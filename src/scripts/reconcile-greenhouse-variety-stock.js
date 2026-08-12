// Bir martalik tuzatish: greenhouse_variety_stock jadvali endi barcha yozish nuqtalarida
// (move, receive, stage-transfer, sotuv, undo) to'g'ri yangilanadi, lekin TARIXIY yozuvlar
// (bu tuzatishdan oldingi) baribir to'liq emas — chunki ba'zi eski harakatlar (qo'lda kirim,
// teplitsalar orasidagi eski transferlar, sotuvlar) nav ma'lumotisiz o'tgan.
//
// Bu skript har (location, stage) uchun "Aniqlanmagan" (variety_id=0, seedling_type_id=0,
// rootstock_type_id=0) buketni SUM(greenhouse_variety_stock) === greenhouse_stage_stock.quantity
// bo'lguncha to'ldiradi — nomlangan (aniq nav) qatorlarga HECH QACHON tegmaydi.
//
// Idempotent: qayta ishga tushirilsa, farqni qaytadan hisoblab, "Aniqlanmagan" buketni ABSOLYUT
// qiymatga o'rnatadi (increment emas), shuning uchun ikki marta ishga tushirish xavfli emas.

import mysql from "mysql2/promise";
import env from "../config/env.js";
import { ensureDatabaseReady } from "../db/bootstrap.js";
import { ensureVarietyStockTable } from "../utils/greenhouse-stock.js";

async function reconcile() {
  await ensureDatabaseReady();

  const connection = await mysql.createConnection({
    host: env.dbHost,
    port: env.dbPort,
    user: env.dbUser,
    password: env.dbPassword,
    database: env.dbName,
  });

  const warnings = [];
  let misTaggedCollapsed = 0;
  let stagesToppedUp = 0;
  let totalShortfallApplied = 0;

  try {
    await ensureVarietyStockTable(connection);

    await connection.beginTransaction();

    // ── Phase A ──────────────────────────────────────────────────────────────
    // cassette/grafting FAQAT rootstock bo'yicha kuzatilishi kerak (nav/tur ahamiyatsiz).
    // Yozish-tomoni tuzatishdan oldin yozilgan ba'zi qatorlar bu ikki bosqichda nav bilan
    // tavsiflangan bo'lishi mumkin — ularni rootstock-only buketga qo'shib, o'chiramiz.
    const [misTagged] = await connection.query(
      `SELECT location_id, stage, rootstock_type_id, SUM(quantity) AS qty
       FROM greenhouse_variety_stock
       WHERE stage IN ('cassette','grafting') AND (variety_id <> 0 OR seedling_type_id <> 0)
       GROUP BY location_id, stage, rootstock_type_id`
    );

    for (const row of misTagged) {
      await connection.query(
        `INSERT INTO greenhouse_variety_stock
          (location_id, stage, variety_id, seedling_type_id, rootstock_type_id, quantity)
         VALUES (?, ?, 0, 0, ?, ?)
         ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
        [row.location_id, row.stage, row.rootstock_type_id, row.qty]
      );
    }

    if (misTagged.length > 0) {
      await connection.query(
        `DELETE FROM greenhouse_variety_stock
         WHERE stage IN ('cassette','grafting') AND (variety_id <> 0 OR seedling_type_id <> 0)`
      );
    }
    misTaggedCollapsed = misTagged.length;

    // ── Phase B ──────────────────────────────────────────────────────────────
    // Har (location, stage) juftligi uchun (ikkala jadvaldan ham) farqni "Aniqlanmagan"
    // buketga yopamiz. greenhouse_stage_stock — bosqich darajasidagi haqiqiy son (har doim aniq).
    const [keyRows] = await connection.query(
      `SELECT location_id, stage FROM greenhouse_stage_stock
       UNION
       SELECT location_id, stage FROM greenhouse_variety_stock
       WHERE NOT (variety_id = 0 AND seedling_type_id = 0 AND rootstock_type_id = 0)`
    );

    for (const key of keyRows) {
      const [[stageRow]] = await connection.query(
        `SELECT quantity FROM greenhouse_stage_stock WHERE location_id = ? AND stage = ? LIMIT 1`,
        [key.location_id, key.stage]
      );
      const stageQty = Number(stageRow?.quantity || 0);

      const [[namedSumRow]] = await connection.query(
        `SELECT COALESCE(SUM(quantity), 0) AS named_sum
         FROM greenhouse_variety_stock
         WHERE location_id = ? AND stage = ?
           AND NOT (variety_id = 0 AND seedling_type_id = 0 AND rootstock_type_id = 0)
         FOR UPDATE`,
        [key.location_id, key.stage]
      );
      const namedSum = Number(namedSumRow.named_sum || 0);

      if (namedSum > stageQty) {
        warnings.push({
          locationId: key.location_id,
          stage: key.stage,
          stageQty,
          namedSum,
          delta: namedSum - stageQty,
        });
        // Nomlangan qatorlarga tegmaymiz — faqat Aniqlanmagan buketni nolga o'rnatamiz,
        // manual review kerak.
        await connection.query(
          `INSERT INTO greenhouse_variety_stock (location_id, stage, variety_id, seedling_type_id, rootstock_type_id, quantity)
           VALUES (?, ?, 0, 0, 0, 0)
           ON DUPLICATE KEY UPDATE quantity = 0`,
          [key.location_id, key.stage]
        );
        continue;
      }

      const shortfall = stageQty - namedSum;
      await connection.query(
        `INSERT INTO greenhouse_variety_stock (location_id, stage, variety_id, seedling_type_id, rootstock_type_id, quantity)
         VALUES (?, ?, 0, 0, 0, ?)
         ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)`,
        [key.location_id, key.stage, shortfall]
      );

      if (shortfall > 0) {
        totalShortfallApplied += shortfall;
        stagesToppedUp += 1;
      }
    }

    await connection.commit();

    console.log("Greenhouse variety-stock reconciliation tugadi.");
    console.log({
      misTaggedBucketsCollapsed: misTaggedCollapsed,
      stagesToppedUp,
      totalShortfallApplied,
      warningsCount: warnings.length,
    });

    if (warnings.length > 0) {
      console.warn(
        "DIQQAT: quyidagi (location, stage) larda nomlangan navlar yig'indisi umumiy sondan katta — qo'lda tekshiring:"
      );
      for (const w of warnings) {
        console.warn(
          `  location=${w.locationId} stage=${w.stage} stageQty=${w.stageQty} namedSum=${w.namedSum} delta=${w.delta}`
        );
      }
    }
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }

  return warnings;
}

reconcile()
  .then((warnings) => process.exit(warnings.length > 0 ? 1 : 0))
  .catch((error) => {
    console.error("Reconciliation xatoligi:", error);
    process.exit(1);
  });
