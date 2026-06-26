// lib/ai-isa/portal-link.ts
// ─────────────────────────────────────────────────────────────────────────────
// EVERY TOUCH DRIVES BACK TO THE PORTAL — the contact's portal is the home base (their
// matches, their journey, their value, their videos in one place). Outbound material
// (email/voice/video) routes them there, so the relationship compounds in OUR portal rather
// than leaking to a competitor's. This is the differentiator vs RealScout/Lofty: the AI team
// isn't just messaging — it's pulling the client back to a living, personalized portal.
//
// PURE. The contact's portal home is `/portal/<contactId>`; sections hang off it.

/** Origin (no trailing slash). Defaults to NEXT_PUBLIC_APP_URL when not supplied. */
function resolveOrigin(origin?: string | null): string {
  const o = (origin ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim()
  return o.replace(/\/+$/, "")
}

/** buildContactPortalUrl — PURE. The contact's portal URL (optionally a section). */
export function buildContactPortalUrl(contactId: string, section?: string | null, origin?: string | null): string {
  const base = `${resolveOrigin(origin)}/portal/${contactId}`
  if (!section) return base
  return `${base}/${String(section).replace(/^\/+/, "")}`
}

/** An HTML "back to your portal" CTA button to append to an outbound email body. */
export function portalCtaHtml(contactId: string, origin?: string | null, label = "Open your portal"): string {
  const url = buildContactPortalUrl(contactId, null, origin)
  return (
    `<div style="margin:24px 0;text-align:center;">` +
    `<a href="${url}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;` +
    `padding:12px 22px;border-radius:8px;font-weight:600;">${label} →</a>` +
    `<div style="margin-top:6px;font-size:12px;color:#6b7280;">Your matches, journey, and updates — all in one place.</div>` +
    `</div>`
  )
}
