-- ============================================================
-- reset-greenhouse-data.sql
-- Faqat "Teplitsa bosqichlari" (greenhouse stage) subsystemini tozalaydi:
--   - greenhouse_stage_log        (harakatlar tarixi)
--   - greenhouse_stage_stock      (bosqich bo'yicha rasmiy miqdorlar)
--   - greenhouse_variety_stock    (nav bo'yicha miqdorlar)
--   - greenhouse_transfers        (teplitsalar-orasi transfer yozuvlari)
--
-- Boshqa hech narsaga tegmaydi: partiya-asosidagi ko'chat tizimi
-- (seedling_batches, seedling_inventory, seedling_history, seedling_units),
-- buyurtmalar, kataloglar (varieties/seedling_types/rootstock_types),
-- lokatsiyalar va foydalanuvchilar O'ZGARMAYDI.
--
-- Ishlatish (serverda, backend qayta ishga tushirilgandan keyin):
--   mysql -u <user> -p'<password>' <db_nomi> < src/scripts/reset-greenhouse-data.sql
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE greenhouse_stage_log;
TRUNCATE TABLE greenhouse_stage_stock;

-- greenhouse_variety_stock mavjud bo'lsa ham tozala (yangi kodda har doim yaratiladi)
SET @exists = (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'greenhouse_variety_stock'
);
SET @sql = IF(@exists > 0, 'TRUNCATE TABLE greenhouse_variety_stock', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists = (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'greenhouse_transfers'
);
SET @sql = IF(@exists > 0, 'TRUNCATE TABLE greenhouse_transfers', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET FOREIGN_KEY_CHECKS = 1;

-- Natija tekshirish
SELECT
  (SELECT COUNT(*) FROM greenhouse_stage_log)      AS greenhouse_log,
  (SELECT COUNT(*) FROM greenhouse_stage_stock)     AS greenhouse_stock,
  (SELECT COUNT(*) FROM seedling_batches)           AS seedling_batches_saqlansi,
  (SELECT COUNT(*) FROM locations)                  AS lokatsiyalar_saqlansi,
  (SELECT COUNT(*) FROM users)                      AS foydalanuvchilar_saqlansi,
  (SELECT COUNT(*) FROM varieties)                  AS navlar_saqlansi;
