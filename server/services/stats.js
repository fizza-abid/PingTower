const mongoose = require("mongoose");
const Check = require("../models/Check");

// Number of recent checks behind the uptime bar (48 x 5 minutes = 4 hours).
const RECENT_WINDOW = 48;

function summarizeChecks(checks) {
  const visibleChecks = checks.map(({ __v, ...check }) => check);
  const upChecks = visibleChecks.filter((check) => check.isUp);

  // Average over successful checks only: failures (timeouts, refused
  // connections) carry meaningless latency and would skew the number.
  const avgResponseTime = upChecks.length
    ? Math.round(
        upChecks.reduce((sum, check) => sum + check.responseTime, 0) / upChecks.length
      )
    : null;

  return {
    uptimePercent: visibleChecks.length
      ? Number(((upChecks.length / visibleChecks.length) * 100).toFixed(1))
      : null,
    avgResponseTime,
    checksInWindow: visibleChecks.length,
    // Chronological (oldest -> newest) for left-to-right bar rendering.
    recentChecks: [...visibleChecks].reverse(),
  };
}

async function fetchStats(projectIds) {
  if (!projectIds.length) return new Map();

  const objectIds = projectIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id)
  );

  // Sort before grouping so each group's first 48 records are the newest. This
  // replaces the old per-project N+1 query pattern with one indexed aggregation.
  const rows = await Check.aggregate([
    { $match: { projectId: { $in: objectIds } } },
    { $sort: { checkedAt: -1 } },
    { $group: { _id: "$projectId", checks: { $push: "$$ROOT" } } },
    { $project: { checks: { $slice: ["$checks", RECENT_WINDOW] } } },
  ]);

  return new Map(rows.map((row) => [String(row._id), summarizeChecks(row.checks)]));
}

async function statsFor(projectId) {
  const stats = await fetchStats([projectId]);
  return stats.get(String(projectId)) || summarizeChecks([]);
}

async function attachStats(projects) {
  const stats = await fetchStats(projects.map((project) => project._id));
  return projects.map((project) => ({
    ...project,
    ...(stats.get(String(project._id)) || summarizeChecks([])),
  }));
}

module.exports = { attachStats, statsFor, summarizeChecks, RECENT_WINDOW };
