// lib/did/context-markers.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE GRAMMAR FOR D-ID CONTEXT MARKERS (wave 79, lane E — orphan doctrine §1.1).
//
// D-ID's Agents API passes no metadata of its own, so the widget prefixes its
// FIRST turn with a marker the custom-LLM route (app/api/did/custom-llm) parses
// and strips before the model sees the text. Three markers exist, one per
// deployment identity:
//   · [[CTX:contactId=<uuid>]]             — a known tenant contact (portal/website)
//   · [[CTX:embedSessionId=<uuid>]]        — an anonymous tenant embed_sessions row
//   · [[CTX:platformLiveSessionId=<uuid>]] — the platform's own live_agent_sessions row
//
// BEFORE THIS FILE the grammar lived in three places: the builders as inline
// template literals in app/embed/[publicId]/embed-widget.tsx, two of the three
// regexes as file-local consts in the custom-LLM route, and the platform pair in
// lib/did/platform-live-agent.ts (`platformLiveSessionMarker`, which the
// orphan-export census filed as proof-only because the widget re-spelt the
// string by hand instead of calling it). Two spellings of one marker is the §6
// defect — a widget that drifts from the route's regex silently loses its
// identity and the turn is refused as anonymous. The builder and its regex now
// sit side by side so they cannot drift apart.
//
// PURE — no imports, no "server-only" — because the widget is a client
// component and lib/did/platform-live-agent.ts (the previous home) is a
// server module the client bundle cannot load.
// ─────────────────────────────────────────────────────────────────────────────

const UUID = "([0-9a-f-]{36})"

/** A known tenant contact — the portal / website deployment. */
export const CONTACT_CTX_RE = new RegExp(`\\[\\[CTX:contactId=${UUID}\\]\\]\\s*`, "gi")
export function contactMarker(contactId: string): string {
  return `[[CTX:contactId=${contactId}]]`
}

/** An anonymous tenant visitor — an embed_sessions row minted by /api/embed/session. */
export const EMBED_CTX_RE = new RegExp(`\\[\\[CTX:embedSessionId=${UUID}\\]\\]\\s*`, "gi")
export function embedSessionMarker(embedSessionId: string): string {
  return `[[CTX:embedSessionId=${embedSessionId}]]`
}

/** The platform's own live agent — a live_agent_sessions row under the showcase
 *  tenant, minted by /api/platform/live-agent/session. The ONLY platform handle
 *  in a D-ID payload. */
export const PLATFORM_LIVE_CTX_RE = new RegExp(`\\[\\[CTX:platformLiveSessionId=${UUID}\\]\\]\\s*`, "gi")
export function platformLiveSessionMarker(liveSessionId: string): string {
  return `[[CTX:platformLiveSessionId=${liveSessionId}]]`
}
