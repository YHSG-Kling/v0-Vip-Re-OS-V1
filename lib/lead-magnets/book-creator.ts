// lib/lead-magnets/book-creator.ts
//
// THE BOOK CREATOR — wave 142, lane 142E (owner: "we have built a capability for creating a book to publish
// for using as a lead magnet but not sure if it built correctly"). Audited at fec8b6a95: NO book pipeline
// existed — lib/education/book-authority-program.ts is a CURRICULUM that coaches agents to write their own
// book (KDP), and the nearest producing survivor is the buyer/seller GUIDE BOOKLET (a 5-chapter PDF the
// lead-magnet delivery renders). This is the smallest production pipeline, built ON those survivors:
//
//   concept → RESEARCH (lib/marketing/content-topics-runner.ts fetchContentTopics — the gated, platform-
//   covered search rail — plus lib/content-intel/topic-bank.ts pickTopics, the tenant's own topic bank)
//   → OUTLINE (routed lane book_manuscript) → ORIGINAL CHAPTERS (same lane, a bounded number per advance)
//   → FACT CHECK (routed lane book_fact_check + the deterministic unsupportedFigures scan: every figure,
//   statistic, date or law the chapters assert that the research did not supply is a finding)
//   → EDIT (one pass per chapter resolving the fact findings, then the public-copy FAIR-HOUSING REWRITE
//   LOOP, lib/kernel/marketing/public-copy-rewrite.ts, capped and escalated per chapter)
//   → COVER + LAYOUT + PDF (lib/documents/client-pdf.ts bookPdfSpec on the SAME engine as the booklet;
//   hosted + recorded in the document library by lib/documents/client-document-producer.ts)
//   → the DRAFT lead magnet it rides on (lib/kernel/lead-magnets.ts — the project record lives in
//   lead_capture_forms.settings.book; a human reviews, edits and PUBLISHES it — publishLeadMagnet refuses
//   an unfinished book) → capture → DELIVERY (lead-magnet-delivery-runner ships the book PDF and records
//   the asset refs on the activity) → follow-up → attribution (the existing spine, untouched).
//
// STAGED AND RESUMABLE: one advance = one stage (or a bounded slice of one), each a counted, tenant-pinned
// write of the project record under withActionLedger evidence and the routed lane's cost booking; the UI
// auto-continues, the daily sweep is the safety net (CLAUDE.md wave 142: cron is a backup). Every
// collaborator is a seam so scripts/autonomous-marketing-guard.ts drives the whole pipeline in memory
// with real PDF bytes. No model ever fills a fact: the writer is told to state NO figures; whatever it
// states anyway is caught and removed. Entitlement (mayUseAndAfford "ai.generate") before every spend.

import { createLeadMagnet, type CreateLeadMagnetInput } from "@/lib/kernel/lead-magnets"
import { bookPdfSpec, type BookPdfData, type ClientPdfBrand, type ClientPdfSpec } from "@/lib/documents/client-pdf"
import { rewritePublicCopyUntilCompliant, scanPublicCopy, renderFindingsForRewrite, type CopyFinding } from "@/lib/kernel/marketing/public-copy-rewrite"
import type { ContentTopic } from "@/lib/marketing/content-topics"
// Wave 143 (lane 143F): a "55+ / senior living" claim in a chapter is verified against the tenant's recorded
// housing-for-older-persons exemption (42 U.S.C. § 3607(b)); a held claim is rewritten around, then a human decides.
import { OLDER_PERSONS_WRITING_DIRECTIVE } from "@/lib/compliance/fair-housing-older-persons"
import { loadOlderPersonsVerifications } from "@/lib/compliance/fair-housing-older-persons-store"

// ── The project record (lead_capture_forms.settings.book) ─────────────────────────────────────────

export const BOOK_STAGES = ["research", "outline", "chapters", "fact_check", "edit", "layout", "ready_for_review"] as const
export type BookStage = (typeof BOOK_STAGES)[number]

export type BookAudience = "buyer" | "seller"

interface BookChapter {
  heading: string
  body: string
  words: number
  written_at: string
  /** Set by the edit pass: fact findings resolved, fair-housing rewrites run, escalated to a human? */
  edited?: { fact_findings: number; fair_housing_rewrites: number; escalated: boolean; findings: string[]; human_revised_at?: string }
}

interface BookFactFinding {
  chapter: number
  claim: string
  verdict: "unsupported" | "needs_qualification"
  note: string
  /** "model" for the fact-check lane's finding, "scan" for the deterministic figure scan. */
  by: "model" | "scan"
}

export interface BookProject {
  stage: BookStage
  concept: string
  audience: BookAudience
  area: string | null
  brand: string | null
  title: string
  subtitle: string | null
  tagline: string | null
  introduction: string | null
  closing: string | null
  research: { topics: string[]; bank_topics: string[]; fetched_at: string | null } | null
  outline: Array<{ heading: string; summary: string; key_points: string[] }> | null
  chapters: BookChapter[]
  fact_check: { findings: BookFactFinding[]; checked_at: string } | null
  pdf_url: string | null
  document_id: string | null
  page_count: number | null
  /** The reviewer's tally — the routed lane books the ledger; this is what THIS book cost in tokens. */
  cost: { tokens: number; model_calls: number }
  /** Chapters the edit pass could not make compliant within the cap — the human owns them. */
  needs_human_review: number[]
  started_by: string
  started_at: string
  updated_at: string
  log: Array<{ stage: BookStage; at: string; note: string }>
}

