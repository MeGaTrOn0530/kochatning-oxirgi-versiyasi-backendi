import { Router } from "express";
import { getPool, withTransaction } from "../config/database.js";
import asyncHandler from "../utils/async-handler.js";
import AppError from "../utils/app-error.js";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import { fetchOne } from "../utils/db-helpers.js";
import { requireFields, toPositiveInt } from "../utils/validation.js";
import { logActivity } from "../utils/activity.js";
import { sendCreated, sendOk } from "../utils/http.js";
import { generateCode } from "../utils/code-generator.js";
import {
  createNotifications,
  getNotificationRecipientIds,
  getTransferNotificationRecipientIds
} from "../utils/notifications.js";
import { sendTelegramNotification, msgNewTransfer } from "../utils/telegram.js";
import {
  assertEnoughStock,
  ensureLocationExists,
  getInventoryByBatchAndLocation
} from "../utils/inventory.js";

const router = Router();

router.use(authenticate);

async function getTransfer(executor, transferId, lock = false) {
  const sql = `SELECT t.*, b.batch_code
               FROM transfers t
               JOIN seedling_batches b ON b.id = t.batch_id
               WHERE t.id = ?
               LIMIT 1${lock ? " FOR UPDATE" : ""}`;
  return fetchOne(executor, sql, [transferId]);
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

      conditions.push("(t.from_location_id = ? OR t.to_location_id = ?)");
      params.push(req.user.locationId, req.user.locationId);
    }

    if (req.query.status) {
      if (req.query.status === "pending_sender") {
        conditions.push("COALESCE(t.sender_confirmed, 0) = 0");
      } else if (req.query.status === "pending_head") {
        conditions.push("COALESCE(t.sender_confirmed, 0) = 1 AND COALESCE(t.head_confirmed, 0) = 0");
      } else if (req.query.status === "pending_receiver") {
        conditions.push("COALESCE(t.head_confirmed, 0) = 1 AND COALESCE(t.receiver_confirmed, 0) = 0");
      } else {
        conditions.push("t.status = ?");
        params.push(req.query.status);
      }
    }

    if (req.query.batchId) {
      conditions.push("t.batch_id = ?");
      params.push(req.query.batchId);
    }

    if (req.query.locationId) {
      conditions.push("(t.from_location_id = ? OR t.to_location_id = ?)");
      params.push(req.query.locationId, req.query.locationId);
    }

    if (req.query.fromLocationId) {
      conditions.push("t.from_location_id = ?");
      params.push(req.query.fromLocationId);
    }

    if (req.query.toLocationId) {
      conditions.push("t.to_location_id = ?");
      params.push(req.query.toLocationId);
    }

    if (req.query.dateFrom) {
      conditions.push("t.transfer_date >= ?");
      params.push(`${req.query.dateFrom} 00:00:00`);
    }

    if (req.query.dateTo) {
      conditions.push("t.transfer_date <= ?");
      params.push(`${req.query.dateTo} 23:59:59`);
    }

    const [rows] = await pool.query(
      `SELECT t.*,
              b.batch_code,
              st.name AS seedling_type_name,
              v.name AS variety_name,
              rt.name AS rootstock_type_name,
              fl.name AS from_location_name,
              fl.type AS from_location_type,
              tl.name AS to_location_name,
              tl.type AS to_location_type,
              cu.full_name AS created_by_name,
              su.full_name AS sender_confirmed_by_name,
              hu.full_name AS head_confirmed_by_name,
              ru.full_name AS receiver_confirmed_by_name
       FROM transfers t
       JOIN seedling_batches b ON b.id = t.batch_id
       LEFT JOIN seedling_types st ON st.id = b.seedling_type_id
       LEFT JOIN varieties v ON v.id = b.variety_id
       LEFT JOIN rootstock_types rt ON rt.id = b.rootstock_type_id
       JOIN locations fl ON fl.id = t.from_location_id
       JOIN locations tl ON tl.id = t.to_location_id
       LEFT JOIN users cu ON cu.id = t.created_by
       LEFT JOIN users su ON su.id = t.sender_confirmed_by
       LEFT JOIN users hu ON hu.id = t.head_confirmed_by
       LEFT JOIN users ru ON ru.id = t.receiver_confirmed_by
       WHERE ${conditions.join(" AND ")}
       ORDER BY t.id DESC`,
      params
    );

    return sendOk(res, rows);
  })
);

