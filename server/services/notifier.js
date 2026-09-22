// Alert delivery seam. The monitor loop only knows notifyDown/notifyRecovery, so
// an email (nodemailer) or webhook transport can be dropped in without touching
// monitoring logic. Delivery failures are swallowed and logged: a broken mail
// provider must never stop checks from running or being recorded.
const transport = {
  async sendDown(project, context) {
    console.warn(
      `[alert] DOWN  ${project.name} <${project.url}> -> ${project.alertEmail} | ` +
        `status=${context.result.statusCode} error=${context.result.error || "n/a"} ` +
        `fails=${context.consecutiveFails}/${context.failThreshold}`
    );
  },

  async sendRecovery(project, context) {
    console.warn(
      `[alert] UP    ${project.name} <${project.url}> -> ${project.alertEmail} | ` +
        `status=${context.result.statusCode} after ${context.outageDurationMs ?? "unknown"} ms of downtime`
    );
  },
};

async function safeDeliver(method, project, context) {
  try {
    await method(project, context);
    return true;
  } catch (err) {
    console.error(
      `[alert] delivery failed for ${project && project.name}: ${err.message}`
    );
    return false;
  }
}

function notifyDown(project, context) {
  return safeDeliver(transport.sendDown, project, context);
}

function notifyRecovery(project, context) {
  return safeDeliver(transport.sendRecovery, project, context);
}

module.exports = { notifyDown, notifyRecovery, transport };
