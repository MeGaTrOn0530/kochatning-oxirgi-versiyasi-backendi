-- ============================================================
-- reset-operational-data.sql
-- Faqat operatsion ma'lumotlarni tozalaydi:
--   1. Ko'chat partiyalari (seedling batches)
--   2. Teplitsa bosqichlari (greenhouse stages)
--   3. Transferlar
-- Kataloglar (varieties, rootstock_types, seedling_types),
-- lokatsiyalar, foydalanuvchilar va boshqa jadvallar O'ZGARMAYDI.
--
-- Ishlatish:
--   mysql -u kochat_user -p'Azizbek1999@' kochat_platforma_app < src/scripts/reset-operational-data.sql
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

-- 1. Teplitsa bosqichlari
TRUNCATE TABLE greenhouse_stage_log;
TRUNCATE TABLE greenhouse_stage_stock;

-- greenhouse_variety_stock mavjud bo'lsa ham tozala
SET @exists = (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'greenhouse_variety_stock'
);
SET @sql = IF(@exists > 0, 'TRUNCATE TABLE greenhouse_variety_stock', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Ko'chat partiyalari
TRUNCATE TABLE seedling_scan_events;
TRUNCATE TABLE seedling_history;
TRUNCATE TABLE seedling_units;
TRUNCATE TABLE seedling_inventory;
TRUNCATE TABLE seedling_batches;

-- 3. Transferlar
TRUNCATE TABLE transfers;

SET FOREIGN_KEY_CHECKS = 1;

-- Natija tekshirish
SELECT
  (SELECT COUNT(*) FROM greenhouse_stage_log)   AS greenhouse_log,
  (SELECT COUNT(*) FROM greenhouse_stage_stock)  AS greenhouse_stock,
  (SELECT COUNT(*) FROM seedling_batches)        AS seedling_batches,
  (SELECT COUNT(*) FROM seedling_inventory)      AS seedling_inventory,
  (SELECT COUNT(*) FROM transfers)               AS transfers,
  (SELECT COUNT(*) FROM locations)               AS lokatsiyalar_saqlansi,
  (SELECT COUNT(*) FROM users)                   AS foydalanuvchilar_saqlansi,
  (SELECT COUNT(*) FROM varieties)               AS navlar_saqlansi;
