// lib/marketing/humanize-final.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE FINAL PERSONALIZATION PHASE OF EVERY AI DISTRIBUTION (wave 145, lane 145G — contract C4; owner ruling 20, 2026-10-27:
// "All distributions of material created by ai should have a last phase of removing any ai typical wording and adds the
// user's tagline so it has a personalized human wording inserted to make it their own").
//
// THE SURVIVOR IS EXTENDED, NOT DUPLICATED (CLAUDE.md §1, LAW 1). Wave 144H built the ONE humanized review — the book's
// machine-written-tell list + scanner in lib/lead-magnets/book-editorial.ts (`scanAiTells`, `humanizedReviewState`). This
// module is that review generalised to every public asset kind, on the SAME list: book-editorial.ts gained `stripAiTells`
// (the safe deterministic removals) beside the scanner, and this phase imports both. There is no second tell list. The
// other pieces it composes are survivors too, never restated:
//   · the claim guard (rank / bestseller / award language) — lib/lead-magnets/book-publishing.ts scanBookClaims;
//   · unsupported superlatives — lib/video/director-eval-harness.ts detectUngroundedClaims (the Director's ONE list,
//     grounded against the caller's bounded facts exactly as the video hook harness grounds them);
//   · public-copy fair housing — lib/kernel/marketing/public-copy-rewrite.ts scanPublicCopy (public housing marketing
//     surfaces only; the 55+ claim against the tenant's recorded exemption);
//   · the brand — lib/branding/resolve-brand-context.ts (logo + the agent > team > brokerage tagline cascade) and the
//     brand-voice rules lib/kernel/brand-voice.ts resolveBrandVoiceCore (the tenant's prohibited / preferred words).
//
// WHAT THE PHASE DOES (pure: finalizeForDistribution — no I/O, no model call):
//   1. removes the machine-written phrasing it can remove WITHOUT touching a fact (stripAiTells); what it cannot safely
//      rewrite stays OPEN and is named for the human (the phase never guesses at meaning);
//   2. keeps every FACT: material terms (amounts, percentages, dates, counts) are extracted before and proven present after;
//   3. preserves advertising / legal DISCLOSURES (the caller's required lines + every disclosure-like line the draft
//      carried — Equal Housing, licence lines, NMLS / DRE numbers, rate and "not an appraisal" disclaimers, AI disclosure);
//      a required line the draft lacked is appended, never invented beyond what the caller names;
//   4. adds the tenant's APPROVED tagline (vetted by the claim guard + public-copy fair housing — a tagline that fails is
//      left off and the human is told) where the asset kind carries one, and the brand's logo where the renderer places it;
//   5. flags — never silently ships — unsupported superlatives, testimonials without a verified review, rank claims, the
//      tenant's prohibited words and hard fair-housing findings;
//   6. hashes the result (sha256) so the version a human approves is the version the publication door can prove it sent.
// The HUMAN APPROVAL is the publication gate (requiresHumanApproval is always true). The I/O half below records the final
// version (public.distribution_finals, m866), notifies the human THE MOMENT it is ready, and — at the publication door —
// records which approved version actually went out (or refuses an unapproved / non-compliant one, fail closed).
//
// Not server-only: the proof (scripts/content-distribution-guard.ts) drives the pure half and the I/O half on an in-memory
// client. The brand / voice / notification defaults are lazy imports so this module stays importable anywhere on the server.

import { createHash } from "node:crypto"
import { scanAiTells, stripAiTells, type AiTellFinding } from "@/lib/lead-magnets/book-editorial"
import { scanBookClaims } from "@/lib/lead-magnets/book-publishing"
import { detectUngroundedClaims } from "@/lib/video/director-eval-harness"
import { scanPublicCopy, type CopySurface, type OlderPersonsRecords } from "@/lib/kernel/marketing/public-copy-rewrite"
// A SPOKEN piece (a video / podcast / TV script) is also graded by the spoken-realism survivor — advisory, exactly as the
// podcast writer already uses it (lib/video/realism-profile.ts scanForAiTells); never a second written-tell list.
import { scanForAiTells as scanSpokenRealism } from "@/lib/video/realism-profile"

// ── The asset kinds and what each can carry ───────────────────────────────────────────────────────

/** Every AI-generated PUBLIC asset kind the final phase serves (= the distribution_finals.asset_kind CHECK, m866). */
export const HUMANIZE_ASSET_KINDS = [
  "newsletter", "email_campaign", "blog_post", "social_post", "ad_creative", "lead_magnet", "book", "video_script",
  "podcast_script", "video_description", "ctv_ad", "listing_creative", "direct_mail",
] as const
export type HumanizeAssetKind = (typeof HUMANIZE_ASSET_KINDS)[number]

function isHumanizeAssetKind(v: unknown): v is HumanizeAssetKind {
  return typeof v === "string" && (HUMANIZE_ASSET_KINDS as readonly string[]).includes(v)
}

