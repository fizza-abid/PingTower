const Project = require("../models/Project");
const Check = require("../models/Check");
const config = require("../config/env");
const { checkWebsite } = require("./checker");
const { nextProjectState } = require("./alertState");
const notifier = require("./notifier");

// Overlap guard: with a 5-minute schedule and slow targets, a run can outlive its
// interval. Stacking runs would duplicate checks and corrupt the fail counters.
let running = false;
const projectLocks = new Map();

// The scheduler and "Check now" can target the same project concurrently. This
// small process-local lock serializes those operations so a manual result cannot
// overwrite a scheduler result in the same Node process. Mongo's atomic update
// below still makes each individual state write safe; a multi-replica deployment
// should additionally use a distributed job lock.
async function withProjectLock(projectId, worker) {
  const key = String(projectId);
  const previous = projectLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  projectLocks.set(key, queued);

  await previous;
  try {
    return await worker();
  } finally {
    release();
    if (projectLocks.get(key) === queued) projectLocks.delete(key);
  }
}

// Runs `worker` over `items` with at most `limit` in flight. Isolated per item:
// a throw in one worker never cancels the others, so one broken row cannot abort
// an entire monitoring pass.
async function mapWithConcurrency(items, limit, worker) {
  const outcomes = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        outcomes[index] = { ok: true, value: await worker(items[index], index) };
      } catch (err) {
        outcomes[index] = { ok: false, error: err };
      }
    }
  });

  await Promise.all(runners);
  return outcomes;
}

// Performs and records a single check, then applies the health state machine and
// delivers at most one notification. Shared by the scheduler and the manual
// "Check now" endpoint so both paths behave identically.
async function performProjectCheck(project, { now = new Date() } = {}) {
  // checkWebsite never throws — every failure mode comes back as a result.
  const result = await checkWebsite(project.url);

  await Check.create({
    projectId: project._id,
    statusCode: result.statusCode,
    responseTime: result.responseTime,
    isUp: result.isUp,
    error: result.error,
    errorDetail: result.errorDetail || null,
    finalUrl: result.finalUrl || null,
    hops: result.hops || 0,
    checkedAt: now,
  });

  const { next, shouldAlert, recovered } = nextProjectState(project, result, {
    failThreshold: config.failThreshold,
    now,
  });

  // One atomic write of a fully computed state, instead of read-modify-write on a
  // hydrated document (which would clobber concurrent manual checks).
  const updated =
    (await Project.findOneAndUpdate({ _id: project._id }, { $set: next }, { new: true })) ||
    project;

  if (shouldAlert) {
    const delivered = await notifier.notifyDown(updated, {
      result,
      now,
      consecutiveFails: next.consecutiveFails,
      failThreshold: config.failThreshold,
    });

    // Do not permanently consume the alert edge when SMTP failed. The next
    // check can retry delivery while the outage is still active. Disabled mail
    // is treated as an intentional log-only mode by the notifier.
    if (!delivered && config.mailEnabled) {
      await Project.updateOne(
        { _id: project._id },
        { $set: { alertSent: false, lastAlertAt: null } }
      );
    }
  } else if (recovered) {
    const since = project.lastAlertAt ? now.getTime() - new Date(project.lastAlertAt).getTime() : null;
    await notifier.notifyRecovery(updated, { result, now, outageDurationMs: since });
  }

  return { projectId: project._id, ...result };
}

async function checkProject(project, options) {
  return withProjectLock(project._id, async () => {
    // Refresh after waiting for a prior same-process check so state transitions
    // are based on the latest counters, not the caller's stale snapshot.
    const latest = await Project.findById(project._id).lean();
    return performProjectCheck(latest || project, options);
  });
}

async function runChecks() {
  if (running) {
    console.warn("[monitor] previous run still in progress; skipping this tick");
    return { skipped: true, checked: 0, results: [], errors: [] };
  }

  running = true;
  const startedAt = Date.now();
  try {
    const projects = await Project.find({ status: "active" }).lean();
    const now = new Date();

    const outcomes = await mapWithConcurrency(projects, config.checkConcurrency, (project) =>
      checkProject(project, { now })
    );

    const results = [];
    const errors = [];
    outcomes.forEach((outcome, index) => {
      if (outcome.ok) results.push(outcome.value);
      else {
        errors.push({
          projectId: projects[index]._id,
          error: outcome.error && outcome.error.message,
        });
        console.error(
          `[monitor] check failed for ${projects[index].name} (${projects[index]._id}):`,
          outcome.error
        );
      }
    });

    console.log(
      `[monitor] ${results.length}/${projects.length} checks recorded in ${Date.now() - startedAt}ms` +
        (errors.length ? ` (${errors.length} failed)` : "")
    );

    return { skipped: false, checked: results.length, results, errors };
  } finally {
    running = false;
  }
}

function isRunning() {
  return running;
}

module.exports = { runChecks, checkProject, mapWithConcurrency, isRunning };
