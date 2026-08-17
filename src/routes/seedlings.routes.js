import { Router } from "express";
import { getPool, withTransaction } from "../config/database.js";
import asyncHandler from "../utils/async-handler.js";
import AppError from "../utils/app-error.js";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import { fetchOne } from "../utils/db-helpers.js";
import { requireFields, toBoolean, toInteger, toPositiveInt } from "../utils/validation.js";
import { logActivity } from "../utils/activity.js";
import { sendCreated, sendOk } from "../utils/http.js";
import { generateCode } from "../utils/code-generator.js";
import { saveSeedlingImages } from "../utils/upload-storage.js";
import { buildSeedlingBatchCodeArtifacts, parseSeedlingBatchCode } from "../utils/seedling-code.js";
import {
  createNotifications,
  getNotificationRecipientIds,
  getSeedlingApprovalRecipientIds
} from "../utils/notifications.js";
import {
  ensureLocationExists,
  ensureUnknownCatalog,
  ensureRootstockTypeExists,
  ensureSeedlingTypeExists,
  ensureVarietyExists,
  ensureFallbackVarietyForType,
  getInventoryByBatchAndLocation
} from "../utils/inventory.js";

const router = Router();

router.use(authenticate);

const seedlingBatchColumnCache = new Map();

async function hasSeedlingBatchColumn(conn, columnName) {
  if (seedlingBatchColumnCache.has(columnName)) {
    return seedlingBatchColumnCache.get(columnName);
  }

  const [rows] = await conn.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'seedling_batches'
       AND column_name = ?
     LIMIT 1`,
    [columnName]
  );

  const exists = Boolean(rows[0]);
  seedlingBatchColumnCache.set(columnName, exists);
  return exists;
}

async function updateSeedlingBatchCompatibility(conn, batchId, fields) {
  const updates = [];
  const values = [];

  for (const [columnName, value] of Object.entries(fields)) {
    if (await hasSeedlingBatchColumn(conn, columnName)) {
      updates.push(`${columnName} = ?`);
      values.push(value);
    }
  }

  if (!updates.length) {
    return;
  }

  values.push(batchId);
  await conn.query(`UPDATE seedling_batches SET ${updates.join(", ")} WHERE id = ?`, values);
}

async function resolveCatalogSelection(conn, rawSeedlingTypeId, rawVarietyId) {
  const unknownCatalog = await ensureUnknownCatalog(conn);
  const seedlingTypeId = rawSeedlingTypeId
    ? toPositiveInt(rawSeedlingTypeId, "seedlingTypeId")
    : unknownCatalog.seedlingTypeId;

  const seedlingType = await ensureSeedlingTypeExists(conn, seedlingTypeId);

  if (rawVarietyId) {
    const variety = await ensureVarietyExists(conn, toPositiveInt(rawVarietyId, "varietyId"));

    if (variety.seedling_type_id !== seedlingTypeId) {
      throw new AppError("Variety tanlangan seedling type ga tegishli emas.", 400);
    }

    return {
      seedlingTypeId,
      varietyId: variety.id,
      seedlingType,
      variety
    };
  }

  const fallbackVariety =
    seedlingTypeId === unknownCatalog.seedlingTypeId
      ? unknownCatalog.variety
      : await ensureFallbackVarietyForType(conn, seedlingTypeId);

  return {
    seedlingTypeId,
    varietyId: fallbackVariety.id,
    seedlingType,
    variety: fallbackVariety
  };
}

function serializePayloadJson(payload) {
  try {
    return JSON.stringify(payload ?? null);
  } catch {
    return null;
  }
}

function withBatchCodeArtifacts(batch) {
  const quantityAvailable = Number(batch?.quantity_available ?? batch?.healthy_quantity ?? 0);
  const defectQuantity = Number(batch?.defect_quantity ?? batch?.defective_quantity ?? 0);
  const artifacts = buildSeedlingBatchCodeArtifacts({
    batchId: batch?.batch_id ?? batch?.id,
    batchCode: batch?.batch_code ?? batch?.batch_number,
    labelCodeType: batch?.label_code_type,
    qrPayload: batch?.qr_payload,
    barcodeValue: batch?.barcode_value,
    quantity: batch?.initial_quantity ?? quantityAvailable + defectQuantity,
    receivedAt:
      batch?.received_at_exact ??
      batch?.batch_created_at ??
      batch?.created_at ??
      batch?.received_date ??
      batch?.last_activity_at,
    receivedDate: batch?.received_date,
    locationId: batch?.source_location_id ?? batch?.location_id,
    locationName: batch?.source_location_name ?? batch?.location_name,
    seedlingTypeId: batch?.seedling_type_id,
    seedlingTypeName: batch?.seedling_type_name,
    varietyId: batch?.variety_id,
    varietyName: batch?.variety_name,
    rootstockTypeId: batch?.rootstock_type_id,
    rootstockTypeName: batch?.rootstock_type_name,
    notes: batch?.notes || "",
  });

  return {
    ...batch,
    label_code_type: artifacts.labelCodeType,
    qr_payload: artifacts.qrPayload,
    barcode_value: artifacts.barcodeValue,
  };
}

async function fetchBatchForScan(conn, lookup, userLocationId) {
  if (!lookup?.batchId && !lookup?.batchCode) {
    return null;
  }

  const conditions = [];
  const params = [Number(userLocationId || 0)];

  if (lookup.batchId) {
    conditions.push("b.id = ?");
    params.push(toPositiveInt(lookup.batchId, "batchId"));
  }

  if (lookup.batchCode) {
    conditions.push("b.batch_code = ?");
    params.push(String(lookup.batchCode).trim());
  }

  const [rows] = await conn.query(
    `SELECT b.id AS batch_id,
            COALESCE(user_inventory.id, source_inventory.id) AS inventory_id,
            COALESCE(user_inventory.location_id, source_inventory.location_id, b.source_location_id) AS location_id,
            COALESCE(user_inventory.current_stage, source_inventory.current_stage, 'cassette') AS current_stage,
            COALESCE(user_inventory.quantity_available, source_inventory.quantity_available, b.initial_quantity) AS quantity_available,
            COALESCE(user_inventory.defect_quantity, source_inventory.defect_quantity, 0) AS defect_quantity,
            COALESCE(user_inventory.last_activity_at, source_inventory.last_activity_at, b.updated_at, b.created_at) AS last_activity_at,
            b.batch_code, b.received_date, b.initial_quantity, b.notes,
            b.label_code_type, b.qr_payload, b.barcode_value, b.source_location_id,
            b.created_at AS batch_created_at, b.updated_at,
            st.id AS seedling_type_id, st.name AS seedling_type_name,
            v.id AS variety_id, v.name AS variety_name,
            rt.id AS rootstock_type_id, rt.name AS rootstock_type_name,
            sl.name AS source_location_name
     FROM seedling_batches b
     LEFT JOIN seedling_inventory source_inventory
       ON source_inventory.batch_id = b.id AND source_inventory.location_id = b.source_location_id
     LEFT JOIN seedling_inventory user_inventory
       ON user_inventory.batch_id = b.id AND user_inventory.location_id = ?
     LEFT JOIN seedling_types st ON st.id = b.seedling_type_id
     LEFT JOIN varieties v ON v.id = b.variety_id
     LEFT JOIN rootstock_types rt ON rt.id = b.rootstock_type_id
     LEFT JOIN locations sl ON sl.id = b.source_location_id
     WHERE ${conditions.join(" OR ")}
     ORDER BY b.id DESC
     LIMIT 1`,
    params
  );

  return rows[0] ? withBatchCodeArtifacts(rows[0]) : null;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const conditions = ["1 = 1"];
    const params = [];

    if (req.user.role === "agranom") {
      if (!req.user.locationId) {
        return sendOk(res, []);
      }

      conditions.push("si.location_id = ?");
      params.push(req.user.locationId);
    }

    if (req.query.locationId) {
      conditions.push("si.location_id = ?");
      params.push(req.query.locationId);
    }

    if (req.query.type) {
      conditions.push("l.type = ?");
      params.push(req.query.type);
    }

    if (req.query.stage) {
      conditions.push("si.current_stage = ?");
      params.push(req.query.stage);
    }

    if (req.query.readyOnly === "true") {
      conditions.push("si.current_stage = 'ready'");
    }

    if (req.query.defectOnly === "true") {
      conditions.push("si.defect_quantity > 0");
    }

    if (req.query.dateFrom) {
      conditions.push("si.last_activity_at >= ?");
      params.push(`${req.query.dateFrom} 00:00:00`);
    }

    if (req.query.dateTo) {
      conditions.push("si.last_activity_at <= ?");
      params.push(`${req.query.dateTo} 23:59:59`);
    }

    if (req.query.seedlingTypeId) {
      conditions.push("b.seedling_type_id = ?");
      params.push(req.query.seedlingTypeId);
    }

    if (req.query.varietyId) {
      conditions.push("b.variety_id = ?");
      params.push(req.query.varietyId);
    }

    if (req.query.batchCode) {
      conditions.push("b.batch_code = ?");
      params.push(req.query.batchCode);
    }

    const [rows] = await pool.query(
      `SELECT si.id AS inventory_id, si.batch_id, si.location_id, si.current_stage,
              si.quantity_available, si.defect_quantity, si.last_activity_at,
              b.batch_code, b.received_date, b.initial_quantity, b.notes,
              b.label_code_type, b.qr_payload, b.barcode_value, b.source_location_id,
              b.created_at AS batch_created_at,
              st.id AS seedling_type_id, st.name AS seedling_type_name, st.code AS seedling_type_code,
              v.id AS variety_id, v.name AS variety_name, v.code AS variety_code,
              rt.id AS rootstock_type_id, rt.name AS rootstock_type_name, rt.code AS rootstock_type_code,
              l.name AS location_name, l.code AS location_code, l.type AS location_type,
              sl.name AS source_location_name,
              last_history.last_history_id, last_history.created_by AS last_history_created_by,
              last_history.approved_by, last_history.approval_status, last_history.image_paths, last_history.stage_date,
              receive_history.stage_date AS received_at_exact, receive_history.next_stage AS received_stage,
              gss_ready.quantity AS greenhouse_ready_qty
       FROM seedling_inventory si
       JOIN seedling_batches b ON b.id = si.batch_id
       LEFT JOIN seedling_types st ON st.id = b.seedling_type_id
       LEFT JOIN varieties v ON v.id = b.variety_id
       LEFT JOIN rootstock_types rt ON rt.id = b.rootstock_type_id
       JOIN locations l ON l.id = si.location_id
       LEFT JOIN locations sl ON sl.id = b.source_location_id
       LEFT JOIN (
         SELECT h.inventory_id, h.id AS last_history_id, h.created_by, h.approved_by, h.approval_status, h.image_paths, h.stage_date
         FROM seedling_history h
         INNER JOIN (
           SELECT inventory_id, MAX(id) AS last_history_id
           FROM seedling_history
           WHERE inventory_id IS NOT NULL
           GROUP BY inventory_id
         ) latest ON latest.last_history_id = h.id
       ) last_history ON last_history.inventory_id = si.id
       LEFT JOIN (
         SELECT h.batch_id, h.stage_date, h.next_stage
         FROM seedling_history h
         INNER JOIN (
           SELECT batch_id, MIN(id) AS first_history_id
           FROM seedling_history
           WHERE action_type = 'receive'
           GROUP BY batch_id
         ) earliest ON earliest.first_history_id = h.id
       ) receive_history ON receive_history.batch_id = si.batch_id
       LEFT JOIN greenhouse_variety_stock gss_ready
         ON gss_ready.location_id = si.location_id
         AND gss_ready.stage = 'ready'
         AND gss_ready.variety_id = COALESCE(b.variety_id, 0)
         AND gss_ready.seedling_type_id = COALESCE(b.seedling_type_id, 0)
         AND gss_ready.rootstock_type_id = COALESCE(b.rootstock_type_id, 0)
       WHERE ${conditions.join(" AND ")}
       ORDER BY si.updated_at DESC, si.id DESC`,
      params
    );

    return sendOk(res, rows.map(withBatchCodeArtifacts));
  })
);

router.post(
  "/scan",
  asyncHandler(async (req, res) => {
    requireFields(req.body, ["code"]);

    const result = await withTransaction(async (conn) => {
      const parsedCode = parseSeedlingBatchCode(req.body.code);

      if (!parsedCode) {
        throw new AppError("Scan kodi bo'sh yoki noto'g'ri.", 400);
      }

      const batch = await fetchBatchForScan(conn, parsedCode.payload, req.user.locationId);

      if (!batch) {
        throw new AppError("Skaner qilingan batch topilmadi.", 404);
      }

      const [scanResult] = await conn.query(
        `INSERT INTO seedling_scan_events
          (batch_id, inventory_id, user_id, location_id, code_type, raw_code, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          batch.batch_id,
          batch.inventory_id ?? null,
          req.user.id,
          req.user.locationId ?? batch.location_id ?? null,
          parsedCode.codeType,
          parsedCode.rawValue,
          serializePayloadJson(parsedCode.payload),
        ]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "seedling_scanned",
        entityType: "batch",
        entityId: batch.batch_id,
        description: `${batch.batch_code} partiyasi skaner qilindi`,
        metadata: {
          scanId: scanResult.insertId,
          codeType: parsedCode.codeType,
          locationId: req.user.locationId ?? batch.location_id ?? null,
        },
      });

      return {
        scanId: scanResult.insertId,
        codeType: parsedCode.codeType,
        scannedAt: new Date().toISOString(),
        assignedUserId: req.user.id,
        assignedLocationId: req.user.locationId ?? batch.location_id ?? null,
        batch,
      };
    });

    return sendCreated(res, result, "QR/barcode muvaffaqiyatli skaner qilindi.");
  })
);

