/**
 * THE ACTION LEDGER — one row per external action an agent / manager / automation takes
 * (wave 97, lane 97A; docs/architecture/OS-BLUEPRINT-GAP-MAP.md rows 11, 12, 17).
 *
 * WHY A NEW TABLE (evaluated, not assumed): the survivors each hold a SLICE of this and none can
 * hold the whole without changing what it means —
 *   · ai_autopilot_actions — the agent's next-best-action CARD queue (title/priority/scheduled_for),
 *     read by app/dashboard/agent and ActionPlanCard. Writing every dispatched send there would
 *     flood an agent-facing surface with brokerage-side machinery (and leads belong to the brokerage).
 *   · workflow_runs — one row per CHAIN run, not per action; a send outside a chain has no run.
 *   · outcome_reconciliations — the PROVIDER half (claimed vs provider-reported). It is the
 *     reconciliation partner of this ledger, joined on provider_ref — not a replacement for it.
 *   · self_heal_events / vendor_usage_tracking — self-repair audit and cost metering.
 * So this is BUILT (orphan doctrine case 2) as `agent_action_ledger` (m687) and every other
 * ledger keeps its job.
 *
 * WHAT A ROW SAYS: who acted (actor), for which tenant (the dispatcher's verified tenant — never a
 * request body), on what (subject), what (action, `domain.entity.action`), WHY (reason_code from
 * ACTION_REASON_CODES), whether it happened (status), what came back (outcome, provider_ref, cost),
 * and which event caused it (causation_id / correlation_id — lib/kernel/causation.ts).
 *
 * IDEMPOTENCY: `idempotency_key` is UNIQUE. A caller that knows its cycle (tenant + subject +
 * action + cycle — actionIdempotencyKey) gets at-most-once: the loser of a race is refused 23505
 * and RE-READS the winner (the portal-invite pattern, lib/portal/portal-invite-core.ts:220) —
 *   executed → replay the winner's result, do not act again;
 *   unknown  → the provider never answered (timeout). NOT retried: the message may have gone.
 *              A human / reconciler settles it first;
 *   proposed → in flight elsewhere; refused;
 *   failed / skipped → nothing left the building, so the retry re-claims the row (attempts + 1).
 *
 * "wait" and "do_nothing" are actions too (recordNonAction): status 'skipped' with the reason.
 *
 * DEGRADES SAFELY until m687 is applied: a 42P01 / PGRST205 (no table) or PGRST204 / 42703 (no
 * column) is read, logged once, and the action proceeds UNLEDGERED exactly as it did before this
 * file existed. Any OTHER refusal fails closed when the caller asked for an idempotency key (the
 * key exists to prevent a double send, and an unreadable ledger cannot promise that).
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceClient } from "@/lib/supabase/service"
import { currentCausation } from "@/lib/kernel/causation"
import { getIsaSystemUserIdCached } from "@/lib/auth/isa-actor"


/** agent_action_ledger.status — m687 CHECK agent_action_ledger_status_check. */
const ACTION_STATUSES = ["proposed", "executed", "failed", "unknown", "skipped"] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

/** agent_action_ledger.actor_type — m687 CHECK. `agent` is an agents-row actor (agents.id is
 *  disjoint from users.id, CLAUDE.md §3), `manager` a governed AI manager (ManagerKey). */
const ACTION_ACTOR_TYPES = ["manager", "user", "agent", "system"] as const
export type ActionActorType = (typeof ACTION_ACTOR_TYPES)[number]

/**
 * WHY the system acted — ONE vocabulary (CLAUDE.md §6), m687 CHECK agent_action_ledger_reason_code_check.
 * Stable, uppercase, never renamed (a rename orphans every historical row). Add, never respell.
 * UNSPECIFIED is the honest default for a caller that has not yet said why — it is a finding
 * (the flight recorder shows it), not a reason.
 */
const ACTION_REASON_CODES = [
  "SELLER_FOLLOWUP_INTENT_INCREASE",
  "BUYER_PROPERTY_MATCH",
  "TRANSACTION_DEADLINE",
  "TRANSACTION_MILESTONE",
  "AGENT_SLA_BREACH",
  "PROPERTY_VALUE_CHANGE",
  "LEAD_FIRST_RESPONSE",
  "CAMPAIGN_STEP",
  "LIFETIME_TOUCH",
  "CONTACT_WELCOME",
  "COMPLIANCE_NOTICE",
  "HUMAN_REQUESTED",
  "SCHEDULED_CONTENT_PUBLISH",
  // m692 (wave 99A): a subscription state the lifecycle sweep moved (trial expired / converted).
  "SUBSCRIPTION_LIFECYCLE",
  // m693 (wave 100A): the four WHYs no earlier code fit, found by mapping every sender's own
  // spelling onto this set (REASON_CODE_MAP below). Each one carried callers that recorded UNSPECIFIED.
  "NURTURE_TOUCH",           // the AI ISA's / lead plan's cadenced follow-up to a lead or contact
  "CONVERSATION_RESPONSE",   // answering the person's own message or request (inbound reply, AI chat tool, callback ask)
  "SERVICE_NOTICE",          // operational notice to a client / vendor / partner (vendor booking, feedback request, w9)
  "STAFF_ALERT",             // an alert to the brokerage's own staff (push, lead-magnet notify)
  "WAIT_COOLDOWN",
  "NO_ACTION_NEEDED",
  "UNSPECIFIED",
] as const
export type ActionReasonCode = (typeof ACTION_REASON_CODES)[number]

