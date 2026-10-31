// lib/lead-magnets/deliverable-asset.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ASSET IS CREATED WITH THE LEAD MAGNET (wave 147, lane 147E — owner ruling 5, 2026-10-31: "when lead magnets are created,
// the asset for delivery is always created at the same time"; contract C11).
//
// WHAT WAS THERE (audited at 4d527cc3): createLeadMagnet (lib/kernel/lead-magnets.ts) wrote ONLY the lead_capture_forms row.
// The deliverable was produced PER SUBMISSION at capture (lib/marketing/lead-magnet-delivery-runner.ts prepareMagnetDelivery —
// topics → AI copy → booklet render, once per person), so a page could go live promising a guide whose booklet then failed to
// render, and a market-report page promised a report no code could produce (lane 146F Still open 3). Nothing tied a published
// offer to an asset that existed.
//
// C11 — ONE UNIT: the magnet row and its DELIVERABLE row (m898 lead_magnet_deliverables) are written together by
// createLeadMagnet; if the deliverable record cannot be written the magnet is deleted again (counted) — a magnet never exists
// without its deliverable record. A magnet is PUBLISHABLE only when its deliverable is `ready` (produced AND validated):
//   · the app gate — publishLeadMagnet calls ensureDeliverableForPublish (and the C5 approver check) before activation;
//   · the database gate — m898's trigger refuses is_active false→true (or an active INSERT) for an asset-promising magnet with
//     no `ready` deliverable, whoever writes it.
// An async render (a book still being written) parks the deliverable in `staged` — the offer stays unpublished until ready.
// Existing published magnets (no deliverable row) keep delivering on C4's recovery path (lib/lead-magnets/promised-deliverables.ts
// — the runner prepares at capture, exactly as before); a promise recorded against a ready deliverable delivers THAT version.
//
// The deliverable per magnet type (the C4 promise kinds — one vocabulary, PROMISE_ASSET_KINDS):
//   buyer_guide / seller_guide → "guide": the designed booklet PDF (the runner's preparation, no recipient) — or "book" when the
//                                magnet distributes a finished book (staged until the book is ready_for_review with its PDF)
//   market_report              → "report": the market-report producer (lib/market-reports/producer.ts) for the magnet's territory
//   home_valuation             → "valuation", fulfilment "human": a per-person value cannot exist before the person does; ready
//                                means an agent with a user seat is assigned to prepare it (C4 keeps it awaiting_human)
//   listing_alert / open_house / generic_form → no asset is promised → no deliverable (the invariant does not apply)
//
// Not server-only (the proofs drive it in memory with seams); the producers are lazy imports. Every write is tenant-pinned and
// counted; every { error } is read. Never throws.

import { PROMISE_ASSET_KINDS, type PreparedAsset, type PromiseAssetKind } from "./promised-deliverables"

type Db = { from: (table: string) => any }

/** lead_magnet_deliverables.status (m898 CHECK). */
export const DELIVERABLE_STATUSES = ["producing", "staged", "ready", "failed", "superseded"] as const
type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number]

/** lead_magnet_deliverables.fulfilment (m898 CHECK). */
export const DELIVERABLE_FULFILMENTS = ["asset", "human"] as const

/** The magnet types whose page promises an asset — m898's trigger names the same list (the proof holds them equal). */
export const ASSET_PROMISING_MAGNET_TYPES = ["buyer_guide", "seller_guide", "market_report", "home_valuation"] as const

/** A `producing` row older than this is a crashed attempt (a publish may re-produce). */
const STALE_PRODUCING_MS = 15 * 60_000

interface DeliverableSpec { kind: PromiseAssetKind; fulfilment: "asset" | "human" }

/** PURE. What a magnet must have produced before it can publish — null when it promises no asset. */
export function deliverableSpecFor(magnetType: string | null | undefined, settings: Record<string, unknown> | null | undefined): DeliverableSpec | null {
  const s = (settings ?? {}) as { book_id?: unknown; book?: unknown }
  switch (magnetType) {
    case "buyer_guide":
    case "seller_guide":
      return { kind: s.book_id || s.book ? "book" : "guide", fulfilment: "asset" }
    case "market_report":
      return { kind: "report", fulfilment: "asset" }
    case "home_valuation":
      return { kind: "valuation", fulfilment: "human" }
    default:
      return null
  }
}

