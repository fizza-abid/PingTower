const Project = require("../models/Project");
const Check = require("../models/Check");
const { checkWebsite } = require("./checker");

async function runChecks() {
  const projects = await Project.find({ status: "active" });
  const results = [];

  for (const project of projects) {
    const result = await checkWebsite(project.url);

    await Check.create({
      projectId: project._id,
      ...result,
      checkedAt: new Date(),
    });

    if (!result.isUp) {
      project.consecutiveFails += 1;
      if (project.consecutiveFails >= 3 && project.isUp) {
        console.log(`ALERT: ${project.name} is down. Email later: ${project.alertEmail}`);
      }
      project.isUp = false;
    } else {
      if (!project.isUp) {
        console.log(`RECOVERY: ${project.name} is back up`);
      }
      project.isUp = true;
      project.consecutiveFails = 0;
    }

    project.lastCheckedAt = new Date();
    await project.save();
    results.push({ projectId: project._id, ...result });
  }

  return results;
}

module.exports = { runChecks };
