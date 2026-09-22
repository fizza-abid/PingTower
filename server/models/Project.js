const mongoose = require("mongoose");

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    alertEmail: { type: String, required: true, trim: true },
    status: { type: String, enum: ["active", "paused"], default: "active" },
    isUp: { type: Boolean, default: true },
    lastCheckedAt: Date,
    consecutiveFails: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Project", projectSchema);
