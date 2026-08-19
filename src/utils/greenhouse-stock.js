// Greenhouse (teplitsa) bosqich va nav bo'yicha stok — umumiy yordamchi funksiyalar.
// greenhouse.routes.js, transfers.routes.js va orders.routes.js shu yerdan import qiladi,
// shunda "har bosqich o'zgarishida ikkala jadval (stage_stock va variety_stock) birga yangilanadi" qoidasi
// bitta joyda ta'minlanadi.

import AppError from "./app-error.js";

export const GREENHOUSE_STAGES = ["cassette", "grafting", "grafted", "ready"];

// cassette/grafting: FAQAT rootstock (payvand turi) bo'yicha kuzatiladi, nav/tur ahamiyatsiz.
// grafted/ready: to'liq nav+tur+rootstock bo'yicha kuzatiladi.
const ROOTSTOCK_ONLY_STAGES = new Set(["cassette", "grafting"]);

export const UNKNOWN_VARIETY_BUCKET = { varietyId: 0, seedlingTypeId: 0, rootstockTypeId: 0 };

function normalizeVarietyBucket(stage, varietyId, seedlingTypeId, rootstockTypeId) {
  const isRootstockOnly = ROOTSTOCK_ONLY_STAGES.has(stage);
  return {
    varietyId: isRootstockOnly ? 0 : (varietyId || 0),
    seedlingTypeId: isRootstockOnly ? 0 : (seedlingTypeId || 0),
    rootstockTypeId: rootstockTypeId || 0,
  };
}

// DDL funksiyalar: transaksiya TASHQARISIDA chaqirilishi kerak (MySQL DDL implicit commit qiladi)
export async function ensureLogColumns(db) {
  const [cols] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'greenhouse_stage_log'
     AND COLUMN_NAME IN ('seedling_type_id','variety_id','rootstock_type_id','action_type','variety_quantity','from_rootstock_type_id')`
  );
  const existing = cols.map((c) => c.COLUMN_NAME);
  const alters = [];
  if (!existing.includes("seedling_type_id"))
    alters.push("ADD COLUMN seedling_type_id INT NULL");
  if (!existing.includes("variety_id"))
    alters.push("ADD COLUMN variety_id INT NULL");
  if (!existing.includes("rootstock_type_id"))
    alters.push("ADD COLUMN rootstock_type_id INT NULL");
  if (!existing.includes("action_type"))
    alters.push("ADD COLUMN action_type VARCHAR(30) NULL DEFAULT 'move'");
  if (!existing.includes("variety_quantity"))
    alters.push("ADD COLUMN variety_quantity INT NULL");
  if (!existing.includes("from_rootstock_type_id"))
    alters.push("ADD COLUMN from_rootstock_type_id INT NULL");
  if (alters.length > 0) {
    await db.query(`ALTER TABLE greenhouse_stage_log ${alters.join(", ")}`);
  }
}

export async function ensureVarietyStockTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS greenhouse_variety_stock (
      location_id INT NOT NULL,
      stage VARCHAR(50) NOT NULL,
      variety_id INT NOT NULL DEFAULT 0,
      seedling_type_id INT NOT NULL DEFAULT 0,
      rootstock_type_id INT NOT NULL DEFAULT 0,
      quantity INT NOT NULL DEFAULT 0,
      PRIMARY KEY (location_id, stage, variety_id, seedling_type_id, rootstock_type_id)
    )
  `);
}

export async function ensureGreenhouseTransfersTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS greenhouse_transfers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      transfer_code VARCHAR(80) NOT NULL UNIQUE,
      from_location_id INT NOT NULL,
      to_location_id INT NOT NULL,
      from_stage VARCHAR(50) NOT NULL,
      to_stage VARCHAR(50) NOT NULL,
      quantity INT NOT NULL,
      rootstock_type_id INT NULL,
      transfer_date DATE NOT NULL,
      note TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_head',
      created_by INT NULL,
      sender_confirmed TINYINT(1) NOT NULL DEFAULT 1,
      sender_confirmed_by INT NULL,
      sender_confirmed_at DATETIME NULL,
      head_confirmed TINYINT(1) NOT NULL DEFAULT 0,
      head_confirmed_by INT NULL,
      head_confirmed_at DATETIME NULL,
      receiver_confirmed TINYINT(1) NOT NULL DEFAULT 0,
      receiver_confirmed_by INT NULL,
      receiver_confirmed_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_gt_status (status),
      INDEX idx_gt_from_location (from_location_id),
      INDEX idx_gt_to_location (to_location_id)
    )
  `);
}

// Ko'p-navli to'g'ridan-to'g'ri savdo (Savdo sahifasidagi "Yangi savdo") uchun
// har bir qatorni alohida saqlaydi — order_items dan farqli, bu yerda batch_id/inventory_id
// shart emas (partiyasiz, faqat nav+tur bo'yicha savdo qilinadi).
export async function ensureGreenhouseOrderItemsTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS greenhouse_order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      variety_id INT NOT NULL DEFAULT 0,
      seedling_type_id INT NOT NULL DEFAULT 0,
      rootstock_type_id INT NOT NULL DEFAULT 0,
      quantity INT NOT NULL,
      unit_price DECIMAL(14,2) NOT NULL DEFAULT 0,
      total_price DECIMAL(14,2) NOT NULL DEFAULT 0,
      fulfilled_quantity INT NOT NULL DEFAULT 0,
      shortage_quantity INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      INDEX idx_gh_order_items_order (order_id)
    )
  `);
}

