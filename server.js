const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { validateEnvironment } = require("./src/config/env");
const {
  createAttemptLimiter,
  createTicketService,
  hashToken,
  sanitizeFilename,
} = require("./src/services/securityService");
const { createShareRepository } = require("./src/repositories/shareRepository");
const { useSecurityHeaders } = require("./src/middleware/securityHeaders");
const { createShareRouter } = require("./src/routes/shareRoutes");
const { startCleanupWorker } = require("./src/services/cleanupService");

function createApp({
  db,
  uploadsDir,
  ticketSecret,
  allowedOrigins = process.env.FRONTEND_URL || "",
} = {}) {
  const config = validateEnvironment();
  const storageRoot = config.STORAGE_PATH || __dirname;
  const actualUploadsDir = uploadsDir || path.join(storageRoot, "uploads");
  fs.mkdirSync(actualUploadsDir, { recursive: true });
  const database =
    db ||
    createShareRepository(path.join(storageRoot, "data", "shares.sqlite"));
  const configuredSecret = ticketSecret || config.TICKET_SECRET;
  const secret = Buffer.isBuffer(configuredSecret)
    ? configuredSecret
    : Buffer.from(configuredSecret || crypto.randomBytes(32));
  if (secret.length < 32)
    throw new Error("TICKET_SECRET must contain at least 32 bytes.");

  const app = express();
  app.set("trust proxy", config.TRUST_PROXY === "true" ? 1 : false);
  useSecurityHeaders(app, allowedOrigins);

  const webBuild = path.join(__dirname, "client", "dist");
  if (fs.existsSync(webBuild))
    app.use(
      express.static(webBuild, {
        setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
      }),
    );

  app.get("/healthz", (_req, res) => {
    try {
      database.healthCheck();
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  const tickets = createTicketService(secret);
  const limiter = createAttemptLimiter();
  app.use(
    "/api",
    createShareRouter({
      database,
      uploadsDir: actualUploadsDir,
      tickets,
      limiter,
    }),
  );

  app.get("/vault/:token", (_req, res) => {
    if (fs.existsSync(webBuild))
      return res.sendFile(path.join(webBuild, "index.html"));
    res
      .status(503)
      .json({ error: "Frontend has not been built. Run npm run build." });
  });

  app.locals.database = database;
  app.locals.uploadsDir = actualUploadsDir;
  return app;
}

function start() {
  const app = createApp();
  const port = validateEnvironment().PORT || 3000;
  const server = app.listen(port, () =>
    console.log(`Peigon listening on port ${port}`),
  );
  const cleanup = startCleanupWorker(
    app.locals.database,
    app.locals.uploadsDir,
  );
  const shutdown = () => {
    cleanup.stop();
    server.close(() => {
      app.locals.database.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { app, server, cleanup };
}

if (require.main === module) start();
module.exports = {
  createApp,
  start,
  hashToken,
  sanitizeFilename,
  validateEnvironment,
};
