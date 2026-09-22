const mongoose = require("mongoose");
const config = require("./env");

// Connects with bounded retries and wires up connection lifecycle logging, so a
// transient database blip at boot doesn't kill the process silently.
async function connectDB({ retries = 5, delayMs = 2000 } = {}) {
  mongoose.connection.on("error", (err) => {
    console.error("[db] connection error:", err.message);
  });
  mongoose.connection.on("disconnected", () => console.warn("[db] disconnected"));
  mongoose.connection.on("reconnected", () => console.log("[db] reconnected"));

  for (let attempt = 1; ; attempt += 1) {
    try {
      await mongoose.connect(config.mongoUri, {
        serverSelectionTimeoutMS: 10_000,
        maxPoolSize: 10,
        autoIndex: true,
      });
      console.log(`[db] MongoDB connected (${mongoose.connection.name})`);
      return mongoose.connection;
    } catch (err) {
      if (attempt > retries) throw err;
      const wait = delayMs * attempt;
      console.warn(
        `[db] attempt ${attempt}/${retries} failed: ${err.message} — retrying in ${wait}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

module.exports = connectDB;
