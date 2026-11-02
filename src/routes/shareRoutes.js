const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { createShareController } = require("../controllers/shareController");

const MAX_FILE_SIZE = 100 * 1024 * 1024;

function createShareRouter({ database, uploadsDir, tickets, limiter }) {
  const router = express.Router();
  const controller = createShareController({
    database,
    uploadsDir,
    tickets,
    limiter,
  });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (_req, _file, callback) =>
        callback(null, crypto.randomBytes(24).toString("hex")),
    }),
    limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 4 },
    fileFilter: (_req, _file, callback) => callback(null, true),
  });

  router.post("/shares", upload.single("file"), controller.upload);
  router.get("/shares/:token", controller.metadata);
  router.post("/shares/:token/unlock", controller.unlock);
  router.post("/shares/:token/download", controller.download);
  router.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE")
      return res
        .status(400)
        .json({ error: "Files must be 100 MB or smaller." });
    res.status(400).json({ error: "Request could not be processed." });
  });
  return router;
}

module.exports = { createShareRouter };
