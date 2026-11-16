// Shared, side-effect-free helpers for the repurpose pipeline. Kept out of the
// "use server" action files so both the synchronous actions and the async
// completion-side distributor can import them.

// Platforms accepted by social_posts.platform CHECK — only these can be
// auto-distributed.
export const DISTRIBUTABLE_PLATFORMS = new Set([
  "facebook",
  "instagram",
  "linkedin",
  "twitter",
  "tiktok",
  "youtube",
  "pinterest",
  "google_business",
])

export function extractHashtags(text: string): string[] {
  const matches = text.match(/#[\p{L}0-9_]+/gu) ?? []
  return Array.from(new Set(matches.map((h) => h.slice(1)))).slice(0, 15)
}

// ── WAVE 153 (lane 153P — owner B9 "refurbish"): REFURBISHED CONTENT KEEPS LINEAGE AND LICENSE ─────────────────────────────
// Measured at base 1ef5df85: the four "paste a URL" refurbish doors (repurposeVideoUrl, repurposeUrlToBrandedVideo,
// repurposeUrlToBlogPost, repurposeUrlToPodcast — lib/repurpose/actions.ts) took ANY public URL — someone else's video,
// podcast or article — and re-published it (or a rewrite of it) under the tenant's brand with no record of whose it was. A
// tenant-owned source (a row of this brokerage's own video / podcast / blog / script) carries its lineage and licence by
// ownership; an EXTERNAL URL is refused unless the person running it states the basis they hold (their own content
// published elsewhere, or a licence) — and that statement is stored on the run as its lineage. PURE.
export const REFURBISH_RIGHTS_BASES = ["own_content", "licensed"] as const
export type RefurbishRightsBasis = (typeof REFURBISH_RIGHTS_BASES)[number]

export type RefurbishVerdict =
  | { allowed: true; lineage: string; license: "tenant_owned" | RefurbishRightsBasis }
  | { allowed: false; reason: "no_lineage" | "no_license"; message: string }

export function assessRefurbishSource(i: { sourceType: string; ownedSourceId: string | null; sourceUrl: string | null; rightsBasis: string | null | undefined }): RefurbishVerdict {
  if (i.ownedSourceId) return { allowed: true, lineage: `${i.sourceType}:${i.ownedSourceId}`, license: "tenant_owned" }
  const url = i.sourceUrl?.trim() || null
  if (!url) return { allowed: false, reason: "no_lineage", message: "No source to refurbish — pick your own content or paste the original's URL." }
  if (!(REFURBISH_RIGHTS_BASES as readonly string[]).includes(String(i.rightsBasis ?? ""))) {
    return { allowed: false, reason: "no_license", message: "Confirm you own this content or hold a licence to reuse it — an external source is not refurbished without one." }
  }
  return { allowed: true, lineage: `url:${url}`, license: i.rightsBasis as RefurbishRightsBasis }
}