/** Public-facing surface text the book's landing page carries once the title exists. */
export const BOOK_MIN_CHAPTERS = 4
export const BOOK_MAX_CHAPTERS = 10
/** Chapters written / edited per advance — bounded so one advance fits a request. */
export const BOOK_CHAPTERS_PER_ADVANCE = 2
/** A chapter under this many words is a stub, not a chapter — refused and rewritten. */
export const BOOK_MIN_CHAPTER_WORDS = 250
/** The budget ask handed to mayUseAndAfford per advance (one chapter ≈ 1,800 tokens; an advance writes two). */
const BOOK_ADVANCE_EST_TOKENS = 4500

// ── PURE helpers (proven directly) ────────────────────────────────────────────────────────────────

/** @proofSeam the stage order is the contract the UI and the sweep walk. */
export function nextBookStage(stage: BookStage): BookStage {
  const i = BOOK_STAGES.indexOf(stage)
  return i < 0 || i >= BOOK_STAGES.length - 1 ? "ready_for_review" : BOOK_STAGES[i + 1]
}

export function wordCount(text: string): number {
  return (text ?? "").trim().split(/\s+/).filter(Boolean).length
}

/** The first `{…}` object in a model answer, or null — never a throw. */
export function parseJsonObject<T = Record<string, unknown>>(text: string): T | null {
  const m = (text ?? "").match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) as T } catch { return null }
}

/**
 * PURE: every FIGURE a chapter asserts — a percentage, a dollar amount, a 4-digit year, a "N days/months/
 * years" span, a statute number — that the research corpus (topics + outline + concept) never supplied.
 * A figure that appears verbatim in the allowed text is supported (the writer repeated what it was given);
 * everything else is unsupported and the edit pass removes or qualifies it. @proofSeam asserted directly.
 */
export function unsupportedFigures(chapterBody: string, allowedText: string): string[] {
  const allowed = (allowedText ?? "").toLowerCase()
  const FIGURE = /(\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|million|billion))?|\d+(?:\.\d+)?\s?%|\b(?:19|20)\d{2}\b|\b\d+(?:\.\d+)?\s+(?:percent|days?|months?|years?|basis points?)\b|§\s?\d[\d.()a-z-]*)/gi
  const out = new Set<string>()
  for (const m of (chapterBody ?? "").matchAll(FIGURE)) {
    const fig = m[1].trim()
    if (!allowed.includes(fig.toLowerCase())) out.add(fig)
  }
  return [...out]
}

/** PURE: the PDF spec data for a finished manuscript. */
export function composeBookPdfData(p: BookProject): BookPdfData {
  return {
    title: p.title,
    subtitle: p.subtitle,
    tagline: p.tagline,
    introduction: p.introduction,
    chapters: p.chapters.map((c) => ({ heading: c.heading, body: c.body })),
    closing: p.closing,
    areaLabel: p.area,
  }
}

/** PURE: the corpus a chapter's figures are checked against — what the writer was GIVEN. */
function allowedCorpus(p: BookProject): string {
  return [p.concept, ...(p.research?.topics ?? []), ...(p.research?.bank_topics ?? []), ...(p.outline ?? []).flatMap((o) => [o.heading, o.summary, ...o.key_points])].join("\n")
}

function newProject(input: { concept: string; audience: BookAudience; area: string | null; brand: string | null; startedBy: string; now: string }): BookProject {
  return {
    stage: "research", concept: input.concept, audience: input.audience, area: input.area, brand: input.brand,
    title: workingTitle(input.concept), subtitle: null, tagline: null, introduction: null, closing: null,
    research: null, outline: null, chapters: [], fact_check: null, pdf_url: null, document_id: null, page_count: null,
    cost: { tokens: 0, model_calls: 0 }, needs_human_review: [], started_by: input.startedBy, started_at: input.now, updated_at: input.now,
    log: [{ stage: "research", at: input.now, note: "book project started" }],
  }
}

/** PURE: a working title from the concept until the outline names the real one. */
export function workingTitle(concept: string): string {
  const c = (concept ?? "").replace(/\s+/g, " ").trim()
  if (!c) return "Untitled book"
  const first = c.split(/[.:;!?]/)[0].trim()
  const t = first.length > 70 ? `${first.slice(0, 67).trim()}…` : first
  return t.charAt(0).toUpperCase() + t.slice(1)
}

// ── Seams ─────────────────────────────────────────────────────────────────────────────────────────

interface BookWriterRequest {
  brokerageId: string
  userId: string | null
  system: string
  prompt: string
  maxTokens: number
}
interface BookWriterResult { text: string; tokens: number; model: string | null }
/** The manuscript lane (outline, chapters, edit) and the fact-check lane — two routed features. */
type BookWriter = (req: BookWriterRequest) => Promise<BookWriterResult | null>

type Svc = { from: (t: string) => any }

export interface BookDeps {
  client?: NonNullable<Parameters<typeof createLeadMagnet>[1]>["client"]
  /** The gated search rail (default fetchContentTopics, platform-covered, tenant-attributed). */
  researcher?: (audience: BookAudience, area: string | null, brokerageId: string) => Promise<ContentTopic[]>
  /** The tenant's own topic bank (default pickTopics on the same client). */
  topicReader?: (brokerageId: string, svc: Svc) => Promise<string[]>
  manuscriptWriter?: BookWriter
  factCheckWriter?: BookWriter
  entitlement?: (ask: { brokerageId: string; estTokens: number; actor?: { platformRole?: string | null; userType?: string | null } | null }) => Promise<{ allowed: boolean; reason: string; message?: string }>
  brandResolver?: (svc: Svc, brokerageId: string, agentUserId: string | null) => Promise<ClientPdfBrand>
  /** Render + host + record (default produceClientDocument). The proof's producer renders REAL bytes too. */
  producer?: (svc: Svc, args: { brokerageId: string; agentUserId: string | null; spec: ClientPdfSpec; metadata: Record<string, unknown> }) => Promise<{ ok: boolean; pdfUrl: string | null; documentId: string | null; pageCount: number | null; error: string | null }>
  chaptersPerAdvance?: number
  now?: Date
}