router.get(
  "/scans/me",
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
    const [rows] = await pool.query(
      `SELECT s.id AS scan_id, s.code_type, s.raw_code, s.payload_json, s.created_at AS scanned_at,
              b.id AS batch_id, b.batch_code, b.received_date, b.initial_quantity, b.notes,
              b.label_code_type, b.qr_payload, b.barcode_value, b.source_location_id,
              b.created_at AS batch_created_at, b.updated_at,
              st.id AS seedling_type_id, st.name AS seedling_type_name,
              v.id AS variety_id, v.name AS variety_name,
              rt.id AS rootstock_type_id, rt.name AS rootstock_type_name,
              COALESCE(scan_inventory.id, source_inventory.id) AS inventory_id,
              COALESCE(scan_inventory.location_id, source_inventory.location_id, b.source_location_id) AS location_id,
              COALESCE(scan_inventory.current_stage, source_inventory.current_stage, 'cassette') AS current_stage,
              COALESCE(scan_inventory.quantity_available, source_inventory.quantity_available, b.initial_quantity) AS quantity_available,
              COALESCE(scan_inventory.defect_quantity, source_inventory.defect_quantity, 0) AS defect_quantity,
              COALESCE(scan_inventory.last_activity_at, source_inventory.last_activity_at, b.updated_at, b.created_at) AS last_activity_at,
              sl.name AS source_location_name,
              current_location.name AS location_name
       FROM seedling_scan_events s
       JOIN seedling_batches b ON b.id = s.batch_id
       LEFT JOIN seedling_inventory scan_inventory ON scan_inventory.id = s.inventory_id
       LEFT JOIN seedling_inventory source_inventory
         ON source_inventory.batch_id = b.id AND source_inventory.location_id = b.source_location_id
       LEFT JOIN seedling_types st ON st.id = b.seedling_type_id
       LEFT JOIN varieties v ON v.id = b.variety_id
       LEFT JOIN rootstock_types rt ON rt.id = b.rootstock_type_id
       LEFT JOIN locations sl ON sl.id = b.source_location_id
       LEFT JOIN locations current_location
         ON current_location.id = COALESCE(scan_inventory.location_id, source_inventory.location_id, b.source_location_id)
       WHERE s.user_id = ?
       ORDER BY s.id DESC
       LIMIT ?`,
      [req.user.id, limit]
    );

    return sendOk(
      res,
      rows.map((row) => {
        const batch = withBatchCodeArtifacts(row);

        return {
          id: row.scan_id,
          codeType: row.code_type,
          rawCode: row.raw_code,
          scannedAt: row.scanned_at,
          batch,
        };
      })
    );
  })
);

