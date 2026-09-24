// lib/video/render-cut.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CUT DIMENSION — ONE plan, TWO derived renders (wave 81, lane 81C).
//
// OWNER (2026-09-24, verbatim): "the listing videos have to be mls compliant.
// you can create one for mls and one for posting/ads."
//
// A listing video is written ONCE (script, body-visual plan, duration) and
// rendered TWICE:
//   · `ads` — the posting / ads cut: full branding, agent contact, tracked QR,
//     CTA, captions, brand bookends, share thumbnail. Instagram / TikTok /
//     YouTube / Facebook / email / the agent's own site.
//   · `mls` — the MLS cut: the SAME script and plan with every branded element
//     stripped. Goes in the MLS's UNBRANDED virtual-tour / media field, which
//     is what syndicates to Zillow, Realtor.com and Redfin from the feed.
//
// WHAT THE RULES SAY (Exa, 2026-09-24):
//   · IRMLS Rules & Regulations §1.19 (sbarearealtors.org, Nov 2025): photos
//     and digital images "shall not contain user/office contact information
//     such as names, phone numbers, email addresses or website addresses,
//     virtual tour links … including the use of embedded, overlaid, or
//     digitally stamped information"; "'Unbranded' means that no aspect of the
//     virtual media … can exhibit listing agent, office or broker name, phone
//     number, email address, web address or other information of this nature
//     that is not descriptive in nature and relevant to an accurate portrayal
//     of the property being marketed." Branded tours go in the BRANDED field
//     and are the ones syndicated to third-party sites.
//   · NAR Handbook on Multiple Listing Policy: "listing content" includes
//     "audio and video recordings, virtual tours" (Statement 7.9 definition);
//     MLSs "may prohibit advertising controlled by participants (including
//     co-branding) on any pages displaying IDX-provided listings" (7.58 §7).
//   · Zillow Showcase video (agentschoicemedia.com): no brokerage ads, no
//     watermarks, no copyrighted music, no "call me at this number", no logo
//     overlay; max 2 minutes. Zillow stopped hosting videos 2022-12-06 — the
//     unbranded MLS link is what reaches the Zillow listing (vmdpros.com).
//   · Reel-E MLS video requirements (2026-01): "Realtor.com and Redfin will
//     reject or suppress listings with branded video content (visible logos,
//     contact information overlays, or brokerage watermarks)"; a 60-120 s
//     listing video, MP4/H.264/AAC, 1080p, under 5 minutes.
//   · The strip list the field uses (cloudpano.com 2026-05-27, swarmify.com
//     2026-07-30): logos, agent names, brokerage names, contact prompts,
//     website URLs, social handles, QR codes, lead-capture overlays, branded
//     end cards, lower-thirds, spoken calls to action; opening title = the
//     address or a neutral property label; end screen = property facts, a
//     neutral closing frame, or nothing.
//   · "Edit a single master timeline and export an unbranded cut for MLS …
//     Duplicate the project and add minimal branding, agent info, and a clear
//     next step for … social. Keep footage and timestamps identical"
//     (peachgum.ai 2026-04-24) — which is exactly ONE plan, TWO renders.
//   · Fair housing applies to the narration and captions of BOTH cuts
//     (listingkit.app 2026-04-23: HUD 24 CFR 100 covers "all advertising
//     media"; narration implying who lives in the area, "great schools",
//     proximity to a place of worship are the steering shapes) — the MLS cut
//     REQUIRES the scan to pass; a red flag blocks it.
//
// WHY A REGISTRY, NOT A FLAG: `mlsClean` already existed as a per-render boolean
// (video-director CommissionOpts, QrOutroBadge, EndCard, composite-attribution,
// verbal-disclosure's usage_intent carve-out) — but nothing said WHICH
// compositions may be cut for the MLS, WHAT the cut strips, or proved that a
// branded prop could not ride along. The four listing reels the Director
// commissions most (JustListedReel, JustListedReelSquare/Horizontal,
// JustSoldReelSquare) never read `mlsClean` at all: their outro printed the
// agent's name, phone and logo and mounted the QR badge without forwarding
// the flag. This module is the ONE definition; `mlsClean` stays the render
// flag the compositions consume (§6 — one spelling, this derives it).
//
// PURE. No I/O.