// ── Production defaults (routed, feature-keyed, tenant-booked; lazy so the proof never loads them) ──

const routedManuscriptWriter: BookWriter = async (req) => {
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { text, usage } = await generateTextRouted({ feature: "book_manuscript", brokerageId: req.brokerageId, userId: req.userId, system: req.system, prompt: req.prompt, maxTokens: req.maxTokens, temperature: 0.6 })
    return { text, tokens: usage?.totalTokens ?? 0, model: usage?.model ?? null }
  } catch {
    return null
  }
}

const routedFactCheckWriter: BookWriter = async (req) => {
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { text, usage } = await generateTextRouted({ feature: "book_fact_check", brokerageId: req.brokerageId, userId: req.userId, system: req.system, prompt: req.prompt, maxTokens: req.maxTokens, temperature: 0 })
    return { text, tokens: usage?.totalTokens ?? 0, model: usage?.model ?? null }
  } catch {
    return null
  }
}

const defaultResearcher: NonNullable<BookDeps["researcher"]> = async (audience, area, brokerageId) => {
  const { fetchContentTopics } = await import("@/lib/marketing/content-topics-runner")
  return fetchContentTopics(audience === "buyer" ? "buyer_guide" : "seller_guide", area, { brokerageId, limit: 10 })
}

const defaultTopicReader: NonNullable<BookDeps["topicReader"]> = async (brokerageId, svc) => {
  const { pickTopics } = await import("@/lib/content-intel/topic-bank")
  const topics = await pickTopics({ brokerageId, limit: 6, client: svc as never })
  return topics.map((t) => (t.value_angle ? `${t.topic_title} — ${t.value_angle}` : t.topic_title))
}

const defaultEntitlement: NonNullable<BookDeps["entitlement"]> = async (ask) => {
  const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
  const d = await mayUseAndAfford({ brokerageId: ask.brokerageId, capability: "ai.generate", estTokens: ask.estTokens, actor: ask.actor ?? null })
  return { allowed: d.allowed, reason: d.reason, message: d.message }
}

const defaultBrandResolver: NonNullable<BookDeps["brandResolver"]> = async (svc, brokerageId, agentUserId) => {
  const { resolvePdfBrand } = await import("@/lib/documents/client-document-producer")
  return resolvePdfBrand(svc, { brokerageId, agentUserId })
}

const defaultProducer: NonNullable<BookDeps["producer"]> = async (svc, args) => {
  const { produceClientDocument } = await import("@/lib/documents/client-document-producer")
  const r = await produceClientDocument(svc, { brokerageId: args.brokerageId, agentUserId: args.agentUserId, documentType: "book", spec: args.spec, metadata: args.metadata })
  return { ok: r.ok, pdfUrl: r.pdfUrl, documentId: r.documentId, pageCount: null, error: r.error }
}

// ── The writing rules (the prompt carries fair housing — CLAUDE.md §5) ────────────────────────────

function manuscriptSystem(p: BookProject): string {
  return (
    `You are ghost-writing an ORIGINAL ${p.audience === "buyer" ? "home-buyer's" : "home-seller's"} book for a real-estate ${p.brand ? `brand, ${p.brand}` : "agent"}${p.area ? ` serving ${p.area}` : ""}. ` +
    "HARD RULES: (1) FAIR HOUSING — never reference or imply race, religion, national origin, family status, disability, sex, or use steering language ('safe neighborhood', 'perfect for families', 'great for retirees', 'exclusive community', 'good schools'); describe the home, the process and the service, never who should want it. " +
    OLDER_PERSONS_WRITING_DIRECTIVE + " " +
    "(2) STATE NO FIGURES: no prices, rates, percentages, statistics, dates, deadlines or statute numbers — speak in process and principles; a figure you were not given is a fabrication. " +
    "(3) No legal, tax or lending advice; no guarantees or market predictions. (4) Plain, warm, specific prose in the agent's voice — a knowledgeable coach, never a template. (5) Original writing only: never reproduce another author's or a competitor's wording."
  )
}

function outlinePrompt(p: BookProject): string {
  const asked = (p.research?.topics ?? []).slice(0, 10)
  const bank = (p.research?.bank_topics ?? []).slice(0, 6)
  return (
    `Concept from the agent: ${p.concept}\n` +
    (asked.length ? `What ${p.audience}s are actually asking right now:\n${asked.map((t) => `- ${t}`).join("\n")}\n` : "") +
    (bank.length ? `Topics the brokerage is already seeing traction on (inspiration only, never copy):\n${bank.map((t) => `- ${t}`).join("\n")}\n` : "") +
    `Plan a ${BOOK_MIN_CHAPTERS}-${BOOK_MAX_CHAPTERS} chapter book. Return ONLY JSON: {"title": "≤60 chars", "subtitle": "≤90 chars", "tagline": "one line for the cover", "introduction": "two short paragraphs", "closing": "one short closing paragraph inviting the reader to talk to the agent", "chapters": [{"heading": "Chapter title", "summary": "2 sentences", "key_points": ["3-5 points the chapter must cover"]}]}`
  )
}

