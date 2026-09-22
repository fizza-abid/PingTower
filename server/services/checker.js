const axios = require("axios");
const dns = require("dns").promises;
const net = require("net");

function isPrivateIp(ip) {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("127.") ||
    ip.startsWith("0.") ||
    ip.startsWith("169.254.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    ip === "::1"
  );
}

async function assertPublicUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are allowed");
  }

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) {
    throw new Error("Private hosts are not allowed");
  }

  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error("Private IPs are not allowed");
  }

  const records = await dns.lookup(host, { all: true });
  if (records.some((record) => isPrivateIp(record.address))) {
    throw new Error("URL resolves to a private IP");
  }

  return url.toString();
}

async function checkWebsite(rawUrl) {
  const url = await assertPublicUrl(rawUrl);
  const started = Date.now();

  try {
    const response = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 3,
      validateStatus: () => true,
    });

    return {
      statusCode: response.status,
      responseTime: Date.now() - started,
      isUp: response.status >= 200 && response.status < 400,
      error: null,
    };
  } catch (error) {
    return {
      statusCode: 0,
      responseTime: Date.now() - started,
      isUp: false,
      error: error.code || "request_failed",
    };
  }
}

module.exports = { checkWebsite, assertPublicUrl };
