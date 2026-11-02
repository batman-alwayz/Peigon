const { z } = require("zod");

const EXPIRY_OPTIONS = [10, 60, 1440];
const DOWNLOAD_OPTIONS = [1, 3, 10];

const uploadSchema = z.object({
  expiryMinutes: z.coerce
    .number()
    .refine((value) => EXPIRY_OPTIONS.includes(value)),
  maxDownloads: z.coerce
    .number()
    .refine((value) => DOWNLOAD_OPTIONS.includes(value)),
  password: z
    .string()
    .max(128)
    .refine((value) => value.length === 0 || value.length >= 4)
    .optional()
    .default(""),
  encryptedName: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .min(1)
    .max(1024)
    .optional(),
});

const unlockSchema = z.object({
  password: z.string().max(128).optional().default(""),
});

module.exports = { uploadSchema, unlockSchema };
