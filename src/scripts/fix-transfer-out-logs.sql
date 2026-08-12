-- transfer_out log yozuvlarida to_stage noto'g'ri (from_stage bilan bir xil) bo'lgan
-- yozuvlarni NULL ga o'zgartirish.
-- Bu getVarietyStock da ikki marta hisoblanib, scale factor buzilib ketishiga sabab bo'lgan edi.

UPDATE greenhouse_stage_log
SET to_stage = NULL
WHERE action_type = 'transfer_out'
  AND to_stage IS NOT NULL
  AND to_stage = from_stage;