router.post(
  "/receive",
  authorize("admin", "agranom"),
  asyncHandler(async (req, res) => {
    requireFields(req.body, ["locationId", "quantity"]);

    const result = await withTransaction(async (conn) => {
      const locationId = toPositiveInt(req.body.locationId, "locationId");
      const quantity = toPositiveInt(req.body.quantity, "quantity");
      const stage = req.body.stage || "cassette";
      const labelCodeType = String(req.body.labelCodeType || "qr").trim().toLowerCase() === "barcode"
        ? "barcode"
        : "qr";
      const requiresApproval = toBoolean(req.body.requiresApproval, false);
      const approvalStatus = requiresApproval ? "pending" : "approved";
      const batchCode = req.body.batchCode || generateCode("BATCH");
      const receivedAt = req.body.receivedAt ? new Date(req.body.receivedAt) : new Date();

      if (Number.isNaN(receivedAt.getTime())) {
        throw new AppError("Kirim vaqti noto'g'ri yuborildi.", 400);
      }

      const receivedDate = req.body.receivedDate || receivedAt.toISOString().slice(0, 10);

      if (req.user.role === "agranom" && req.user.locationId !== locationId) {
        throw new AppError("Siz faqat o'zingizga biriktirilgan lokatsiyaga kirim qila olasiz.", 403);
      }

      // Faqat manba (is_source=1) lokatsiyalar partiya yarata oladi
      const sourceCheck = await fetchOne(
        conn,
        `SELECT id, is_source FROM locations WHERE id = ? LIMIT 1`,
        [locationId]
      );
      if (sourceCheck && sourceCheck.is_source !== undefined && !sourceCheck.is_source) {
        throw new AppError(
          "Bu lokatsiya partiya yarata olmaydi. Faqat manba (Jomboy) lokatsiyalar partiya yaratishi mumkin.",
          403
        );
      }

      const { seedlingTypeId, varietyId, seedlingType, variety } = await resolveCatalogSelection(
        conn,
        req.body.seedlingTypeId,
        req.body.varietyId
      );
      const rootstockTypeId = req.body.rootstockTypeId
        ? toPositiveInt(req.body.rootstockTypeId, "rootstockTypeId")
        : null;
      const location = await ensureLocationExists(conn, locationId);
      const rootstockType = rootstockTypeId
        ? await ensureRootstockTypeExists(conn, rootstockTypeId)
        : null;

      const batchColumns = [];
      const batchValues = [];

      const optionalBatchFields = {
        batch_number: batchCode,
        location_id: locationId,
        current_stage: stage,
        quantity,
        healthy_quantity: quantity,
        defective_quantity: 0,
        approval_status: approvalStatus,
        note: req.body.notes || null,
        label_code_type: labelCodeType,
      };

      for (const [columnName, value] of Object.entries(optionalBatchFields)) {
        if (await hasSeedlingBatchColumn(conn, columnName)) {
          batchColumns.push(columnName);
          batchValues.push(value);
        }
      }

      batchColumns.push(
        "batch_code",
        "seedling_type_id",
        "variety_id",
        "rootstock_type_id",
        "source_location_id",
        "received_date",
        "initial_quantity",
        "notes",
        "created_by"
      );
      batchValues.push(
        batchCode,
        seedlingTypeId,
        varietyId,
        rootstockTypeId,
        locationId,
        receivedDate,
        quantity,
        req.body.notes || null,
        req.user.id
      );

      const placeholders = batchColumns.map(() => "?").join(", ");
      const [batchResult] = await conn.query(
        `INSERT INTO seedling_batches
          (${batchColumns.join(", ")})
         VALUES (${placeholders})`,
        batchValues
      );

      const batchId = batchResult.insertId;

      const [inventoryResult] = await conn.query(
        `INSERT INTO seedling_inventory
          (batch_id, location_id, current_stage, quantity_available, defect_quantity, last_activity_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
        [batchId, locationId, stage, quantity, receivedAt]
      );

      const inventoryId = inventoryResult.insertId;

      const codeArtifacts = buildSeedlingBatchCodeArtifacts({
        batchId,
        batchCode,
        labelCodeType,
        quantity,
        receivedAt: receivedAt.toISOString(),
        receivedDate,
        locationId: location.id,
        locationName: location.name,
        seedlingTypeId,
        seedlingTypeName: seedlingType.name,
        varietyId: variety.id,
        varietyName: variety.name,
        rootstockTypeId,
        rootstockTypeName: rootstockType?.name ?? null,
        notes: req.body.notes || "",
      });

      await updateSeedlingBatchCompatibility(conn, batchId, {
        label_code_type: codeArtifacts.labelCodeType,
        qr_payload: codeArtifacts.qrPayload,
        barcode_value: codeArtifacts.barcodeValue,
      });

      const [historyResult] = await conn.query(
        `INSERT INTO seedling_history
          (batch_id, inventory_id, action_type, to_location_id, next_stage, quantity,
           stage_date, approval_status, requires_approval, notes, created_by)
         VALUES (?, ?, 'receive', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          batchId,
          inventoryId,
          locationId,
          stage,
          quantity,
          receivedAt,
          approvalStatus,
          requiresApproval ? 1 : 0,
          req.body.notes || null,
          req.user.id
        ]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "seedlings_received",
        entityType: "batch",
        entityId: batchId,
        description: `${quantity} ta ko'chat qabul qilindi`,
        metadata: {
          batchCode,
          locationId,
          quantity,
          stage,
          seedlingTypeId,
          varietyId: variety.id,
          rootstockTypeId,
          receivedAt: receivedAt.toISOString()
        }
      });

      if (requiresApproval) {
        const notificationRecipientIds = await getSeedlingApprovalRecipientIds(conn, [req.user.id]);
        await createNotifications(conn, notificationRecipientIds, {
          type: "seedling_approval_required",
          title: "Yangi tasdiq kutilmoqda",
          message: `${batchCode} partiyasi uchun kirim tasdig'i kutilmoqda`,
          entityType: "seedling_history",
          entityId: historyResult.insertId,
          locationId,
          createdBy: req.user.id,
        });
      } else {
        const notificationRecipientIds = await getNotificationRecipientIds(conn, {
          locationIds: [locationId],
          includeAgranomsForLocations: true,
          roles: ["admin", "bosh_agranom"],
          excludeUserIds: [req.user.id],
        });
        await createNotifications(conn, notificationRecipientIds, {
          type: "seedlings_received",
          title: "Yangi kirim qabul qilindi",
          message: `${batchCode} partiyasi ${quantity} ta miqdor bilan qabul qilindi`,
          entityType: "batch",
          entityId: batchId,
          locationId,
          createdBy: req.user.id,
        });
      }

      // Har bir ko'chat uchun alohida dona kodlar yaratish
      const unitPrefix = batchCode.replace(/^(BATCH|KO|KOCHAT|SEEDLING|URUG)-?/i, "").trim() || batchCode;
      const unitInserts = [];
      for (let i = 1; i <= quantity; i++) {
        const unitCode = `PLT-${unitPrefix}-${String(i).padStart(4, "0")}`;
        const unitQrPayload = unitCode; // faqat unitCode — kamera oson o'qiydi
        unitInserts.push([batchId, i, unitCode, unitQrPayload, stage]);
      }
      if (unitInserts.length > 0) {
        // Jadval mavjudligini tekshirib qo'shish
        const [tableCheck] = await conn.query(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema = DATABASE() AND table_name = 'seedling_units' LIMIT 1`
        );
        if (tableCheck.length > 0) {
          for (const unitRow of unitInserts) {
            await conn.query(
              `INSERT IGNORE INTO seedling_units
                (batch_id, unit_number, unit_code, qr_payload, current_stage)
               VALUES (?, ?, ?, ?, ?)`,
              unitRow
            );
          }
        }
      }

      return {
        batchId,
        batchCode,
        inventoryId,
        historyId: historyResult.insertId,
        quantity,
        stage,
        approvalStatus,
        labelCodeType: codeArtifacts.labelCodeType,
        qrPayload: codeArtifacts.qrPayload,
        barcodeValue: codeArtifacts.barcodeValue,
      };
    });

    return sendCreated(res, result, "Ko'chat partiyasi qabul qilindi.");
  })
);

router.post(
  "/stage-change",
  authorize("admin", "agranom"),
  asyncHandler(async (req, res) => {
    requireFields(req.body, ["batchId", "locationId", "nextStage"]);

    const result = await withTransaction(async (conn) => {
      const batchId = toPositiveInt(req.body.batchId, "batchId");
      const locationId = toPositiveInt(req.body.locationId, "locationId");
      const nextStage = req.body.nextStage;
      const quantityAdjustment = toInteger(req.body.quantityAdjustment, "quantityAdjustment", 0);
      const defectQuantityChange = toInteger(req.body.defectQuantityChange, "defectQuantityChange", 0);
      // failedGraftQuantity: payvant olmagan ko'chatlar qaytariladi oldingi bosqichga
      const failedGraftQuantity = toInteger(req.body.failedGraftQuantity, "failedGraftQuantity", 0);
      const fromStage = req.body.fromStage || null;
      const requiresApproval = toBoolean(req.body.requiresApproval, false);
      const approvalStatus = requiresApproval ? "pending" : "approved";
      const stageDate = req.body.stageDate ? new Date(req.body.stageDate) : new Date();

      if (Number.isNaN(stageDate.getTime())) {
        throw new AppError("Stage sanasi noto'g'ri yuborildi.", 400);
      }

      if (req.user.role === "agranom" && req.user.locationId !== locationId) {
        throw new AppError("Siz faqat o'zingizning lokatsiyangizdagi partiyani yangilay olasiz.", 403);
      }

      await ensureLocationExists(conn, locationId);

      const batch = await fetchOne(
        conn,
        `SELECT b.id, b.batch_code, b.seedling_type_id, b.variety_id
         FROM seedling_batches b
         WHERE b.id = ?
         LIMIT 1`,
        [batchId]
      );

      if (!batch) {
        throw new AppError("Batch topilmadi.", 404);
      }

      let inventory;
      if (fromStage) {
        inventory = await fetchOne(
          conn,
          `SELECT * FROM seedling_inventory WHERE batch_id = ? AND location_id = ? AND current_stage = ? LIMIT 1 FOR UPDATE`,
          [batchId, locationId, fromStage]
        );
      } else {
        inventory = await getInventoryByBatchAndLocation(conn, batchId, locationId, true);
      }

      if (!inventory) {
        throw new AppError("Berilgan batch uchun shu lokatsiyada inventar topilmadi.", 404);
      }

      if (failedGraftQuantity < 0) {
        throw new AppError("Muvaffaqiyatsiz payvant soni manfiy bo'lmasligi kerak.", 400);
      }

      const newDefectQuantity = inventory.defect_quantity + defectQuantityChange;
      const newQuantityAvailable = inventory.quantity_available + quantityAdjustment - defectQuantityChange - failedGraftQuantity;

      if (newDefectQuantity < 0) {
        throw new AppError("Defect quantity manfiy bo'lib qolmasligi kerak.", 400);
      }

      if (newQuantityAvailable < 0) {
        throw new AppError("Quantity available manfiy bo'lib qolmasligi kerak.", 400);
      }

      const originalStage = inventory.current_stage;

      await conn.query(
        `UPDATE seedling_inventory
         SET current_stage = ?, quantity_available = ?, defect_quantity = ?, last_activity_at = ?
         WHERE id = ?`,
        [nextStage, newQuantityAvailable, newDefectQuantity, stageDate, inventory.id]
      );

      // Muvaffaqiyatsiz payvantlarni oldingi bosqichga qaytarish
      if (failedGraftQuantity > 0) {
        const [failedRows] = await conn.query(
          `SELECT id, quantity_available FROM seedling_inventory
           WHERE batch_id = ? AND location_id = ? AND current_stage = ? LIMIT 1`,
          [batchId, locationId, originalStage]
        );

        if (failedRows.length > 0) {
          await conn.query(
            `UPDATE seedling_inventory
             SET quantity_available = quantity_available + ?, last_activity_at = ?
             WHERE id = ?`,
            [failedGraftQuantity, stageDate, failedRows[0].id]
          );
        } else {
          await conn.query(
            `INSERT INTO seedling_inventory
              (batch_id, location_id, current_stage, quantity_available, defect_quantity, last_activity_at)
             VALUES (?, ?, ?, ?, 0, ?)`,
            [batchId, locationId, originalStage, failedGraftQuantity, stageDate]
          );
        }
      }

      await updateSeedlingBatchCompatibility(conn, batchId, {
        current_stage: nextStage,
        quantity: newQuantityAvailable + newDefectQuantity,
        healthy_quantity: newQuantityAvailable,
        defective_quantity: newDefectQuantity,
        approval_status: approvalStatus,
        note: req.body.notes || null,
      });

      // Reportlar uchun quantity yangi bosqichga o'tgan sog'lom miqdorni bildiradi.
      const movedHealthyQuantity = Math.max(newQuantityAvailable, 0);

      const imagePaths = await saveSeedlingImages(req.body.defectiveImages, {
        prefix: batch.batch_code || "batch",
      });

      const [historyResult] = await conn.query(
        `INSERT INTO seedling_history
          (batch_id, inventory_id, action_type, from_location_id, to_location_id,
           previous_stage, next_stage, quantity, defect_quantity, image_paths, stage_date, approval_status,
           requires_approval, notes, created_by)
         VALUES (?, ?, 'stage_change', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          batchId,
          inventory.id,
          locationId,
          locationId,
          originalStage,
          nextStage,
          movedHealthyQuantity,
          defectQuantityChange,
          JSON.stringify(imagePaths),
          stageDate,
          approvalStatus,
          requiresApproval ? 1 : 0,
          req.body.notes || null,
          req.user.id
        ]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "seedlings_stage_changed",
        entityType: "batch",
        entityId: batchId,
        description: `${batch.batch_code} batch stage o'zgartirildi`,
        metadata: {
          locationId,
          fromStage: originalStage,
          toStage: nextStage,
          quantityAdjustment,
          defectQuantityChange,
          failedGraftQuantity,
          stageDate: stageDate.toISOString(),
          imageCount: imagePaths.length
        }
      });

      if (requiresApproval) {
        const notificationRecipientIds = await getSeedlingApprovalRecipientIds(conn, [req.user.id]);
        await createNotifications(conn, notificationRecipientIds, {
          type: "seedling_approval_required",
          title: "Bosqich tasdig'i kutilmoqda",
          message: `${batch.batch_code} partiyasi ${nextStage} bosqichiga o'tkazildi va tasdiq kutilmoqda`,
          entityType: "seedling_history",
          entityId: historyResult.insertId,
          locationId,
          createdBy: req.user.id,
        });
      }

      return {
        batchId,
        batchCode: batch.batch_code,
        inventoryId: inventory.id,
        historyId: historyResult.insertId,
        previousStage: originalStage,
        nextStage,
        quantityAvailable: newQuantityAvailable,
        defectQuantity: newDefectQuantity,
        failedGraftQuantity,
        approvalStatus,
        imagePaths,
        stageDate: stageDate.toISOString()
      };
    });

    return sendOk(res, result, "Stage muvaffaqiyatli yangilandi.");
  })
);

