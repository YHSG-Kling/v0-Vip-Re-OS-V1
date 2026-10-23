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

import "server-only"
import { randomUUID } from "node:crypto"
import sharp from "sharp"
import { loadProject, composeBookPdfData, type BookProject } from "./book-creator"
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
}

export interface KdpBuildDeps {
  client?: Svc
  /** The tenant's recorded older-persons exemptions (default: loaded). */
  olderPersons?: Awaited<ReturnType<typeof loadOlderPersonsVerifications>>
  /** Brand resolver (default: the PDF producer's, the same one the book layout uses). */
  brandResolver?: (svc: Svc, brokerageId: string, agentUserId: string | null) => Promise<{ brokerageName: string; agentName?: string | null; primaryColor?: string | null }>
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
  | { ok: false; error: string; blockers?: { claims?: BookClaimFinding[]; fairHousing?: string[]; metadata?: KdpMetadataProblem[]; cover?: string[] } }

const COVER_EST_TOKENS = 1500

const defaultBrandResolver: NonNullable<KdpBuildDeps["brandResolver"]> = async (svc, brokerageId, agentUserId) => {
  const { resolvePdfBrand } = await import("@/lib/documents/client-document-producer")
  return resolvePdfBrand(svc as never, { brokerageId, agentUserId })
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

  const now = deps.now ?? new Date()
  const brand = await (deps.brandResolver ?? defaultBrandResolver)(svc, args.brokerageId, args.actorUserId).catch(() => null)
  const brokerageName = brand?.brokerageName || p.brand || "Our Team"
  const authorName = brand?.agentName?.trim() || p.brand || brokerageName
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

  // THE COVER — art from the image rail when the tenant may spend on it, else typography.
  const warnings: string[] = []
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
  const cover: BookCoverResult = await composeBookCover({ title: metadata.title, subtitle: metadata.subtitle, authorName, primaryColor: brand?.primaryColor ?? null, art })
  const meta = await sharp(cover.jpeg).metadata()
  const coverProblems = validateEbookCover({ width: meta.width ?? 0, height: meta.height ?? 0, bytes: cover.bytes, format: meta.format ?? "unknown" })
  if (coverProblems.length > 0) return { ok: false, error: "The cover does not meet KDP's eBook cover rules.", blockers: { cover: coverProblems } }

  const identifier = deps.id ?? randomUUID()
  const epub = buildEpub({ ...input, coverJpeg: cover.jpeg, identifier, description: metadata.descriptionText, now })
  const words = wordsIn([input.introduction, ...input.chapters.map((c) => c.body), input.closing].filter(Boolean).join("\n\n"))
  const paperback = kdpPaperbackPlan(words)
  if (!kdpTrimAllowed(paperback.trimIn.width, paperback.trimIn.height)) warnings.push(`PAPERBACK: the planned trim ${paperback.trimIn.width}×${paperback.trimIn.height} in is outside KDP's allowed range`)
  const rights = composeRightsRecord({ authorName, year: now.getUTCFullYear(), coverArt: cover.usedArt ? "image_rail" : "typographic_only" })

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
  }
  const saved = await savePackage(svc, args.brokerageId, args.magnetId, args.actorUserId, loaded.row.settings, record, "build", now)
  if (saved) return { ok: false, error: saved }
  return { ok: true, record }
}

async function savePackage(svc: Svc, brokerageId: string, magnetId: string, actorUserId: string, settings: Record<string, unknown>, record: KdpPackageRecord, kind: "build" | "approve", now: Date): Promise<string | null> {
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const res = await withActionLedger<string | null>(
    {
      brokerageId, action: kind === "build" ? "marketing.lead_magnet.kdp_package" : "marketing.lead_magnet.kdp_approve",
      actor: { type: "user", userId: actorUserId }, subject: { type: "lead_capture_form", id: magnetId }, reasonCode: "HUMAN_REQUESTED",
      reasonDetail: kind === "build" ? `human request: KDP package for book "${record.metadata.title}"` : `human approval: KDP package for "${record.metadata.title}" — rights and AI disclosure attested`,
      riskClass: "LOW_RISK_WRITE", systemSource: "lead_magnets",
      detail: { cover_art: record.cover_art, words: record.words, attested: record.approval?.attestations ?? [], warnings: record.warnings.length },
    },
    async () => {
      const { data, error } = await svc.from("lead_capture_forms").update({ settings: { ...settings, book_publishing: record }, updated_at: now.toISOString() }).eq("brokerage_id", brokerageId).eq("id", magnetId).select("id")
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

/** The human's approval: every attestation, by id, by a session user. Re-building the package clears it (the files changed). */
export async function approveKdpPackage(args: { brokerageId: string; magnetId: string; actorUserId: string; attested: string[] }, deps: { client?: Svc; now?: Date } = {}): Promise<{ ok: true; record: KdpPackageRecord } | { ok: false; error: string }> {
  if (!args.brokerageId || !args.magnetId || !args.actorUserId) return { ok: false, error: "Missing tenant, magnet or approver." }
  const svc = (deps.client ?? (await import("@/lib/supabase/service")).createServiceClient()) as Svc
  const { data, error } = await svc.from("lead_capture_forms").select("id, settings").eq("id", args.magnetId).eq("brokerage_id", args.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `Could not read the magnet: ${error.message}` }
  if (!data) return { ok: false, error: "Lead magnet not found in this brokerage." }
  const settings = ((data as { settings?: Record<string, unknown> | null }).settings ?? {}) as Record<string, unknown>
  const pkg = kdpPackageOf(settings)
  if (!pkg) return { ok: false, error: "No KDP package has been built for this book yet." }
  const missing = KDP_ATTESTATIONS.filter((a) => !args.attested.includes(a.id)).map((a) => a.id)
  if (missing.length > 0) return { ok: false, error: `Every attestation is required before approval — missing: ${missing.join(", ")}.` }
  const now = deps.now ?? new Date()
  const record: KdpPackageRecord = { ...pkg, approval: { by: args.actorUserId, at: now.toISOString(), attestations: KDP_ATTESTATIONS.map((a) => a.id) } }
  const err = await savePackage(svc, args.brokerageId, args.magnetId, args.actorUserId, settings, record, "approve", now)
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
