// Pure state machine for monitor health, kept separate from I/O so it can be
// unit tested without a database.
//
// Semantics:
//   - `isUp` is null until the first check, so a new monitor never claims health.
//   - A monitor is only marked DOWN after `failThreshold` consecutive failures,
//     which prevents a single blip from flapping the dashboard.
//   - A down-alert is delivered exactly once per outage (`alertSent`), and a
//     recovery notice exactly once when it comes back.
function nextProjectState(project, result, { failThreshold = 3, now = new Date() } = {}) {
  const wasUp = project.isUp === undefined ? null : project.isUp;
  const alertSentBefore = Boolean(project.alertSent);
  const failsBefore = Number(project.consecutiveFails) || 0;
  const lastAlertAt = project.lastAlertAt || null;

  if (result.isUp) {
    return {
      next: {
        isUp: true,
        consecutiveFails: 0,
        alertSent: false,
        lastCheckedAt: now,
        lastAlertAt,
      },
      shouldAlert: false,
      recovered: wasUp === false,
      outage: false,
      consecutiveFails: 0,
    };
  }

  const consecutiveFails = failsBefore + 1;
  const outage = consecutiveFails >= failThreshold;
  // Guard on the dedupe flag, NOT on `isUp`: the previous implementation checked
  // `isUp` here, which was already false from the first failure, so the alert
  // branch was unreachable and no down-alert was ever sent.
  const shouldAlert = outage && !alertSentBefore;

  return {
    next: {
      isUp: outage ? false : wasUp,
      consecutiveFails,
      alertSent: shouldAlert ? true : alertSentBefore,
      lastCheckedAt: now,
      lastAlertAt: shouldAlert ? now : lastAlertAt,
    },
    shouldAlert,
    recovered: false,
    outage,
    consecutiveFails,
  };
}

module.exports = { nextProjectState };
