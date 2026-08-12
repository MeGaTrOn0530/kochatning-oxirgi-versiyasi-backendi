import { Router } from "express";
import { getPool, withTransaction } from "../config/database.js";
import asyncHandler from "../utils/async-handler.js";
import AppError from "../utils/app-error.js";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import { fetchOne } from "../utils/db-helpers.js";
import { requireFields, toPositiveInt, toInteger } from "../utils/validation.js";
import { logActivity } from "../utils/activity.js";
import { sendCreated, sendOk } from "../utils/http.js";
import { saveSeedlingImages } from "../utils/upload-storage.js";

const router = Router();
router.use(authenticate);

const GREENHOUSE_STAGES = ["cassette", "grafting", "grafted", "ready"];

// DDL funksiyalar: transaksiya TASHQARISIDA chaqirilishi kerak (MySQL DDL implicit commit qiladi)
async function ensureLogColumns(db) {
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

async function ensureVarietyStockTable(db) {
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

async function ensureGreenhouseTransfersTable(db) {
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

// Nav bo'yicha stokni yangilash
async function adjustVarietyStock(conn, locationId, stage, varietyId, seedlingTypeId, rootstockTypeId, delta) {
  const vId = varietyId || 0;
  const stId = seedlingTypeId || 0;
  const rtId = rootstockTypeId || 0;
  await conn.query(
    `INSERT INTO greenhouse_variety_stock
      (location_id, stage, variety_id, seedling_type_id, rootstock_type_id, quantity)
     VALUES (?, ?, ?, ?, ?, GREATEST(0, ?))
     ON DUPLICATE KEY UPDATE quantity = GREATEST(0, quantity + ?)`,
    [locationId, stage, vId, stId, rtId, delta, delta]
  );
}

// Joriy miqdorni yangilash yordamchi funksiyasi
async function adjustStock(conn, locationId, stage, delta) {
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
async function getLocationStock(conn, locationId) {
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

// ─── GET /api/greenhouse/transfers ──────────────────────────────────────────
// Teplitsa-to-teplitsa bosqich transferlari ro'yxati
router.get(
  "/transfers",
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    await ensureGreenhouseTransfersTable(pool);

    const [rows] = await pool.query(`
      SELECT gt.*,
        fl.name AS from_location_name,
        tl.name AS to_location_name,
        u1.full_name AS created_by_name,
        u2.full_name AS sender_confirmed_by_name,
        u3.full_name AS head_confirmed_by_name,
        u4.full_name AS receiver_confirmed_by_name,
        rt.name AS rootstock_type_name
      FROM greenhouse_transfers gt
      LEFT JOIN locations fl ON fl.id = gt.from_location_id
      LEFT JOIN locations tl ON tl.id = gt.to_location_id
      LEFT JOIN users u1 ON u1.id = gt.created_by
      LEFT JOIN users u2 ON u2.id = gt.sender_confirmed_by
      LEFT JOIN users u3 ON u3.id = gt.head_confirmed_by
      LEFT JOIN users u4 ON u4.id = gt.receiver_confirmed_by
      LEFT JOIN rootstock_types rt ON rt.id = gt.rootstock_type_id
      ORDER BY gt.created_at DESC
      LIMIT 200
    `);

    return sendOk(res, rows);
  })
);

// ─── POST /api/greenhouse/transfers/:id/confirm-head ────────────────────────
// Bosh agronom tasdiqlaydi → manba teplitsadan stok chiqariladi
router.post(
  "/transfers/:id/confirm-head",
  authorize("admin", "bosh_agranom"),
  asyncHandler(async (req, res) => {
    const id = toPositiveInt(req.params.id, "id");

    await ensureLogColumns(getPool());

    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        "SELECT * FROM greenhouse_transfers WHERE id = ? LIMIT 1",
        [id]
      );
      const gt = rows[0];
      if (!gt) throw new AppError("Greenhouse transfer topilmadi.", 404);
      if (gt.head_confirmed) throw new AppError("Bosh agronom allaqachon tasdiqlagan.", 400);

      // Manba teplitsada yetarli stok borligini tekshirish
      const [stockRows] = await conn.query(
        `SELECT quantity FROM greenhouse_stage_stock WHERE location_id = ? AND stage = ? LIMIT 1`,
        [gt.from_location_id, gt.from_stage]
      );
      const available = Number(stockRows[0]?.quantity || 0);
      if (available < gt.quantity) {
        throw new AppError(
          `Manba teplitsada yetarli miqdor yo'q. Mavjud: ${available}, kerak: ${gt.quantity}.`,
          400
        );
      }

      // Manba teplitsadan stok chiqariladi
      await adjustStock(conn, gt.from_location_id, gt.from_stage, -gt.quantity);

      // Chiqish logi
      const transferDate = gt.transfer_date instanceof Date
        ? gt.transfer_date.toISOString().slice(0, 10)
        : String(gt.transfer_date).slice(0, 10);
      await conn.query(
        `INSERT INTO greenhouse_stage_log
          (location_id, action_date, from_stage, to_stage, quantity, notes, created_by, action_type, from_rootstock_type_id)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 'transfer_out', ?)`,
        [gt.from_location_id, transferDate, gt.from_stage,
         gt.quantity, gt.note, req.user.id, gt.rootstock_type_id || null]
      );

      await conn.query(
        `UPDATE greenhouse_transfers
         SET head_confirmed = 1, head_confirmed_by = ?, head_confirmed_at = NOW(), status = 'pending_receiver'
         WHERE id = ?`,
        [req.user.id, id]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "greenhouse_transfer_head_confirmed",
        entityType: "greenhouse_transfer",
        entityId: id,
        description: `Greenhouse transfer #${id} bosh agronom tomonidan tasdiqlandi`
      });

      return { id, status: "pending_receiver" };
    });

    return sendOk(res, result, "Bosh agronom tasdig'i saqlandi.");
  })
);

