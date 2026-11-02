const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const crypto = require('crypto');
const cors = require('cors');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');

const env = z.object({ PORT: z.coerce.number().int().positive().default(3000), STORAGE_PATH: z.string().optional(), FRONTEND_URL: z.string().optional() }).parse(process.env);
const app = express(); app.set('trust proxy', 1);
const ROOT = __dirname, STORAGE_ROOT = env.STORAGE_PATH || ROOT, UPLOADS = path.join(STORAGE_ROOT, 'uploads'), DATA = path.join(STORAGE_ROOT, 'data'), DB_FILE = path.join(DATA, 'shares.json'), WEB_BUILD = path.join(ROOT, 'client', 'dist');
const MAX_PASSKEY_ATTEMPTS = 5, TICKET_TTL_MS = 60_000, shareLocks = new Map();
for (const dir of [UPLOADS, DATA]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

const readShares = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const writeShares = shares => fs.writeFileSync(DB_FILE, JSON.stringify(shares, null, 2));
const hashSecret = value => crypto.createHash('sha256').update(value).digest('hex');
const unavailable = res => res.status(404).json({ error: 'This share is unavailable.' });
function removeStoredFile(share) { const file = path.join(UPLOADS, share.storageName); if (fs.existsSync(file)) fs.unlinkSync(file); }
function invalidate(share) { removeStoredFile(share); share.deleted = true; }
const isUnavailable = share => share.deleted || Date.now() >= new Date(share.expiresAt).getTime() || share.downloadsRemaining <= 0;
const publicShare = share => ({ fileName: share.fileName, fileSize: share.fileSize, expiresAt: share.expiresAt, downloadsRemaining: share.downloadsRemaining, passwordRequired: Boolean(share.passwordHash) });
function isDangerousUpload(file) { const ext = path.extname(file.originalname).toLowerCase(); const buffer = Buffer.alloc(512); const fd = fs.openSync(file.path, 'r'); const bytes = fs.readSync(fd, buffer, 0, 512, 0); fs.closeSync(fd); const header = buffer.subarray(0, bytes).toString('utf8').toLowerCase(); return ['.html', '.htm', '.svg', '.js', '.mjs'].includes(ext) || /^\s*(<!doctype\s+html|<html|<script)/.test(header); }

// Atomic for the current single Render instance. Use PostgreSQL/Redis when scaling out.
async function withShareLock(key, operation) { const previous = (shareLocks.get(key) || Promise.resolve()).catch(() => {}); let release; const next = new Promise(resolve => { release = resolve; }); const queued = previous.then(() => next); shareLocks.set(key, queued); await previous; try { return await operation(); } finally { release(); queued.then(() => { if (shareLocks.get(key) === queued) shareLocks.delete(key); }); } }
function locate(token, res) { const shares = readShares(); const index = shares.findIndex(share => share.tokenHash === hashSecret(token)); if (index < 0) return unavailable(res), null; const share = shares[index]; if (isUnavailable(share)) { if (!share.deleted) try { invalidate(share); writeShares(shares); } catch (_) {} return unavailable(res), null; } if (share.passkeyBlockedAt) { res.status(423).json({ error: 'This share is blocked after five incorrect passkey attempts.' }); return null; } return { shares, index, share }; }
async function verifyPasskey(found, password, ip) { const { shares, index, share } = found; if (!share.passwordHash) return { ok: true, ticket: null }; const now = Date.now(); share.passkeyAttemptLog = (share.passkeyAttemptLog || []).filter(a => now - new Date(a.at).getTime() < 15 * 60_000); if (share.passkeyAttemptLog.filter(a => a.ip === ip).length >= MAX_PASSKEY_ATTEMPTS) return { ok: false, blocked: true }; if (!(await bcrypt.compare(String(password || ''), share.passwordHash))) { share.failedPasskeyAttempts = (share.failedPasskeyAttempts || 0) + 1; share.passkeyAttemptLog.push({ ip, at: new Date().toISOString() }); if (share.failedPasskeyAttempts >= MAX_PASSKEY_ATTEMPTS) share.passkeyBlockedAt = new Date().toISOString(); shares[index] = share; writeShares(shares); return { ok: false, blocked: Boolean(share.passkeyBlockedAt) }; } const ticket = crypto.randomBytes(32).toString('base64url'); share.unlockTicketHash = hashSecret(ticket); share.unlockTicketExpiresAt = new Date(now + TICKET_TTL_MS).toISOString(); shares[index] = share; writeShares(shares); return { ok: true, ticket }; }
function verifyTicket(share, ticket) { return Boolean(ticket && share.unlockTicketHash && share.unlockTicketExpiresAt && Date.now() < new Date(share.unlockTicketExpiresAt).getTime() && crypto.timingSafeEqual(Buffer.from(hashSecret(ticket)), Buffer.from(share.unlockTicketHash))); }

app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }); next(); });
app.use(cors({ origin: env.FRONTEND_URL ? env.FRONTEND_URL.split(',') : false }));
if (fs.existsSync(WEB_BUILD)) app.use(express.static(WEB_BUILD, { setHeaders: res => res.set('Cache-Control', 'no-store') }));
const upload = multer({ dest: UPLOADS, limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
const createShareSchema = z.object({ expiryMinutes: z.coerce.number().refine(v => [10, 60, 1440].includes(v)), maxDownloads: z.coerce.number().refine(v => [1, 3, 10].includes(v)), password: z.string().max(256).optional().default('') });

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.post('/api/shares', upload.single('file'), async (req, res) => { try { if (!req.file) return res.status(400).json({ error: 'Choose one file (maximum 100 MB).' }); const parsed = createShareSchema.safeParse(req.body); if (!parsed.success || (parsed.data.password && parsed.data.password.length < 4) || isDangerousUpload(req.file)) { removeStoredFile({ storageName: req.file.filename }); return res.status(400).json({ error: 'Invalid transfer settings or unsupported file type.' }); } const token = crypto.randomBytes(32).toString('base64url'); const { expiryMinutes, maxDownloads, password } = parsed.data; const share = { tokenHash: hashSecret(token), fileName: path.basename(req.file.originalname), fileSize: req.file.size, storageName: req.file.filename, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiryMinutes * 60_000).toISOString(), downloadsRemaining: maxDownloads, passwordHash: password ? await bcrypt.hash(password, 12) : null, failedPasskeyAttempts: 0, passkeyBlockedAt: null, passkeyAttemptLog: [], unlockTicketHash: null, unlockTicketExpiresAt: null, deleted: false, accessLog: [] }; const shares = readShares(); shares.push(share); writeShares(shares); res.status(201).json({ url: `${req.protocol}://${req.get('host')}/vault/${token}`, share: publicShare(share) }); } catch (_) { res.status(500).json({ error: 'Upload failed. Please retry.' }); } });
app.get('/api/shares/:token', (req, res) => { const found = locate(req.params.token, res); if (!found) return; if (found.share.passwordHash) return res.json({ passwordRequired: true }); res.json({ passwordRequired: false, share: publicShare(found.share) }); });
app.post('/api/shares/:token/unlock', async (req, res) => { await withShareLock(req.params.token, async () => { const found = locate(req.params.token, res); if (!found) return; const verification = await verifyPasskey(found, req.body.password, req.ip); if (!verification.ok) return res.status(verification.blocked ? 423 : 401).json({ error: verification.blocked ? 'This share is blocked after five incorrect passkey attempts.' : 'Incorrect passkey.' }); res.json({ share: publicShare(found.share), ticket: verification.ticket }); }); });
app.post('/api/shares/:token/download', async (req, res) => { await withShareLock(req.params.token, async () => { const found = locate(req.params.token, res); if (!found) return; const { shares, index, share } = found; if (share.passwordHash && !verifyTicket(share, req.body.ticket)) return res.status(401).json({ error: 'Unlock expired. Enter the passkey again.' }); share.downloadsRemaining -= 1; share.unlockTicketHash = null; share.unlockTicketExpiresAt = null; share.accessLog.push({ at: new Date().toISOString(), ip: req.ip }); if (share.downloadsRemaining === 0) share.deleted = true; shares[index] = share; writeShares(shares); const filePath = path.join(UPLOADS, share.storageName); if (!fs.existsSync(filePath)) return unavailable(res); res.download(filePath, share.fileName, () => { if (share.deleted) try { removeStoredFile(share); } catch (_) {} }); }); });
app.get('/vault/:token', (_req, res) => fs.existsSync(WEB_BUILD) ? res.sendFile(path.join(WEB_BUILD, 'index.html')) : res.status(503).json({ error: 'Frontend has not been built.' }));
const cleanupTask = cron.schedule('*/5 * * * *', () => { const shares = readShares(); let changed = false; for (const share of shares) if (!share.deleted && isUnavailable(share)) try { invalidate(share); changed = true; } catch (_) {} if (changed) writeShares(shares); });
app.use((err, _req, res, _next) => res.status(400).json({ error: err instanceof multer.MulterError ? 'Files must be 100 MB or smaller.' : 'Request could not be processed.' }));
const server = app.listen(env.PORT, () => console.log(`Peigon running on port ${env.PORT}`));
function shutdown() { cleanupTask.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