const REASON_SET = new Set<string>(ACTION_REASON_CODES)
function normalizeReasonCode(code: string | null | undefined): ActionReasonCode {
  return code && REASON_SET.has(code) ? (code as ActionReasonCode) : "UNSPECIFIED"
}

/**
 * THE ONE MAPPING TABLE (wave 100A, CLAUDE.md §6, OWNER LAW 2). Every other spelling of "why an
 * autonomous action happened" is mapped onto ACTION_REASON_CODES HERE and nowhere else:
 *   · system_source — the dispatch / voice / portal / push / social `systemSource` every sender
 *     already passes (≈90 call sites). Exact names first, then the prefix families.
 *   · nba_plan — lib/ai-isa/lead-action-plan.ts LeadTouchPlanCode (the NBA verdict's sub-reason);
 *     its own code rides `detail.plan_code`, the canonical WHY rides reason_code.
 *   · action_prefix — the ledger action name, for writers whose WHY is fixed by what they are
 *     (an AI tool call inside a conversation answers that conversation).
 * EVALUATED, NOT MAPPED: campaign_sequences.trigger_event / notification_rules.trigger_event are
 * WHAT-HAPPENED vocabularies (event types). The event is the CAUSE (causation_id on the row); the
 * WHY of a sequence step is CAMPAIGN_STEP whatever started the enrollment. Manager signal types are
 * manager-to-manager messages, not ledger writers.
 * An explicit valid reasonCode always wins; a spelling with no entry stays UNSPECIFIED (a finding).
 */
const REASON_CODE_MAP = {
  system_source: {
    ai_isa: "NURTURE_TOUCH", ai_isa_contact: "NURTURE_TOUCH", ghost_recovery: "NURTURE_TOUCH", lead_action_plan: "NURTURE_TOUCH",
    sequence: "CAMPAIGN_STEP", newsletter: "CAMPAIGN_STEP", email_campaign: "CAMPAIGN_STEP", prelisting_drip: "CAMPAIGN_STEP",
    direct_mail_campaign: "CAMPAIGN_STEP", marketing_agent_retry: "CAMPAIGN_STEP", open_house_invitation: "CAMPAIGN_STEP",
    farm_mail: "CAMPAIGN_STEP", email_preset: "CAMPAIGN_STEP", sms_preset: "CAMPAIGN_STEP", orchestrated: "CAMPAIGN_STEP", preset: "CAMPAIGN_STEP",
    demo_appointment: "SERVICE_NOTICE",
    lifetime_touchpoints: "LIFETIME_TOUCH", thank_you_note: "LIFETIME_TOUCH", review_request: "LIFETIME_TOUCH", review_automation: "LIFETIME_TOUCH",
    property_alerts: "BUYER_PROPERTY_MATCH", property_alert: "BUYER_PROPERTY_MATCH", listing_concierge_buybox_preview: "BUYER_PROPERTY_MATCH", buyer_search: "BUYER_PROPERTY_MATCH",
    home_value_report: "PROPERTY_VALUE_CHANGE", home_value_investor_report: "PROPERTY_VALUE_CHANGE",
    transaction_notification: "TRANSACTION_MILESTONE", transaction_communication: "TRANSACTION_MILESTONE", transaction_parties_notice: "TRANSACTION_MILESTONE",
    closing_concierge: "TRANSACTION_MILESTONE", cda: "TRANSACTION_MILESTONE", lender_status_request: "TRANSACTION_MILESTONE",
    showing_reminder_transactional: "TRANSACTION_MILESTONE", cooperating_agent_copy_transactional: "TRANSACTION_MILESTONE", offer_net_sheet: "TRANSACTION_MILESTONE",
    agent_client_message: "HUMAN_REQUESTED", inbox: "HUMAN_REQUESTED", inbox_reply: "HUMAN_REQUESTED", universal_inbox_reply: "HUMAN_REQUESTED",
    communications: "HUMAN_REQUESTED", text_command: "HUMAN_REQUESTED", phone_test_call: "HUMAN_REQUESTED",
    billing_lifecycle: "SUBSCRIPTION_LIFECYCLE",
    social_publisher: "SCHEDULED_CONTENT_PUBLISH",
    open_house_feedback_request: "SERVICE_NOTICE", open_house_weather_alert: "SERVICE_NOTICE", credit_copilot: "SERVICE_NOTICE", listing_appointment: "SERVICE_NOTICE",
    web_push: "STAFF_ALERT", lead_magnet_notify: "STAFF_ALERT", queue_drain: "STAFF_ALERT",
  },
  system_source_prefix: {
    vendor_: "SERVICE_NOTICE",
    platform_: "SUBSCRIPTION_LIFECYCLE",
    "lifecycle:": "LIFETIME_TOUCH",
  },
  nba_plan: {
    due: "NURTURE_TOUCH", convert_on_callback: "CONVERSATION_RESPONSE",
    interval_not_elapsed: "WAIT_COOLDOWN", appointment_scheduled: "WAIT_COOLDOWN", recently_contacted: "WAIT_COOLDOWN",
    quiet_hours: "WAIT_COOLDOWN", postponed: "WAIT_COOLDOWN",
    blocked_lifecycle: "NO_ACTION_NEEDED", max_touches_reached: "NO_ACTION_NEEDED", no_permitted_channel: "NO_ACTION_NEEDED",
    plan_complete: "NO_ACTION_NEEDED", duplicate: "NO_ACTION_NEEDED", outreach_paused: "NO_ACTION_NEEDED",
    agent_handling: "NO_ACTION_NEEDED", dead_end: "NO_ACTION_NEEDED",
  },
  action_prefix: {
    "ai.tool.": "CONVERSATION_RESPONSE",
    "marketing.social.": "SCHEDULED_CONTENT_PUBLISH",
  },
} as const satisfies Record<string, Record<string, ActionReasonCode>>

