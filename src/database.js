const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

function createDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS shares (
    token_hash TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    storage_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    encrypted_name TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    downloads_remaining INTEGER NOT NULL CHECK(downloads_remaining >= 0),
    password_hash TEXT,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1))
  );
  CREATE INDEX IF NOT EXISTS shares_expiry_idx ON shares(deleted, expires_at);`);
  if (
    !db
      .prepare("PRAGMA table_info(shares)")
      .all()
      .some((column) => column.name === "encrypted_name")
  ) {
    db.exec("ALTER TABLE shares ADD COLUMN encrypted_name TEXT");
  }

  const mapRow = (row) =>
    row && {
      tokenHash: row.token_hash,
      fileName: row.file_name,
      fileSize: row.file_size,
      storageName: row.storage_name,
      mimeType: row.mime_type,
      encryptedName: row.encrypted_name,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      downloadsRemaining: row.downloads_remaining,
      passwordHash: row.password_hash,
      deleted: row.deleted,
    };
  const insert = db.prepare(`INSERT OR IGNORE INTO shares
    (token_hash, file_name, file_size, storage_name, mime_type, encrypted_name, created_at, expires_at, downloads_remaining, password_hash, deleted)
    VALUES (@tokenHash, @fileName, @fileSize, @storageName, @mimeType, @encryptedName, @createdAt, @expiresAt, @downloadsRemaining, @passwordHash, @deleted)`);
  const findAvailableStmt = db.prepare(
    `SELECT * FROM shares WHERE token_hash = ? AND deleted = 0 AND downloads_remaining > 0 AND expires_at > ?`,
  );
  const updateDownload =
    db.prepare(`UPDATE shares SET downloads_remaining = downloads_remaining - 1
    WHERE token_hash = ? AND downloads_remaining > 0 AND expires_at > ? AND deleted = 0`);
  const transaction = db.transaction((tokenHash, now) => {
    const result = updateDownload.run(tokenHash, now);
    return result.changes
      ? mapRow(
          db
            .prepare("SELECT * FROM shares WHERE token_hash = ?")
            .get(tokenHash),
        )
      : null;
  });
  const markDeleted = db.prepare(
    "UPDATE shares SET deleted = 1 WHERE token_hash = ?",
  );
  const expired = db.prepare(
    `SELECT * FROM shares WHERE deleted = 0 AND (expires_at <= ? OR downloads_remaining <= 0)`,
  );

  // One-time migration for existing MVP installations. Existing links remain valid, while
  // the new database stores only their SHA-256 token digests.
  const legacyFile = path.join(path.dirname(filename), "shares.json");
  if (fs.existsSync(legacyFile)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
      const migrate = db.transaction((rows) => {
        for (const share of rows) {
          if (!share.token || !share.storageName || !share.expiresAt) continue;
          insert.run({
            tokenHash: crypto
              .createHash("sha256")
              .update(share.token)
              .digest("hex"),
            fileName: String(share.fileName || "download"),
            fileSize: Number(share.fileSize) || 0,
            storageName: String(share.storageName),
            mimeType: "application/octet-stream",
            encryptedName: null,
            createdAt: share.createdAt || new Date().toISOString(),
            expiresAt: share.expiresAt,
            downloadsRemaining: Math.max(
              0,
              Number(share.downloadsRemaining) || 0,
            ),
            passwordHash: share.passwordHash || null,
            deleted: share.deleted ? 1 : 0,
          });
        }
      });
      if (Array.isArray(legacy)) migrate(legacy);
      fs.unlinkSync(legacyFile);
    } catch (error) {
      console.error("Could not migrate legacy share records:", error.message);
      throw error;
    }
  }

  return {
    insert: (share) => insert.run(share),
    findAvailable: (tokenHash, now) =>
      mapRow(findAvailableStmt.get(tokenHash, now)),
    consumeDownload: (tokenHash, now) => transaction(tokenHash, now),
    markDeleted: (tokenHash) => markDeleted.run(tokenHash),
    findExpired: (now) => expired.all(now).map(mapRow),
    healthCheck: () => db.prepare("SELECT 1").get(),
    close: () => db.close(),
    raw: db,
  };
}

module.exports = { createDatabase };
