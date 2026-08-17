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
import {
  GREENHOUSE_STAGES,
  ensureLogColumns,
  ensureVarietyStockTable,
  ensureGreenhouseTransfersTable,
  ensureGreenhouseTransfersColumns,
  adjustVarietyStock,
  adjustStock,
  getLocationStock,
} from "../utils/greenhouse-stock.js";

const router = Router();
router.use(authenticate);

// ─── GET /api/greenhouse/transfers ──────────────────────────────────────────
// Teplitsa-to-teplitsa bosqich transferlari ro'yxati
router.get(
  "/transfers",
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    await ensureGreenhouseTransfersTable(pool);
    await ensureGreenhouseTransfersColumns(pool);

    const [rows] = await pool.query(`
      SELECT gt.*,
        fl.name AS from_location_name,
        tl.name AS to_location_name,
        u1.full_name AS created_by_name,
        u2.full_name AS sender_confirmed_by_name,
        u3.full_name AS head_confirmed_by_name,
        u4.full_name AS receiver_confirmed_by_name,
        rt.name AS rootstock_type_name,
        v.name AS variety_name,
        st.name AS seedling_type_name
      FROM greenhouse_transfers gt
      LEFT JOIN locations fl ON fl.id = gt.from_location_id
      LEFT JOIN locations tl ON tl.id = gt.to_location_id
      LEFT JOIN users u1 ON u1.id = gt.created_by
      LEFT JOIN users u2 ON u2.id = gt.sender_confirmed_by
      LEFT JOIN users u3 ON u3.id = gt.head_confirmed_by
      LEFT JOIN users u4 ON u4.id = gt.receiver_confirmed_by
      LEFT JOIN rootstock_types rt ON rt.id = gt.rootstock_type_id
      LEFT JOIN varieties v ON v.id = gt.variety_id
      LEFT JOIN seedling_types st ON st.id = gt.seedling_type_id
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
    await ensureVarietyStockTable(getPool());
    await ensureGreenhouseTransfersColumns(getPool());

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
      await adjustVarietyStock(
        conn, gt.from_location_id, gt.from_stage,
        gt.variety_id, gt.seedling_type_id, gt.rootstock_type_id, -gt.quantity
      );

      // Chiqish logi
      const transferDate = gt.transfer_date instanceof Date
        ? gt.transfer_date.toISOString().slice(0, 10)
        : String(gt.transfer_date).slice(0, 10);
      await conn.query(
        `INSERT INTO greenhouse_stage_log
          (location_id, action_date, from_stage, to_stage, quantity, notes, created_by, action_type,
           from_rootstock_type_id, variety_id, seedling_type_id)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 'transfer_out', ?, ?, ?)`,
        [gt.from_location_id, transferDate, gt.from_stage,
         gt.quantity, gt.note, req.user.id, gt.rootstock_type_id || null,
         gt.variety_id || null, gt.seedling_type_id || null]
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
    await ensureVarietyStockTable(getPool());
    await ensureGreenhouseTransfersColumns(getPool());

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
      await adjustVarietyStock(
        conn, gt.to_location_id, gt.to_stage,
        gt.variety_id, gt.seedling_type_id, gt.rootstock_type_id, gt.quantity
      );

      // Kirim logi
      const transferDate = gt.transfer_date instanceof Date
        ? gt.transfer_date.toISOString().slice(0, 10)
        : String(gt.transfer_date).slice(0, 10);
      await conn.query(
        `INSERT INTO greenhouse_stage_log
          (location_id, action_date, from_stage, to_stage, quantity, notes, created_by, action_type,
           rootstock_type_id, variety_id, seedling_type_id)
         VALUES (?, ?, NULL, ?, ?, ?, ?, 'transfer_in', ?, ?, ?)`,
        [gt.to_location_id, transferDate, gt.to_stage, gt.quantity, gt.note, req.user.id,
         gt.rootstock_type_id || null, gt.variety_id || null, gt.seedling_type_id || null]
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

    await ensureVarietyStockTable(getPool());

    const result = await withTransaction(async (conn) => {
      const location = await fetchOne(
        conn,
        "SELECT id, name FROM locations WHERE id = ? LIMIT 1",
        [locationId]
      );
      if (!location) throw new AppError("Lokatsiya topilmadi.", 404);

      await adjustStock(conn, locationId, "cassette", quantity);
      // Nav/tur ma'lumoti yo'q — "Aniqlanmagan" buketga yoziladi, hech qachon yo'qolmaydi
      await adjustVarietyStock(conn, locationId, "cassette", 0, 0, 0, quantity);

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

      // Agar foydalanuvchi aniq nav/payvand turini tanlagan bo'lsa, umumiy bosqich
      // jamisi yetarli bo'lsa ham, AYNAN shu birikmada yetarli borligini alohida tekshiramiz —
      // aks holda umumiy sondan to'g'ri ayiriladi-yu, lekin aniq buket "manfiy"ga kirib,
      // 0 da qolib, farq boshqa hech qayerda ko'rinmay yo'qolib ketadi (nav-taqsimot xato bo'lib qoladi).
      const fromBucketVarietyId = fromStageIsRootstockOnly ? 0 : (varietyId || 0);
      const fromBucketSeedlingTypeId = fromStageIsRootstockOnly ? 0 : (seedlingTypeId || 0);
      const fromBucketRootstockId = effectiveRootstockTypeId || 0;
      const fromBucketIsSpecific =
        fromBucketVarietyId !== 0 || fromBucketSeedlingTypeId !== 0 || fromBucketRootstockId !== 0;

      if (fromBucketIsSpecific) {
        const [bucketRows] = await conn.query(
          `SELECT quantity FROM greenhouse_variety_stock
           WHERE location_id = ? AND stage = ? AND variety_id = ? AND seedling_type_id = ? AND rootstock_type_id = ?
           LIMIT 1`,
          [locationId, fromStage, fromBucketVarietyId, fromBucketSeedlingTypeId, fromBucketRootstockId]
        );
        const bucketAvailable = Number(bucketRows[0]?.quantity || 0);
        if (bucketAvailable < needed) {
          throw new AppError(
            `Tanlangan nav/payvand turida yetarli miqdor yo'q. Mavjud: ${bucketAvailable}, kerak: ${needed}.`,
            400
          );
        }
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
// Nav bo'yicha har bir bosqichdagi ko'chatlar soni — greenhouse_variety_stock
// jadvalidan to'g'ridan-to'g'ri o'qiladi (har bir harakat shu jadvalni ham yangilaydi,
// shuning uchun bu yerda taxminiy/proportional tuzatish kerak emas — sonlar har doim aniq).
router.get(
  "/:locationId/variety-stock",
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const locationId = toPositiveInt(req.params.locationId, "locationId");

    await ensureVarietyStockTable(pool);

    const [rows] = await pool.query(
      `SELECT gvs.stage,
              gvs.variety_id,
              gvs.seedling_type_id,
              gvs.rootstock_type_id,
              gvs.quantity,
              v.name AS variety_name,
              st.name AS seedling_type_name,
              rt.name AS rootstock_type_name
       FROM greenhouse_variety_stock gvs
       LEFT JOIN varieties       v  ON v.id  = gvs.variety_id
       LEFT JOIN seedling_types  st ON st.id = gvs.seedling_type_id
       LEFT JOIN rootstock_types rt ON rt.id = gvs.rootstock_type_id
       WHERE gvs.location_id = ? AND gvs.quantity > 0
       ORDER BY gvs.stage, gvs.quantity DESC`,
      [locationId]
    );
    return sendOk(res, rows);
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
    // cassette/grafting faqat rootstock bo'yicha kuzatiladi — nav/tur shu ikki bosqichda ahamiyatsiz
    const fromStageIsRootstockOnly = ["cassette", "grafting"].includes(fromStage);
    const varietyId = !fromStageIsRootstockOnly && req.body.varietyId != null ? Number(req.body.varietyId) : null;
    const seedlingTypeId = !fromStageIsRootstockOnly && req.body.seedlingTypeId != null ? Number(req.body.seedlingTypeId) : null;
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
    await ensureGreenhouseTransfersColumns(getPool());
    await ensureVarietyStockTable(getPool());

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

      // Aniq nav/payvand turi tanlangan bo'lsa, umumiy bosqich jamisidan tashqari
      // AYNAN shu birikmada ham yetarli borligini tekshiramiz (aks holda nav-taqsimot chalkashadi).
      const fromBucketVarietyId = varietyId || 0;
      const fromBucketSeedlingTypeId = seedlingTypeId || 0;
      const fromBucketRootstockId = fromRootstockTypeId || 0;
      const fromBucketIsSpecific =
        fromBucketVarietyId !== 0 || fromBucketSeedlingTypeId !== 0 || fromBucketRootstockId !== 0;

      if (fromBucketIsSpecific) {
        const [bucketRows] = await conn.query(
          `SELECT quantity FROM greenhouse_variety_stock
           WHERE location_id = ? AND stage = ? AND variety_id = ? AND seedling_type_id = ? AND rootstock_type_id = ?
           LIMIT 1`,
          [fromLocationId, fromStage, fromBucketVarietyId, fromBucketSeedlingTypeId, fromBucketRootstockId]
        );
        const bucketAvailable = Number(bucketRows[0]?.quantity || 0);
        if (bucketAvailable < quantity) {
          throw new AppError(
            `Tanlangan nav/payvand turida yetarli miqdor yo'q. Mavjud: ${bucketAvailable}, kerak: ${quantity}.`,
            400
          );
        }
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
           rootstock_type_id, variety_id, seedling_type_id, transfer_date, note, status, created_by,
           sender_confirmed, sender_confirmed_by, sender_confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_head', ?, 1, ?, NOW())`,
        [transferCode, fromLocationId, toLocationId, fromStage, toStage, quantity,
         fromRootstockTypeId || null, varietyId || null, seedlingTypeId || null,
         actionDateStr, transferNote, req.user.id, req.user.id]
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

    await ensureVarietyStockTable(getPool());

    const result = await withTransaction(async (conn) => {
      const log = await fetchOne(
        conn,
        `SELECT * FROM greenhouse_stage_log WHERE id = ? AND location_id = ? LIMIT 1`,
        [logId, locationId]
      );

      if (!log) throw new AppError("Jurnal yozuvi topilmadi.", 404);

      // Harakatni teskari qaytarish: toStage dan chiqarish, fromStage ga qo'shish
      // (nav-stock jadvali ham xuddi shu shartlar bilan qaytariladi, ikkalasi mos qoladi)
      // 'defect' virtual stage real bosqich emas — adjustStock chaqirmaslik kerak
      if (log.to_stage && GREENHOUSE_STAGES.includes(log.to_stage)) {
        await adjustStock(conn, locationId, log.to_stage, -log.quantity);
        await adjustVarietyStock(
          conn, locationId, log.to_stage,
          log.variety_id, log.seedling_type_id, log.rootstock_type_id, -log.quantity
        );
      }
      if (log.from_stage && GREENHOUSE_STAGES.includes(log.from_stage)) {
        await adjustStock(conn, locationId, log.from_stage, log.quantity);
        await adjustVarietyStock(
          conn, locationId, log.from_stage,
          log.variety_id, log.seedling_type_id, log.rootstock_type_id, log.quantity
        );
      }

      await conn.query(`DELETE FROM greenhouse_stage_log WHERE id = ?`, [logId]);

      const stock = await getLocationStock(conn, locationId);
      return { stock };
    });

    return sendOk(res, result, "Jurnal yozuvi o'chirildi va miqdorlar qaytarildi.");
  })
);

export default router;