// ─── POST /api/greenhouse/transfers/:id/confirm-receiver ────────────────────
// Qabul qiluvchi tasdiqlaydi → maqsad teplitsaga stok qo'shiladi
router.post(
  "/transfers/:id/confirm-receiver",
  authorize("admin", "bosh_agranom", "agranom"),
  asyncHandler(async (req, res) => {
    const id = toPositiveInt(req.params.id, "id");

    await ensureLogColumns(getPool());

    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        "SELECT * FROM greenhouse_transfers WHERE id = ? LIMIT 1",
        [id]
      );
      const gt = rows[0];
      if (!gt) throw new AppError("Greenhouse transfer topilmadi.", 404);
      if (!gt.head_confirmed) throw new AppError("Avval bosh agronom tasdiqlashi kerak.", 400);
      if (gt.receiver_confirmed) throw new AppError("Qabul qiluvchi allaqachon tasdiqlagan.", 400);

      if (req.user.role === "agranom" && req.user.locationId !== gt.to_location_id) {
        throw new AppError("Siz bu transferni qabul qiluvchi sifatida tasdiqlay olmaysiz.", 403);
      }

      // Maqsad teplitsaga stok qo'shiladi
      await adjustStock(conn, gt.to_location_id, gt.to_stage, gt.quantity);

      // Kirim logi
      const transferDate = gt.transfer_date instanceof Date
        ? gt.transfer_date.toISOString().slice(0, 10)
        : String(gt.transfer_date).slice(0, 10);
      await conn.query(
        `INSERT INTO greenhouse_stage_log
          (location_id, action_date, from_stage, to_stage, quantity, notes, created_by, action_type, rootstock_type_id)
         VALUES (?, ?, NULL, ?, ?, ?, ?, 'transfer_in', ?)`,
        [gt.to_location_id, transferDate, gt.to_stage, gt.quantity, gt.note, req.user.id, gt.rootstock_type_id || null]
      );

      await conn.query(
        `UPDATE greenhouse_transfers
         SET receiver_confirmed = 1, receiver_confirmed_by = ?, receiver_confirmed_at = NOW(), status = 'completed'
         WHERE id = ?`,
        [req.user.id, id]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "greenhouse_transfer_receiver_confirmed",
        entityType: "greenhouse_transfer",
        entityId: id,
        description: `Greenhouse transfer #${id} qabul qiluvchi tomonidan tasdiqlandi`
      });

      return { id, status: "completed" };
    });

    return sendOk(res, result, "Qabul tasdig'i saqlandi. Ko'chatlar maqsad teplitsada paydo bo'ldi.");
  })
);

