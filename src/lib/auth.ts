// auth.ts — admin session cookie (HMAC-signed) + constant-time password check.
// The MCP endpoint keeps its own MCP_ACCESS_TOKEN; /api/health stays public.
import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "admin_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function secret(): string {
  return `${process.env.ADMIN_PASSWORD || ""}|${process.env.ENCRYPTION_KEY || ""}`;
}

export function signSession(): { token: string; maxAge: number } {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `admin.${exp}`;
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return { token: `${payload}.${sig}`, maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

export function verifySession(token: string | undefined | null): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [prefix, expStr, sig] = parts;
  const payload = `${prefix}.${expStr}`;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Route-level guard: takes the raw admin_session cookie value.
export function requireAdmin(token: string | undefined | null): boolean {
  return verifySession(token);
}

export function passwordConfigured(): boolean {
  return !!process.env.ADMIN_PASSWORD;
}

export function checkPassword(pw: string | undefined): boolean {
  if (!pw || !process.env.ADMIN_PASSWORD) return false;
  const a = Buffer.from(pw);
  const b = Buffer.from(process.env.ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Constant-time MCP bearer check for /mcp when MCP_ACCESS_TOKEN is set.
export function mcpAuthorized(headerValue: string | null): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  const expected = `Bearer ${token}`;
  const a = Buffer.from(headerValue || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