router.post(
  "/",
  authorize("admin", "bugalter", "agranom"),
  asyncHandler(async (req, res) => {
    requireFields(req.body, ["batchId", "fromLocationId", "toLocationId", "quantity"]);

    const result = await withTransaction(async (conn) => {
      const batchId = toPositiveInt(req.body.batchId, "batchId");
      const fromLocationId = toPositiveInt(req.body.fromLocationId, "fromLocationId");
      const toLocationId = toPositiveInt(req.body.toLocationId, "toLocationId");
      const quantity = toPositiveInt(req.body.quantity, "quantity");

      if (req.user.role === "agranom") {
        if (!req.user.locationId) {
          throw new AppError("Sizga lokatsiya biriktirilmagan. Admin bilan bog'laning.", 403);
        }
        if (Number(req.user.locationId) !== fromLocationId) {
          throw new AppError("Siz faqat o'z lokatsiyangizdan transfer yarata olasiz.", 403);
        }
      }
      const transferCode = req.body.transferCode || generateCode("TRF");
      const transferDate = req.body.transferDate ? new Date(req.body.transferDate) : new Date();
      const note = req.body.notes ?? req.body.note ?? null;
      const transferType = req.body.transferType || "movement";

      if (Number.isNaN(transferDate.getTime())) {
        throw new AppError("Transfer vaqti noto'g'ri yuborildi.", 400);
      }

      if (fromLocationId === toLocationId) {
        throw new AppError("Jo'natuvchi va qabul qiluvchi lokatsiya bir xil bo'lishi mumkin emas.", 400);
      }

      const fromLocation = await ensureLocationExists(conn, fromLocationId);
      await ensureLocationExists(conn, toLocationId);

      const batch = await fetchOne(conn, "SELECT id, batch_code FROM seedling_batches WHERE id = ? LIMIT 1", [batchId]);

      if (!batch) {
        throw new AppError("Batch topilmadi.", 404);
      }

      const inventory = await getInventoryByBatchAndLocation(conn, batchId, fromLocationId);

      if (!inventory) {
        throw new AppError("Ushbu batch jo'natuvchi lokatsiyada topilmadi.", 404);
      }

      assertEnoughStock(inventory, quantity);

      const stageOnTransfer = inventory.current_stage;

      const [result] = await conn.query(
        `INSERT INTO transfers
          (transfer_code, batch_id, from_inventory_id, from_location_id, to_location_id,
           quantity, transfer_type, transfer_date, stage_on_transfer, note, notes, status, created_by,
           sender_confirmed, head_confirmed, receiver_confirmed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_sender', ?, 0, 0, 0)`,
        [
          transferCode,
          batchId,
          inventory.id,
          fromLocationId,
          toLocationId,
          quantity,
          transferType,
          transferDate,
          stageOnTransfer,
          note,
          note,
          req.user.id
        ]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "transfer_created",
        entityType: "transfer",
        entityId: result.insertId,
        description: `${batch.batch_code} batch uchun transfer yaratildi`,
        metadata: { fromLocationId, toLocationId, quantity }
      });

      const notificationRecipientIds = await getTransferNotificationRecipientIds(
        conn,
        [fromLocationId, toLocationId],
        [req.user.id]
      );
      await createNotifications(conn, notificationRecipientIds, {
        type: "transfer_created",
        title: "Yangi transfer yaratildi",
        message: `${batch.batch_code} uchun transfer yaratildi`,
        entityType: "transfer",
        entityId: result.insertId,
        locationId: fromLocationId,
        createdBy: req.user.id,
      });

      return {
        id: result.insertId,
        transferCode,
        batchId,
        fromLocationId,
        toLocationId,
        quantity,
        transferType,
        status: "pending_sender"
      };
    });

    // Telegram bildirishnoma
    const pool = getPool();
    sendTelegramNotification(pool, "notify_transfer", msgNewTransfer({
      batchCode: result.batchCode || "—",
      fromLocation: result.fromLocationName || String(result.fromLocationId),
      toLocation: result.toLocationName || String(result.toLocationId),
      quantity: result.quantity,
      createdByName: req.user.fullName || req.user.username,
    })).catch(() => {});

    return sendCreated(res, result, "Transfer yaratildi.");
  })
);

