import { Router } from "express";
import { getPool } from "../config/database.js";
import asyncHandler from "../utils/async-handler.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import { sendOk } from "../utils/http.js";

const router = Router();

router.use(authenticate);

router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const pool = getPool();

    const [stats] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE status = 'active') AS active_users,
         (SELECT COUNT(*) FROM locations WHERE status = 'active') AS active_locations,
         (SELECT COALESCE(SUM(quantity_available), 0) FROM seedling_inventory) AS total_stock,
         (SELECT COALESCE(SUM(defect_quantity), 0) FROM seedling_inventory) AS total_defects,
         (SELECT COUNT(*) FROM transfers WHERE status IN ('pending_sender', 'pending_head', 'pending_receiver')) AS pending_transfers,
         (SELECT COUNT(*) FROM seedling_history WHERE approval_status = 'pending') AS pending_approvals,
         (SELECT COUNT(*) FROM tasks WHERE status IN ('open', 'in_progress')) AS open_tasks,
         (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE status = 'completed') AS revenue,
         (SELECT COALESCE(SUM(quantity), 0) FROM greenhouse_stage_stock WHERE stage = 'ready') AS greenhouse_ready,
         (SELECT COALESCE(SUM(quantity), 0) FROM greenhouse_stage_stock WHERE stage = 'grafted') AS greenhouse_grafted,
         (SELECT COALESCE(SUM(quantity), 0) FROM greenhouse_stage_stock WHERE stage = 'grafting') AS greenhouse_grafting,
         (SELECT COALESCE(SUM(quantity), 0) FROM greenhouse_stage_stock WHERE stage = 'cassette') AS greenhouse_cassette,
         (SELECT COALESCE(SUM(quantity), 0) FROM greenhouse_stage_stock) AS greenhouse_total`
    );

    // Per-location greenhouse stage stock (greenhouse + source locations)
    const [locationStageStock] = await pool.query(
      `SELECT l.id AS location_id, l.name AS location_name, l.type AS location_type, l.is_source,
              gss.stage, COALESCE(gss.quantity, 0) AS quantity
       FROM locations l
       LEFT JOIN greenhouse_stage_stock gss ON gss.location_id = l.id
       WHERE l.status = 'active' AND (l.type = 'greenhouse' OR l.is_source = 1)
       ORDER BY l.id, gss.stage`
    );

    // Source location: per-batch inventory
    const [sourceInventory] = await pool.query(
      `SELECT si.location_id, l.name AS location_name,
              b.id AS batch_id, b.batch_code,
              v.name AS variety_name,
              st.name AS seedling_type_name,
              si.current_stage AS stage,
              COALESCE(si.quantity_available, 0) AS quantity
       FROM seedling_inventory si
       JOIN locations l ON l.id = si.location_id
       JOIN seedling_batches b ON b.id = si.batch_id
       LEFT JOIN varieties v ON v.id = b.variety_id
       LEFT JOIN seedling_types st ON st.id = b.seedling_type_id
       WHERE l.is_source = 1 AND l.status = 'active' AND si.quantity_available > 0
       ORDER BY l.id, si.quantity_available DESC`
    );

    const [lowStock] = await pool.query(
      `SELECT si.id AS inventory_id, si.quantity_available, si.current_stage,
              b.batch_code, l.name AS location_name, v.name AS variety_name
       FROM seedling_inventory si
       JOIN seedling_batches b ON b.id = si.batch_id
       JOIN locations l ON l.id = si.location_id
       JOIN varieties v ON v.id = b.variety_id
       WHERE si.quantity_available <= 100
       ORDER BY si.quantity_available ASC
       LIMIT 10`
    );

    const [recentOrders] = await pool.query(
      `SELECT o.id, o.order_number, o.customer_name, o.status, o.total_amount, o.created_at
       FROM orders o
       ORDER BY o.id DESC
       LIMIT 10`
    );

    return sendOk(res, {
      summary: stats[0],
      lowStock,
      recentOrders,
      locationStageStock,
      sourceInventory,
    });
  })
);

router.get(
  "/activity-log",
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 30;

    const [rows] = await pool.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.description, a.metadata, a.created_at,
              u.full_name AS actor_name, u.username AS actor_username
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
       ORDER BY a.id DESC
       LIMIT ?`,
      [Number.isNaN(limit) ? 30 : limit]
    );

    return sendOk(res, rows);
  })
);

export default router;