function chapterPrompt(p: BookProject, i: number): string {
  const o = p.outline![i]
  return (
    `Book: "${p.title}"${p.subtitle ? ` — ${p.subtitle}` : ""}. Write chapter ${i + 1} of ${p.outline!.length}: "${o.heading}".\n` +
    `Summary: ${o.summary}\nIt must cover:\n${o.key_points.map((k) => `- ${k}`).join("\n")}\n` +
    (p.research?.topics?.length ? `Questions readers actually ask (answer the relevant ones in prose):\n${p.research.topics.slice(0, 8).map((t) => `- ${t}`).join("\n")}\n` : "") +
    `Write 450-700 words of original prose in 4-6 paragraphs separated by blank lines. Return ONLY the chapter text — no heading, no JSON, no figures.`
  )
}

function factCheckSystem(): string {
  return "You are a fact-checker for a real-estate book. You review chapters against the research the writer was given and flag every claim the research does NOT support: any price, rate, percentage, statistic, date, deadline, legal rule, statute, program name or guarantee. You never rewrite; you only report. Return STRICT JSON."
}

function factCheckPrompt(p: BookProject, chapters: Array<{ i: number; body: string }>): string {
  return (
    `Research the writer was given:\n${allowedCorpus(p).slice(0, 6000)}\n\n` +
    chapters.map((c) => `=== CHAPTER ${c.i + 1}: ${p.chapters[c.i].heading} ===\n${c.body}`).join("\n\n") +
    `\n\nReturn ONLY JSON: {"findings": [{"chapter": <1-based number>, "claim": "the exact words", "verdict": "unsupported" | "needs_qualification", "note": "why"}]} — an empty findings array when every claim is supported by the research.`
  )
}

function editPrompt(p: BookProject, i: number, factFindings: BookFactFinding[], fh: CopyFinding[]): string {
  return (
    `Book: "${p.title}". Chapter ${i + 1}: "${p.chapters[i].heading}".\n\nCURRENT TEXT:\n${p.chapters[i].body}\n\n` +
    (factFindings.length ? `FACT-CHECK FINDINGS (remove each unsupported figure or claim, or restate it without the number — never invent a replacement):\n${factFindings.map((f) => `- "${f.claim}" — ${f.verdict}: ${f.note}`).join("\n")}\n\n` : "") +
    (fh.length ? `FAIR-HOUSING FINDINGS (resolve every one):\n${renderFindingsForRewrite(fh)}\n\n` : "") +
    `Rewrite the chapter resolving every finding, keeping its length, structure and voice. Return ONLY the chapter text.`
  )
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────────

interface StartBookInput {
  /** The VERIFIED tenant (session) — never a request body. */
  brokerageId: string
  /** agents.id (lead_capture_forms.agent_id). */
  agentId: string
  /** users.id of the requester — the ledger's actor. */
  createdBy: string
  concept: string
  audience: BookAudience
  area?: string | null
  brand?: string | null
  actor?: { platformRole?: string | null; userType?: string | null } | null
}

interface StartBookOutput { success: boolean; magnetId?: string; slug?: string; title?: string; error?: string }

/**
 * Concept → a DRAFT lead magnet carrying a NEW book project at stage "research". Entitlement first (a refusal
 * writes nothing). The magnet type is the audience's guide type, so capture, intent routing and attribution
 * ride the survivors unchanged; the book replaces the booklet at delivery once it is finished.
 */
export async function startBookProject(input: StartBookInput, deps: BookDeps = {}): Promise<StartBookOutput> {
  const concept = (input.concept ?? "").trim()
  if (!input.brokerageId || !input.agentId || !input.createdBy) return { success: false, error: "Missing required fields: brokerageId, agentId, createdBy" }
  if (concept.length < 12) return { success: false, error: "Describe the book in a sentence or two first." }
  if (input.audience !== "buyer" && input.audience !== "seller") return { success: false, error: "The book's audience must be buyer or seller." }
  const gate = deps.entitlement ?? defaultEntitlement
  const verdict = await gate({ brokerageId: input.brokerageId, estTokens: BOOK_ADVANCE_EST_TOKENS, actor: input.actor ?? null }).catch((e): { allowed: boolean; reason: string; message?: string } => ({ allowed: false, reason: `entitlement_threw: ${(e as Error)?.message ?? String(e)}` }))
  if (!verdict.allowed) return { success: false, error: verdict.message ?? `AI book writing is not available right now (${verdict.reason}).` }

  const now = (deps.now ?? new Date()).toISOString()
  const project = newProject({ concept, audience: input.audience, area: input.area ?? null, brand: input.brand ?? null, startedBy: input.createdBy, now })
  const magnetType: CreateLeadMagnetInput["magnetType"] = input.audience === "buyer" ? "buyer_guide" : "seller_guide"
  const createInput: CreateLeadMagnetInput = {
    title: project.title,
    description: `A ${input.audience}'s book written from the agent's concept: ${concept.slice(0, 160)}`,
    magnetType,
    brokerageId: input.brokerageId,
    agentId: input.agentId,
    createdBy: input.createdBy,
    thankYouMessage: "Thank you! Your book is on its way to your inbox.",
    publishState: "draft",
    settings: {
      authoring: { by: "ai", feature: "book_manuscript", kind: "book", concept, generated_at: now, requested_by: input.createdBy, from_ai_copy: true, fallback_reason: null, fair_housing_flags: [] },
      book: project,
    },
  }
  try {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const result = await withActionLedger<Awaited<ReturnType<typeof createLeadMagnet>>>(
      {
        brokerageId: input.brokerageId, action: "marketing.lead_magnet.book_start", actor: { type: "user", userId: input.createdBy },
        subject: { type: "lead_capture_form", ref: concept.slice(0, 120) }, reasonCode: "HUMAN_REQUESTED",
        reasonDetail: `AI book project (${input.audience}) started from the agent's concept`, riskClass: "LOW_RISK_WRITE", systemSource: "lead_magnets",
        detail: { audience: input.audience, magnetType, feature: "book_manuscript" },
      },
      () => createLeadMagnet(createInput, { client: deps.client }),
      {
        settle: (r) => r.success ? { status: "executed", outcome: "book_project_started", providerRef: r.magnetId ?? null } : { status: "failed", outcome: "create_refused", error: r.error ?? null },
        replay: (claim) => ({ success: false, error: claim.kind === "replay" ? "already started" : `ledger refused the book: ${claim.kind}` }),
      },
      { client: deps.client as any },
    )
    if (!result.success || !result.magnetId) return { success: false, error: result.error ?? "The book project was not created." }
    return { success: true, magnetId: result.magnetId, slug: result.slug, title: project.title }
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e) }
  }
}