router.post(
  "/:id/sender-confirm",
  authorize("admin", "agranom"),
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (conn) => {
      const transferId = toPositiveInt(req.params.id, "transferId");
      const transfer = await getTransfer(conn, transferId, true);

      if (!transfer) {
        throw new AppError("Transfer topilmadi.", 404);
      }

      const awaitingSender = !transfer.sender_confirmed && !transfer.sender_confirmed_by;

      if (!awaitingSender) {
        throw new AppError("Bu transfer sender confirm bosqichida emas.", 400);
      }

      if (req.user.role === "agranom" && req.user.locationId !== transfer.from_location_id) {
        throw new AppError("Siz bu transferni jo'natuvchi sifatida tasdiqlay olmaysiz.", 403);
      }

      const inventory = await getInventoryByBatchAndLocation(conn, transfer.batch_id, transfer.from_location_id, true);
      assertEnoughStock(inventory, transfer.quantity);

      // Jo'natuvchi tasdiqlashida manbadan inventarni ayirish
      await conn.query(
        `UPDATE seedling_inventory
         SET quantity_available = quantity_available - ?, last_activity_at = NOW()
         WHERE id = ?`,
        [transfer.quantity, inventory.id]
      );

      const [[fromLocRow]] = await conn.query(
        'SELECT type FROM locations WHERE id = ? LIMIT 1',
        [transfer.from_location_id]
      );
      if (fromLocRow?.type === 'greenhouse') {
        await conn.query(
          `UPDATE greenhouse_stage_stock
           SET quantity = GREATEST(0, quantity - ?), updated_at = NOW()
           WHERE location_id = ? AND stage = ?`,
          [transfer.quantity, transfer.from_location_id, transfer.stage_on_transfer || 'cassette']
        );
      }

      await conn.query(
        `INSERT INTO seedling_history
          (batch_id, inventory_id, action_type, from_location_id, to_location_id,
           previous_stage, next_stage, quantity, approval_status, requires_approval,
           reference_type, reference_id, notes, created_by)
         VALUES (?, ?, 'transfer_out', ?, ?, ?, ?, ?, 'approved', 0, 'transfer', ?, ?, ?)`,
        [
          transfer.batch_id,
          inventory.id,
          transfer.from_location_id,
          transfer.to_location_id,
          transfer.stage_on_transfer,
          transfer.stage_on_transfer,
          transfer.quantity,
          transferId,
          transfer.notes,
          req.user.id
        ]
      );

      await conn.query(
        `UPDATE transfers
         SET sender_confirmed = 1, sender_confirmed_by = ?, sender_confirmed_at = NOW(), status = 'pending_receiver'
         WHERE id = ?`,
        [req.user.id, transferId]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "transfer_sender_confirmed",
        entityType: "transfer",
        entityId: transferId,
        description: `${transfer.batch_code} transfer sender tomonidan tasdiqlandi`
      });

      const notificationRecipientIds = await getTransferNotificationRecipientIds(
        conn,
        [transfer.to_location_id],
        [req.user.id]
      );
      await createNotifications(conn, notificationRecipientIds, {
        type: "transfer_sender_confirmed",
        title: "Transfer qabulga kelayapti",
        message: `${transfer.batch_code} transferi jo'natuvchi tomonidan tasdiqlandi, qabul qiling`,
        entityType: "transfer",
        entityId: transferId,
        locationId: transfer.to_location_id,
        createdBy: req.user.id,
      });

      return {
        id: transferId,
        status: "pending_receiver",
        senderConfirmedBy: req.user.id
      };
    });

    return sendOk(res, result, "Sender confirm bajarildi.");
  })
);

