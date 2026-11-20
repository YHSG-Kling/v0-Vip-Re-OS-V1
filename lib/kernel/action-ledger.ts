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
import { formatPolicyRef, resolvePolicyRef } from "@/lib/kernel/tenant-policy"
import { redactSecretValues } from "@/lib/security/export-credential-scan"


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
  // m709 (wave 104C): the controlled-learning loop promoted / rolled back one of its own proposals
  // under the autonomy gate (lib/kernel/improvement-proposals.ts); a human's promotion is HUMAN_REQUESTED.
  "LEARNED_IMPROVEMENT",
  // m710 (wave 104D): a mission created / moved by the state machine (lib/kernel/missions.ts) —
  // the WHY of the transition rides reason_detail, the mission id rides detail.mission_id.
  "MISSION_LIFECYCLE",
  // m729 (wave 108C): the OS health supervisor (lib/kernel/os-health.ts) recovered, routed, halted or
  // escalated an operational incident — the incident class + recovery ride detail, the WHY reason_detail.
  "OS_HEALTH_RECOVERY",
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
  /**
   * WHICH POLICY PERMITTED (wave 102, lane 102D; LAW 5) — the registered tenant policy key this
   * action ran under (`autonomy_tier:<manager>` for an autonomous send, `experiments` for an
   * experiment arm, `authority_level:ai_isa` for an AI tool call). The row records it as
   * `policy_key@version` (policy_ref, m700); the version is lib/kernel/tenant-policy.ts
   * currentPolicyVersion unless the caller already holds it (`policyVersion`).
   */
  policyKey?: string | null
  policyVersion?: number | null
  /**
   * WAVE 155 (lane 155B3, directive §B3) — the decision contract's facts, OPTIONAL and additive. Set by the BOUNDARY that knows
   * them, never by a model. Present facts are normalized onto `detail.governance` (decisionContractFacts) on the SAME insert — no
   * extra round trip. An unmapped spelling reads null and is named in `contract_findings`.
   */
  trustClass?: string | null
  /** The facts / versions the decision READ (dependency fingerprint is a digest over this set). */
  dependencies?: Array<{ type: string; id?: string | null; version?: string | number | null }> | null
  approvalBasis?: string | null
  /** When the DECISION stops being valid (an expired decision does not execute — sinkRule). */
  expiresAt?: string | null
  nextTrigger?: NextTriggerInput | null
  /** Sink-rule inputs only the boundary may supply (ledgerToolCall / ledgerToolExecutions read them; never persisted verbatim). */
  sink?: {
    verification?: VerificationInput | null
    /** A target manager the MODEL named (data) — checked against `allowedManagers`, never trusted. */
    proposedTargetManager?: string | null
    allowedManagers?: readonly string[] | null
    /** The model's own fields (e.g. "approved: true") — recorded for audit, NEVER read by the rule. */
    modelClaims?: Record<string, unknown> | null
  } | null
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
  /** WAVE 155 (155B3): a settle that learns the verdict (a spend envelope, a gate) may write the row's FULL detail on the SAME update
   *  (no extra round trip). The caller passes the whole detail — it replaces, never merges. Absent = detail untouched. */
  detail?: Record<string, unknown> | null
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
  // 102D — `policy_key@version` from the ONE version reader; a refused version read records `@unknown`.
  const policyRef = ctx.policyKey
    ? (ctx.policyVersion !== undefined ? formatPolicyRef(ctx.policyKey, ctx.policyVersion) : await resolvePolicyRef(svc, ctx.brokerageId, ctx.policyKey))
    : null
  const write = async (code: ActionReasonCode, detailNote: string | null, withPolicyColumn = true): Promise<{ data: { id?: string } | null; error: { code?: string; message?: string } | null }> => {
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
    // Before m700 the column is absent (PGRST204 / 42703): the row is re-written WITHOUT it and the
    // ref rides detail.policy_ref — the action stays ledgered, the evidence stays.
    // Audit sink: a secret by name or shape never lands in the ledger detail (wave 139E).
    // WAVE 155 (155B3): the context's decision-contract facts ride detail.governance on this same insert (decisionContractFacts).
    detail: redactSecretValues(withContractFacts(ctx, withPolicyColumn || !policyRef ? (ctx.detail ?? {}) : { ...(ctx.detail ?? {}), policy_ref: policyRef })),
    ...(withPolicyColumn ? { policy_ref: policyRef } : {}),
    ...extra,
    }).select("id").single()
    // Read, not swallowed: the caller (claim / non-action) decides degrade vs fail-closed on it.
    return { data: (data as { id?: string } | null) ?? null, error: error ?? null }
  }
  let first = await write(reasonCode, null)
  if (first.error && isSchemaAbsent(first.error) && /policy_ref/.test(first.error.message ?? "")) {
    first = await write(reasonCode, null, false)
  }
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
  // A malformed action name is a programmer error the m687 CHECK would refuse (23514). It used to
  // degrade to "unledgered" — the action RAN with no evidence row and no once-per-cycle protection,
  // and only a console line said so (wave 146: `strategy.activate`, `life_change.respond` and four
  // more ran that way for weeks). A gate that cannot run must refuse (CLAUDE.md §4): the claim is
  // REFUSED, `withActionLedger` returns the caller's replay value without acting, and
  // scripts/action-ledger-guard.ts §14 catches the name before it ships.
  if (!ACTION_NAME_PATTERN.test(ctx.action)) {
    console.error(`[action-ledger] '${ctx.action}' is not domain.entity.action — REFUSED (the action did not run)`)
    return { kind: "refused", error: `Action name '${ctx.action}' is not domain.entity.action` }
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
    // Audit sink (wave 139E) on the settle path too: a secret never lands in the detail a settle writes.
    const settledDetail = s.detail ? redactSecretValues(s.detail) : null
    const { data, error } = await svc
      .from("agent_action_ledger")
      .update({
        status: s.status,
        outcome: s.outcome,
        provider: s.provider ?? null,
        provider_ref: s.providerRef ?? null,
        cost_usd: s.costUsd ?? null,
        error: s.error ?? null,
        ...(settledDetail ? { detail: settledDetail } : {}),
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
 * Record a DECISION as a first-class ledger row (status 'skipped', outcome the verdict, with its
 * reason). The action name is `<domain>.decision.<verdict>`. Never throws.
 *   · wait / do_nothing — the decision NOT to act (lane 98B);
 *   · send_touch / convert — the ACTING verdict (wave 102C, owner answer 3): the decision row and
 *     the act are two rows. The act itself is ledgered by its chokepoint (dispatch / voice /
 *     conversion) as 'executed'; this row stays 'skipped' so lib/intelligence/roi-ledger.ts's
 *     "executed" attribution rule never counts a verdict as a touch — only its wait / do_nothing
 *     siblings are attribution-eligible (DECISION_ACTION there), and that rule is unchanged.
 */
export async function recordNonAction(
  ctx: Omit<ActionContext, "action"> & { decision: "wait" | "do_nothing" | "send_touch" | "convert"; domain?: string; until?: string | null },
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

/** A non-acting claim, said to the model as a refusal it can read — the tool never re-executes. */
function toolReplay(claim: NonActingClaim): { success: boolean; error?: string } {
  return {
    success: claim.kind === "replay",
    error: claim.kind === "replay" ? undefined : `This exact tool call was already ${claim.kind === "unknown" ? "attempted and its outcome is unknown" : claim.kind === "in_flight" ? "in progress" : "refused"} — not repeated.`,
  }
}

/**
 * WAVE 152 (lane 152I — LAW 5 at the voice tool boundary): ONE consequential tool call made OUTSIDE an AI SDK registry (the
 * ElevenLabs tool webhook, app/api/agent-assistant/tool-call/route.ts) is claimed → run → settled on agent_action_ledger with the
 * SAME settle / replay rules as ledgerToolExecutions below. The caller's `cycle` is its unit of once (the released hold id), so a
 * replayed or racing confirm of one read-back executes at most once.
 */
export function ledgerToolCall<T>(ctx: ActionContext, run: () => Promise<T>, opts?: { client?: LedgerClient; now?: Date }): Promise<T | SinkRefusal | { success: boolean; error?: string }> {
  // WAVE 155 (155B3, directive §B3 / D 152): the sink rule decides BEFORE the claim — pure, no model, no I/O. A permitted call
  // takes exactly the round trips it took before (claim + settle); a refusal writes ONE decision row and returns typed feedback.
  const verdict = sinkVerdictFor(ctx, opts?.now)
  if (verdict.decision !== "ALLOW") return refuseAtSink(ctx, verdict, opts)
  return withActionLedger<T | { success: boolean; error?: string }>(ctx, run, { settle: settleToolResult, replay: toolReplay }, opts)
}

/**
 * WAVE 155 (lane 155B3 — integrator addendum, for the batch-2 repair lanes): ONE wrapper for a USER-INITIATED write (a server
 * action / a session route) — claim → run → settle on agent_action_ledger with the SAME result-reading rule the tool wrapper uses
 * (settleToolResult) and a typed refusal on replay (toolReplay — the run is never called twice). It sets nothing the caller did not
 * pass, except the trust class: `authorized_human` ONLY when the actor is a user with a userId (a session write is not model output).
 * The tenant is `ctx.brokerageId` exactly as passed — the caller resolves it from the session (CLAUDE.md §4). A two-segment action
 * name is REFUSED by the claim (ACTION_NAME_PATTERN) and comes back as the typed refusal. Round trips: claim + settle, nothing more;
 * an absent ledger degrades exactly as withActionLedger does. Not a model door: the sink rule stays on ledgerToolCall /
 * ledgerToolExecutions, where a model proposes.
 * @proofSeam scripts/arbiter-decision-contract-guard.ts §G drives it; the batch-2 repair lanes are its callers.
 */
export function ledgerSessionAction<T>(ctx: ActionContext, run: () => Promise<T>, opts?: { client?: LedgerClient }): Promise<T | { success: boolean; error?: string }> {
  const sessionUser = ctx.actor.type === "user" && !!ctx.actor.userId
  const call: ActionContext = ctx.trustClass || !sessionUser ? ctx : { ...ctx, trustClass: "authorized_human" }
  return withActionLedger<T | { success: boolean; error?: string }>(call, run, { settle: settleToolResult, replay: toolReplay }, opts)
}

/**
 * THE RESULT FAMILY OF A WRAPPED ACTION — an identity at run time; it only restores what the compiler knew before the wrap.
 *
 * An action's returns used to be object literals in ONE function, and the compiler unions those as a family: a field one
 * return lacks reads as `undefined` on it, so a caller may write `result.copy` or `result.error` without narrowing. A wrapped
 * body is a separate function and the refusal `{ success, error? }` is a declared type, so (a) every success shape is a
 * subtype of the refusal and the export's inferred return type COLLAPSES to the refusal — `result.copy` stops existing — and
 * (b) members from two scopes no longer share their fields. The first whole-project type-check after the receipt lanes merged
 * found 59 such errors in 20 callers. An export whose callers read its result fields returns
 * `resultFamily(await ledgerSessionAction(…))`: every member of the union gets the family's other LITERAL keys as absent.
 * Arrays, primitives and index signatures pass through untouched. Not a second wrapper: it claims, runs and settles nothing.
 */
type FamilyKeysOf<W> = W extends readonly unknown[] ? never : W extends object ? { [K in keyof W]-?: K extends string ? (string extends K ? never : K) : never }[keyof W] : never
export type ResultFamily<U, W = U> = U extends readonly unknown[] ? U : U extends object ? U & { [K in Exclude<FamilyKeysOf<W>, keyof U>]?: undefined } : U
export function resultFamily<T>(result: T): ResultFamily<T> {
  return result as ResultFamily<T>
}

/** The typed feedback a refused tool call returns to its caller (the model / the speaker): never a silent drop, never a 500. */
export interface SinkRefusal {
  success: false
  error: string
  governance: { decision: "DENY" | "HOLD"; reason: SinkReason; next_trigger: NextTrigger | null; recorded: boolean }
}

/** PURE. The sink verdict for a ledgered tool context — the boundary's facts only (the model's claims are never read). */
function sinkVerdictFor(ctx: ActionContext, now?: Date): SinkVerdict {
  return sinkRule({
    riskClass: ctx.riskClass ?? null, trustClass: ctx.trustClass ?? null, verification: ctx.sink?.verification ?? null,
    approvalBasis: ctx.approvalBasis ?? null, expiresAt: ctx.expiresAt ?? null, now: now ?? new Date(),
    proposedTargetManager: ctx.sink?.proposedTargetManager ?? null, allowedManagers: ctx.sink?.allowedManagers ?? null,
    modelClaims: ctx.sink?.modelClaims ?? null,
  })
}

/**
 * A refusal at the sink is a DECISION: ONE `<domain>.decision.wait` (HOLD) / `.do_nothing` (DENY) row with the typed reason, the
 * next trigger and the contract facts on detail.governance. Keyed by the call's cycle, so a replay of the same refused call adds
 * no row (23505 → already recorded). The tool never runs.
 */
async function refuseAtSink(ctx: ActionContext, v: SinkVerdict, opts?: { client?: LedgerClient }): Promise<SinkRefusal> {
  const domain = ctx.action.split(".")[0] || "ai"
  const key = ctx.cycle && ctx.cycle.trim()
    ? actionIdempotencyKey({ brokerageId: ctx.brokerageId, subjectType: ctx.subject.type, subjectId: ctx.subject.id ?? "-", action: `${domain}.decision.sink`, cycle: `${ctx.action}:${ctx.cycle.trim()}` })
    : null
  const governance = governanceRecord({
    plane: "tool_boundary", verdict: v.decision === "HOLD" ? "hold" : "deny",
    scope: { brokerageId: ctx.brokerageId, userId: ctx.actor.userId ?? null }, actor: { type: ctx.actor.type, id: ctx.actor.managerKey ?? ctx.actor.userId ?? ctx.actor.agentId ?? null },
    causationId: ctx.causationId ?? null, correlationId: ctx.correlationId ?? null,
    entity: { type: ctx.subject.type, id: ctx.subject.id ?? null, version: null },
    objective: ctx.action, policyConstraints: [`sink rule: ${v.reason}`, `risk class ${ctx.riskClass ?? "unknown"}`], rationale: v.detail,
    trustClass: ctx.trustClass ?? null, dependencies: ctx.dependencies ?? null, approvalBasis: null, expiresAt: ctx.expiresAt ?? null, nextTrigger: v.nextTrigger,
  })
  const r = await recordNonAction({
    ...ctx, domain, decision: v.decision === "HOLD" ? "wait" : "do_nothing", idempotencyKey: key, cycle: null,
    reasonDetail: `sink ${v.decision}: ${v.reason} — ${v.detail}`.slice(0, 1000),
    detail: { ...(ctx.detail ?? {}), proposed_action: ctx.action, ...(ctx.sink?.modelClaims ? { model_claims_ignored: Object.keys(ctx.sink.modelClaims).slice(0, 20) } : {}), governance },
  }, opts)
  return {
    success: false,
    error: `Not done — ${v.decision === "HOLD" ? "held for verification" : "refused"}: ${v.detail}`,
    governance: { decision: v.decision as "DENY" | "HOLD", reason: v.reason, next_trigger: v.nextTrigger, recorded: r.recorded },
  }
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
    /** 102D — the policy the mount ran under (the authority ladder key for this actor's agent kind). */
    policyKey?: string | null
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
      execute: async (args: unknown, options?: { toolCallId?: string }) => {
        // WAVE 155 (155B3, D 152): the call IS a model proposal — the trust class is set HERE, by the wrapper, never read from the
        // model's arguments. Its recorded verification is the tool's NAMED deterministic gate (persona-tool-policy.ts
        // TOOL_APPROVAL_GATE — the dispatch policy chain / the approval queue the tool hands to); a consequential tool with no named
        // gate is HELD at the sink. Already loaded by the mount (customer-context-tools.ts) — a module lookup, not a round trip.
        const { TOOL_APPROVAL_GATE } = await import("@/lib/ai-isa/persona-tool-policy")
        const gate = TOOL_APPROVAL_GATE[name]
        const call: ActionContext = {
          brokerageId: ctx.brokerageId,
          action: `ai.tool.${name}`,
          channel: "ai_tool",
          actor: ctx.actor ?? { type: "system" },
          subject: ctx.subject,
          riskClass: risk,
          systemSource: ctx.surface ?? null,
          cycle: options?.toolCallId ?? null,
          detail: { tool: name },
          policyKey: ctx.policyKey ?? null,
          trustClass: "model_output",
          dependencies: [{ type: ctx.subject.type, id: ctx.subject.id ?? null, version: null }],
          approvalBasis: gate ? "policy_permitted" : null,
          sink: { verification: gate ? { kind: "deterministic", check: `TOOL_APPROVAL_GATE.${name}` } : null, modelClaims: args && typeof args === "object" ? args as Record<string, unknown> : null },
        }
        const verdict = sinkVerdictFor(call)
        if (verdict.decision !== "ALLOW") return refuseAtSink(call, verdict, opts)
        call.detail = { tool: name, governance: governanceRecord({
          plane: "tool_boundary", verdict: "allow", scope: { brokerageId: ctx.brokerageId }, actor: { type: call.actor.type, id: call.actor.managerKey ?? call.actor.userId ?? null },
          entity: { type: ctx.subject.type, id: ctx.subject.id ?? null, version: null }, objective: call.action,
          policyConstraints: [`sink rule: ${verdict.reason}`, ...(ctx.policyKey ? [ctx.policyKey] : [])], rationale: verdict.detail,
          trustClass: call.trustClass, dependencies: call.dependencies, approvalBasis: verdict.approvalBasis, verification: call.sink?.verification ?? null,
        }) }
        return withActionLedger<unknown>(
          call,
          () => Promise.resolve((exec as (a: unknown, o?: unknown) => unknown)(args, options)),
          { settle: settleToolResult, replay: toolReplay },
          opts,
        )
      },
    }
  }
  return out as T
}

// ─── WAVE 153 (lane 153H) — THE GOVERNANCE DECISION CONTRACT (directive H3) ─────────────────
// OWNER RULING 14 (2026-11-14): arbitration is OS-wide governance spread across the EXISTING planes, never a new
// central arbiter. Each plane keeps its OWN verdict vocabulary (the tool boundary's allow/deny/hold/rewrite, the
// delegation statuses, the arbiter's experience kinds, the decision rows' wait/do_nothing, the dispatch gates,
// the approval states). The eight governance verbs below are a READING of those spellings, made HERE and nowhere
// else (CLAUDE.md §6 — one mapping table, the planes are not respelled), and they ride the EXISTING
// `agent_action_ledger.detail.governance` jsonb (no DB enum, no migration: nothing in the readback was blocked by a
// missing column — causation/correlation, policy_ref, subject, actor, risk and status are already columns).

/** The eight governance verbs (directive H3). A code vocabulary on `detail.governance.decision` — never a CHECK. */
const GOVERNANCE_DECISIONS = ["ALLOW", "DENY", "REWRITE", "HOLD", "DELEGATE", "RESCHEDULE", "ESCALATE", "CANCEL"] as const
type GovernanceDecision = (typeof GOVERNANCE_DECISIONS)[number]

/** Where a decision's urgency came from — the KIND of obligation behind it (directive H3's own list). "Never invent a deadline":
 *  a deadline whose source is not one of these is dropped and recorded as `none`. Not a second spelling of
 *  lib/intent/moving-moments.ts KnownDeadlineSource, which records a different fact (the PROVENANCE of a known date — who stated it). */
const DEADLINE_SOURCES = ["contractual", "human_requested", "consumer_reply", "provider_deadline", "campaign_opportunity", "none"] as const
export type DeadlineSource = (typeof DEADLINE_SOURCES)[number]

/** The planes whose verdicts the contract reads (the six of the ownership matrix + the resource / money / closing rails). */
type GovernancePlane = "tool_boundary" | "delegation" | "contact_engagement" | "ledger_decision" | "dispatch" | "approval" | "resource" | "closing"

/** THE ONE MAPPING TABLE: a plane's own verdict spelling → the governance verb. A spelling with no entry reads null. */
const GOVERNANCE_VERB_MAP: Readonly<Record<GovernancePlane, Readonly<Record<string, GovernanceDecision>>>> = {
  tool_boundary: { allow: "ALLOW", deny: "DENY", hold: "HOLD", rewrite: "REWRITE" },
  delegation: { REQUESTED: "DELEGATE", ACCEPTED: "ALLOW", WORKING: "ALLOW", RETURNED: "ALLOW", REJECTED: "DENY", DISSENTED: "HOLD", ESCALATED: "ESCALATE", CANCELLED: "CANCEL" },
  contact_engagement: { communication: "ALLOW", experience: "ALLOW", wait: "RESCHEDULE", agent_intervention: "DELEGATE", halt_no_lawful_channel: "DENY", human_owns: "DELEGATE", notify_human: "DELEGATE", reply: "ALLOW" },
  ledger_decision: { wait: "RESCHEDULE", do_nothing: "CANCEL", send_touch: "ALLOW", convert: "ALLOW" },
  dispatch: { accepted: "ALLOW", gate: "DENY", provider_error: "ALLOW", provider_timeout: "ALLOW" },
  approval: { pending: "HOLD", approved: "ALLOW", rejected: "DENY", expired: "CANCEL", escalated: "ESCALATE" },
  resource: { allowed: "ALLOW", refused: "DENY", over_budget: "HOLD", rerouted: "REWRITE" },
  closing: { pass: "ALLOW", hold: "HOLD", blocked: "DENY", correction_requested: "ESCALATE" },
}

/** PURE. The verb a plane's own verdict reads as (null when the spelling is not mapped — a finding, never a guess). */
function governanceVerb(plane: GovernancePlane, verdict: string | null | undefined): GovernanceDecision | null {
  if (!verdict) return null
  const v = GOVERNANCE_VERB_MAP[plane]?.[verdict] ?? GOVERNANCE_VERB_MAP[plane]?.[verdict.toLowerCase()] ?? null
  return v && (GOVERNANCE_DECISIONS as readonly string[]).includes(v) ? v : null
}

/** The H3 facts a consequential / cross-manager decision persists on `detail.governance`. */
interface GovernanceRecordInput {
  plane: GovernancePlane
  /** The plane's OWN verdict spelling (e.g. a delegation status, the tool boundary's `deny`). */
  verdict: string
  /** Who decided and for which scope — the VERIFIED tenant, never a body (CLAUDE.md §4). */
  scope: { brokerageId: string; officeId?: string | null; teamId?: string | null; userId?: string | null }
  actor: { type: string; id?: string | null }
  missionId?: string | null
  causationId?: string | null
  correlationId?: string | null
  /** The entity decided on, with the version the decision READ (a later write on a different version is a conflict). */
  entity?: { type: string; id?: string | null; version?: string | number | null } | null
  objective?: string | null
  /** The candidate managers / options the decision chose among. */
  candidates?: string[]
  deadline?: string | null
  deadlineSource?: string | null
  policyConstraints?: string[]
  resourceConstraints?: string[]
  conflicts?: string[]
  rationale: string
  evidenceRefs?: string[]
  /** A hold names who can release it and when it is reassessed. */
  approver?: { required: boolean; userIds?: string[]; expiresAt?: string | null } | null
  // ── WAVE 155 (lane 155B3, directive §B3): the facts the record did not carry. All OPTIONAL; unknown stays null. ──
  /** What the decision RESTS ON (DECISION_TRUST_CLASSES, or an existing spelling TRUST_CLASS_MAP reads). */
  trustClass?: string | null
  /** Every fact / version the decision READ — digested into `dependency_fingerprint` (with `entity`). */
  dependencies?: Array<{ type: string; id?: string | null; version?: string | number | null }> | null
  /** WHY it may execute (APPROVAL_BASES, or an existing spelling APPROVAL_BASIS_MAP reads). Never a model's field. */
  approvalBasis?: string | null
  /** When the DECISION stops being valid. */
  expiresAt?: string | null
  nextTrigger?: NextTriggerInput | null
  /** The recorded verification that cleared an untrusted origin (a named deterministic check, or an authorized human). */
  verification?: VerificationInput | null
  /** One accountable decider for a conflict: the winner, and the loser's typed outcome + next trigger. */
  arbitration?: ArbitrationInput | null
}

/**
 * PURE. Normalize the H3 facts into the `detail.governance` block. The verb is READ from the plane's own verdict (an
 * unmapped verdict keeps `decision: null` and says so — never a guessed ALLOW). A deadline whose source is not one of
 * DEADLINE_SOURCES is DROPPED (source `none`): a decision never carries an invented deadline.
 */
export function governanceRecord(i: GovernanceRecordInput): Record<string, unknown> {
  const source = (DEADLINE_SOURCES as readonly string[]).includes(String(i.deadlineSource ?? "")) ? (i.deadlineSource as DeadlineSource) : "none"
  const deadline = source !== "none" && i.deadline && Number.isFinite(Date.parse(i.deadline)) ? i.deadline : null
  const list = (x?: string[]) => [...new Set((x ?? []).filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 200)))].slice(0, 20)
  return {
    decision: governanceVerb(i.plane, i.verdict),
    plane: i.plane,
    verdict: i.verdict,
    scope: { brokerage_id: i.scope.brokerageId, office_id: i.scope.officeId ?? null, team_id: i.scope.teamId ?? null, user_id: i.scope.userId ?? null },
    actor: { type: i.actor.type, id: i.actor.id ?? null },
    mission_id: i.missionId ?? null,
    causation_id: i.causationId ?? null,
    correlation_id: i.correlationId ?? null,
    entity: i.entity ? { type: i.entity.type, id: i.entity.id ?? null, version: i.entity.version ?? null } : null,
    objective: i.objective ? i.objective.slice(0, 300) : null,
    candidates: list(i.candidates),
    urgency: { deadline, deadline_source: deadline ? source : "none" },
    constraints: { policy: list(i.policyConstraints), resource: list(i.resourceConstraints) },
    conflicts: list(i.conflicts),
    rationale: i.rationale.slice(0, 600),
    evidence_refs: list(i.evidenceRefs),
    approver: i.approver ? { required: i.approver.required, user_ids: list(i.approver.userIds), expires_at: i.approver.expiresAt ?? null } : null,
    ...decisionContractFacts({ ...i, dependencies: [...(i.entity ? [i.entity] : []), ...(i.dependencies ?? [])] }),
  }
}

