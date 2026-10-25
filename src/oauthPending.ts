import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * An opaque, authenticated authorization-request envelope.
 * OAuth consent pages can survive a free-instance restart without persisting
 * sensitive redirect and PKCE challenge parameters in the page itself.
 */
function keyFor(secret: string): Buffer {
  return createHash("sha256")
    .update("cove:oauth:pending:v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

export function sealPendingRequest<T extends { created: number }>(
  data: T,
  signingSecret: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(signingSecret), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final(),
  ]);
  return ["v1", iv.toString("base64url"), encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url")].join(".");
}

export function unsealPendingRequest<T extends { created: number }>(
  token: string,
  signingSecret: string,
  maxAgeMs: number,
  now = Date.now(),
): T | null {
  if (typeof token !== "string" || token.length < 30 || token.length > 8192 ||
      !/^[A-Za-z0-9_.-]+$/.test(token)) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const encrypted = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyFor(signingSecret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const payload = JSON.parse(plaintext.toString("utf8")) as T;
    if (typeof payload?.created !== "number" ||
        !Number.isFinite(payload.created) ||
        payload.created > now + 60_000 ||
        now - payload.created > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}
