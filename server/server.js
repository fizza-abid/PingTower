// Requires and validates configuration first: config/env.js exits with an
// actionable message if a required value is missing, so nothing below can run in
// a half-configured (or fail-open) state.
const config = require("./config/env");

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cron = require("node-cron");
const mongoose = require("mongoose");

const connectDB = require("./config/db");
const projectsRouter = require("./routes/projects");
const { runChecks } = require("./services/monitor");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const { UnauthorizedError, asyncHandler } = require("./utils/errors");

// Fail closed: without a configured secret the endpoint is unreachable, and the
// comparison is constant-time. The previous `header !== process.env.CRON_SECRET`
// check passed when both sides were undefined, i.e. whenever the env var was
// missing the endpoint was open to anyone.
function requireCronSecret(req, res, next) {
  const expected = config.cronSecret;
  const provided = req.header("x-cron-secret");

  if (!expected) return next(new UnauthorizedError("Cron secret is not configured"));
  if (!provided) return next(new UnauthorizedError("Missing x-cron-secret header"));

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  const ok =
    providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf);

  return ok ? next() : next(new UnauthorizedError("Invalid x-cron-secret"));
}

function createApp() {
  const app = express();

  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    });
  });

  app.use("/api/projects", projectsRouter);

  // Driven by an external scheduler (cron job / CI schedule) so monitoring does
  // not depend on this process staying alive.
  app.post(
    "/api/internal/run-checks",
    requireCronSecret,
    asyncHandler(async (req, res) => {
      const started = Date.now();
      const outcome = await runChecks();
      res.json({ ...outcome, durationMs: Date.now() - started });
    })
  );

  // JSON for unknown paths, then the single error translator. Without these,
  // Express' default HTML error page was returned and the client blew up trying
  // to JSON.parse it.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

async function start() {
  if (config.enableLocalCron && !cron.validate(config.checkCron)) {
    throw new Error(`CHECK_CRON is not a valid cron expression: "${config.checkCron}"`);
  }

  await connectDB();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[server] listening on :${config.port} (${config.nodeEnv})`);
  });

  let task = null;
  if (config.enableLocalCron) {
    task = cron.schedule(config.checkCron, () => {
      runChecks().catch((err) => console.error("[cron] run failed:", err));
    });
    console.log(`[cron] local scheduler enabled: ${config.checkCron}`);
  }

  const shutdown = async (signal) => {
    console.log(`[server] ${signal} received, shutting down`);
    if (task) task.stop();
    server.close(async () => {
      try {
        await mongoose.disconnect();
      } finally {
        process.exit(0);
      }
    });
    // Don't hang forever on stuck connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    console.error("[server] unhandled rejection:", reason);
  });

  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error("[server] failed to start:", err.message);
    process.exit(1);
  });
}

module.exports = { createApp, start, requireCronSecret };
