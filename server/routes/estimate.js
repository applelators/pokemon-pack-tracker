import { Router } from "express";
import db, { getSetting } from "../db.js";
import { getCachedSet } from "../services/pokemontcg.js";
import { estimate } from "../services/estimator.js";

const router = Router();

function round2(n) {
  return Math.round(n * 100) / 100;
}

function setTotals(setId) {
  const orders = db.prepare("SELECT id, tax_rate FROM orders WHERE set_id = ?").all(setId);
  const breakdown = {}; // product_type -> { quantity, packs, spend }
  let totalSpent = 0;
  let totalPacks = 0;
  for (const o of orders) {
    const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(o.id);
    let subtotal = 0;
    for (const it of items) {
      const lineSubtotal = it.quantity * it.unit_price;
      subtotal += lineSubtotal;
      totalPacks += it.quantity * it.packs_per_unit;
      const b = (breakdown[it.product_type] ||= { quantity: 0, packs: 0, spend: 0 });
      b.quantity += it.quantity;
      b.packs += it.quantity * it.packs_per_unit;
      b.spend += lineSubtotal * (1 + o.tax_rate);
    }
    totalSpent += subtotal * (1 + o.tax_rate);
  }
  for (const b of Object.values(breakdown)) b.spend = round2(b.spend);
  return { totalSpent: round2(totalSpent), totalPacks, orderCount: orders.length, breakdown };
}

function computeEstimate(set, opened) {
  if (!set.rarities || set.rarities.length === 0) return null;
  let packModel;
  try {
    packModel = JSON.parse(getSetting("pack_model"));
  } catch {
    packModel = { slots: [] };
  }
  const runs = Number(getSetting("monte_carlo_runs")) || 3000;
  return estimate({ rarities: set.rarities, packModel, opened, runs });
}

// GET /api/sets/:id/summary — spend, packs, product breakdown, completion estimate.
router.get("/sets/:id/summary", (req, res) => {
  const set = getCachedSet(req.params.id);
  if (!set) return res.status(404).json({ error: "Set not imported" });
  const totals = setTotals(set.id);
  const completion = computeEstimate(set, totals.totalPacks);
  res.json({ set, ...totals, completion });
});

// GET /api/estimate/:setId?opened=N — standalone estimate (defaults to opened from data).
router.get("/estimate/:setId", (req, res) => {
  const set = getCachedSet(req.params.setId);
  if (!set) return res.status(404).json({ error: "Set not imported" });
  const opened = req.query.opened !== undefined
    ? Number(req.query.opened)
    : setTotals(set.id).totalPacks;
  const completion = computeEstimate(set, opened);
  if (!completion) return res.status(400).json({ error: "No rarity data for this set" });
  res.json(completion);
});

export default router;
