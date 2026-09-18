// lib/env/aliases.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE SPELLING PER ENV VAR (CLAUDE.md §6) — the resolvers for every name this
// repo had spelled two ways, each with its survivor and a documented fallback
// for ONE release. Written 2026-09-03 (lane H3).
//
// Why a module rather than `A ?? B` at each site: the split was never one
// site. GOOGLE_CLIENT_ID lived in three files and GOOGLE_OAUTH_CLIENT_ID in a
// fourth (lib/security/oauth-refresh.ts), so an operator who set the three-file
// spelling had a credential-rotation runner that reported "skipped_unconfigured"
// on every Google credential, forever, while the OAuth flows next to it worked.
// NEXT_PUBLIC_GOOGLE_MAPS_API_KEY drove every map but the team heatmap, which
// read NEXT_PUBLIC_GOOGLE_MAPS_KEY and was dark unless BOTH were set. A second
// spelling is a defect, not a style choice: nothing can match a writer to a
// reader across it.
//
// SURVIVORS (chosen by reader count and by the name the launch checklist /
// connector registry / tenancy matrix already document):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET       ← GOOGLE_OAUTH_CLIENT_ID / _SECRET
//   MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET ← MICROSOFT_OAUTH_CLIENT_ID / _SECRET
//   APIFY_API_TOKEN                                ← APIFY_TOKEN
//   NEXT_PUBLIC_GOOGLE_MAPS_API_KEY                ← NEXT_PUBLIC_GOOGLE_MAPS_KEY
//
// CLIENT-SAFE ON PURPOSE. app/dashboard/team-heatmap/heatmap-map.tsx is a
// "use client" module, so this file imports nothing server-only. Every read is
// a LITERAL `process.env.NEXT_PUBLIC_…` member access, which is the only form
// Next.js inlines into the browser bundle — a dynamic `process.env[name]` would
// resolve to undefined on the client and the map would go dark again.
//
// The deprecated spelling is read in exactly ONE place — here — and warns once
// per process when it is the one that resolved, so removing a fallback next
// release is a one-line delete and the warning names the exact rename.

const warned = new Set<string>()

function pick(survivor: string, survivorValue: string | undefined, deprecated: string, deprecatedValue: string | undefined): string | null {
  if (survivorValue) return survivorValue
  if (deprecatedValue) {
    if (!warned.has(deprecated)) {
      warned.add(deprecated)
      console.warn(`[env] ${deprecated} is a deprecated spelling — set ${survivor} instead; the fallback is removed next release`)
    }
    return deprecatedValue
  }
  return null
}

/** Google OAuth app credentials (Gmail, Calendar, YouTube, Business Profile). */
export function googleOAuthClient(): { clientId: string | null; clientSecret: string | null } {
  return {
    clientId:     pick("GOOGLE_CLIENT_ID",     process.env.GOOGLE_CLIENT_ID,     "GOOGLE_OAUTH_CLIENT_ID",     process.env.GOOGLE_OAUTH_CLIENT_ID),
    clientSecret: pick("GOOGLE_CLIENT_SECRET", process.env.GOOGLE_CLIENT_SECRET, "GOOGLE_OAUTH_CLIENT_SECRET", process.env.GOOGLE_OAUTH_CLIENT_SECRET),
  }
}

/** Microsoft (Graph / Outlook) OAuth app credentials. */
export function microsoftOAuthClient(): { clientId: string | null; clientSecret: string | null } {
  return {
    clientId:     pick("MICROSOFT_CLIENT_ID",     process.env.MICROSOFT_CLIENT_ID,     "MICROSOFT_OAUTH_CLIENT_ID",     process.env.MICROSOFT_OAUTH_CLIENT_ID),
    clientSecret: pick("MICROSOFT_CLIENT_SECRET", process.env.MICROSOFT_CLIENT_SECRET, "MICROSOFT_OAUTH_CLIENT_SECRET", process.env.MICROSOFT_OAUTH_CLIENT_SECRET),
  }
}

/** Apify API token (connector registry key APIFY_API_TOKEN). */
export function apifyToken(): string | null {
  return pick("APIFY_API_TOKEN", process.env.APIFY_API_TOKEN, "APIFY_TOKEN", process.env.APIFY_TOKEN)
}

/**
 * The BROWSER Google Maps key (Maps JavaScript API, Static Maps from the
 * client). Server-side callers that hold a private GOOGLE_MAPS_API_KEY should
 * prefer it and fall back to this — see lib/property/enrichment-chain.ts.
 */
export function googleMapsBrowserKey(): string | null {
  return pick("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY, "NEXT_PUBLIC_GOOGLE_MAPS_KEY", process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY)
}

/** The survivor / deprecated pairs this module resolves, for docs and guards. */
// File-local (integrator): exported with no importer, the census listed it as an orphan const.
const ENV_ALIASES = [
  { survivor: "GOOGLE_CLIENT_ID",               deprecated: "GOOGLE_OAUTH_CLIENT_ID" },
  { survivor: "GOOGLE_CLIENT_SECRET",           deprecated: "GOOGLE_OAUTH_CLIENT_SECRET" },
  { survivor: "MICROSOFT_CLIENT_ID",            deprecated: "MICROSOFT_OAUTH_CLIENT_ID" },
  { survivor: "MICROSOFT_CLIENT_SECRET",        deprecated: "MICROSOFT_OAUTH_CLIENT_SECRET" },
  { survivor: "APIFY_API_TOKEN",                deprecated: "APIFY_TOKEN" },
  { survivor: "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", deprecated: "NEXT_PUBLIC_GOOGLE_MAPS_KEY" },
] as const
