const { mailer: defaultMailer } = require("./mailer");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeSubject(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 180);
}

function formatDate(value) {
  return new Date(value || Date.now()).toISOString();
}

function resultReason(result) {
  if (result.error) return result.errorDetail ? `${result.error}: ${result.errorDetail}` : result.error;
  return result.statusCode ? `HTTP ${result.statusCode}` : "No HTTP response";
}

function buildDownMessage(project, context) {
  const checkedAt = formatDate(context.now);
  const reason = resultReason(context.result);
  const subject = safeSubject(`PingTower alert: ${project.name} is down`);
  const text = [
    `PingTower detected that ${project.name} is down.`,
    "",
    `URL: ${project.url}`,
    `Reason: ${reason}`,
    `Consecutive failures: ${context.consecutiveFails}/${context.failThreshold}`,
    `Response time: ${context.result.responseTime} ms`,
    `Checked at: ${checkedAt}`,
    "",
    "You will receive a recovery email when the monitor is healthy again.",
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#17212b">
      <h2 style="color:#b42318">${escapeHtml(project.name)} is down</h2>
      <p>PingTower detected that this monitor is unavailable.</p>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
        <tr><td><strong>URL</strong></td><td><a href="${escapeHtml(project.url)}">${escapeHtml(project.url)}</a></td></tr>
        <tr><td><strong>Reason</strong></td><td>${escapeHtml(reason)}</td></tr>
        <tr><td><strong>Consecutive failures</strong></td><td>${context.consecutiveFails}/${context.failThreshold}</td></tr>
        <tr><td><strong>Response time</strong></td><td>${escapeHtml(context.result.responseTime)} ms</td></tr>
        <tr><td><strong>Checked at</strong></td><td>${escapeHtml(checkedAt)}</td></tr>
      </table>
      <p>You will receive a recovery email when the monitor is healthy again.</p>
    </div>
  `;

  return { to: project.alertEmail, subject, text, html };
}

function buildRecoveryMessage(project, context) {
  const checkedAt = formatDate(context.now);
  const downtime =
    context.outageDurationMs == null
      ? "unknown duration"
      : `${Math.max(0, Math.round(context.outageDurationMs / 1000))} seconds`;
  const subject = safeSubject(`PingTower recovery: ${project.name} is back up`);
  const text = [
    `PingTower detected that ${project.name} is back up.`,
    "",
    `URL: ${project.url}`,
    `Downtime: ${downtime}`,
    `Status: HTTP ${context.result.statusCode}`,
    `Response time: ${context.result.responseTime} ms`,
    `Checked at: ${checkedAt}`,
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#17212b">
      <h2 style="color:#067647">${escapeHtml(project.name)} is back up</h2>
      <p>PingTower detected a successful check after an outage.</p>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
        <tr><td><strong>URL</strong></td><td><a href="${escapeHtml(project.url)}">${escapeHtml(project.url)}</a></td></tr>
        <tr><td><strong>Downtime</strong></td><td>${escapeHtml(downtime)}</td></tr>
        <tr><td><strong>Status</strong></td><td>HTTP ${escapeHtml(context.result.statusCode)}</td></tr>
        <tr><td><strong>Response time</strong></td><td>${escapeHtml(context.result.responseTime)} ms</td></tr>
        <tr><td><strong>Checked at</strong></td><td>${escapeHtml(checkedAt)}</td></tr>
      </table>
    </div>
  `;

  return { to: project.alertEmail, subject, text, html };
}

function createNotifier({ mailer = defaultMailer, logger = console } = {}) {
  async function send(kind, project, message) {
    const result = await mailer.send(message);
    if (result && result.skipped) {
      logger.warn(
        `[alert] ${kind} email skipped for ${project.name}: ${result.reason || "mailer disabled"}`
      );
    } else {
      logger.info(
        `[alert] ${kind} email sent for ${project.name} -> ${project.alertEmail}` +
          (result && result.messageId ? ` (${result.messageId})` : "")
      );
    }
    return result;
  }

  async function safeDeliver(kind, project, message) {
    try {
      await send(kind, project, message);
      return true;
    } catch (err) {
      logger.error(`[alert] ${kind} email failed for ${project && project.name}: ${err.message}`);
      return false;
    }
  }

  return {
    async notifyDown(project, context) {
      return safeDeliver("DOWN", project, buildDownMessage(project, context));
    },
    async notifyRecovery(project, context) {
      return safeDeliver("RECOVERY", project, buildRecoveryMessage(project, context));
    },
  };
}

const notifier = createNotifier();

module.exports = {
  ...notifier,
  createNotifier,
  buildDownMessage,
  buildRecoveryMessage,
  escapeHtml,
  safeSubject,
};