// Ko'chatlarni hisobdan chiqarish (qurib qolgan, yo'qolgan va h.k.)
router.post(
  "/write-off",
  authorize("admin", "agranom", "bosh_agranom"),
  asyncHandler(async (req, res) => {
    requireFields(req.body, ["inventoryId", "quantity"]);

    const result = await withTransaction(async (conn) => {
      const inventoryId = toPositiveInt(req.body.inventoryId, "inventoryId");
      const quantity = toPositiveInt(req.body.quantity, "quantity");
      const note = req.body.note || req.body.notes || null;

      const inventory = await fetchOne(
        conn,
        `SELECT si.*, b.batch_code, l.name AS location_name
         FROM seedling_inventory si
         JOIN seedling_batches b ON b.id = si.batch_id
         JOIN locations l ON l.id = si.location_id
         WHERE si.id = ?
         LIMIT 1 FOR UPDATE`,
        [inventoryId]
      );

      if (!inventory) {
        throw new AppError("Inventar topilmadi.", 404);
      }

      if (req.user.role === "agranom" && req.user.locationId !== inventory.location_id) {
        throw new AppError("Siz faqat o'zingizning lokatsiyangizdagi ko'chatlarni hisobdan chiqara olasiz.", 403);
      }

      if (quantity > inventory.quantity_available) {
        throw new AppError(
          `Mavjud miqdordan ko'p chiqarib bo'lmaydi. Mavjud: ${inventory.quantity_available}`,
          400
        );
      }

      const newQuantityAvailable = inventory.quantity_available - quantity;

      await conn.query(
        `UPDATE seedling_inventory
         SET quantity_available = ?, last_activity_at = NOW()
         WHERE id = ?`,
        [newQuantityAvailable, inventoryId]
      );

      await conn.query(
        `INSERT INTO seedling_history
          (batch_id, inventory_id, action_type, from_location_id, to_location_id,
           previous_stage, next_stage, quantity, defect_quantity, image_paths, stage_date,
           approval_status, requires_approval, notes, created_by)
         VALUES (?, ?, 'write_off', ?, NULL, ?, ?, ?, 0, '[]', NOW(), 'approved', 0, ?, ?)`,
        [
          inventory.batch_id,
          inventoryId,
          inventory.location_id,
          inventory.current_stage,
          inventory.current_stage,
          quantity,
          note,
          req.user.id
        ]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "seedlings_written_off",
        entityType: "batch",
        entityId: inventory.batch_id,
        description: `${inventory.batch_code}: ${quantity} ta ko'chat hisobdan chiqarildi`,
        metadata: { inventoryId, quantity, note }
      });

      return {
        inventoryId,
        batchId: inventory.batch_id,
        batchCode: inventory.batch_code,
        writtenOffQuantity: quantity,
        newQuantityAvailable
      };
    });

    return sendOk(res, result, "Ko'chatlar hisobdan chiqarildi.");
  })
);

