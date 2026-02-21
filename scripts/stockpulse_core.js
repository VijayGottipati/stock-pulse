require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATA_DIR = path.join(__dirname, "..", "data");
const UPSERT_BATCH_SIZE = 500;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function chunkArray(input, size) {
  const chunks = [];
  for (let i = 0; i < input.length; i += size) {
    chunks.push(input.slice(i, i + size));
  }
  return chunks;
}

function readJsonArray(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf8");
  if (!content.trim()) {
    return [];
  }

  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array in ${filePath}`);
  }
  return parsed;
}

async function upsertInBatches(table, rows, onConflict) {
  if (!rows.length) return;
  const chunks = chunkArray(rows, UPSERT_BATCH_SIZE);
  for (let i = 0; i < chunks.length; i += 1) {
    const { error } = await supabase.from(table).upsert(chunks[i], { onConflict });
    if (error) throw error;
  }
}

async function fetchSkuCodeMap() {
  const { data, error } = await supabase.from("skus").select("id, sku_code");
  if (error) throw error;
  return Object.fromEntries((data || []).map((x) => [x.sku_code, x.id]));
}

async function fetchSupplierCodeMap() {
  const { data, error } = await supabase.from("suppliers").select("id, supplier_code");
  if (error) throw error;
  return Object.fromEntries((data || []).map((x) => [x.supplier_code, x.id]));
}

async function upsertSkusFromData() {
  const skuInput = readJsonArray("skus.json");
  if (!skuInput.length) {
    throw new Error("data/skus.json is required and must contain at least one sku_code.");
  }

  const normalized = skuInput
    .map((x) => ({
      sku_code: String(x.sku_code || "").trim(),
      name: String((x.name || "").trim() || `Product ${String(x.sku_code || "").trim()}`),
      category: x.category || "General",
      unit_cost: Number.isFinite(Number(x.unit_cost)) ? Number(x.unit_cost) : 0,
      active: x.active !== false,
    }))
    .filter((x) => x.sku_code);

  await upsertInBatches("skus", normalized, "sku_code");
  console.log(`Upserted skus: ${normalized.length}`);
}

async function upsertSuppliersFromData() {
  const supplierInput = readJsonArray("suppliers.json");
  const fallback = [
    { supplier_code: "SUP-A", name: "Supplier A", predicted_lead_days: 9, reliability_score: 0.92 },
    { supplier_code: "SUP-B", name: "Supplier B", predicted_lead_days: 7, reliability_score: 0.84 },
  ];
  const source = supplierInput.length ? supplierInput : fallback;

  const normalized = source
    .map((x) => ({
      supplier_code: String(x.supplier_code || "").trim(),
      name: String((x.name || "").trim() || `Supplier ${String(x.supplier_code || "").trim()}`),
      predicted_lead_days: Math.max(0, Number.parseInt(x.predicted_lead_days ?? 7, 10)),
      reliability_score: clamp(Number(x.reliability_score ?? 0.8), 0, 1),
    }))
    .filter((x) => x.supplier_code);

  await upsertInBatches("suppliers", normalized, "supplier_code");
  console.log(`Upserted suppliers: ${normalized.length}`);
}

async function upsertSupplierSkusFromData() {
  const mappings = readJsonArray("supplier_skus.json");
  const skuByCode = await fetchSkuCodeMap();
  const supplierByCode = await fetchSupplierCodeMap();

  const supplierCodes = Object.keys(supplierByCode);
  if (!supplierCodes.length) throw new Error("No suppliers found.");

  let rows = mappings
    .map((x) => ({
      supplier_id: supplierByCode[x.supplier_code],
      sku_id: skuByCode[x.sku_code],
      unit_price: Number(x.unit_price ?? 0),
      min_order_qty: Math.max(1, Number.parseInt(x.min_order_qty ?? 1, 10)),
      is_active: x.is_active !== false,
    }))
    .filter((x) => x.supplier_id && x.sku_id);

  if (!rows.length) {
    const defaultSupplierId = supplierByCode[supplierCodes[0]];
    rows = Object.entries(skuByCode).map(([, skuId]) => ({
      supplier_id: defaultSupplierId,
      sku_id: skuId,
      unit_price: 0,
      min_order_qty: 1,
      is_active: true,
    }));
  }

  await upsertInBatches("supplier_skus", rows, "supplier_id,sku_id");
  console.log(`Upserted supplier_skus: ${rows.length}`);
}

async function upsertInventoryFromData() {
  const inventoryInput = readJsonArray("inventory_levels.json");
  const skuByCode = await fetchSkuCodeMap();

  let rows = inventoryInput
    .map((x) => ({
      sku_id: skuByCode[x.sku_code],
      current_stock: Math.max(0, Number.parseInt(x.current_stock ?? 0, 10)),
      incoming_stock: Math.max(0, Number.parseInt(x.incoming_stock ?? 0, 10)),
      safety_buffer_days: Math.max(0, Number.parseInt(x.safety_buffer_days ?? 2, 10)),
    }))
    .filter((x) => x.sku_id);

  if (!rows.length) {
    rows = Object.entries(skuByCode).map(([, skuId]) => ({
      sku_id: skuId,
      current_stock: 100,
      incoming_stock: 0,
      safety_buffer_days: 2,
    }));
  }

  await upsertInBatches("inventory_levels", rows, "sku_id");
  console.log(`Upserted inventory_levels: ${rows.length}`);
}

async function upsertSalesFromData() {
  const salesInput = readJsonArray("sales_daily.json");
  const skuByCode = await fetchSkuCodeMap();

  let rows = salesInput
    .map((x) => ({
      sku_id: skuByCode[x.sku_code],
      sales_date: x.sales_date,
      units_sold: Math.max(0, Number.parseInt(x.units_sold ?? 0, 10)),
    }))
    .filter((x) => x.sku_id && x.sales_date);

  if (!rows.length) {
    const today = new Date();
    rows = [];
    const skuIds = Object.values(skuByCode);
    for (let i = 0; i < skuIds.length; i += 1) {
      const skuId = skuIds[i];
      for (let d = 1; d <= 7; d += 1) {
        const date = new Date(today);
        date.setDate(today.getDate() - d);
        rows.push({
          sku_id: skuId,
          sales_date: formatDate(date),
          units_sold: Math.max(1, 8 + ((i * 3 + d) % 20)),
        });
      }
    }
  }

  await upsertInBatches("sales_daily", rows, "sku_id,sales_date");
  console.log(`Upserted sales_daily: ${rows.length}`);
}

async function getCandidates() {
  const { data, error } = await supabase.rpc("fn_stockpulse_candidates");
  if (error) throw error;
  console.log(`Candidates from fn_stockpulse_candidates: ${(data || []).length}`);
  return data || [];
}

function buildReasoning(candidate, supplierName) {
  const seasonalText = candidate.seasonal_detected
    ? `Seasonal anomaly ratio ${candidate.anomaly_ratio}x detected, adding ${(Number(candidate.suggested_buffer_pct) * 100).toFixed(0)}% buffer.`
    : "No seasonal anomaly detected.";

  return [
    `${candidate.sku_code} has ${Number(candidate.days_remaining).toFixed(2)} days of stock remaining.`,
    `${supplierName} lead time is ${candidate.lead_time_days} days with ${candidate.safety_buffer_days} safety buffer days.`,
    seasonalText,
    `Ordering ${candidate.suggested_qty} units to prevent stockout.`,
  ].join(" ");
}

async function runDecisionAndAct() {
  const { data: runRows, error: runErr } = await supabase
    .from("stockpulse_runs")
    .insert([{ run_status: "running", notes: "Hourly StockPulse automation run" }])
    .select("id")
    .limit(1);
  if (runErr) throw runErr;
  const runId = runRows[0].id;

  const candidates = await getCandidates();
  const supplierCache = new Map();
  let orderCount = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    let supplierName = "Unknown supplier";

    if (c.best_supplier_id) {
      if (!supplierCache.has(c.best_supplier_id)) {
        const { data: supRows, error: supErr } = await supabase
          .from("suppliers")
          .select("id, name")
          .eq("id", c.best_supplier_id)
          .limit(1);
        if (supErr) throw supErr;
        supplierCache.set(c.best_supplier_id, supRows?.[0]?.name || "Unknown supplier");
      }
      supplierName = supplierCache.get(c.best_supplier_id);
    }

    const shouldOrder = c.suggested_qty > 0 && Boolean(c.best_supplier_id);
    const reasoning = buildReasoning(c, supplierName);
    let decision = shouldOrder ? "order" : "no_action";

    if (shouldOrder) {
      const { data: openPos, error: openErr } = await supabase
        .from("purchase_orders")
        .select("id")
        .eq("sku_id", c.sku_id)
        .eq("supplier_id", c.best_supplier_id)
        .in("status", ["placed", "in_transit"])
        .limit(1);
      if (openErr) throw openErr;
      if (openPos && openPos.length > 0) {
        decision = "no_action";
      }
    }

    const { error: decErr } = await supabase.from("stockpulse_decisions").insert([
      {
        run_id: runId,
        sku_id: c.sku_id,
        velocity_7day: c.velocity_7day || 0,
        velocity_same_week_last_year: c.velocity_same_week_last_year || 0,
        anomaly_ratio: c.anomaly_ratio,
        seasonal_detected: Boolean(c.seasonal_detected),
        days_remaining: c.days_remaining,
        lead_time_days: c.lead_time_days,
        safety_buffer_days: c.safety_buffer_days,
        recommended_qty: c.suggested_qty,
        selected_supplier_id: c.best_supplier_id,
        decision,
        reasoning,
      },
    ]);
    if (decErr) throw decErr;

    if (c.seasonal_detected) {
      const now = new Date();
      const yearNum = now.getUTCFullYear();
      const start = new Date(Date.UTC(yearNum, 0, 1));
      const day = Math.floor((now - start) / 86400000);
      const weekNum = Math.ceil((day + start.getUTCDay() + 1) / 7);
      const { error: seasonalErr } = await supabase.from("seasonal_pattern_logs").upsert(
        [
          {
            sku_id: c.sku_id,
            year_num: yearNum,
            week_num: weekNum,
            anomaly_ratio: c.anomaly_ratio || 1,
            suggested_buffer_pct: c.suggested_buffer_pct || 0,
            note: `${c.sku_code} anomaly captured during run ${runId}`,
          },
        ],
        { onConflict: "sku_id,year_num,week_num" }
      );
      if (seasonalErr) throw seasonalErr;
    }

    if (decision === "order") {
      const poNumber = `PO-${Date.now()}-${i + 1}`;
      const predictedArrivalDate = formatDate(addDays(new Date(), c.lead_time_days));

      const { error: poErr } = await supabase.from("purchase_orders").insert([
        {
          po_number: poNumber,
          sku_id: c.sku_id,
          supplier_id: c.best_supplier_id,
          qty_ordered: c.suggested_qty,
          status: "placed",
          predicted_arrival_date: predictedArrivalDate,
          seasonal_buffer_pct: c.suggested_buffer_pct || 0,
          reasoning,
          webhook_fired: true,
        },
      ]);
      if (poErr) throw poErr;

      const { data: invRows, error: invGetErr } = await supabase
        .from("inventory_levels")
        .select("sku_id, incoming_stock")
        .eq("sku_id", c.sku_id)
        .limit(1);
      if (invGetErr) throw invGetErr;
      const currentIncoming = invRows?.[0]?.incoming_stock || 0;

      const { error: invUpdErr } = await supabase
        .from("inventory_levels")
        .update({ incoming_stock: currentIncoming + c.suggested_qty, updated_at: new Date().toISOString() })
        .eq("sku_id", c.sku_id);
      if (invUpdErr) throw invUpdErr;

      orderCount += 1;
    }
  }

  const { error: runDoneErr } = await supabase
    .from("stockpulse_runs")
    .update({ run_status: "success", run_completed_at: new Date().toISOString() })
    .eq("id", runId);
  if (runDoneErr) throw runDoneErr;

  console.log(`Decision + Act complete. Run id: ${runId}. Orders placed: ${orderCount}.`);
}

async function runWaitAndLearn() {
  const { data: openPoRows, error: poErr } = await supabase
    .from("purchase_orders")
    .select("id, sku_id, po_number, qty_ordered, predicted_arrival_date, status")
    .in("status", ["placed", "in_transit"])
    .is("actual_arrival_date", null);
  if (poErr) throw poErr;

  if (!openPoRows || openPoRows.length === 0) {
    console.log("Wait + Learn: no open POs to process.");
    return;
  }

  let learnedCount = 0;
  for (let i = 0; i < openPoRows.length; i += 1) {
    const po = openPoRows[i];
    const now = new Date();
    const lateBias = po.status === "placed" ? 0.2 : 0.1;
    const arrivalDeltaDays = Math.random() < lateBias ? 2 : 0;
    const arrivalDate = formatDate(addDays(now, arrivalDeltaDays));

    const fillRate = clamp(0.95 + Math.random() * 0.1, 0.9, 1.05);
    const qtyReceived = Math.max(0, Math.round(po.qty_ordered * fillRate));
    const expectedDailyDemand = Math.max(1, Math.ceil(po.qty_ordered / 10));
    const stockoutDays = arrivalDeltaDays > 1 ? 1 : 0;
    const wasteUnits = Math.max(0, qtyReceived - expectedDailyDemand * 8);

    const { error: poUpdateErr } = await supabase
      .from("purchase_orders")
      .update({
        status: "delivered",
        qty_received: qtyReceived,
        actual_arrival_date: arrivalDate,
      })
      .eq("id", po.id);
    if (poUpdateErr) throw poUpdateErr;

    const { data: invRows, error: invErr } = await supabase
      .from("inventory_levels")
      .select("sku_id, current_stock, incoming_stock")
      .eq("sku_id", po.sku_id)
      .limit(1);
    if (invErr) throw invErr;

    const current = invRows?.[0]?.current_stock || 0;
    const incoming = invRows?.[0]?.incoming_stock || 0;
    const incomingAfterReceipt = Math.max(0, incoming - qtyReceived);

    const { error: invUpdateErr } = await supabase
      .from("inventory_levels")
      .update({
        current_stock: current + qtyReceived,
        incoming_stock: incomingAfterReceipt,
        updated_at: new Date().toISOString(),
      })
      .eq("sku_id", po.sku_id);
    if (invUpdateErr) throw invUpdateErr;

    const { data: scoreResult, error: scoreErr } = await supabase.rpc("fn_score_delivery", {
      p_po_id: po.id,
      p_stockout_days: stockoutDays,
      p_waste_units: wasteUnits,
    });
    if (scoreErr) throw scoreErr;

    learnedCount += 1;
    console.log(
      `Learned ${po.po_number}: received=${qtyReceived}, stockout_days=${stockoutDays}, waste_units=${wasteUnits}, outcome=${scoreResult}`
    );
  }

  console.log(`Wait + Learn complete. Deliveries processed: ${learnedCount}.`);
}

async function seedFromDataFiles() {
  await upsertSkusFromData();
  await upsertSuppliersFromData();
  await upsertSupplierSkusFromData();
  await upsertInventoryFromData();
  await upsertSalesFromData();
}

async function runHourlyWorkflow() {
  await seedFromDataFiles();
  await runDecisionAndAct();
}

async function runLearnWorkflow() {
  await runWaitAndLearn();
}

async function runFullWorkflow() {
  await runHourlyWorkflow();
  await runLearnWorkflow();
}

module.exports = {
  runHourlyWorkflow,
  runLearnWorkflow,
  runFullWorkflow,
};