router.post(
  "/:id/head-confirm",
  authorize("admin", "bosh_agranom"),
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (conn) => {
      const transferId = toPositiveInt(req.params.id, "transferId");
      const transfer = await getTransfer(conn, transferId, true);

      if (!transfer) {
        throw new AppError("Transfer topilmadi.", 404);
      }

      // Bosh agronom — so'nggi qadam (receiver confirmed bo'lgandan keyin)
      const awaitingHead =
        (transfer.receiver_confirmed || transfer.receiver_confirmed_by) &&
        !transfer.head_confirmed &&
        !transfer.head_confirmed_by;

      if (!awaitingHead) {
        throw new AppError("Bu transfer head confirm bosqichida emas. Avval qabul qiluvchi tasdiqlasin.", 400);
      }

      await conn.query(
        `UPDATE transfers
         SET head_confirmed = 1, head_confirmed_by = ?, head_confirmed_at = NOW(), status = 'completed'
         WHERE id = ?`,
        [req.user.id, transferId]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "transfer_head_confirmed",
        entityType: "transfer",
        entityId: transferId,
        description: `${transfer.batch_code} transfer bosh agronom tomonidan yakunlandi`
      });

      const notificationRecipientIds = await getTransferNotificationRecipientIds(
        conn,
        [transfer.from_location_id, transfer.to_location_id],
        [req.user.id]
      );
      await createNotifications(conn, notificationRecipientIds, {
        type: "transfer_completed",
        title: "Transfer yakunlandi",
        message: `${transfer.batch_code} transferi bosh agronom tomonidan tasdiqlandi va yakunlandi`,
        entityType: "transfer",
        entityId: transferId,
        locationId: transfer.to_location_id,
        createdBy: req.user.id,
      });

      return {
        id: transferId,
        status: "completed",
        headConfirmedBy: req.user.id
      };
    });

    return sendOk(res, result, "Head confirm bajarildi.");
  })
);