// Joriy lokatsiya uchun hisobdan chiqarishlar ro'yxati
router.get(
  "/write-offs",
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const locationId = req.user.locationId;

    const [rows] = await pool.query(
      `SELECT h.id, h.batch_id, h.quantity, h.notes, h.stage_date, h.created_at,
              b.batch_code,
              v.name AS variety_name,
              cu.full_name AS created_by_name
       FROM seedling_history h
       JOIN seedling_batches b ON b.id = h.batch_id
       LEFT JOIN varieties v ON v.id = b.variety_id
       LEFT JOIN users cu ON cu.id = h.created_by
       WHERE h.action_type = 'write_off'
         AND h.from_location_id = ?
       ORDER BY h.stage_date DESC, h.id DESC
       LIMIT 50`,
      [locationId]
    );

    return sendOk(res, rows);
  })
);

router.get(
  "/history/:batchId",
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const batchId = toPositiveInt(req.params.batchId, "batchId");

    const batch = await fetchOne(
      pool,
      `SELECT b.id, b.batch_code, st.name AS seedling_type_name, v.name AS variety_name
       FROM seedling_batches b
       LEFT JOIN seedling_types st ON st.id = b.seedling_type_id
       LEFT JOIN varieties v ON v.id = b.variety_id
       WHERE b.id = ?
       LIMIT 1`,
      [batchId]
    );

    if (!batch) {
      throw new AppError("Batch topilmadi.", 404);
    }

    if (req.user.role === "agranom") {
      const allowedBatch = await fetchOne(
        pool,
        `SELECT 1
         FROM seedling_inventory
         WHERE batch_id = ? AND location_id = ?
         LIMIT 1`,
        [batchId, req.user.locationId || 0]
      );

      if (!allowedBatch) {
        throw new AppError("Bu batch tarixini ko'rishga ruxsat yo'q.", 403);
      }
    }

    const [history] = await pool.query(
      `SELECT h.*,
              fl.name AS from_location_name,
              tl.name AS to_location_name,
              cu.full_name AS created_by_name,
              au.full_name AS approved_by_name
       FROM seedling_history h
       LEFT JOIN locations fl ON fl.id = h.from_location_id
       LEFT JOIN locations tl ON tl.id = h.to_location_id
       LEFT JOIN users cu ON cu.id = h.created_by
       LEFT JOIN users au ON au.id = h.approved_by
       WHERE h.batch_id = ?
       ORDER BY h.id DESC`,
      [batchId]
    );

    return sendOk(res, { batch, history });
  })
);

