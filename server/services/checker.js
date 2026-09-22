const axios = require("axios");
const dns = require("dns").promises;
const http = require("http");
const https = require("https");
const net = require("net");

const config = require("../config/env");
const { SsrfError, ValidationError } = require("../utils/errors");

// --- Non-routable address space ------------------------------------------------
// net.BlockList is used instead of string prefix matching: it is family-aware,
// handles CIDR ranges correctly, and transparently applies IPv4 rules to
// IPv4-mapped IPv6 addresses (::ffff:127.0.0.1), which string checks miss.
const NON_PUBLIC_V4 = [
  "0.0.0.0/8", // "this" network
  "10.0.0.0/8", // RFC1918
  "100.64.0.0/10", // RFC6598 carrier-grade NAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, incl. 169.254.169.254 cloud metadata
  "172.16.0.0/12", // RFC1918
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1
  "192.88.99.0/24", // 6to4 relay anycast (deprecated)
  "192.168.0.0/16", // RFC1918
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved
  "255.255.255.255/32", // broadcast
];

const NON_PUBLIC_V6 = [
  "::/128", // unspecified
  "::1/128", // loopback
  "64:ff9b:1::/48", // local-use NAT64
  "100::/64", // discard-only
  "2001::/32", // Teredo (can embed a private IPv4)
  "2001:2::/48", // benchmarking
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4 (can embed a private IPv4)
  "3ffe::/16", // legacy 6bone
  "5f00::/8", // SRv6 local
  "fc00::/7", // unique local
  "fe80::/10", // link local
  "ff00::/8", // multicast
];

const blockList = new net.BlockList();
for (const entry of NON_PUBLIC_V4) {
  const [address, prefix] = entry.split("/");
  blockList.addSubnet(address, Number(prefix), "ipv4");
}
for (const entry of NON_PUBLIC_V6) {
  const [address, prefix] = entry.split("/");
  blockList.addSubnet(address, Number(prefix), "ipv6");
}

// Hostnames that resolve to local/private space by convention, or that are
// reserved by cloud providers for internal metadata services.
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "instance-data", "metadata.goog"]);
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".intranet",
  ".google.internal",
];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function truncate(value, max = 200) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// WHATWG URL keeps brackets around an IPv6 literal ("[::1]"), which makes
// net.isIP() return 0 and silently disables any literal-IP check. Strip them.
function hostnameOf(url) {
  const host = url.hostname.toLowerCase();
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function ipFamily(ip) {
  const family = net.isIP(ip);
  return family === 4 ? "ipv4" : family === 6 ? "ipv6" : null;
}

function isNonPublicIp(ip) {
  const family = ipFamily(ip);
  // An address we cannot parse is treated as unsafe rather than allowed.
  if (!family) return true;
  return blockList.check(ip, family);
}

function isBlockedHostname(host) {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function parseTargetUrl(rawUrl) {
  if (typeof rawUrl !== "string") throw new SsrfError("URL must be a string", "invalid_url");

  const trimmed = rawUrl.trim();
  if (!trimmed) throw new SsrfError("URL is required", "invalid_url");

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SsrfError(`Malformed URL: "${truncate(trimmed, 120)}"`, "invalid_url");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new SsrfError(`Only http and https URLs are allowed (got "${url.protocol}")`, "invalid_url");
  }
  if (url.username || url.password) {
    throw new SsrfError("Credentials embedded in a URL are not allowed", "invalid_url");
  }

  const host = hostnameOf(url);
  if (!host) throw new SsrfError("URL has no hostname", "invalid_url");
  if (!config.allowPrivateTargets && isBlockedHostname(host)) {
    throw new SsrfError(`Private hostnames are not allowed ("${host}")`);
  }

  url.hash = "";
  return { url, host };
}

// Resolves the target and returns the addresses that are permitted. The caller
// pins the request to exactly these addresses, which closes the DNS-rebinding
// window between "we resolved it and it looked public" and "we connected".
async function resolveAllowedAddresses(host) {
  if (net.isIP(host)) {
    if (!config.allowPrivateTargets && isNonPublicIp(host)) {
      throw new SsrfError(`Non-public IP addresses are not allowed (${host})`);
    }
    return [{ address: host, family: net.isIP(host) }];
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    const wrapped = new ValidationError(
      `Hostname could not be resolved (${err.code || err.message})`
    );
    wrapped.classification = "dns_error";
    throw wrapped;
  }

  if (!records.length) throw new SsrfError(`Hostname did not resolve to any address (${host})`);

  if (!config.allowPrivateTargets) {
    const blocked = records.filter((record) => isNonPublicIp(record.address));
    if (blocked.length) {
      throw new SsrfError(
        `Hostname resolves to a non-public address (${blocked.map((r) => r.address).join(", ")})`
      );
    }
  }

  return records;
}

// A `dns.lookup` replacement that only ever returns addresses we already
// approved for this specific request.
function pinnedLookup(allowed) {
  return function lookup(hostname, options, callback) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : options || {};
    const family = opts.family ? Number(opts.family) : 0;

    let pool =
      family === 4
        ? allowed.filter((a) => a.family === 4)
        : family === 6
          ? allowed.filter((a) => a.family === 6)
          : allowed;
    if (!pool.length) pool = allowed;

    if (!pool.length) {
      const err = new Error(`No permitted address for ${hostname}`);
      err.code = "SSRF_BLOCKED";
      err.classification = "blocked_target";
      return cb(err);
    }

    if (opts.all) return cb(null, pool.map((a) => ({ address: a.address, family: a.family })));
    const pick = pool[0];
    cb(null, pick.address, pick.family);
  };
}

