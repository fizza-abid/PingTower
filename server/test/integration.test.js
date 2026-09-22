const test = require("node:test");
const assert = require("node:assert/strict");

// Keep the default test command independent of MongoDB. CI opts in explicitly
// with RUN_INTEGRATION=1 and provides a Mongo service container.
if (process.env.RUN_INTEGRATION !== "1") {
  test("Mongo integration suite (set RUN_INTEGRATION=1 to run)", { skip: true }, () => {});
} else {
  const http = require("http");
  const mongoose = require("mongoose");
  const config = require("../config/env");
  const Project = require("../models/Project");
  const Check = require("../models/Check");
  const { createApp } = require("../server");

  let targetServer;
  let apiServer;
  let targetIsUp = true;
  let base;
  let targetUrl;

  function listen(server) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve(server.address().port);
      });
    });
  }

  async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }

  test.before(async () => {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 10_000,
      dbName: "pingtower-ci",
    });
    await Check.deleteMany({});
    await Project.deleteMany({});

    targetServer = http.createServer((_req, res) => {
      if (!targetIsUp) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("simulated outage");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    const targetPort = await listen(targetServer);
    targetUrl = `http://127.0.0.1:${targetPort}/health`;

    apiServer = createApp().listen(0);
    await new Promise((resolve, reject) => {
      apiServer.once("listening", resolve);
      apiServer.once("error", reject);
    });
    base = `http://127.0.0.1:${apiServer.address().port}`;
  });

  test.after(async () => {
    await Check.deleteMany({});
    await Project.deleteMany({});
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => targetServer.close(resolve));
    await mongoose.disconnect();
  });

  test("Mongo-backed project lifecycle, checks, alerts, and cron auth", async () => {
    const health = await request("/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.database, "connected");

    const created = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "CI monitor",
        url: targetUrl,
        alertEmail: "owner@example.com",
        // These fields must be ignored by the route whitelist.
        status: "paused",
        isUp: false,
        consecutiveFails: 99,
        alertSent: true,
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "active");
    assert.equal(created.body.isUp, null);
    assert.equal(created.body.consecutiveFails, 0);
    assert.equal(created.body.alertSent, false);
    const id = created.body._id;

    let list = await request("/api/projects");
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].checksInWindow, 0);
    assert.equal(list.body[0].uptimePercent, null);

    const paused = await request(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
    });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, "paused");

    const resumed = await request(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.status, "active");

    const goodCheck = await request(`/api/projects/${id}/check`, { method: "POST" });
    assert.equal(goodCheck.status, 200);
    assert.equal(goodCheck.body.check.isUp, true);
    assert.equal(goodCheck.body.project.isUp, true);
    assert.equal(goodCheck.body.project.checksInWindow, 1);

    targetIsUp = false;
    for (let attempt = 0; attempt < config.failThreshold; attempt += 1) {
      const failedCheck = await request(`/api/projects/${id}/check`, { method: "POST" });
      assert.equal(failedCheck.status, 200);
      assert.equal(failedCheck.body.check.isUp, false);
    }

    const down = await Project.findById(id).lean();
    assert.equal(down.isUp, false);
    assert.equal(down.consecutiveFails, config.failThreshold);
    assert.equal(down.alertSent, true);

    targetIsUp = true;
    const recovery = await request(`/api/projects/${id}/check`, { method: "POST" });
    assert.equal(recovery.status, 200);
    assert.equal(recovery.body.check.isUp, true);
    assert.equal(recovery.body.project.isUp, true);
    assert.equal(recovery.body.project.checksInWindow, config.failThreshold + 2);

    const recovered = await Project.findById(id).lean();
    assert.equal(recovered.alertSent, false);
    assert.equal(recovered.consecutiveFails, 0);

    const noSecret = await request("/api/internal/run-checks", { method: "POST" });
    assert.equal(noSecret.status, 401);
    const validSecret = await request("/api/internal/run-checks", {
      method: "POST",
      headers: { "x-cron-secret": config.cronSecret },
    });
    assert.equal(validSecret.status, 200);
    assert.equal(validSecret.body.checked, 1);

    const deleted = await request(`/api/projects/${id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.equal(await Project.countDocuments({ _id: id }), 0);
    assert.equal(await Check.countDocuments({ projectId: id }), 0);

    const missing = await request(`/api/projects/${id}`);
    assert.equal(missing.status, 404);
  });
}