router.post(
  "/:historyId/approve",
  authorize("admin", "bosh_agranom"),
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (conn) => {
      const historyId = toPositiveInt(req.params.historyId, "historyId");
      const history = await fetchOne(
        conn,
        `SELECT h.*, b.batch_code
         FROM seedling_history h
         JOIN seedling_batches b ON b.id = h.batch_id
         WHERE h.id = ?
         LIMIT 1`,
        [historyId]
      );

      if (!history) {
        throw new AppError("History yozuvi topilmadi.", 404);
      }

      if (history.approval_status === "approved") {
        throw new AppError("Bu history allaqachon approve qilingan.", 400);
      }

      await conn.query(
        `UPDATE seedling_history
         SET approval_status = 'approved', approved_by = ?, approved_at = NOW(), approval_note = ?
         WHERE id = ?`,
        [req.user.id, req.body.approvalNote || null, historyId]
      );

      await updateSeedlingBatchCompatibility(conn, history.batch_id, {
        approval_status: "approved",
        approved_by_head_agranom: req.user.id,
      });

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "seedling_history_approved",
        entityType: "seedling_history",
        entityId: historyId,
        description: `${history.batch_code} batch history approve qilindi`
      });

      const notificationRecipientIds = await getNotificationRecipientIds(conn, {
        userIds: [history.created_by],
        excludeUserIds: [req.user.id],
      });
      await createNotifications(conn, notificationRecipientIds, {
        type: "seedling_history_approved",
        title: "Tasdiqlandi",
        message: `${history.batch_code} partiyasi bo'yicha kiritilgan o'zgarish tasdiqlandi`,
        entityType: "seedling_history",
        entityId: historyId,
        locationId: history.to_location_id || history.from_location_id || null,
        createdBy: req.user.id,
      });

      return {
        historyId,
        batchId: history.batch_id,
        approvalStatus: "approved",
        approvedBy: req.user.id
      };
    });

    return sendOk(res, result, "History approve qilindi.");
  })
);

