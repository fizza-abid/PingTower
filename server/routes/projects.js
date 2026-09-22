const express = require("express");
const Project = require("../models/Project");
const Check = require("../models/Check");
const { checkWebsite, assertPublicUrl } = require("../services/checker");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    if (req.body && req.body.url) {
      await assertPublicUrl(req.body.url);
    }
    const project = await Project.create(req.body);
    res.status(201).json(project);
  } catch (err) {
    res.status(400).json({ message: err.message || "Invalid project" });
  }
});

router.get("/", async (req, res) => {
  const projects = await Project.find().sort({ createdAt: -1 }).lean();

  const withStats = await Promise.all(
    projects.map(async (project) => {
      const checks = await Check.find({ projectId: project._id })
        .sort({ checkedAt: -1 })
        .limit(48)
        .lean();

      const upChecks = checks.filter((check) => check.isUp);
      const avg = upChecks.length
        ? Math.round(
            upChecks.reduce((sum, check) => sum + check.responseTime, 0) /
              upChecks.length
          )
        : null;

      return {
        ...project,
        uptimePercent: checks.length
          ? Number(((upChecks.length / checks.length) * 100).toFixed(1))
          : null,
        avgResponseTime: avg,
        recentChecks: [...checks].reverse(),
      };
    })
  );

  res.json(withStats);
});

router.post("/:id/check", async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ message: "Project not found" });

  const result = await checkWebsite(project.url);
  const check = await Check.create({
    projectId: project._id,
    ...result,
    checkedAt: new Date(),
  });

  project.isUp = result.isUp;
  project.lastCheckedAt = new Date();
  project.consecutiveFails = result.isUp ? 0 : project.consecutiveFails + 1;
  await project.save();

  res.json({ project, check });
});

module.exports = router;
