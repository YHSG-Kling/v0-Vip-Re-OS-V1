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
// podcast or article — and re-published it (or a rewrite of it) under the tenant's brand with no record of whose it was.
//
// WAVE 154 (lane 154D — owner R4: "refurbish is taking an idea that is working for a competitor or of your own content and
// putting it in the user's voice and posting"). Wave 153 answered the re-publishing defect by REFUSING every outside URL that
// had no stated own-content / license basis — which confused borrowing an IDEA with reusing an ASSET. An idea, a topic, a
// fact or a broad format is not protected expression; wording, footage, images, music and designs are. So an outside URL
// with no recorded basis is now admitted in IDEA-ONLY mode: it may supply an idea brief (provenance + what consumer
// question it answers), and NOTHING of the source may be carried — no media URL into a post, no source text into the
// writer (lib/repurpose/refurbish-idea.ts composes from the brief, and its originality gate rejects a near-copy). Literal
// reuse of the source's bytes or text still needs the recorded basis (own_content | licensed). PURE.
export const REFURBISH_RIGHTS_BASES = ["own_content", "licensed"] as const
export type RefurbishRightsBasis = (typeof REFURBISH_RIGHTS_BASES)[number]

/**
 * tenant_owned — a row of this brokerage's own content: broad repurposing, its media may be carried.
 * asset_reuse  — an outside source the person states they own or license: its media/text may be reused, lineage recorded.
 * idea_only    — an outside source with no recorded basis: the IDEA may inspire an original piece; no source media or text
 *                may be carried, and every draft passes the originality gate against the source.
 */
export type RefurbishMode = "tenant_owned" | "asset_reuse" | "idea_only"

export type RefurbishVerdict =
  | { allowed: true; mode: RefurbishMode; lineage: string; license: "tenant_owned" | RefurbishRightsBasis | "idea_only"; mayReuseSourceMedia: boolean; mayReuseSourceText: boolean }
  | { allowed: false; reason: "no_lineage" | "unrecorded_basis"; message: string }

export function assessRefurbishSource(i: { sourceType: string; ownedSourceId: string | null; sourceUrl: string | null; rightsBasis: string | null | undefined }): RefurbishVerdict {
  if (i.ownedSourceId) return { allowed: true, mode: "tenant_owned", lineage: `${i.sourceType}:${i.ownedSourceId}`, license: "tenant_owned", mayReuseSourceMedia: true, mayReuseSourceText: true }
  const url = i.sourceUrl?.trim() || null
  if (!url) return { allowed: false, reason: "no_lineage", message: "No source to refurbish — pick your own content or paste the original's URL." }
  const basis = i.rightsBasis == null ? "" : String(i.rightsBasis).trim()
  if (!basis) return { allowed: true, mode: "idea_only", lineage: `url:${url}`, license: "idea_only", mayReuseSourceMedia: false, mayReuseSourceText: false }
  if (!(REFURBISH_RIGHTS_BASES as readonly string[]).includes(basis)) {
    // A stated basis the system cannot record (e.g. "fair_use") is not silently upgraded to reuse rights, nor silently
    // downgraded: the person is told to state own_content / licensed, or leave it blank for an idea-only original.
    return { allowed: false, reason: "unrecorded_basis", message: `"${basis}" is not a basis we can record — choose "my own content" or "licensed", or leave it blank to create an original piece from the idea only.` }
  }
  return { allowed: true, mode: "asset_reuse", lineage: `url:${url}`, license: basis as RefurbishRightsBasis, mayReuseSourceMedia: true, mayReuseSourceText: true }
}
