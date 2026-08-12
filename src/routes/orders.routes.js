import { Router } from "express";
import { getPool, withTransaction } from "../config/database.js";
import asyncHandler from "../utils/async-handler.js";
import AppError from "../utils/app-error.js";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import { fetchOne } from "../utils/db-helpers.js";
import { requireFields, toNumber, toPositiveInt } from "../utils/validation.js";
import { logActivity } from "../utils/activity.js";
import { sendCreated, sendOk } from "../utils/http.js";
import { generateCode } from "../utils/code-generator.js";
import {
  createNotifications,
  getNotificationRecipientIds,
  getOrderNotificationRecipientIds
} from "../utils/notifications.js";
import { sendTelegramNotification, msgNewOrder, msgOrderSold } from "../utils/telegram.js";
import {
  assertEnoughStock,
  ensureLocationExists,
  ensureUnknownCatalog,
  getInventoryById
} from "../utils/inventory.js";

const router = Router();

router.use(authenticate);

async function resolveExistingId(conn, tableName, id) {
  if (!id) return null;
  const row = await fetchOne(conn, `SELECT id FROM ${tableName} WHERE id = ? LIMIT 1`, [id]);
  return row?.id || null;
}

async function tableExists(conn, tableName) {
  const row = await fetchOne(
    conn,
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name = ?
     LIMIT 1`,
    [tableName]
  );

  return Boolean(row);
}

async function resolveOrderVarietyId(conn, seedlingTypeId, varietyId) {
  if (!seedlingTypeId || !varietyId) {
    if (!seedlingTypeId || !(await tableExists(conn, "fruit_varieties"))) {
      return null;
    }

    const fallbackLegacyRow = await fetchOne(
      conn,
      `SELECT id
       FROM fruit_varieties
       WHERE seedling_type_id = ?
       ORDER BY id ASC
       LIMIT 1`,
      [seedlingTypeId]
    );

    return fallbackLegacyRow?.id || null;
  }

  if (!(await tableExists(conn, "fruit_varieties"))) {
    return null;
  }

  const exactLegacyId = await resolveExistingId(conn, "fruit_varieties", varietyId);
  if (exactLegacyId) {
    return exactLegacyId;
  }

  const sourceVariety = await fetchOne(
    conn,
    `SELECT id, seedling_type_id, name, description
     FROM varieties
     WHERE id = ?
     LIMIT 1`,
    [varietyId]
  );

  if (!sourceVariety) {
    return null;
  }

  const matchedLegacyRow = await fetchOne(
    conn,
    `SELECT id
     FROM fruit_varieties
     WHERE seedling_type_id = ?
       AND LOWER(TRIM(name)) = LOWER(TRIM(?))
     LIMIT 1`,
    [seedlingTypeId, sourceVariety.name]
  );

  if (matchedLegacyRow?.id) {
    return matchedLegacyRow.id;
  }

  const [insertResult] = await conn.query(
    `INSERT INTO fruit_varieties
      (seedling_type_id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, NOW(), NOW())`,
    [seedlingTypeId, sourceVariety.name, sourceVariety.description || null]
  );

  return insertResult.insertId;
}

async function resolveOrderSeedlingTypeId(conn, rawSeedlingTypeId, rawVarietyId) {
  const directSeedlingTypeId = await resolveExistingId(conn, "seedling_types", rawSeedlingTypeId || null);
  if (directSeedlingTypeId) {
    return directSeedlingTypeId;
  }

  if (rawVarietyId) {
    const sourceVariety = await fetchOne(
      conn,
      `SELECT seedling_type_id
       FROM varieties
       WHERE id = ?
       LIMIT 1`,
      [rawVarietyId]
    );

    const derivedSeedlingTypeId = await resolveExistingId(
      conn,
      "seedling_types",
      sourceVariety?.seedling_type_id || null
    );

    if (derivedSeedlingTypeId) {
      return derivedSeedlingTypeId;
    }
  }

  const unknownCatalog = await ensureUnknownCatalog(conn);
  return unknownCatalog.seedlingTypeId;
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

      conditions.push("o.location_id = ?");
      params.push(req.user.locationId);
    }

    if (req.query.status) {
      conditions.push("o.status = ?");
      params.push(req.query.status);
    }

    if (req.query.locationId) {
      conditions.push("o.location_id = ?");
      params.push(req.query.locationId);
    }

    if (req.query.search) {
      const pattern = `%${req.query.search}%`;
      conditions.push("(o.order_number LIKE ? OR o.customer_name LIKE ? OR o.client_name LIKE ? OR o.customer_phone LIKE ?)");
      params.push(pattern, pattern, pattern, pattern);
    }

    const [rows] = await pool.query(
      `SELECT o.*, l.name AS location_name, cu.full_name AS created_by_name, su.full_name AS sold_by_name,
              COUNT(DISTINCT oi.id) AS items_count,
              GROUP_CONCAT(DISTINCT b.batch_code ORDER BY b.batch_code SEPARATOR ', ') AS batch_codes
       FROM orders o
       JOIN locations l ON l.id = o.location_id
       LEFT JOIN users cu ON cu.id = o.created_by
       LEFT JOIN users su ON su.id = o.sold_by
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN seedling_batches b ON b.id = oi.batch_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY o.id
       ORDER BY o.id DESC`,
      params
    );

    return sendOk(res, rows);
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const orderId = toPositiveInt(req.params.id, "orderId");

    const order = await fetchOne(
      pool,
      `SELECT o.*, l.name AS location_name, cu.full_name AS created_by_name, su.full_name AS sold_by_name
       FROM orders o
       JOIN locations l ON l.id = o.location_id
       LEFT JOIN users cu ON cu.id = o.created_by
       LEFT JOIN users su ON su.id = o.sold_by
       WHERE o.id = ?
       LIMIT 1`,
      [orderId]
    );

    if (!order) {
      throw new AppError("Order topilmadi.", 404);
    }

    const [items] = await pool.query(
      `SELECT oi.*, b.batch_code, st.name AS seedling_type_name, v.name AS variety_name
       FROM order_items oi
       JOIN seedling_batches b ON b.id = oi.batch_id
       LEFT JOIN seedling_types st ON st.id = b.seedling_type_id
       LEFT JOIN varieties v ON v.id = b.variety_id
       WHERE oi.order_id = ?
       ORDER BY oi.id ASC`,
      [orderId]
    );

    return sendOk(res, { order, items });
  })
);

router.post(
  "/",
  authorize("admin", "bugalter", "agranom"),
  asyncHandler(async (req, res) => {
    requireFields(req.body, ["customerName", "locationId", "items"]);

    if (!Array.isArray(req.body.items) || req.body.items.length === 0) {
      throw new AppError("items bo'sh bo'lmasligi kerak.", 400);
    }

    const result = await withTransaction(async (conn) => {
      const locationId = toPositiveInt(req.body.locationId, "locationId");

      // Agranom faqat manba lokatsiyasida (is_source=1) buyurtma yarata oladi
      if (req.user.role === "agranom") {
        const locRow = await fetchOne(conn, "SELECT is_source FROM locations WHERE id = ?", [locationId]);
        if (!locRow || !locRow.is_source) {
          throw new AppError("Agranom faqat manba lokatsiyasida buyurtma yarata oladi.", 403);
        }
        if (Number(req.user.location_id) !== locationId) {
          throw new AppError("Siz faqat o'z lokatsiyangiz uchun buyurtma yarata olasiz.", 403);
        }
      }
      const orderDate = req.body.orderDate ? new Date(req.body.orderDate) : new Date();

      if (Number.isNaN(orderDate.getTime())) {
        throw new AppError("Buyurtma vaqti noto'g'ri yuborildi.", 400);
      }

      await ensureLocationExists(conn, locationId);
      const unknownCatalog = await ensureUnknownCatalog(conn);

      let totalQuantity = 0;
      let totalAmount = 0;
      const parsedItems = [];

      for (const item of req.body.items) {
        requireFields(item, ["batchId", "quantity"]);

        const batchId = toPositiveInt(item.batchId, "batchId");
        const quantity = toPositiveInt(item.quantity, "quantity");
        const unitPrice = toNumber(item.unitPrice, "unitPrice", 0);

        const inventory = await fetchOne(
          conn,
          `SELECT si.*, b.batch_code, b.seedling_type_id, b.variety_id
           FROM seedling_inventory si
           JOIN seedling_batches b ON b.id = si.batch_id
           WHERE si.batch_id = ? AND si.location_id = ?
           LIMIT 1`,
          [batchId, locationId]
        );

        if (!inventory) {
          throw new AppError(`Batch #${batchId} uchun ushbu lokatsiyada inventar topilmadi.`, 404);
        }

        // Bron logikasi: mavjud miqdordan oshsa ham buyurtma qabul qilinadi
        const available = Number(inventory.quantity_available || 0);
        const itemShortage = Math.max(0, quantity - available);

        const totalPrice = quantity * unitPrice;
        totalQuantity += quantity;
        totalAmount += totalPrice;

        const existingBatchId = await resolveExistingId(conn, "seedling_batches", batchId);
        const existingInventoryId = await resolveExistingId(conn, "seedling_inventory", inventory.id);
        const seedlingTypeId =
          (await resolveOrderSeedlingTypeId(
            conn,
            inventory.seedling_type_id || null,
            inventory.variety_id || null
          )) || unknownCatalog.seedlingTypeId;
        const orderVarietyId = await resolveOrderVarietyId(
          conn,
          seedlingTypeId,
          inventory.variety_id || null
        );

        if (!existingBatchId) {
          throw new AppError(`Tanlangan partiya (#${batchId}) bazada topilmadi.`, 400);
        }

        if (!existingInventoryId) {
          throw new AppError(`Tanlangan partiya inventari (#${inventory.id}) topilmadi.`, 400);
        }

        parsedItems.push({
          batchId: existingBatchId,
          inventoryId: existingInventoryId,
          seedlingTypeId,
          varietyId: orderVarietyId,
          quantity,
          unitPrice,
          totalPrice,
          shortage: itemShortage
        });
      }

      const totalShortage = parsedItems.reduce((sum, item) => sum + item.shortage, 0);
      const orderStatus = totalShortage > 0 ? 'partial' : 'new';
      const expectedDate = req.body.expectedDate ? new Date(req.body.expectedDate) : null;

      const orderNumber = req.body.orderNumber || generateCode("ORD");
      const location = await fetchOne(
        conn,
        "SELECT id, name FROM locations WHERE id = ? LIMIT 1",
        [locationId]
      );
      const [orderResult] = await conn.query(
        `INSERT INTO orders
          (order_number, client_name, customer_name, customer_phone, location_id, status, order_date, note, notes,
           total_amount, total_quantity, quantity, fulfilled_quantity, shortage_quantity, expected_date, batch_id,
           seedling_type_id, variety_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        [
          orderNumber,
          req.body.customerName,
          req.body.customerName,
          req.body.customerPhone || null,
          locationId,
          orderStatus,
          orderDate,
          req.body.notes || null,
          req.body.notes || null,
          totalAmount,
          totalQuantity,
          totalQuantity,
          totalShortage,
          expectedDate,
          parsedItems[0]?.batchId || null,
          parsedItems[0]?.seedlingTypeId || null,
          parsedItems[0]?.varietyId || null,
          req.user.id
        ]
      );

      for (const item of parsedItems) {
        await conn.query(
          `INSERT INTO order_items
            (order_id, batch_id, inventory_id, quantity, unit_price, total_price)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [orderResult.insertId, item.batchId, item.inventoryId, item.quantity, item.unitPrice, item.totalPrice]
        );
      }

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "order_created",
        entityType: "order",
        entityId: orderResult.insertId,
        description: `${orderNumber} buyurtmasi yaratildi`,
        metadata: { locationId, totalQuantity, totalAmount, orderDate: orderDate.toISOString() }
      });

      const notificationRecipientIds = await getOrderNotificationRecipientIds(conn, locationId);
      await createNotifications(conn, notificationRecipientIds, {
        type: "order_created",
        title: "Yangi buyurtma yaratildi",
        message: `${orderNumber} buyurtmasi ${location?.name || "lokatsiya"} uchun yaratildi`,
        entityType: "order",
        entityId: orderResult.insertId,
        locationId,
        createdBy: req.user.id,
      });

      return {
        id: orderResult.insertId,
        orderNumber,
        status: orderStatus,
        locationId,
        totalQuantity,
        totalAmount,
        shortageQuantity: totalShortage,
        immediateQuantity: totalQuantity - totalShortage,
        expectedDate: expectedDate ? expectedDate.toISOString().slice(0, 10) : null,
        createdAt: orderDate.toISOString()
      };
    });

    // Telegram bildirishnoma (asinxron, kutmaymiz)
    const pool = getPool();
    sendTelegramNotification(pool, "notify_new_order", msgNewOrder({
      orderNumber: result.orderNumber,
      customerName: req.body.customerName || "—",
      quantity: result.totalQuantity,
      totalAmount: result.totalAmount,
      locationName: req.body.locationName,
    })).catch(() => {});

    return sendCreated(res, result, "Order yaratildi.");
  })
);

