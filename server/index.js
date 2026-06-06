import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import "./db.js"; // initialize schema + defaults
import setsRouter from "./routes/sets.js";
import ordersRouter from "./routes/orders.js";
import settingsRouter from "./routes/settings.js";
import estimateRouter from "./routes/estimate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use("/api/sets", setsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/settings", settingsRouter);
app.use("/api", estimateRouter); // /api/sets/:id/summary, /api/estimate/:setId

app.use(express.static(join(__dirname, "..", "public")));

// Fallback JSON 404 for unknown API routes.
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Internal error" });
});

app.listen(PORT, () => {
  console.log(`Pokémon Pack Tracker running at http://localhost:${PORT}`);
});