// ─── WAVE 155 (lane 155B3, directive §B3 / D 148–152) — THE CONTRACT'S MISSING FACTS + THE SINK RULE ──────────────────────────
// NOT a new arbiter, table or kernel: the facts §B3 lists that `detail.governance` did not carry (trust class, dependency
// fingerprint, approval basis, decision expiry, next trigger, the recorded verification, the conflict's accountable decider), each a
// CLOSED vocabulary defined HERE once, read from existing spellings through ONE mapping table each (an unmapped spelling reads
// null and is named in `contract_findings` — a finding, never a guess, exactly like GOVERNANCE_VERB_MAP). Research taken as RULES
// (Arbiter-K, arXiv 2604.18652): the model is a non-privileged proposal generator; taint is tagged at ingress; nothing tainted
// reaches a consequential sink without an explicit verification; a refusal is feedback, not an abort.

/** What a decision rests on. The first three are TRUSTED (established by the platform / a person with authority); the rest are
 *  UNTRUSTED (a model's output, a person's inbound words, public text, a document's text, a vendor claim with no seat). */
export const DECISION_TRUST_CLASSES = ["verified_first_party", "authorized_human", "tenant_policy", "model_output", "inbound_message", "public_web_text", "uploaded_document_text", "unseated_vendor_claim"] as const
export type DecisionTrustClass = (typeof DECISION_TRUST_CLASSES)[number]
const TRUSTED_CLASSES: ReadonlySet<DecisionTrustClass> = new Set(["verified_first_party", "authorized_human", "tenant_policy"])