// ─── POST /api/orders/greenhouse — Teplitsa tayyor stokidan buyurtma ──────────
// Bugalter, admin va bosh_agranom yaratadi; agranom o'z lokatsiyasi uchun
router.post(
  "/greenhouse",
  authorize("admin", "bosh_agranom", "bugalter", "agranom"),
  asyncHandler(async (req, res) => {
    requireFields(req.body, ["customerName", "locationId", "quantity"]);

    const locationId = toPositiveInt(req.body.locationId, "locationId");
    const quantity = toPositiveInt(req.body.quantity, "quantity");
    const varietyId = req.body.varietyId ? Number(req.body.varietyId) : null;
    const seedlingTypeId = req.body.seedlingTypeId ? Number(req.body.seedlingTypeId) : null;
    const rootstockTypeId = req.body.rootstockTypeId ? Number(req.body.rootstockTypeId) : null;
    const unitPrice = toNumber(req.body.unitPrice || 0, "unitPrice", 0);
    const orderDate = req.body.orderDate ? new Date(req.body.orderDate) : new Date();
    const expectedDate = req.body.expectedDate ? new Date(req.body.expectedDate) : null;

    if (req.user.role === "agranom" && req.user.locationId !== locationId) {
      throw new AppError("Siz faqat o'z lokatsiyangiz uchun buyurtma bera olasiz.", 403);
    }

    const pool = getPool();

    // Tayyor bosqichdagi stokni hisoblash
    const [stockRows] = await pool.query(
      `SELECT
         SUM(CASE WHEN to_stage = 'ready'   THEN COALESCE(variety_quantity, quantity) ELSE 0 END) -
         SUM(CASE WHEN from_stage = 'ready' THEN COALESCE(variety_quantity, quantity) ELSE 0 END)
         AS qty
       FROM greenhouse_stage_log
       WHERE location_id = ?
         AND (to_stage = 'ready' OR from_stage = 'ready')
         AND COALESCE(variety_id, 0) = ?
         AND COALESCE(seedling_type_id, 0) = ?
         AND COALESCE(rootstock_type_id, 0) = ?`,
      [locationId, varietyId || 0, seedlingTypeId || 0, rootstockTypeId || 0]
    );

    const available = Math.max(0, Number(stockRows[0]?.qty || 0));
    const immediateQty = Math.min(available, quantity);
    const shortageQty = Math.max(0, quantity - available);
    const orderStatus = shortageQty > 0 ? "partial" : "new";
    const totalAmount = quantity * unitPrice;
    const orderNumber = req.body.orderNumber || generateCode("ORD");

    const result = await withTransaction(async (conn) => {
      await ensureLocationExists(conn, locationId);

      const [orderResult] = await conn.query(
        `INSERT INTO orders
          (order_number, client_name, customer_name, customer_phone, location_id, status, order_date,
           note, notes, total_amount, total_quantity, quantity, fulfilled_quantity, shortage_quantity,
           expected_date, batch_id, seedling_type_id, variety_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?)`,
        [
          orderNumber,
          req.body.customerName,
          req.body.customerName,
          req.body.customerPhone || null,
          locationId,
          orderStatus,
          orderDate,
          req.body.notes || null,
          req.body.notes || null,
          totalAmount,
          quantity,
          quantity,
          shortageQty,
          expectedDate,
          seedlingTypeId,
          varietyId,
          req.user.id,
        ]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "order_created",
        entityType: "order",
        entityId: orderResult.insertId,
        description: `${orderNumber} greenhouse buyurtmasi yaratildi`,
        metadata: { locationId, quantity, immediateQty, shortageQty }
      });

      const notificationRecipientIds = await getOrderNotificationRecipientIds(conn, locationId);
      await createNotifications(conn, notificationRecipientIds, {
        type: "order_created",
        title: "Yangi teplitsa buyurtmasi",
        message: `Yangi buyurtma: ${orderNumber} — ${req.body.customerName}, ${quantity} ta`,
        entityType: "order",
        entityId: orderResult.insertId,
        locationId,
        createdBy: req.user.id,
      });

      return {
        orderId: orderResult.insertId,
        orderNumber,
        immediateQuantity: immediateQty,
        shortageQuantity: shortageQty,
        totalAmount,
        status: orderStatus,
      };
    });

    return sendCreated(res, result, "Greenhouse buyurtmasi yaratildi.");
  })
);