// ─── GET /api/greenhouse/summary ────────────────────────────────────────────
// Barcha faol teplitsalar bo'yicha umumiy holat
router.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    const pool = getPool();

    const [locations] = await pool.query(
      `SELECT l.id, l.name, l.type, l.status
       FROM locations l
       WHERE l.status = 'active'
       ORDER BY l.name`
    );

    const [stockRows] = await pool.query(
      `SELECT gss.location_id, gss.stage, gss.quantity
       FROM greenhouse_stage_stock gss
       JOIN locations l ON l.id = gss.location_id
       WHERE l.status = 'active'`
    );

    const [defectRows] = await pool.query(
      `SELECT gsl.location_id, SUM(gsl.quantity) AS defect_total
       FROM greenhouse_stage_log gsl
       JOIN locations l ON l.id = gsl.location_id
       WHERE l.status = 'active'
         AND (gsl.action_type = 'defect' OR gsl.to_stage = 'defect')
       GROUP BY gsl.location_id`
    );

    const stockMap = {};
    for (const row of stockRows) {
      if (!stockMap[row.location_id]) {
        stockMap[row.location_id] = Object.fromEntries(GREENHOUSE_STAGES.map((s) => [s, 0]));
      }
      if (GREENHOUSE_STAGES.includes(row.stage)) {
        stockMap[row.location_id][row.stage] = Number(row.quantity || 0);
      }
    }

    const defectMap = {};
    for (const row of defectRows) {
      defectMap[row.location_id] = Number(row.defect_total || 0);
    }

    const result = locations.map((loc) => {
      const s = stockMap[loc.id] || Object.fromEntries(GREENHOUSE_STAGES.map((st) => [st, 0]));
      return {
        locationId: loc.id,
        locationName: loc.name,
        locationType: loc.type,
        cassette: s.cassette || 0,
        grafting: s.grafting || 0,
        grafted: s.grafted || 0,
        ready: s.ready || 0,
        total: (s.cassette || 0) + (s.grafting || 0) + (s.grafted || 0) + (s.ready || 0),
        defectTotal: defectMap[loc.id] || 0,
      };
    });

    return sendOk(res, result);
  })
);

// ─── GET /api/greenhouse/:locationId ────────────────────────────────────────
// Bitta teplitsaning joriy holati
router.get(
  "/:locationId",
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const locationId = toPositiveInt(req.params.locationId, "locationId");

    const location = await fetchOne(
      pool,
      "SELECT id, name, type FROM locations WHERE id = ? LIMIT 1",
      [locationId]
    );

    if (!location) {
      throw new AppError("Lokatsiya topilmadi.", 404);
    }

    const stock = await getLocationStock(pool, locationId);

    return sendOk(res, { location, stock });
  })
);

// ─── GET /api/greenhouse/:locationId/log ────────────────────────────────────
// Bitta teplitsaning harakat jurnali
router.get(
  "/:locationId/log",
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const locationId = toPositiveInt(req.params.locationId, "locationId");
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const [rows] = await pool.query(
      `SELECT gsl.*,
              u.full_name AS created_by_name,
              st.name AS seedling_type_name,
              v.name AS variety_name,
              rt.name AS rootstock_type_name
       FROM greenhouse_stage_log gsl
       LEFT JOIN users u ON u.id = gsl.created_by
       LEFT JOIN seedling_types st ON st.id = gsl.seedling_type_id
       LEFT JOIN varieties v ON v.id = gsl.variety_id
       LEFT JOIN rootstock_types rt ON rt.id = gsl.rootstock_type_id
       WHERE gsl.location_id = ? AND (gsl.action_type IS NULL OR gsl.action_type NOT IN ('defect', 'correction'))
       ORDER BY gsl.action_date DESC, gsl.id DESC
       LIMIT ?`,
      [locationId, limit]
    );

    return sendOk(res, rows);
  })
);

