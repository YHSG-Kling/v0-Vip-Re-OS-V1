'use strict'

/**
 * app/types/auth.ts — the MAGIC-LINK MESSAGE RAIL.
 *
 * WHAT WAS BROKEN (measured 2026-08-29, orphan-doctrine lane K4)
 * ─────────────────────────────────────────────────────────────
 * This module had ZERO importers, and inside it sat the READER-LESS half of a
 * live redirect contract. Four writers push a message code into the URL —
 *
 *   app/auth/callback/route.ts:23  `/login?message=${message}`   (link-expired / link-used / error)
 *   app/auth/callback/route.ts:29  `/login?message=error`        (no code in the callback)
 *   app/auth/callback/route.ts:38  `/login?message=${message}`   (handleAuthCallback refused)
 *   app/auth/error/page.tsx:14     `/login?message=${…}`         (superseded page's forward)
 *
 * — and `app/login/page.tsx` read only `?error=`. It never read `?message=` at
 * all. So a user who clicked an EXPIRED magic link was bounced to /login and
 * shown NOTHING: no explanation, no instruction to request a new link, just the
 * form again. The vocabulary that explains the bounce was sitting right here,
 * spelled out, and no reader had ever been built for it.
 *
 * `MagicLinkMessage` is now that one vocabulary (CLAUDE.md §6) and it carries its
 * own display copy, so the writers, the reader and the wording cannot drift into
 * three spellings again. `toMagicLinkMessage` is the narrowing gate: an unknown
 * `?message=` value resolves to null and renders nothing, rather than echoing
 * arbitrary query text back at the user as if the product had said it.
 *
 * TOMBSTONES (§1.3 — this module was a parallel auth vocabulary; the same wave
 * that deleted `AUTH_ERROR_CODES` from app/constants/auth.ts:487 named the same
 * survivors):
 *   · `SignInRequest` / `SignInResponse` — DELETED. SURVIVOR:
 *     app/actions/auth.ts:39 `AuthActionResult` + `loginUser`, the discriminated
 *     union the login form actually calls. `SignInResponse` was the flat
 *     `{ success, message?, error? }` shape — it cannot express "failed, and
 *     here is why" without a second nullable read, which is why nothing adopted it.
 *   · `SessionValidation` — DELETED. SURVIVOR: lib/kernel/api-auth.ts:19
 *     `AuthResult` / `AuthFailure`, returned by `requireAuth`, the guard every
 *     API route runs. `SessionValidation.roles?: string[]` could not have been
 *     right in any case: staff identity on this database is DUAL-COLUMN
 *     (`user_type` + `platform_role`, CLAUDE.md §4) and `AuthResult` carries both.
 *   · `MagicLinkState` — DELETED. SURVIVOR: `MagicLinkMessage` below, now wired
 *     at app/login/page.tsx. The state BAG was never adopted (the login page
 *     holds email/message/error/isLoading as four separate `useState` hooks);
 *     the VOCABULARY inside it was the half worth keeping, and it is now live.
 */

export type AuthStatus = 'idle' | 'loading' | 'success' | 'error' | 'checking'

export interface AuthError {
  message: string
  code?: string
  details?: string
}

export interface SessionData {
  user: {
    id: string
    email: string
    created_at: string
  }
  session: {
    access_token: string
    refresh_token: string
    expires_at: number
  }
}

export interface AuthState {
  status: AuthStatus
  user: SessionData['user'] | null
  session: SessionData['session'] | null
  error: AuthError | null
  isAuthenticated: boolean
}

// ── MAGIC-LINK MESSAGE VOCABULARY ───────────────────────────────────────────
// The only spelling of a magic-link outcome. Writers put one of these in
// `/login?message=…`; the login page reads it back through toMagicLinkMessage.

export const MAGIC_LINK_MESSAGES = [
  'check-email',
  'link-expired',
  'link-used',
  'invalid-session',
  'session-expired',
  'error',
] as const

export type MagicLinkMessage = (typeof MAGIC_LINK_MESSAGES)[number]

/** The only magic-link wording the UI may use. */
export const MAGIC_LINK_MESSAGE_COPY: Record<MagicLinkMessage, string> = {
  'check-email':     'Check your email for the magic link.',
  'link-expired':    'That sign-in link has expired. Request a new one below.',
  'link-used':       'That sign-in link has already been used. Request a new one below.',
  'invalid-session': 'That sign-in session is no longer valid. Please sign in again.',
  'session-expired': 'Your session expired. Please sign in again.',
  error:             'We could not complete that sign-in. Please try again.',
}

/**
 * Narrow an arbitrary `?message=` value onto the vocabulary.
 *
 * FAIL CLOSED (CLAUDE.md §4): a value that is not in the roster returns null and
 * renders nothing. The alternative — echoing the raw query string — would let any
 * link put words in the product's mouth on its own login page, and would also
 * surface raw provider error codes ('otp_expired', 'flow_state_not_found') to a
 * user who cannot act on them.
 */
export function toMagicLinkMessage(raw: string | null | undefined): MagicLinkMessage | null {
  if (!raw) return null
  const v = decodeURIComponent(raw).trim()
  return (MAGIC_LINK_MESSAGES as readonly string[]).includes(v) ? (v as MagicLinkMessage) : null
}