// ─── POST /api/orders/:id/agranom-confirm — Agranom "berdim" tasdiqlashi ───
router.post(
  "/:id/agranom-confirm",
  authorize("admin", "agranom", "bosh_agranom"),
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (conn) => {
      const orderId = toPositiveInt(req.params.id, "orderId");
      const order = await fetchOne(
        conn,
        "SELECT * FROM orders WHERE id = ? LIMIT 1 FOR UPDATE",
        [orderId]
      );

      if (!order) throw new AppError("Buyurtma topilmadi.", 404);

      if (!["new", "partial"].includes(order.status)) {
        throw new AppError("Bu buyurtma 'berdim' tasdiqlash uchun mos emas.", 400);
      }

      if (req.user.role === "agranom" && req.user.locationId !== order.location_id) {
        throw new AppError("Siz faqat o'z lokatsiyangiz buyurtmasini tasdiqlay olasiz.", 403);
      }

      // agranom_confirmed_by kolonnasi yo'q bo'lsa, statusni o'zgartirib, notes ga yozamiz
      await conn.query(
        `UPDATE orders
         SET notes = CONCAT(COALESCE(notes, ''), ?)
         WHERE id = ?`,
        [`\n[Agranom tasdiqladi: ${req.user.fullName || req.user.username} — ${new Date().toLocaleString("uz-UZ")}]`, orderId]
      );

      // Status ni "agranom_confirmed" ga o'tkazish uchun: mavjud status ni saqlash
      // Lekin orders jadvalida bu status yo'q, shuning uchun notes ga yozamiz va "pending_head" atamasini ishlatmaymiz
      // Frontend da buni notes orqali aniqlaymiz, yoki yangi status qo'shamiz

      await conn.query(
        `UPDATE orders SET status = 'agranom_confirmed', updated_at = NOW() WHERE id = ?`,
        [orderId]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "order_agranom_confirmed",
        entityType: "order",
        entityId: orderId,
        description: `${order.order_number} buyurtmasi agranom tomonidan tasdiqlandi (berdim)`,
      });

      const notificationRecipientIds = await getNotificationRecipientIds(conn, {
        roles: ["admin", "bosh_agranom"],
        excludeUserIds: [req.user.id],
      });
      await createNotifications(conn, notificationRecipientIds, {
        type: "order_agranom_confirmed",
        title: "Buyurtma berildi",
        message: `${order.order_number} buyurtmasi agranom tomonidan berildi. Tasdiqlash kerak.`,
        entityType: "order",
        entityId: orderId,
        locationId: order.location_id,
        createdBy: req.user.id,
      });

      return { id: orderId, status: "agranom_confirmed" };
    });

    return sendOk(res, result, "Agranom tasdiqladi.");
  })
);

