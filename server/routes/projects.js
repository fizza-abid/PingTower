const express = require("express");
const mongoose = require("mongoose");
const { rateLimit } = require("express-rate-limit");

const Project = require("../models/Project");
const Check = require("../models/Check");
const config = require("../config/env");
const { assertPublicUrl } = require("../services/checker");
const { checkProject } = require("../services/monitor");
const { attachStats } = require("../services/stats");
const { asyncHandler, NotFoundError, ValidationError } = require("../utils/errors");

const router = express.Router();

// Only these fields may be supplied by a client. Without a whitelist,
// Project.create(req.body) let callers set isUp, status, consecutiveFails or
// even _id directly.
const CREATABLE_FIELDS = ["name", "url", "alertEmail"];
const UPDATABLE_FIELDS = ["name", "url", "alertEmail", "status"];
const STATUSES = ["active", "paused"];

function pick(body, fields) {
  const out = {};
  for (const field of fields) {
    if (body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

function requireObjectBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return body;
}

function parseId(raw) {
  if (!mongoose.isValidObjectId(raw)) {
    throw new ValidationError(`Invalid project id: "${String(raw).slice(0, 64)}"`);
  }
  return raw;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// "Check now" makes the server issue an outbound request, so it is the one
// endpoint worth throttling per client.
const checkLimiter = rateLimit({
  windowMs: config.checkRateLimitWindowMs,
  limit: config.checkRateLimitMax,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    message: "Too many on-demand checks, please wait a moment",
    code: "rate_limited",
  },
});

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const skip = clampInt(req.query.skip, 0, 0, 1_000_000);

    const projects = await Project.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json(await attachStats(projects));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const payload = pick(requireObjectBody(req.body), CREATABLE_FIELDS);

    // Validated unconditionally — the old code skipped the SSRF check whenever
    // `url` was absent and fell through to a confusing Mongoose error.
    if (typeof payload.url !== "string" || !payload.url.trim()) {
      throw new ValidationError("url is required");
    }

    // Store the normalized URL that actually passed validation.
    payload.url = await assertPublicUrl(payload.url);

    const project = await Project.create(payload);
    res.status(201).json(project);
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const project = await Project.findById(parseId(req.params.id)).lean();
    if (!project) throw new NotFoundError("Project not found");
    res.json((await attachStats([project]))[0]);
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const payload = pick(requireObjectBody(req.body), UPDATABLE_FIELDS);
    if (!Object.keys(payload).length) {
      throw new ValidationError(`No updatable fields provided (allowed: ${UPDATABLE_FIELDS.join(", ")})`);
    }
    if (payload.status !== undefined && !STATUSES.includes(payload.status)) {
      throw new ValidationError(`status must be one of: ${STATUSES.join(", ")}`);
    }
    if (payload.url !== undefined) {
      if (typeof payload.url !== "string" || !payload.url.trim()) {
        throw new ValidationError("url must be a non-empty string");
      }
      payload.url = await assertPublicUrl(payload.url);
    }

    const project = await Project.findById(parseId(req.params.id));
    if (!project) throw new NotFoundError("Project not found");

    const urlChanged = payload.url !== undefined && payload.url !== project.url;
    Object.assign(project, payload);

    if (urlChanged) {
      // The existing health state and history describe a different target.
      project.isUp = null;
      project.consecutiveFails = 0;
      project.alertSent = false;
      project.lastAlertAt = null;
    }

    await project.save(); // runs schema validators
    if (urlChanged) {
      // A history entry for the old target should not affect the new target's
      // uptime percentage or response-time average.
      await Check.deleteMany({ projectId: project._id });
    }
    res.json(project);
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const project = await Project.findByIdAndDelete(parseId(req.params.id));
    if (!project) throw new NotFoundError("Project not found");

    const { deletedCount } = await Check.deleteMany({ projectId: project._id });
    res.json({ deleted: true, projectId: project._id, checksRemoved: deletedCount || 0 });
  })
);

router.post(
  "/:id/check",
  checkLimiter,
  asyncHandler(async (req, res) => {
    const project = await Project.findById(parseId(req.params.id)).lean();
    if (!project) throw new NotFoundError("Project not found");

    const check = await checkProject(project);

    const fresh = await Project.findById(project._id).lean();
    res.json({ project: fresh ? (await attachStats([fresh]))[0] : null, check });
  })
);

module.exports = router;
