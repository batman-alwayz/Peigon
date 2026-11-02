const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // Render terminates HTTPS at a reverse proxy.
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const STORAGE_ROOT = process.env.STORAGE_PATH || ROOT;
const UPLOADS = path.join(STORAGE_ROOT, 'uploads');
const DATA = path.join(STORAGE_ROOT, 'data');
const DB_FILE = path.join(DATA, 'shares.json');
const WEB_BUILD = path.join(ROOT, 'client', 'dist');
const MAX_PASSKEY_ATTEMPTS = 5;
const shareLocks = new Map();
for (const dir of [UPLOADS, DATA]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

const readShares = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const writeShares = (shares) => fs.writeFileSync(DB_FILE, JSON.stringify(shares, null, 2));
const removeStoredFile = (share) => {
  const file = path.join(UPLOADS, share.storageName);
  if (fs.existsSync(file)) fs.unlinkSync(file);
};
const invalidate = (share) => { share.deleted = true; removeStoredFile(share); };
const isUnavailable = (share) => share.deleted || Date.now() >= new Date(share.expiresAt).getTime() || share.downloadsRemaining <= 0;
const publicShare = (share) => ({
  fileName: share.fileName, fileSize: share.fileSize, expiresAt: share.expiresAt,
  downloadsRemaining: share.downloadsRemaining, passwordRequired: Boolean(share.passwordHash)
});

// JSON files do not offer transactions. This keyed queue provides an atomic critical
// section per share while this single Node.js instance is running.
async function withShareLock(token, operation) {
  const previous = (shareLocks.get(token) || Promise.resolve()).catch(() => {});
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => next);
  shareLocks.set(token, queued);
  await previous;
  try { return await operation(); }
  finally {
    release();
    queued.then(() => { if (shareLocks.get(token) === queued) shareLocks.delete(token); });
  }
}

async function verifyPasskey(found, suppliedPassword) {
  const { shares, index, share } = found;
  if (!share.passwordHash) return { ok: true };
  if (share.passkeyBlockedAt) return { ok: false, blocked: true };
  const ok = await bcrypt.compare(String(suppliedPassword || ''), share.passwordHash);
  if (ok) return { ok: true };
  share.failedPasskeyAttempts = (share.failedPasskeyAttempts || 0) + 1;
  if (share.failedPasskeyAttempts >= MAX_PASSKEY_ATTEMPTS) share.passkeyBlockedAt = new Date().toISOString();
  shares[index] = share;
  writeShares(shares);
  return { ok: false, blocked: Boolean(share.passkeyBlockedAt) };
}

app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : true }));
if (fs.existsSync(WEB_BUILD)) app.use(express.static(WEB_BUILD));

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, !file.mimetype.includes('html'))
});

app.post('/api/shares', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose one file (maximum 100 MB).' });
    const minutes = Number(req.body.expiryMinutes);
    const maxDownloads = Number(req.body.maxDownloads);
    if (![10, 60, 1440].includes(minutes) || ![1, 3, 10].includes(maxDownloads)) {
      removeStoredFile({ storageName: req.file.filename });
      return res.status(400).json({ error: 'Invalid expiry or download limit.' });
    }
    const password = String(req.body.password || '');
    if (password.length > 0 && password.length < 4) {
      removeStoredFile({ storageName: req.file.filename });
      return res.status(400).json({ error: 'Passkey must be at least 4 characters.' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const share = {
      token, fileName: path.basename(req.file.originalname), fileSize: req.file.size,
      storageName: req.file.filename, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
      downloadsRemaining: maxDownloads, passwordHash: password ? await bcrypt.hash(password, 12) : null,
      failedPasskeyAttempts: 0, passkeyBlockedAt: null,
      deleted: false, accessLog: []
    };
    const shares = readShares(); shares.push(share); writeShares(shares);
    res.status(201).json({ url: `${req.protocol}://${req.get('host')}/vault/${token}`, share: publicShare(share) });
  } catch (error) { res.status(500).json({ error: 'Upload failed. Please retry.' }); }
});

function locate(req, res) {
  const shares = readShares(); const index = shares.findIndex((s) => s.token === req.params.token);
  if (index < 0) { res.status(404).json({ error: 'This link does not exist.' }); return null; }
  const share = shares[index];
  if (share.passkeyBlockedAt) { res.status(423).json({ error: 'This share was blocked after too many incorrect passkey attempts.' }); return null; }
  if (isUnavailable(share)) { if (!share.deleted) { invalidate(share); writeShares(shares); } res.status(410).json({ error: 'This link has expired or reached its download limit.' }); return null; }
  return { shares, index, share };
}

app.get('/api/shares/:token', (req, res) => {
  const found = locate(req, res); if (!found) return;
  // A password-protected share reveals no filename, size, expiry or count until unlocked.
  if (found.share.passwordHash) return res.json({ passwordRequired: true });
  res.json({ passwordRequired: false, share: publicShare(found.share) });
});

// Password verification stays separate from download: metadata is never returned before a valid password.
app.post('/api/shares/:token/unlock', async (req, res) => {
  await withShareLock(req.params.token, async () => {
    const found = locate(req, res); if (!found) return;
    const verification = await verifyPasskey(found, req.body.password);
    if (!verification.ok) return res.status(verification.blocked ? 423 : 401).json({
      error: verification.blocked ? 'This share is blocked after five incorrect passkey attempts.' : 'Incorrect passkey.'
    });
    res.json({ share: publicShare(found.share) });
  });
});

// The lock plus decrement-before-stream makes the count atomic for this instance.
app.post('/api/shares/:token/download', async (req, res) => {
  await withShareLock(req.params.token, async () => {
    const found = locate(req, res); if (!found) return;
    const { shares, index, share } = found;
    const verification = await verifyPasskey(found, req.body.password);
    if (!verification.ok) return res.status(verification.blocked ? 423 : 401).json({
      error: verification.blocked ? 'This share is blocked after five incorrect passkey attempts.' : 'Incorrect passkey.'
    });
    share.downloadsRemaining -= 1;
    share.accessLog.push({ at: new Date().toISOString(), ip: req.ip });
    if (share.downloadsRemaining === 0) share.deleted = true;
    shares[index] = share; writeShares(shares);
    const filePath = path.join(UPLOADS, share.storageName);
    if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'File is no longer available.' });
    res.download(filePath, share.fileName, () => { if (share.deleted) removeStoredFile(share); });
  });
});

app.get('/vault/:token', (_req, res) => {
  if (fs.existsSync(WEB_BUILD)) return res.sendFile(path.join(WEB_BUILD, 'index.html'));
  res.status(503).json({ error: 'Frontend has not been built. Run npm run build.' });
});

cron.schedule('*/5 * * * *', () => {
  const shares = readShares(); let changed = false;
  for (const share of shares) if (!share.deleted && isUnavailable(share)) { invalidate(share); changed = true; }
  if (changed) writeShares(shares);
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Files must be 100 MB or smaller.' });
  res.status(400).json({ error: 'Request could not be processed.' });
});
app.listen(PORT, () => console.log(`Peigon running at http://localhost:${PORT}`));