router.post(
  "/:id/receiver-confirm",
  authorize("admin", "agranom"),
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (conn) => {
      const transferId = toPositiveInt(req.params.id, "transferId");
      const transfer = await getTransfer(conn, transferId, true);

      if (!transfer) {
        throw new AppError("Transfer topilmadi.", 404);
      }

      // Qabul qiluvchi — o'rta qadam (sender confirmed bo'lgandan keyin, head dan oldin)
      const awaitingReceiver =
        (transfer.sender_confirmed || transfer.sender_confirmed_by) &&
        !transfer.receiver_confirmed &&
        !transfer.receiver_confirmed_by;

      if (!awaitingReceiver) {
        throw new AppError("Bu transfer receiver confirm bosqichida emas.", 400);
      }

      if (req.user.role === "agranom" && req.user.locationId !== transfer.to_location_id) {
        throw new AppError("Siz bu transferni qabul qiluvchi sifatida tasdiqlay olmaysiz.", 403);
      }

      const stage = req.body.stage || transfer.stage_on_transfer;
      let destinationInventory = await getInventoryByBatchAndLocation(conn, transfer.batch_id, transfer.to_location_id, true);

      if (!destinationInventory) {
        const [inventoryResult] = await conn.query(
          `INSERT INTO seedling_inventory
            (batch_id, location_id, current_stage, quantity_available, defect_quantity, last_activity_at)
           VALUES (?, ?, ?, ?, 0, NOW())`,
          [transfer.batch_id, transfer.to_location_id, stage, transfer.quantity]
        );

        destinationInventory = {
          id: inventoryResult.insertId,
          batch_id: transfer.batch_id,
          location_id: transfer.to_location_id,
          current_stage: stage,
          quantity_available: transfer.quantity,
          defect_quantity: 0
        };
      } else {
        await conn.query(
          `UPDATE seedling_inventory
           SET quantity_available = quantity_available + ?, current_stage = ?, last_activity_at = NOW()
           WHERE id = ?`,
          [transfer.quantity, stage, destinationInventory.id]
        );
      }

      await conn.query(
        `UPDATE transfers
         SET receiver_confirmed = 1, receiver_confirmed_by = ?, receiver_confirmed_at = NOW(), status = 'pending_head'
         WHERE id = ?`,
        [req.user.id, transferId]
      );

      await conn.query(
        `INSERT INTO seedling_history
          (batch_id, inventory_id, action_type, from_location_id, to_location_id,
           previous_stage, next_stage, quantity, approval_status, requires_approval,
           reference_type, reference_id, notes, created_by)
         VALUES (?, ?, 'transfer_in', ?, ?, ?, ?, ?, 'approved', 0, 'transfer', ?, ?, ?)`,
        [
          transfer.batch_id,
          destinationInventory.id,
          transfer.from_location_id,
          transfer.to_location_id,
          transfer.stage_on_transfer,
          stage,
          transfer.quantity,
          transferId,
          req.body.notes || transfer.notes || null,
          req.user.id
        ]
      );

      // Teplitsa greenhouse stock ga avtomatik qo'shish (faqat teplitsa lokatsiyalari uchun)
      try {
        const [[toLocRow]] = await conn.query(
          'SELECT type FROM locations WHERE id = ? LIMIT 1',
          [transfer.to_location_id]
        );
        if (toLocRow?.type === 'greenhouse') {
          const targetStage = transfer.stage_on_transfer || stage || 'cassette';

          // Batch dan nav ma'lumotini olish
          const [batchRows] = await conn.query(
            `SELECT variety_id, seedling_type_id, rootstock_type_id FROM seedling_batches WHERE id = ? LIMIT 1`,
            [transfer.batch_id]
          );
          const batchInfo = batchRows[0] || {};
          const bVarietyId = batchInfo.variety_id || 0;
          const bSeedlingTypeId = batchInfo.seedling_type_id || 0;
          const bRootstockTypeId = batchInfo.rootstock_type_id || 0;

          const [gssExisting] = await conn.query(
            `SELECT id, quantity FROM greenhouse_stage_stock
             WHERE location_id = ? AND stage = ? LIMIT 1`,
            [transfer.to_location_id, targetStage]
          );
          if (gssExisting.length > 0) {
            await conn.query(
              `UPDATE greenhouse_stage_stock SET quantity = quantity + ?, updated_at = NOW()
               WHERE location_id = ? AND stage = ?`,
              [transfer.quantity, transfer.to_location_id, targetStage]
            );
          } else {
            await conn.query(
              `INSERT INTO greenhouse_stage_stock (location_id, stage, quantity) VALUES (?, ?, ?)
               ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
              [transfer.to_location_id, targetStage, transfer.quantity]
            );
          }

          // Nav bo'yicha stok yangilash
          await conn.query(
            `CREATE TABLE IF NOT EXISTS greenhouse_variety_stock (
               location_id INT NOT NULL, stage VARCHAR(50) NOT NULL,
               variety_id INT NOT NULL DEFAULT 0, seedling_type_id INT NOT NULL DEFAULT 0,
               rootstock_type_id INT NOT NULL DEFAULT 0, quantity INT NOT NULL DEFAULT 0,
               PRIMARY KEY (location_id, stage, variety_id, seedling_type_id, rootstock_type_id)
             )`
          );
          await conn.query(
            `INSERT INTO greenhouse_variety_stock
              (location_id, stage, variety_id, seedling_type_id, rootstock_type_id, quantity)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE quantity = GREATEST(0, quantity + ?)`,
            [transfer.to_location_id, targetStage, bVarietyId, bSeedlingTypeId, bRootstockTypeId,
             transfer.quantity, transfer.quantity]
          );

          // Log yozuvi (variety bilan)
          const [logCols] = await conn.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'greenhouse_stage_log'
             AND COLUMN_NAME = 'variety_id'`
          );
          if (logCols.length > 0) {
            await conn.query(
              `INSERT INTO greenhouse_stage_log
                (location_id, action_date, from_stage, to_stage, quantity, notes, created_by, source_transfer_id,
                 variety_id, seedling_type_id, rootstock_type_id)
               VALUES (?, CURDATE(), NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [transfer.to_location_id, targetStage, transfer.quantity,
               `Transfer qabul: ${transfer.batch_code || transfer.transfer_code}`,
               req.user.id, transferId, bVarietyId || null, bSeedlingTypeId || null, bRootstockTypeId || null]
            );
          } else {
            await conn.query(
              `INSERT INTO greenhouse_stage_log
                (location_id, action_date, from_stage, to_stage, quantity, notes, created_by, source_transfer_id)
               VALUES (?, CURDATE(), NULL, ?, ?, ?, ?, ?)`,
              [transfer.to_location_id, targetStage, transfer.quantity,
               `Transfer qabul: ${transfer.batch_code || transfer.transfer_code}`,
               req.user.id, transferId]
            );
          }
        }
      } catch (_) {
        // greenhouse jadvallari bo'lmasa ham transfer davom etadi
      }

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "transfer_receiver_confirmed",
        entityType: "transfer",
        entityId: transferId,
        description: `${transfer.batch_code} transfer qabul qilindi, bosh agronom tasdig'i kutilmoqda`,
        metadata: { stage }
      });

      const notificationRecipientIds = await getNotificationRecipientIds(conn, {
        roles: ["admin", "bosh_agranom"],
        excludeUserIds: [req.user.id],
      });
      await createNotifications(conn, notificationRecipientIds, {
        type: "transfer_receiver_confirmed",
        title: "Transfer qabul qilindi",
        message: `${transfer.batch_code} transferi qabul qilindi. Bosh agronom tasdig'i kerak`,
        entityType: "transfer",
        entityId: transferId,
        locationId: transfer.to_location_id,
        createdBy: req.user.id,
      });

      return {
        id: transferId,
        status: "pending_head",
        receiverConfirmedBy: req.user.id,
        stage
      };
    });

    return sendOk(res, result, "Receiver confirm bajarildi.");
  })
);

