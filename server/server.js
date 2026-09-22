require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const connectDB = require("./config/db");
const projectsRouter = require("./routes/projects");
const { runChecks } = require("./services/monitor");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use("/api/projects", projectsRouter);

app.post("/api/internal/run-checks", async (req, res) => {
  if (req.header("x-cron-secret") !== process.env.CRON_SECRET) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const results = await runChecks();
  res.json({ checked: results.length, results });
});

connectDB().then(() => {
  if (process.env.ENABLE_LOCAL_CRON === "true") {
    cron.schedule("*/5 * * * *", () => runChecks().catch(console.error));
  }
  app.listen(process.env.PORT || 5000, () => {
    console.log(`Server running on ${process.env.PORT || 5000}`);
  });
});