/** THE ONE TRUST MAPPING: an existing spelling → its class. Canonical spellings map to themselves. */
const TRUST_CLASS_MAP: Readonly<Record<string, DecisionTrustClass>> = {
  ...Object.fromEntries(DECISION_TRUST_CLASSES.map((c) => [c, c])),
  // app/api/agent-assistant/tool-call/route.ts TOOL_INPUT_TRUST (wave 153O): the verified rows / the registry are first-party; a
  // typed parameter is still the model's proposal (the identity gates check it — they do not make it the platform's).
  verified_session_row: "verified_first_party", verified_users_row: "verified_first_party", tool_registry: "verified_first_party",
  typed_parameter_behind_declared_identity_gates: "model_output",
  // The two text fences (they do different jobs — not merged): lib/content-intel/public-chatter-topics.ts fenceUntrusted (a typed
  // wrapper over a public post / page) and lib/repurpose/refurbish-idea.ts fenceUntrustedSource (a prompt fence over fetched text).
  fenceUntrusted: "public_web_text", fenceUntrustedSource: "public_web_text",
}

/** WHY a decision may execute. Reuses the existing spellings where they exist (APPROVAL_BASIS_MAP). */
export const APPROVAL_BASES = ["policy_permitted", "human_approval", "tenant_override", "standing_authority"] as const
export type ApprovalBasis = (typeof APPROVAL_BASES)[number]
const APPROVAL_BASIS_MAP: Readonly<Record<string, ApprovalBasis>> = {
  ...Object.fromEntries(APPROVAL_BASES.map((b) => [b, b])),
  // the approval plane's `approved`; lib/managers/autonomy-gate.ts HUMAN_APPROVED_SYSTEM_SOURCE; video-render-hold `releasedBy`
  approved: "human_approval", agent_client_message: "human_approval",
  // lib/kernel/strategy-library.ts change source `tenant_policy` (a tenant's own override of the default)
  tenant_policy: "tenant_override",
  // an autonomy posture the tenant granted (lib/managers/eval-scoring.ts AutonomyPosture) is a standing authority
  autonomous: "standing_authority", review_recommended: "standing_authority",
  // the tool boundary's `allow` and the resource plane's `allowed`: the policy permitted it
  allow: "policy_permitted", allowed: "policy_permitted",
}