// Teplitsa bo'yicha bosqich xulosasi (har qaysi lokatsiyada nechta ko'chat qaysi bosqichda)
router.get(
  "/greenhouse-summary",
  asyncHandler(async (req, res) => {
    const pool = getPool();

    const conditions = ["l.status = 'active'"];
    const params = [];

    if (req.query.locationType) {
      conditions.push("l.type = ?");
      params.push(req.query.locationType);
    }

    if (req.query.locationId) {
      conditions.push("si.location_id = ?");
      params.push(req.query.locationId);
    }

    if (req.user.role === "agranom") {
      if (!req.user.locationId) return sendOk(res, []);
      conditions.push("si.location_id = ?");
      params.push(req.user.locationId);
    }

    const [rows] = await pool.query(
      `SELECT
         l.id AS location_id,
         l.name AS location_name,
         l.type AS location_type,
         si.current_stage,
         COUNT(si.id) AS batch_count,
         SUM(si.quantity_available) AS total_quantity,
         SUM(si.defect_quantity) AS total_defects
       FROM seedling_inventory si
       JOIN locations l ON l.id = si.location_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY l.id, l.name, l.type, si.current_stage
       ORDER BY l.name, FIELD(si.current_stage, 'cassette','sown','grafting','grafted','ready')`,
      params
    );

    return sendOk(res, rows);
  })
);

// Admin: partiyani o'chirish
router.delete(
  "/batches/:batchId",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const batchId = toPositiveInt(req.params.batchId, "batchId");

    const result = await withTransaction(async (conn) => {
      const batch = await fetchOne(
        conn,
        `SELECT id, batch_code FROM seedling_batches WHERE id = ? LIMIT 1`,
        [batchId]
      );

      if (!batch) {
        throw new AppError("Partiya topilmadi.", 404);
      }

      // FK tartibida bog'liq yozuvlarni o'chirish
      await conn.query(`DELETE FROM seedling_scan_events WHERE batch_id = ?`, [batchId]);
      await conn.query(`DELETE FROM seedling_units WHERE batch_id = ?`, [batchId]);
      await conn.query(`DELETE FROM order_items WHERE batch_id = ?`, [batchId]);
      await conn.query(`DELETE FROM transfers WHERE batch_id = ?`, [batchId]);
      await conn.query(`DELETE FROM seedling_history WHERE batch_id = ?`, [batchId]);
      await conn.query(`DELETE FROM seedling_inventory WHERE batch_id = ?`, [batchId]);
      await conn.query(`DELETE FROM seedling_batches WHERE id = ?`, [batchId]);

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "batch_deleted",
        entityType: "batch",
        entityId: batchId,
        description: `${batch.batch_code} partiyasi o'chirildi`,
        metadata: { batchId, batchCode: batch.batch_code }
      });

      return { batchId, batchCode: batch.batch_code };
    });

    return sendOk(res, result, "Partiya o'chirildi.");
  })
);