type ReasonVocabulary = keyof typeof REASON_CODE_MAP

/** Map one spelling from a named vocabulary onto the canonical set. Prefix vocabularies match by
 *  `startsWith`. Unmapped → null (the caller decides; the ledger records UNSPECIFIED). */
/** @proofSeam exported so scripts/action-ledger-guard.ts asserts the NBA map against the verdicts and runs the chokepoint census through the SAME table the ledger resolves with. */
export function canonicalReasonCode(vocabulary: ReasonVocabulary, spelling: string | null | undefined): ActionReasonCode | null {
  if (!spelling) return null
  const table = REASON_CODE_MAP[vocabulary] as Readonly<Record<string, ActionReasonCode>>
  if (vocabulary === "system_source_prefix" || vocabulary === "action_prefix") {
    for (const [prefix, code] of Object.entries(table)) if (spelling.startsWith(prefix)) return code
    return null
  }
  return Object.prototype.hasOwnProperty.call(table, spelling) ? table[spelling] : null
}

/** The WHY a ledger row records: explicit valid code → systemSource → its prefix family → the
 *  action's own family → UNSPECIFIED. Deterministic; no model decides it. */
function resolveReasonCode(ctx: Pick<ActionContext, "reasonCode" | "systemSource" | "action">): ActionReasonCode {
  const explicit = normalizeReasonCode(ctx.reasonCode)
  if (explicit !== "UNSPECIFIED") return explicit
  return canonicalReasonCode("system_source", ctx.systemSource)
    ?? canonicalReasonCode("system_source_prefix", ctx.systemSource)
    ?? canonicalReasonCode("action_prefix", ctx.action)
    ?? "UNSPECIFIED"
}

// ─── THE AI ISA IS A SYSTEM ACTOR (wave 100A; owner: "isa is a system ai isa") ──────────────
/** The governed manager key every AI-ISA action is attributed to (lib/kernel/manager-registry.ts). */
const AI_ISA_MANAGER_KEY = "ai_isa"

/**
 * True when a sender's `systemSource` says the AI ISA is the one acting — the `ai_isa*` family (the
 * convention lib/providers/dispatch.ts already uses for compliance `actorType`), ghost recovery, and
 * the lead plan. The dispatch / voice chokepoints use it to name the ISA as the ACTOR without arming
 * the autonomy gate (that stays keyed to SYSTEM_SOURCE_TO_MANAGER, lib/managers/autonomy-gate.ts) —
 * so an unattended ISA SMS never lands on the human agent whose contact it was.
 */
export function isAiIsaSystemSource(systemSource: string | null | undefined): boolean {
  return !!systemSource && (/(^|_)ai_isa(_|$)/.test(systemSource) || systemSource === "ghost_recovery" || systemSource === "lead_action_plan")
}

/**
 * WHO a ledger row names. An AI-ISA action (actor manager `ai_isa`) is attributed to the ISA's
 * SYSTEM identity — `brokerages.ai_isa_system_user_id` (users.platform_role 'ai_isa_system',
 * lib/auth/isa-actor.ts) or null when the brokerage has none — NEVER to the human whose record or
 * session it ran beside. That human, if any, is kept as `detail.on_behalf_of_user_id` (context,
 * not credit). A HUMAN acting (actor `user` / `agent`, including a human approving an ISA draft)
 * keeps the human. Pure.
 */
