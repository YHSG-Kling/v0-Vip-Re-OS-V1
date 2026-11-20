/**
 * lib/platform/site-url.ts
 *
 * THE ONE PUBLIC-ORIGIN RESOLVER (owner rule: the domain is not decided —
 * it must never be hardcoded). Four routes (sitemap, robots, llms.txt,
 * /v/[slug]) and the citation monitor each carried their own copy of this
 * function with a hardcoded fallback domain baked in; keep-one, env-only:
 *
 *   1. NEXT_PUBLIC_APP_URL — the explicit production origin (the go-live
 *      gate already requires it).
 *   2. VERCEL_URL — the deployment's own host (previews work unconfigured).
 *   3. "" — relative URLs in bare dev; never an invented domain.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/$/, "")
  const vercel = process.env.VERCEL_URL
  if (vercel && vercel.trim()) return `https://${vercel.trim().replace(/\/$/, "")}`
  return ""
}

/**
 * THE ONE INVITATION LANDING (wave 143, lane 143G). Every Supabase auth invite a tenant seat is sent lands on
 * /auth/callback?next=/dashboard/onboarding — the ONLY place the invite's code is exchanged for a session AND the
 * user_invitations row is marked accepted (lib/onboarding/state-machine.ts acceptUserInvitationOnFirstLogin).
 * Six seat-door call sites each built the link from a bare `${process.env.NEXT_PUBLIC_APP_URL}` template in TWO spellings:
 * four landed on /auth/callback?next=…, but the tenant invite door (lib/kernel/users.ts inviteTenantMember default) and the
 * recruiting door sent the invitee straight to /dashboard/onboarding — skipping the callback, so their invitation stayed
 * `pending` until it expired and the brokerage's onboarding never advanced on a first non-admin acceptance. Unset, the raw
 * template is the literal string "undefined/…".
 * undefined when no origin is known (bare dev): the auth provider then uses the project's configured Site URL —
 * a relative or "undefined/…" redirect is never sent.
 */
export function invitationLandingUrl(): string | undefined {
  const origin = siteUrl()
  return origin ? `${origin}/auth/callback?next=/dashboard/onboarding` : undefined
}
