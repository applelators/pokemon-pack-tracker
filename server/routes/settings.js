import { Router } from "express";
import { getAllSettings, setSetting } from "../db.js";

const router = Router();

// JSON-valued settings that should be parsed before sending to the client.
const JSON_KEYS = ["packs_per_product", "pack_model"];

function shapeSettings(raw) {
  const out = { ...raw };
  for (const k of JSON_KEYS) {
    if (out[k]) {
      try { out[k] = JSON.parse(out[k]); } catch { /* leave as string */ }
    }
  }
  if (out.sales_tax_rate !== undefined) out.sales_tax_rate = Number(out.sales_tax_rate);
  if (out.monte_carlo_runs !== undefined) out.monte_carlo_runs = Number(out.monte_carlo_runs);
  return out;
}

router.get("/", (req, res) => {
  res.json(shapeSettings(getAllSettings()));
});

router.put("/", (req, res) => {
  const body = req.body || {};
  for (const [key, value] of Object.entries(body)) {
    const v = JSON_KEYS.includes(key) && typeof value !== "string"
      ? JSON.stringify(value)
      : String(value);
    setSetting(key, v);
  }
  res.json(shapeSettings(getAllSettings()));
});

export default router;
