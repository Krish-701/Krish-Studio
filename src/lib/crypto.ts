import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

// API keys are stored encrypted at rest when SETTINGS_SECRET is set.
const PREFIX = "enc:v1:";

function key() {
  const s = process.env.SETTINGS_SECRET;
  return s ? createHash("sha256").update(s).digest() : null;
}

export function encryptSecret(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const k = key();
  if (!k) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) return stored;
  const k = key();
  if (!k) return null;
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const d = createDecipheriv("aes-256-gcm", k, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

export function maskSecret(s: string | null | undefined) {
  if (!s) return "";
  return s.length <= 8 ? "••••" : `${s.slice(0, 4)}••••${s.slice(-4)}`;
}
