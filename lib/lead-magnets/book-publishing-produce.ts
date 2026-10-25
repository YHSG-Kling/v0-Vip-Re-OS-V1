// lib/lead-magnets/book-publishing-produce.ts
//
// BUILD, EVIDENCE AND APPROVE THE KDP PACKAGE FOR A FINISHED BOOK (wave 143, lane 143F).
// The pure halves are lib/lead-magnets/book-publishing.ts (EPUB, metadata, claim guard, rights, paperback plan) and
// lib/lead-magnets/book-cover.ts (cover). This file is the I/O: read the finished book (book-creator's loadProject —
// tenant-pinned, stage must be `ready_for_review`, no chapter still owned by a human), compose, GUARD, make the cover
// (the existing image rail, entitlement-gated, spend booked, falling back to typography), build the EPUB, host both files
// in the PRIVATE `documents` bucket (they are pre-publication — never a permanent public URL), and record the package on
// lead_capture_forms.settings.book_publishing under withActionLedger evidence.
//
// THE GATES, in order — a book that fails one is NOT packaged and the reasons are returned by name:
//   1. the book is finished (ready_for_review) and no chapter is waiting on the human (needs_human_review empty);
//   2. the CLAIM GUARD finds no rank / bestseller / award language in the title, subtitle, tagline, description,
//      keywords or the cover's own text (the owner: never guarantee rank);
//   3. the PUBLIC-COPY fair-housing gate (surface "book") passes the title, subtitle, tagline and description — and an
//      age-qualified claim passes only against the tenant's verified older-persons exemption;
//   4. KDP's own metadata limits (title + subtitle < 200, description ≤ 4,000 incl. tags, ≤ 7 keywords);
//   5. the cover meets KDP's eBook-cover rules (JPEG, ≥ 625 × 1,000, ratio ≥ 1.6:1, RGB, < 50 MB).
// APPROVAL (approveKdpPackage) is the human's: every attestation in KDP_ATTESTATIONS must be given, by name, by a
// session user; the approval records who and when. KDP has no publishing API — a person uploads the files in their own
// KDP account (WAITING_EXTERNAL: the author's KDP account; nothing here logs in to it, stores a credential or claims a
// publication happened).
//
// WAVE 144 (lane 144H, owner ruling 15) — three things the package did not know:
//   · WHOSE retail book it is. A lead magnet becomes the TENANT's KDP book (tenant_kdp) when its owner asks for the
//     package; a book in the platform's house tenant is the PLATFORM's (platform_kdp) — packaged and approved by platform
//     staff only (users.platform_role), branded with the platform's product brand, the platform as rights holder. The
//     context change is recorded on the book (settings.book.publication.history).
//   · THE BRAND: logo, colours and tagline from the ONE brand cascade (lib/branding/resolve-brand-context.ts — agent
//     motto > team > brokerage; team > brokerage logo / colours), or the platform's product brand. A tagline that fails
//     the claim guard or the public-copy fair-housing gate is LEFT OFF the cover (approved taglines only), with a warning.
//   · THE HUMANIZED REVIEW: an AI-drafted chapter that still reads machine-written blocks the package; approval needs the
//     humanized_review attestation and records the sign-off on the book. A package older than the manuscript is refused.

import "server-only"
import { randomUUID } from "node:crypto"
import sharp from "sharp"
import { loadProject, composeBookPdfData, type BookProject } from "./book-creator"
import {
  bookContextAllowed, humanizedReviewRefusal, humanizedReviewState, kdpContextFor, publicationRecord,
  type BookPublication, type HumanizedReviewRecord,
} from "./book-editorial"
import {
  KDP_ATTESTATIONS, buildEpub, composeKdpMetadata, composeRightsRecord, kdpPaperbackPlan, scanBookClaims, validateEbookCover, validateKdpMetadata, wordsIn,
  type BookClaimFinding, type KdpBookInput, type KdpMetadata, type KdpMetadataProblem, type KdpRightsRecord, type PaperbackPlan,
} from "./book-publishing"
import { kdpTrimAllowed } from "./kdp-print-math"
import { composeBookCover, coverArtPrompt, type BookCoverResult } from "./book-cover"
import { scanPublicCopy } from "@/lib/kernel/marketing/public-copy-rewrite"
import { loadOlderPersonsVerifications } from "@/lib/compliance/fair-housing-older-persons-store"
import { GENERATED_DOCUMENT_BUCKET, issueBucketObjectUrl } from "@/lib/storage/document-buckets"

