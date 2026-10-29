// lib/lead-magnets/promised-deliverables.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PROMISE LEDGER — WHAT A LEAD MAGNET PROMISED IS DELIVERED (wave 146, lane 146F — owner ruling 10, contract C4).
//
// OWNER (2026-10-29): "The arbiter needs to make sure that any deliverables that were promised from the lead magnet are
// delivered." Capture source campaign/form, promised asset + version, recipient identity, consent basis, delivery mechanism,
// status, retries, failure, final evidence. FORM/REQUEST → canonical identity → record the promise → confirm the asset exists
// and is approved → deliver via a permitted channel or the secure portal → verify send/access → arbiter follow-up. Never mark
// delivered when the guide/video/report/book was missing; one request never produces duplicate deliveries.
//
// WHAT WAS THERE (audited at bf67aa63): lib/kernel/lead-magnets.ts captureFormSubmission called the delivery runner's
// deliverMagnet, which PREPARED the copy and wrote an activity "lead_magnet_delivered" — and nothing ever sent it. A guide
// whose booklet failed to render was "delivered" as its cover note; a double form post wrote two deliveries; nobody retried,
// and the AI ISA read "Delivered" off the timeline for a guide the person never received. The runner is split (prepare vs
// record — tombstone in lib/marketing/lead-magnet-delivery-runner.ts) and THIS module is the one place a promise lives:
//
//   recordPromisedDeliverable  the capture records the promise (m883 lead_magnet_promises): form, submission, campaign +
//                              attribution, contact + person, the promised asset (promisedAssetFor), consent basis, due time.
//                              Idempotent: UNIQUE(submission_id), and an open / delivered promise for the same (form, contact)
//                              inside REQUEST_DEDUPE_WINDOW_MS is REUSED (a double post is one request).
//   deliverPromised            claim (optimistic, counted) → prepare (the runner) → the asset must EXIST and be APPROVED
//                              (preparedAssetVerdict) → send through permitted channels (email through the governed
//                              dispatchEmail — consent / suppression / de-confliction / content safety / action ledger, at
//                              most once per promise by the ledger cycle; the secure portal card when the person has a portal
//                              sign-in) → verified (provider message id / the card row) → `delivered` + evidence + the
//                              timeline activity. Anything else is asset_missing / failed with the reason, a back-off retry,
//                              and — once overdue or out of attempts — the arbiter's signal LEAD_MAGNET_PROMISE_UNDELIVERED_SIGNAL.
//   undeliveredPromisesFor     the arbiter's (and the Promises panel's) read: every promise not delivered, overdue first.
//   sweepUndeliveredPromises   the retry driver (app/api/cron/marketing-campaign-scheduler, every 30 min): due retries, overdue
//                              escalations; each promise handled under its OWN brokerage_id.
//   attestPromiseDelivered     the HUMAN fulfilment door (an agent-prepared home value): delivered only with a document of
//                              THIS contact in THIS tenant as evidence — an attestation without the asset is refused.
//
// Not server-only: the proof (scripts/lead-magnet-promise-guard.ts) drives it on the in-memory client with seams. The runner,
// the dispatcher, the portal writer and the signal bus are lazy imports at their call.

type Db = { from: (table: string) => any }

/** The arbiter's signal (contract C4 — the name is fixed). Registered in lib/kernel/signal-registry.ts by lane 146D. */
export const LEAD_MAGNET_PROMISE_UNDELIVERED_SIGNAL = "lead_magnet_promise_undelivered" as const

/** lead_magnet_promises.status (m883 CHECK). */
export const PROMISE_STATUSES = ["promised", "delivering", "asset_missing", "awaiting_human", "failed", "delivered", "cancelled"] as const
export type PromiseStatus = (typeof PROMISE_STATUSES)[number]

/** lead_magnet_promises.asset_kind (m883 CHECK). checklist / video are admitted for magnets that will promise them; no
 *  magnet type maps to them today (promisedAssetFor). */
export const PROMISE_ASSET_KINDS = ["guide", "book", "report", "valuation", "checklist", "video"] as const
export type PromiseAssetKind = (typeof PROMISE_ASSET_KINDS)[number]

/** transparency_updates.update_type of the portal card that carries a delivered asset. */
export const PROMISE_PORTAL_UPDATE_TYPE = "lead_magnet_deliverable"

const OPEN_STATUSES: readonly PromiseStatus[] = ["promised", "delivering", "asset_missing", "awaiting_human", "failed"]
const CLAIMABLE: readonly PromiseStatus[] = ["promised", "asset_missing", "failed"]
const MAX_DELIVERY_ATTEMPTS = 5
/** Minutes to wait before attempt n+1 (index = attempts already made − 1). */
const RETRY_BACKOFF_MINUTES = [5, 15, 60, 240, 720] as const
/** A double post / a retried capture of the same request inside this window reuses the promise. */
const REQUEST_DEDUPE_WINDOW_MS = 24 * 3_600_000
/** A system-produced asset is due promptly; an agent-prepared home value within one day. */
const SYSTEM_DUE_MS = 15 * 60_000
const HUMAN_DUE_MS = 24 * 3_600_000
/** A `delivering` claim older than this is a crashed attempt and may be re-claimed. */
const STALE_CLAIM_MS = 10 * 60_000

// ── PURE ─────────────────────────────────────────────────────────────────────

interface PromisedAsset {
  kind: PromiseAssetKind
  title: string
  fulfilment: "system" | "human"
}

/** A finished book the magnet distributes (lib/kernel/lead-magnets.ts leadMagnetBookRefOf). */
export interface PromiseBookRef { pdfUrl: string; documentId: string | null; title: string; chapters: number }

/**
 * PURE. What a magnet PROMISED the person who filled it out — read off what its page offers (lib/marketing/lead-magnet-copy.ts
 * LANDING: "Send me the guide", "Your local market report", "a precise, agent-prepared value"). Null for a magnet that promises
 * no asset (a listing-alert subscription, an open-house RSVP, a plain contact form).
 */
