const crypto = require("crypto");
const path = require("path");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sanitizeFilename(name) {
  const leaf = path.basename(String(name).replace(/\\/g, "/"));
  const withoutControls = [...leaf]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
  return (
    withoutControls
      .replace(/[<>:"|?*]/g, "_")
      .trim()
      .slice(0, 180) || "download"
  );
}

function createTicketService(secret, ttlSeconds = 60, now = Date.now) {
  function issue(tokenHash) {
    const payload = Buffer.from(
      JSON.stringify({
        tokenHash,
        exp: Math.floor(now() / 1000) + ttlSeconds,
      }),
    ).toString("base64url");
    const signature = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  function verify(ticket, tokenHash) {
    if (!ticket || typeof ticket !== "string") return false;
    const [payload, signature, extra] = ticket.split(".");
    if (!payload || !signature || extra) return false;
    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest();
    let actual;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      return false;
    }
    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    )
      return false;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());
      return (
        data.tokenHash === tokenHash &&
        Number.isInteger(data.exp) &&
        data.exp > Math.floor(now() / 1000)
      );
    } catch {
      return false;
    }
  }
  return { issue, verify };
}

function createAttemptLimiter({
  now = Date.now,
  maxAttempts = 5,
  windowMs = 15 * 60_000,
  lockoutMs = 15 * 60_000,
  maxKeys = 10_000,
} = {}) {
  const attempts = new Map();
  function stateFor(key) {
    if (attempts.size > maxKeys) {
      const cutoff = now() - windowMs;
      for (const [savedKey, state] of attempts)
        if (state.startedAt < cutoff && state.lockedUntil <= now())
          attempts.delete(savedKey);
      while (attempts.size > maxKeys)
        attempts.delete(attempts.keys().next().value);
    }
    let state = attempts.get(key);
    if (!state || now() - state.startedAt > windowMs) {
      state = { startedAt: now(), failures: 0, lockedUntil: 0 };
      attempts.set(key, state);
    }
    return state;
  }
  const statesFor = (tokenHash, ip) => [
    stateFor(`token:${tokenHash}`),
    stateFor(`ip:${ip}`),
  ];
  return {
    isLimited: (tokenHash, ip) =>
      statesFor(tokenHash, ip).some((state) => state.lockedUntil > now()),
    recordFailure: (tokenHash, ip) => {
      for (const state of statesFor(tokenHash, ip)) {
        state.failures += 1;
        if (state.failures >= maxAttempts)
          state.lockedUntil = now() + lockoutMs;
      }
    },
  };
}

module.exports = {
  createAttemptLimiter,
  createTicketService,
  hashToken,
  sanitizeFilename,
};