type Svc = { from: (t: string) => any; storage?: any }

/** The recorded package — lead_capture_forms.settings.book_publishing. */
export interface KdpPackageRecord {
  built_at: string
  built_by: string
  files: { epub: { bucket: string; path: string; bytes: number }; cover: { bucket: string; path: string; bytes: number; width: number; height: number } }
  metadata: KdpMetadata
  rights: KdpRightsRecord
  paperback: PaperbackPlan
  words: number
  cover_art: "image_rail" | "typographic_only"
  cover_art_note: string | null
  warnings: string[]
  approval: null | { by: string; at: string; attestations: string[] }
  /** Wave 144: whose retail book (context, owner, history) and what of the brand went on it. Absent on older packages. */
  publication?: BookPublication
  brand?: { source: "tenant" | "platform"; logo: "embedded" | "none" | "unreadable"; tagline: string | null; primary_color: string | null; accent_color: string | null }
}

/** The brand a book is dressed in (the tenant cascade or the platform's product brand). */
export interface BookBrand { brokerageName: string; agentName?: string | null; primaryColor?: string | null; accentColor?: string | null; logoUrl?: string | null; tagline?: string | null }

export interface KdpBuildDeps {
  client?: Svc
  /** The tenant's recorded older-persons exemptions (default: loaded). */
  olderPersons?: Awaited<ReturnType<typeof loadOlderPersonsVerifications>>
  /** Tenant brand (default: lib/branding/resolve-brand-context.ts resolveBrandContext — logo, colours, tagline cascade). */
  brandResolver?: (svc: Svc, brokerageId: string, agentUserId: string | null) => Promise<BookBrand>
  /** The PLATFORM's product brand for a platform_kdp book (default lib/platform/product-brand.ts loadProductBrand). */
  platformBrandResolver?: (svc: Svc) => Promise<BookBrand>
  /** Is this the platform's house tenant (brokerages.is_demo)? An unreadable row is NOT the house tenant. */
  tenantReader?: (svc: Svc, brokerageId: string) => Promise<{ isHouseTenant: boolean; readable: boolean }>
  /** Is the actor platform staff (users.platform_role set)? A platform book is packaged and approved by staff only. */
  staffReader?: (svc: Svc, userId: string) => Promise<{ platformStaff: boolean; readable: boolean }>
  /** The brand's logo file (default: an https GET, ≤ 5 MB). null = no usable logo. */
  fetchLogo?: (url: string) => Promise<Buffer | null>
  /** Entitlement before the paid image call (default mayUseAndAfford ai.generate). */
  entitlement?: (ask: { brokerageId: string; estTokens: number }) => Promise<{ allowed: boolean; reason: string }>
  /** The text-free art, bytes (default: the existing image rail generateImage, spend booked on ai_tool_usage). null = no art. */
  coverArt?: (a: { brokerageId: string; userId: string; magnetId: string; prompt: string }) => Promise<{ bytes: Buffer | null; note: string | null; costUsd: number | null }>
  /** Hosting (default hostRenderedMedia into the private documents bucket). */
  host?: (svc: Svc, path: string, bytes: Buffer, contentType: string) => Promise<void>
  now?: Date
  id?: string
}

export type KdpBuildResult =
  | { ok: true; record: KdpPackageRecord }
  | { ok: false; error: string; blockers?: { claims?: BookClaimFinding[]; fairHousing?: string[]; metadata?: KdpMetadataProblem[]; cover?: string[]; humanize?: Array<{ chapter: number; phrases: string[] }> } }

const COVER_EST_TOKENS = 1500
const MAX_LOGO_BYTES = 5 * 1024 * 1024