function promisedAssetFor(input: { magnetType: string | null | undefined; book?: PromiseBookRef | null }): PromisedAsset | null {
  switch (input.magnetType) {
    case "buyer_guide":
    case "seller_guide":
      return input.book
        ? { kind: "book", title: input.book.title, fulfilment: "system" }
        : { kind: "guide", title: input.magnetType === "buyer_guide" ? "The Complete Home-Buying Guide" : "Sell for More, With Less Stress", fulfilment: "system" }
    case "market_report":
      return { kind: "report", title: "Your Local Market Report", fulfilment: "system" }
    case "home_valuation":
      return { kind: "valuation", title: "Your precise home value (agent-prepared CMA)", fulfilment: "human" }
    default:
      return null
  }
}

/** What the runner prepared (lib/marketing/lead-magnet-delivery-runner.ts PreparedMagnetDelivery — the fields read here). */
export interface PreparedAsset {
  deliverable: { subject: string; title: string; body: string } | null
  pdfUrl: string | null
  documentId: string | null
  deliverableKind: "book" | "booklet" | "copy"
  heldReason?: string
}

/**
 * PURE. Does the prepared material FULFIL the promise? The asset must EXIST (a hosted file the person can open) and be the
 * KIND that was promised: a guide is the designed booklet or the book, never its cover note; a book is the finished book's
 * PDF; a report is a hosted report document — the runner has no market-report producer, so a report promise is MISSING until
 * one exists (said, never faked). A held compliance gate is missing too (the copy did not clear).
 */
function preparedAssetVerdict(kind: PromiseAssetKind, prepared: PreparedAsset | null):
  | { ok: true; assetUrl: string; documentId: string | null; title: string }
  | { ok: false; reason: string } {
  if (!prepared || !prepared.deliverable) return { ok: false, reason: `nothing to deliver — ${prepared?.heldReason ?? "the deliverable could not be prepared"}` }
  const url = typeof prepared.pdfUrl === "string" && /^https:\/\/\S+$/.test(prepared.pdfUrl) ? prepared.pdfUrl : null
  switch (kind) {
    case "book":
      if (prepared.deliverableKind !== "book" || !url) return { ok: false, reason: "the promised book's hosted PDF is not available" }
      break
    case "guide":
      if ((prepared.deliverableKind !== "booklet" && prepared.deliverableKind !== "book") || !url) return { ok: false, reason: "the promised guide (the designed PDF) did not render — the cover note alone is not the guide" }
      break
    case "report":
      if (!url || prepared.deliverableKind === "copy") return { ok: false, reason: "no market-report document exists for this request (the OS has no report producer for this magnet yet — the cover note is not the report)" }
      break
    default:
      return { ok: false, reason: `a ${kind} is fulfilled by a person, not by the system rail` }
  }
  return { ok: true, assetUrl: url!, documentId: prepared.documentId ?? null, title: prepared.deliverable.title }
}

/** PURE. When the next attempt may run after `attempts` attempts (null when attempts are exhausted). */
function nextAttemptAt(attempts: number, now: Date): string | null {
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return null
  const mins = RETRY_BACKOFF_MINUTES[Math.max(0, Math.min(attempts - 1, RETRY_BACKOFF_MINUTES.length - 1))]
  return new Date(now.getTime() + mins * 60_000).toISOString()
}

// ── RECORD ───────────────────────────────────────────────────────────────────

export interface RecordPromiseInput {
  brokerageId: string
  formId: string
  submissionId: string
  /** contacts.id (the PK) — the canonical recipient. */
  contactId: string | null
  personId?: string | null
  /** The VERIFIED campaign (this tenant's — captureFormSubmission verifies it). */
  campaignId?: string | null
  attribution?: Record<string, unknown> | null
  magnetType: string
  book?: PromiseBookRef | null
  tcpaConsentGiven?: boolean
  now?: Date
}

export type RecordPromiseResult =
  | { ok: true; promised: true; promiseId: string; reused: boolean; status: PromiseStatus }
  | { ok: true; promised: false; reason: string }
  | { ok: false; error: string }

const PROMISE_COLUMNS = "id, brokerage_id, form_id, submission_id, contact_id, person_id, magnet_type, asset_kind, asset_title, asset_ref, fulfilment, status, due_at, attempts, last_attempt_at, next_attempt_at, last_error, delivered_at, delivered_via, evidence, escalated_at, created_at"

interface PromiseRow {
  id: string; brokerage_id: string; form_id: string | null; submission_id: string | null; contact_id: string | null
  person_id: string | null; magnet_type: string; asset_kind: PromiseAssetKind; asset_title: string | null
  asset_ref: Record<string, unknown> | null; fulfilment: "system" | "human"; status: PromiseStatus; due_at: string
  attempts: number; last_attempt_at: string | null; next_attempt_at: string | null; last_error: string | null
  delivered_at: string | null; delivered_via: string | null; evidence: Record<string, unknown> | null; escalated_at: string | null
  created_at: string | null
}

