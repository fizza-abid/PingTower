// Verifies the enriched list endpoint shape after the dashboard slice.
require("dotenv").config({ override: false });
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

async function main() {
  const mem = await MongoMemoryServer.create();
  process.env.MONGO_URI = mem.getUri();
  process.env.PORT = "5052";
  process.env.CRON_SECRET = process.env.CRON_SECRET || "smoke-secret-0123456789-0123456789-0123456789";
  process.env.ENABLE_LOCAL_CRON = "false";
  await mongoose.disconnect();
  require("../server.js");
  await new Promise((r) => setTimeout(r, 800));

  const base = `http://127.0.0.1:${process.env.PORT}`;
  async function req(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }

  // Create one project, then a series of checks with mixed success/failure.
  const create = await req("POST", "/api/projects", {
    name: "Example",
    url: "https://example.com",
    alertEmail: "you@email.com",
  });
  const id = create.body._id;

  // 5 good checks
  for (let i = 0; i < 5; i++) await req("POST", `/api/projects/${id}/check`);

  // Insert one synthetic failing check directly via mongoose to exercise the
  // "down" segment rendering without depending on real network failure.
  const Check = require("../models/Check");
  await Check.create({
    projectId: id,
    statusCode: 0,
    responseTime: 123,
    isUp: false,
    error: "ECONNREFUSED",
    checkedAt: new Date(),
  });

  const list = await req("GET", "/api/projects");
  const p = list.body[0];

  const summary = {
    status: list.status,
    listLen: list.body.length,
    keys: Object.keys(p).sort(),
    uptimePercent: p.uptimePercent,
    avgResponseTime: p.avgResponseTime,
    recentChecksLen: p.recentChecks.length,
    recentChecksAreAscending: p.recentChecks.every((c, i, arr) =>
      i === 0 ? true : new Date(c.checkedAt) >= new Date(arr[i - 1].checkedAt)
    ),
    hasDownSegment: p.recentChecks.some((c) => !c.isUp),
  };
  console.log("=== ENRICHED LIST ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("=== END ===");

  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mem.stop();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
