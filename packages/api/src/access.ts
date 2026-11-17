// Who may call what. API Gateway has already checked the Cognito token (signature, expiry, our app client); the
// pool is shared and anyone can sign up to it, so the user must also be in one of this stage's groups.
// FULL_ACCESS_GROUPS may do everything; READ_ONLY_GROUPS (the test user's, off prod only) may only read: the tests
// must never start, stop or change the real instance (docs/development.md).

type Claims = Record<string, string | number | boolean | string[]> | undefined;

/** `cognito:groups` as a list. HTTP API passes array claims flattened to a string, e.g. "[a b]". */
export function groupsOf(claims: Claims): string[] {
  const raw = claims?.["cognito:groups"];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const s = raw.trim();
  if (s.startsWith('["')) {
    try {
      return JSON.parse(s) as string[];
    } catch {
      /* fall through */
    }
  }
  return s
    .replace(/^\[|\]$/g, "")
    .split(/[\s,]+/)
    .filter(Boolean);
}

export type Access = "full" | "read" | "none";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function accessOf(claims: Claims, env: Record<string, string | undefined> = process.env): Access {
  const groups = groupsOf(claims);
  if (groups.some((g) => list(env["FULL_ACCESS_GROUPS"]).includes(g))) return "full";
  if (groups.some((g) => list(env["READ_ONLY_GROUPS"]).includes(g))) return "read";
  return "none";
}
