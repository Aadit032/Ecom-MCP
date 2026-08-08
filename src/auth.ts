/**
 * Write-path guardrail: secret token for mutative MCP tools.
 * Set WRITE_TOKEN in the environment (see .env.example).
 */
import { timingSafeEqual } from "node:crypto";

export function getWriteToken(): string | undefined {
  const t = process.env.WRITE_TOKEN;
  return t && t.length > 0 ? t : undefined;
}

/**
 * Validate a caller-supplied write token against WRITE_TOKEN.
 * Uses constant-time comparison when lengths match.
 */
export function assertWriteToken(
  token: string | undefined | null,
): { ok: true } | { ok: false; message: string } {
  const expected = getWriteToken();
  if (!expected) {
    return {
      ok: false,
      message: "Unauthorized: server WRITE_TOKEN is not configured. Set WRITE_TOKEN in the environment.",
    };
  }
  if (token == null || token === "") {
    return {
      ok: false,
      message: "Unauthorized: missing write token. Pass the secret token required for write tools.",
    };
  }

  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      ok: false,
      message: "Unauthorized: invalid write token.",
    };
  }
  return { ok: true };
}
