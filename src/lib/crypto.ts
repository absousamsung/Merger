// crypto.ts — optional AES-256-GCM encryption at rest for API keys.
// Without ENCRYPTION_KEY values are stored as-is (documented trade-off).
// Mask/fingerprint are computed from plaintext at insert time so display and
// duplicate checks NEVER depend on decryption being available.
import crypto from "node:crypto";

function keyFromEnv(): Buffer | null {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) return null;
  try {
    const raw = Buffer.from(k, "base64");
    if (raw.length === 32) return raw;
  } catch {
    /* fallthrough */
  }
  // Tolerate a non-base64 passphrase by deriving a stable 32-byte key.
  return crypto.createHash("sha256").update(k).digest();
}

export function encryptSecret(plain: string): string {
  const key = keyFromEnv();
  if (!key) return plain;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return "enc1:" + [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
  } catch {
    return plain;
  }
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith("enc1:")) return stored;
  const key = keyFromEnv();
  if (!key) return stored; // cannot decrypt in this environment; caller will see an auth failure
  try {
    const [ivB, tagB, dataB] = stored.slice(5).split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return stored;
  }
}

export function fingerprint(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

// ABCD123••••••••WXYZ ; short keys: ABC••••
export function maskKey(plain: string): string {
  if (plain.length >= 14) return plain.slice(0, 7) + "••••••••" + plain.slice(-4);
  if (plain.length >= 6) return plain.slice(0, 3) + "••••";
  return "•".repeat(Math.max(4, plain.length));
}