/** @proofSeam exported so scripts/action-ledger-guard.ts asserts the ISA → system actor rule and the human-keeps-human control on the pure function directly. */
export function attributedActor(
  actor: ActionContext["actor"],
  isaSystemUserId: string | null,
): { actor: ActionContext["actor"]; onBehalfOfUserId: string | null } {
  if (actor.type !== "manager" || actor.managerKey !== AI_ISA_MANAGER_KEY) return { actor, onBehalfOfUserId: null }
  const human = actor.userId && actor.userId !== isaSystemUserId ? actor.userId : null
  return { actor: { type: "manager", managerKey: AI_ISA_MANAGER_KEY, userId: isaSystemUserId, agentId: null }, onBehalfOfUserId: human }
}

/** The ISA's system user for a brokerage through the ONE resolver (lib/auth/isa-actor.ts
 *  getIsaSystemUserIdCached), on the ledger's own client. A thrown / refused read → null: the row
 *  then names no user — never a human. */
async function isaSystemUserIdFor(svc: LedgerClient, brokerageId: string): Promise<string | null> {
  try {
    return await getIsaSystemUserIdCached(svc as unknown as SupabaseClient, brokerageId)
  } catch {
    return null
  }
}

/** The insert-ready actor columns + the on-behalf-of context for one ledger row. */
async function ledgerActorFor(svc: LedgerClient, ctx: ActionContext): Promise<ActionContext> {
  if (ctx.actor.type !== "manager" || ctx.actor.managerKey !== AI_ISA_MANAGER_KEY) return ctx
  const { actor, onBehalfOfUserId } = attributedActor(ctx.actor, await isaSystemUserIdFor(svc, ctx.brokerageId))
  return { ...ctx, actor, detail: onBehalfOfUserId ? { ...(ctx.detail ?? {}), on_behalf_of_user_id: onBehalfOfUserId } : ctx.detail }
}

/** `domain.entity.action`, lowercase snake segments — the naming rule for NEW actions and events
 *  (m687 CHECK agent_action_ledger_action_format_check enforces the same shape). */
const ACTION_NAME_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

/** Deterministic idempotency key: tenant + subject + action + cycle. The cycle is the caller's
 *  unit of "once" (a deadline id + day, a campaign step id, a sweep date) — the ledger cannot
 *  invent it, which is why a send with no cycle is recorded but not de-duplicated. */
function actionIdempotencyKey(k: {
  brokerageId: string
  subjectType: string
  subjectId: string
  action: string
  cycle: string
}): string {
  return [k.brokerageId, k.subjectType, k.subjectId, k.action, k.cycle].map((s) => String(s).trim()).join(":")
}

/** A provider that did not answer — the message may or may not have left. Never retried blindly. */
function isTimeoutLike(message: string | null | undefined): boolean {
  return !!message && /timed?[\s-]?out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|AbortError|aborted|socket hang up|504|gateway timeout/i.test(message)
}

/** Error codes that mean "m687 is not applied yet" — degrade, do not fail. */
function isSchemaAbsent(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false
  return ["42P01", "PGRST205", "PGRST204", "42703"].includes(err.code ?? "")
}

let warnedAbsent = false
function warnAbsentOnce(where: string, err: { code?: string; message?: string }): void {
  if (warnedAbsent) return
  warnedAbsent = true
  console.warn(`[action-ledger] ${where}: ledger not deployed (m687 not applied?) — proceeding unledgered:`, err.code, err.message)
}

// ─── types ────────────────────────────────────────────────────────────────────

/** Structural subset of a supabase-js client — the seam the proof drives with a fake. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LedgerClient = { from: (table: string) => any }

export interface ActionContext {
  /** The VERIFIED tenant (the dispatcher's caller-verified brokerageId / the session's). */
  brokerageId: string
  action: string
  actor: { type: ActionActorType; userId?: string | null; agentId?: string | null; managerKey?: string | null }
  subject: { type: string; id?: string | null; ref?: string | null }
  reasonCode?: string | null
  reasonDetail?: string | null
  /** Explicit key wins; otherwise derived from `cycle` when the subject has an id. */
  idempotencyKey?: string | null
  cycle?: string | null
  causationId?: string | null
  correlationId?: string | null
  channel?: string | null
  /** Blueprint tool risk class (READ / LOW_RISK_WRITE / COMMUNICATION / FINANCIAL / LEGAL /
   *  IRREVERSIBLE — the vocabulary lives at lib/ai-isa/persona-tool-policy.ts ToolRiskClass). */
  riskClass?: string | null
  systemSource?: string | null
  detail?: Record<string, unknown> | null
}

export interface LedgerEntry {
  id: string
  status: ActionStatus
  attempts: number
  outcome: string | null
  provider: string | null
  provider_ref: string | null
  idempotency_key: string | null
}

export type ClaimResult =
  | { kind: "claimed"; id: string; idempotencyKey: string | null }
  | { kind: "replay"; entry: LedgerEntry }
  | { kind: "unknown"; entry: LedgerEntry }
  | { kind: "in_flight"; entry: LedgerEntry | null }
  | { kind: "refused"; error: string }
  | { kind: "unledgered"; reason: string }

