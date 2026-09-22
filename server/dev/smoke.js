// Smoke test: boots an in-memory MongoDB, loads the real server, and exercises
// every endpoint from the README. This file is for verification only and is not
// used in production. To run real server, use `npm run dev` or `npm start`
// with a real MONGO_URI.
require("dotenv").config({ override: false });
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

async function main() {
  const mem = await MongoMemoryServer.create();
  process.env.MONGO_URI = mem.getUri();
  // Force a unique port so smoke runs don't clash with `npm run dev`.
  process.env.PORT = "5051";
  process.env.CRON_SECRET = process.env.CRON_SECRET || "smoke-secret-0123456789-0123456789-0123456789";
  process.env.ENABLE_LOCAL_CRON = "false";

  // Reset cached connection if any from a previous run.
  await mongoose.disconnect();

  require("../server.js");
  // server.js calls connectDB().then(...) and then app.listen — wait briefly.
  await new Promise((r) => setTimeout(r, 800));

  const base = `http://127.0.0.1:${process.env.PORT}`;

  async function request(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }

  const results = {};

  // 1. Health
  results.health = await request("GET", "/api/health");

  // 2. Reject wrong cron secret
  results.badCron = await request("POST", "/api/internal/run-checks", {}, { "x-cron-secret": "wrong" });

  // 3. Create project
  const create = await request("POST", "/api/projects", {
    name: "Example",
    url: "https://example.com",
    alertEmail: "you@email.com",
  });
  results.create = create;
  const id = create.body && create.body._id;

  // 4. Immediate check on that project
  results.check = await request("POST", `/api/projects/${id}/check`);

  // 5. Run all checks the way GitHub Actions will later
  results.runChecks = await request(
    "POST",
    "/api/internal/run-checks",
    {},
    { "x-cron-secret": process.env.CRON_SECRET }
  );

  // 6. List projects
  results.list = await request("GET", "/api/projects");

  // 7. Private-IP guard
  results.privateIp = await request("POST", "/api/projects", {
    name: "Bad",
    url: "http://127.0.0.1/",
    alertEmail: "you@email.com",
  });
  results.privateHost = await request("POST", "/api/projects", {
    name: "Bad",
    url: "http://localhost:5000",
    alertEmail: "you@email.com",
  });

  // Shut down
  console.log("=== SMOKE RESULTS ===");
  console.log(JSON.stringify(results, null, 2));
  console.log("=== END SMOKE RESULTS ===");
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mem.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("SMOKE_FAIL", err);
  process.exit(1);
});
