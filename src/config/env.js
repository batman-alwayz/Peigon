const { z } = require("zod");

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  STORAGE_PATH: z.string().min(1).optional(),
  FRONTEND_URL: z.string().optional(),
  TICKET_SECRET: z.string().min(32).optional(),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
});

function validateEnvironment(env = process.env) {
  return envSchema.parse(env);
}

module.exports = { validateEnvironment };