const defaultBrandResolver: NonNullable<KdpBuildDeps["brandResolver"]> = async (_svc, brokerageId, agentUserId) => {
  const { resolveBrandContext } = await import("@/lib/branding/resolve-brand-context")
  const b = await resolveBrandContext({ brokerageId, agentUserId })
  return { brokerageName: b.displayName || b.brokerageName, agentName: b.agentName ?? null, primaryColor: b.visual.primaryColor, accentColor: b.visual.accentColor, logoUrl: b.visual.logoUrl, tagline: b.display.tagline }
}
const defaultPlatformBrandResolver: NonNullable<KdpBuildDeps["platformBrandResolver"]> = async (svc) => {
  const { loadProductBrand } = await import("@/lib/platform/product-brand")
  const b = await loadProductBrand(svc)
  // logoUrl (wave 144 — lane 144H Outside-lane 7): the platform's own logo, a product-brand field now; fetched only from
  // the platform's own storage host like every brand logo (defaultFetchLogo).
  return { brokerageName: b.name, agentName: null, primaryColor: b.primaryColor, accentColor: b.accentColor, logoUrl: b.logoUrl, tagline: b.tagline }
}
const defaultTenantReader: NonNullable<KdpBuildDeps["tenantReader"]> = async (svc, brokerageId) => {
  const { data, error } = await svc.from("brokerages").select("is_demo").eq("id", brokerageId).maybeSingle()
  if (error) return { isHouseTenant: false, readable: false }
  return { isHouseTenant: (data as { is_demo?: boolean | null } | null)?.is_demo === true, readable: true }
}
const defaultStaffReader: NonNullable<KdpBuildDeps["staffReader"]> = async (svc, userId) => {
  const { data, error } = await svc.from("users").select("platform_role").eq("id", userId).maybeSingle()
  if (error) return { platformStaff: false, readable: false }
  return { platformStaff: !!(data as { platform_role?: string | null } | null)?.platform_role, readable: true }
}
/** PURE. A logo is fetched server-side only from the platform's OWN storage host (a tenant-typed URL is never fetched —
 *  no server request is steered at an address a tenant chose). */
function logoFetchAllowed(url: string, storageOrigin: string | null | undefined): boolean {
  try {
    const u = new URL(url), s = storageOrigin ? new URL(storageOrigin) : null
    return u.protocol === "https:" && !!s && u.host === s.host
  } catch {
    return false
  }
}
const defaultFetchLogo: NonNullable<KdpBuildDeps["fetchLogo"]> = async (url) => {
  if (!logoFetchAllowed(url, process.env.NEXT_PUBLIC_SUPABASE_URL)) return null
  const res = await fetch(url)
  if (!res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer())
  return buf.length > 0 && buf.length <= MAX_LOGO_BYTES ? buf : null
}

/**
 * THE BRAND ON A BOOK — the APPROVED tagline and the brand's OWN logo file: the ONE vetting the KDP cover and the
 * lead-magnet PDF (book-creator.ts layout, through lib/documents/client-pdf.ts) share (wave 144 — lane 144H Outside-lane 4).
 * A tagline the claim guard or the public-copy fair-housing gate flags is left off (the book is not held for it); the logo
 * is fetched only from the platform's own storage host (defaultFetchLogo), never AI-made. Each omission is a warning.
 */