// ─── POST /api/greenhouse/:locationId/receive ───────────────────────────────
// Jomboy transferidan kelib tushgan ko'chatlarni kasetada bosqichiga qo'shish
// (transfers.routes.js dan chaqiriladi, lekin to'g'ridan-to'g'ri ham ishlaydi)
router.post(
  "/:locationId/receive",
  authorize("admin", "bosh_agranom", "agranom"),
  asyncHandler(async (req, res) => {
    requireFields(req.body, ["quantity"]);

    const locationId = toPositiveInt(req.params.locationId, "locationId");
    const quantity = toPositiveInt(req.body.quantity, "quantity");
    const actionDate = req.body.actionDate ? new Date(req.body.actionDate) : new Date();

    if (req.user.role === "agranom" && req.user.locationId !== locationId) {
      throw new AppError("Siz faqat o'z lokatsiyangizga qabul qila olasiz.", 403);
    }

    const result = await withTransaction(async (conn) => {
      const location = await fetchOne(
        conn,
        "SELECT id, name FROM locations WHERE id = ? LIMIT 1",
        [locationId]
      );
      if (!location) throw new AppError("Lokatsiya topilmadi.", 404);

      await adjustStock(conn, locationId, "cassette", quantity);

      const [logResult] = await conn.query(
        `INSERT INTO greenhouse_stage_log
          (location_id, action_date, from_stage, to_stage, quantity, notes, created_by, source_transfer_id)
         VALUES (?, ?, NULL, 'cassette', ?, ?, ?, ?)`,
        [
          locationId,
          actionDate.toISOString().slice(0, 10),
          quantity,
          req.body.notes || null,
          req.user.id,
          req.body.transferId || null,
        ]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "greenhouse_receive",
        entityType: "greenhouse",
        entityId: locationId,
        description: `${location.name} teplitsasiga ${quantity} ta ko'chat qabul qilindi (kasetada)`,
        metadata: { locationId, quantity, actionDate: actionDate.toISOString() }
      });

      const stock = await getLocationStock(conn, locationId);
      return { logId: logResult.insertId, stock };
    });

    return sendCreated(res, result, "Ko'chatlar qabul qilindi.");
  })
);