interface AdvanceBookInput {
  brokerageId: string
  magnetId: string
  /** users.id of whoever asked for the next stage (the reviewer clicking Continue, or the sweep's system actor). */
  actorUserId: string | null
  actor?: { platformRole?: string | null; userType?: string | null } | null
}

interface AdvanceBookOutput {
  success: boolean
  stage?: BookStage
  /** true once the book is ready for the human's review (nothing left to advance). */
  done?: boolean
  note?: string
  project?: BookProject
  error?: string
}

/** Read the project off the magnet row — tenant-pinned; a magnet without a book is not a book project. */
export async function loadProject(svc: Svc, brokerageId: string, magnetId: string): Promise<{ ok: true; row: { id: string; name: string; agent_id: string | null; settings: Record<string, unknown>; landing_content: Record<string, unknown> | null }; project: BookProject } | { ok: false; error: string }> {
  const { data, error } = await svc.from("lead_capture_forms").select("id, name, agent_id, settings, landing_content").eq("id", magnetId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `Book project unreadable: ${error.message}` }
  if (!data) return { ok: false, error: "Book project not found in this brokerage" }
  const settings = ((data as { settings?: Record<string, unknown> | null }).settings ?? {}) as Record<string, unknown>
  const project = settings.book as BookProject | undefined
  if (!project || typeof project !== "object" || !project.stage) return { ok: false, error: "This lead magnet carries no book project" }
  return { ok: true, row: { id: (data as { id: string }).id, name: (data as { name: string }).name, agent_id: (data as { agent_id?: string | null }).agent_id ?? null, settings, landing_content: ((data as { landing_content?: Record<string, unknown> | null }).landing_content ?? null) }, project }
}

/** A COUNTED, tenant-pinned write of the project record (plus the name / landing copy when the title lands). */
async function saveProject(svc: Svc, brokerageId: string, magnetId: string, settings: Record<string, unknown>, project: BookProject, extra: Record<string, unknown> = {}): Promise<string | null> {
  const { data, error } = await svc.from("lead_capture_forms").update({ settings: { ...settings, book: project }, updated_at: project.updated_at, ...extra }).eq("brokerage_id", brokerageId).eq("id", magnetId).select("id")
  if (error) return `Book project not saved: ${error.message}`
  if ((data ?? []).length !== 1) return "Book project not saved: no row matched this brokerage + id"
  return null
}

/**
 * Run the NEXT stage (or the next bounded slice of it). Idempotent per stage: a re-run after a saved stage
 * simply runs the following one; a failed model call leaves the record untouched and reports why.
 */
