// Small error hierarchy so routes can signal intent and the error middleware can
// produce a consistent JSON shape. Anything that is an HttpError is considered
// safe to show to a client (`expose`); everything else is logged server-side and
// reported as a generic 500 so internals never leak.
class HttpError extends Error {
  constructor(statusCode, message, { code, details } = {}) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code || "error";
    this.details = details;
    this.expose = true;
  }
}

class ValidationError extends HttpError {
  constructor(message = "Invalid request", details) {
    super(400, message, { code: "validation_error", details });
  }
}

class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, message, { code: "not_found" });
  }
}

class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, message, { code: "unauthorized" });
  }
}

// Raised when a target URL is not permitted. Kept distinct so the checker can
// tell "blocked by policy" apart from "malformed input" and "request failed".
class SsrfError extends ValidationError {
  constructor(message = "Target address is not allowed", classification = "blocked_target") {
    super(message);
    this.name = "SsrfError";
    this.code = "SSRF_BLOCKED";
    this.classification = classification;
  }
}

// Wraps an async route handler so a rejected promise reaches Express' error
// middleware instead of becoming an unhandled rejection.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  HttpError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  SsrfError,
  asyncHandler,
};