export interface Settlement {
  status: Exclude<ActionStatus, "proposed">
  outcome: string
  provider?: string | null
  providerRef?: string | null
  costUsd?: number | null
  error?: string | null
}

const ENTRY_COLS = "id, status, attempts, outcome, provider, provider_ref, idempotency_key"

function resolveIdempotencyKey(ctx: ActionContext): string | null {
  if (ctx.idempotencyKey && ctx.idempotencyKey.trim()) return ctx.idempotencyKey.trim()
  if (ctx.cycle && ctx.cycle.trim() && ctx.subject.id) {
    return actionIdempotencyKey({
      brokerageId: ctx.brokerageId, subjectType: ctx.subject.type, subjectId: ctx.subject.id,
      action: ctx.action, cycle: ctx.cycle,
    })
  }
  return null
}

/**
 * The ONE insert into agent_action_ledger. The row literal sits inside the `.insert({...})` call so the
 * column censuses (opposite-missing, readerless-writes) can see every column this module writes —
 * a builder that RETURNED the object hid them, and the ledger read as written-by-nobody.
 */
async function insertLedgerRow(
  svc: LedgerClient, raw: ActionContext, status: ActionStatus, key: string | null, extra: Record<string, unknown> = {},
): Promise<{ data: { id?: string } | null; error: { code?: string; message?: string } | null }> {
  const scope = currentCausation()
  const ctx = await ledgerActorFor(svc, raw)
  const reasonCode = resolveReasonCode(ctx)
  const write = async (code: ActionReasonCode, detailNote: string | null): Promise<{ data: { id?: string } | null; error: { code?: string; message?: string } | null }> => {
    const { data, error } = await svc.from("agent_action_ledger").insert({
    brokerage_id: ctx.brokerageId,
    action: ctx.action,
    channel: ctx.channel ?? null,
    actor_type: ctx.actor.type,
    actor_user_id: ctx.actor.userId ?? null,
    actor_agent_id: ctx.actor.agentId ?? null,
    actor_manager_key: ctx.actor.managerKey ?? null,
    subject_type: ctx.subject.type,
    subject_id: ctx.subject.id ?? null,
    subject_ref: ctx.subject.ref ?? null,
    reason_code: code,
    reason_detail: detailNote ? `${detailNote}${ctx.reasonDetail ? ` ${ctx.reasonDetail}` : ""}`.slice(0, 1000) : ctx.reasonDetail ?? null,
    idempotency_key: key,
    status,
    risk_class: ctx.riskClass ?? null,
    system_source: ctx.systemSource ?? null,
    causation_id: ctx.causationId ?? scope.causationId,
    correlation_id: ctx.correlationId ?? scope.correlationId,
    detail: ctx.detail ?? {},
    ...extra,
    }).select("id").single()
    // Read, not swallowed: the caller (claim / non-action) decides degrade vs fail-closed on it.
    return { data: (data as { id?: string } | null) ?? null, error: error ?? null }
  }
  const first = await write(reasonCode, null)
  // A code the LIVE reason_code CHECK does not know yet (a code whose widening migration is not applied yet) is refused
  // 23514 — that is a vocabulary lag, not a reason to drop the record or fail a send closed.
  // Record it once more as UNSPECIFIED with the intended code named in reason_detail.
  if (first.error?.code === "23514" && /reason_code/.test(first.error.message ?? "") && reasonCode !== "UNSPECIFIED") {
    return await write("UNSPECIFIED", `[intended ${reasonCode}; CHECK not widened]`)
  }
  return first
}

// ─── claim / settle ───────────────────────────────────────────────────────────

/** Open the row (status 'proposed') BEFORE acting. Never throws. */
async function claimAction(ctx: ActionContext, opts?: { client?: LedgerClient }): Promise<ClaimResult> {
  const key = resolveIdempotencyKey(ctx)
  // A malformed action name is a programmer error the m687 CHECK would refuse (23514) — say so
  // here and record nothing, rather than let the refusal look like an outage.
  if (!ACTION_NAME_PATTERN.test(ctx.action)) {
    console.error(`[action-ledger] '${ctx.action}' is not domain.entity.action — not ledgered`)
    return { kind: "unledgered", reason: "invalid action name" }
  }
  try {
    const svc = opts?.client ?? createServiceClient()
    const { data, error } = await insertLedgerRow(svc, ctx, "proposed", key)
    if (!error && data?.id) return { kind: "claimed", id: data.id as string, idempotencyKey: key }
    if (error && isSchemaAbsent(error)) {
      warnAbsentOnce("claim", error)
      return { kind: "unledgered", reason: `${error.code}: ${error.message}` }
    }
    if (error?.code === "23505" && key) return await rereadWinner(svc, key)
    const msg = error?.message ?? "claim returned no row"
    console.error("[action-ledger] claim refused:", error?.code, msg)
    // Fail CLOSED only where at-most-once was asked for; a recording-only claim must not
    // take the channel down with it.
    return key ? { kind: "refused", error: `Action ledger refused the claim (${msg}) — not sending without idempotency` }
               : { kind: "unledgered", reason: msg }
  } catch (e) {
    const msg = (e as Error).message
    console.error("[action-ledger] claim threw:", msg)
    return key ? { kind: "refused", error: `Action ledger unavailable (${msg})` } : { kind: "unledgered", reason: msg }
  }
}