export async function approvedBookBrandAssets(
  brand: { tagline?: string | null; logoUrl?: string | null } | null | undefined,
  ctx: { brokerageName: string; olderPersons: Awaited<ReturnType<typeof loadOlderPersonsVerifications>>; fetchLogo?: KdpBuildDeps["fetchLogo"] },
): Promise<{ tagline: string | null; logo: Buffer | null; logoUnreadable: boolean; warnings: string[] }> {
  const warnings: string[] = []
  let tagline: string | null = (brand?.tagline ?? "").trim() || null
  if (tagline) {
    const tagClaims = scanBookClaims({ brand_tagline: tagline })
    const tagFh = await scanPublicCopy(tagline, "book", { brokerageName: ctx.brokerageName, olderPersons: ctx.olderPersons })
    if (tagClaims.length > 0 || !tagFh.ok) {
      warnings.push(`The brand tagline "${tagline}" was left off the book — ${tagClaims.length ? tagClaims.map((c) => c.rule).join("; ") : tagFh.findings.map((f) => f.fix).join("; ")}. Approve a clean tagline in brand settings to carry it.`)
      tagline = null
    }
  }
  let logo: Buffer | null = null
  let logoUnreadable = false
  if (brand?.logoUrl) {
    logo = await (ctx.fetchLogo ?? defaultFetchLogo)(brand.logoUrl).catch(() => null)
    if (!logo) { logoUnreadable = true; warnings.push("The brand logo could not be used (not a readable file in the platform's own storage) — the cover carries no logo; upload the logo file in brand settings.") }
  }
  return { tagline, logo, logoUnreadable, warnings }
}