interface KindProfile {
  /** The public-copy surface the fair-housing scan judges it as (every kind here is public housing marketing). */
  surface: CopySurface
  /** append = the tagline joins the copy as its sign-off; render = the renderer places it (cover, end card, mail panel); none = no room (an ad headline). */
  tagline: "append" | "render" | "none"
  /** render = the renderer places the brand's own logo file; none = a text-only surface. Never inlined into copy. */
  logo: "render" | "none"
}

/** WHAT EACH KIND CARRIES. The tagline is appended only where a sign-off belongs; a TV spot / book / mail piece renders it. */
export const HUMANIZE_KIND_PROFILE: Readonly<Record<HumanizeAssetKind, KindProfile>> = Object.freeze({
  newsletter:        { surface: "newsletter",   tagline: "append", logo: "render" },
  email_campaign:    { surface: "newsletter",   tagline: "append", logo: "render" },
  blog_post:         { surface: "blog",         tagline: "append", logo: "render" },
  social_post:       { surface: "social",       tagline: "append", logo: "none" },
  ad_creative:       { surface: "ad",           tagline: "none",   logo: "render" },
  lead_magnet:       { surface: "lead_magnet",  tagline: "render", logo: "render" },
  book:              { surface: "book",         tagline: "render", logo: "render" },
  video_script:      { surface: "video_script", tagline: "render", logo: "render" },
  podcast_script:    { surface: "video_script", tagline: "append", logo: "none" },
  video_description: { surface: "social",       tagline: "append", logo: "none" },
  ctv_ad:            { surface: "ad",           tagline: "render", logo: "render" },
  listing_creative:  { surface: "listing",      tagline: "append", logo: "render" },
  direct_mail:       { surface: "ad",           tagline: "render", logo: "render" },
})

// ── Inputs / outputs ──────────────────────────────────────────────────────────────────────────────

export interface TenantBrandForFinal {
  /** The name the piece is signed with (team > brokerage — resolveBrandContext displayName). */
  brandName?: string | null
  /** The tagline cascade's answer (agent motto > team > brokerage). Vetted here before it is used. */
  tagline?: string | null
  /** The brand's OWN logo file (team > brokerage > onboarding wizard). The renderer places it; never AI-made. */
  logoUrl?: string | null
  /** The tenant's brand-voice prohibited words / phrases (every scope accumulates). */
  prohibitedWords?: readonly string[]
  /** The tenant's preferred words — advisory only. */
  preferredWords?: readonly string[]
}

export interface FinalizeInput {
  assetKind: HumanizeAssetKind
  /** Plain text / markdown / spoken script. Give text OR html. */
  text?: string | null
  /** HTML — only text between tags is rewritten; tags and attributes are never touched. */
  html?: string | null
  tenantBrand: TenantBrandForFinal | null
  /** Advertising / legal lines the published piece MUST carry (the caller names them — never invented here). */
  disclosures?: readonly string[]
  /** Bounded facts a superlative may be grounded in (a listing's own facts, a verified award). */
  facts?: readonly string[]
  /** Testimonial quotes that exist in a verified review record — any other testimonial is unsupported. */
  verifiedTestimonials?: readonly string[]
  /** "ai" (default): the model drafted it. "human": the person's own words — never re-flagged for machine tells. */
  authoredBy?: "ai" | "human"
  /** The tenant's recorded housing-for-older-persons exemptions (scanPublicCopy) — omitted = none recorded. */
  olderPersons?: OlderPersonsRecords
}

export interface FinalizedDistribution {
  assetKind: HumanizeAssetKind
  format: "html" | "text"
  /** THE FINAL — what the human reviews and what the door must send. */
  text: string
  sha256: string
  /** The draft the phase was handed (so a later edit by the human is distinguishable from the phase's own work). */
  sourceSha256: string
  authoredBy: "ai" | "human"
  /** Machine-written phrases the phase removed (safe rewrites only). */
  removed: AiTellFinding[]
  /** Machine-written phrases still in the final — the human rewrites them (none for a human-authored final). */
  openTells: AiTellFinding[]
  tagline: { applied: "appended" | "render" | "already_present" | "none"; text: string | null; reason: string | null }
  logo: { placement: "render" | "none"; url: string | null; reason: string | null }
  disclosures: { required: string[]; carried: string[]; appended: string[]; missing: string[] }
  materialTerms: { source: string[]; missing: string[] }
  /** Unsupported superlatives (not grounded in the caller's facts). */
  superlatives: string[]
  /** Testimonial-shaped claims with no verified review behind them. */
  testimonials: string[]
  /** Rank / bestseller / award language (the claim guard). */
  rankClaims: string[]
  brandVoice: { prohibited: string[]; preferredMissing: boolean }
  /** Hard public-copy fair-housing findings (severity high / blocker). */
  fairHousing: string[]
  /** What must be resolved before this is ready for approval (each names the phrase). */
  blockers: string[]
  /** What the human should know (a tagline left off, warnings that pass through). */
  reviewNotes: string[]
  readyForApproval: boolean
  /** Always true: no AI-generated public asset publishes without a person's approval. */
  requiresHumanApproval: true
  /** One plain sentence for the human's notification. */
  summary: string
}

