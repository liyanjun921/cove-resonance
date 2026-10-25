import { timingSafeEqual } from "node:crypto";

export type AccessDecision = "allowed" | "not_configured" | "unauthorized";

/**
 * Fail closed in production. Local development may omit a token when explicitly
 * running outside NODE_ENV=production; never use this mode on a public host.
 */
export function checkBearerAccess(
  authorization: string | undefined,
  configuredToken: string | undefined,
  production: boolean,
): AccessDecision {
  const expected = configuredToken?.trim() ?? "";
  if (!expected) return production ? "not_configured" : "allowed";

  if (!authorization?.startsWith("Bearer ")) return "unauthorized";
  const candidate = authorization.slice("Bearer ".length);
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return "unauthorized";
  return timingSafeEqual(left, right) ? "allowed" : "unauthorized";
}
