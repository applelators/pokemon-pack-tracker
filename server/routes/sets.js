import { Router } from "express";
import { searchSets, importSet, getCachedSet, listCachedSets } from "../services/pokemontcg.js";

const router = Router();

// Locally cached/imported sets (the ones the user is tracking).
router.get("/", (req, res) => {
  res.json(listCachedSets());
});

// Live search against pokemontcg.io.
router.get("/search", async (req, res) => {
  try {
    res.json(await searchSets(req.query.q));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get("/:id", (req, res) => {
  const set = getCachedSet(req.params.id);
  if (!set) return res.status(404).json({ error: "Set not imported" });
  res.json(set);
});

// Import (fetch + cache) a set and its base-set rarity breakdown.
router.post("/:id/import", async (req, res) => {
  try {
    res.json(await importSet(req.params.id));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