// Admin: partiyani tahrirlash (nav, tur, payvand turi, eslatma)
router.patch(
  "/batches/:batchId",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const batchId = toPositiveInt(req.params.batchId, "batchId");

    const result = await withTransaction(async (conn) => {
      const batch = await fetchOne(
        conn,
        `SELECT id, batch_code FROM seedling_batches WHERE id = ? LIMIT 1`,
        [batchId]
      );

      if (!batch) {
        throw new AppError("Partiya topilmadi.", 404);
      }

      const updates = [];
      const values = [];

      if (req.body.seedlingTypeId !== undefined) {
        updates.push("seedling_type_id = ?");
        values.push(req.body.seedlingTypeId ? toPositiveInt(req.body.seedlingTypeId, "seedlingTypeId") : null);
      }

      if (req.body.varietyId !== undefined) {
        updates.push("variety_id = ?");
        values.push(req.body.varietyId ? toPositiveInt(req.body.varietyId, "varietyId") : null);
      }

      if (req.body.rootstockTypeId !== undefined) {
        updates.push("rootstock_type_id = ?");
        values.push(req.body.rootstockTypeId ? toPositiveInt(req.body.rootstockTypeId, "rootstockTypeId") : null);
      }

      if (req.body.notes !== undefined) {
        updates.push("notes = ?");
        values.push(req.body.notes || null);
      }

      if (req.body.batchCode !== undefined && req.body.batchCode.trim()) {
        updates.push("batch_code = ?");
        values.push(req.body.batchCode.trim());
      }

      if (!updates.length) {
        throw new AppError("Yangilash uchun kamida bitta maydon yuboring.", 400);
      }

      values.push(batchId);
      await conn.query(
        `UPDATE seedling_batches SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`,
        values
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "batch_updated",
        entityType: "batch",
        entityId: batchId,
        description: `${batch.batch_code} partiyasi tahrirlandi`,
        metadata: { batchId }
      });

      return { batchId, batchCode: batch.batch_code };
    });

    return sendOk(res, result, "Partiya yangilandi.");
  })
);

// Partiya uchun alohida dona kodlar ro'yxati
router.get(
  "/units/:batchId",
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const batchId = toPositiveInt(req.params.batchId, "batchId");

    const batch = await fetchOne(
      pool,
      `SELECT b.id, b.batch_code, b.initial_quantity, b.received_date,
              b.created_at, b.source_location_id,
              sl.name AS location_name,
              st.name AS seedling_type_name,
              v.name AS variety_name,
              COALESCE(si.quantity_available, 0) AS quantity_available,
              COALESCE(si.defect_quantity, 0) AS defect_quantity,
              COALESCE(si.current_stage, 'cassette') AS current_stage
       FROM seedling_batches b
       LEFT JOIN locations sl ON sl.id = b.source_location_id
       LEFT JOIN seedling_types st ON st.id = b.seedling_type_id
       LEFT JOIN varieties v ON v.id = b.variety_id
       LEFT JOIN seedling_inventory si ON si.batch_id = b.id AND si.location_id = b.source_location_id
       WHERE b.id = ? LIMIT 1`,
      [batchId]
    );

    if (!batch) {
      throw new AppError("Partiya topilmadi.", 404);
    }

    // Agar units yo'q bo'lsa, yaratib berish
    const [tableCheck] = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'seedling_units' LIMIT 1`
    );

    let units = [];

    if (tableCheck.length > 0) {
      const [existing] = await pool.query(
        `SELECT id, unit_number, unit_code, qr_payload, current_stage, is_defective, notes
         FROM seedling_units WHERE batch_id = ? ORDER BY unit_number ASC`,
        [batchId]
      );

      // Mavjud unitlarda JSON formatdagi qr_payload ni soda kodga o'zgartirish
      if (existing.length > 0) {
        const needsFixing = existing.some(
          (u) => u.qr_payload && u.qr_payload !== u.unit_code &&
                 (u.qr_payload.startsWith("{") || u.qr_payload.startsWith("KOCHAT-"))
        );
        if (needsFixing) {
          await pool.query(
            `UPDATE seedling_units SET qr_payload = unit_code
             WHERE batch_id = ? AND (qr_payload LIKE '{%' OR qr_payload LIKE 'KOCHAT-%')`,
            [batchId]
          );
          // Yangilangan ma'lumotni qayta o'qish
          const [refreshed] = await pool.query(
            `SELECT id, unit_number, unit_code, qr_payload, current_stage, is_defective, notes
             FROM seedling_units WHERE batch_id = ? ORDER BY unit_number ASC`,
            [batchId]
          );
          units = refreshed;
        } else {
          units = existing;
        }
      }

      if (existing.length === 0 && batch.initial_quantity > 0) {
        // Mavjud bo'lmasa, yaratish
        const unitPrefix = batch.batch_code.replace(/^(BATCH|KO|KOCHAT|SEEDLING|URUG)-?/i, "").trim() || batch.batch_code;
        const stage = batch.current_stage || "cassette";
        const conn = pool;
        for (let i = 1; i <= batch.initial_quantity; i++) {
          const unitCode = `PLT-${unitPrefix}-${String(i).padStart(4, "0")}`;
          const unitQrPayload = unitCode;
          await conn.query(
            `INSERT IGNORE INTO seedling_units
              (batch_id, unit_number, unit_code, qr_payload, current_stage)
             VALUES (?, ?, ?, ?, ?)`,
            [batchId, i, unitCode, unitQrPayload, stage]
          );
        }

        const [created] = await pool.query(
          `SELECT id, unit_number, unit_code, qr_payload, current_stage, is_defective, notes
           FROM seedling_units WHERE batch_id = ? ORDER BY unit_number ASC`,
          [batchId]
        );
        units = created;
      } else {
        units = existing;
      }
    }

    return sendOk(res, { batch, units });
  })
);

export default router;
