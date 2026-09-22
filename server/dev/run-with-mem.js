// Boots the real server with an in-memory MongoDB on a fixed port.
// Used for the dashboard end-to-end check.
require("dotenv").config({ override: false });
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

async function main() {
  const mem = await MongoMemoryServer.create();
  process.env.MONGO_URI = mem.getUri();
  process.env.PORT = "5000";
  process.env.ENABLE_LOCAL_CRON = "false";
  await mongoose.disconnect();
  const { start } = require("../server.js");
  await start();
}

main().catch((e) => { console.error(e); process.exit(1); });