export interface DeliverableRow {
  id: string; brokerage_id: string; form_id: string; version: number; kind: PromiseAssetKind; fulfilment: "asset" | "human"
  status: DeliverableStatus; title: string | null; asset_url: string | null; document_id: string | null
  cover_note: { subject: string; title: string; body: string } | null; payload: Record<string, unknown> | null
  validation: Record<string, unknown> | null; approver: Record<string, unknown> | null; approved_by: string | null; approved_at: string | null; produced_by: string | null
  error: string | null; produced_at: string | null; created_at: string | null
}

const DELIVERABLE_COLUMNS = "id, brokerage_id, form_id, version, kind, fulfilment, status, title, asset_url, document_id, cover_note, payload, validation, approver, approved_by, approved_at, produced_by, error, produced_at, created_at"

/** What one production attempt produced (the seams return this). */
export interface ProducedDeliverable {
  status: "ready" | "staged" | "failed"
  assetUrl?: string | null
  documentId?: string | null
  title?: string | null
  coverNote?: { subject: string; title: string; body: string } | null
  payload?: Record<string, unknown>
  validation?: Record<string, unknown>
  reason?: string | null
}

interface DeliverableProductionInput {
  brokerageId: string
  formId: string
  magnetType: string
  title: string
  /** agents.id of the magnet's owner (lead_capture_forms.agent_id). */
  agentId: string | null
  settings: Record<string, unknown> | null
  /** users.id of the person (or the system user) creating / publishing. */
  actorUserId: string | null
}

export interface DeliverableDeps {
  now?: Date
  /** guide / book (default: the runner's preparation with no recipient). */
  produceGuide?: (svc: Db, a: DeliverableProductionInput & { agentUserId: string | null; kind: "guide" | "book" }) => Promise<ProducedDeliverable>
  /** report (default: lib/market-reports/producer.ts produceMarketReport for the magnet's territory). */
  produceReport?: (svc: Db, a: DeliverableProductionInput & { agentUserId: string | null }) => Promise<ProducedDeliverable>
  /** The producer's own seams for the DEFAULT report path (the proof runs the real producer with fake providers). */
  report?: import("@/lib/market-reports/producer").ProducerDeps
}

type DeliverableResult =
  | { ok: true; required: false }
  | { ok: true; required: true; deliverable: DeliverableRow }
  | { ok: false; required: true; recorded: boolean; error: string; deliverable?: DeliverableRow | null }

const httpsUrl = (u: unknown): string | null => (typeof u === "string" && /^https:\/\/\S+$/.test(u) ? u : null)