/** The 23505 loser: re-read the WINNER and decide from its status. */
async function rereadWinner(svc: LedgerClient, key: string): Promise<ClaimResult> {
  const { data: winner, error } = await svc.from("agent_action_ledger").select(ENTRY_COLS).eq("idempotency_key", key).maybeSingle()
  if (error || !winner) return { kind: "refused", error: `Idempotency key raced and the winner could not be re-read: ${error?.message ?? "no row"}` }
  const entry = winner as LedgerEntry
  if (entry.status === "executed") return { kind: "replay", entry }
  if (entry.status === "unknown") return { kind: "unknown", entry }
  if (entry.status === "proposed") return { kind: "in_flight", entry }
  // failed / skipped: nothing left the building — re-claim, guarded on the status+attempts we
  // read so two retries cannot both win. COUNT the rows (an UPDATE matching nothing resolves too).
  const { data: reclaimed, error: upErr } = await svc
    .from("agent_action_ledger")
    .update({ status: "proposed", attempts: (entry.attempts ?? 1) + 1, updated_at: new Date().toISOString(), settled_at: null })
    .eq("idempotency_key", key)
    .eq("status", entry.status)
    .eq("attempts", entry.attempts ?? 1)
    .select("id")
  if (upErr) return { kind: "refused", error: `Re-claim refused: ${upErr.message}` }
  if (!Array.isArray(reclaimed) || reclaimed.length !== 1) return { kind: "in_flight", entry }
  return { kind: "claimed", id: reclaimed[0].id as string, idempotencyKey: key }
}