// Opens the request and resolves as soon as headers arrive, so the reported
// response time is time-to-first-byte rather than "time to download the page".
function openRequest(url, addresses) {
  const isTls = url.protocol === "https:";
  const Agent = isTls ? https.Agent : http.Agent;
  const agent = new Agent({
    keepAlive: false,
    lookup: config.allowPrivateTargets ? undefined : pinnedLookup(addresses),
  });

  return axios
    .request({
      url: url.toString(),
      method: "GET",
      timeout: config.checkTimeoutMs,
      // Redirects are followed by hand so every hop goes through the same
      // validation. Following them inside axios would let a public URL 302 to
      // 169.254.169.254 or 127.0.0.1 and bypass the guard entirely.
      maxRedirects: 0,
      maxBodyLength: config.maxResponseBytes,
      maxContentLength: config.maxResponseBytes,
      validateStatus: () => true,
      responseType: "stream",
      decompress: true,
      headers: {
        "User-Agent": config.userAgent,
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate",
      },
      ...(isTls ? { httpsAgent: agent } : { httpAgent: agent }),
    })
    .then((response) => ({ response, agent, headersAt: Date.now() }));
}

// Consumes at most `limit` bytes, then tears the stream down. Prevents a target
// that serves a huge file from buffering unbounded data into memory.
function drain(stream, limit) {
  return new Promise((resolve) => {
    let seen = 0;
    let truncated = false;
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      resolve({ seen, truncated });
    };

    if (!stream || typeof stream.on !== "function") return done();

    stream.on("data", (chunk) => {
      seen += chunk.length;
      if (seen > limit) {
        truncated = true;
        stream.destroy();
        done();
      }
    });
    stream.on("end", done);
    stream.on("close", done);
    stream.on("error", done);
  });
}

function classifyError(err) {
  if (!err) return "request_failed";
  if (err.classification) return err.classification;

  const code = String(err.code || "");
  const message = String(err.message || "");

  if (code === "SSRF_BLOCKED") return "blocked_target";
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || /timeout/i.test(message)) return "timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "DNS_ERROR") return "dns_error";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ECONNRESET" || code === "EPIPE") return "connection_reset";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "unreachable";
  if (code === "ERR_FR_MAX_BODY_LENGTH_EXCEEDED") return "response_too_large";
  if (
    code.startsWith("CERT_") ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(code)
  ) {
    return "tls_error";
  }
  if (code === "EPROTO") return "protocol_error";
  if (code) return code.toLowerCase();
  return "request_failed";
}

// Kept identical to the original semantics (2xx/3xx = up) so existing history
// stays comparable. Per-project expected-status rules are a separate change.
function isStatusUp(status) {
  return status >= 200 && status < 400;
}

/**
 * Validates a URL and returns its normalized form. Throws SsrfError /
 * ValidationError for input that must not be stored or requested.
 */
async function assertPublicUrl(rawUrl) {
  const { url, host } = parseTargetUrl(rawUrl);
  await resolveAllowedAddresses(host);
  return url.toString();
}

async function performHop(rawUrl, started) {
  const { url, host } = parseTargetUrl(rawUrl);
  const addresses = await resolveAllowedAddresses(host);
  const { response, agent, headersAt } = await openRequest(url, addresses);
  try {
    const { truncated } = await drain(response.data, config.maxResponseBytes);
    return {
      url,
      status: response.status,
      location: response.headers ? response.headers.location : undefined,
      truncated,
      responseTime: headersAt - started,
    };
  } finally {
    agent.destroy();
  }
}

/**
 * Performs one check. Never throws: every failure mode is returned as a result
 * object, so one bad target cannot abort a whole monitoring run.
 */
async function checkWebsite(rawUrl) {
  const started = Date.now();
  let target = rawUrl;
  let hops = 0;
  let truncated = false;
  let hop;

  try {
    for (;;) {
      hop = await performHop(target, started);
      truncated = truncated || hop.truncated;

      if (!REDIRECT_STATUSES.has(hop.status) || !hop.location) break;

      if (hops >= config.maxRedirects) {
        return {
          statusCode: hop.status,
          responseTime: hop.responseTime,
          isUp: false,
          error: "too_many_redirects",
          errorDetail: truncate(hop.location),
          finalUrl: hop.url.toString(),
          hops,
        };
      }

      hops += 1;
      target = new URL(hop.location, hop.url).toString();
    }

    return {
      statusCode: hop.status,
      responseTime: hop.responseTime,
      isUp: isStatusUp(hop.status),
      error: null,
      errorDetail: truncated ? "response_truncated" : null,
      finalUrl: hop.url.toString(),
      hops,
    };
  } catch (err) {
    return {
      statusCode: 0,
      responseTime: Date.now() - started,
      isUp: false,
      error: classifyError(err),
      errorDetail: truncate(err.message),
      finalUrl: "",
      hops,
    };
  }
}

module.exports = {
  checkWebsite,
  assertPublicUrl,
  // exported for tests and for re-validating a stored URL on update
  parseTargetUrl,
  resolveAllowedAddresses,
  isNonPublicIp,
  isBlockedHostname,
  classifyError,
  blockList,
};