import type { VideoFinish } from "./finish-spec"
import { finishForVideo } from "./finish-spec"
import { compositionPurposes, type VideoPurpose } from "./duration-model"
import { CONTENT_CONTRACT } from "@/lib/remotion/content-contract"

export const RENDER_CUTS = ["ads", "mls"] as const
export type RenderCut = (typeof RENDER_CUTS)[number]

/** ai_video_projects.usage_intent per cut (scripts/check-vocabularies.ts: both | mls | public_marketing). */
export const CUT_USAGE_INTENT: Record<RenderCut, "mls" | "public_marketing"> = {
  ads: "public_marketing",
  mls: "mls",
}

/** The purposes whose subject is THE PROPERTY — the only videos an MLS field
 *  takes. An agent intro, a market update or a testimonial is agent content
 *  and has no MLS cut by construction. */
export const MLS_CUT_PURPOSES: ReadonlySet<VideoPurpose> = new Set<VideoPurpose>(["listing_promo", "photo_walkthrough"])

export type MlsStripElement =
  | "brand_logo"
  | "agent_name"
  | "agent_contact"
  | "brokerage_name"
  | "tracked_qr"
  | "cta"
  | "lower_third"
  | "brand_bookends"
  | "share_thumbnail"
  | "verbal_disclosure"

export interface MlsStripRule {
  element: MlsStripElement
  /** Dotted prop paths removed from the staged input props. */
  propPaths: string[]
  why: string
  source: string
}

/** THE STRIP LIST — what the MLS cut removes from the ads cut. Every entry names
 *  its rule. The proof asserts this list and that each path is actually gone. */
export const MLS_CUT_STRIP: readonly MlsStripRule[] = [
  { element: "brand_logo", propPaths: ["brand.logoUrl", "logoUrl"], why: "a brokerage or agent logo overlay is branding", source: "IRMLS §1.19 f 'office or broker name'; Zillow Showcase: no logo overlay" },
  { element: "agent_name", propPaths: ["brand.agentName", "agentName"], why: "the listing agent's name is contact information", source: "IRMLS §1.19 d/f 'names'" },
  { element: "agent_contact", propPaths: ["brand.agentPhone", "agentPhone", "brand.agentEmail", "agentEmail", "brand.website", "website", "brand.licenseLine", "licenseLine"], why: "phone, email, web address, licence line", source: "IRMLS §1.19 d 'phone numbers, email addresses or website addresses'" },
  { element: "brokerage_name", propPaths: ["brand.brokerageName", "brokerageName"], why: "the office name is branding", source: "IRMLS §1.19 f 'office or broker name'" },
  { element: "tracked_qr", propPaths: ["qrCodeDataUrl", "qrCaption", "qrSlug", "qrDestinationType", "outro.qrCodeDataUrl", "outro.qrDestinationType", "outro.qrSlug"], why: "a tracked QR is a virtual-tour link and a lead-capture overlay", source: "IRMLS §1.19 d 'virtual tour links'; cloudpano 2026: 'QR codes, lead capture overlays'" },
  { element: "cta", propPaths: ["ctaLabel", "closingCta", "intro.hook", "outro.agentContact"], why: "'DM me to tour' / 'call me' is a call to action, not a description of the property", source: "Zillow Showcase: no 'call me at this number'; swarmify 2026: no spoken calls to action" },
  { element: "lower_third", propPaths: [], why: "a name/brokerage strap is an overlay; the MLS cut plans no lower_third treatment and the attribution band is not burned", source: "IRMLS §1.19 d 'embedded, overlaid, or digitally stamped information'" },
  { element: "brand_bookends", propPaths: ["intro.brand", "outro.brand", "intro.agentPhotoSlot"], why: "the stock brand intro/outro clips are a branded intro/outro", source: "cloudpano 2026: 'No branded intro/outro'" },
  { element: "share_thumbnail", propPaths: ["thumbnail_props"], why: "the VideoCoverThumb share card carries the brand block", source: "cloudpano 2026: 'Clean thumbnail'" },
  { element: "verbal_disclosure", propPaths: [], why: "the spoken 'Brought to you by <brokerage>' line is brokerage attribution — lib/video/verbal-disclosure.ts already leaves usage_intent='mls' clean", source: "lib/video/verbal-disclosure.ts (the MLS carve-out is part of the rule)" },
]