// ─── POST /api/greenhouse/:locationId/move ──────────────────────────────────
// Bosqich almashtirish (forward yoki backward)
// Parametrlar:
//   fromStage, toStage, quantity — asosiy harakat
//   failedQuantity  — (ixtiyoriy) muvaffaqiyatsiz payvantlar, toStage → fromStage ga qaytadi
//   actionDate, notes, images
router.post(
  "/:locationId/move",
  authorize("admin", "bosh_agranom", "agranom"),
  asyncHandler(async (req, res) => {
    requireFields(req.body, ["fromStage", "toStage", "quantity"]);

    const locationId = toPositiveInt(req.params.locationId, "locationId");
    const fromStage = req.body.fromStage;
    const toStage = req.body.toStage;
    const quantity = toPositiveInt(req.body.quantity, "quantity");
    const failedQuantity = toInteger(req.body.failedQuantity, "failedQuantity", 0);
    const actionDate = req.body.actionDate ? new Date(req.body.actionDate) : new Date();

    if (!GREENHOUSE_STAGES.includes(fromStage)) {
      throw new AppError(`fromStage noto'g'ri: ${fromStage}`, 400);
    }
    if (!GREENHOUSE_STAGES.includes(toStage)) {
      throw new AppError(`toStage noto'g'ri: ${toStage}`, 400);
    }
    if (fromStage === toStage) {
      throw new AppError("fromStage va toStage bir xil bo'lmasligi kerak.", 400);
    }
    if (failedQuantity < 0) {
      throw new AppError("failedQuantity manfiy bo'lmasligi kerak.", 400);
    }

    if (req.user.role === "agranom" && req.user.locationId !== locationId) {
      throw new AppError("Siz faqat o'z lokatsiyangizda harakat kirita olasiz.", 403);
    }

    const seedlingTypeId = req.body.seedlingTypeId ? Number(req.body.seedlingTypeId) : null;
    const varietyId = req.body.varietyId ? Number(req.body.varietyId) : null;
    const rootstockTypeId = req.body.rootstockTypeId ? Number(req.body.rootstockTypeId) : null;
    const fromRootstockTypeId = req.body.fromRootstockTypeId ? Number(req.body.fromRootstockTypeId) : null;
    const fromStageIsRootstockOnly = ["cassette", "grafting"].includes(fromStage);
    const effectiveRootstockTypeId = rootstockTypeId || fromRootstockTypeId;
    const defectQuantity = toInteger(req.body.defectQuantity, "defectQuantity", 0);
    const defectNotes = req.body.defectNotes || null;

    if (defectQuantity < 0) {
      throw new AppError("defectQuantity manfiy bo'lmasligi kerak.", 400);
    }

    // DDL transaksiya tashqarisida (MySQL DDL implicit commit qiladi)
    await ensureLogColumns(getPool());
    await ensureVarietyStockTable(getPool());

    // Har doim actual miqdorni saqlaymiz (scaling yo'q)
    const vqty = (q) => q;

    const result = await withTransaction(async (conn) => {
      const location = await fetchOne(
        conn,
        "SELECT id, name FROM locations WHERE id = ? LIMIT 1",
        [locationId]
      );
      if (!location) throw new AppError("Lokatsiya topilmadi.", 404);

      // Joriy fromStage qoldiqni tekshirish
      const [currentStock] = await conn.query(
        `SELECT quantity FROM greenhouse_stage_stock WHERE location_id = ? AND stage = ? LIMIT 1`,
        [locationId, fromStage]
      );
      const available = Number(currentStock[0]?.quantity || 0);
      const needed = quantity + failedQuantity + defectQuantity;
      if (available < needed) {
        throw new AppError(
          `${fromStage} bosqichida yetarli miqdor yo'q. Mavjud: ${available}, kerak: ${needed}.`,
          400
        );
      }

      const actionDateStr = actionDate.toISOString().slice(0, 10);

      // Asosiy harakat: fromStage → toStage
      await adjustStock(conn, locationId, fromStage, -(quantity + failedQuantity + defectQuantity));
      await adjustStock(conn, locationId, toStage, quantity);

      // Nav bo'yicha stok yangilash (asosiy harakat)
      await adjustVarietyStock(conn, locationId, fromStage, varietyId, seedlingTypeId, rootstockTypeId, -(quantity + failedQuantity + defectQuantity));
      await adjustVarietyStock(conn, locationId, toStage, varietyId, seedlingTypeId, rootstockTypeId, quantity);

      const imagePaths = await saveSeedlingImages(req.body.images, {
        prefix: `gh-${locationId}`,
      });

      const [logResult] = await conn.query(
        `INSERT INTO greenhouse_stage_log
          (location_id, action_date, from_stage, to_stage, quantity, notes, image_paths, created_by,
           seedling_type_id, variety_id, rootstock_type_id, action_type, variety_quantity, from_rootstock_type_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'move', ?, ?)`,
        [
          locationId,
          actionDateStr,
          fromStage,
          toStage,
          quantity,
          req.body.notes || null,
          JSON.stringify(imagePaths),
          req.user.id,
          seedlingTypeId,
          varietyId,
          effectiveRootstockTypeId,
          vqty(quantity),
          fromStageIsRootstockOnly ? fromRootstockTypeId : null,
        ]
      );

      // Nobut bo'lganlar — fromStage dan ayirildi, qayd etiladi
      if (defectQuantity > 0) {
        const defectImagePaths = await saveSeedlingImages(req.body.defectImages || [], {
          prefix: `gh-defect-${locationId}`,
        });
        await conn.query(
          `INSERT INTO greenhouse_stage_log
            (location_id, action_date, from_stage, to_stage, quantity, notes, image_paths, created_by,
             seedling_type_id, variety_id, rootstock_type_id, action_type, variety_quantity, from_rootstock_type_id)
           VALUES (?, ?, ?, 'defect', ?, ?, ?, ?, ?, ?, ?, 'defect', ?, ?)`,
          [
            locationId,
            actionDateStr,
            fromStage,
            defectQuantity,
            defectNotes || `Nobut bo'lganlar: ${defectQuantity} ta`,
            JSON.stringify(defectImagePaths),
            req.user.id,
            seedlingTypeId,
            varietyId,
            effectiveRootstockTypeId,
            vqty(defectQuantity),
            fromStageIsRootstockOnly ? fromRootstockTypeId : null,
          ]
        );
      }

      // Payvant olmagan — fromStage ga qaytariladi (kasetaga emas)
      let failedLogId = null;
      if (failedQuantity > 0) {
        await adjustStock(conn, locationId, fromStage, failedQuantity);
        await adjustVarietyStock(conn, locationId, fromStage, varietyId, seedlingTypeId, rootstockTypeId, failedQuantity);

        const [failedLog] = await conn.query(
          `INSERT INTO greenhouse_stage_log
            (location_id, action_date, from_stage, to_stage, quantity, notes, created_by, action_type,
             seedling_type_id, variety_id, rootstock_type_id, variety_quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'return', ?, ?, ?, ?)`,
          [
            locationId,
            actionDateStr,
            fromStage,
            fromStage,
            failedQuantity,
            `Payvant olmagan: ${failedQuantity} ta ${fromStage} bosqichida qoldi`,
            req.user.id,
            seedlingTypeId,
            varietyId,
            rootstockTypeId,
            vqty(failedQuantity),
          ]
        );
        failedLogId = failedLog.insertId;
      }

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "greenhouse_move",
        entityType: "greenhouse",
        entityId: locationId,
        description: `${location.name}: ${fromStage} → ${toStage}, ${quantity} ta` +
          (failedQuantity > 0 ? `, ${failedQuantity} ta ${fromStage} bosqichida qoldi` : "") +
          (defectQuantity > 0 ? `, ${defectQuantity} ta nobut` : ""),
        metadata: { locationId, fromStage, toStage, quantity, failedQuantity, defectQuantity, actionDate: actionDateStr }
      });

      const stock = await getLocationStock(conn, locationId);
      return { logId: logResult.insertId, failedLogId, stock };
    });

    return sendOk(res, result, "Bosqich almashtirildi.");
  })
);

