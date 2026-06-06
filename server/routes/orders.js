import { Router } from "express";
import db from "../db.js";

const router = Router();

function getOrderWithItems(id) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!order) return null;
  order.items = db
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
    .all(id);
  const subtotal = order.items.reduce((a, i) => a + i.quantity * i.unit_price, 0);
  order.subtotal = round2(subtotal);
  order.tax = round2(subtotal * order.tax_rate);
  order.total = round2(subtotal + subtotal * order.tax_rate);
  order.packs = order.items.reduce((a, i) => a + i.quantity * i.packs_per_unit, 0);
  return order;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) return "At least one line item is required";
  for (const it of items) {
    if (!it.product_type) return "Each item needs a product_type";
    if (!(Number(it.quantity) > 0)) return "Quantity must be > 0";
    if (!(Number(it.unit_price) >= 0)) return "Unit price must be >= 0";
    if (!(Number(it.packs_per_unit) >= 0)) return "packs_per_unit must be >= 0";
  }
  return null;
}

router.get("/", (req, res) => {
  const { set } = req.query;
  const rows = set
    ? db.prepare("SELECT id FROM orders WHERE set_id = ? ORDER BY purchase_date DESC, id DESC").all(set)
    : db.prepare("SELECT id FROM orders ORDER BY purchase_date DESC, id DESC").all();
  res.json(rows.map((r) => getOrderWithItems(r.id)));
});

router.get("/:id", (req, res) => {
  const order = getOrderWithItems(Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

router.post("/", (req, res) => {
  const { set_id, purchase_date, tax_rate = 0, note = "", items } = req.body || {};
  if (!set_id) return res.status(400).json({ error: "set_id is required" });
  if (!purchase_date) return res.status(400).json({ error: "purchase_date is required" });
  const setExists = db.prepare("SELECT 1 FROM sets WHERE id = ?").get(set_id);
  if (!setExists) return res.status(400).json({ error: "Unknown set_id (import it first)" });
  const itemErr = validateItems(items);
  if (itemErr) return res.status(400).json({ error: itemErr });

  const tx = db.transaction(() => {
    const info = db
      .prepare("INSERT INTO orders (set_id, purchase_date, tax_rate, note) VALUES (?, ?, ?, ?)")
      .run(set_id, purchase_date, Number(tax_rate), note);
    const ins = db.prepare(
      "INSERT INTO order_items (order_id, product_type, quantity, unit_price, packs_per_unit) VALUES (?, ?, ?, ?, ?)"
    );
    for (const it of items) {
      ins.run(info.lastInsertRowid, it.product_type, Number(it.quantity), Number(it.unit_price), Number(it.packs_per_unit));
    }
    return info.lastInsertRowid;
  });
  const id = tx();
  res.status(201).json(getOrderWithItems(id));
});

router.put("/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT id FROM orders WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Order not found" });
  const { purchase_date, tax_rate, note, items } = req.body || {};
  if (items !== undefined) {
    const itemErr = validateItems(items);
    if (itemErr) return res.status(400).json({ error: itemErr });
  }

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE orders SET purchase_date = COALESCE(?, purchase_date), tax_rate = COALESCE(?, tax_rate), note = COALESCE(?, note) WHERE id = ?"
    ).run(
      purchase_date ?? null,
      tax_rate !== undefined ? Number(tax_rate) : null,
      note ?? null,
      id
    );
    if (items !== undefined) {
      db.prepare("DELETE FROM order_items WHERE order_id = ?").run(id);
      const ins = db.prepare(
        "INSERT INTO order_items (order_id, product_type, quantity, unit_price, packs_per_unit) VALUES (?, ?, ?, ?, ?)"
      );
      for (const it of items) {
        ins.run(id, it.product_type, Number(it.quantity), Number(it.unit_price), Number(it.packs_per_unit));
      }
    }
  });
  tx();
  res.json(getOrderWithItems(id));
});

router.delete("/:id", (req, res) => {
  const info = db.prepare("DELETE FROM orders WHERE id = ?").run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: "Order not found" });
  res.json({ deleted: true });
});

export default router;
export { getOrderWithItems, round2 };