/** Every prop path the MLS cut removes (flattened, for the proof and the finder). */
export const MLS_STRIPPED_PROP_PATHS: readonly string[] = MLS_CUT_STRIP.flatMap((r) => r.propPaths)

/** Content-contract `required` keys that ARE branded elements — a composition
 *  that cannot render without one of these has no MLS cut. Derived from the
 *  strip list's IDENTITY paths (the brand block and the flat agent keys),
 *  never a second list. The chrome groups (intro.* / outro.* / the share
 *  card) are excluded: `intro.hook` is the cover hook every listing reel
 *  requires as a content claim ("Just Listed" vs a price improvement) and
 *  the MLS cut prints the address in its place rather than needing it gone. */
const BRANDED_LEAF_KEYS: ReadonlySet<string> = new Set(
  MLS_STRIPPED_PROP_PATHS
    .filter((p) => !/^(intro|outro)\./.test(p) && p !== "thumbnail_props")
    .map((p) => p.split(".").pop() as string),
)

/**
 * DERIVED, never typed by hand: a composition has an MLS cut when
 *   · every purpose it serves is a property purpose (MLS_CUT_PURPOSES),
 *   · it puts no presenter on screen (a talking head IS agent branding —
 *     finish-spec presenter "none"), and
 *   · its content contract requires no branded key (OpenHouseAnnounceReel
 *     requires agentName + agentPhone: an open-house announcement is an
 *     invitation to meet the agent, not an MLS tour).
 */
export function compositionHasMlsCut(compositionId: string): boolean {
  const purposes = compositionPurposes(compositionId)
  if (purposes.length === 0 || !purposes.every((p) => MLS_CUT_PURPOSES.has(p))) return false
  if (finishForVideo(compositionId).presenter !== "none") return false
  const required = CONTENT_CONTRACT[compositionId]?.required ?? []
  return !required.some((k) => BRANDED_LEAF_KEYS.has(k))
}

/** The cuts a composition renders: every composition has the ads cut; the MLS cut is registry-derived. */
export function cutsForComposition(compositionId: string): RenderCut[] {
  return compositionHasMlsCut(compositionId) ? ["ads", "mls"] : ["ads"]
}

/** Every registered composition with an MLS cut — the denominator the proof publishes. */
export function mlsCutCompositions(): string[] {
  return Object.keys(CONTENT_CONTRACT).filter(compositionHasMlsCut)
}

/**
 * The finish a cut renders with. The ads cut is the composition's own finish.
 * The MLS cut keeps the music bed (a LICENSED bed is not branding — Zillow's
 * rule is "no copyrighted music", which the stock library already satisfies),
 * keeps b-roll and captions (captions carry the scanned narration, not the
 * brand), and drops the brand bookends, the tracked QR and the branded share
 * thumbnail. Presenter stays "none" by construction (compositionHasMlsCut).
 */
export function finishForCut(finish: VideoFinish, cut: RenderCut): VideoFinish {
  if (cut === "ads") return finish
  return { ...finish, presenter: "none", bookends: false, qr: false, thumbnail: false }
}

function deletePath(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split(".")
  let cur: unknown = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== "object") return false
    cur = (cur as Record<string, unknown>)[parts[i]]
  }
  if (!cur || typeof cur !== "object") return false
  const leaf = parts[parts.length - 1]
  if (!(leaf in (cur as Record<string, unknown>))) return false
  delete (cur as Record<string, unknown>)[leaf]
  return true
}

function readPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export interface MlsCutProps {
  props: Record<string, unknown>
  /** The dotted paths that were present and removed. */
  stripped: string[]
}

/**
 * Derive the MLS cut's input props FROM the ads cut's — the same script, the
 * same photos, the same body-visual plan, every branded path removed,
 * `mlsClean: true` set so the compositions, QrOutroBadge, EndCard and the
 * attribution compositor all read the ONE flag they already read. The
 * `outro` block keeps `brand:false, agentContact:false` so the assembly spec
 * shape survives with its claims turned off rather than a missing object.
 */
export function mlsCutProps(adsProps: Record<string, unknown>): MlsCutProps {
  const props = clone(adsProps)
  const stripped: string[] = []
  for (const path of MLS_STRIPPED_PROP_PATHS) {
    if (deletePath(props, path)) stripped.push(path)
  }
  const intro = props.intro && typeof props.intro === "object" ? (props.intro as Record<string, unknown>) : null
  if (intro) intro.brand = false
  const outro = props.outro && typeof props.outro === "object" ? (props.outro as Record<string, unknown>) : null
  if (outro) { outro.brand = false; outro.agentContact = false; outro.qrCodeDataUrl = null; outro.qrSlug = null; outro.qrDestinationType = null }
  props.qrCodeDataUrl = null
  props.mlsClean = true
  props.renderCut = "mls"
  // The plan's lower_third segments (if any) become plain kinetic text — the
  // strap would print a name the cut just removed.
  const plan = props.bodyVisualPlan
  if (plan && typeof plan === "object" && Array.isArray((plan as { segments?: unknown }).segments)) {
    for (const seg of (plan as { segments: Array<Record<string, unknown>> }).segments) {
      if (seg.treatment === "lower_third") { seg.treatment = "kinetic_text"; stripped.push("bodyVisualPlan.segments[].lower_third") }
    }
  }
  return { props, stripped }
}

/**
 * THE FINDER — every branded element still present in a prop set. This is the
 * positive control: hand it the ads cut and it must name every branded path;
 * hand it the MLS cut and it must find nothing. A cut that is not flagged
 * `mlsClean: true` is itself a finding (the compositions gate on that flag).
 */
export function brandedElementsIn(props: Record<string, unknown>): string[] {
  const found: string[] = []
  for (const path of MLS_STRIPPED_PROP_PATHS) {
    const v = readPath(props, path)
    if (v === undefined || v === null || v === false || v === "") continue
    found.push(path)
  }
  const plan = props.bodyVisualPlan
  if (plan && typeof plan === "object" && Array.isArray((plan as { segments?: unknown }).segments)) {
    if ((plan as { segments: Array<Record<string, unknown>> }).segments.some((s) => s.treatment === "lower_third")) found.push("bodyVisualPlan.segments[].lower_third")
  }
  if (props.mlsClean !== true) found.push("mlsClean!==true")
  return found
}

export type MlsCutVerdict = { ok: true } | { ok: false; reason: string; found: string[] }

/** FAIL CLOSED: the MLS cut may not carry a single branded element. */
export function assertMlsCutClean(props: Record<string, unknown>): MlsCutVerdict {
  const found = brandedElementsIn(props)
  if (found.length === 0) return { ok: true }
  return { ok: false, reason: `MLS cut still carries branded elements: ${found.join(", ")}`, found }
}

/** The idempotency discriminator suffix that keeps the two cuts as two rows. */
export function cutDiscriminator(cut: RenderCut): string {
  return `cut:${cut}`
}

/** The neutral opening/closing copy the MLS cut prints instead of a hook / CTA:
 *  the address (descriptive, relevant to the property) — IRMLS §1.19 f. */
export function mlsNeutralTitle(address: string | null | undefined, cityState?: string | null): string {
  const a = (address ?? "").trim()
  const c = (cityState ?? "").trim()
  return a && c ? `${a}, ${c}` : a || c || "Property tour"
}
