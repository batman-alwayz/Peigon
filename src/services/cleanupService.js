const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

function cleanupExpiredShares(
  database,
  uploadsDir,
  now = new Date().toISOString(),
) {
  const expired = database.findExpired(now);
  let cleaned = 0;
  for (const share of expired) {
    const filePath = path.join(uploadsDir, share.storageName);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      database.markDeleted(share.tokenHash);
      cleaned += 1;
    } catch {
      // Leave the row active so the next worker run retries the file deletion.
    }
  }
  return cleaned;
}

function startCleanupWorker(database, uploadsDir) {
  return cron.schedule("*/5 * * * *", () =>
    cleanupExpiredShares(database, uploadsDir),
  );
}

module.exports = { cleanupExpiredShares, startCleanupWorker };
