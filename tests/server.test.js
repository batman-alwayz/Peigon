import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createApp, hashToken, sanitizeFilename } = require("../server");
const { createDatabase } = require("../src/database");
const { cleanupExpiredShares } = require("../src/services/cleanupService");

describe("Peigon security and share lifecycle", () => {
  let tempDir;
  let db;
  let app;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "peigon-test-"));
    db = createDatabase(path.join(tempDir, "data", "test.sqlite"));
    app = createApp({
      db,
      uploadsDir: path.join(tempDir, "uploads"),
      ticketSecret: "test-secret-with-more-than-32-bytes-long",
    });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function upload({ downloads = "3", password = "" } = {}) {
    const response = await request(app)
      .post("/api/shares")
      .field("expiryMinutes", "60")
      .field("maxDownloads", downloads)
      .field("password", password)
      .field("encryptedName", Buffer.from("private-name").toString("base64url"))
      .attach("file", Buffer.from("hello transfer"), {
        filename: "payload.bin",
        contentType: "application/octet-stream",
      });
    expect(response.status).toBe(201);
    return response.body.url.match(/\/vault\/([^/]+)/)[1];
  }
  async function uploadLegacy({ downloads = "3", password = "" } = {}) {
    const response = await request(app)
      .post("/api/shares")
      .field("expiryMinutes", "60")
      .field("maxDownloads", downloads)
      .field("password", password)
      .attach("file", Buffer.from("old client payload"), {
        filename: "legacy.txt",
        contentType: "text/plain",
      });
    expect(response.status).toBe(201);
    return response.body.url.match(/\/vault\/([^/]+)/)[1];
  }
  async function unlock(token, password = "") {
    return request(app).post(`/api/shares/${token}/unlock`).send({ password });
  }

  it("stores only the SHA-256 token digest", async () => {
    const token = await upload();
    const stored = db.raw.prepare("SELECT token_hash FROM shares").get();
    expect(stored.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("returns the same 404 for unknown, expired, and exhausted links", async () => {
    const token = await upload({ downloads: "1" });
    const unknown = await request(app).get(
      "/api/shares/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    const share = db.raw.prepare("SELECT token_hash FROM shares").get();
    db.raw
      .prepare("UPDATE shares SET expires_at = ? WHERE token_hash = ?")
      .run(new Date(Date.now() - 1000).toISOString(), share.token_hash);
    const expired = await request(app).get(`/api/shares/${token}`);
    expect(unknown.status).toBe(404);
    expect(expired.status).toBe(404);
    expect(expired.body).toEqual(unknown.body);
  });

  it("returns the same 404 after a share is exhausted", async () => {
    const token = await upload({ downloads: "1" });
    const ticket = (await unlock(token)).body.ticket;
    const download = await request(app)
      .post(`/api/shares/${token}/download`)
      .set("Authorization", `Bearer ${ticket}`);
    const unavailable = await request(app).get(`/api/shares/${token}`);
    const unknown = await request(app).get(
      "/api/shares/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(download.status).toBe(200);
    expect(unavailable.status).toBe(404);
    expect(unavailable.body).toEqual(unknown.body);
  });

  it("hides protected metadata, verifies passkeys, and issues a short-lived ticket", async () => {
    const token = await upload({ password: "correct horse" });
    const metadata = await request(app).get(`/api/shares/${token}`);
    expect(metadata.body).toEqual({ passwordRequired: true });
    expect((await unlock(token, "wrong")).status).toBe(401);
    const result = await unlock(token, "correct horse");
    expect(result.status).toBe(200);
    expect(result.body.ticket.split(".")).toHaveLength(2);
    const downloaded = await request(app)
      .post(`/api/shares/${token}/download`)
      .set("Authorization", `Bearer ${result.body.ticket}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("keeps the original plaintext API request shape working", async () => {
    const token = await uploadLegacy({ password: "legacy pass" });
    const metadata = await request(app).get(`/api/shares/${token}`);
    expect(metadata.body).toEqual({ passwordRequired: true });
    const unlocked = await unlock(token, "legacy pass");
    expect(unlocked.body.share.fileName).toBe("legacy.txt");
    const downloaded = await request(app)
      .post(`/api/shares/${token}/download`)
      .send({ password: "legacy pass" });
    expect(downloaded.status).toBe(200);
    expect(downloaded.body.toString()).toBe("old client payload");
  });

  it("cleans an upload when Zod rejects the request options", async () => {
    const response = await request(app)
      .post("/api/shares")
      .field("expiryMinutes", "11")
      .field("maxDownloads", "3")
      .field("encryptedName", Buffer.from("name").toString("base64url"))
      .attach("file", Buffer.from("temporary"), "temporary.bin");
    expect(response.status).toBe(400);
    expect(fs.readdirSync(path.join(tempDir, "uploads"))).toHaveLength(0);
  });

  it("sets private cache/referrer headers and rejects unapproved browser origins", async () => {
    const response = await request(app)
      .get("/api/shares/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
      .set("Origin", "https://unapproved.example");
    expect(response.status).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("locks passkey verification after repeated failures", async () => {
    const token = await upload({ password: "correct horse" });
    for (let i = 0; i < 5; i++)
      expect((await unlock(token, "wrong")).status).toBe(401);
    expect((await unlock(token, "correct horse")).status).toBe(429);
  });

  it("applies token throttling across different IPs", async () => {
    const token = await upload({ password: "correct horse" });
    app.set("trust proxy", 1);
    for (let index = 1; index <= 5; index++) {
      const result = await request(app)
        .post(`/api/shares/${token}/unlock`)
        .set("X-Forwarded-For", `10.0.0.${index}`)
        .send({ password: "wrong" });
      expect(result.status).toBe(401);
    }
    const locked = await request(app)
      .post(`/api/shares/${token}/unlock`)
      .set("X-Forwarded-For", "10.0.1.1")
      .send({ password: "correct horse" });
    expect(locked.status).toBe(429);
  });

  it("rejects an expired HMAC download ticket", async () => {
    const token = await upload();
    const payload = Buffer.from(
      JSON.stringify({
        tokenHash: hashToken(token),
        exp: Math.floor(Date.now() / 1000) - 1,
      }),
    ).toString("base64url");
    const signature = crypto
      .createHmac("sha256", "test-secret-with-more-than-32-bytes-long")
      .update(payload)
      .digest("base64url");
    const result = await request(app)
      .post(`/api/shares/${token}/download`)
      .set("Authorization", `Bearer ${payload}.${signature}`);
    expect(result.status).toBe(401);
  });

  it("migrates legacy plaintext-token JSON and removes the source", () => {
    const migrationDir = path.join(tempDir, "migration");
    fs.mkdirSync(migrationDir);
    const legacyToken = crypto.randomBytes(32).toString("base64url");
    const legacyFile = path.join(migrationDir, "shares.json");
    fs.writeFileSync(
      legacyFile,
      JSON.stringify([
        {
          token: legacyToken,
          fileName: "old.txt",
          fileSize: 3,
          storageName: "opaque-file",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          downloadsRemaining: 1,
        },
      ]),
    );
    const migrated = createDatabase(path.join(migrationDir, "shares.sqlite"));
    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(
      migrated.raw.prepare("SELECT token_hash FROM shares").get().token_hash,
    ).toBe(hashToken(legacyToken));
    migrated.close();
  });

  it("sanitizes downloaded filenames", () => {
    expect(sanitizeFilename("../evil<script>.txt\u0000")).toBe(
      "evil_script_.txt",
    );
  });

  it("deletes expired files before marking their records deleted", () => {
    const uploadsDir = path.join(tempDir, "cleanup-uploads");
    fs.mkdirSync(uploadsDir);
    const storageName = "random-storage-name";
    const filePath = path.join(uploadsDir, storageName);
    fs.writeFileSync(filePath, "expired");
    let marked = false;
    const cleanupDb = {
      findExpired: () => [{ tokenHash: "hash", storageName }],
      markDeleted: () => {
        expect(fs.existsSync(filePath)).toBe(false);
        marked = true;
      },
    };
    expect(cleanupExpiredShares(cleanupDb, uploadsDir)).toBe(1);
    expect(marked).toBe(true);
  });

  it("atomically permits only three of ten parallel downloads", async () => {
    const token = await upload({ downloads: "3", password: "correct horse" });
    const ticket = (await unlock(token, "correct horse")).body.ticket;
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app)
          .post(`/api/shares/${token}/download`)
          .set("Authorization", `Bearer ${ticket}`),
      ),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(3);
    expect(
      responses.filter((response) => response.status === 404),
    ).toHaveLength(7);
  });

  it("provides a database health endpoint", async () => {
    const response = await request(app).get("/healthz");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});