export async function ensureGreenhouseTransfersColumns(db) {
  const [cols] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'greenhouse_transfers'
     AND COLUMN_NAME IN ('variety_id','seedling_type_id')`
  );
  const existing = cols.map((c) => c.COLUMN_NAME);
  const alters = [];
  if (!existing.includes("variety_id"))
    alters.push("ADD COLUMN variety_id INT NULL");
  if (!existing.includes("seedling_type_id"))
    alters.push("ADD COLUMN seedling_type_id INT NULL");
  if (alters.length > 0) {
    await db.query(`ALTER TABLE greenhouse_transfers ${alters.join(", ")}`);
  }
}

// Nav bo'yicha stokni yangilash — cassette/grafting uchun nav/tur avtomatik nolga tenglanadi
// (bu ikki bosqich faqat rootstock bo'yicha kuzatiladi), shu bilan har bir chaqiruv nuqtasi xavfsiz bo'ladi.
//
// MUHIM: manfiy delta (ayirish) uchun, agar aniq buket (masalan foydalanuvchi nav tanlamagan
// holatda "Aniqlanmagan" buket) yetarli bo'lmasa, oddiy GREATEST(0,...) bilan ortiqcha qism
// jimgina yo'qolib ketardi — bu esa boshqa buketlarda (masalan haqiqiy nav tegida) "elg'or"
// (hech qachon to'g'ri bo'lmagan) miqdor qolib ketishiga olib kelardi, chunki keyinchalik shu
// yozuv bekor qilinsa, miqdor xuddi o'sha (asossiz) buketga qaytarib qo'shilardi. Shuning uchun
// yetishmagan qism shu bosqichning "Aniqlanmagan" (0,0,0) buketidan qarz olinadi — shunda
// SUM(variety_stock bir bosqich uchun) har doim greenhouse_stage_stock bilan mos qoladi.
export async function adjustVarietyStock(conn, locationId, stage, varietyId, seedlingTypeId, rootstockTypeId, delta) {
  const { varietyId: vId, seedlingTypeId: stId, rootstockTypeId: rtId } =
    normalizeVarietyBucket(stage, varietyId, seedlingTypeId, rootstockTypeId);

  if (delta >= 0) {
    await conn.query(
      `INSERT INTO greenhouse_variety_stock
        (location_id, stage, variety_id, seedling_type_id, rootstock_type_id, quantity)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
      [locationId, stage, vId, stId, rtId, delta, delta]
    );
    return;
  }

  const need = -delta;
  const isUnknownBucket = vId === 0 && stId === 0 && rtId === 0;

  const [[row]] = await conn.query(
    `SELECT quantity FROM greenhouse_variety_stock
     WHERE location_id = ? AND stage = ? AND variety_id = ? AND seedling_type_id = ? AND rootstock_type_id = ?
     FOR UPDATE`,
    [locationId, stage, vId, stId, rtId]
  );
  const available = Number(row?.quantity || 0);
  const take = Math.min(need, available);

  if (take > 0) {
    await conn.query(
      `UPDATE greenhouse_variety_stock SET quantity = quantity - ?
       WHERE location_id = ? AND stage = ? AND variety_id = ? AND seedling_type_id = ? AND rootstock_type_id = ?`,
      [take, locationId, stage, vId, stId, rtId]
    );
  }

  const shortfall = need - take;
  if (shortfall > 0 && !isUnknownBucket) {
    await conn.query(
      `INSERT INTO greenhouse_variety_stock
        (location_id, stage, variety_id, seedling_type_id, rootstock_type_id, quantity)
       VALUES (?, ?, 0, 0, 0, 0)
       ON DUPLICATE KEY UPDATE quantity = GREATEST(0, quantity - ?)`,
      [locationId, stage, shortfall]
    );
  }
}