/** What happens next for a decision that did not (yet) execute. `none` is a RECORDED fact (nothing re-triggers it), not a gap. */
export const NEXT_TRIGGER_KINDS = ["time", "event", "human", "re_evaluate", "none"] as const
export type NextTriggerKind = (typeof NEXT_TRIGGER_KINDS)[number]
export interface NextTriggerInput { kind: string; at?: string | null; event?: string | null; detail?: string | null }
export interface NextTrigger { kind: NextTriggerKind; at: string | null; event: string | null; detail: string | null }

export type VerificationInput =
  | { kind: "deterministic"; check: string }
  | { kind: "authorized_human"; userId: string; authority: string; at?: string | null }
export type DecisionVerification =
  | { kind: "deterministic"; check: string }
  | { kind: "authorized_human"; user_id: string; authority: string; at: string | null }

/** The four conflict classes directive §B3 names, each resolved by its EXISTING survivor (the record names the decider). */
export const CONFLICT_CLASSES = ["same_contact", "same_campaign", "same_transaction_terms", "competing_provider_spend"] as const
export type ConflictClass = (typeof CONFLICT_CLASSES)[number]
const LOSER_OUTCOMES = ["HOLD", "RESCHEDULE", "DENY"] as const
export interface ArbitrationInput {
  conflictClass: string
  /** The accountable REGISTERED manager whose survivor decided. */
  decider: string | null
  /** Which survivor decided (file:function), so the record names its own authority. */
  survivor: string
  winner: { manager?: string | null; ref?: string | null } | null
  loser?: { manager?: string | null; ref?: string | null; outcome: string; nextTrigger?: NextTriggerInput | null } | null
  /** Does a SECOND writer compete for this subject today? null = not measured. */
  secondWriter?: boolean | null
}

