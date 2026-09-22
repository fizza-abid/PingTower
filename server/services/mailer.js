const nodemailer = require("nodemailer");
const config = require("../config/env");

// Creates a small mail transport seam. Production uses Nodemailer's SMTP
// transport; tests can provide a factory that returns an in-memory fake without
// opening a network connection or sending real mail.
function createMailer({ settings = config, transportFactory = nodemailer.createTransport } = {}) {
  if (!settings.mailEnabled) {
    return {
      enabled: false,
      async send() {
        return { skipped: true, reason: "MAIL_ENABLED=false" };
      },
    };
  }

  const smtpTransport = transportFactory({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    ...(settings.smtpUser
      ? { auth: { user: settings.smtpUser, pass: settings.smtpPassword } }
      : {}),
    connectionTimeout: settings.mailConnectionTimeoutMs,
    greetingTimeout: settings.mailGreetingTimeoutMs,
    socketTimeout: settings.mailSocketTimeoutMs,
  });

  return {
    enabled: true,
    async send(message) {
      return smtpTransport.sendMail({
        from: settings.mailFrom,
        ...message,
      });
    },
  };
}

const mailer = createMailer();

module.exports = { createMailer, mailer };