router.post(
  "/:id/sell",
  authorize("admin", "agranom", "bosh_agranom"),
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (conn) => {
      const orderId = toPositiveInt(req.params.id, "orderId");
      const order = await fetchOne(
        conn,
        "SELECT * FROM orders WHERE id = ? LIMIT 1 FOR UPDATE",
        [orderId]
      );

      if (!order) {
        throw new AppError("Order topilmadi.", 404);
      }

      if (!["new", "partial", "shortage", "agranom_confirmed"].includes(order.status)) {
        throw new AppError("Faqat yangi yoki faol order sotilishi mumkin.", 400);
      }

      if (req.user.role === "agranom" && req.user.locationId !== order.location_id) {
        throw new AppError("Siz faqat o'zingizga biriktirilgan lokatsiya buyurtmasini sotishingiz mumkin.", 403);
      }

      const isGreenhouseOrder = !order.batch_id;

      const [items] = isGreenhouseOrder ? [[], null] : await conn.query(
        `SELECT oi.*, si.location_id, b.batch_code
         FROM order_items oi
         JOIN seedling_inventory si ON si.id = oi.inventory_id
         JOIN seedling_batches b ON b.id = oi.batch_id
         WHERE oi.order_id = ?
         ORDER BY oi.id ASC`,
        [orderId]
      );

      if (!isGreenhouseOrder && items.length === 0) {
        throw new AppError("Order itemlari topilmadi.", 400);
      }

      if (isGreenhouseOrder) {
        // Greenhouse buyurtma — tayyor bosqich stokini kamaytirish
        const soldQty = (order.total_quantity || 0) - (order.shortage_quantity || 0);
        if (soldQty > 0) {
          await conn.query(
            `UPDATE greenhouse_stage_stock
             SET quantity = GREATEST(0, quantity - ?)
             WHERE location_id = ? AND stage = 'ready'`,
            [soldQty, order.location_id]
          );
          await conn.query(
            `INSERT INTO greenhouse_stage_log
              (location_id, action_date, from_stage, to_stage, quantity, notes, created_by,
               action_type, seedling_type_id, variety_id, rootstock_type_id, variety_quantity)
             VALUES (?, DATE(NOW()), 'ready', 'sold', ?, ?, ?, 'sale', ?, ?, NULL, ?)`,
            [order.location_id, soldQty,
             `Buyurtma ${order.order_number} bo'yicha sotildi`,
             req.user.id,
             order.seedling_type_id || null,
             order.variety_id || null,
             soldQty]
          );
        }
      } else {
        for (const item of items) {
          const inventory = await getInventoryById(conn, item.inventory_id, true);
          assertEnoughStock(inventory, item.quantity);

          await conn.query(
            `UPDATE seedling_inventory
             SET quantity_available = quantity_available - ?, last_activity_at = NOW()
             WHERE id = ?`,
            [item.quantity, inventory.id]
          );

          await conn.query(
            `INSERT INTO seedling_history
              (batch_id, inventory_id, action_type, from_location_id, previous_stage, next_stage,
               quantity, approval_status, requires_approval, reference_type, reference_id, notes, created_by)
             VALUES (?, ?, 'order_sale', ?, ?, ?, ?, 'approved', 0, 'order', ?, ?, ?)`,
            [
              item.batch_id,
              inventory.id,
              item.location_id,
              inventory.current_stage,
              inventory.current_stage,
              item.quantity,
              orderId,
              req.body.notes || `Order ${order.order_number} sotildi`,
              req.user.id
            ]
          );
        }

        // Agar lokatsiya greenhouse bo'lsa, tayyor bosqich stokini ham kamaytirish
        const [locRow] = await conn.query(
          `SELECT type, is_source FROM locations WHERE id = ? LIMIT 1`,
          [order.location_id]
        );
        if (locRow[0]?.type === 'greenhouse' && !locRow[0]?.is_source) {
          const totalSoldQty = items.reduce((s, i) => s + Number(i.quantity || 0), 0);
          if (totalSoldQty > 0) {
            await conn.query(
              `UPDATE greenhouse_stage_stock
               SET quantity = GREATEST(0, quantity - ?)
               WHERE location_id = ? AND stage = 'ready'`,
              [totalSoldQty, order.location_id]
            );
            await conn.query(
              `INSERT INTO greenhouse_stage_log
                (location_id, action_date, from_stage, to_stage, quantity, notes, created_by,
                 action_type, seedling_type_id, variety_id, rootstock_type_id, variety_quantity)
               VALUES (?, DATE(NOW()), 'ready', 'sold', ?, ?, ?, 'sale', ?, ?, NULL, ?)`,
              [order.location_id, totalSoldQty,
               `Buyurtma ${order.order_number} (batch) bo'yicha sotildi`,
               req.user.id,
               order.seedling_type_id || null,
               order.variety_id || null,
               totalSoldQty]
            );
          }
        }
      }

      await conn.query(
        `UPDATE orders
         SET status = 'completed', sold_by = ?, sold_at = NOW(), updated_at = NOW(),
             fulfilled_quantity = total_quantity, shortage_quantity = 0
         WHERE id = ?`,
        [req.user.id, orderId]
      );

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "order_sold",
        entityType: "order",
        entityId: orderId,
        description: `${order.order_number} order sotildi`,
        metadata: { totalQuantity: order.total_quantity, totalAmount: order.total_amount }
      });

      const notificationRecipientIds = await getNotificationRecipientIds(conn, {
        roles: ["admin", "bosh_agranom", "bugalter"],
        locationIds: [order.location_id],
        includeAgranomsForLocations: true,
        excludeUserIds: [req.user.id],
      });
      await createNotifications(conn, notificationRecipientIds, {
        type: "order_sold",
        title: "Buyurtma sotildi",
        message: `${order.order_number} buyurtmasi sotildi`,
        entityType: "order",
        entityId: orderId,
        locationId: order.location_id,
        createdBy: req.user.id,
      });

      return {
        id: orderId,
        orderNumber: order.order_number,
        status: "completed",
        soldBy: req.user.id,
        soldAt: new Date().toISOString()
      };
    });

    // Telegram bildirishnoma
    const pool = getPool();
    sendTelegramNotification(pool, "notify_order_sold", msgOrderSold({
      orderNumber: result.orderNumber,
      customerName: result.customerName || "—",
      quantity: result.totalQuantity,
      totalAmount: result.totalAmount,
      soldByName: req.user.fullName || req.user.username,
    })).catch(() => {});

    return sendOk(res, result, "Order sotildi.");
  })
);