router.post(
  "/:id/reject",
  authorize("admin", "bosh_agranom"),
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (conn) => {
      const transferId = toPositiveInt(req.params.id, "transferId");
      const transfer = await getTransfer(conn, transferId, true);

      if (!transfer) {
        throw new AppError("Transfer topilmadi.", 404);
      }

      if (transfer.status === "completed" || transfer.status === "rejected") {
        throw new AppError("Yakunlangan yoki allaqachon rad etilgan transferni qaytarib bo'lmaydi.", 400);
      }

      // Agar jo'natuvchi allaqachon tasdiqlagan bo'lsa, inventarni qaytarish
      if (transfer.sender_confirmed || transfer.sender_confirmed_by) {
        const inventory = await getInventoryByBatchAndLocation(conn, transfer.batch_id, transfer.from_location_id, true);
        if (inventory) {
          await conn.query(
            `UPDATE seedling_inventory
             SET quantity_available = quantity_available + ?, last_activity_at = NOW()
             WHERE id = ?`,
            [transfer.quantity, inventory.id]
          );

          const [[fromLocRow]] = await conn.query(
            'SELECT type FROM locations WHERE id = ? LIMIT 1',
            [transfer.from_location_id]
          );
          if (fromLocRow?.type === 'greenhouse') {
            await conn.query(
              `UPDATE greenhouse_stage_stock
               SET quantity = quantity + ?, updated_at = NOW()
               WHERE location_id = ? AND stage = ?`,
              [transfer.quantity, transfer.from_location_id, transfer.stage_on_transfer || 'cassette']
            );
          }
        }

        // Qabul qiluvchi ham tasdiqlagan bo'lsa, maqsad lokatsiyadan ayirish
        if (transfer.receiver_confirmed || transfer.receiver_confirmed_by) {
          const destInventory = await getInventoryByBatchAndLocation(conn, transfer.batch_id, transfer.to_location_id, true);
          if (destInventory) {
            await conn.query(
              `UPDATE seedling_inventory
               SET quantity_available = GREATEST(0, quantity_available - ?), last_activity_at = NOW()
               WHERE id = ?`,
              [transfer.quantity, destInventory.id]
            );

            const [[toLocRow]] = await conn.query(
              'SELECT type FROM locations WHERE id = ? LIMIT 1',
              [transfer.to_location_id]
            );
            if (toLocRow?.type === 'greenhouse') {
              await conn.query(
                `UPDATE greenhouse_stage_stock
                 SET quantity = GREATEST(0, quantity - ?), updated_at = NOW()
                 WHERE location_id = ? AND stage = ?`,
                [transfer.quantity, transfer.to_location_id, transfer.stage_on_transfer || 'cassette']
              );
            }
          }
        }
      }

      const rejectReason = req.body.reason || req.body.rejectReason || null;

      await conn.query(
        `UPDATE transfers
         SET status = 'rejected',
             head_confirmed = 0, head_confirmed_by = ?, head_confirmed_at = NOW(),
             notes = CONCAT(COALESCE(notes, ''), ?)
         WHERE id = ?`,
        [req.user.id, rejectReason ? `\n[Rad etildi: ${rejectReason}]` : "\n[Rad etildi]", transferId]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "transfer_rejected",
        entityType: "transfer",
        entityId: transferId,
        description: `${transfer.batch_code} transfer rad etildi${rejectReason ? `: ${rejectReason}` : ""}`,
        metadata: { rejectReason }
      });

      const notificationRecipientIds = await getTransferNotificationRecipientIds(
        conn,
        [transfer.from_location_id, transfer.to_location_id],
        [req.user.id]
      );
      await createNotifications(conn, notificationRecipientIds, {
        type: "transfer_rejected",
        title: "Transfer rad etildi",
        message: `${transfer.batch_code} transferi rad etildi${rejectReason ? `: ${rejectReason}` : ""}`,
        entityType: "transfer",
        entityId: transferId,
        locationId: transfer.from_location_id,
        createdBy: req.user.id,
      });

      return { id: transferId, status: "rejected" };
    });

    return sendOk(res, result, "Transfer rad etildi.");
  })
);

export default router;
