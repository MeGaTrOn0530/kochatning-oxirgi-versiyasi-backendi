-- ============================================================
-- clean-data.sql
-- Katalog (seedling_types, rootstock_types, varieties) va
-- admin foydalanuvchidan tashqari HAMMA ma'lumotni o'chiradi.
-- Ishlatish:
--   mysql -u kochat_user -p'Azizbek1999@' kochat_platforma_app < src/scripts/clean-data.sql
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE certificates;
TRUNCATE TABLE bot_orders;
TRUNCATE TABLE telegram_settings;
TRUNCATE TABLE telegram_bot_config;
TRUNCATE TABLE bosh_ofes_modules;
TRUNCATE TABLE temperature_readings;
TRUNCATE TABLE sensor_devices;
TRUNCATE TABLE greenhouse_stage_log;
TRUNCATE TABLE greenhouse_stage_stock;
TRUNCATE TABLE attendance;
TRUNCATE TABLE employee_tasks;
TRUNCATE TABLE agro_journal;
TRUNCATE TABLE deliveries;
TRUNCATE TABLE customers;
TRUNCATE TABLE payments;
TRUNCATE TABLE activity_logs;
TRUNCATE TABLE notifications;
TRUNCATE TABLE customer_products;
TRUNCATE TABLE tasks;
TRUNCATE TABLE order_items;
TRUNCATE TABLE orders;
TRUNCATE TABLE transfers;
TRUNCATE TABLE seedling_scan_events;
TRUNCATE TABLE seedling_history;
TRUNCATE TABLE seedling_units;
TRUNCATE TABLE seedling_inventory;
TRUNCATE TABLE seedling_batches;
TRUNCATE TABLE auth_sessions;
TRUNCATE TABLE locations;

-- Faqat admin rolini saqlab, boshqa foydalanuvchilarni o'chirish
DELETE FROM users WHERE role != 'admin';
UPDATE users SET location_id = NULL WHERE role = 'admin';

SET FOREIGN_KEY_CHECKS = 1;

SELECT
  (SELECT COUNT(*) FROM seedling_types)  AS seedling_types_qoldi,
  (SELECT COUNT(*) FROM rootstock_types) AS rootstock_types_qoldi,
  (SELECT COUNT(*) FROM varieties)       AS varieties_qoldi,
  (SELECT COUNT(*) FROM users)           AS admin_users_qoldi;