/** PURE. A spelling's trust class (null = unmapped or absent — never a default of "trusted"). */
function decisionTrustClass(spelling: string | null | undefined): DecisionTrustClass | null {
  if (!spelling || typeof spelling !== "string") return null
  return TRUST_CLASS_MAP[spelling] ?? TRUST_CLASS_MAP[spelling.trim().toLowerCase()] ?? null
}
/** PURE. A spelling's approval basis (null = unmapped or absent). */
function decisionApprovalBasis(spelling: string | null | undefined): ApprovalBasis | null {
  if (!spelling || typeof spelling !== "string") return null
  return APPROVAL_BASIS_MAP[spelling] ?? APPROVAL_BASIS_MAP[spelling.trim().toLowerCase()] ?? null
}
const isoOrNull = (s: string | null | undefined): string | null => (typeof s === "string" && Number.isFinite(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : null)
/** PURE. A next trigger in the closed vocabulary (null = absent / unmapped kind / a `time` trigger with no readable time). */
function decisionNextTrigger(t: NextTriggerInput | null | undefined): NextTrigger | null {
  if (!t || typeof t.kind !== "string" || !(NEXT_TRIGGER_KINDS as readonly string[]).includes(t.kind)) return null
  const at = isoOrNull(t.at ?? null)
  if (t.kind === "time" && !at) return null
  return { kind: t.kind as NextTriggerKind, at, event: t.event ? String(t.event).slice(0, 120) : null, detail: t.detail ? String(t.detail).slice(0, 300) : null }
}
/** PURE. A verification that names itself (a check name / an authorized user AND the authority they acted under), else null. */
function decisionVerification(v: VerificationInput | null | undefined): DecisionVerification | null {
  if (!v || typeof v !== "object") return null
  if (v.kind === "deterministic") return typeof v.check === "string" && v.check.trim() ? { kind: "deterministic", check: v.check.trim().slice(0, 200) } : null
  if (v.kind === "authorized_human") {
    return typeof v.userId === "string" && v.userId.trim() && typeof v.authority === "string" && v.authority.trim()
      ? { kind: "authorized_human", user_id: v.userId.trim(), authority: v.authority.trim().slice(0, 200), at: isoOrNull(v.at ?? null) } : null
  }
  return null
}

/** PURE. A stable digest over the SET of facts a decision read (order-free, duplicate-free; the version is part of each fact) —
 *  a later decision that read a different version of any of them has a different fingerprint. FNV-1a over two lanes (no
 *  node:crypto — the module stays runtime-neutral). null = nothing was named (an unknown read set is not an empty one). */
function dependencyFingerprint(deps: ReadonlyArray<{ type: string; id?: string | null; version?: string | number | null }> | null | undefined): string | null {
  const facts = [...new Set((deps ?? []).filter((d) => d && typeof d.type === "string" && d.type.trim()).map((d) => `${d.type.trim()}:${d.id ?? ""}@${d.version ?? ""}`))].sort()
  if (facts.length === 0) return null
  const s = facts.join("|")
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return `fnv1a:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`
}

/** PURE. The conflict block (one accountable decider; the loser's typed outcome and next trigger). Unmapped spellings → null. */
export function governanceArbitration(a: ArbitrationInput | null | undefined): Record<string, unknown> | null {
  if (!a) return null
  const cls = (CONFLICT_CLASSES as readonly string[]).includes(a.conflictClass) ? a.conflictClass : null
  const loser = a.loser ? {
    manager: a.loser.manager ?? null, ref: a.loser.ref ? String(a.loser.ref).slice(0, 200) : null,
    outcome: (LOSER_OUTCOMES as readonly string[]).includes(a.loser.outcome) ? a.loser.outcome : null,
    next_trigger: decisionNextTrigger(a.loser.nextTrigger ?? null),
  } : null
  return {
    conflict_class: cls, decider: a.decider ?? null, survivor: String(a.survivor ?? "").slice(0, 200) || null,
    winner: a.winner ? { manager: a.winner.manager ?? null, ref: a.winner.ref ? String(a.winner.ref).slice(0, 200) : null } : null,
    loser, second_writer: typeof a.secondWriter === "boolean" ? a.secondWriter : null,
  }
}

/** PURE. The contract facts as persisted (snake_case), with every unmapped spelling named in `contract_findings`. */
function decisionContractFacts(i: {
  trustClass?: string | null; dependencies?: ReadonlyArray<{ type: string; id?: string | null; version?: string | number | null }> | null
  approvalBasis?: string | null; expiresAt?: string | null; nextTrigger?: NextTriggerInput | null; verification?: VerificationInput | null; arbitration?: ArbitrationInput | null
}): Record<string, unknown> {
  const trust = decisionTrustClass(i.trustClass)
  const basis = decisionApprovalBasis(i.approvalBasis)
  const next = decisionNextTrigger(i.nextTrigger)
  const arbitration = governanceArbitration(i.arbitration)
  const findings: string[] = []
  if (i.trustClass && !trust) findings.push(`trust_class unmapped: ${String(i.trustClass).slice(0, 60)}`)
  if (i.approvalBasis && !basis) findings.push(`approval_basis unmapped: ${String(i.approvalBasis).slice(0, 60)}`)
  if (i.nextTrigger && !next) findings.push(`next_trigger unmapped: ${String(i.nextTrigger.kind).slice(0, 60)}`)
  if (i.expiresAt && !isoOrNull(i.expiresAt)) findings.push("expires_at unreadable")
  if (i.verification && !decisionVerification(i.verification)) findings.push("verification does not name itself")
  if (arbitration && (!arbitration.conflict_class || (arbitration.loser && !(arbitration.loser as { outcome: unknown }).outcome))) findings.push("arbitration spelling unmapped")
  return {
    trust_class: trust, dependency_fingerprint: dependencyFingerprint(i.dependencies), approval_basis: basis,
    expires_at: isoOrNull(i.expiresAt ?? null), next_trigger: next, verification: decisionVerification(i.verification), arbitration,
    ...(findings.length ? { contract_findings: findings } : {}),
  }
}

/** The facts a context carries, merged onto its detail.governance on the SAME insert (fills only what the block left null). */
function withContractFacts(ctx: ActionContext, detail: Record<string, unknown>): Record<string, unknown> {
  const has = ctx.trustClass || ctx.dependencies?.length || ctx.approvalBasis || ctx.expiresAt || ctx.nextTrigger
  if (!has) return detail
  const facts = decisionContractFacts({ trustClass: ctx.trustClass, dependencies: ctx.dependencies, approvalBasis: ctx.approvalBasis, expiresAt: ctx.expiresAt, nextTrigger: ctx.nextTrigger, verification: ctx.sink?.verification ?? null })
  const prior = (detail.governance && typeof detail.governance === "object" ? detail.governance : {}) as Record<string, unknown>
  const merged: Record<string, unknown> = { ...prior }
  for (const [k, v] of Object.entries(facts)) if (merged[k] === undefined || merged[k] === null) merged[k] = v
  return { ...detail, governance: merged }
}

/** ToolRiskClass (lib/ai-isa/persona-tool-policy.ts) values that are NOT consequential. Any other value — including an unknown or
 *  absent one — is treated as consequential (fail closed, CLAUDE.md §4). */
const NON_CONSEQUENTIAL_RISK: ReadonlySet<string> = new Set(["READ", "LOW_RISK_WRITE"])
function isConsequentialRisk(riskClass: string | null | undefined): boolean { return !NON_CONSEQUENTIAL_RISK.has(String(riskClass ?? "")) }

/**
 * PURE. Which contract facts a persisted `detail.governance` block is MISSING for its risk class (empty = contract-complete).
 * The coverage ledger and the guards read this; it never fills a gap. Rules (derived, not pinned):
 *   every decision    — decision verb, scope tenant, actor, subject, rationale;
 *   consequential     — + trust class, dependency fingerprint, approval basis (an ALLOW resting on an untrusted origin + verification);
 *   a waiting verb    — HOLD / RESCHEDULE / ESCALATE / DELEGATE + expiry;
 *   anything not ALLOW — + next trigger (`none` is a recorded answer).
 */
function governanceContractGaps(governance: unknown, riskClass: string | null | undefined): string[] {
  if (!governance || typeof governance !== "object") return ["governance"]
  const g = governance as Record<string, any>
  const gaps: string[] = []
  const decision = typeof g.decision === "string" && (GOVERNANCE_DECISIONS as readonly string[]).includes(g.decision) ? g.decision as GovernanceDecision : null
  if (!decision) gaps.push("decision")
  if (!g.scope?.brokerage_id) gaps.push("scope")
  if (!g.actor?.type) gaps.push("actor")
  if (!g.entity?.type) gaps.push("subject")
  if (!(typeof g.rationale === "string" && g.rationale.trim())) gaps.push("rationale")
  const trust = decisionTrustClass(g.trust_class)
  if (isConsequentialRisk(riskClass)) {
    if (!trust) gaps.push("trust_class")
    if (!g.dependency_fingerprint) gaps.push("dependency_fingerprint")
    if (!decisionApprovalBasis(g.approval_basis)) gaps.push("approval_basis")
    if (decision === "ALLOW" && trust && !TRUSTED_CLASSES.has(trust) && !g.verification) gaps.push("verification")
  }
  if (decision && ["HOLD", "RESCHEDULE", "ESCALATE", "DELEGATE"].includes(decision) && !isoOrNull(g.expires_at)) gaps.push("expires_at")
  if (decision && decision !== "ALLOW" && !decisionNextTrigger(g.next_trigger)) gaps.push("next_trigger")
  return gaps
}

/** The typed reasons the sink rule gives (one spelling — the refusal row and the caller's feedback carry it). */
export const SINK_REASONS = ["non_consequential", "trusted_origin", "verified_deterministic", "verified_by_authorized_human", "decision_expired", "unverified_untrusted_origin", "trust_class_unknown", "target_outside_capability_set", "capability_set_unknown"] as const
export type SinkReason = (typeof SINK_REASONS)[number]
export interface SinkVerdict { decision: "ALLOW" | "DENY" | "HOLD"; reason: SinkReason; detail: string; trustClass: DecisionTrustClass | null; approvalBasis: ApprovalBasis | null; nextTrigger: NextTrigger | null }
export interface SinkRuleInput {
  riskClass: string | null
  /** Established by the BOUNDARY (the wrapper / the route), never by the model. */
  trustClass: string | null
  verification?: VerificationInput | null
  approvalBasis?: string | null
  expiresAt?: string | null
  now: Date
  /** A target manager the MODEL named (data). Refused when outside `allowedManagers`; unverifiable when that set is unknown. */
  proposedTargetManager?: string | null
  allowedManagers?: readonly string[] | null
  /** The model's own fields — accepted so the caller can record them; this function NEVER reads them (INJECT-005, SCOPE-003). */
  modelClaims?: Record<string, unknown> | null
}

/**
 * PURE — no model, no I/O (directive D 152). The deterministic sink rule, in order:
 *   1. an expired (or unreadable) expiry → DENY decision_expired (next: re-evaluate fresh);
 *   2. a model-named target manager outside the caller's capability set (or an unknown set) → DENY;
 *   3. READ / LOW_RISK_WRITE → ALLOW (not a consequential sink);
 *   4. a TRUSTED origin → ALLOW;
 *   5. an untrusted origin with a recorded verification — a deterministic check that names itself → ALLOW (policy_permitted), an
 *      authorized human under a named authority → ALLOW (human_approval);
 *   6. otherwise HOLD — unverified_untrusted_origin, or trust_class_unknown (never a default of "trusted") — next: a person verifies.
 * `modelClaims` is never read: a model's "approved", "trusted" or "basis" changes nothing.
 */
function sinkRule(i: SinkRuleInput): SinkVerdict {
  const trust = decisionTrustClass(i.trustClass)
  const basisIn = decisionApprovalBasis(i.approvalBasis)
  const v = (decision: SinkVerdict["decision"], reason: SinkReason, detail: string, approvalBasis: ApprovalBasis | null, next: NextTriggerInput | null): SinkVerdict =>
    ({ decision, reason, detail, trustClass: trust, approvalBasis, nextTrigger: decisionNextTrigger(next) })
  if (i.expiresAt !== null && i.expiresAt !== undefined) {
    const at = Date.parse(i.expiresAt)
    if (!Number.isFinite(at) || at <= i.now.getTime()) return v("DENY", "decision_expired", Number.isFinite(at) ? `the decision expired at ${new Date(at).toISOString()} — it never executes late` : "the decision's expiry cannot be read — it does not execute", null, { kind: "re_evaluate", detail: "a fresh decision on the current facts" })
  }
  if (i.proposedTargetManager) {
    if (!i.allowedManagers) return v("DENY", "capability_set_unknown", `a target manager (${i.proposedTargetManager}) was named but the caller's capability set is unknown`, null, { kind: "none" })
    if (!i.allowedManagers.includes(i.proposedTargetManager)) return v("DENY", "target_outside_capability_set", `${i.proposedTargetManager} is outside the caller's capability set — a model cannot pick the target`, null, { kind: "none" })
  }
  if (!isConsequentialRisk(i.riskClass)) return v("ALLOW", "non_consequential", `${i.riskClass} is not a consequential sink`, basisIn ?? "policy_permitted", null)
  if (trust && TRUSTED_CLASSES.has(trust)) return v("ALLOW", "trusted_origin", `rests on ${trust}`, basisIn ?? "policy_permitted", null)
  const ver = decisionVerification(i.verification)
  if (ver?.kind === "deterministic") return v("ALLOW", "verified_deterministic", `${trust ?? "unknown origin"} cleared by the deterministic check ${ver.check}`, "policy_permitted", null)
  if (ver?.kind === "authorized_human") return v("ALLOW", "verified_by_authorized_human", `${trust ?? "unknown origin"} cleared by an authorized person (${ver.authority})`, "human_approval", null)
  if (!trust) return v("HOLD", "trust_class_unknown", `what this ${i.riskClass ?? "unclassified"} action rests on is unknown — it waits for a person`, null, { kind: "human", detail: "a person with authority verifies the origin" })
  return v("HOLD", "unverified_untrusted_origin", `a ${i.riskClass} action resting on ${trust} has no recorded verification — it waits for a person`, null, { kind: "human", detail: "a person with authority verifies, or a named deterministic check clears it" })
}

/**
 * The ledger's FIVE facts (directive H3: decided ≠ attempted ≠ provider accepted ≠ completed ≠ outcome), READ from the
 * columns a row already carries:
 *   decided           — a `*.decision.*` row, or a `skipped` row (a gate refused: nothing left the building);
 *   attempted         — claimed and not finished (`proposed`), or finished without effect (`failed` / `unknown`);
 *   provider_accepted — `executed` with the provider's acceptance (`accepted` + a provider) — handed over, not proven landed;
 *   completed         — `executed` with provider truth (`reconciled_confirmed`) or a domain write that IS the completion
 *                       (a tool completed, a state transition — no provider in between).
 * OUTCOME (a reply / appointment / contract / closed GCI credited back to the row) is the attribution reader's
 * (lib/intelligence/roi-ledger.ts loadLedgerAttribution), returned beside the chain by the flight recorder — a single
 * row cannot know it. PURE.
 */
type ActionPhase = "decided" | "attempted" | "provider_accepted" | "completed"
function actionPhase(a: { action: string; status: string; outcome?: string | null; provider?: string | null; provider_ref?: string | null }): ActionPhase {
  if (/\.decision\./.test(a.action) || a.status === "skipped") return "decided"
  if (a.status !== "executed") return "attempted"
  if (a.outcome === "reconciled_confirmed") return "completed"
  // WAVE 154 (lane 154A2, canary 10): settleDispatchResult records ANY success as outcome 'accepted' — including a provider that
  // answered success WITHOUT a message id. With no provider reference there is no acknowledgement to point at, so the row reads as
  // ATTEMPTED (handed over, receipt not evidenced) until the reconciliation net records one (reconciled_*), never as accepted / done.
  if (a.outcome === "accepted" && !a.provider_ref) return "attempted"
  if (a.outcome === "accepted" ||/^reconciled_/.test(a.outcome ?? "") || ((a.provider || a.provider_ref) && a.outcome !== "tool_completed")) return "provider_accepted"
  return "completed"
}

/** PURE. The governance verb a ledger row reads as: the persisted `detail.governance.decision`, else the row's own shape. */
function rowGovernanceDecision(a: { action: string; status: string; outcome?: string | null; detail?: Record<string, unknown> | null }): GovernanceDecision | null {
  const g = a.detail?.governance as { decision?: unknown } | undefined
  if (typeof g?.decision === "string" && (GOVERNANCE_DECISIONS as readonly string[]).includes(g.decision)) return g.decision as GovernanceDecision
  const verdict = /\.decision\.([a-z_]+)$/.exec(a.action)?.[1]
  if (verdict) return governanceVerb("ledger_decision", verdict)
  if (a.status === "skipped" && /_gate$/.test(a.outcome ?? "")) return governanceVerb("dispatch", "gate")
  if (a.status === "executed" && a.outcome === "accepted") return governanceVerb("dispatch", "accepted")
  return null
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
  /** WAVE 104: a mission_events row folded into a chain carries its evidence here (reason, actor, states, ledger link). */
  detail?: Record<string, unknown> | null
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
  /** 102D — `policy_key@version` (m700); before m700 the ref rides detail.policy_ref. */
  policy_ref?: string | null
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
  /** 102D — which policy permitted: `policy_key@version` (LAW 5). */
  policyRef?: string | null
  /** WAVE 153 (153H, directive H3): which of decided / attempted / provider_accepted / completed this row proves. */
  phase?: ActionPhase
  /** WAVE 153 (153H): the governance verb (ALLOW / DENY / REWRITE / HOLD / DELEGATE / RESCHEDULE / ESCALATE / CANCEL) the row reads as. */
  decision?: GovernanceDecision | null
  /** WAVE 155 (155B3, directive §B3): the contract facts this row's detail.governance is MISSING for its risk class ([] = complete;
   *  null = the row carries no governance block — the reach gap the coverage ledger counts). */
  contractGaps?: string[] | null
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
      policyRef: a.policy_ref ?? (typeof a.detail?.policy_ref === "string" ? (a.detail.policy_ref as string) : null),
      phase: actionPhase(a), decision: rowGovernanceDecision(a),
      contractGaps: a.detail?.governance ? governanceContractGaps(a.detail.governance, a.risk_class ?? null) : null,
      because: ancestry(a.causation_id),
    })),
  ]
  return links.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.kind === y.kind ? 0 : x.kind === "event" ? -1 : 1))
}