// ─── GET /api/greenhouse/:locationId/variety-stock ──────────────────────────
// Nav bo'yicha har bir bosqichdagi ko'chatlar soni — logdan hisoblanadi (har doim aniq)
router.get(
  "/:locationId/variety-stock",
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const locationId = toPositiveInt(req.params.locationId, "locationId");

    try {
      // variety_id ustuni mavjudligini tekshirish
      const [cols] = await pool.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'greenhouse_stage_log'
         AND COLUMN_NAME = 'variety_id'`
      );
      if (cols.length === 0) return sendOk(res, []);

      // Log asosida nav stokini hisoblash
      // cassette va grafting: FAQAT rootstock bo'yicha kuzatiladi (variety/tur ahamiyatsiz)
      // grafted va ready: to'liq variety (nav+tur+rootstock) bo'yicha kuzatiladi
      const [rows] = await pool.query(
        `SELECT
           stage,
           variety_id,
           seedling_type_id,
           rootstock_type_id,
           SUM(qty_delta)          AS quantity,
           MAX(variety_name)       AS variety_name,
           MAX(seedling_type_name) AS seedling_type_name,
           MAX(rootstock_type_name) AS rootstock_type_name
         FROM (
           -- Inbound: cassette/grafting → (0,0,rootstock), boshqalar → to'liq variety
           SELECT gsl.to_stage AS stage,
                  CASE WHEN gsl.to_stage IN ('cassette','grafting') THEN 0
                       ELSE COALESCE(gsl.variety_id, 0) END      AS variety_id,
                  CASE WHEN gsl.to_stage IN ('cassette','grafting') THEN 0
                       ELSE COALESCE(gsl.seedling_type_id, 0) END AS seedling_type_id,
                  COALESCE(gsl.rootstock_type_id, 0)             AS rootstock_type_id,
                  gsl.quantity                                    AS qty_delta,
                  CASE WHEN gsl.to_stage IN ('cassette','grafting') THEN NULL
                       ELSE v.name END AS variety_name,
                  CASE WHEN gsl.to_stage IN ('cassette','grafting') THEN NULL
                       ELSE st.name END AS seedling_type_name,
                  rt.name AS rootstock_type_name
           FROM greenhouse_stage_log gsl
           LEFT JOIN varieties       v  ON v.id  = gsl.variety_id
           LEFT JOIN seedling_types  st ON st.id = gsl.seedling_type_id
           LEFT JOIN rootstock_types rt ON rt.id = gsl.rootstock_type_id
           WHERE gsl.location_id = ?
             AND gsl.to_stage IS NOT NULL
             AND gsl.to_stage NOT IN ('defect', 'sold')

           UNION ALL

           -- Outbound: cassette/grafting → (0,0,rootstock), boshqalar → to'liq variety
           SELECT gsl.from_stage AS stage,
                  CASE WHEN gsl.from_stage IN ('cassette','grafting') THEN 0
                       ELSE COALESCE(gsl.variety_id, 0) END      AS variety_id,
                  CASE WHEN gsl.from_stage IN ('cassette','grafting') THEN 0
                       ELSE COALESCE(gsl.seedling_type_id, 0) END AS seedling_type_id,
                  COALESCE(gsl.from_rootstock_type_id, gsl.rootstock_type_id, 0) AS rootstock_type_id,
                  -gsl.quantity                                   AS qty_delta,
                  NULL AS variety_name,
                  NULL AS seedling_type_name,
                  NULL AS rootstock_type_name
           FROM greenhouse_stage_log gsl
           WHERE gsl.location_id = ?
             AND gsl.from_stage IS NOT NULL
         ) t
         GROUP BY stage, variety_id, seedling_type_id, rootstock_type_id
         HAVING SUM(qty_delta) > 0
         ORDER BY stage, SUM(qty_delta) DESC`,
        [locationId, locationId]
      );
      return sendOk(res, rows);
    } catch (_) {
      return sendOk(res, []);
    }
  })
);

// ─── GET /api/greenhouse/:locationId/defect-log ─────────────────────────────
// Nobut bo'lganlar tarixi
router.get(
  "/:locationId/defect-log",
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const locationId = toPositiveInt(req.params.locationId, "locationId");
    const limit = Math.min(Number(req.query.limit || 100), 500);

    try {
      const [rows] = await pool.query(
        `SELECT gsl.*,
                u.full_name AS created_by_name,
                v.name AS variety_name,
                st.name AS seedling_type_name,
                rt.name AS rootstock_type_name
         FROM greenhouse_stage_log gsl
         LEFT JOIN users u ON u.id = gsl.created_by
         LEFT JOIN varieties v ON v.id = gsl.variety_id
         LEFT JOIN seedling_types st ON st.id = gsl.seedling_type_id
         LEFT JOIN rootstock_types rt ON rt.id = gsl.rootstock_type_id
         WHERE gsl.location_id = ? AND gsl.action_type = 'defect'
         ORDER BY gsl.action_date DESC, gsl.id DESC
         LIMIT ?`,
        [locationId, limit]
      );
      return sendOk(res, rows);
    } catch (_) {
      return sendOk(res, []);
    }
  })
);

// ─── POST /api/greenhouse/:locationId/stage-transfer ────────────────────────
// Bir teplitsadagi bosqichdan boshqa teplitsaning bosqichiga ko'chatlarni o'tkazish
router.post(
  "/:locationId/stage-transfer",
  authorize("admin", "bosh_agranom", "agranom"),
  asyncHandler(async (req, res) => {
    requireFields(req.body, ["toLocationId", "fromStage", "quantity"]);

    const fromLocationId = toPositiveInt(req.params.locationId, "fromLocationId");
    const toLocationId = toPositiveInt(req.body.toLocationId, "toLocationId");
    const fromStage = req.body.fromStage;
    const toStage = req.body.toStage || fromStage;
    const quantity = toPositiveInt(req.body.quantity, "quantity");
    const fromRootstockTypeId = req.body.fromRootstockTypeId != null ? Number(req.body.fromRootstockTypeId) : null;
    const notes = req.body.notes || null;
    const actionDate = req.body.actionDate ? new Date(req.body.actionDate) : new Date();

    if (!GREENHOUSE_STAGES.includes(fromStage)) {
      throw new AppError(`fromStage noto'g'ri: ${fromStage}`, 400);
    }
    if (!GREENHOUSE_STAGES.includes(toStage)) {
      throw new AppError(`toStage noto'g'ri: ${toStage}`, 400);
    }
    if (fromLocationId === toLocationId) {
      throw new AppError("Jo'natuvchi va qabul qiluvchi teplitsa bir xil bo'lmasligi kerak.", 400);
    }

    if (req.user.role === "agranom" && req.user.locationId !== fromLocationId) {
      throw new AppError("Siz faqat o'z lokatsiyangizdan o'tkaza olasiz.", 403);
    }

    await ensureLogColumns(getPool());
    await ensureGreenhouseTransfersTable(getPool());

    const result = await withTransaction(async (conn) => {
      const fromLocation = await fetchOne(
        conn,
        "SELECT id, name FROM locations WHERE id = ? LIMIT 1",
        [fromLocationId]
      );
      if (!fromLocation) throw new AppError("Manba teplitsa topilmadi.", 404);

      const toLocation = await fetchOne(
        conn,
        "SELECT id, name FROM locations WHERE id = ? LIMIT 1",
        [toLocationId]
      );
      if (!toLocation) throw new AppError("Maqsad teplitsa topilmadi.", 404);

      const [stockRows] = await conn.query(
        `SELECT quantity FROM greenhouse_stage_stock WHERE location_id = ? AND stage = ? LIMIT 1`,
        [fromLocationId, fromStage]
      );
      const available = Number(stockRows[0]?.quantity || 0);
      if (available < quantity) {
        throw new AppError(
          `${GREENHOUSE_STAGES.includes(fromStage) ? fromStage : fromStage} bosqichida yetarli miqdor yo'q. Mavjud: ${available}, kerak: ${quantity}.`,
          400
        );
      }

      const actionDateStr = actionDate.toISOString().slice(0, 10);
      const transferNote = notes || `${fromLocation.name} dan ${toLocation.name} ga o'tkazildi`;

      // Stok HOZIRCHA ko'chirilmaydi — faqat transfer yozuvi yaratiladi
      // Bosh agronom tasdiqlashida manba teplitsadan chiqariladi
      // Qabul qiluvchi tasdiqlashida maqsad teplitsaga qo'shiladi
      const transferCode = `GT-${Date.now()}-${fromLocationId}`;
      await conn.query(
        `INSERT INTO greenhouse_transfers
          (transfer_code, from_location_id, to_location_id, from_stage, to_stage, quantity,
           rootstock_type_id, transfer_date, note, status, created_by,
           sender_confirmed, sender_confirmed_by, sender_confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_head', ?, 1, ?, NOW())`,
        [transferCode, fromLocationId, toLocationId, fromStage, toStage, quantity,
         fromRootstockTypeId || null, actionDateStr, transferNote, req.user.id, req.user.id]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "greenhouse_stage_transfer_created",
        entityType: "greenhouse",
        entityId: fromLocationId,
        description: `${fromLocation.name} (${fromStage}) → ${toLocation.name} (${toStage}), ${quantity} ta — tasdiqlash kutilmoqda`,
        metadata: { fromLocationId, toLocationId, fromStage, toStage, quantity }
      });

      return { transferCode, status: "pending_head" };
    });

    return sendOk(res, result, "Transfer yaratildi. Bosh agronom tasdig'i kutilmoqda.");
  })
);