/** Close the row with what happened. Never throws; a settle that matched nothing is said. */
async function settleAction(id: string, s: Settlement, opts?: { client?: LedgerClient }): Promise<{ ok: boolean; error?: string }> {
  try {
    const svc = opts?.client ?? createServiceClient()
    const now = new Date().toISOString()
    const { data, error } = await svc
      .from("agent_action_ledger")
      .update({
        status: s.status,
        outcome: s.outcome,
        provider: s.provider ?? null,
        provider_ref: s.providerRef ?? null,
        cost_usd: s.costUsd ?? null,
        error: s.error ?? null,
        settled_at: now,
        updated_at: now,
      })
      .eq("id", id)
      .select("id")
    if (error) {
      console.error("[action-ledger] settle refused:", error.code, error.message)
      return { ok: false, error: error.message }
    }
    if (!Array.isArray(data) || data.length !== 1) {
      console.error(`[action-ledger] settle matched ${Array.isArray(data) ? data.length : 0} rows for ${id}`)
      return { ok: false, error: "settle matched no row" }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Record a decision NOT to act — "wait" or "do nothing" — as a first-class ledger row
 * (status 'skipped', outcome the decision, with its reason). The action name is
 * `<domain>.decision.wait|do_nothing`. Never throws.
 */
export async function recordNonAction(
  ctx: Omit<ActionContext, "action"> & { decision: "wait" | "do_nothing"; domain?: string; until?: string | null },
  opts?: { client?: LedgerClient },
): Promise<{ recorded: boolean; id?: string; error?: string }> {
  const action = `${ctx.domain ?? "agent"}.decision.${ctx.decision}`
  const full: ActionContext = { ...ctx, action, detail: { ...(ctx.detail ?? {}), ...(ctx.until ? { until: ctx.until } : {}) } }
  try {
    const svc = opts?.client ?? createServiceClient()
    const { data, error } = await insertLedgerRow(svc, full, "skipped", resolveIdempotencyKey(full), { outcome: ctx.decision, settled_at: new Date().toISOString() })
    if (error) {
      if (isSchemaAbsent(error)) {
        warnAbsentOnce("non-action", error)
        return { recorded: false } // not deployed yet — degrade quietly, the decision still stands
      }
      if (error.code !== "23505") console.error("[action-ledger] non-action refused:", error.code, error.message)
      // 23505: this decision was already recorded for this cycle — that is the idempotency working.
      return { recorded: error.code === "23505", error: error.message }
    }
    return { recorded: true, id: data?.id as string }
  } catch (e) {
    return { recorded: false, error: (e as Error).message }
  }
}

// ─── the wrapper the chokepoints use ──────────────────────────────────────────

export type NonActingClaim = Exclude<ClaimResult, { kind: "claimed" } | { kind: "unledgered" }>

/**
 * Claim → act → settle. `run` executes only for a fresh claim (or an unledgered degrade);
 * a replay / unknown / in-flight / refused claim returns `hooks.replay(claim)` WITHOUT acting.
 * A thrown `run` is settled (timeout-like → 'unknown', otherwise 'failed') and rethrown.
 */
export async function withActionLedger<T>(
  ctx: ActionContext,
  run: () => Promise<T>,
  hooks: { settle: (result: T) => Settlement; replay: (claim: NonActingClaim) => T },
  opts?: { client?: LedgerClient },
): Promise<T> {
  const claim = await claimAction(ctx, opts)
  if (claim.kind !== "claimed" && claim.kind !== "unledgered") return hooks.replay(claim)
  const id = claim.kind === "claimed" ? claim.id : null
  let result: T
  try {
    result = await run()
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    if (id) {
      const timedOut = isTimeoutLike(msg)
      await settleAction(id, { status: timedOut ? "unknown" : "failed", outcome: timedOut ? "provider_timeout" : "threw", error: msg }, opts)
    }
    throw e
  }
  if (id) await settleAction(id, hooks.settle(result), opts)
  return result
}

// ─── dispatch adapters (lib/providers/dispatch.ts) ────────────────────────────

export interface DispatchLike {
  success: boolean
  providerKey: string
  messageId?: string
  error?: string
}

/** The provider key every refusal the ledger itself issues carries (a `*_gate`, like the others). */
const ACTION_LEDGER_GATE_KEY = "action_ledger_gate"

/** A DispatchResult → what the ledger records. A `*_gate` refusal is 'skipped' (nothing was sent;
 *  a later cycle may send), a timeout is 'unknown', any other failure 'failed'. */
export function settleDispatchResult(r: DispatchLike, costUsd: number | null): Settlement {
  if (r.success) return { status: "executed", outcome: "accepted", provider: r.providerKey, providerRef: r.messageId ?? null, costUsd }
  if (/_gate$/.test(r.providerKey)) return { status: "skipped", outcome: r.providerKey, error: r.error ?? null }
  if (isTimeoutLike(r.error)) return { status: "unknown", outcome: "provider_timeout", provider: r.providerKey, error: r.error ?? null }
  return { status: "failed", outcome: "provider_error", provider: r.providerKey, error: r.error ?? null }
}

/** A non-acting claim → the DispatchResult the caller receives. Only an executed winner reads as
 *  success (the message DID go — once); everything else is a refusal that says why. */
export function replayDispatchResult(claim: NonActingClaim): DispatchLike {
  switch (claim.kind) {
    case "replay":
      return { success: true, providerKey: claim.entry.provider ?? ACTION_LEDGER_GATE_KEY, messageId: claim.entry.provider_ref ?? undefined }
    case "unknown":
      return { success: false, providerKey: ACTION_LEDGER_GATE_KEY, error: "An earlier attempt's outcome is unknown (the provider did not answer) — not retried; reconcile it first" }
    case "in_flight":
      return { success: false, providerKey: ACTION_LEDGER_GATE_KEY, error: "An identical action is already in flight" }
    case "refused":
      return { success: false, providerKey: ACTION_LEDGER_GATE_KEY, error: claim.error }
  }
}

// ─── AI tool calls (wave 98, lane 98B) ────────────────────────────────────────
// No tool-execution wrapper existed: each surface mounts an AI SDK tool registry and the model
// calls `execute` directly. This is the ONE wrapper, applied where a registry is assembled with
// its tenant known (lib/ai-isa/customer-context-tools.ts buildCustomerFreeTools — every
// customer-facing surface spreads it). Only the consequential classes are ledgered —
// COMMUNICATION and FINANCIAL (lib/ai-isa/persona-tool-policy.ts riskClassForTool); a READ or a
// LOW_RISK_WRITE is not an external action. The tool call id (AI SDK `options.toolCallId`) is the
// cycle, so a retried step of the SAME call is at-most-once.

/** The risk classes whose tool calls leave a ledger row. */
const LEDGERED_TOOL_RISK = new Set(["COMMUNICATION", "FINANCIAL"])

/** A tool result reads as a failure when it says so (`success: false` / `error`). */
function settleToolResult(r: unknown): Settlement {
  const o = (r && typeof r === "object") ? r as { success?: unknown; error?: unknown } : null
  if (o && (o.success === false || (typeof o.error === "string" && o.error && o.success !== true))) {
    const msg = typeof o.error === "string" ? o.error : "tool reported failure"
    return isTimeoutLike(msg) ? { status: "unknown", outcome: "provider_timeout", error: msg } : { status: "failed", outcome: "tool_failed", error: msg }
  }
  return { status: "executed", outcome: "tool_completed" }
}

/**
 * Wrap every COMMUNICATION / FINANCIAL tool in `registry` so each call is claimed → run → settled
 * on agent_action_ledger (action `ai.tool.<name>`). Other tools are returned untouched. A replayed
 * / in-flight / unknown claim returns a refusal object the model can read — it never re-executes.
 */
export function ledgerToolExecutions<T extends Record<string, unknown>>(
  registry: T,
  ctx: {
    brokerageId: string
    subject: { type: string; id?: string | null }
    riskClassOf: (toolName: string) => string
    actor?: ActionContext["actor"]
    surface?: string
  },
  opts?: { client?: LedgerClient },
): T {
  const out: Record<string, unknown> = {}
  for (const [name, t] of Object.entries(registry)) {
    const risk = ctx.riskClassOf(name)
    const exec = (t as { execute?: unknown } | null)?.execute
    if (!LEDGERED_TOOL_RISK.has(risk) || typeof exec !== "function" || !/^[a-z][a-z0-9_]*$/.test(name)) { out[name] = t; continue }
    out[name] = {
      ...(t as object),
      execute: (args: unknown, options?: { toolCallId?: string }) => withActionLedger<unknown>(
        {
          brokerageId: ctx.brokerageId,
          action: `ai.tool.${name}`,
          channel: "ai_tool",
          actor: ctx.actor ?? { type: "system" },
          subject: ctx.subject,
          riskClass: risk,
          systemSource: ctx.surface ?? null,
          cycle: options?.toolCallId ?? null,
          detail: { tool: name },
        },
        () => Promise.resolve((exec as (a: unknown, o?: unknown) => unknown)(args, options)),
        {
          settle: settleToolResult,
          replay: (claim) => ({
            success: claim.kind === "replay",
            error: claim.kind === "replay" ? undefined : `This exact tool call was already ${claim.kind === "unknown" ? "attempted and its outcome is unknown" : claim.kind === "in_flight" ? "in progress" : "refused"} — not repeated.`,
          }),
        },
        opts,
      ),
    }
  }
  return out as T
}

// ─── flight recorder: the causal chain ────────────────────────────────────────

export interface ChainEvent {
  id: string
  event_type: string
  entity_type: string
  entity_id: string
  created_at: string
  causation_id?: string | null
  correlation_id?: string | null
}
export interface ChainAction {
  id: string
  action: string
  status: string
  reason_code: string
  reason_detail?: string | null
  outcome?: string | null
  subject_type: string
  subject_id?: string | null
  actor_type: string
  actor_manager_key?: string | null
  created_at: string
  settled_at?: string | null
  error?: string | null
  actor_user_id?: string | null
  actor_agent_id?: string | null
  subject_ref?: string | null
  risk_class?: string | null
  system_source?: string | null
  cost_usd?: number | string | null
  detail?: Record<string, unknown> | null
  causation_id?: string | null
  correlation_id?: string | null
}
export interface ChainLink {
  kind: "event" | "action"
  id: string
  at: string
  name: string
  causationId: string | null
  correlationId: string | null
  status?: string
  reasonCode?: string
  outcome?: string | null
  /** When the provider's result settled the row (the unknown-settler or the send itself), and why it failed. */
  settledAt?: string | null
  error?: string | null
  /** Who acted (manager key, else user/agent id), what it cost, its risk class and where it came from. */
  actor?: string | null
  costUsd?: number | null
  riskClass?: string | null
  source?: string | null
  subjectRef?: string | null
  detail?: Record<string, unknown> | null
  /** For an action: the event chain that caused it, ROOT first ("why did the AI send this?"). */
  because?: string[]
}

/** Merge events + ledger rows into one time-ordered chain; explain each action by walking its
 *  causation upward (cycle-guarded, depth-capped). Pure — the proof drives it directly. */
export function assembleCausalChain(events: ChainEvent[], actions: ChainAction[]): ChainLink[] {
  const byId = new Map<string, ChainEvent>()
  for (const e of events) byId.set(e.id, e)
  const ancestry = (start: string | null | undefined): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    let cur = start ?? null
    while (cur && !seen.has(cur) && out.length < 25) {
      seen.add(cur)
      const ev = byId.get(cur)
      if (!ev) break
      out.unshift(ev.event_type)
      cur = ev.causation_id ?? null
    }
    return out
  }
  const links: ChainLink[] = [
    ...[...byId.values()].map((e): ChainLink => ({
      kind: "event", id: e.id, at: e.created_at, name: e.event_type,
      causationId: e.causation_id ?? null, correlationId: e.correlation_id ?? null,
      because: ancestry(e.causation_id),
    })),
    ...actions.map((a): ChainLink => ({
      kind: "action", id: a.id, at: a.created_at, name: a.action,
      causationId: a.causation_id ?? null, correlationId: a.correlation_id ?? null,
      status: a.status, reasonCode: a.reason_code, outcome: a.outcome ?? null,
      settledAt: a.settled_at ?? null, error: a.error ?? null,
      actor: a.actor_manager_key ?? a.actor_agent_id ?? a.actor_user_id ?? null,
      costUsd: a.cost_usd == null ? null : Number(a.cost_usd), riskClass: a.risk_class ?? null,
      source: a.system_source ?? null, subjectRef: a.subject_ref ?? null, detail: a.detail ?? null,
      because: ancestry(a.causation_id),
    })),
  ]
  return links.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.kind === y.kind ? 0 : x.kind === "event" ? -1 : 1))
}
