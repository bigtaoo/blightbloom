/**
 * A request body's `chapterId` (2026-10-06) — how `/find` and `/party/start` read the PvE
 * chapter a co-op player or party host chose. One reader, so both routes apply one policy.
 *
 * ## The policy: absent is the first chapter, unknown is refused
 *
 * **Absent → `DEFAULT_CHAPTER_ID`.** Every client older than chapters sends no field at all,
 * and the only chapter it can build is the first one, so that is the honest reading of
 * silence — and it keeps every such client queueing exactly as it did.
 *
 * **Present but not a chapter this server's catalog knows → `null`, which the routes answer
 * with 400.** Not quietly defaulted, for the reason `/find` already refuses a party asking
 * for the wrong mode: the player asked for a specific dungeon, and seating them in a
 * different one is a wrong answer that looks like a right one. The legitimate way to send an
 * unknown id is a client deployed ahead of this server (`client-deploy` and `server-deploy`
 * both run on a push to `main`, not atomically), and for that player a visible failure they
 * can retry in a minute beats a run in a chapter they did not pick — whose clear would also
 * credit the wrong chapter's unlock. The other way is a hand-made request, which deserves
 * nothing better. `null` (JSON's only spelling of "explicitly nothing") is refused the same
 * way: it is a field that is present and is not a chapter.
 */
import { DEFAULT_CHAPTER_ID, isChapterId, type ChapterId } from '@dd/engine';

/** The chapter `raw` names, the first chapter when it is absent, or `null` to refuse. */
export function readChapterField(raw: unknown): ChapterId | null {
  if (raw === undefined) return DEFAULT_CHAPTER_ID;
  return isChapterId(raw) ? raw : null;
}

/** The error body both routes refuse an unknown chapter with. */
export const UNKNOWN_CHAPTER = { error: 'unknown chapter' } as const;