// Qisman berish: shortage_quantity dan kamaytirish
router.post(
  "/:id/partial-fulfill",
  authorize("admin", "agranom"),
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (conn) => {
      const orderId = toPositiveInt(req.params.id, "orderId");
      const deliverQuantity = toPositiveInt(req.body.deliverQuantity, "deliverQuantity");
      const notes = req.body.notes || null;

      const order = await fetchOne(
        conn,
        "SELECT * FROM orders WHERE id = ? LIMIT 1 FOR UPDATE",
        [orderId]
      );

      if (!order) throw new AppError("Buyurtma topilmadi.", 404);
      if (["completed", "cancelled"].includes(order.status)) {
        throw new AppError("Bu buyurtma allaqachon yakunlangan yoki bekor qilingan.", 400);
      }

      const remainingShortage = Number(order.shortage_quantity || 0);
      if (remainingShortage <= 0) {
        throw new AppError("Bu buyurtmada bron qilingan qoldiq yo'q.", 400);
      }
      if (deliverQuantity > remainingShortage) {
        throw new AppError(
          `Berilayotgan miqdor (${deliverQuantity}) bron qoldiqdan (${remainingShortage}) ko'p bo'lmasligi kerak.`,
          400
        );
      }

      const isGreenhouseOrder = !order.batch_id;

      if (isGreenhouseOrder) {
        // Greenhouse buyurtma: tayyor bosqich stokini bevosita kamaytirish
        await conn.query(
          `UPDATE greenhouse_stage_stock
           SET quantity = GREATEST(0, quantity - ?)
           WHERE location_id = ? AND stage = 'ready'`,
          [deliverQuantity, order.location_id]
        );
        await conn.query(
          `INSERT INTO greenhouse_stage_log
            (location_id, action_date, from_stage, to_stage, quantity, notes, created_by,
             action_type, seedling_type_id, variety_id, rootstock_type_id, variety_quantity)
           VALUES (?, DATE(NOW()), 'ready', 'sold', ?, ?, ?, 'sale', ?, ?, NULL, ?)`,
          [order.location_id, deliverQuantity,
           notes || `Qisman berish — ${order.order_number}`,
           req.user.id, order.seedling_type_id || null,
           order.variety_id || null, deliverQuantity]
        );
      } else {
        // Oddiy batch buyurtma: inventardan kamaytirish
        const items = await conn.query(
          `SELECT oi.*, si.quantity_available
           FROM order_items oi
           JOIN seedling_inventory si ON si.id = oi.inventory_id
           WHERE oi.order_id = ?`,
          [orderId]
        );
        const itemRows = items[0];
        if (!itemRows.length) throw new AppError("Order itemlari topilmadi.", 400);

        let toDeliver = deliverQuantity;
        for (const item of itemRows) {
          if (toDeliver <= 0) break;
          const available = Number(item.quantity_available || 0);
          if (available <= 0) continue;

          const takeFromItem = Math.min(toDeliver, available);
          assertEnoughStock({ quantity_available: available }, takeFromItem);

          const inventory = await getInventoryById(conn, item.inventory_id, true);

          await conn.query(
            `UPDATE seedling_inventory SET quantity_available = quantity_available - ?, updated_at = NOW()
             WHERE id = ?`,
            [takeFromItem, item.inventory_id]
          );
          await conn.query(
            `INSERT INTO seedling_history
               (batch_id, inventory_id, action_type, from_location_id, previous_stage, next_stage,
                quantity, approval_status, requires_approval, reference_type, reference_id, notes, created_by)
             VALUES (?, ?, 'order_sale', ?, ?, ?, ?, 'approved', 0, 'order', ?, ?, ?)`,
            [item.batch_id, item.inventory_id, inventory.location_id,
             inventory.current_stage, inventory.current_stage,
             takeFromItem, orderId,
             notes || `Qisman berish — ${order.order_number}`,
             req.user.id]
          );
          toDeliver -= takeFromItem;
        }

        if (toDeliver > 0) {
          throw new AppError(`Inventarda yetarli ko'chat yo'q. ${toDeliver} ta yetishmaydi.`, 400);
        }
      }

      const newFulfilled = Number(order.fulfilled_quantity || 0) + deliverQuantity;
      const newShortage = Number(order.total_quantity) - newFulfilled;
      const newStatus = newShortage <= 0 ? "completed" : "partial";

      await conn.query(
        `UPDATE orders
         SET fulfilled_quantity = ?, shortage_quantity = ?, status = ?,
             updated_at = NOW()
             ${newStatus === "completed" ? ", sold_by = ?, sold_at = NOW()" : ""}
         WHERE id = ?`,
        newStatus === "completed"
          ? [newFulfilled, 0, newStatus, req.user.id, orderId]
          : [newFulfilled, newShortage, newStatus, orderId]
      );

      if (notes) {
        await conn.query(
          "UPDATE orders SET notes = CONCAT(COALESCE(notes,''), ?, '') WHERE id = ?",
          [`\n[Qisman berish ${deliverQuantity} ta]: ${notes}`, orderId]
        );
      }

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "order_partial_fulfilled",
        entityType: "order",
        entityId: orderId,
        description: `${order.order_number}: ${deliverQuantity} ta berildi (qoldi: ${newShortage})`,
        metadata: { deliverQuantity, newFulfilled, newShortage, newStatus }
      });

      const recipientIds = await getNotificationRecipientIds(conn, {
        roles: ["admin", "bosh_agranom"],
        locationIds: [order.location_id],
        excludeUserIds: [req.user.id],
      });
      await createNotifications(conn, recipientIds, {
        type: "order_partial_fulfilled",
        title: newStatus === "completed" ? "Buyurtma to'liq bajarildi" : "Buyurtma qisman bajarildi",
        message: newStatus === "completed"
          ? `${order.order_number} buyurtmasi to'liq bajarildi`
          : `${order.order_number}: ${deliverQuantity} ta berildi, ${newShortage} ta bron qoldi`,
        entityType: "order",
        entityId: orderId,
        locationId: order.location_id,
        createdBy: req.user.id,
      });

      return {
        id: orderId,
        orderNumber: order.order_number,
        status: newStatus,
        fulfilledQuantity: newFulfilled,
        shortageQuantity: newShortage,
        deliveredNow: deliverQuantity
      };
    });

    return sendOk(res, result, "Qisman berish muvaffaqiyatli bajarildi.");
  })
);

// ─── DELETE /api/orders/:id — Admin buyurtmani o'chirish ─────────────────────
router.delete(
  "/:id",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const orderId = toPositiveInt(req.params.id, "orderId");

    const order = await fetchOne(
      pool,
      "SELECT id, order_number, status FROM orders WHERE id = ? LIMIT 1",
      [orderId]
    );

    if (!order) {
      throw new AppError("Buyurtma topilmadi.", 404);
    }

    await withTransaction(async (conn) => {
      await conn.query("DELETE FROM order_items WHERE order_id = ?", [orderId]);
      await conn.query("DELETE FROM orders WHERE id = ?", [orderId]);

      await logActivity(conn, {
        actorUserId: req.user.id,
        action: "order_deleted",
        entityType: "order",
        entityId: orderId,
        description: `${order.order_number} buyurtmasi o'chirildi`,
        metadata: { orderId, orderNumber: order.order_number, status: order.status },
      });
    });

    return sendOk(res, { id: orderId }, "Buyurtma o'chirildi.");
  })
);

export default router;