// ── Pure helpers ──────────────────────────────────────────────────────────────────────────────────

/** PURE. The hash a final is identified by — line endings normalised, trailing whitespace dropped (nothing else). */
function finalContentSha256(content: string): string {
  const norm = String(content ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/, "")
  return createHash("sha256").update(norm, "utf8").digest("hex")
}

/** Apply `fn` to the TEXT between tags only (tags / attributes untouched). Plain text passes straight through. */
function mapTextSegments(source: string, isHtml: boolean, fn: (s: string) => string): string {
  if (!isHtml) return fn(source)
  return source.split(/(<[^>]*>)/g).map((seg) => (seg.startsWith("<") && seg.endsWith(">") ? seg : fn(seg))).join("")
}

/** The readable text of a piece (tags stripped, the common entities decoded) — what every scan reads. */
function plainOf(source: string, isHtml: boolean): string {
  if (!isHtml) return source
  return source
    .replace(/<(?:br|\/p|\/h\d|\/li|\/section|hr)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&#x27;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const squash = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim()

/**
 * PURE. The MATERIAL TERMS a piece states — amounts, percentages, dates, years and counts. The final phase proves every one
 * of these survives (a humanizer that changed "3.25%" or "$12,500" would be changing an advertised term).
 */
function materialTermsOf(text: string): string[] {
  const TERM = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|million|billion))?|\d+(?:\.\d+)?\s?%|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d[\d,]*(?:\.\d+)?\b/gi
  const out = new Set<string>()
  for (const m of String(text ?? "").matchAll(TERM)) out.add(m[0].replace(/\s+/g, ""))
  return [...out]
}

/** Lines that read as an advertising / legal disclosure — kept by construction and proven present after. */
const DISCLOSURE_LINE = /\b(?:equal housing|fair housing|licen[cs]ed|licen[cs]e|broker(?:age)? of record|subject to change|not an appraisal|not intended to solicit|deemed reliable|not guaranteed|ai[- ]generated|created with (?:the help of )?ai|terms and conditions|for illustration)\b|\b(?:nmls|dre)\s*#?\s*\d+/i