// ─── DELETE /api/greenhouse/:locationId/log/:logId ──────────────────────────
// Log yozuvini o'chirish (admin only) — undone xato kiritilgan harakat
router.delete(
  "/:locationId/log/:logId",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const locationId = toPositiveInt(req.params.locationId, "locationId");
    const logId = toPositiveInt(req.params.logId, "logId");

    const result = await withTransaction(async (conn) => {
      const log = await fetchOne(
        conn,
        `SELECT * FROM greenhouse_stage_log WHERE id = ? AND location_id = ? LIMIT 1`,
        [logId, locationId]
      );

      if (!log) throw new AppError("Jurnal yozuvi topilmadi.", 404);

      // Harakatni teskari qaytarish: toStage dan chiqarish, fromStage ga qo'shish
      // 'defect' virtual stage real bosqich emas — adjustStock chaqirmaslik kerak
      if (log.to_stage && GREENHOUSE_STAGES.includes(log.to_stage)) {
        await adjustStock(conn, locationId, log.to_stage, -log.quantity);
      }
      if (log.from_stage && GREENHOUSE_STAGES.includes(log.from_stage)) {
        await adjustStock(conn, locationId, log.from_stage, log.quantity);
      }

      await conn.query(`DELETE FROM greenhouse_stage_log WHERE id = ?`, [logId]);

      const stock = await getLocationStock(conn, locationId);
      return { stock };
    });

    return sendOk(res, result, "Jurnal yozuvi o'chirildi va miqdorlar qaytarildi.");
  })
);

export default router;
