// lib/marketing/image-library.ts
// ─────────────────────────────────────────────────────────────────────────────
// SHARED IMAGE LIBRARY — stock photos + AI stills, for the PLATFORM and every
// TENANT, on the EXISTING marketing_assets rail (no parallel table). The video
// "stock library" (video_assets) and AI image generation (gpt-image-1 →
// marketing_assets) already existed; what was missing:
//   1. a licensed STOCK-PHOTO search (Pexels, creds-gated — we never scrape or
//      fabricate imagery; every saved photo carries its license + photographer
//      attribution in metadata),
//   2. PLATFORM-scoped shared assets (visibility_scope='platform',
//      brokerage_id NULL — migration l24-s01) that every tenant can browse —
//      the platform curates once, the whole fleet reuses,
//   3. one list that unions "mine" + "platform-shared" for pickers (reel
//      slideshows, video backgrounds, social posts).
// Pexels license (pexels.com/license): free for commercial use, no attribution
// required — we store attribution anyway because taste and audits both like it.

export interface LibraryImage {
  url: string
  thumbnailUrl: string
  alt: string
  photographer: string | null
  photographerUrl: string | null
  /** Where the pixels came from — provable provenance, never a mystery JPEG. */
  source: "stock:pexels" | "ai_image" | "upload" | "unknown"
  licenseNote: string | null
}

/** PURE: normalize one Pexels /v1/search photo into the library shape. */
export function normalizePexelsPhoto(p: {
  src?: { large2x?: string; large?: string; medium?: string }
  alt?: string | null
  photographer?: string | null
  photographer_url?: string | null
}): LibraryImage | null {
  const url = p.src?.large2x ?? p.src?.large ?? null
  if (!url) return null
  return {
    url,
    thumbnailUrl: p.src?.medium ?? url,
    alt: (p.alt ?? "").slice(0, 200),
    photographer: p.photographer ?? null,
    photographerUrl: p.photographer_url ?? null,
    source: "stock:pexels",
    licenseNote: "Pexels license — free for commercial use, modification allowed",
  }
}

/** PURE: may this SOURCE be shared platform-wide (redistributed to every tenant)?
 *  LICENSE LINE: Pexels lets each USER use photos commercially, but forbids
 *  redistributing them as your own stock collection — so a tenant picking a
 *  Pexels photo for THEIR OWN use is fine (tenant scope), while the PLATFORM
 *  pushing Pexels photos to all tenants is not. Platform-shared rows must be
 *  platform-OWNED content: AI-generated, own uploads/renders, or assets
 *  explicitly licensed for redistribution. */
export function canShareToTenants(source: string | null | undefined): boolean {
  return source === "ai_image" || source === "upload" || source === "owned" || source === "licensed_redistribution"
}

/** PURE: validate a save-to-library request. Platform scope carries no brokerage
 *  and only accepts redistributable sources (see canShareToTenants). */
export function validateLibrarySave(input: {
  name?: string | null
  url?: string | null
  scope?: string | null
  source?: string | null
}): { ok: true; name: string; url: string; scope: "platform" | "brokerage" } | { ok: false; error: string } {
  const name = (input.name ?? "").trim()
  const url = (input.url ?? "").trim()
  const scope = input.scope === "platform" ? "platform" : input.scope === "brokerage" ? "brokerage" : null
  if (!name) return { ok: false, error: "A name is required" }
  if (!/^https?:\/\/.+/.test(url)) return { ok: false, error: "A valid image URL is required" }
  if (!scope) return { ok: false, error: "scope must be 'platform' or 'brokerage'" }
  if (scope === "platform" && !canShareToTenants(input.source)) {
    return { ok: false, error: "Stock photos can't be shared platform-wide — the stock license covers each user's own use, not redistribution. Each tenant can search stock themselves; share only AI-generated or platform-owned images." }
  }
  return { ok: true, name: name.slice(0, 160), url, scope }
}

/** Creds-gated Pexels search. Key resolution is TWO-RAIL: the tenant's own key
 *  (platform_credentials, added in Settings → Stock Library — their license,
 *  their use) wins; the platform env key is the fallback. Honest "not
 *  configured" when neither exists. */
export async function searchPexels(
  query: string, perPage = 12, apiKeyOverride?: string | null,
  /** Wave 139 (139B): the caller's SESSION tenant — rides the gateway call onto api_response_logs. */
  brokerageId?: string | null,
): Promise<{ ok: true; images: LibraryImage[] } | { ok: false; error: string; notConfigured?: boolean }> {
  const key = apiKeyOverride || process.env.PEXELS_API_KEY
  if (!key) return { ok: false, error: "Stock search not configured — add your Pexels API key in Settings → Stock Library (or the platform can set PEXELS_API_KEY).", notConfigured: true }
  const q = query.trim()
  if (q.length < 2) return { ok: false, error: "Give the search at least 2 characters." }
  // The ONE Pexels egress — through the connector gateway (wave 139, lane 139B: was a raw fetch).
  // Free API (no spend to book); the gateway's api_response_logs row is the per-tenant usage +
  // health record, and its timeout / GET retry replace the bare fetch's none. Never throws.
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<{ photos?: unknown[] }>({
    connector: "pexels", brokerageId: brokerageId ?? null,
    baseUrl: "https://api.pexels.com/v1", path: "search",
    query: { query: q, per_page: String(Math.min(30, Math.max(1, perPage))) },
    auth: { style: "header", name: "Authorization", value: key },
  })
  if (!res.ok) return { ok: false, error: res.status ? `Pexels search failed (${res.status})` : (res.error ?? "Pexels search failed") }
  const images = (((res.data?.photos) ?? []) as any[]).map(normalizePexelsPhoto).filter(Boolean) as LibraryImage[]
  return { ok: true, images }
}
