const mongoose = require("mongoose");

const URL_PATTERN = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    url: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2048,
      validate: {
        validator: (value) => URL_PATTERN.test(value),
        message: "url must be a valid http:// or https:// URL",
      },
    },
    alertEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      validate: {
        validator: (value) => EMAIL_PATTERN.test(value),
        message: "alertEmail must be a valid email address",
      },
    },
    status: { type: String, enum: ["active", "paused"], default: "active", index: true },

    // null means "never checked yet" — a brand new monitor must not present
    // itself as healthy before it has any evidence.
    isUp: { type: Boolean, default: null },

    lastCheckedAt: { type: Date, default: null },
    consecutiveFails: { type: Number, default: 0, min: 0 },

    // Alert dedupe: set when a down-alert has been delivered for the current
    // outage, cleared on recovery, so one outage never alerts repeatedly.
    alertSent: { type: Boolean, default: false },
    lastAlertAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

projectSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Project", projectSchema);