/** PURE. The disclosure-like sentences a draft carries (each must still be in the final). */
function disclosureLinesOf(text: string): string[] {
  return String(text ?? "").split(/\n+|(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0 && DISCLOSURE_LINE.test(s))
}

/** Testimonial shapes: a quoted endorsement with an attribution, a star rating, "our clients say". */
const TESTIMONIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /["“][^"”]{12,240}["”]\s*(?:[-–—]|,?\s*(?:says|said|writes|wrote))\s*[A-Z][a-z]+/g,
  /\b[1-5](?:\.\d)?[\s-]?stars?\b/gi,
  /\b(?:our|my|happy|satisfied)\s+(?:clients?|customers?|buyers?|sellers?)\s+(?:say|said|rave|love|agree)\b/gi,
  /\btestimonials?\b/gi,
]

/** PURE. Testimonial-shaped claims not backed by a verified review quote. */
function unsupportedTestimonials(text: string, verified: readonly string[] = []): string[] {
  const ok = verified.map(squash).filter(Boolean)
  const out = new Set<string>()
  for (const re of TESTIMONIAL_PATTERNS) {
    for (const m of String(text ?? "").matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) {
      const hit = squash(m[0])
      if (ok.some((v) => hit.includes(v) || v.includes(hit.replace(/^"|".*$/g, "")))) continue
      out.add(m[0].trim().slice(0, 160))
    }
  }
  return [...out]
}

/**
 * PURE. Is this tagline fit to go on a public piece? The claim guard (no rank / award / bestseller language) and the
 * public-copy fair-housing scan — the SAME vetting the book cover used (lib/lead-magnets/book-publishing-produce.ts
 * approvedBookBrandAssets now calls this). A tagline that fails is LEFT OFF with the reason; the piece is never held for it.
 */
export async function vetBrandTagline(
  tagline: string | null | undefined,
  ctx: { surface?: CopySurface; brokerageName?: string | null; olderPersons?: OlderPersonsRecords },
): Promise<{ tagline: string | null; reason: string | null; why: string | null }> {
  const t = (tagline ?? "").trim()
  if (!t) return { tagline: null, reason: "no approved tagline in brand settings", why: null }
  const claims = scanBookClaims({ brand_tagline: t })
  const superlatives = detectUngroundedClaims({ hook: t, script: t, captionText: "" }, []).filter((c) => c.kind === "superlative").map((c) => c.claim)
  const fh = await scanPublicCopy(t, ctx.surface ?? "book", { brokerageName: ctx.brokerageName ?? null, olderPersons: ctx.olderPersons })
  if (claims.length > 0 || superlatives.length > 0 || !fh.ok) {
    const why = claims.length ? claims.map((c) => c.rule).join("; ")
      : superlatives.length ? `unsupported superlative${superlatives.length === 1 ? "" : "s"} (${[...new Set(superlatives)].join(", ")})`
      : fh.findings.map((f) => f.fix).join("; ")
    return { tagline: null, reason: `The brand tagline "${t}" was left off — ${why}. Approve a clean tagline in brand settings to carry it.`, why }
  }
  return { tagline: t, reason: null, why: null }
}

// ── THE PHASE ─────────────────────────────────────────────────────────────────────────────────────

/**
 * finalizeForDistribution — contract C4. PURE (no I/O, no model): the last phase every AI-generated public asset passes
 * before a human approves it. Returns the FINAL text, everything it changed, everything the human must still resolve, and
 * the hash the publication door proves it sent. Never throws on content; an unknown asset kind is a programming error.
 */
export async function finalizeForDistribution(input: FinalizeInput): Promise<FinalizedDistribution> {
  if (!isHumanizeAssetKind(input.assetKind)) throw new Error(`humanize-final: "${String(input.assetKind)}" is not a public asset kind`)
  const profile = HUMANIZE_KIND_PROFILE[input.assetKind]
  const isHtml = typeof input.html === "string" && input.html.trim().length > 0
  const source = isHtml ? String(input.html) : String(input.text ?? "")
  const authoredBy = input.authoredBy ?? "ai"
  const brand = input.tenantBrand ?? {}
  const sourcePlain = plainOf(source, isHtml)

  // 1 · remove the machine-written phrasing that can go without touching a fact (AI drafts only — a human's words are theirs).
  const removed: AiTellFinding[] = []
  let body = source
  if (authoredBy === "ai") {
    body = mapTextSegments(source, isHtml, (seg) => {
      const r = stripAiTells(seg)
      removed.push(...r.removed)
      return r.text
    })
  }

  // 2 · the tagline — vetted, then appended where a sign-off belongs (never twice).
  const vetted = await vetBrandTagline(brand.tagline ?? null, { surface: profile.surface, brokerageName: brand.brandName ?? null, olderPersons: input.olderPersons })
  let taglineOut: FinalizedDistribution["tagline"]
  if (!vetted.tagline) taglineOut = { applied: "none", text: null, reason: vetted.reason }
  else if (profile.tagline === "none") taglineOut = { applied: "none", text: vetted.tagline, reason: `a ${input.assetKind.replace(/_/g, " ")} has no room for a sign-off — the tagline rides the rest of the campaign` }
  else if (profile.tagline === "render") taglineOut = { applied: "render", text: vetted.tagline, reason: null }
  else if (squash(plainOf(body, isHtml)).includes(squash(vetted.tagline))) taglineOut = { applied: "already_present", text: vetted.tagline, reason: null }
  else {
    body = isHtml
      ? `${body}\n<p class="brand-tagline">${escapeHtml(`— ${vetted.tagline}`)}</p>`
      : `${body.replace(/\s+$/, "")}\n\n— ${vetted.tagline}`
    taglineOut = { applied: "appended", text: vetted.tagline, reason: null }
  }

  // 3 · the logo — the brand's own file, placed by the renderer; a text-only surface carries none (said, not hidden).
  const logoUrl = (brand.logoUrl ?? "").trim() || null
  const logoOut: FinalizedDistribution["logo"] = profile.logo === "none"
    ? { placement: "none", url: null, reason: `a ${input.assetKind.replace(/_/g, " ")} is text-only — no logo placement` }
    : logoUrl ? { placement: "render", url: logoUrl, reason: null } : { placement: "none", url: null, reason: "no brand logo file in brand settings" }

  // 4 · disclosures — what the draft carried stays; what the caller requires and the draft lacked is appended (last).
  const carried = disclosureLinesOf(sourcePlain)
  const required = [...new Set((input.disclosures ?? []).map((d) => String(d ?? "").trim()).filter(Boolean))]
  const appended: string[] = []
  for (const d of required) {
    if (squash(plainOf(body, isHtml)).includes(squash(d))) continue
    body = isHtml ? `${body}\n<p class="disclosure">${escapeHtml(d)}</p>` : `${body.replace(/\s+$/, "")}\n\n${d}`
    appended.push(d)
  }
  const finalPlain = plainOf(body, isHtml)
  const finalSquashed = squash(finalPlain)
  const missingDisclosures = [...carried, ...required].filter((d) => !finalSquashed.includes(squash(d)))

  // 5 · material terms — every amount / rate / date the draft stated is still stated.
  const sourceTerms = materialTermsOf(sourcePlain)
  const finalCompact = finalPlain.replace(/\s+/g, "")
  const missingTerms = sourceTerms.filter((t) => !finalCompact.includes(t))

  // 6 · what the human must resolve.
  const openTells = authoredBy === "ai" ? scanAiTells(finalPlain) : []
  const superlatives = [...new Set(detectUngroundedClaims({ hook: "", script: finalPlain, captionText: "" }, [...(input.facts ?? [])])
    .filter((c) => c.kind === "superlative").map((c) => c.claim))]
  const testimonials = unsupportedTestimonials(finalPlain, input.verifiedTestimonials ?? [])
  const rankClaims = [...new Set(scanBookClaims({ copy: finalPlain }).map((c) => c.phrase))]
  const lower = finalPlain.toLowerCase()
  const prohibited = (brand.prohibitedWords ?? []).map((w) => String(w ?? "").trim()).filter(Boolean)
    .filter((w) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(lower))
  const preferred = (brand.preferredWords ?? []).map((w) => String(w ?? "").trim().toLowerCase()).filter(Boolean)
  const preferredMissing = preferred.length > 0 && !preferred.some((w) => lower.includes(w))
  const fh = await scanPublicCopy(finalPlain, profile.surface, { brokerageName: brand.brandName ?? null, olderPersons: input.olderPersons })
  const fairHousing = fh.findings.filter((f) => f.severity === "high" || f.severity === "blocker").map((f) => `"${f.phrase}" — ${f.fix}`)

  const blockers = [
    ...openTells.map((t) => `machine-written phrasing still reads "${t.phrase}" (${t.rule}) — rewrite it in your own words`),
    ...superlatives.map((s) => `unsupported superlative "${s}" — remove it or ground it in a fact you can show`),
    ...testimonials.map((s) => `testimonial with no verified review behind it: "${s}"`),
    ...rankClaims.map((s) => `rank / award claim "${s}" — nothing the platform can verify`),
    ...prohibited.map((w) => `your brand voice prohibits "${w}"`),
    ...fairHousing.map((f) => `fair housing: ${f}`),
    ...missingDisclosures.map((d) => `a disclosure was lost: "${d}"`),
    ...missingTerms.map((t) => `a material term was lost: "${t}"`),
  ]
  const spoken = input.assetKind === "video_script" || input.assetKind === "podcast_script" || input.assetKind === "ctv_ad"
  const reviewNotes = [
    ...(spoken && authoredBy === "ai" ? scanSpokenRealism(finalPlain) : []),
    ...(taglineOut.reason ? [taglineOut.reason] : []),
    ...(logoOut.reason && profile.logo !== "none" ? [logoOut.reason] : []),
    ...(preferredMissing ? [`none of your preferred words appear (${preferred.slice(0, 5).join(", ")})`] : []),
    ...fh.warnings.slice(0, 5),
  ]
  const summary = [
    removed.length ? `removed ${removed.length} machine-written phrase${removed.length === 1 ? "" : "s"}` : "no machine-written phrase to remove",
    taglineOut.applied === "appended" ? "added your tagline" : taglineOut.applied === "render" ? "your tagline goes on the rendered piece" : taglineOut.applied === "already_present" ? "your tagline is already in it" : "no tagline added",
    appended.length ? `added ${appended.length} required disclosure${appended.length === 1 ? "" : "s"}` : null,
    blockers.length ? `${blockers.length} item${blockers.length === 1 ? "" : "s"} need${blockers.length === 1 ? "s" : ""} you before approval` : "ready for your approval",
  ].filter(Boolean).join("; ")

  return {
    assetKind: input.assetKind,
    format: isHtml ? "html" : "text",
    text: body,
    sha256: finalContentSha256(body),
    sourceSha256: finalContentSha256(source),
    authoredBy,
    removed,
    openTells,
    tagline: taglineOut,
    logo: logoOut,
    disclosures: { required, carried, appended, missing: missingDisclosures },
    materialTerms: { source: sourceTerms, missing: missingTerms },
    superlatives,
    testimonials,
    rankClaims,
    brandVoice: { prohibited, preferredMissing },
    fairHousing,
    blockers,
    reviewNotes,
    readyForApproval: blockers.length === 0,
    requiresHumanApproval: true,
    summary: `${summary[0]?.toUpperCase() ?? ""}${summary.slice(1)}.`,
  }
}

// ── THE I/O HALF — record the final, tell the human, prove what went out ─────────────────────────────

type Db = { from: (table: string) => any }

/** distribution_finals.status (m866 CHECK). */
export const DISTRIBUTION_FINAL_STATUSES = ["awaiting_approval", "approved", "published", "superseded"] as const
export type DistributionFinalStatus = (typeof DISTRIBUTION_FINAL_STATUSES)[number]

/** distribution_finals.approval_basis (m866 CHECK) — WHICH human act approved the version that went out. */
export const DISTRIBUTION_APPROVAL_BASES = ["asset_approval", "derived_from_approved_asset", "human_edit"] as const
export type DistributionApprovalBasis = (typeof DISTRIBUTION_APPROVAL_BASES)[number]

/** notifications.type for "your AI piece is ready for approval". */
export const FINAL_READY_NOTIFICATION_TYPE = "content_final_ready"

interface DistributionFinalRow {
  id: string
  version: number
  status: DistributionFinalStatus
  content_sha256: string
  blockers: string[] | null
  final_text?: string
  /** The final's findings (the disclosures it carried / required are what a human edit must keep). */
  findings?: Record<string, unknown> | null
}

const FINAL_COLUMNS = "id, version, status, content_sha256, blockers, findings"

/** The newest final of an asset (any status) — tenant-pinned; a refused read is `error`, never "none". */
async function loadLatestFinal(db: Db, args: { brokerageId: string; assetTable: string; assetId: string }): Promise<{ row: DistributionFinalRow | null; error: string | null }> {
  if (!args.brokerageId || !args.assetTable || !args.assetId) return { row: null, error: "brokerageId, assetTable and assetId are required" }
  const { data, error } = await db.from("distribution_finals").select(FINAL_COLUMNS)
    .eq("brokerage_id", args.brokerageId).eq("asset_table", args.assetTable).eq("asset_id", args.assetId)
    .order("version", { ascending: false }).limit(1)
  if (error) return { row: null, error: `distribution_finals read refused: ${error.message ?? "unknown"}` }
  return { row: (((data ?? []) as DistributionFinalRow[])[0]) ?? null, error: null }
}

export interface StageFinalInput {
  brokerageId: string
  assetTable: string
  assetId: string
  final: FinalizedDistribution
  /** users.id of whoever's AI request produced it (null = a system pass). */
  createdBy: string | null
  /** users.id of the human to tell the moment it is ready (the creator / the asset's agent). Null = nobody to tell (said). */
  notifyUserId: string | null
  /**
   * The caller ALREADY told `notifyUserId` about THIS version with its own bell (named by its notifications.type — the
   * fair-housing escalation on a stubborn lead-magnet draft says "edit it before publishing"). One bell per version, never
   * two that contradict each other: no second notification is written, and the stamp records who was told and when.
   */
  announcedBy?: string | null
  /** Set when the version is derived from an asset a human ALREADY approved (a YouTube description of an approved video). */
  derivedFromApproval?: { by: string | null; at: string | null } | null
  /**
   * The asset's STORED representation when it is not the final's plain text (a newsletter is stored as its sections' JSON):
   * the version is identified by what the door will send, so the hash is taken from this. The findings stay the final's.
   */
  storedAs?: string
  now?: Date
}

export type StageFinalResult =
  | { ok: true; finalId: string; version: number; status: DistributionFinalStatus; reused: boolean; notified: boolean; notifyError: string | null }
  | { ok: false; error: string }

/**
 * Record a FINAL version of an asset and tell the human it is ready. Idempotent on content: the same final (same sha) is
 * reused, never re-versioned or re-notified. A new final supersedes the asset's earlier unpublished ones (counted). Every
 * read is read for its error; the insert is counted. Never throws.
 */
export async function stageDistributionFinal(db: Db, input: StageFinalInput): Promise<StageFinalResult> {
  try {
    const now = (input.now ?? new Date()).toISOString()
    const prior = await loadLatestFinal(db, input)
    if (prior.error) return { ok: false, error: prior.error }
    const storedText = typeof input.storedAs === "string" ? input.storedAs : input.final.text
    const storedSha = typeof input.storedAs === "string" ? finalContentSha256(input.storedAs) : input.final.sha256
    if (prior.row && prior.row.content_sha256 === storedSha && prior.row.status !== "superseded") {
      return { ok: true, finalId: prior.row.id, version: prior.row.version, status: prior.row.status, reused: true, notified: false, notifyError: null }
    }
    const { error: supErr } = await db.from("distribution_finals").update({ status: "superseded", updated_at: now })
      .eq("brokerage_id", input.brokerageId).eq("asset_table", input.assetTable).eq("asset_id", input.assetId)
      .in("status", ["awaiting_approval", "approved"]).select("id")
    if (supErr) return { ok: false, error: `could not supersede the earlier final: ${supErr.message ?? "unknown"}` }
    const derived = input.derivedFromApproval ?? null
    const status: DistributionFinalStatus = derived ? "approved" : "awaiting_approval"
    const f = input.final
    const { data: ins, error: insErr } = await db.from("distribution_finals").insert({
      brokerage_id: input.brokerageId,
      asset_kind: f.assetKind,
      asset_table: input.assetTable,
      asset_id: input.assetId,
      version: (prior.row?.version ?? 0) + 1,
      final_text: storedText,
      content_sha256: storedSha,
      source_sha256: f.sourceSha256,
      authored_by: f.authoredBy,
      findings: {
        summary: f.summary, removed: f.removed, open_tells: f.openTells, tagline: f.tagline, logo: f.logo, disclosures: f.disclosures,
        material_terms: f.materialTerms, superlatives: f.superlatives, testimonials: f.testimonials, rank_claims: f.rankClaims,
        brand_voice: f.brandVoice, fair_housing: f.fairHousing, review_notes: f.reviewNotes,
      },
      blockers: f.blockers,
      tagline: f.tagline.applied === "none" ? null : f.tagline.text,
      logo_url: f.logo.url,
      status,
      approval_basis: derived ? "derived_from_approved_asset" : null,
      approved_by: derived?.by ?? null,
      approved_at: derived ? (derived.at ?? now) : null,
      created_by: input.createdBy,
      created_at: now,
      updated_at: now,
    }).select("id, version")
    const row = ((ins ?? []) as Array<{ id: string; version: number }>)[0]
    if (insErr || !row) return { ok: false, error: `distribution_finals insert refused: ${insErr?.message ?? "no row returned"}` }

    // THE MOMENT IT IS READY: the human is told (a version that awaits approval only — a derived one is already approved).
    let notified = false
    let notifyError: string | null = null
    if (status === "awaiting_approval") {
      if (!input.notifyUserId) notifyError = "no human named to notify — the final waits in the asset's approval queue unannounced"
      else if (input.announcedBy) {
        const { data: stamped, error: stampErr } = await db.from("distribution_finals").update({ notified_user_id: input.notifyUserId, notified_at: now, updated_at: now })
          .eq("id", row.id).eq("brokerage_id", input.brokerageId).select("id")
        notified = true
        if (stampErr || (stamped ?? []).length !== 1) notifyError = `told by ${input.announcedBy}, but the stamp was not recorded: ${stampErr?.message ?? "matched no row"}`
      } else {
        const { data: note, error: noteErr } = await db.from("notifications").insert({
          user_id: input.notifyUserId,
          brokerage_id: input.brokerageId,
          type: FINAL_READY_NOTIFICATION_TYPE,
          title: `Ready for your approval: ${f.assetKind.replace(/_/g, " ")}`,
          body: f.summary,
          entity_type: input.assetTable,
          entity_id: input.assetId,
          priority: f.blockers.length ? "high" : "medium",
          channel: "in_app",
          is_read: false,
          created_at: now,
        }).select("id")
        if (noteErr || (note ?? []).length !== 1) notifyError = `the human was NOT notified: ${noteErr?.message ?? "no notification row"}`
        else {
          notified = true
          const { data: stamped, error: stampErr } = await db.from("distribution_finals").update({ notified_user_id: input.notifyUserId, notified_at: now, updated_at: now })
            .eq("id", row.id).eq("brokerage_id", input.brokerageId).select("id")
          if (stampErr || (stamped ?? []).length !== 1) notifyError = `notified, but the stamp was not recorded: ${stampErr?.message ?? "matched no row"}`
        }
      }
    }
    return { ok: true, finalId: row.id, version: row.version, status, reused: false, notified, notifyError }
  } catch (e) {
    return { ok: false, error: `stageDistributionFinal threw: ${(e as Error)?.message ?? String(e)}` }
  }
}

export interface PublicationCheckInput {
  brokerageId: string
  assetKind: HumanizeAssetKind
  assetTable: string
  assetId: string
  /** EXACTLY what is about to go out (or went out). */
  content: string
  /** The human approval the door's OWN gate read (approval_status approved, the lead-magnet publish, the KDP attestation). */
  approval: { approved: boolean; by: string | null; at: string | null }
  tenantBrand?: TenantBrandForFinal | null
  disclosures?: readonly string[]
  olderPersons?: OlderPersonsRecords
}

export type PublicationCheck =
  | { ok: true; finalId: string | null; humanEdit: boolean; acknowledged: string[]; sha256: string }
  | { ok: false; reason: string }

/**
 * THE PUBLICATION DOOR'S CHECK (read-only). Publishable when a human approved it AND either (a) the content is byte-for-byte
 * the staged final (its open items were the approver's to accept — recorded as `acknowledged`), or (b) it is the human's own
 * edit of it — then the edit is re-checked for what no approval may waive (hard fair-housing findings, the brand's prohibited
 * words, a lost disclosure). Fail closed: no approval, an unreadable final, or a waived-nothing finding refuses.
 */
export async function checkDistributionPublication(db: Db, input: PublicationCheckInput): Promise<PublicationCheck> {
  if (!input.approval?.approved) return { ok: false, reason: "not approved by a person — an AI-generated public asset never publishes on its own" }
  const latest = await loadLatestFinal(db, input)
  if (latest.error) return { ok: false, reason: latest.error }
  const sha = finalContentSha256(input.content)
  if (latest.row && latest.row.status !== "superseded" && latest.row.content_sha256 === sha) {
    return { ok: true, finalId: latest.row.id, humanEdit: false, acknowledged: latest.row.blockers ?? [], sha256: sha }
  }
  // Not the staged final: the human's own edit (or an asset staged before the final phase existed). Re-check what nobody waives —
  // including every disclosure the STAGED final carried or required (an edit may reword the page, never drop its disclosures).
  const staged = (latest.row?.findings as { disclosures?: { required?: unknown; carried?: unknown } } | null | undefined)?.disclosures
  const stagedDisclosures = [staged?.required, staged?.carried].flatMap((v) => (Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : []))
  const audit = await finalizeForDistribution({
    assetKind: input.assetKind, text: input.content, tenantBrand: input.tenantBrand ?? null, disclosures: [...(input.disclosures ?? []), ...stagedDisclosures],
    authoredBy: "human", olderPersons: input.olderPersons,
  })
  if (audit.disclosures.appended.length > 0) {
    return { ok: false, reason: `a required disclosure is missing from what would go out: ${audit.disclosures.appended.map((d) => `"${d}"`).join(", ")}` }
  }
  const hard = [...audit.fairHousing.map((f) => `fair housing: ${f}`), ...audit.brandVoice.prohibited.map((w) => `prohibited by your brand voice: "${w}"`)]
  if (hard.length) return { ok: false, reason: `the approved edit still carries what no approval waives — ${hard.join("; ")}` }
  return { ok: true, finalId: null, humanEdit: true, acknowledged: [...audit.superlatives, ...audit.testimonials, ...audit.rankClaims], sha256: sha }
}

/**
 * RECORD WHAT WENT OUT (after the external send succeeded). Marks the matching final `published` with the approval evidence
 * and the provider reference; a human edit becomes its own version (basis human_edit) so the record is always the exact text
 * that was sent. Counted writes; never throws.
 */
export async function recordDistributionPublication(
  db: Db,
  input: PublicationCheckInput & { via: string; ref: string | null; basis?: Exclude<DistributionApprovalBasis, "human_edit">; now?: Date },
): Promise<{ ok: true; finalId: string; humanEdit: boolean } | { ok: false; error: string }> {
  try {
    const check = await checkDistributionPublication(db, input)
    if (!check.ok) return { ok: false, error: check.reason }
    const now = (input.now ?? new Date()).toISOString()
    const evidence = {
      status: "published", approval_basis: check.humanEdit ? "human_edit" : (input.basis ?? "asset_approval"),
      approved_by: input.approval.by, approved_at: input.approval.at ?? now,
      published_at: now, published_via: input.via, published_ref: input.ref, published_sha256: check.sha256, updated_at: now,
    }
    if (!check.humanEdit && check.finalId) {
      const { data, error } = await db.from("distribution_finals").update({ ...evidence, acknowledged: check.acknowledged })
        .eq("id", check.finalId).eq("brokerage_id", input.brokerageId).select("id")
      if (error || (data ?? []).length !== 1) return { ok: false, error: `publication not recorded: ${error?.message ?? "matched no row"}` }
      return { ok: true, finalId: check.finalId, humanEdit: false }
    }
    const latest = await loadLatestFinal(db, input)
    if (latest.error) return { ok: false, error: latest.error }
    if (latest.row && latest.row.status !== "superseded" && latest.row.status !== "published") {
      const { error: supErr } = await db.from("distribution_finals").update({ status: "superseded", updated_at: now })
        .eq("id", latest.row.id).eq("brokerage_id", input.brokerageId).select("id")
      if (supErr) return { ok: false, error: `could not supersede the staged final: ${supErr.message ?? "unknown"}` }
    }
    const { data: ins, error: insErr } = await db.from("distribution_finals").insert({
      brokerage_id: input.brokerageId, asset_kind: input.assetKind, asset_table: input.assetTable, asset_id: input.assetId,
      version: (latest.row?.version ?? 0) + 1, final_text: input.content, content_sha256: check.sha256, source_sha256: check.sha256,
      authored_by: "human", findings: { summary: "the approver's own edit, published as approved" }, blockers: [], acknowledged: check.acknowledged,
      created_by: input.approval.by, created_at: now, ...evidence,
    }).select("id")
    const row = ((ins ?? []) as Array<{ id: string }>)[0]
    if (insErr || !row) return { ok: false, error: `publication not recorded: ${insErr?.message ?? "no row returned"}` }
    return { ok: true, finalId: row.id, humanEdit: true }
  } catch (e) {
    return { ok: false, error: `recordDistributionPublication threw: ${(e as Error)?.message ?? String(e)}` }
  }
}

/**
 * The tenant's brand for a final — logo + tagline from THE brand cascade (resolveBrandContext), prohibited / preferred
 * words from the brand-voice core (every scope, tenant-pinned on the caller's client). A refused voice read is said, never
 * read as "no rules". Lazy imports: the pure phase above never needs them.
 */
export async function resolveTenantBrandForFinal(db: Db, args: { brokerageId: string; teamId?: string | null; agentUserId?: string | null }): Promise<{ brand: TenantBrandForFinal; error: string | null }> {
  try {
    const { resolveBrandContext } = await import("@/lib/branding/resolve-brand-context")
    const { resolveBrandVoiceCore } = await import("@/lib/kernel/brand-voice")
    const [ctx, voice] = await Promise.all([
      resolveBrandContext({ brokerageId: args.brokerageId, teamId: args.teamId ?? null, agentUserId: args.agentUserId ?? null }),
      resolveBrandVoiceCore(db as never, { brokerageId: args.brokerageId, teamId: args.teamId ?? undefined, actorUserId: args.agentUserId ?? undefined }),
    ])
    return {
      brand: { brandName: ctx.displayName, tagline: ctx.display.tagline, logoUrl: ctx.visual.logoUrl, prohibitedWords: voice.prohibitedWords, preferredWords: voice.preferredWords },
      error: ctx.readErrors?.length ? `part of the brand was unreadable (${ctx.readErrors.join("; ")}) — the tagline / logo may be missing` : null,
    }
  } catch (e) {
    return { brand: {}, error: `brand unreadable — no tagline / logo / voice rules applied: ${(e as Error)?.message ?? String(e)}` }
  }
}
