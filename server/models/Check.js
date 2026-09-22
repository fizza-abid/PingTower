const mongoose = require("mongoose");

const checkSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
  statusCode: { type: Number, default: 0 },
  responseTime: { type: Number, required: true },
  isUp: { type: Boolean, required: true },
  error: { type: String, default: null },
  checkedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Check", checkSchema);