export async function advanceBookProject(input: AdvanceBookInput, deps: BookDeps = {}): Promise<AdvanceBookOutput> {
  if (!input.brokerageId || !input.magnetId) return { success: false, error: "Missing required fields: brokerageId, magnetId" }
  const svc = (deps.client ?? (await import("@/lib/supabase/service")).createServiceClient()) as Svc
  const loaded = await loadProject(svc, input.brokerageId, input.magnetId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { row } = loaded
  const settings = row.settings
  const p: BookProject = { ...loaded.project, chapters: [...loaded.project.chapters], log: [...loaded.project.log], needs_human_review: [...(loaded.project.needs_human_review ?? [])], cost: { ...loaded.project.cost } }
  const now = (deps.now ?? new Date()).toISOString()
  if (p.stage === "ready_for_review") return { success: true, stage: p.stage, done: true, note: "The book is finished — review and publish it.", project: p }

  // Entitlement BEFORE any spend, every advance (a refusal changes nothing).
  const gate = deps.entitlement ?? defaultEntitlement
  const verdict = await gate({ brokerageId: input.brokerageId, estTokens: BOOK_ADVANCE_EST_TOKENS, actor: input.actor ?? null }).catch((e): { allowed: boolean; reason: string; message?: string } => ({ allowed: false, reason: `entitlement_threw: ${(e as Error)?.message ?? String(e)}` }))
  if (!verdict.allowed) return { success: false, stage: p.stage, error: verdict.message ?? `AI book writing is not available right now (${verdict.reason}).` }

  const writer = deps.manuscriptWriter ?? routedManuscriptWriter
  const checker = deps.factCheckWriter ?? routedFactCheckWriter
  const perAdvance = Math.max(1, deps.chaptersPerAdvance ?? BOOK_CHAPTERS_PER_ADVANCE)
  const agentUserId = await resolveAgentUserId(svc, input.brokerageId, row.agent_id)
  const book = (req: Omit<BookWriterRequest, "brokerageId" | "userId">, lane: BookWriter) => lane({ ...req, brokerageId: input.brokerageId, userId: input.actorUserId }).then((r) => { if (r) { p.cost.tokens += r.tokens; p.cost.model_calls += 1 } return r })

  const stageBefore = p.stage
  let note = ""
  let extra: Record<string, unknown> = {}
  try {
    switch (p.stage) {
      case "research": {
        const topics = await (deps.researcher ?? defaultResearcher)(p.audience, p.area, input.brokerageId).catch(() => [] as ContentTopic[])
        const bank = await (deps.topicReader ?? defaultTopicReader)(input.brokerageId, svc).catch(() => [] as string[])
        p.research = { topics: topics.map((t) => t.topic), bank_topics: bank, fetched_at: now }
        p.stage = "outline"
        note = `research: ${topics.length} demand topic(s), ${bank.length} topic-bank topic(s)`
        break
      }
      case "outline": {
        const r = await book({ system: manuscriptSystem(p), prompt: outlinePrompt(p), maxTokens: 1400 }, writer)
        const o = r ? parseJsonObject<{ title?: string; subtitle?: string; tagline?: string; introduction?: string; closing?: string; chapters?: Array<{ heading?: string; summary?: string; key_points?: string[] }> }>(r.text) : null
        const chapters = (o?.chapters ?? []).map((c) => ({ heading: String(c?.heading ?? "").trim().slice(0, 90), summary: String(c?.summary ?? "").trim().slice(0, 400), key_points: Array.isArray(c?.key_points) ? c.key_points.map((k) => String(k).trim()).filter(Boolean).slice(0, 6) : [] })).filter((c) => c.heading)
        if (!o || chapters.length < BOOK_MIN_CHAPTERS || chapters.length > BOOK_MAX_CHAPTERS) return { success: false, stage: p.stage, error: `The outline did not land (${chapters.length} chapter(s); needs ${BOOK_MIN_CHAPTERS}-${BOOK_MAX_CHAPTERS}) — try again.`, project: p }
        p.outline = chapters
        p.title = String(o.title ?? "").trim().slice(0, 60) || p.title
        p.subtitle = String(o.subtitle ?? "").trim().slice(0, 90) || null
        p.tagline = String(o.tagline ?? "").trim().slice(0, 120) || null
        p.introduction = String(o.introduction ?? "").trim() || null
        p.closing = String(o.closing ?? "").trim() || null
        p.stage = "chapters"
        note = `outline: "${p.title}" — ${chapters.length} chapters`
        extra = { name: p.title }
        break
      }
      case "chapters": {
        const outline = p.outline ?? []
        let wrote = 0
        while (p.chapters.length < outline.length && wrote < perAdvance) {
          const i = p.chapters.length
          const r = await book({ system: manuscriptSystem(p), prompt: chapterPrompt(p, i), maxTokens: 1400 }, writer)
          const body = (r?.text ?? "").trim()
          if (!r || wordCount(body) < BOOK_MIN_CHAPTER_WORDS) return { success: false, stage: p.stage, error: `Chapter ${i + 1} did not land (${wordCount(body)} words; a chapter needs ${BOOK_MIN_CHAPTER_WORDS}+) — try again.`, project: p }
          p.chapters.push({ heading: outline[i].heading, body, words: wordCount(body), written_at: now })
          wrote++
        }
        if (p.chapters.length >= outline.length) p.stage = "fact_check"
        note = `chapters: ${p.chapters.length}/${outline.length} written`
        break
      }
      case "fact_check": {
        const corpus = allowedCorpus(p)
        const findings: BookFactFinding[] = []
        // The deterministic scan first — it needs no model and cannot be talked out of a figure.
        p.chapters.forEach((c, i) => {
          for (const fig of unsupportedFigures(c.body, corpus)) findings.push({ chapter: i + 1, claim: fig, verdict: "unsupported", note: "figure not present in the research the writer was given", by: "scan" })
        })
        const r = await book({ system: factCheckSystem(), prompt: factCheckPrompt(p, p.chapters.map((c, i) => ({ i, body: c.body }))), maxTokens: 1200 }, checker)
        const parsed = r ? parseJsonObject<{ findings?: Array<{ chapter?: number; claim?: string; verdict?: string; note?: string }> }>(r.text) : null
        for (const f of parsed?.findings ?? []) {
          const ch = Number(f?.chapter)
          const claim = String(f?.claim ?? "").trim()
          if (!claim || !Number.isInteger(ch) || ch < 1 || ch > p.chapters.length) continue
          findings.push({ chapter: ch, claim: claim.slice(0, 200), verdict: f?.verdict === "needs_qualification" ? "needs_qualification" : "unsupported", note: String(f?.note ?? "").slice(0, 200), by: "model" })
        }
        p.fact_check = { findings, checked_at: now }
        p.stage = "edit"
        note = `fact check: ${findings.length} finding(s)`
        break
      }
      case "edit": {
        let edited = 0
        const olderPersons = await loadOlderPersonsVerifications(svc as never, input.brokerageId)
        for (let i = 0; i < p.chapters.length && edited < perAdvance; i++) {
          if (p.chapters[i].edited) continue
          const factFindings = (p.fact_check?.findings ?? []).filter((f) => f.chapter === i + 1)
          let body = p.chapters[i].body
          if (factFindings.length > 0) {
            const r = await book({ system: manuscriptSystem(p), prompt: editPrompt(p, i, factFindings, []), maxTokens: 1400 }, writer)
            const next = (r?.text ?? "").trim()
            if (!r || wordCount(next) < BOOK_MIN_CHAPTER_WORDS) return { success: false, stage: p.stage, error: `The edit of chapter ${i + 1} did not land — try again.`, project: p }
            body = next
          }
          // THE FAIR-HOUSING REWRITE LOOP — the book is PUBLIC housing marketing; cap + escalate per chapter.
          const loop = await rewritePublicCopyUntilCompliant({
            text: body, surface: "book", brokerageName: p.brand, olderPersons,
            rewrite: async (text, fh) => {
              const snapshot: BookProject = { ...p, chapters: p.chapters.map((c, j) => (j === i ? { ...c, body: text } : c)) }
              const r = await book({ system: manuscriptSystem(p), prompt: editPrompt(snapshot, i, [], fh), maxTokens: 1400 }, writer)
              const next = (r?.text ?? "").trim()
              return r && wordCount(next) >= BOOK_MIN_CHAPTER_WORDS ? next : null
            },
          })
          p.chapters[i] = { ...p.chapters[i], body: loop.text, words: wordCount(loop.text), edited: { fact_findings: factFindings.length, fair_housing_rewrites: loop.rewrites, escalated: loop.escalated, findings: loop.findings.map((f) => f.phrase) } }
          if (loop.escalated && !p.needs_human_review.includes(i + 1)) p.needs_human_review.push(i + 1)
          edited++
        }
        if (p.chapters.every((c) => c.edited)) p.stage = "layout"
        note = `edit: ${p.chapters.filter((c) => c.edited).length}/${p.chapters.length} chapters edited${p.needs_human_review.length ? `; ${p.needs_human_review.length} escalated to the reviewer` : ""}`
        break
      }
      case "layout": {
        const brand = await (deps.brandResolver ?? defaultBrandResolver)(svc, input.brokerageId, agentUserId)
        const dateLabel = new Date(now).toLocaleDateString("en-US", { year: "numeric", month: "long" })
        const spec = bookPdfSpec(composeBookPdfData(p), brand, dateLabel)
        const produced = await (deps.producer ?? defaultProducer)(svc, { brokerageId: input.brokerageId, agentUserId, spec, metadata: { source: "lead_magnet_book", magnet_id: input.magnetId, chapters: p.chapters.length, audience: p.audience } })
        if (!produced.ok || !produced.pdfUrl) return { success: false, stage: p.stage, error: produced.error ?? "The book PDF was not produced.", project: p }
        p.pdf_url = produced.pdfUrl
        p.document_id = produced.documentId
        p.page_count = produced.pageCount
        p.stage = "ready_for_review"
        note = `layout: PDF hosted${produced.pageCount ? ` (${produced.pageCount} pages)` : ""} — ready for review`
        // The landing surface names the book: a human still reviews and edits before publishing.
        const prevLanding = row.landing_content ?? {}
        extra = {
          name: p.title,
          landing_content: {
            ...prevLanding,
            headline: p.title, subhead: p.tagline ?? p.subtitle ?? `A ${p.audience}'s guide, written for you.`, cta: "Send me the book",
            bullets: p.chapters.slice(0, 3).map((c) => c.heading), topics: p.research?.topics?.slice(0, 6) ?? [],
            faq: Array.isArray((prevLanding as { faq?: unknown }).faq) ? (prevLanding as { faq: unknown[] }).faq : [], faqJsonLd: (prevLanding as { faqJsonLd?: string | null }).faqJsonLd ?? null,
            fromTopics: (p.research?.topics?.length ?? 0) > 0, generatedAt: now,
          },
        }
        break
      }
    }
  } catch (e) {
    return { success: false, stage: p.stage, error: (e as Error)?.message ?? String(e), project: p }
  }

  p.updated_at = now
  p.log.push({ stage: p.stage, at: now, note })

  // EVIDENCE (LAW 5) around the counted write: which stage ran, what it cost, who asked.
  let saveError: string | null = null
  try {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    saveError = await withActionLedger<string | null>(
      {
        brokerageId: input.brokerageId, action: "marketing.lead_magnet.book_stage",
        actor: input.actorUserId ? { type: "user", userId: input.actorUserId } : { type: "system" },
        subject: { type: "lead_capture_form", id: input.magnetId }, reasonCode: "HUMAN_REQUESTED",
        reasonDetail: `book stage ${stageBefore} → ${p.stage}: ${note}`, riskClass: "LOW_RISK_WRITE", systemSource: "lead_magnets",
        detail: { stage_before: stageBefore, stage_after: p.stage, chapters: p.chapters.length, tokens: p.cost.tokens, model_calls: p.cost.model_calls, needs_human_review: p.needs_human_review },
      },
      () => saveProject(svc, input.brokerageId, input.magnetId, settings, p, extra),
      {
        settle: (err) => err ? { status: "failed", outcome: "save_refused", error: err } : { status: "executed", outcome: p.stage },
        replay: (claim) => `ledger refused the stage: ${claim.kind}`,
      },
      { client: deps.client as any },
    )
  } catch (e) {
    saveError = (e as Error)?.message ?? String(e)
  }
  if (saveError) return { success: false, stage: stageBefore, error: saveError, project: p }
  return { success: true, stage: p.stage, done: p.stage === "ready_for_review", note, project: p }
}

interface ReviseBookChapterInput {
  brokerageId: string
  magnetId: string
  /** 1-based chapter number. */
  chapter: number
  body: string
  actorUserId: string | null
}

/**
 * THE HUMAN'S REWRITE of a chapter (owner: the human approves the CORRECTED creative). An escalated chapter is
 * the reviewer's to fix; any chapter may be revised. The reviewer's words run the SAME public-copy scan (a
 * steering revision is refused — nobody is exempt from fair housing), must clear the word floor, replace the
 * chapter, clear it from needs_human_review, and send a finished book back to LAYOUT so the PDF is re-rendered
 * from the corrected manuscript (the stale PDF is dropped, never served). A COUNTED tenant-pinned write under
 * ledger evidence (marketing.lead_magnet.book_revise).
 */
export async function reviseBookChapter(input: ReviseBookChapterInput, deps: BookDeps = {}): Promise<AdvanceBookOutput> {
  if (!input.brokerageId || !input.magnetId) return { success: false, error: "Missing required fields: brokerageId, magnetId" }
  const text = (input.body ?? "").trim()
  const svc = (deps.client ?? (await import("@/lib/supabase/service")).createServiceClient()) as Svc
  const loaded = await loadProject(svc, input.brokerageId, input.magnetId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { row } = loaded
  const settings = row.settings
  const p: BookProject = { ...loaded.project, chapters: [...loaded.project.chapters], log: [...loaded.project.log], needs_human_review: [...(loaded.project.needs_human_review ?? [])], cost: { ...loaded.project.cost } }
  const i = input.chapter - 1
  if (!Number.isInteger(input.chapter) || i < 0 || i >= p.chapters.length) return { success: false, stage: p.stage, error: `Chapter ${input.chapter} does not exist (the book has ${p.chapters.length}).`, project: p }
  if (wordCount(text) < BOOK_MIN_CHAPTER_WORDS) return { success: false, stage: p.stage, error: `A chapter needs ${BOOK_MIN_CHAPTER_WORDS}+ words (${wordCount(text)} given).`, project: p }
  const scan = await scanPublicCopy(text, "book", { brokerageName: p.brand, olderPersons: await loadOlderPersonsVerifications(svc as never, input.brokerageId) })
  if (!scan.ok) return { success: false, stage: p.stage, error: `Fair-housing review: the revision still says ${scan.findings.map((f) => `"${f.phrase}"`).join(", ")} — ${scan.findings.map((f) => f.fix).join("; ")}.`, project: p }

  const now = (deps.now ?? new Date()).toISOString()
  const stageBefore = p.stage
  const prior = p.chapters[i].edited
  p.chapters[i] = { ...p.chapters[i], body: text, words: wordCount(text), edited: { fact_findings: prior?.fact_findings ?? 0, fair_housing_rewrites: prior?.fair_housing_rewrites ?? 0, escalated: false, findings: [], human_revised_at: now } }
  p.needs_human_review = p.needs_human_review.filter((n) => n !== input.chapter)
  if (p.stage === "ready_for_review") { p.stage = "layout"; p.pdf_url = null; p.document_id = null; p.page_count = null }
  p.updated_at = now
  const note = `chapter ${input.chapter} revised by the reviewer${stageBefore === "ready_for_review" ? "; back to layout for a fresh PDF" : ""}`
  p.log.push({ stage: p.stage, at: now, note })

  let saveError: string | null = null
  try {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    saveError = await withActionLedger<string | null>(
      {
        brokerageId: input.brokerageId, action: "marketing.lead_magnet.book_revise",
        actor: input.actorUserId ? { type: "user", userId: input.actorUserId } : { type: "system" },
        subject: { type: "lead_capture_form", id: input.magnetId }, reasonCode: "HUMAN_REQUESTED",
        reasonDetail: note, riskClass: "LOW_RISK_WRITE", systemSource: "lead_magnets",
        detail: { chapter: input.chapter, stage_before: stageBefore, stage_after: p.stage, words: wordCount(text), needs_human_review: p.needs_human_review },
      },
      () => saveProject(svc, input.brokerageId, input.magnetId, settings, p),
      {
        settle: (err) => err ? { status: "failed", outcome: "save_refused", error: err } : { status: "executed", outcome: "chapter_revised" },
        replay: (claim) => `ledger refused the revision: ${claim.kind}`,
      },
      { client: deps.client as any },
    )
  } catch (e) {
    saveError = (e as Error)?.message ?? String(e)
  }
  if (saveError) return { success: false, stage: stageBefore, error: saveError, project: p }
  // A revision never leaves the book ready: a finished one went back to layout for its fresh PDF.
  return { success: true, stage: p.stage, done: false, note, project: p }
}

/** lead_capture_forms.agent_id is agents.id; the PDF brand and the document library want users.id (disjoint, CLAUDE.md §3). */
async function resolveAgentUserId(svc: Svc, brokerageId: string, agentId: string | null): Promise<string | null> {
  if (!agentId) return null
  const { data, error } = await svc.from("agents").select("user_id").eq("id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return null
  return ((data as { user_id?: string | null } | null)?.user_id) ?? null
}

/**
 * THE SAFETY NET (cron is a backup, never the primary way): advance every unfinished book project of a tenant
 * that has sat untouched for `staleMinutes` — one stage each, bounded per sweep. The UI's auto-continue is the
 * primary driver; this catches a closed tab.
 */
export async function sweepStalledBookProjects(svc: Svc, brokerageId: string, opts: { staleMinutes?: number; max?: number; now?: Date; deps?: BookDeps } = {}): Promise<{ advanced: number; errors: string[] }> {
  const now = opts.now ?? new Date()
  const stale = new Date(now.getTime() - (opts.staleMinutes ?? 15) * 60_000).toISOString()
  const out = { advanced: 0, errors: [] as string[] }
  const { data, error } = await svc.from("lead_capture_forms").select("id, settings").eq("brokerage_id", brokerageId).eq("is_active", false).limit(200)
  if (error) { out.errors.push(`book sweep read refused: ${error.message}`); return out }
  const max = opts.max ?? 2
  for (const r of (data ?? []) as Array<{ id: string; settings?: Record<string, unknown> | null }>) {
    if (out.advanced >= max) break
    const book = (r.settings?.book ?? null) as BookProject | null
    if (!book || typeof book !== "object" || !book.stage || book.stage === "ready_for_review") continue
    if ((book.updated_at ?? "") > stale) continue
    const res = await advanceBookProject({ brokerageId, magnetId: r.id, actorUserId: null }, { ...(opts.deps ?? {}), client: (opts.deps?.client ?? svc) as never, now })
    if (res.success) out.advanced++
    else out.errors.push(`${r.id}: ${res.error}`)
  }
  return out
}
