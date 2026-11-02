const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { uploadSchema, unlockSchema } = require("../validation/shareSchemas");
const { hashToken, sanitizeFilename } = require("../services/securityService");

const unavailable = (res) =>
  res.status(404).json({ error: "This link is unavailable." });

function createShareController({ database, uploadsDir, tickets, limiter }) {
  function getShare(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return null;
    const tokenHash = hashToken(token);
    const share = database.findAvailable(tokenHash, new Date().toISOString());
    return share ? { ...share, tokenHash } : null;
  }

  function publicShare(share) {
    return {
      fileName: share.encryptedName ? null : share.fileName,
      encryptedName: share.encryptedName || null,
      fileSize: share.fileSize,
      expiresAt: share.expiresAt,
      downloadsRemaining: share.downloadsRemaining,
      passwordRequired: Boolean(share.passwordHash),
    };
  }

  async function upload(req, res) {
    let uploadedPath;
    try {
      if (!req.file)
        return res
          .status(400)
          .json({ error: "Choose one file (maximum 100 MB)." });
      uploadedPath = req.file.path;
      const parsed = uploadSchema.safeParse(req.body);
      if (!parsed.success) {
        fs.rmSync(uploadedPath, { force: true });
        return res
          .status(400)
          .json({ error: "Invalid expiry, download limit, or passkey." });
      }

      const { fileTypeFromFile } = await import("file-type");
      const detected = await fileTypeFromFile(uploadedPath);
      const mimeType = detected?.mime || "application/octet-stream";
      const fileName = parsed.data.encryptedName
        ? "Encrypted transfer"
        : sanitizeFilename(req.file.originalname);
      const token = crypto.randomBytes(32).toString("base64url");
      const now = Date.now();
      const share = {
        tokenHash: hashToken(token),
        fileName,
        fileSize: req.file.size,
        storageName: req.file.filename,
        mimeType,
        encryptedName: parsed.data.encryptedName || null,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(
          now + parsed.data.expiryMinutes * 60_000,
        ).toISOString(),
        downloadsRemaining: parsed.data.maxDownloads,
        passwordHash: parsed.data.password
          ? await bcrypt.hash(parsed.data.password, 12)
          : null,
        deleted: 0,
      };
      database.insert(share);
      res.status(201).json({
        url: `${req.protocol}://${req.get("host")}/vault/${token}`,
        share: publicShare(share),
      });
    } catch {
      if (uploadedPath && fs.existsSync(uploadedPath)) {
        try {
          fs.unlinkSync(uploadedPath);
        } catch {
          /* Orphan cleanup can remove files left by failed requests. */
        }
      }
      res.status(500).json({ error: "Upload failed. Please retry." });
    }
  }

  function metadata(req, res) {
    const share = getShare(req.params.token);
    if (!share) return unavailable(res);
    if (share.passwordHash) return res.json({ passwordRequired: true });
    return res.json({ passwordRequired: false, share: publicShare(share) });
  }

  async function unlock(req, res) {
    const share = getShare(req.params.token);
    if (!share) return unavailable(res);
    const parsed = unlockSchema.safeParse(req.body || {});
    if (!parsed.success)
      return res.status(400).json({ error: "Invalid passkey." });
    if (limiter.isLimited(share.tokenHash, req.ip))
      return res
        .status(429)
        .json({ error: "Too many attempts. Try again in 15 minutes." });
    if (
      share.passwordHash &&
      !(await bcrypt.compare(parsed.data.password, share.passwordHash))
    ) {
      limiter.recordFailure(share.tokenHash, req.ip);
      return res.status(401).json({ error: "Incorrect passkey." });
    }
    return res.json({
      share: publicShare(share),
      ticket: tickets.issue(share.tokenHash),
    });
  }

  async function download(req, res) {
    const share = getShare(req.params.token);
    if (!share) return unavailable(res);
    const authorization = req.get("authorization") || "";
    const ticket = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (!tickets.verify(ticket, share.tokenHash)) {
      // Preserve the original request format for legacy unencrypted shares.
      if (share.encryptedName)
        return res
          .status(401)
          .json({ error: "Unlock this file again to download." });
      const parsed = unlockSchema.safeParse(req.body || {});
      if (!parsed.success)
        return res.status(400).json({ error: "Invalid passkey." });
      if (share.passwordHash) {
        if (limiter.isLimited(share.tokenHash, req.ip))
          return res
            .status(429)
            .json({ error: "Too many attempts. Try again in 15 minutes." });
        if (!(await bcrypt.compare(parsed.data.password, share.passwordHash))) {
          limiter.recordFailure(share.tokenHash, req.ip);
          return res.status(401).json({ error: "Incorrect passkey." });
        }
      }
    }

    const filePath = path.join(uploadsDir, share.storageName);
    if (!fs.existsSync(filePath)) {
      database.markDeleted(share.tokenHash);
      return unavailable(res);
    }
    const updated = database.consumeDownload(
      share.tokenHash,
      new Date().toISOString(),
    );
    if (!updated) return unavailable(res);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Type", share.mimeType || "application/octet-stream");
    res.download(filePath, share.fileName, (error) => {
      if (updated.downloadsRemaining === 0) {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {
          /* Cleanup retries on the scheduled worker. */
        }
        database.markDeleted(share.tokenHash);
      }
      if (error && !res.headersSent) res.status(500).end();
    });
  }

  return { upload, metadata, unlock, download };
}

module.exports = { createShareController };