/** Record what the request was promised. Idempotent per request (see the header). Never throws. */
export async function recordPromisedDeliverable(svc: Db, input: RecordPromiseInput): Promise<RecordPromiseResult> {
  try {
    if (!input.brokerageId || !input.formId || !input.submissionId) return { ok: false, error: "tenant, form and submission are required" }
    const asset = promisedAssetFor({ magnetType: input.magnetType, book: input.book ?? null })
    if (!asset) return { ok: true, promised: false, reason: `a ${input.magnetType} magnet promises no asset` }
    if (!input.contactId) return { ok: true, promised: false, reason: "no recipient identity (no email or phone on the request) — nothing can be delivered" }
    const now = input.now ?? new Date()

    // 1 · the same request (a retried capture of THIS submission).
    const bySub = await svc.from("lead_magnet_promises").select("id, status").eq("brokerage_id", input.brokerageId).eq("submission_id", input.submissionId).maybeSingle()
    if (bySub.error) return { ok: false, error: `lead_magnet_promises read refused: ${bySub.error.message ?? "unknown"}` }
    if (bySub.data) return { ok: true, promised: true, promiseId: bySub.data.id, reused: true, status: bySub.data.status }

    // 2 · a double post — the same person, the same magnet, inside the request window, not cancelled.
    const since = new Date(now.getTime() - REQUEST_DEDUPE_WINDOW_MS).toISOString()
    const recent = await svc.from("lead_magnet_promises").select("id, status, created_at")
      .eq("brokerage_id", input.brokerageId).eq("form_id", input.formId).eq("contact_id", input.contactId)
      .gte("created_at", since).neq("status", "cancelled").order("created_at", { ascending: false }).limit(1)
    if (recent.error) return { ok: false, error: `lead_magnet_promises read refused: ${recent.error.message ?? "unknown"}` }
    const twin = ((recent.data ?? []) as Array<{ id: string; status: PromiseStatus }>)[0]
    if (twin) return { ok: true, promised: true, promiseId: twin.id, reused: true, status: twin.status }

    const status: PromiseStatus = asset.fulfilment === "human" ? "awaiting_human" : "promised"
    const row = {
      brokerage_id: input.brokerageId,
      form_id: input.formId,
      submission_id: input.submissionId,
      campaign_id: input.campaignId ?? null,
      attribution: input.attribution ?? {},
      contact_id: input.contactId,
      person_id: input.personId ?? null,
      magnet_type: input.magnetType,
      asset_kind: asset.kind,
      asset_title: asset.title,
      asset_ref: input.book ? { table: "book_projects", url: input.book.pdfUrl, document_id: input.book.documentId } : {},
      fulfilment: asset.fulfilment,
      consent_basis: input.tcpaConsentGiven === true ? "requested_with_tcpa_consent" : "requested_by_form",
      status,
      due_at: new Date(now.getTime() + (asset.fulfilment === "human" ? HUMAN_DUE_MS : SYSTEM_DUE_MS)).toISOString(),
      attempts: 0,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }
    const ins = await svc.from("lead_magnet_promises").insert(row).select("id").maybeSingle()
    if (ins.error) {
      // A concurrent capture of the same submission won the UNIQUE(submission_id) race — reuse its promise.
      if (ins.error.code === "23505") {
        const winner = await svc.from("lead_magnet_promises").select("id, status").eq("brokerage_id", input.brokerageId).eq("submission_id", input.submissionId).maybeSingle()
        if (winner.data) return { ok: true, promised: true, promiseId: winner.data.id, reused: true, status: winner.data.status }
      }
      return { ok: false, error: `the promise was not recorded: ${ins.error.message ?? "unknown"}` }
    }
    if (!ins.data?.id) return { ok: false, error: "the promise insert returned no row" }
    return { ok: true, promised: true, promiseId: ins.data.id, reused: false, status }
  } catch (e) {
    return { ok: false, error: `recordPromisedDeliverable threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ── DELIVER ──────────────────────────────────────────────────────────────────

/** The governed email send (lib/providers/dispatch.ts dispatchEmail) — the fields this module passes and reads. */
export type PromiseEmailSender = (p: {
  brokerageId: string; contactId: string; agentId?: string; userId?: string; to: string; subject: string; html: string; text: string
  channelPurpose: "transactional"; systemSource: string; ledger: { reasonCode: "CONVERSATION_RESPONSE"; cycle: string }; metadata: Record<string, unknown>
}) => Promise<{ success: boolean; providerKey: string; messageId?: string; error?: string }>

/** The portal card writer (lib/kernel/portal-value.ts pushPortalValueCard). */
export type PromisePortalWriter = (p: {
  brokerageId: string; contactId: string; title: string; summary: string; updateType: string; dedupeWindowMs: number; metadata: Record<string, unknown>
}, svc: Db) => Promise<{ pushed: boolean; id?: string; reason?: string }>

/** The runner's preparation (lib/marketing/lead-magnet-delivery-runner.ts prepareMagnetDelivery). */
export type PromisePreparer = (a: {
  brokerageId: string; contactId: string; agentUserId: string | null; magnetType: string; magnetId: string
  book: PromiseBookRef | null; area: string | null
}, svc: Db) => Promise<PreparedAsset>

/** The arbiter's bus (lib/kernel/manager-signals.ts publishManagerSignal). */
export type PromiseSignalPublisher = (s: {
  brokerageId: string; fromManager: string; toManager: string; signalType: string; message: string
  entityType: string; entityId: string; contactId: string | null; payload: Record<string, unknown>
}, svc: Db) => Promise<{ ok: boolean; reason?: string }>

/** The timeline activity (lib/marketing/lead-magnet-delivery-runner.ts recordMagnetDelivery). */
export type PromiseActivityRecorder = (a: {
  brokerageId: string; contactId: string; agentUserId: string | null; magnetType: string
  deliverable: { subject: string; title: string; body: string }; refs: Record<string, unknown>
}, svc: Db) => Promise<{ ok: boolean; error?: string }>

/** The C4 final phase on the cover note (lib/marketing/humanize-final.ts finalizeForDistribution, kind 'lead_magnet', the
 *  tenant's brand): machine phrasing out, the brand's voice + tagline in; a hard fair-housing finding or a word the brand
 *  prohibits holds the delivery (no approval waives them). */
export type PromiseFinalizer = (a: { brokerageId: string; agentUserId: string | null; text: string }, svc: Db) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>

export interface PromiseDeps {
  now?: Date
  finalize?: PromiseFinalizer
  prepare?: PromisePreparer
  sendEmail?: PromiseEmailSender
  pushPortal?: PromisePortalWriter
  publishSignal?: PromiseSignalPublisher
  recordActivity?: PromiseActivityRecorder
  /** The book the magnet distributes, resolved by the caller (the capture already read it); default: read through the entity. */
  book?: PromiseBookRef | null
}

export type DeliverPromiseResult =
  | { ok: true; status: "delivered"; promiseId: string; reused: boolean; via: string; evidence: Record<string, unknown> }
  | { ok: true; status: Exclude<PromiseStatus, "delivered">; promiseId: string; reason: string; escalated: boolean }
  | { ok: false; error: string }

const defaultFinalize: PromiseFinalizer = async (a, svc) => {
  const { finalizeForDistribution, resolveTenantBrandForFinal } = await import("@/lib/marketing/humanize-final")
  const brand = await resolveTenantBrandForFinal(svc, { brokerageId: a.brokerageId, agentUserId: a.agentUserId })
  const final = await finalizeForDistribution({ assetKind: "lead_magnet", text: a.text, tenantBrand: brand.brand })
  const hard = [...final.fairHousing, ...final.brandVoice.prohibited.map((w) => `prohibited by the brand voice: "${w}"`)]
  return hard.length ? { ok: false, reason: hard.join("; ") } : { ok: true, text: final.text }
}

/** The timeline line, written by the runner's ONE recorder — only after a verified delivery (or a human attestation). */
const defaultRecordActivity: PromiseActivityRecorder = async (a, client) => {
  const { recordMagnetDelivery } = await import("@/lib/marketing/lead-magnet-delivery-runner")
  type RecordArgs = Parameters<typeof recordMagnetDelivery>[0]
  return recordMagnetDelivery({ ...a, magnetType: a.magnetType as RecordArgs["magnetType"], refs: a.refs as unknown as RecordArgs["refs"] }, client as never)
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

async function readPromise(svc: Db, brokerageId: string, promiseId: string): Promise<{ row: PromiseRow | null; error: string | null }> {
  const { data, error } = await svc.from("lead_magnet_promises").select(PROMISE_COLUMNS).eq("id", promiseId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { row: null, error: `lead_magnet_promises read refused: ${error.message ?? "unknown"}` }
  return { row: (data as PromiseRow | null) ?? null, error: null }
}

/** A counted, tenant-pinned, state-fenced update of one promise (a write that matched nothing RESOLVES — counted here). */
async function updatePromise(svc: Db, row: { id: string; brokerage_id: string }, patch: Record<string, unknown>, fence: { status?: PromiseStatus | readonly PromiseStatus[]; attempts?: number } = {}): Promise<{ ok: boolean; error?: string }> {
  let q = svc.from("lead_magnet_promises").update(patch).eq("id", row.id).eq("brokerage_id", row.brokerage_id)
  if (typeof fence.status === "string") q = q.eq("status", fence.status)
  else if (Array.isArray(fence.status)) q = q.in("status", [...fence.status])
  if (typeof fence.attempts === "number") q = q.eq("attempts", fence.attempts)
  const { data, error } = await q.select("id")
  if (error) return { ok: false, error: error.message ?? "update refused" }
  if (!Array.isArray(data) || data.length !== 1) return { ok: false, error: "the promise changed under this attempt (matched no row)" }
  return { ok: true }
}

/** Raise the arbiter's moment ONCE per promise (escalated_at fences it; the bus dedupes an open signal per entity too). */
async function escalate(svc: Db, row: PromiseRow, reason: string, now: Date, deps: PromiseDeps): Promise<boolean> {
  if (row.escalated_at) return false
  const publish: PromiseSignalPublisher = deps.publishSignal ?? (async (s, c) => {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    return publishManagerSignal(s as Parameters<typeof publishManagerSignal>[0], c as never)
  })
  const sent = await publish({
    brokerageId: row.brokerage_id,
    // campaign_orchestrator owns the lead-magnet surfaces; the arbiter's desk is the AI ISA (lib/ai-isa/followup-arbiter.ts).
    fromManager: "campaign_orchestrator",
    toManager: "ai_isa",
    // spelled as the literal so test:signal-integrity's publish scan SEES it (it reads `signalType: "…"` literals only);
    // equal to LEAD_MAGNET_PROMISE_UNDELIVERED_SIGNAL by the type below
    signalType: "lead_magnet_promise_undelivered" satisfies typeof LEAD_MAGNET_PROMISE_UNDELIVERED_SIGNAL,
    message: `A lead-magnet promise is not delivered: ${row.asset_title ?? row.asset_kind} (${row.status}) — ${reason}`,
    entityType: "lead_magnet_promise",
    entityId: row.id,
    contactId: row.contact_id,
    payload: { promise_id: row.id, form_id: row.form_id, asset_kind: row.asset_kind, fulfilment: row.fulfilment, status: row.status, attempts: row.attempts, due_at: row.due_at, reason, priority: "high" },
  }, svc).catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }))
  if (!sent.ok) {
    console.error(`[promised-deliverables] the undelivered signal for promise ${row.id} was NOT raised: ${sent.reason ?? "unknown"}`)
    return false
  }
  const stamped = await updatePromise(svc, row, { escalated_at: now.toISOString(), updated_at: now.toISOString() })
  if (!stamped.ok) console.error(`[promised-deliverables] promise ${row.id} escalated but escalated_at not stamped: ${stamped.error}`)
  return true
}

/** Record a failed / missing attempt with its reason and back-off; escalate when overdue or out of attempts. */
async function failAttempt(svc: Db, row: PromiseRow, status: "asset_missing" | "failed", reason: string, now: Date, deps: PromiseDeps): Promise<DeliverPromiseResult> {
  const exhausted = row.attempts >= MAX_DELIVERY_ATTEMPTS
  const finalStatus: PromiseStatus = exhausted ? "failed" : status
  const patch = { status: finalStatus, last_error: reason.slice(0, 1000), next_attempt_at: nextAttemptAt(row.attempts, now), updated_at: now.toISOString() }
  const w = await updatePromise(svc, row, patch, { status: "delivering" })
  if (!w.ok) return { ok: false, error: `the failed attempt on promise ${row.id} was not recorded: ${w.error}` }
  const after: PromiseRow = { ...row, ...patch } as PromiseRow
  const overdue = now.getTime() >= new Date(row.due_at).getTime()
  const escalated = exhausted || overdue ? await escalate(svc, after, reason, now, deps) : false
  return { ok: true, status: finalStatus as Exclude<PromiseStatus, "delivered">, promiseId: row.id, reason, escalated }
}

/**
 * Deliver ONE promise. Idempotent: a delivered promise replays its evidence; a claim in flight refuses; the email is at most
 * once per promise (action-ledger cycle). The tenant is the caller's VERIFIED brokerage (the capture's form row, the sweep's
 * own row) and every read and write is pinned to it. Never throws.
 */
export async function deliverPromised(svc: Db, input: { brokerageId: string; promiseId: string }, deps: PromiseDeps = {}): Promise<DeliverPromiseResult> {
  try {
    const now = deps.now ?? new Date()
    const read = await readPromise(svc, input.brokerageId, input.promiseId)
    if (read.error) return { ok: false, error: read.error }
    const row = read.row
    if (!row) return { ok: false, error: "promise not found in this brokerage" }
    if (row.status === "delivered") return { ok: true, status: "delivered", promiseId: row.id, reused: true, via: row.delivered_via ?? "unknown", evidence: row.evidence ?? {} }
    if (row.status === "cancelled") return { ok: true, status: "cancelled", promiseId: row.id, reason: "the promise was cancelled", escalated: false }

    // A PERSON fulfils it (an agent-prepared home value) — the system never fakes it; overdue → the arbiter's moment.
    if (row.fulfilment === "human") {
      const overdue = now.getTime() >= new Date(row.due_at).getTime()
      const reason = "an agent prepares and sends this (attestPromiseDelivered records it with the document as evidence)"
      const escalated = overdue ? await escalate(svc, row, `${reason} — overdue since ${row.due_at}`, now, deps) : false
      return { ok: true, status: "awaiting_human", promiseId: row.id, reason, escalated }
    }

    // CLAIM (optimistic: the status AND the attempt count must still be what was read; a stale `delivering` is re-claimable).
    const staleClaim = row.status === "delivering" && (!row.last_attempt_at || now.getTime() - new Date(row.last_attempt_at).getTime() > STALE_CLAIM_MS)
    if (row.status === "delivering" && !staleClaim) return { ok: true, status: "delivering", promiseId: row.id, reason: "another attempt is in flight", escalated: false }
    if (row.attempts >= MAX_DELIVERY_ATTEMPTS && !staleClaim) {
      // Out of attempts: the arbiter / a person owns it now (escalated once). A human may still deliver it by hand.
      const escalated = await escalate(svc, row, `out of attempts (${row.attempts}): ${row.last_error ?? "undelivered"}`, now, deps)
      return { ok: true, status: row.status as Exclude<PromiseStatus, "delivered">, promiseId: row.id, reason: `out of attempts (${row.attempts}) — awaiting the arbiter or a hand delivery`, escalated }
    }
    if (!staleClaim && !CLAIMABLE.includes(row.status)) return { ok: true, status: row.status as Exclude<PromiseStatus, "delivered">, promiseId: row.id, reason: `not deliverable from ${row.status}`, escalated: false }
    if (!staleClaim && row.status !== "promised" && row.next_attempt_at && new Date(row.next_attempt_at).getTime() > now.getTime()) {
      return { ok: true, status: row.status as Exclude<PromiseStatus, "delivered">, promiseId: row.id, reason: `next attempt not before ${row.next_attempt_at}`, escalated: false }
    }
    const attempts = row.attempts + 1
    const claim = await updatePromise(svc, row, { status: "delivering", attempts, last_attempt_at: now.toISOString(), updated_at: now.toISOString() }, { status: row.status, attempts: row.attempts })
    if (!claim.ok) return { ok: true, status: "delivering", promiseId: row.id, reason: `not claimed: ${claim.error}`, escalated: false }
    const claimed: PromiseRow = { ...row, status: "delivering", attempts, last_attempt_at: now.toISOString() }

    // THE REQUEST'S OWN FORM AND RECIPIENT, in this tenant.
    if (!row.form_id || !row.contact_id) return failAttempt(svc, claimed, "failed", "the promise lost its form or its recipient", now, deps)
    const form = await svc.from("lead_capture_forms").select("id, agent_id, magnet_type, name, settings, is_active").eq("id", row.form_id).eq("brokerage_id", row.brokerage_id).maybeSingle()
    if (form.error) return failAttempt(svc, claimed, "failed", `lead_capture_forms read refused: ${form.error.message ?? "unknown"}`, now, deps)
    if (!form.data) return failAttempt(svc, claimed, "failed", "the magnet is no longer this brokerage's", now, deps)
    const contact = await svc.from("contacts").select("id, email, first_name, has_login, city").eq("id", row.contact_id).eq("brokerage_id", row.brokerage_id).maybeSingle()
    if (contact.error) return failAttempt(svc, claimed, "failed", `contacts read refused: ${contact.error.message ?? "unknown"}`, now, deps)
    if (!contact.data) return failAttempt(svc, claimed, "failed", "the recipient is no longer a contact of this brokerage", now, deps)
    const f = form.data as { id: string; agent_id: string | null; magnet_type: string | null; name: string | null; settings: Record<string, unknown> | null; is_active: boolean | null }
    const c = contact.data as { id: string; email: string | null; first_name: string | null; has_login: boolean | null; city: string | null }

    // agents.id → users.id (DISJOINT, CLAUDE.md §3) for the signature, the activity and the dispatch actor.
    let agentUserId: string | null = null
    if (f.agent_id) {
      const a = await svc.from("agents").select("user_id").eq("id", f.agent_id).eq("brokerage_id", row.brokerage_id).maybeSingle()
      if (a.error) console.warn(`[promised-deliverables] agent read refused for promise ${row.id}: ${a.error.message}`)
      agentUserId = (a.data as { user_id?: string | null } | null)?.user_id ?? null
    }

    // THE ASSET — prepared by the runner; the book a magnet distributes read through the ONE entity reader.
    let book: PromiseBookRef | null = deps.book ?? null
    if (deps.book === undefined && row.asset_kind === "book") {
      const { loadDistributedBook } = await import("@/lib/lead-magnets/book-entity")
      const { leadMagnetBookRefOf } = await import("@/lib/kernel/lead-magnets")
      const distributed = await loadDistributedBook(svc as never, row.brokerage_id, f.id, f.settings ?? null)
      if (distributed.error) return failAttempt(svc, claimed, "asset_missing", `the distributed book is unreadable: ${distributed.error}`, now, deps)
      book = leadMagnetBookRefOf({ book: distributed.book?.project ?? null })
    }
    const prepare: PromisePreparer = deps.prepare ?? (async (a, client) => {
      const { prepareMagnetDelivery } = await import("@/lib/marketing/lead-magnet-delivery-runner")
      return prepareMagnetDelivery({
        brokerageId: a.brokerageId, contactId: a.contactId, agentUserId: a.agentUserId,
        magnetType: a.magnetType as Parameters<typeof prepareMagnetDelivery>[0]["magnetType"],
        magnetId: a.magnetId, book: a.book, ctx: { area: a.area },
      }, client as never)
    })
    const prepared = await prepare({ brokerageId: row.brokerage_id, contactId: c.id, agentUserId, magnetType: row.magnet_type, magnetId: f.id, book, area: c.city ?? null }, svc)
      .catch((e: unknown) => ({ deliverable: null, pdfUrl: null, documentId: null, deliverableKind: "copy" as const, heldReason: `preparation threw: ${e instanceof Error ? e.message : String(e)}` }))
    const verdict = preparedAssetVerdict(row.asset_kind, prepared)
    if (!verdict.ok) return failAttempt(svc, claimed, "asset_missing", verdict.reason, now, deps)
    // HUMANIZATION PRESERVED (wave 145 ruling 20 / C4): the AI-written cover note passes the ONE final phase before it is sent.
    const finalize = deps.finalize ?? defaultFinalize
    const fin = await finalize({ brokerageId: row.brokerage_id, agentUserId, text: prepared.deliverable!.body }, svc)
      .catch((e: unknown) => ({ ok: false as const, reason: `the final phase could not run: ${e instanceof Error ? e.message : String(e)}` }))
    if (!fin.ok) return failAttempt(svc, claimed, "asset_missing", `the cover note is held by the final phase — ${fin.reason}`, now, deps)
    const deliverable = { ...prepared.deliverable!, body: fin.text }
    // APPROVED: the magnet that made the promise was published by a person (lifecycle.approved_by — the human publish gate in
    // lib/kernel/lead-magnets.ts publishLeadMagnet); the deliverable cleared the compliance gate inside the runner.
    const lifecycle = ((f.settings ?? {}) as { lifecycle?: { approved_by?: string | null; state?: string } }).lifecycle
    const approvalBasis = lifecycle?.approved_by ? "magnet_published_by_a_person" : "live_magnet_without_recorded_publisher"

    // DELIVER — every permitted channel; at least one must accept.
    const channels: string[] = []
    const evidence: Record<string, unknown> = {
      asset_url: verdict.assetUrl, document_id: verdict.documentId, asset_kind: row.asset_kind, deliverable_kind: prepared.deliverableKind,
      approval_basis: approvalBasis, approved_by: lifecycle?.approved_by ?? null, attempt: attempts,
    }
    const errors: string[] = []
    if (c.email) {
      const send: PromiseEmailSender = deps.sendEmail ?? (async (p) => {
        const { dispatchEmail } = await import("@/lib/providers/dispatch")
        // The WHY is named AT the chokepoint call (test:action-ledger census): the reply to the person's own request.
        return dispatchEmail({ ...p, systemSource: "lead_magnet_delivery", ledger: { reasonCode: "CONVERSATION_RESPONSE", cycle: p.ledger.cycle } })
      })
      const greeting = c.first_name ? `Hi ${escapeHtml(c.first_name)},` : "Hi,"
      const html = `<p>${greeting}</p><p>${escapeHtml(deliverable.body).replace(/\n/g, "<br/>")}</p><p><a href="${escapeHtml(verdict.assetUrl)}">Open ${escapeHtml(verdict.title)}</a></p>`
      const sent = await send({
        brokerageId: row.brokerage_id, contactId: c.id, agentId: f.agent_id ?? undefined, userId: agentUserId ?? undefined,
        to: c.email, subject: deliverable.subject, html, text: `${deliverable.body}\n\n${verdict.assetUrl}`,
        // The person ASKED for this asset on the form — the reply to their own request, governed like every send.
        channelPurpose: "transactional", systemSource: "lead_magnet_delivery",
        ledger: { reasonCode: "CONVERSATION_RESPONSE", cycle: `lead_magnet_promise:${row.id}` },
        metadata: { lead_magnet_promise_id: row.id, form_id: f.id, asset_kind: row.asset_kind },
      }).catch((e: unknown): Awaited<ReturnType<PromiseEmailSender>> => ({ success: false, providerKey: "threw", error: e instanceof Error ? e.message : String(e) }))
      if (sent.success) {
        channels.push("email")
        evidence.email = { provider: sent.providerKey, message_id: sent.messageId ?? null }
      } else errors.push(`email refused (${sent.providerKey}): ${sent.error ?? "unknown"}`)
    } else errors.push("no email on the contact")

    if (c.has_login === true) {
      // The SECURE PORTAL — visible only to this contact (transparency_updates is the contact's own feed); once per promise.
      const cards = await svc.from("transparency_updates").select("id, metadata").eq("brokerage_id", row.brokerage_id).eq("contact_id", c.id).eq("update_type", PROMISE_PORTAL_UPDATE_TYPE)
      if (cards.error) errors.push(`portal card read refused: ${cards.error.message ?? "unknown"}`)
      else {
        const existing = ((cards.data ?? []) as Array<{ id: string; metadata?: Record<string, unknown> | null }>).find((r) => r.metadata?.lead_magnet_promise_id === row.id)
        if (existing) { channels.push("portal"); evidence.portal = { card_id: existing.id, reused: true } }
        else {
          const push: PromisePortalWriter = deps.pushPortal ?? (async (p, client) => {
            const { pushPortalValueCard } = await import("@/lib/kernel/portal-value")
            return pushPortalValueCard(p as Parameters<typeof pushPortalValueCard>[0], client as never)
          })
          const pushed = await push({
            brokerageId: row.brokerage_id, contactId: c.id, title: verdict.title.slice(0, 200),
            // The link rides the summary text too: the portal feed renders the card's words today; rendering metadata.asset_url
            // as a button is lane 146C's (app/portal/**) — Outside-lane in the 146F notes.
            summary: `The ${row.asset_kind} you asked for is ready: ${verdict.assetUrl}`,
            updateType: PROMISE_PORTAL_UPDATE_TYPE, dedupeWindowMs: 0,
            metadata: { lead_magnet_promise_id: row.id, asset_url: verdict.assetUrl, document_id: verdict.documentId, asset_kind: row.asset_kind },
          }, svc).catch((e: unknown): Awaited<ReturnType<PromisePortalWriter>> => ({ pushed: false, reason: e instanceof Error ? e.message : String(e) }))
          if (pushed.pushed && pushed.id) { channels.push("portal"); evidence.portal = { card_id: pushed.id } }
          else errors.push(`portal card not written: ${pushed.reason ?? "unknown"}`)
        }
      }
    }

    if (channels.length === 0) return failAttempt(svc, claimed, "failed", errors.join("; ") || "no permitted channel accepted the delivery", now, deps)

    // VERIFIED → delivered (fenced on this attempt's claim, counted).
    const via = channels.length === 2 ? "email_and_portal" : channels[0]
    evidence.verified_at = now.toISOString()
    if (errors.length) evidence.partial_failures = errors
    const done = await updatePromise(svc, claimed, {
      status: "delivered", delivered_at: now.toISOString(), delivered_via: via, channels, evidence, last_error: null, next_attempt_at: null,
      asset_ref: { ...(row.asset_ref ?? {}), url: verdict.assetUrl, document_id: verdict.documentId },
      asset_version: verdict.documentId ?? verdict.assetUrl, updated_at: now.toISOString(),
    }, { status: "delivering", attempts })
    if (!done.ok) return { ok: false, error: `the asset went out but promise ${row.id} was not marked delivered: ${done.error}` }

    // The AI ISA's timeline line — only now (the runner's recorder; its refusal is said, the delivery stands).
    const record: PromiseActivityRecorder = deps.recordActivity ?? defaultRecordActivity
    const act = await record({
      brokerageId: row.brokerage_id, contactId: c.id, agentUserId, magnetType: row.magnet_type, deliverable,
      refs: { magnet_id: f.id, pdf_url: verdict.assetUrl, document_id: verdict.documentId, deliverable_kind: prepared.deliverableKind, title: verdict.title, promise_id: row.id, delivered_via: via },
    }, svc).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    if (!act.ok) console.error(`[promised-deliverables] promise ${row.id} delivered but the timeline activity was refused: ${act.error ?? "unknown"}`)

    return { ok: true, status: "delivered", promiseId: row.id, reused: false, via, evidence }
  } catch (e) {
    return { ok: false, error: `deliverPromised threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ── THE ARBITER'S READ ───────────────────────────────────────────────────────

export interface UndeliveredPromise {
  promiseId: string
  contactId: string | null
  formId: string | null
  assetKind: PromiseAssetKind
  assetTitle: string | null
  fulfilment: "system" | "human"
  status: PromiseStatus
  attempts: number
  dueAt: string
  overdue: boolean
  lastError: string | null
  escalated: boolean
  createdAt: string | null
}

/**
 * Every promise of this tenant that is NOT delivered (cancelled excluded), overdue first. The arbiter (lib/ai-isa/followup-
 * arbiter.ts — lane 146B) treats an overdue one as a high-priority moment; the Promises panel lists them. A refused read is an
 * error, never an empty list.
 */
export async function undeliveredPromisesFor(svc: Db, input: { brokerageId: string; contactId?: string | null; now?: Date; limit?: number }): Promise<{ promises: UndeliveredPromise[]; error: string | null }> {
  if (!input.brokerageId) return { promises: [], error: "a tenant is required" }
  const now = input.now ?? new Date()
  let q = svc.from("lead_magnet_promises").select(PROMISE_COLUMNS).eq("brokerage_id", input.brokerageId).in("status", [...OPEN_STATUSES])
  // the arbiter asks about ONE person; the panel asks about the tenant — two named reads, never an optional narrowing of one
  if (typeof input.contactId === "string") q = q.eq("contact_id", input.contactId)
  const { data, error } = await q.order("due_at", { ascending: true }).limit(Math.max(1, Math.min(input.limit ?? 100, 500)))
  if (error) return { promises: [], error: `lead_magnet_promises read refused: ${error.message ?? "unknown"}` }
  const promises = ((data ?? []) as PromiseRow[]).map((r) => ({
    promiseId: r.id, contactId: r.contact_id, formId: r.form_id, assetKind: r.asset_kind, assetTitle: r.asset_title, fulfilment: r.fulfilment,
    status: r.status, attempts: r.attempts, dueAt: r.due_at, overdue: now.getTime() >= new Date(r.due_at).getTime(), lastError: r.last_error,
    escalated: !!r.escalated_at, createdAt: r.created_at,
  }))
  promises.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dueAt.localeCompare(b.dueAt))
  return { promises, error: null }
}

// ── THE RETRY DRIVER ─────────────────────────────────────────────────────────

export interface PromiseSweepResult { examined: number; delivered: number; stillOpen: number; escalated: number; errors: string[] }

/**
 * Retry every due promise and escalate every overdue one, across tenants (the cron's caller verified CRON_SECRET); each promise
 * is read, claimed and delivered under its OWN brokerage_id. Bounded. Never throws.
 */
export async function sweepUndeliveredPromises(svc: Db, opts: { now?: Date; limit?: number; deps?: PromiseDeps } = {}): Promise<PromiseSweepResult> {
  const out: PromiseSweepResult = { examined: 0, delivered: 0, stillOpen: 0, escalated: 0, errors: [] }
  const now = opts.now ?? new Date()
  try {
    const { applyTenantScope, platformScope } = await import("@/lib/kernel/tenant-scope")
    const q = applyTenantScope(
      svc.from("lead_magnet_promises").select("id, brokerage_id, status, next_attempt_at, due_at, escalated_at")
        .in("status", [...OPEN_STATUSES]).lte("due_at", now.toISOString())
        // an escalated promise with no retry left (a person's to fulfil, or out of attempts) is the arbiter's now — it must
        // not hold a slot in every sweep and starve the newer ones
        .or(`escalated_at.is.null,next_attempt_at.lte.${now.toISOString()}`),
      platformScope("the promised-deliverable sweep (/api/cron/marketing-campaign-scheduler, CRON_SECRET verified at the route) retries and escalates undelivered lead-magnet promises across every tenant; each promise is delivered under its own brokerage_id"),
    )
    const { data, error } = await q.order("due_at", { ascending: true }).limit(Math.max(1, Math.min(opts.limit ?? 50, 200)))
    if (error) return { ...out, errors: [`lead_magnet_promises read refused: ${error.message ?? "unknown"} — nothing retried`] }
    for (const p of (data ?? []) as Array<{ id: string; brokerage_id: string | null; status: PromiseStatus; next_attempt_at: string | null; escalated_at: string | null }>) {
      if (!p.brokerage_id) continue
      out.examined++
      const r = await deliverPromised(svc, { brokerageId: p.brokerage_id, promiseId: p.id }, { ...(opts.deps ?? {}), now })
      if (!r.ok) { out.errors.push(`${p.id}: ${r.error}`); continue }
      if (r.status === "delivered") { if (!r.reused) out.delivered++ }
      else {
        out.stillOpen++
        if (r.escalated) out.escalated++
        // An overdue promise the retry could not touch yet (back-off, in flight) still reaches the arbiter once.
        else if (!p.escalated_at && r.status !== "delivering") {
          const read = await readPromise(svc, p.brokerage_id, p.id)
          if (read.row && !read.row.escalated_at && await escalate(svc, read.row, `overdue since ${read.row.due_at}: ${read.row.last_error ?? r.reason}`, now, opts.deps ?? {})) out.escalated++
        }
      }
    }
  } catch (e) {
    out.errors.push(`sweep threw: ${e instanceof Error ? e.message : String(e)}`)
  }
  return out
}

// ── THE HUMAN FULFILMENT DOOR ────────────────────────────────────────────────

/**
 * A person delivered the promised asset themselves (the agent-prepared home value, or a guide sent by hand after the system
 * could not). DELIVERED ONLY WITH THE ASSET: the document must be THIS contact's, in THIS tenant, with a hosted file. The
 * caller is a session door that already verified the tenant and the person's authority (app/actions/lead-magnets-actions.ts).
 */
export async function attestPromiseDelivered(svc: Db, input: { brokerageId: string; promiseId: string; actorUserId: string; documentId: string; now?: Date }, deps: Pick<PromiseDeps, "recordActivity"> = {}): Promise<{ ok: true; reused: boolean } | { ok: false; error: string }> {
  try {
    const now = input.now ?? new Date()
    if (!input.actorUserId || !input.documentId) return { ok: false, error: "the attesting person and the delivered document are required" }
    const read = await readPromise(svc, input.brokerageId, input.promiseId)
    if (read.error) return { ok: false, error: read.error }
    const row = read.row
    if (!row) return { ok: false, error: "promise not found in this brokerage" }
    if (row.status === "delivered") return { ok: true, reused: true }
    if (row.status === "cancelled") return { ok: false, error: "the promise was cancelled" }
    if (!row.contact_id) return { ok: false, error: "the promise has no recipient" }
    const doc = await svc.from("generated_documents").select("id, contact_id, blob_url, document_type, file_name").eq("id", input.documentId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (doc.error) return { ok: false, error: `generated_documents read refused: ${doc.error.message ?? "unknown"}` }
    const d = doc.data as { id: string; contact_id: string | null; blob_url: string | null; document_type: string | null; file_name: string | null } | null
    if (!d) return { ok: false, error: "the document is not this brokerage's" }
    if (d.contact_id !== row.contact_id) return { ok: false, error: "the document was not made for this contact — it cannot be the promised asset" }
    if (!d.blob_url || !/^https:\/\/\S+$/.test(d.blob_url)) return { ok: false, error: "the document has no hosted file — nothing was delivered" }
    const evidence = { asset_url: d.blob_url, document_id: d.id, document_type: d.document_type, attested_by: input.actorUserId, attested_at: now.toISOString(), asset_kind: row.asset_kind }
    const w = await updatePromise(svc, row, {
      status: "delivered", delivered_at: now.toISOString(), delivered_via: "human_attested", evidence, last_error: null, next_attempt_at: null,
      asset_ref: { ...(row.asset_ref ?? {}), table: "generated_documents", id: d.id, url: d.blob_url }, asset_version: d.id, updated_at: now.toISOString(),
    }, { status: row.status })
    if (!w.ok) return { ok: false, error: `not recorded: ${w.error}` }
    const record: PromiseActivityRecorder = deps.recordActivity ?? defaultRecordActivity
    const act = await record({
      brokerageId: row.brokerage_id, contactId: row.contact_id, agentUserId: input.actorUserId, magnetType: row.magnet_type,
      deliverable: { subject: row.asset_title ?? row.asset_kind, title: row.asset_title ?? row.asset_kind, body: `Delivered by hand: ${d.file_name ?? d.id}` },
      refs: { magnet_id: row.form_id, pdf_url: d.blob_url, document_id: d.id, deliverable_kind: "copy", title: row.asset_title ?? row.asset_kind, promise_id: row.id, delivered_via: "human_attested" },
    }, svc).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    if (!act.ok) console.error(`[promised-deliverables] promise ${row.id} attested but the timeline activity was refused: ${act.error ?? "unknown"}`)
    return { ok: true, reused: false }
  } catch (e) {
    return { ok: false, error: `attestPromiseDelivered threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}
