/**
 * lib/direct-mail/unsubscribe-token.ts
 *
 * THE PER-RECIPIENT OPT-OUT TOKEN — the thing a person holding a postcard can
 * type, and the ONLY credential the public mail-unsubscribe surface accepts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A TOKEN AND NOT AN ID (the whole point of this file)
 *
 * The pre-existing surface (`/unsubscribe?contactId=…`) uses an ENTITY ID as its
 * only credential. An entity id is not a secret and cannot be made one: it is a
 * lookup key, so it is in dashboard URLs, CSV exports, webhook payloads, server
 * logs, and — decisively — in the footer of every marketing email the product
 * sends. FORWARD ONE OF THOSE EMAILS and the person you forwarded it to holds a
 * working, permanent, unauthenticated suppression capability for the original
 * addressee, and the compliance ledger will record the result as that person's
 * own request. An id also cannot be rotated (rotating it breaks the entity) and
 * cannot be scoped (it names the whole row, not one channel of one mail piece).
 *
 * A token fixes each of those properties independently:
 *   · it is minted for ONE purpose, so it appears in exactly one place;
 *   · it names one RECIPIENT ROW — one person on one campaign — so its blast
 *     radius is one mail piece, not one CRM record;
 *   · its use is stamped on that row, so "who opted out, off which piece" is
 *     answerable — which is literally the owner's ruling;
 *   · it can be rotated by updating one column.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS ALPHABET AND THIS LENGTH
 *
 * This token is READ OFF PAPER AND TYPED BY A HUMAN. That is a harder constraint
 * than a click-through token and it drives every choice here:
 *
 *   · CROCKFORD BASE32, i.e. 0-9 A-Z minus I, L, O and U. I/1, L/1 and O/0 are
 *     the pairs people mistype off print; U is dropped so a random draw cannot
 *     spell something the brokerage has to apologise for.
 *   · 14 CHARACTERS = 70 BITS. Each character is 5 bits, and the migration draws
 *     each one from a whole random byte reduced mod 32 — 256 is an exact multiple
 *     of 32, so the reduction is unbiased and all 70 bits are real. 70 bits is
 *     not a compromise for print: guessing one live token at 100 attempts/second
 *     is ~10^11 years, and the surface is rate-limited on top of that.
 *   · CASE-INSENSITIVE, and normalisation folds the confusable pairs INTO the
 *     alphabet rather than rejecting them. Someone who types "o" where the card
 *     printed "0" gets unsubscribed, not an error page. An opt-out surface that
 *     punishes a typo is an opt-out surface that does not work.
 *   · Printed in 3 groups of 4-5 (`K7M2-NP4R-Q8TVW`) because that is how people
 *     copy digits accurately; the hyphens are decorative and normalisation eats
 *     them.
 *
 * URL LENGTH, measured — this is the constraint the ruling actually imposes,
 * because the string has to fit on a 4x6 postcard back next to the indicia:
 *   vipagentos.com/unsubscribe/K7M2NP4RQ8TVWX   → 42 chars
 *   vipagentos.com/u/K7M2NP4RQ8TVWX             → 31 chars  (short alias)
 * Both print. The short alias needs a route this lane does not own; see the
 * report. The canonical form works today.
 *
 * PURE MODULE — no server-only, no supabase, no next/*. It is imported by the
 * route handler, by the client component that echoes the token back, and by
 * scripts/mail-unsubscribe-simulator.ts, which is why it can be proven offline.
 */

/**
 * Crockford Base32. Deliberately NOT the RFC 4648 alphabet: this string is
 * typed by hand off a printed card, and RFC 4648 keeps I, L and O.
 *
 * MUST stay byte-for-byte identical to the alphabet in the m493 migration's
 * `direct_mail_unsubscribe_token()` generator. A drift between the two means the
 * database mints tokens this module then rejects as malformed, which would look
 * exactly like "the unsubscribe link is broken" — the defect being repaired.
 */
export const MAIL_UNSUB_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** Characters per token. 14 x 5 bits = 70 bits of entropy. */
export const MAIL_UNSUB_TOKEN_LENGTH = 14

/**
 * Fold the pairs people mistype off print INTO the alphabet.
 * Crockford's own rule: O reads as 0, I and L read as 1. U is not remapped —
 * it is simply absent, so a token containing one is malformed and says so.
 */
const CONFUSABLES: Record<string, string> = { O: "0", I: "1", L: "1" }

/**
 * normalizeMailUnsubToken — turn what a human typed into the canonical token.
 *
 * Accepts the printed grouped form (`k7m2-np4r-q8tvw`), lower case, stray
 * spaces, and the confusable characters. Returns the canonical uppercase
 * 14-character string, or null when what remains is not a token.
 *
 * Total function: never throws, and returns null rather than a partial token,
 * so a caller cannot accidentally look up a truncated value.
 */
export function normalizeMailUnsubToken(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null

  let out = ""
  for (const ch of raw.toUpperCase()) {
    // Separators people add or the print adds for them.
    if (ch === "-" || ch === " " || ch === "_" || ch === "–" || ch === "—") continue
    const folded = CONFUSABLES[ch] ?? ch
    if (!MAIL_UNSUB_ALPHABET.includes(folded)) return null   // any real junk → not a token
    out += folded
    if (out.length > MAIL_UNSUB_TOKEN_LENGTH) return null    // reject early, don't truncate
  }

  return out.length === MAIL_UNSUB_TOKEN_LENGTH ? out : null
}

/** True when `raw` normalises to a well-formed token. Shape only — says nothing about existence. */
export function isMailUnsubTokenShaped(raw: string | null | undefined): boolean {
  return normalizeMailUnsubToken(raw) !== null
}

/**
 * formatMailUnsubTokenForPrint — the grouped form that goes on the card.
 * 14 characters split 5/5/4: `K7M2NP4RQ8TVWX` → `K7M2N-P4RQ8-TVWX`.
 * Groups are for the human eye only; normalisation removes them again, so the
 * printed form and the canonical form resolve to the same recipient.
 */
export function formatMailUnsubTokenForPrint(token: string): string {
  const t = normalizeMailUnsubToken(token)
  if (!t) return token
  return `${t.slice(0, 5)}-${t.slice(5, 10)}-${t.slice(10)}`
}

/**
 * buildMailUnsubscribeUrl — the canonical public URL for a token.
 *
 * `baseUrl` defaults to the same env var the email footer already uses
 * (`NEXT_PUBLIC_APP_URL`) with the same fallback, so the printed link and the
 * emailed link never disagree about which host serves this product.
 */
export function buildMailUnsubscribeUrl(token: string, baseUrl?: string): string {
  const base = (baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://app.vipagentos.com").replace(/\/+$/, "")
  const t = normalizeMailUnsubToken(token) ?? token
  return `${base}/unsubscribe/${t}`
}

/**
 * mailOptOutPrintLine — the exact sentence to print on the mail piece.
 *
 * Kept here, next to the token, so the wording and the URL cannot drift apart in
 * two files. Deliberately short: it competes for space with the indicia keep-out
 * zone on a 4x6 back. Host is shown without the scheme because nobody types
 * "https://" off a postcard.
 */
export function mailOptOutPrintLine(token: string, baseUrl?: string): string {
  const url = buildMailUnsubscribeUrl(token, baseUrl).replace(/^https?:\/\//, "")
  return `To stop receiving mail: ${url}`
}