/** PLATFORM BOOKS ARE STAFF WORK: a platform_kdp package is built and approved by platform staff only (fail closed). */
async function platformStaffGate(svc: Svc, actorUserId: string, deps: { staffReader?: KdpBuildDeps["staffReader"] }): Promise<string | null> {
  const s = await (deps.staffReader ?? defaultStaffReader)(svc, actorUserId).catch(() => ({ platformStaff: false, readable: false }))
  if (!s.readable) return "Could not verify platform staff — a platform book is packaged and approved by platform staff only."
  return s.platformStaff ? null : "This is the PLATFORM's book — only platform staff can package or approve it for KDP."
}
const defaultEntitlement: NonNullable<KdpBuildDeps["entitlement"]> = async (ask) => {
  const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
  const d = await mayUseAndAfford({ brokerageId: ask.brokerageId, capability: "ai.generate", estTokens: ask.estTokens })
  return { allowed: d.allowed, reason: d.reason }
}
const defaultCoverArt: NonNullable<KdpBuildDeps["coverArt"]> = async (a) => {
  try {
    const { generateImage } = await import("@/lib/ai/image-generation")
    const r = await generateImage({
      prompt: a.prompt, purpose: "generic", size: "1024x1792", quality: "hd", style: "natural",
      brand: { noLogo: true, mlsClean: true },
      spend: { brokerageId: a.brokerageId, userId: a.userId, feature: "book_cover", idempotencyKey: `book_cover:${a.magnetId}` },
    })
    if (!r.success || !r.imageUrl) return { bytes: null, note: `image rail returned no image (${r.error ?? "unknown"})`, costUsd: null }
    if (!/^https:\/\//i.test(r.imageUrl)) return { bytes: null, note: "image rail returned a non-https URL", costUsd: r.cost ?? null }
    const res = await fetch(r.imageUrl)
    if (!res.ok) return { bytes: null, note: `generated image could not be fetched (${res.status})`, costUsd: r.cost ?? null }
    return { bytes: Buffer.from(await res.arrayBuffer()), note: null, costUsd: r.cost ?? null }
  } catch (e) {
    return { bytes: null, note: `image rail failed: ${(e as Error).message}`, costUsd: null }
  }
}
const defaultHost: NonNullable<KdpBuildDeps["host"]> = async (svc, path, bytes, contentType) => {
  const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
  await hostRenderedMedia(svc, path, bytes, contentType, GENERATED_DOCUMENT_BUCKET)
}

function kdpInputOf(p: BookProject, authorName: string, brokerageName: string, landingUrl: string | null, year: number): KdpBookInput {
  const d = composeBookPdfData(p)
  return {
    title: d.title, subtitle: d.subtitle ?? null, tagline: d.tagline ?? null, introduction: d.introduction ?? null, closing: d.closing ?? null,
    chapters: d.chapters, audience: p.audience, area: p.area, concept: p.concept, authorName, brokerageName, landingUrl, year,
  }
}

/** Build (or rebuild) the KDP package of a finished book. Tenant + actor come from the caller's SESSION. */
export async function buildKdpPackage(args: { brokerageId: string; magnetId: string; actorUserId: string; landingUrl?: string | null }, deps: KdpBuildDeps = {}): Promise<KdpBuildResult> {
  if (!args.brokerageId || !args.magnetId || !args.actorUserId) return { ok: false, error: "Missing tenant, magnet or actor." }
  const svc = (deps.client ?? (await import("@/lib/supabase/service")).createServiceClient()) as Svc
  const loaded = await loadProject(svc, args.brokerageId, args.magnetId)
  if (!loaded.ok) return { ok: false, error: loaded.error }
  const p = loaded.project
  if (p.stage !== "ready_for_review") return { ok: false, error: `The book is still being written (stage: ${p.stage.replace(/_/g, " ")}) — finish it before packaging for KDP.` }
  if ((p.needs_human_review ?? []).length > 0) return { ok: false, error: `Chapter${p.needs_human_review.length === 1 ? "" : "s"} ${p.needs_human_review.join(", ")} still need your rewrite (the AI reached its fair-housing cap) — resolve them before packaging.` }
  if (p.chapters.length === 0) return { ok: false, error: "The book has no chapters." }
  // GATE 1b — THE HUMANIZED REVIEW: no AI-drafted chapter may still read machine-written (the human rewrites it).
  const review = humanizedReviewState(p.chapters)
  if (!review.ready) return { ok: false, error: humanizedReviewRefusal(review), blockers: { humanize: review.open } }

  // WHOSE RETAIL BOOK: a lead magnet becomes the tenant's KDP book on this request; the house tenant's is the platform's.
  const now = deps.now ?? new Date()
  const tenant = await (deps.tenantReader ?? defaultTenantReader)(svc, args.brokerageId).catch(() => ({ isHouseTenant: false, readable: false }))
  const fromContext = p.publication?.context ?? "lead_magnet"
  if (fromContext === "platform_kdp" && !tenant.readable) return { ok: false, error: "Could not verify the platform's house tenant — the platform book was not packaged." }
  const context = kdpContextFor(fromContext, tenant)
  const allowed = bookContextAllowed(context, tenant)
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (context === "platform_kdp") {
    const staff = await platformStaffGate(svc, args.actorUserId, deps)
    if (staff) return { ok: false, error: staff }
  }
  const publication = publicationRecord({ context, agentId: loaded.row.agent_id, isHouseTenant: tenant.isHouseTenant, by: args.actorUserId, at: now.toISOString(), why: "KDP package requested", prev: p.publication ?? null })

  const brand = context === "platform_kdp"
    ? await (deps.platformBrandResolver ?? defaultPlatformBrandResolver)(svc).catch(() => null)
    : await (deps.brandResolver ?? defaultBrandResolver)(svc, args.brokerageId, args.actorUserId).catch(() => null)
  const brokerageName = brand?.brokerageName || p.brand || "Our Team"
  // A platform book's author of record is the platform's brand; a tenant book's is the agent (else the brand).
  const authorName = context === "platform_kdp" ? brokerageName : (brand?.agentName?.trim() || p.brand || brokerageName)
  const rightsHolder = authorName
  const input = kdpInputOf(p, authorName, brokerageName, args.landingUrl ?? null, now.getUTCFullYear())
  const metadata = composeKdpMetadata(input)

  // GATE 2 — the claim guard (title, subtitle, tagline, description, keywords, and the words that go ON the cover).
  const claims = scanBookClaims({ title: metadata.title, subtitle: metadata.subtitle, tagline: input.tagline, description: metadata.descriptionText, keywords: metadata.keywords.join(" | "), cover: `${metadata.title} ${metadata.subtitle ?? ""} ${authorName}` })
  // GATE 3 — public-copy fair housing on what a retail page shows.
  const olderPersons = deps.olderPersons ?? (await loadOlderPersonsVerifications(svc, args.brokerageId))
  const fh = await scanPublicCopy([metadata.title, metadata.subtitle, input.tagline, metadata.descriptionText].filter(Boolean).join("\n"), "book", { brokerageName, olderPersons })
  const fairHousing = fh.ok ? [] : fh.findings.map((f) => `"${f.phrase}" — ${f.fix}`)
  // GATE 4 — KDP's metadata limits.
  const metaProblems = validateKdpMetadata(metadata)
  if (claims.length > 0 || fairHousing.length > 0 || metaProblems.length > 0) {
    return { ok: false, error: "The book's retail metadata is not ready — resolve these first.", blockers: { claims: claims.length ? claims : undefined, fairHousing: fairHousing.length ? fairHousing : undefined, metadata: metaProblems.length ? metaProblems : undefined } }
  }

  // THE BRAND ON THE BOOK — the APPROVED tagline only: a tagline the claim guard or the public-copy fair-housing gate flags
  // is left off (the book is not held for it); the logo is the brand's own file, never AI-made.
  // Through the ONE vetting the lead-magnet PDF shares (approvedBookBrandAssets above).
  const assets = await approvedBookBrandAssets(brand, { brokerageName, olderPersons, fetchLogo: deps.fetchLogo })
  const warnings: string[] = [...assets.warnings]
  const brandTagline: string | null = assets.tagline
  const logo: Buffer | null = assets.logo
  let logoState: NonNullable<KdpPackageRecord["brand"]>["logo"] = assets.logoUnreadable ? "unreadable" : "none"

  // THE COVER — art from the image rail when the tenant may spend on it, else typography.
  let art: Buffer | null = null
  let artNote: string | null = null
  const ent = await (deps.entitlement ?? defaultEntitlement)({ brokerageId: args.brokerageId, estTokens: COVER_EST_TOKENS }).catch((e) => ({ allowed: false, reason: `entitlement_threw: ${(e as Error).message}` }))
  if (ent.allowed) {
    const a = await (deps.coverArt ?? defaultCoverArt)({ brokerageId: args.brokerageId, userId: args.actorUserId, magnetId: args.magnetId, prompt: coverArtPrompt({ title: metadata.title, audience: p.audience, area: p.area }) })
    art = a.bytes
    artNote = a.note
  } else {
    artNote = `cover art not generated: ${ent.reason}`
  }
  if (!art) warnings.push(`The cover is typography only — ${artNote ?? "no art was produced"}. You can regenerate once the image rail is available.`)
  const cover: BookCoverResult = await composeBookCover({ title: metadata.title, subtitle: metadata.subtitle, authorName, primaryColor: brand?.primaryColor ?? null, accentColor: brand?.accentColor ?? null, brandTagline, logo, art })
  if (logo && cover.usedLogo) logoState = "embedded"
  else if (logo && !cover.usedLogo) { logoState = "unreadable"; warnings.push("The brand logo file could not be decoded — the cover carries no logo.") }
  const meta = await sharp(cover.jpeg).metadata()
  const coverProblems = validateEbookCover({ width: meta.width ?? 0, height: meta.height ?? 0, bytes: cover.bytes, format: meta.format ?? "unknown" })
  if (coverProblems.length > 0) return { ok: false, error: "The cover does not meet KDP's eBook cover rules.", blockers: { cover: coverProblems } }

  const identifier = deps.id ?? randomUUID()
  const epub = buildEpub({ ...input, coverJpeg: cover.jpeg, identifier, description: metadata.descriptionText, brandTagline, rightsHolder, now })
  const words = wordsIn([input.introduction, ...input.chapters.map((c) => c.body), input.closing].filter(Boolean).join("\n\n"))
  const paperback = kdpPaperbackPlan(words)
  if (!kdpTrimAllowed(paperback.trimIn.width, paperback.trimIn.height)) warnings.push(`PAPERBACK: the planned trim ${paperback.trimIn.width}×${paperback.trimIn.height} in is outside KDP's allowed range`)
  const rights = composeRightsRecord({ authorName, year: now.getUTCFullYear(), coverArt: cover.usedArt ? "image_rail" : "typographic_only", publication: { context: context === "platform_kdp" ? "platform_kdp" : "tenant_kdp", owner: publication.owner, rightsHolder } })

  const base = `client-docs/${args.brokerageId}/kdp/${args.magnetId}`
  const epubPath = `${base}/book.epub`, coverPath = `${base}/cover.jpg`
  const host = deps.host ?? defaultHost
  try {
    await host(svc, epubPath, epub, "application/epub+zip")
    await host(svc, coverPath, cover.jpeg, "image/jpeg")
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  const record: KdpPackageRecord = {
    built_at: now.toISOString(), built_by: args.actorUserId,
    files: { epub: { bucket: GENERATED_DOCUMENT_BUCKET, path: epubPath, bytes: epub.length }, cover: { bucket: GENERATED_DOCUMENT_BUCKET, path: coverPath, bytes: cover.bytes, width: cover.width, height: cover.height } },
    metadata, rights, paperback, words, cover_art: cover.usedArt ? "image_rail" : "typographic_only", cover_art_note: artNote, warnings: [...warnings, ...paperback.blockers.map((b) => `PAPERBACK: ${b}`)],
    approval: null,
    publication,
    brand: { source: publication.brand_source, logo: logoState, tagline: brandTagline, primary_color: brand?.primaryColor ?? null, accent_color: brand?.accentColor ?? null },
  }
  // The book records its (possibly new) publication context in the same counted write as the package.
  const saved = await savePackage(svc, args.brokerageId, args.magnetId, args.actorUserId, loaded.row.settings, record, "build", now, { publication })
  if (saved) return { ok: false, error: saved }
  return { ok: true, record }
}

async function savePackage(svc: Svc, brokerageId: string, magnetId: string, actorUserId: string, settings: Record<string, unknown>, record: KdpPackageRecord, kind: "build" | "approve", now: Date, bookPatch: Record<string, unknown> | null = null): Promise<string | null> {
  const book = settings.book && typeof settings.book === "object" ? (settings.book as Record<string, unknown>) : null
  const nextSettings = { ...settings, book_publishing: record, ...(book && bookPatch ? { book: { ...book, ...bookPatch } } : {}) }
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const res = await withActionLedger<string | null>(
    {
      brokerageId, action: kind === "build" ? "marketing.lead_magnet.kdp_package" : "marketing.lead_magnet.kdp_approve",
      actor: { type: "user", userId: actorUserId }, subject: { type: "lead_capture_form", id: magnetId }, reasonCode: "HUMAN_REQUESTED",
      reasonDetail: kind === "build" ? `human request: KDP package for book "${record.metadata.title}"` : `human approval: KDP package for "${record.metadata.title}" — rights and AI disclosure attested`,
      riskClass: "LOW_RISK_WRITE", systemSource: "lead_magnets",
      detail: { cover_art: record.cover_art, words: record.words, attested: record.approval?.attestations ?? [], warnings: record.warnings.length, context: record.publication?.context ?? null, owner: record.publication?.owner ?? null, logo: record.brand?.logo ?? null },
    },
    async () => {
      const { data, error } = await svc.from("lead_capture_forms").update({ settings: nextSettings, updated_at: now.toISOString() }).eq("brokerage_id", brokerageId).eq("id", magnetId).select("id")
      if (error) return `KDP package not saved: ${error.message}`
      if ((data ?? []).length !== 1) return "KDP package not saved: no row matched this brokerage + id"
      return null
    },
    { settle: (err) => (err ? { status: "failed", outcome: "save_refused", error: err } : { status: "executed", outcome: kind === "build" ? "packaged" : "approved" }), replay: (claim) => `ledger refused the KDP ${kind}: ${claim.kind}` },
    { client: svc as never },
  )
  return res
}

/** The recorded package on a magnet's settings (null when none). PURE. */
export function kdpPackageOf(settings: Record<string, unknown> | null | undefined): KdpPackageRecord | null {
  const r = (settings ?? {}).book_publishing as KdpPackageRecord | undefined
  return r && typeof r === "object" && r.files && r.metadata ? r : null
}

/**
 * The human's approval: every attestation, by id, by a session user. Re-building the package clears it (the files changed).
 * Wave 144: the humanized_review attestation is one of them, and the sign-off is recorded on the book
 * (settings.book.humanized_review); a package built before the manuscript last changed is refused (the files are stale);
 * a PLATFORM book is approved by platform staff only.
 */
export async function approveKdpPackage(args: { brokerageId: string; magnetId: string; actorUserId: string; attested: string[] }, deps: { client?: Svc; now?: Date; staffReader?: KdpBuildDeps["staffReader"] } = {}): Promise<{ ok: true; record: KdpPackageRecord } | { ok: false; error: string }> {
  if (!args.brokerageId || !args.magnetId || !args.actorUserId) return { ok: false, error: "Missing tenant, magnet or approver." }
  const svc = (deps.client ?? (await import("@/lib/supabase/service")).createServiceClient()) as Svc
  const { data, error } = await svc.from("lead_capture_forms").select("id, settings").eq("id", args.magnetId).eq("brokerage_id", args.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `Could not read the magnet: ${error.message}` }
  if (!data) return { ok: false, error: "Lead magnet not found in this brokerage." }
  const settings = ((data as { settings?: Record<string, unknown> | null }).settings ?? {}) as Record<string, unknown>
  const pkg = kdpPackageOf(settings)
  if (!pkg) return { ok: false, error: "No KDP package has been built for this book yet." }
  if (!pkg.rights.attestations.some((a) => a.id === "humanized_review")) return { ok: false, error: "This package was built before the humanized review was required — rebuild it, then approve." }
  const book = (settings.book ?? null) as BookProject | null
  if (book?.updated_at && pkg.built_at && book.updated_at > pkg.built_at) return { ok: false, error: "The manuscript changed after this package was built — rebuild the package so the files match the book, then approve." }
  const review = humanizedReviewState(book?.chapters ?? [])
  if (!review.ready) return { ok: false, error: humanizedReviewRefusal(review) }
  if (pkg.publication?.context === "platform_kdp") {
    const staff = await platformStaffGate(svc, args.actorUserId, deps)
    if (staff) return { ok: false, error: staff }
  }
  const missing = KDP_ATTESTATIONS.filter((a) => !args.attested.includes(a.id)).map((a) => a.id)
  if (missing.length > 0) return { ok: false, error: `Every attestation is required before approval — missing: ${missing.join(", ")}.` }
  const now = deps.now ?? new Date()
  const record: KdpPackageRecord = { ...pkg, approval: { by: args.actorUserId, at: now.toISOString(), attestations: KDP_ATTESTATIONS.map((a) => a.id) } }
  const signOff: HumanizedReviewRecord = { by: args.actorUserId, at: now.toISOString(), basis: "kdp_attestation", chapters_human_revised: review.humanRevised, ai_tells_open: 0 }
  const err = await savePackage(svc, args.brokerageId, args.magnetId, args.actorUserId, settings, record, "approve", now, book ? { humanized_review: signOff } : null)
  return err ? { ok: false, error: err } : { ok: true, record }
}

/** Fresh signed URLs for the package files (the bucket is private; a stored URL would expire). Tenant-pinned. */
export async function kdpPackageDownloads(args: { brokerageId: string; magnetId: string }, deps: { client?: Svc } = {}): Promise<{ ok: true; epubUrl: string; coverUrl: string } | { ok: false; error: string }> {
  const svc = (deps.client ?? (await import("@/lib/supabase/service")).createServiceClient()) as Svc
  const { data, error } = await svc.from("lead_capture_forms").select("settings").eq("id", args.magnetId).eq("brokerage_id", args.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `Could not read the magnet: ${error.message}` }
  const pkg = kdpPackageOf(((data as { settings?: Record<string, unknown> | null } | null)?.settings ?? null))
  if (!pkg) return { ok: false, error: "No KDP package has been built for this book yet." }
  const epub = await issueBucketObjectUrl(svc as never, { bucket: pkg.files.epub.bucket, objectPath: pkg.files.epub.path })
  const cover = await issueBucketObjectUrl(svc as never, { bucket: pkg.files.cover.bucket, objectPath: pkg.files.cover.path })
  if (!epub.ok) return { ok: false, error: epub.reason }
  if (!cover.ok) return { ok: false, error: cover.reason }
  return { ok: true, epubUrl: epub.url, coverUrl: cover.url }
}
