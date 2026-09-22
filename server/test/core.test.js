const test = require("node:test");
const assert = require("node:assert/strict");

// The production app intentionally requires this before any server module can
// load. Tests use a syntactically valid placeholder URI; no Mongo connection is
// made in this file.
process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:27017/pingtower-test";
process.env.CRON_SECRET = "test-secret-".repeat(8);
process.env.ENABLE_LOCAL_CRON = "false";
process.env.ALLOW_PRIVATE_TARGETS = "false";

const { checkWebsite, assertPublicUrl, isNonPublicIp, isBlockedHostname } = require("../services/checker");
const { nextProjectState } = require("../services/alertState");
const { mapWithConcurrency } = require("../services/monitor");
const { createApp } = require("../server");

function result(isUp) {
  return { isUp, statusCode: isUp ? 200 : 0, responseTime: 10, error: isUp ? null : "timeout" };
}

test("SSRF guard blocks private, reserved, and IPv6 address space", async () => {
  const blocked = [
    "0.0.0.1",
    "10.10.10.10",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ];
  for (const ip of blocked) assert.equal(isNonPublicIp(ip), true, ip);

  assert.equal(isNonPublicIp("8.8.8.8"), false);
  assert.equal(isBlockedHostname("localhost"), true);
  assert.equal(isBlockedHostname("service.internal"), true);
  assert.equal(isBlockedHostname("example.com"), false);

  for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://[fc00::1]/"]) {
    const check = await checkWebsite(url);
    assert.equal(check.isUp, false, url);
    assert.equal(check.error, "blocked_target", url);
  }

  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), {
    code: "SSRF_BLOCKED",
    classification: "invalid_url",
  });
});

test("alert state sends one down alert at the threshold and one recovery", () => {
  let project = {
    isUp: null,
    consecutiveFails: 0,
    alertSent: false,
    lastAlertAt: null,
  };
  const now = new Date("2026-09-22T00:00:00.000Z");

  const first = nextProjectState(project, result(false), { failThreshold: 3, now });
  assert.equal(first.shouldAlert, false);
  assert.equal(first.next.isUp, null);
  project = { ...project, ...first.next };

  const second = nextProjectState(project, result(false), { failThreshold: 3, now });
  assert.equal(second.shouldAlert, false);
  project = { ...project, ...second.next };

  const threshold = nextProjectState(project, result(false), { failThreshold: 3, now });
  assert.equal(threshold.shouldAlert, true);
  assert.equal(threshold.next.isUp, false);
  assert.equal(threshold.next.alertSent, true);
  project = { ...project, ...threshold.next };

  const continued = nextProjectState(project, result(false), { failThreshold: 3, now });
  assert.equal(continued.shouldAlert, false);
  assert.equal(continued.next.consecutiveFails, 4);

  const recovery = nextProjectState(project, result(true), { failThreshold: 3, now });
  assert.equal(recovery.recovered, true);
  assert.equal(recovery.next.isUp, true);
  assert.equal(recovery.next.alertSent, false);
});

test("mapWithConcurrency bounds in-flight work and preserves result order", async () => {
  let active = 0;
  let peak = 0;
  const values = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.equal(peak, 2);
  assert.deepEqual(values.map((entry) => entry.value), [2, 4, 6, 8, 10]);
  assert.ok(values.every((entry) => entry.ok));
});

test("API returns JSON and fails closed for cron authentication", async (t) => {
  const app = createApp();
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const noSecret = await fetch(`${base}/api/internal/run-checks`, { method: "POST" });
  assert.equal(noSecret.status, 401);
  assert.equal(noSecret.headers.get("content-type").includes("application/json"), true);
  assert.equal((await noSecret.json()).code, "unauthorized");

  const wrongSecret = await fetch(`${base}/api/internal/run-checks`, {
    method: "POST",
    headers: { "x-cron-secret": "wrong" },
  });
  assert.equal(wrongSecret.status, 401);

  const missingRoute = await fetch(`${base}/api/does-not-exist`);
  assert.equal(missingRoute.status, 404);
  assert.equal((await missingRoute.json()).code, "not_found");

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});
