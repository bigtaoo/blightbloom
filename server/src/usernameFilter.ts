/**
 * Local username blacklist (design/16-accounts.md) — no external content-moderation
 * service is configured for this project (no WeChat appid/secret for `msgSecCheck`
 * anywhere in this repo), so this is a small local reserved-word/profanity list rather
 * than a real-time API check. Purely additive to `AuthService.register`'s existing
 * charset/length validation; swapping in a real moderation API later is a caller-side
 * change to `isBlockedUsername` only, not a schema/protocol change.
 *
 * Matching is case-insensitive and substring-based (a blocked word anywhere in the
 * name is rejected, e.g. `xxadminxx`) — deliberately permissive-to-reject, since a
 * false-positive here just means "pick a different username," while a false-negative
 * lets a reserved/impersonation-style name through.
 */
const RESERVED_NAMES = [
  'admin', 'administrator', 'root', 'system', 'sysadmin', 'moderator', 'mod',
  'support', 'staff', 'official', 'gm', 'superuser', 'null', 'undefined',
  // Both brand names: 'daydayup' stays reserved after the 2026-09-06 rename, since a
  // name nobody can defend impersonating is still worth nobody being able to claim.
  'daydayup', 'blightbloom',
];

// A small, deliberately conservative starter list — first-pass profanity/slur coverage,
// not an exhaustive filter. Extend here if real players find a gap.
const BANNED_WORDS: string[] = ['fuck', 'shit', 'nigger', 'faggot', 'cunt'];

const BLOCKED = [...RESERVED_NAMES, ...BANNED_WORDS];

/** True if `username` (case-insensitive) contains a reserved name or banned word. */
export function isBlockedUsername(username: string): boolean {
  const lower = username.toLowerCase();
  return BLOCKED.some((word) => lower.includes(word));
}
