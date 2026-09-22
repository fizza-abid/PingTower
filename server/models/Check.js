const mongoose = require("mongoose");
const config = require("../config/env");

const checkSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
    // 0 is the sentinel for "no HTTP response was received at all".
    statusCode: { type: Number, default: 0, min: 0 },
    // Time to first byte of the final response, in ms.
    responseTime: { type: Number, required: true, min: 0 },
    isUp: { type: Boolean, required: true },
    // Short, stable classification (timeout, dns_error, connection_refused,
    // tls_error, blocked_target, too_many_redirects, ...) — safe to group by.
    error: { type: String, default: null, maxlength: 64 },
    // Human-readable detail, capped so a hostile target cannot store megabytes.
    errorDetail: { type: String, default: null, maxlength: 300 },
    finalUrl: { type: String, default: null, maxlength: 2048 },
    hops: { type: Number, default: 0, min: 0 },
    checkedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: false,
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Every dashboard query is "latest N checks for one project".
checkSchema.index({ projectId: 1, checkedAt: -1 });

// Retention: at a 5-minute interval each monitor writes ~288 documents/day, so
// without a TTL this collection grows without bound. Change CHECK_RETENTION_DAYS
// and drop the old index (`db.checks.dropIndex("checkedAt_1")`) before restarting,
// otherwise MongoDB rejects the conflicting index definition.
checkSchema.index(
  { checkedAt: 1 },
  { expireAfterSeconds: config.checkRetentionDays * 24 * 60 * 60, background: true }
);

module.exports = mongoose.model("Check", checkSchema);