async function agentUserIdOf(svc: Db, brokerageId: string, agentId: string | null): Promise<{ userId: string | null; error: string | null }> {
  if (!agentId) return { userId: null, error: null }
  const { data, error } = await svc.from("agents").select("user_id").eq("id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { userId: null, error: `agents read refused: ${error.message ?? "unknown"}` }
  return { userId: (data as { user_id?: string | null } | null)?.user_id ?? null, error: null }
}

// ── DEFAULT PRODUCERS (on the survivors) ─────────────────────────────────────

const defaultProduceGuide: NonNullable<DeliverableDeps["produceGuide"]> = async (svc, a) => {
  let book: { pdfUrl: string; documentId: string | null; title: string; chapters: number } | null = null
  if (a.kind === "book") {
    const { loadDistributedBook } = await import("./book-entity")
    const { leadMagnetBookRefOf } = await import("@/lib/kernel/lead-magnets")
    const distributed = await loadDistributedBook(svc as never, a.brokerageId, a.formId, a.settings ?? null)
    if (distributed.error) return { status: "failed", reason: `the distributed book is unreadable: ${distributed.error}` }
    book = leadMagnetBookRefOf({ book: distributed.book?.project ?? null })
    if (!book) return { status: "staged", reason: "the book this magnet distributes is still being written — the offer stays unpublished until its PDF is ready" }
  }
  const { prepareMagnetDelivery } = await import("@/lib/marketing/lead-magnet-delivery-runner")
  const area = ((a.settings ?? {}) as { area?: unknown }).area
  const prepared = await prepareMagnetDelivery({
    brokerageId: a.brokerageId, contactId: null, agentUserId: a.agentUserId,
    magnetType: a.magnetType as Parameters<typeof prepareMagnetDelivery>[0]["magnetType"], magnetId: a.formId, book,
    ctx: { area: typeof area === "string" ? area : null },
  }, svc as never)
  const url = httpsUrl(prepared.pdfUrl)
  const okKind = a.kind === "book" ? prepared.deliverableKind === "book" : prepared.deliverableKind === "booklet" || prepared.deliverableKind === "book"
  if (!prepared.deliverable || !url || !okKind) return { status: "failed", reason: prepared.heldReason ?? "the designed PDF did not render — a cover note alone is not the guide" }
  return {
    status: "ready", assetUrl: url, documentId: prepared.documentId, title: prepared.refs.title, coverNote: prepared.deliverable,
    validation: { ok: true, checks: ["hosted_pdf", "compliance_gate_cleared", `deliverable_kind:${prepared.deliverableKind}`], from_topics: prepared.fromTopics },
  }
}

const defaultProduceReport = async (svc: Db, a: DeliverableProductionInput & { agentUserId: string | null }, producerDeps?: DeliverableDeps["report"]): Promise<ProducedDeliverable> => {
  const { produceMarketReport } = await import("@/lib/market-reports/producer")
  const mr = ((a.settings ?? {}) as { market_report?: { territory?: Record<string, unknown>; narrate?: boolean; topic?: { title?: string; angle?: string } } }).market_report ?? {}
  const r = await produceMarketReport(svc, {
    brokerageId: a.brokerageId, agentUserId: a.agentUserId, agentId: a.agentId,
    actor: a.actorUserId ? { type: "user", userId: a.actorUserId } : { type: "manager", managerKey: "campaign_orchestrator" },
    territoryHint: (mr.territory ?? null) as never,
    topic: mr.topic?.title ? { title: String(mr.topic.title), angle: mr.topic.angle ? String(mr.topic.angle) : null, evidenceIds: [] } : null,
    narrate: mr.narrate === true, reasonCode: "HUMAN_REQUESTED", purpose: "lead_magnet_deliverable",
  }, producerDeps ?? {})
  if (!r.ok) return { status: "failed", reason: `the market report was not produced (${r.stage}): ${r.reason}`, validation: r.validation ? { ok: false, refusals: r.validation.refusals, counts: r.validation.counts } : undefined }
  const lead = r.report.data[0]
  return {
    status: "ready", assetUrl: r.assetUrl, documentId: r.documentId, title: `${r.report.territory.label} Market Report`,
    coverNote: {
      subject: `Your ${r.report.territory.label} market report`,
      title: `${r.report.territory.label} Market Report`,
      body: `${r.report.narrative.headline}\n\nEvery figure in the report names its source and date${lead ? `; the newest is from ${lead.asOf}` : ""}. Anything we could not verify for ${r.report.territory.label} is marked as not available rather than estimated.`,
    },
    payload: { territory: r.report.territory, topic: r.report.topic, format: r.report.format, as_of: r.report.asOf, data: r.report.data.length, unavailable: r.report.unavailable.length, comparables: r.report.comparables.length, approver: r.approver, video: r.video, topic_evidence: r.topicSuggestions?.suggestions[0]?.evidence ?? [] },
    validation: { ok: true, warnings: r.validation.warnings, counts: r.validation.counts },
  }
}

// ── READ ─────────────────────────────────────────────────────────────────────

/** The magnet's deliverables, newest version first (tenant-pinned). */
async function readDeliverables(svc: Db, brokerageId: string, formId: string): Promise<{ rows: DeliverableRow[]; error: string | null }> {
  const { data, error } = await svc.from("lead_magnet_deliverables").select(DELIVERABLE_COLUMNS).eq("brokerage_id", brokerageId).eq("form_id", formId).order("version", { ascending: false }).limit(20)
  if (error) return { rows: [], error: `lead_magnet_deliverables read refused: ${error.message ?? "unknown"}` }
  return { rows: (data ?? []) as DeliverableRow[], error: null }
}

/** The magnet's READY deliverable (the one a promise delivers), or null. A refused read is an error, never "none". */
export async function readyDeliverableFor(svc: Db, input: { brokerageId: string; formId: string }): Promise<{ deliverable: DeliverableRow | null; error: string | null }> {
  const r = await readDeliverables(svc, input.brokerageId, input.formId)
  if (r.error) return { deliverable: null, error: r.error }
  return { deliverable: r.rows.find((d) => d.status === "ready") ?? null, error: null }
}

/** A deliverable by id (the version a promise was made against), tenant-pinned. */
export async function deliverableById(svc: Db, input: { brokerageId: string; deliverableId: string }): Promise<{ deliverable: DeliverableRow | null; error: string | null }> {
  const { data, error } = await svc.from("lead_magnet_deliverables").select(DELIVERABLE_COLUMNS).eq("id", input.deliverableId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) return { deliverable: null, error: `lead_magnet_deliverables read refused: ${error.message ?? "unknown"}` }
  return { deliverable: (data as DeliverableRow | null) ?? null, error: null }
}

/** PURE. A ready deliverable → what the promise ledger delivers (no per-recipient render). Null when it is not deliverable. */
export function deliverableAsPreparedAsset(d: DeliverableRow | null): PreparedAsset | null {
  if (!d || d.status !== "ready" || d.fulfilment !== "asset" || !d.cover_note || !httpsUrl(d.asset_url)) return null
  return { deliverable: d.cover_note, pdfUrl: d.asset_url, documentId: d.document_id, deliverableKind: d.kind === "book" ? "book" : d.kind === "guide" ? "booklet" : "report" }
}

// ── PRODUCE ──────────────────────────────────────────────────────────────────

/**
 * Produce a magnet's deliverable NOW: record a `producing` row (a new version), run the kind's producer, and settle it to
 * ready / staged / failed. A previously ready version is superseded only when the new one is ready (one ready per magnet —
 * m898's partial unique index). `recorded: false` means not even the record could be written (the caller must not keep a
 * magnet without one).
 */
export async function produceLeadMagnetDeliverable(svc: Db, input: DeliverableProductionInput, deps: DeliverableDeps = {}): Promise<DeliverableResult> {
  const spec = deliverableSpecFor(input.magnetType, input.settings)
  if (!spec) return { ok: true, required: false }
  try {
    if (!(PROMISE_ASSET_KINDS as readonly string[]).includes(spec.kind)) return { ok: false, required: true, recorded: false, error: `unknown deliverable kind ${spec.kind}` }
    const now = deps.now ?? new Date()
    const existing = await readDeliverables(svc, input.brokerageId, input.formId)
    if (existing.error) return { ok: false, required: true, recorded: false, error: existing.error }
    const version = (existing.rows[0]?.version ?? 0) + 1
    const ins = await svc.from("lead_magnet_deliverables").insert({
      brokerage_id: input.brokerageId, form_id: input.formId, version, kind: spec.kind, fulfilment: spec.fulfilment, status: "producing",
      title: input.title, payload: {}, validation: {}, approver: {}, produced_by: input.actorUserId, created_at: now.toISOString(), updated_at: now.toISOString(),
    }).select(DELIVERABLE_COLUMNS).maybeSingle()
    if (ins.error || !ins.data) return { ok: false, required: true, recorded: false, error: `the deliverable record was not written: ${ins.error?.message ?? "no row returned"}` }
    const row = ins.data as DeliverableRow

    // PRODUCE.
    const owner = await agentUserIdOf(svc, input.brokerageId, input.agentId)
    let out: ProducedDeliverable
    if (owner.error) out = { status: "failed", reason: owner.error }
    else if (spec.kind === "valuation") {
      out = owner.userId
        ? { status: "ready", title: "Your precise home value (agent-prepared CMA)", validation: { ok: true, checks: ["human_fulfilment_assigned"], fulfilled_by_user_id: owner.userId }, payload: { fulfilment: "an agent prepares each value from that person's address (C4 awaiting_human)" } }
        : { status: "failed", reason: "an agent-prepared value needs an assigned agent with a user seat — none on this magnet" }
    } else if (spec.kind === "report") {
      out = await (deps.produceReport ? deps.produceReport(svc, { ...input, agentUserId: owner.userId }) : defaultProduceReport(svc, { ...input, agentUserId: owner.userId }, deps.report))
        .catch((e: unknown) => ({ status: "failed" as const, reason: `the report producer threw: ${e instanceof Error ? e.message : String(e)}` }))
    } else {
      out = await (deps.produceGuide ?? defaultProduceGuide)(svc, { ...input, agentUserId: owner.userId, kind: spec.kind === "book" ? "book" : "guide" })
        .catch((e: unknown) => ({ status: "failed" as const, reason: `the guide producer threw: ${e instanceof Error ? e.message : String(e)}` }))
    }
    // A READY asset must be hosted (human fulfilment excepted) and validated — m898's shape CHECK says the same.
    if (out.status === "ready" && spec.fulfilment === "asset" && (!httpsUrl(out.assetUrl) || !out.coverNote)) out = { status: "failed", reason: "the producer reported ready without a hosted asset and its cover note" }

    // SETTLE (counted, fenced on `producing`). Supersede the previous ready version first (one ready per magnet).
    const settledAt = new Date().toISOString()
    if (out.status === "ready") {
      const prev = existing.rows.filter((d) => d.status === "ready")
      if (prev.length) {
        const sup = await svc.from("lead_magnet_deliverables").update({ status: "superseded", updated_at: settledAt }).eq("brokerage_id", input.brokerageId).eq("form_id", input.formId).eq("status", "ready").select("id")
        if (sup.error) out = { status: "failed", reason: `the previous version could not be superseded: ${sup.error.message ?? "unknown"}` }
      }
    }
    const patch = {
      status: out.status, asset_url: out.assetUrl ?? null, document_id: out.documentId ?? null, title: out.title ?? input.title,
      cover_note: out.coverNote ?? null, payload: out.payload ?? {}, validation: out.validation ?? (out.status === "ready" ? { ok: true } : { ok: false }),
      error: out.status === "ready" ? null : (out.reason ?? null), produced_at: out.status === "ready" ? settledAt : null, updated_at: settledAt,
    }
    const upd = await svc.from("lead_magnet_deliverables").update(patch).eq("id", row.id).eq("brokerage_id", input.brokerageId).eq("status", "producing").select(DELIVERABLE_COLUMNS)
    if (upd.error) return { ok: false, required: true, recorded: true, error: `the deliverable was produced but not recorded: ${upd.error.message ?? "unknown"}`, deliverable: row }
    if (!Array.isArray(upd.data) || upd.data.length !== 1) return { ok: false, required: true, recorded: true, error: "the deliverable changed under this attempt (matched no row)", deliverable: row }
    const settled = upd.data[0] as DeliverableRow
    return settled.status === "failed"
      ? { ok: false, required: true, recorded: true, error: settled.error ?? "the deliverable could not be produced", deliverable: settled }
      : { ok: true, required: true, deliverable: settled }
  } catch (e) {
    return { ok: false, required: true, recorded: false, error: `produceLeadMagnetDeliverable threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * THE PUBLISH GATE (C11): the magnet may publish only with a READY deliverable. A magnet created before ruling 5 (or whose
 * production failed) gets its asset produced now — the same unit, completed lazily; a `staged` asset (a book still being
 * written) refuses with the reason; a fresh `producing` attempt refuses (in flight). Fails closed on any refused read.
 */
export async function ensureDeliverableForPublish(svc: Db, input: DeliverableProductionInput, deps: DeliverableDeps = {}): Promise<DeliverableResult> {
  const spec = deliverableSpecFor(input.magnetType, input.settings)
  if (!spec) return { ok: true, required: false }
  const r = await readDeliverables(svc, input.brokerageId, input.formId)
  if (r.error) return { ok: false, required: true, recorded: false, error: r.error }
  const ready = r.rows.find((d) => d.status === "ready" && d.kind === spec.kind)
  if (ready) return { ok: true, required: true, deliverable: ready }
  const now = (deps.now ?? new Date()).getTime()
  const inFlight = r.rows.find((d) => d.status === "producing" && d.created_at && now - Date.parse(d.created_at) < STALE_PRODUCING_MS)
  if (inFlight) return { ok: false, required: true, recorded: true, error: "the deliverable is still being produced — publish when it is ready", deliverable: inFlight }
  const produced = await produceLeadMagnetDeliverable(svc, input, deps)
  if (produced.ok && produced.required && produced.deliverable.status !== "ready") {
    return { ok: false, required: true, recorded: true, error: produced.deliverable.error ?? "the deliverable is staged — the offer stays unpublished until it is ready", deliverable: produced.deliverable }
  }
  return produced
}

/** Record WHO approved the deliverable (the C5-permitted publisher) on its own row — counted, tenant-pinned, ready-fenced. */
export async function recordDeliverableApproval(svc: Db, input: { brokerageId: string; deliverableId: string; approverUserId: string; decision: { basis: string; tier?: string | null; reason: string; permittedUserIds: string[] }; at: string }): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await svc.from("lead_magnet_deliverables")
    .update({ approved_by: input.approverUserId, approved_at: input.at, approver: { basis: input.decision.basis, tier: input.decision.tier ?? null, reason: input.decision.reason, permitted: input.decision.permittedUserIds.length }, updated_at: input.at })
    .eq("id", input.deliverableId).eq("brokerage_id", input.brokerageId).eq("status", "ready").select("id")
  if (error) return { ok: false, error: error.message ?? "update refused" }
  if (!Array.isArray(data) || data.length !== 1) return { ok: false, error: "the ready deliverable changed before its approval was recorded (matched no row)" }
  return { ok: true }
}
