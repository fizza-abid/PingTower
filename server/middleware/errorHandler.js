const mongoose = require("mongoose");
const { HttpError } = require("../utils/errors");

// 404 for unknown API paths, returned as JSON rather than Express' HTML page so
// the client never has to parse an error page as JSON.
function notFound(req, res) {
  res.status(404).json({
    message: `Unknown endpoint: ${req.method} ${req.originalUrl}`,
    code: "not_found",
  });
}

function fromMongooseError(err) {
  if (err.name === "ValidationError" && err.errors) {
    const details = Object.fromEntries(
      Object.entries(err.errors).map(([field, e]) => [field, e.message])
    );
    return {
      statusCode: 400,
      code: "validation_error",
      message: "Validation failed",
      details,
    };
  }
  if (err.name === "CastError") {
    return {
      statusCode: 400,
      code: "validation_error",
      message: `Invalid value for "${err.path}"`,
    };
  }
  if (err.code === 11000) {
    const fields = Object.keys(err.keyPattern || {});
    return {
      statusCode: 409,
      code: "duplicate_key",
      message: fields.length ? `Already exists: ${fields.join(", ")}` : "Already exists",
    };
  }
  if (err.type === "entity.parse.failed") {
    return { statusCode: 400, code: "malformed_json", message: "Request body is not valid JSON" };
  }
  if (err.type === "entity.too.large") {
    return { statusCode: 413, code: "payload_too_large", message: "Request body is too large" };
  }
  if (err instanceof mongoose.Error) {
    return { statusCode: 500, code: "database_error", message: "Database error" };
  }
  return null;
}

// Single place that turns any thrown value into a JSON response. Client errors
// keep their message; server errors are logged in full and reported generically.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return;

  let statusCode = 500;
  let code = "internal_error";
  let message = "Internal server error";
  let details;

  if (err instanceof HttpError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else {
    const mapped = fromMongooseError(err);
    if (mapped) {
      ({ statusCode, code, message, details } = mapped);
    }
  }

  if (statusCode >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  } else {
    console.warn(`[error] ${req.method} ${req.originalUrl} -> ${statusCode} ${code}: ${message}`);
  }

  res.status(statusCode).json({
    message,
    code,
    ...(details ? { details } : {}),
  });
}

module.exports = { notFound, errorHandler };