// Sotuvda ishlatiladi: orders variety_id+seedling_type_id ni biladi, lekin rootstock_type_id ni
// umuman saqlamaydi. Shu nav+tur bo'yicha mavjud rootstock buketlarini eng kattadan boshlab
// so'radi, tugasa "Aniqlanmagan" (0,0,0) buketdan yopadi — sotuvni hech qachon bloklamaydi.
export async function drainVarietyStockForSale(conn, locationId, stage, varietyId, seedlingTypeId, quantity) {
  if (!(quantity > 0)) return;
  const vId = varietyId || 0;
  const stId = seedlingTypeId || 0;
  let remaining = quantity;

  const [rows] = await conn.query(
    `SELECT rootstock_type_id, quantity FROM greenhouse_variety_stock
     WHERE location_id = ? AND stage = ? AND variety_id = ? AND seedling_type_id = ? AND quantity > 0
     ORDER BY quantity DESC
     FOR UPDATE`,
    [locationId, stage, vId, stId]
  );

  for (const row of rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(row.quantity || 0));
    if (take <= 0) continue;
    await adjustVarietyStock(conn, locationId, stage, vId, stId, row.rootstock_type_id, -take);
    remaining -= take;
  }

  if (remaining > 0) {
    await adjustVarietyStock(
      conn, locationId, stage,
      UNKNOWN_VARIETY_BUCKET.varietyId, UNKNOWN_VARIETY_BUCKET.seedlingTypeId, UNKNOWN_VARIETY_BUCKET.rootstockTypeId,
      -remaining
    );
  }
}

// Sotuvdan oldin tekshirish: tanlangan nav+tur bo'yicha (barcha rootstock buketlari +
// "Aniqlanmagan" buket jamlanib) yetarli miqdor bormi. Yetarli bo'lmasa rad etadi —
// aks holda drainVarietyStockForSale yetishmagan qismni jimgina yo'qotib qo'yar edi,
// natijada bosqich jamisi kamayadi-yu, nav-taqsimot yig'indisi ortiqcha qolib ketardi.
export async function assertVarietyStockAvailable(conn, locationId, stage, varietyId, seedlingTypeId, quantity) {
  if (!(quantity > 0)) return;
  const vId = varietyId || 0;
  const stId = seedlingTypeId || 0;

  const [[row]] = await conn.query(
    `SELECT COALESCE(SUM(quantity), 0) AS avail FROM greenhouse_variety_stock
     WHERE location_id = ? AND stage = ?
       AND ((variety_id = ? AND seedling_type_id = ?) OR (variety_id = 0 AND seedling_type_id = 0))`,
    [locationId, stage, vId, stId]
  );
  const avail = Number(row?.avail || 0);
  if (avail < quantity) {
    throw new AppError(
      `Tanlangan nav/tur bo'yicha yetarli miqdor yo'q. Mavjud: ${avail}, kerak: ${quantity}.`,
      400
    );
  }
}

// Joriy miqdorni yangilash yordamchi funksiyasi
export async function adjustStock(conn, locationId, stage, delta) {
  const [existing] = await conn.query(
    `SELECT id, quantity FROM greenhouse_stage_stock
     WHERE location_id = ? AND stage = ? LIMIT 1`,
    [locationId, stage]
  );

  if (existing.length > 0) {
    await conn.query(
      `UPDATE greenhouse_stage_stock SET quantity = GREATEST(0, quantity + ?), updated_at = NOW()
       WHERE location_id = ? AND stage = ?`,
      [delta, locationId, stage]
    );
  } else {
    await conn.query(
      `INSERT INTO greenhouse_stage_stock (location_id, stage, quantity)
       VALUES (?, ?, GREATEST(0, ?))`,
      [locationId, stage, delta]
    );
  }
}

// Teplitsaning joriy holati: har bosqichda nechta ko'chat bor
export async function getLocationStock(conn, locationId) {
  const [rows] = await conn.query(
    `SELECT stage, quantity FROM greenhouse_stage_stock WHERE location_id = ?`,
    [locationId]
  );

  const stock = Object.fromEntries(GREENHOUSE_STAGES.map((s) => [s, 0]));
  for (const row of rows) {
    if (stock[row.stage] !== undefined) {
      stock[row.stage] = Number(row.quantity || 0);
    }
  }

  return {
    cassette: stock.cassette,
    grafting: stock.grafting,
    grafted: stock.grafted,
    ready: stock.ready,
    total: stock.cassette + stock.grafting + stock.grafted + stock.ready,
  };
}
