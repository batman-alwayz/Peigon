const cors = require("cors");
const helmet = require("helmet");
const express = require("express");

function validateOrigins(value) {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== origin
    )
      throw new Error(`Invalid FRONTEND_URL origin: ${origin}`);
  }
  return origins;
}

function useSecurityHeaders(app, allowedOrigins = "") {
  const origins = validateOrigins(allowedOrigins);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
          ],
          fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
        },
      },
    }),
  );
  app.use(
    cors({ origin: origins.length ? origins : false, credentials: false }),
  );
  app.use(express.json({ limit: "8kb" }));
  app.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    next();
  });
}

module.exports = { useSecurityHeaders, validateOrigins };
