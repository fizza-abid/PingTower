const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:27017/pingtower-test";
process.env.CRON_SECRET = "test-secret-".repeat(8);
process.env.MAIL_ENABLED = "false";

const { createMailer } = require("../services/mailer");
const {
  createNotifier,
  buildDownMessage,
  buildRecoveryMessage,
} = require("../services/notifier");

const project = {
  name: "Checkout <production>",
  url: "https://example.com/checkout?a=1&b=2",
  alertEmail: "owner@example.com",
};

test("SMTP configuration accepts a display-name sender", () => {
  const child = spawnSync(process.execPath, ["-e", "console.log(require('./config/env').mailFrom)"], {
    cwd: require("node:path").join(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      MONGO_URI: "mongodb://127.0.0.1:27017/pingtower-test",
      CRON_SECRET: "test-secret-".repeat(8),
      MAIL_ENABLED: "true",
      SMTP_HOST: "smtp.test",
      SMTP_USER: "smtp-user@example.com",
      SMTP_PASSWORD: "not-real",
      MAIL_FROM: "PingTower <alerts@example.com>",
    },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /PingTower <alerts@example.com>/);
});

const context = {
  now: new Date("2026-09-22T12:00:00.000Z"),
  result: {
    statusCode: 0,
    responseTime: 10023,
    error: "timeout",
    errorDetail: "target <did not respond>",
  },
  consecutiveFails: 3,
  failThreshold: 3,
};

test("disabled mailer never opens SMTP and reports an intentional skip", async () => {
  const mailer = createMailer({
    settings: { mailEnabled: false },
    transportFactory: () => {
      throw new Error("SMTP transport should not be created when disabled");
    },
  });

  assert.equal(mailer.enabled, false);
  assert.deepEqual(await mailer.send({ to: "owner@example.com" }), {
    skipped: true,
    reason: "MAIL_ENABLED=false",
  });
});

test("enabled mailer passes SMTP settings and message to Nodemailer", async () => {
  let transportOptions;
  const sent = [];
  const mailer = createMailer({
    settings: {
      mailEnabled: true,
      smtpHost: "smtp.test",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: "smtp-user",
      smtpPassword: "smtp-password",
      mailFrom: "PingTower <alerts@example.com>",
      mailConnectionTimeoutMs: 1000,
      mailGreetingTimeoutMs: 1000,
      mailSocketTimeoutMs: 1000,
    },
    transportFactory: (options) => {
      transportOptions = options;
      return {
        async sendMail(message) {
          sent.push(message);
          return { messageId: "test-message-id" };
        },
      };
    },
  });

  const response = await mailer.send({
    to: "owner@example.com",
    subject: "Test alert",
    text: "It is down",
    html: "<p>It is down</p>",
  });

  assert.equal(mailer.enabled, true);
  assert.equal(transportOptions.host, "smtp.test");
  assert.equal(transportOptions.auth.user, "smtp-user");
  assert.equal(transportOptions.auth.pass, "smtp-password");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, "PingTower <alerts@example.com>");
  assert.equal(response.messageId, "test-message-id");
});

test("notifier builds escaped down and recovery messages", async () => {
  const down = buildDownMessage(project, context);
  assert.equal(down.to, project.alertEmail);
  assert.match(down.subject, /^PingTower alert:/);
  assert.equal(down.subject.includes("\n"), false);
  assert.match(down.text, /Consecutive failures: 3\/3/);
  assert.match(down.html, /Checkout &lt;production&gt;/);
  assert.match(down.html, /target &lt;did not respond&gt;/);
  assert.equal(down.html.includes("<production>"), false);

  const recovery = buildRecoveryMessage(project, {
    now: context.now,
    result: { statusCode: 200, responseTime: 83 },
    outageDurationMs: 125000,
  });
  assert.match(recovery.subject, /^PingTower recovery:/);
  assert.match(recovery.text, /Downtime: 125 seconds/);
  assert.match(recovery.html, /HTTP 200/);
});

test("notifier reports transport failures without throwing into monitoring", async () => {
  const errors = [];
  const notifier = createNotifier({
    mailer: {
      async send() {
        throw new Error("SMTP unavailable");
      },
    },
    logger: {
      warn() {},
      info() {},
      error(message) {
        errors.push(message);
      },
    },
  });

  assert.equal(await notifier.notifyDown(project, context), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /SMTP unavailable/);
});
