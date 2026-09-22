// Central, validated configuration. Required values are checked once at boot so
// the process fails fast with an actionable message instead of crashing deep
// inside a request handler (or, worse, silently running in an unsafe state).
require("dotenv").config();

const crypto = require("crypto");

const INSECURE_CRON_SECRETS = new Set([
  "",
  "change-this-to-a-long-random-string",
  "secret",
  "changeme",
]);

function fail(message) {
  console.error(`[config] ${message}`);
  console.error("[config] Copy server/.env.example to server/.env, fill in the values, then restart.");
  process.exit(1);
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    fail(`${name} must be an integer between ${min} and ${max}, got "${raw}".`);
  }
  return value;
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw.trim();
}

const nodeEnv = str("NODE_ENV", "development");
const isProduction = nodeEnv === "production";

const mongoUri = str("MONGO_URI", "");
if (!mongoUri) {
  fail("MONGO_URI is required but was not set.");
}
if (!/^mongodb(\+srv)?:\/\//.test(mongoUri)) {
  fail(`MONGO_URI must start with mongodb:// or mongodb+srv:// (got "${mongoUri.slice(0, 24)}...").`);
}

// Fail closed: the internal cron endpoint must never be reachable without a
// secret. In development an ephemeral one is minted so the app still boots, but
// the header check stays mandatory either way.
let cronSecret = str("CRON_SECRET", "");
if (isProduction) {
  if (INSECURE_CRON_SECRETS.has(cronSecret.toLowerCase()) || cronSecret.length < 32) {
    fail(
      "CRON_SECRET is required in production and must be at least 32 characters " +
        "(generate one with: openssl rand -hex 32)."
    );
  }
} else if (INSECURE_CRON_SECRETS.has(cronSecret.toLowerCase())) {
  cronSecret = crypto.randomBytes(32).toString("hex");
  console.warn(
    "[config] CRON_SECRET is missing or still the example value; generated an ephemeral secret " +
      "for this process. Set CRON_SECRET in server/.env to make it stable across restarts."
  );
}

// Comma-separated allowlist. "*" (the default) permits any origin, which is fine
// for local development but should be pinned down before deploying.
const corsOriginRaw = str("CORS_ORIGIN", "*");
if (isProduction && corsOriginRaw === "*") {
  console.warn("[config] CORS_ORIGIN is '*' in production; set it to your dashboard origin.");
}

const allowPrivateTargets = bool("ALLOW_PRIVATE_TARGETS", false);
if (allowPrivateTargets) {
  console.warn(
    "[config] ALLOW_PRIVATE_TARGETS=true — the SSRF guard will permit loopback/private targets. " +
      "Development only; never enable this on a publicly reachable server."
  );
}

// Email delivery is opt-in so existing development environments do not need
// SMTP credentials just to boot. Once MAIL_ENABLED=true, all required transport
// settings are validated here rather than failing during the first alert.
const mailEnabled = bool("MAIL_ENABLED", false);
const smtpHost = str("SMTP_HOST", "");
const smtpPort = int("SMTP_PORT", 587, { min: 1, max: 65535 });
const smtpSecure = bool("SMTP_SECURE", smtpPort === 465);
const smtpUser = str("SMTP_USER", "");
const smtpPassword = process.env.SMTP_PASSWORD || "";
const mailFrom = str("MAIL_FROM", smtpUser);

if (mailEnabled) {
  if (!smtpHost) fail("SMTP_HOST is required when MAIL_ENABLED=true.");
  if (!mailFrom || !mailFrom.includes("@") || /[\r\n]/.test(mailFrom)) {
    fail("MAIL_FROM must be a valid sender address when MAIL_ENABLED=true.");
  }
  if ((smtpUser && !smtpPassword) || (!smtpUser && smtpPassword)) {
    fail("SMTP_USER and SMTP_PASSWORD must be provided together.");
  }
} else if (isProduction) {
  console.warn("[config] MAIL_ENABLED=false — monitor alerts will be logged but no emails will be sent.");
}

module.exports = Object.freeze({
  nodeEnv,
  isProduction,
  port: int("PORT", 5000, { min: 1, max: 65535 }),
  mongoUri,
  cronSecret,
  corsOrigin:
    corsOriginRaw === "*"
      ? "*"
      : corsOriginRaw.split(",").map((origin) => origin.trim()).filter(Boolean),

  // Set to true only when running behind a reverse proxy you control, so
  // req.ip (and therefore rate limiting) reflects the real client.
  trustProxy: bool("TRUST_PROXY", false),

  // Monitoring behaviour
  enableLocalCron: bool("ENABLE_LOCAL_CRON", false),
  checkCron: str("CHECK_CRON", "*/5 * * * *"),
  checkTimeoutMs: int("CHECK_TIMEOUT_MS", 10000, { min: 500, max: 120000 }),
  checkConcurrency: int("CHECK_CONCURRENCY", 5, { min: 1, max: 50 }),
  maxRedirects: int("MAX_REDIRECTS", 3, { min: 0, max: 10 }),
  maxResponseBytes: int("MAX_RESPONSE_BYTES", 2 * 1024 * 1024, { min: 1024 }),
  failThreshold: int("FAIL_THRESHOLD", 3, { min: 1, max: 100 }),
  checkRetentionDays: int("CHECK_RETENTION_DAYS", 30, { min: 1, max: 3650 }),
  userAgent: str("CHECK_USER_AGENT", "PingTower/1.0 (+https://github.com/fizza-abid/PingTower)"),

  // SSRF guard escape hatch (development only)
  allowPrivateTargets,

  // SMTP alert delivery
  mailEnabled,
  smtpHost,
  smtpPort,
  smtpSecure,
  smtpUser,
  smtpPassword,
  mailFrom,
  mailConnectionTimeoutMs: int("MAIL_CONNECTION_TIMEOUT_MS", 10000, { min: 1000, max: 120000 }),
  mailGreetingTimeoutMs: int("MAIL_GREETING_TIMEOUT_MS", 10000, { min: 1000, max: 120000 }),
  mailSocketTimeoutMs: int("MAIL_SOCKET_TIMEOUT_MS", 20000, { min: 1000, max: 120000 }),

  // Rate limiting for the on-demand check endpoint
  checkRateLimitWindowMs: int("CHECK_RATE_LIMIT_WINDOW_MS", 60_000, { min: 1000 }),
  checkRateLimitMax: int("CHECK_RATE_LIMIT_MAX", 20, { min: 1 }),
});
