/**
 * OUTBOUND DISPATCH LAYER
 * lib/providers/dispatch.ts
 *
 * Single entry point for outbound comms: email, SMS, direct mail (+ the D-ID
 * video RENDER-AND-DELIVER path). PHONE IS NOT HERE: an outbound voice call goes
 * through lib/voice/twilio-outbound.ts:placeOutboundAiCall, which owns the one
 * pre-dial gate stack (lib/voice/outbound-call-gates.ts) — see the PHONE section
 * below for why the second one was merged into it.
 * Provider selection is always resolved via kernel/providers.ts cascade:
 *   user → team → brokerage → superadmin → system default
 * Never hardcode a provider name in feature code — use these dispatchers.
 *
 * VIDEO IS NOT A CHANNEL (owner ruling). dispatchVideo is a RENDER-AND-DELIVER
 * dispatcher: it renders a D-ID avatar clip and delivers it over a real channel
 * (today: email — it takes a recipientEmail). Its de-confliction therefore spends
 * the recipient's EMAIL allowance, not a video one. "video" survives here only as
 * a providerType (which D-ID/Remotion renderer to call), never as a lane.
 *
 * direct_mail and the video renderer are SYSTEM_ONLY: superadmin-controlled, no
 * per-brokerage override.
 * SMS is supported via the existing Twilio messaging provider.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const LobSDK = require("lob")

import { resolveProvider } from "@/lib/kernel/providers"
// placeCall is deliberately NOT imported here any more: the phone dispatcher was
// merged into lib/voice/twilio-outbound.ts:placeOutboundAiCall (see the PHONE
// section below). The raw TwiML dial still has its own live caller.
import {
  sendEmail as messagingSendEmail,
  sendSMS as messagingSendSMS,
} from "@/lib/providers/messaging"
import { logVendorUsage } from "@/lib/vendor-governance/usage-logger"
import { normalizeVendorCost } from "@/lib/vendor-governance/cost-normalizer"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { assembleEmail } from "@/lib/kernel/communications/assemble-email"
import { evaluateOutboundCompliance } from "@/lib/kernel/communication-compliance"
import { checkSuppression } from "@/lib/kernel/compliance/check-suppression"
import { evaluateDeconflict, type DeconflictChannel } from "@/lib/kernel/deconflict"
import { DECONFLICT_GATE_KEY } from "@/lib/campaign-sequences/deferral-policy"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveUserIdForAgentRecord } from "@/lib/kernel/agent-identity"
import { needsCassCheck, interpretLobForGate, type MailingGateLead } from "@/lib/providers/mailing-cass-gate"
import { resolveManagerAutonomy, autonomyDecision, managerForDispatch, HUMAN_APPROVED_SYSTEM_SOURCE } from "@/lib/managers/autonomy-gate"
import { contentSafetyBackstop } from "@/lib/providers/content-safety"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

/** True when a governed manager is sending unattended (arms the Fair-Housing content backstop's
 *  hard-block; human-approved sends are flagged-but-allowed). */
function isAutonomousSend(args: { managerKey?: ManagerKey | null; systemSource?: string; humanApproved?: boolean }): boolean {
  const managerKey = managerForDispatch(args.managerKey, args.systemSource)
  if (!managerKey) return false
  return !(args.humanApproved === true || args.systemSource === HUMAN_APPROVED_SYSTEM_SOURCE)
}

// ─── SHARED TYPES ─────────────────────────────────────────────────────────────

interface DispatchActorContext {
  /** The brokerage this dispatch is billed / scoped to (always required) */
  brokerageId: string
  /** The user initiating the dispatch (for provider override cascade) */
  userId?: string
  /** The team for provider override cascade */
  teamId?: string
  /** Source system for vendor usage attribution, e.g. 'ai_isa', 'campaign' */
  systemSource?: string
  /**
   * Lead ID for cost attribution. Use this when the recipient is a lead record.
   * Prefer contactId when the recipient is a promoted contact record.
   * Internally, contactId takes precedence over leadId for assembleEmail().
   */
  leadId?: string
  /**
   * Contact ID for cost attribution. Use this when the recipient is a contacts
   * record (post-promotion). Takes precedence over leadId inside dispatch.
   */
  contactId?: string
  agentId?: string
  /**
   * The governed AI manager performing this send. Set ONLY for autonomous (unattended)
   * manager sends — it arms the autonomy gate: a manager on `approval_required` (broker
   * policy or eval-derived) is held and must route to the approval queue instead. Leave
   * unset for transactional / B2B / system sends (never gated).
   */
  managerKey?: ManagerKey
  /** A human approved this send (approval queue). Bypasses the autonomy gate. */
  humanApproved?: boolean
}

// ─── Autonomy gate — enforce the Manager Trust posture on AUTONOMOUS sends ──────
// The single enforcement point for the certifiable-governance story: a manager may only
// send unattended within its proven trust boundary. Opt-in by managerKey (so existing
// callers are untouched); human-approved sends bypass; absence of a posture signal allows.
async function autonomyGate(args: {
  brokerageId: string
  managerKey?: ManagerKey | null
  humanApproved?: boolean
  systemSource?: string
}): Promise<DispatchResult | null> {
  // Explicit managerKey wins; otherwise infer the owning manager from the systemSource so
  // existing autonomous senders are governed without rewiring. No manager ⇒ not gated.
  const managerKey = managerForDispatch(args.managerKey, args.systemSource)
  if (!managerKey) return null
  const humanApproved = args.humanApproved === true || args.systemSource === HUMAN_APPROVED_SYSTEM_SOURCE
  const effective = await resolveManagerAutonomy(args.brokerageId, managerKey)

  // ── ACCURACY GATE (round 36, accuracy-driven autonomy): an EXPLICIT 'autonomous' posture must
  // ALSO be backed by the domain's measured prediction-accuracy rail (lib/managers/accuracy-gate).
  // Below the bar the send stays supervised (held → approval queue) with the measured reason.
  // Consulted only for 'autonomous' + not-human-approved, so unconfigured managers and approved
  // sends are untouched; halts already resolved into `effective` above and are never overridden.
  // Fail-open on infra errors — a broken accuracy read never silently freezes outbound.
  let accuracyGate: { held: boolean; reason: string | null } | undefined
  if (effective === "autonomous" && !humanApproved) {
    try {
      const { loadAccuracyHoldForManager } = await import("@/lib/managers/accuracy-gate")
      // HOLD TELEMETRY (round 37): `record: true` arms the ledger write inside the
      // helper — every hold enforced here is ALSO appended to self_heal_events (the
      // budget-gate idiom: folds per domain into ONE Exception Center item; feeds the
      // manager-trust "autonomy throttled" rollup). Fire-and-forget, fail-open.
      accuracyGate = await loadAccuracyHoldForManager(args.brokerageId, managerKey, undefined, {
        record: true,
        systemSource: args.systemSource,
      })
    } catch { accuracyGate = undefined }
  }

  const decision = autonomyDecision({ managerKey, effective, humanApproved, accuracyGate })
  if (decision.allow) return null
  return { success: false, providerKey: "autonomy_gate", error: `Outbound held: ${decision.reason}` }
}

interface DispatchResult {
  success: boolean
  providerKey: string
  messageId?: string
  error?: string
  /** Soft vendor-budget warning (≥80% of the monthly ceiling) — the send PROCEEDED. */
  budgetWarning?: string
}

// ─── Vendor-budget pre-flight — the platform-spend ceiling applied at the egress gate ──
// Mirrors the outbound-voice lane (lib/voice/twilio-outbound.ts, step 2): checkVendorBudget
// with the estimated cost of THIS send (cost-normalizer rates, kept in lockstep with the
// post-hoc metered figure), so Twilio SMS / SendGrid email / Lob mail get the same
// pre-spend cap that already protects D-ID / ElevenLabs / twilio-native voice.
//
// GOVERNANCE ORDER (deliberate): this runs AFTER every consumer-protection gate
// (autonomy, consent/suppression/DNC/quiet-hours, de-confliction, content safety) has
// passed and BEFORE the provider call — budget never masks a compliance refusal, and a
// compliance refusal never spends.
//
// FAIL-OPEN RULE (critical): if the budget CHECK ITSELF fails — table missing, query
// failure, module-load error — the send PROCEEDS and the failure is ledgered via
// recordSelfHeal. A broken budget system must never silence a consented client
// communication; only an AFFIRMATIVE over-ceiling verdict blocks.
async function vendorBudgetPreflight(args: {
  brokerageId: string
  channel: "email" | "sms" | "direct_mail"
  vendorKey: string
  /** Estimated USD cost of this send — keep in lockstep with the metered figure below. */
  addCost: number
  systemSource?: string
}): Promise<{ refusal: DispatchResult | null; warning?: string }> {
  const channelLabel = args.channel.replace(/_/g, " ")
  try {
    const { checkVendorBudget } = await import("@/lib/vendor-governance/budget-gate")
    const budget = await checkVendorBudget({ brokerageId: args.brokerageId, addCost: args.addCost })

    if (budget.degraded) {
      // The budget system couldn't answer (ledger read failed) — FAIL OPEN: proceed,
      // and record the breakage so it's a visible fact, never a silent hole.
      void recordBudgetLedgerEvent({
        brokerageId: args.brokerageId,
        subject: `budget_check:${args.brokerageId}`,
        outcome: "failed",
        detail: {
          flow: "vendor_budget_check_error", channel: args.channel, connector: args.vendorKey,
          reason: "Vendor-budget pre-flight could not read the spend ledger — send proceeded (fail-open)",
          system_source: args.systemSource ?? "dispatch",
        },
      })
      return { refusal: null }
    }

    if (!budget.allowed) {
      // Refusal ledger — an 'escalated' self_heal_events row is what the broker's
      // Exception Center folds into its OPEN list (the same rail the Lob no-address
      // refusal rides). The subject collapses per channel+brokerage so a burst of
      // blocked sends is ONE open exception, not a flood. PRIVACY: `reason` is
      // brokerage-visible — no dollar amounts or vendor names in it; the numbers
      // ride in separate (non-rendered) detail keys for platform staff.
      await recordBudgetLedgerEvent({
        brokerageId: args.brokerageId,
        subject: `budget:${args.channel}:${args.brokerageId}`,
        outcome: "escalated",
        detail: {
          flow: "egress_budget_blocked", channel: args.channel, connector: args.vendorKey,
          reason: `Monthly platform usage limit reached — ${channelLabel} sends are paused until the limit resets`,
          spent: budget.spent, budget: budget.budget, percent: budget.percent,
          system_source: args.systemSource ?? "dispatch",
        },
      })
      return {
        refusal: {
          success: false,
          providerKey: "budget_gate",
          error: `Outbound blocked: monthly platform usage limit reached — ${channelLabel} send paused until the limit resets`,
        },
      }
    }

    return {
      refusal: null,
      warning: budget.softWarning
        ? "Approaching the monthly platform usage limit — this send proceeded; outbound may pause if the limit is reached"
        : undefined,
    }
  } catch {
    // FAIL-OPEN RULE: an error thrown by the check itself never blocks the send.
    void recordBudgetLedgerEvent({
      brokerageId: args.brokerageId,
      subject: `budget_check:${args.brokerageId}`,
      outcome: "failed",
      detail: {
        flow: "vendor_budget_check_error", channel: args.channel, connector: args.vendorKey,
        reason: "Vendor-budget pre-flight threw — send proceeded (fail-open)",
        system_source: args.systemSource ?? "dispatch",
      },
    })
    return { refusal: null }
  }
}

/** Best-effort append to the self-heal ledger — ledgering never blocks or fails a dispatch. */
async function recordBudgetLedgerEvent(evt: {
  brokerageId: string
  subject: string
  outcome: "failed" | "escalated"
  detail: Record<string, unknown>
}): Promise<void> {
  try {
    const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
    const svc = createServiceClient()
    await recordSelfHeal(svc, {
      brokerageId: evt.brokerageId,
      domain: "data_flow",
      subject: evt.subject,
      action: "none",
      outcome: evt.outcome,
      detail: evt.detail,
    })
  } catch { /* the dispatch result is the record of truth */ }
}

// ─── De-Conflict helper — single chokepoint for over-touch suppression ──────
// Runs the De-Conflict Engine and converts a suppression decision into a
// DispatchResult that callers can return as-is. Every call writes an audit
// row to deconflict_suppression_log (m113) regardless of outcome.
async function deconflictGate(args: {
  brokerageId:   string
  channel:       DeconflictChannel
  contactId?:    string | null
  leadId?:       string | null
  recipientEmail?: string | null
  recipientPhone?: string | null
  systemSource?: string
}): Promise<DispatchResult | null> {
  if (!args.contactId && !args.leadId && !args.recipientEmail && !args.recipientPhone) return null
  const d = await evaluateDeconflict(args)
  if (d.allowed) return null
  return {
    success:     false,
    providerKey: DECONFLICT_GATE_KEY,
    error:       `Outbound deferred: ${d.reason}`,
  }
}

// ─── EMAIL ────────────────────────────────────────────────────────────────────

export interface DispatchEmailParams extends DispatchActorContext {
  /**
   * The sender. OPTIONAL on purpose: undefined means "resolve it downstream",
   * and sendEmail then walks the tenant credential / platform env cascade and
   * REFUSES if neither yields a real address. A caller that cannot establish a
   * sender must pass undefined rather than a placeholder — `params.from ||
   * SENDGRID_FROM_EMAIL` means a caller's guess would otherwise beat the
   * brokerage's own configured, verified from-address (lib/providers/outbound-sender).
   */
  from?: string
  to: string
  subject: string
  html: string
  text?: string
  /**
   * Override the channelPurpose passed to assembleEmail().
   * When omitted, purpose is inferred from systemSource.
   * Always set this explicitly when the caller knows the intent.
   */
  channelPurpose?: 'conversation' | 'campaign' | 'update' | 'transactional'
  metadata?: Record<string, unknown>
}

export async function dispatchEmail(params: DispatchEmailParams): Promise<DispatchResult> {
  // ── AUTONOMY GATE: hold an autonomous send from a manager outside its trust boundary ──
  const autonomyHeld = await autonomyGate(params)
  if (autonomyHeld) return autonomyHeld
  // ── COMPLIANCE GATE: Check if contact is eligible for outbound ───────────────
  if (params.contactId || params.leadId) {
    const supabase = await createServiceClient()
    const recipientId = params.contactId || params.leadId
    const table = params.contactId ? "contacts" : "leads"

    // Final straggler gate (1/2): comprehensive suppression check — contact flags
    // (email_unsubscribed + legacy email_opt_out) AND contact_suppression_list,
    // brokerage-scoped. The contact-flag-only gate below misses list-only entries.
    const suppression = await checkSuppression({
      brokerageId: params.brokerageId,
      contactId: params.contactId ?? null,
      email: params.to ?? null,
      phone: null,
      channel: "email",
    })
    if (suppression.suppressed) {
      console.warn(`[Dispatch] Email blocked for ${recipientId}: ${suppression.reason}`)
      return {
        success: false,
        providerKey: "compliance_gate",
        error: `Outbound blocked: ${suppression.reason}`,
      }
    }

    const { data: recipient, error: recipientError } = await supabase
      .from(table)
      .select("*")
      .eq("id", recipientId)
      .maybeSingle()

    if (!recipientError && recipient) {
      const complianceResult = await evaluateOutboundCompliance({
        contact: recipient,
        channel: "email",
        content: params.subject,
        actorContext: {
          brokerageId: params.brokerageId,
          actorType: params.systemSource?.includes("ai_isa") ? "ai_isa" : "system",
          userId: params.userId,
        },
      })

      if (!complianceResult.allowed) {
        console.warn(
          `[Dispatch] Email blocked for ${recipientId}: ${complianceResult.primaryReason}`
        )
        return {
          success: false,
          providerKey: "compliance_gate",
          error: `Outbound blocked: ${complianceResult.primaryReason}`,
        }
      }
    }

    // ── De-Conflict gate (over-touch suppression) ────────────────────────────
    const deferred = await deconflictGate({
      brokerageId:    params.brokerageId,
      channel:        "email",
      contactId:      params.contactId ?? null,
      leadId:         params.leadId ?? null,
      recipientEmail: params.to ?? null,
      systemSource:   params.systemSource,
    })
    if (deferred) return deferred
  }

  const { providerKey } = await resolveProvider({
    providerType: "email",
    actorContext: {
      userId: params.userId ?? params.brokerageId,
      brokerageId: params.brokerageId,
      teamId: params.teamId,
    },
  })

  // ── Kernel OS: assemble body → signature → unsubscribe → legal ─────────────
  // Prefer an explicit channelPurpose from the caller; fall back to systemSource inference.
  const channelPurpose: 'conversation' | 'campaign' | 'update' | 'transactional' =
    params.channelPurpose ??
    (params.systemSource?.includes("campaign")        ? "campaign"
    : params.systemSource?.includes("nurture")        ? "update"
    : params.systemSource?.includes("transactional")  ? "transactional"
    : "conversation")

  // contactId takes precedence over leadId — contacts are promoted leads and
  // the signature/unsubscribe lookup keys off the contacts table.
  const recipientId = params.contactId ?? params.leadId ?? null

  // IDENTITY CLASS. assembleEmail looks up `users` by this id to run the
  // signature waterfall (user → team → brokerage). params.agentId is an
  // AGENTS id, so passing it matched no users row: tiers 1 and 2 were skipped
  // and every such send silently fell through to the BROKERAGE signature —
  // exactly the fallback-to-brokerage the OS is not supposed to have. The
  // third branch was worse still: a brokerages id passed as a users id.
  // Nothing is lost by dropping it, because assembleEmail reaches the
  // brokerage tier on its own from the brokerageId argument below.
  const signatureUserId =
    params.userId ??
    (params.agentId
      ? await resolveUserIdForAgentRecord(createServiceClient(), params.agentId)
      : null)

  const assembled = await assembleEmail({
    bodyHtml:       params.html ?? "",
    bodyText:       params.text,
    userId:         signatureUserId ?? "",
    brokerageId:    params.brokerageId,
    contactId:      recipientId,
    channelPurpose,
  }).catch(() => ({
    html:                 params.html ?? "",
    text:                 params.text ?? "",
    signatureIncluded:    false,
    unsubscribeIncluded:  false,
    disclosuresIncluded:  false,
  }))

  // ── FAIR-HOUSING CONTENT BACKSTOP — re-scan the FINAL assembled content at the chokepoint.
  const fhEmail = await contentSafetyBackstop({
    brokerageId: params.brokerageId, channel: "email",
    parts: [params.subject, assembled.text, params.text, assembled.html],
    isAutonomous: isAutonomousSend(params), contactId: params.contactId ?? null,
    actorUserId: params.userId ?? null, systemSource: params.systemSource,
  })
  if (fhEmail.blocked) return { success: false, providerKey: "content_safety_gate", error: `Outbound blocked: ${fhEmail.reason}` }

  // ── VENDOR-BUDGET PRE-FLIGHT — after every consumer-protection gate, before the
  //    provider call. addCost matches the $/email figure metered below. Fail-open.
  const emailBudget = await vendorBudgetPreflight({
    brokerageId: params.brokerageId,
    channel: "email",
    vendorKey: "sendgrid",
    addCost: normalizeVendorCost("sendgrid", 1),
    systemSource: params.systemSource,
  })
  if (emailBudget.refusal) return emailBudget.refusal

  let result: DispatchResult

  if (providerKey === "sendgrid") {
    const raw = await messagingSendEmail({
      from:    params.from,
      to:      params.to,
      subject: params.subject,
      html:    assembled.html,
      text:    assembled.text,
    })
    result = {
      success: raw.success,
      providerKey,
      error: raw.error,
      budgetWarning: emailBudget.warning,
    }
  } else {
    // Future: SMTP relay via global_settings (smtp_host / smtp_port / smtp_username / smtp_password)
    // For now fall through to sendgrid default until SMTP relay is wired
    const raw = await messagingSendEmail({
      from:    params.from,
      to:      params.to,
      subject: params.subject,
      html:    assembled.html,
      text:    assembled.text,
    })
    result = {
      success: raw.success,
      providerKey,
      error: raw.error,
      budgetWarning: emailBudget.warning,
    }
  }

  // Record usage — fire and forget (non-blocking)
  void logVendorUsage({
    vendorName: providerKey,
    usageType: "emails",
    unitCount: 1,
    estimatedCost: 0.001,
    systemSource: params.systemSource ?? "dispatch",
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    // NOT `?? params.contactId`. vendor_usage_tracking.lead_id FKs leads(id) —
    // a contacts.id put here raises 23503, and logVendorUsage is fire-and-forget,
    // so the cost row for that send was silently dropped. The contact identity
    // has its own home in metadata.contact_id, immediately below.
    leadId: params.leadId,
    metadata: {
      to: params.to,
      subject: params.subject,
      provider_key: providerKey,
      contact_id: params.contactId,
      ...(params.metadata ?? {}),
    },
  })

  return result
}

// ─── SMS ──────────────────────────────────────────────────────────────────────

export interface DispatchSmsParams extends DispatchActorContext {
  to: string
  message: string
  /**
   * TCPA-transactional send (e.g. a reminder for a showing the recipient
   * THEMSELVES booked): relaxes the express-written-consent rule the same way
   * the inner sendSMS transactional contract did, while every other gate —
   * suppression list, DNC, quiet hours, opt-out, de-conflict, content safety,
   * budget — still applies. Set ONLY for genuinely recipient-initiated
   * transactional moments; never for marketing or outreach.
   */
  transactional?: boolean
  metadata?: Record<string, unknown>
}

export async function dispatchSms(params: DispatchSmsParams): Promise<DispatchResult> {
  // ── AUTONOMY GATE: hold an autonomous send from a manager outside its trust boundary ──
  const autonomyHeld = await autonomyGate(params)
  if (autonomyHeld) return autonomyHeld
  // ── COMPLIANCE GATE: Check if contact is eligible for SMS ──────────────────
  if (params.contactId || params.leadId) {
    const supabase = await createServiceClient()
    const recipientId = params.contactId || params.leadId
    const table = params.contactId ? "contacts" : "leads"

    // Final straggler gate (1/2): comprehensive suppression check — contact flags
    // (sms_unsubscribed + legacy sms_opt_out) AND contact_suppression_list,
    // brokerage-scoped. The contact-flag-only gate below misses list-only entries.
    const suppression = await checkSuppression({
      brokerageId: params.brokerageId,
      contactId: params.contactId ?? null,
      email: null,
      phone: params.to ?? null,
      channel: "sms",
    })
    if (suppression.suppressed) {
      console.warn(`[Dispatch] SMS blocked for ${recipientId}: ${suppression.reason}`)
      return {
        success: false,
        providerKey: "compliance_gate",
        error: `Outbound blocked: ${suppression.reason}`,
      }
    }

    const { data: recipient, error: recipientError } = await supabase
      .from(table)
      .select("*")
      .eq("id", recipientId)
      .maybeSingle()

    if (!recipientError && recipient) {
      const complianceResult = await evaluateOutboundCompliance({
        contact: recipient,
        channel: "sms",
        content: params.message,
        actorContext: {
          brokerageId: params.brokerageId,
          actorType: params.systemSource?.includes("ai_isa") ? "ai_isa" : "system",
          userId: params.userId,
        },
      })

      // Transactional carve-out: a consent-rule refusal is waived for
      // recipient-initiated transactional sends (TCPA treats these as outside
      // EWC) — every OTHER refusal reason still blocks.
      const onlyConsentRefusal =
        params.transactional === true &&
        complianceResult.primaryReason === "no_tcpa_consent"
      if (!complianceResult.allowed && !onlyConsentRefusal) {
        console.warn(
          `[Dispatch] SMS blocked for ${recipientId}: ${complianceResult.primaryReason}`
        )
        return {
          success: false,
          providerKey: "compliance_gate",
          error: `Outbound blocked: ${complianceResult.primaryReason}`,
        }
      }
    }

    // ── De-Conflict gate (over-touch suppression) ────────────────────────────
    const deferred = await deconflictGate({
      brokerageId:    params.brokerageId,
      channel:        "sms",
      contactId:      params.contactId ?? null,
      leadId:         params.leadId ?? null,
      recipientPhone: params.to ?? null,
      systemSource:   params.systemSource,
    })
    if (deferred) return deferred
  }

  // ── FAIR-HOUSING CONTENT BACKSTOP ─────────────────────────────────────────────
  const fhSms = await contentSafetyBackstop({
    brokerageId: params.brokerageId, channel: "sms", parts: [params.message],
    isAutonomous: isAutonomousSend(params), contactId: params.contactId ?? null,
    actorUserId: params.userId ?? null, systemSource: params.systemSource,
  })
  if (fhSms.blocked) return { success: false, providerKey: "content_safety_gate", error: `Outbound blocked: ${fhSms.reason}` }

  const { providerKey } = await resolveProvider({
    providerType: "sms",
    actorContext: {
      userId: params.userId ?? params.brokerageId,
      brokerageId: params.brokerageId,
      teamId: params.teamId,
    },
  })

  // ── VENDOR-BUDGET PRE-FLIGHT — after every consumer-protection gate, before the
  //    provider call. addCost matches the $/segment figure metered below. Fail-open.
  const smsBudget = await vendorBudgetPreflight({
    brokerageId: params.brokerageId,
    channel: "sms",
    vendorKey: "twilio_sms",
    addCost: normalizeVendorCost("twilio_sms", 1),
    systemSource: params.systemSource,
  })
  if (smsBudget.refusal) return smsBudget.refusal

  // Only Twilio is supported for SMS today. contactId/brokerageId/transactional
  // are forwarded so the inner TCPA gate keeps full attribution and applies its
  // own transactional contract (DNC/quiet-hours/opt-out always enforced).
  const raw = await messagingSendSMS({
    to: params.to,
    message: params.message,
    contactId: params.contactId,
    brokerageId: params.brokerageId,
    transactional: params.transactional,
  })

  const result: DispatchResult = {
    success: raw.success,
    providerKey,
    messageId: raw.messageId,
    error: raw.error,
    budgetWarning: smsBudget.warning,
  }

  // ── OUTCOME RECONCILIATION: open a PENDING claim, not a fact ────────────────
  // Twilio's response says "queued". Recording that as sent-and-done is what left
  // every carrier rejection invisible. The claim is opened against the sid, and the
  // StatusCallback (app/api/webhooks/twilio-sms-status) proves or contradicts it.
  // Fire-and-forget: a ledger failure must never fail a send that already happened.
  if (raw.success && raw.messageId) {
    void (async () => {
      const { recordOutcomeClaim } = await import("@/lib/outcomes/reconciliation-ledger")
      await recordOutcomeClaim({
        brokerageId: params.brokerageId,
        channel: "sms",
        providerRef: raw.messageId!,
        // The provider's OWN word for where it is, not our optimistic label.
        claimedStatus: raw.status ?? "queued",
        entityType: "sms",
        contactId: params.contactId ?? null,
        leadId: params.leadId ?? null,
        claimedByManager: "campaign_orchestrator",
      })
    })().catch(() => {})
  }

  void logVendorUsage({
    vendorName: providerKey,
    usageType: "sms_messages",
    unitCount: 1,
    estimatedCost: 0.0075, // Twilio SMS ~$0.0075/segment
    systemSource: params.systemSource ?? "dispatch",
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    // leads(id) only — see the note on the email path above.
    leadId: params.leadId,
    metadata: {
      to: params.to,
      provider_key: providerKey,
      contact_id: params.contactId,
      ...(params.metadata ?? {}),
    },
  })

  return result
}

// ─── PHONE (outbound call) — MERGED AWAY (wave 8) ─────────────────────────────
// `dispatchPhone` used to live here. It had ZERO callers while the platform's
// ONLY live outbound-dial path was — and remains —
//
//     SURVIVOR: lib/voice/twilio-outbound.ts:placeOutboundAiCall
//
// The two were not redundant, they were COMPLEMENTARY, which is the dangerous
// kind of duplicate: each gate the orphan had and the survivor lacked was a hole
// in the lane that actually dials. `enforceTCPACompliance` (the survivor's
// consent gate) reads the contact FLAG `contacts.dnc_status` and never reads
// `contact_suppression_list`, so a contact suppressed on the LIST alone could
// still be dialled by the AI outbound lane. dispatchPhone's own comment named
// that failure mode and its `checkSuppression` call was the only thing closing
// it — on a code path nothing ever executed.
//
// GATES CARRIED ACROSS to the survivor, in lib/voice/outbound-call-gates.ts:
//   · autonomyGate     → OUTBOUND_CALL_GATES[0] "autonomy"    (trust boundary)
//   · checkSuppression → OUTBOUND_CALL_GATES[1] "suppression" (contact flags AND
//     contact_suppression_list, brokerage-scoped, fails closed) — the fix
//   · deconflictGate   → OUTBOUND_CALL_GATES[3] "deconflict"  (over-touch)
// NOT carried: `evaluateOutboundCompliance` and this file's generic
// vendorBudgetPreflight — the survivor already runs enforceTCPACompliance (a
// stricter, logging consent chokepoint) and its own checkVendorBudget, and
// neither was weakened by the merge.
//
// The generic TwiML dial itself was not deleted: lib/providers/messaging:placeCall
// still exists behind its own TCPA gate and is used by the warm/whisper bridge
// (app/actions/voice-call-bridge.ts), which dials the AGENT's own line.
//
// ─── DIRECT MAIL (superadmin-controlled, system-only) ────────────────────────
// direct_mail is SYSTEM_ONLY in kernel/providers.ts — resolveProvider always
// returns the system default (lob) and ignores per-brokerage overrides.

export type DirectMailPieceType = "letter" | "postcard" | "self_mailer"

export interface DispatchDirectMailParams extends DispatchActorContext {
  recipientName: string
  mailingAddress: string
  mailingAddress2?: string
  city: string
  state: string
  zip: string
  /** Lob template id. For letters/self-mailers this is the document; for postcards it is the FRONT. */
  templateId: string
  /** Postcard BACK template id (defaults to env LOB_POSTCARD_BACK_ID or the front). */
  backTemplateId?: string
  /** Mail piece type — Lob supports more than letters. Defaults to "letter". */
  pieceType?: DirectMailPieceType
  /** Postcard size: "4x6" | "6x9" | "6x11" (default "4x6"). Letters ignore this. */
  size?: string
  /** Color print (default false for letters, true for postcards). */
  color?: boolean
  mergeVars?: Record<string, string>
  metadata?: Record<string, unknown>
}

export async function dispatchDirectMail(
  params: DispatchDirectMailParams
): Promise<DispatchResult> {
  // ── AUTONOMY GATE: hold an autonomous send from a manager outside its trust boundary ──
  const autonomyHeld = await autonomyGate(params)
  if (autonomyHeld) return autonomyHeld

  // ── SUPPRESSION GATE — "stop mailing me" is a thing this dispatcher can now hear ──
  // dispatchEmail (:320) and dispatchSms (:539) both consult checkSuppression before
  // they spend. This dispatcher consulted NEITHER checkSuppression NOR
  // evaluateOutboundCompliance: it gated on address verification, CASS deliverability,
  // de-confliction and a Fair-Housing scan — on everything except whether the recipient
  // had asked to stop. A lead or contact who opted out of mail was still mailed, and
  // the send looked clean at every gate it did have.
  //
  // Channel is "mail" because that is what the LIVE CHECK on
  // contact_suppression_list.channel admits (email | sms | phone | mail) — verified
  // against the database, not guessed from the dispatcher's own vocabulary.
  //
  // Placed BEFORE the verification and CASS gates on purpose: a suppressed recipient
  // must not cost a Lob address-verification call to find that out.
  if (params.contactId || params.leadId) {
    const supSvc = createServiceClient()
    let supEmail: string | null = null
    let supPhone: string | null = null
    if (params.leadId) {
      // The address-keyed arm of checkSuppression is the only one that can fire for a
      // LEAD — its flag arm reads `contacts`. Without these two values a lead's own
      // suppression rows are unreachable and the gate would pass vacuously.
      const { data: supLead, error: supLeadError } = await supSvc
        .from("leads")
        .select("email, phone, dnc_status, direct_mail_opt_out, opt_out_channels")
        .eq("id", params.leadId)
        .maybeSingle()
      if (supLeadError) {
        // FAIL CLOSED. supabase-js RESOLVES a refusal, so treating this as "no
        // suppression" is exactly how a refused read becomes a mailed opt-out.
        return {
          success: false,
          providerKey: "compliance_gate",
          error: `Outbound blocked: suppression precheck could not be read (${supLeadError.message})`,
        }
      }
      const supRow = supLead as {
        email?: string | null
        phone?: string | null
        dnc_status?: boolean | null
        direct_mail_opt_out?: boolean | null
        opt_out_channels?: string[] | null
      } | null
      supEmail = supRow?.email ?? null
      supPhone = supRow?.phone ?? null

      // THE ROW'S OWN FLAGS, read BEFORE the identifier-keyed arm — because for the
      // lead this channel exists to reach there may be no identifier at all.
      // checkSuppression matches suppression rows by email or phone; a MAIL-ONLY lead
      // (address, no email, no phone) has neither, so that arm cannot fire and the gate
      // would pass vacuously while `direct_mail_opt_out` sits true on the row. Proved
      // live: a mail-only lead with dnc_status=t, direct_mail_opt_out=t and
      // opt_out_channels={email,sms,phone,direct_mail} produced ZERO keyable
      // suppression rows. The flags ARE the record for that lead, so they are read here.
      if (supRow?.dnc_status === true || supRow?.direct_mail_opt_out === true) {
        console.warn(`[Dispatch] direct mail blocked for lead ${params.leadId}: lead row carries a mail opt-out`)
        return {
          success: false,
          providerKey: "compliance_gate",
          error: "Outbound blocked: this lead has opted out of mail",
        }
      }
      if (Array.isArray(supRow?.opt_out_channels) && supRow.opt_out_channels.some((c) => c === "direct_mail" || c === "mail")) {
        // Both spellings on purpose: the lead row's channel list and
        // contact_suppression_list.channel are DIFFERENT vocabularies for one idea
        // ("direct_mail" vs the CHECK-admitted "mail"), and honouring only one of them
        // is how a recorded opt-out becomes an unhonoured one.
        console.warn(`[Dispatch] direct mail blocked for lead ${params.leadId}: mail is in opt_out_channels`)
        return {
          success: false,
          providerKey: "compliance_gate",
          error: "Outbound blocked: this lead has opted out of mail",
        }
      }
    }
    const mailSuppression = await checkSuppression({
      brokerageId: params.brokerageId,
      contactId:   params.contactId ?? null,
      email:       supEmail,
      phone:       supPhone,
      channel:     "mail",
    })
    if (mailSuppression.suppressed) {
      console.warn(
        `[Dispatch] direct mail blocked for ${params.contactId ?? params.leadId}: ${mailSuppression.reason}`,
      )
      return {
        success: false,
        providerKey: "compliance_gate",
        error: `Outbound blocked: ${mailSuppression.reason}`,
      }
    }
  }

  // ── Lead consent + verification gate ──────────────────────────────────────
  // Wave 36 — leads are unconsented for most channels; the only outbound
  // touches permitted to a lead row are direct_mail and email. For mail
  // specifically, we additionally require `mailing_address_verified=true`
  // on the lead so we don't pay Lob for an undeliverable piece. The gate
  // lives inside dispatch (not just at the trigger) so every caller —
  // workflow adapters, AI-ISA, marketing-agent resolutions — is covered.
  if (params.leadId) {
    const svc = createServiceClient()
    const { data: lead } = await svc
      .from("leads")
      .select("brokerage_id, mailing_address_verified, mailing_address_source, mailing_address, mailing_city, mailing_state, mailing_zip")
      .eq("id", params.leadId)
      .maybeSingle()
    const l = lead as (MailingGateLead & { brokerage_id: string | null }) | null
    if (!l) {
      return { success: false, providerKey: "lead_gate", error: "Lead not found" }
    }
    if (l.brokerage_id !== params.brokerageId) {
      return { success: false, providerKey: "lead_gate", error: "Lead/brokerage tenant mismatch" }
    }
    if (l.mailing_address_verified !== true) {
      return {
        success:     false,
        providerKey: "lead_gate",
        error:       "Lead mailing address not verified — Lob send blocked. Run lob-address-verify first.",
      }
    }

    // ── CASS deliverability gate ────────────────────────────────────────────
    // mailing_address_verified=true only means "an address string exists" (set naively at promotion).
    // Before we pay Lob for a physical piece, CASS-verify ONCE via Lob so the flag the gate above
    // trusts is HONEST. Deliverable → standardize + mark lob_cass (idempotent). Undeliverable → block
    // this send AND correct the flag to false so speed-to-lead stops choosing direct_mail for this cold
    // lead. Provider-gated (no LOB_API_KEY / transient → defer to the existing flag, never block).
    if (needsCassCheck(l)) {
      const { verifyAddressViaLob } = await import("@/lib/external/lob-address-verify")
      const { data: lob, cost } = await verifyAddressViaLob({
        primary_line: l.mailing_address ?? "",
        city:         l.mailing_city ?? undefined,
        state:        l.mailing_state ?? undefined,
        zip_code:     l.mailing_zip ?? undefined,
      })
      const decision = interpretLobForGate(lob)
      if (decision.action !== "defer") {
        await svc.from("leads").update({ ...decision.patch, updated_at: new Date().toISOString() }).eq("id", params.leadId)
        if (cost > 0) {
          try {
            const { meterVendorSpend } = await import("@/lib/vendor-governance/meter-vendor")
            await meterVendorSpend({ vendorName: "lob", usageType: "address_verify", cost, brokerageId: params.brokerageId, systemSource: "direct_mail_gate", metadata: { leadId: params.leadId, result: decision.reason } })
          } catch { /* metering never breaks the send */ }
        }
      }
      if (decision.action === "block") {
        return {
          success:     false,
          providerKey: "lead_gate",
          error:       "Lead mailing address failed Lob CASS verification (undeliverable) — Lob send blocked; flag corrected so it won't retry on mail.",
        }
      }
    }
  }

  // ── De-Conflict gate (over-touch suppression) ────────────────────────────
  // Lob postcards/letters land in mailboxes — physical touches count too.
  // The default policy caps 1 piece / 30 days per contact OR lead (lead postcards
  // are a real nurture channel — they get the same physical-mail over-touch cap).
  if (params.contactId || params.leadId) {
    const deferred = await deconflictGate({
      brokerageId:  params.brokerageId,
      channel:      "mail",
      contactId:    params.contactId ?? null,
      leadId:       params.leadId ?? null,
      systemSource: params.systemSource,
    })
    if (deferred) return deferred
  }

  // ── FAIR-HOUSING CONTENT BACKSTOP — scan the personalized mail copy (mergeVars) ──
  const fhMail = await contentSafetyBackstop({
    brokerageId: params.brokerageId, channel: "direct_mail",
    parts: Object.values(params.mergeVars ?? {}),
    isAutonomous: isAutonomousSend(params), contactId: params.contactId ?? null,
    actorUserId: params.userId ?? null, systemSource: params.systemSource,
  })
  if (fhMail.blocked) return { success: false, providerKey: "content_safety_gate", error: `Outbound blocked: ${fhMail.reason}` }

  const { providerKey } = await resolveProvider({
    providerType: "direct_mail",
    actorContext: {
      userId: params.userId ?? params.brokerageId,
      brokerageId: params.brokerageId,
      teamId: params.teamId,
    },
  })
  // providerKey will always be 'lob' until a superadmin override exists

  // Real Lob integration (letters / postcards / self-mailers). Feature code calls
  // dispatchDirectMail; if Lob keys are absent it returns a clean unconfigured error.
  const lobApiKey = process.env.LOB_API_KEY
  if (!lobApiKey) {
    const result: DispatchResult = {
      success: false,
      providerKey,
      error: "Direct mail provider (Lob) not configured. Add LOB_API_KEY to environment variables.",
    }
    return result
  }

  const lob = LobSDK(lobApiKey)
  const pieceType: DirectMailPieceType = params.pieceType ?? "letter"
  const to = {
    name: params.recipientName,
    address_line1: params.mailingAddress,
    ...(params.mailingAddress2 ? { address_line2: params.mailingAddress2 } : {}),
    address_city: params.city,
    address_state: params.state,
    address_zip: params.zip,
    address_country: "US",
  }
  const from = process.env.LOB_RETURN_ADDRESS_ID
  const mergeVars = params.mergeVars ?? {}

  // Approx Lob per-piece cost by type (telemetry only; reconciled against Lob invoices).
  const COST: Record<DirectMailPieceType, number> = { letter: 1.2, postcard: 0.78, self_mailer: 1.05 }

  // Budget gate — Lob is the priciest platform-paid vendor. The SAME shared
  // pre-flight the email/SMS/phone dispatchers run: month-to-date vendor-spend
  // ceiling BEFORE incurring spend, so a runaway agent or bulk mail send can't
  // blow past the brokerage's plan-tier budget on the most expensive channel.
  // addCost is the per-piece figure BY MAIL SIZE (letter/postcard/self-mailer)
  // and matches the figure metered into vendor_usage_tracking below. A blocked
  // send is ledgered (Exception Center); a broken budget check FAILS OPEN.
  const mailBudget = await vendorBudgetPreflight({
    brokerageId: params.brokerageId,
    channel: "direct_mail",
    vendorKey: "lob",
    addCost: COST[pieceType],
    systemSource: params.systemSource,
  })
  if (mailBudget.refusal) return mailBudget.refusal

  let data: { id?: string }
  try {
    if (pieceType === "postcard") {
      data = await lob.postcards.create({
        to,
        from,
        front: params.templateId,
        back: params.backTemplateId ?? process.env.LOB_POSTCARD_BACK_ID ?? params.templateId,
        size: params.size ?? "4x6",
        merge_variables: mergeVars,
      })
    } else if (pieceType === "self_mailer") {
      data = await lob.selfMailers.create({
        to,
        from,
        inside: params.templateId,
        outside: params.backTemplateId ?? params.templateId,
        size: params.size ?? "6x18_bifold",
        merge_variables: mergeVars,
        color: params.color ?? true,
      })
    } else {
      data = await lob.letters.create({
        to,
        from,
        file: params.templateId,
        merge_variables: mergeVars,
        color: params.color ?? false,
      })
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, providerKey, error: `Lob API error: ${msg}` }
  }

  void logVendorUsage({
    vendorName: providerKey,
    usageType: "pieces_mailed",
    unitCount: 1,
    estimatedCost: COST[pieceType],
    systemSource: params.systemSource ?? "dispatch",
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    leadId: params.leadId,
    metadata: {
      lob_id: data.id,
      piece_type: pieceType,
      template_id: params.templateId,
      provider_key: providerKey,
      ...(params.metadata ?? {}),
    },
  })

  // ── OUTCOME RECONCILIATION: a Lob ACCEPT is not a delivery ─────────────────
  // A physical piece takes days and can be re-routed or returned to sender. The
  // claim opens pending against the Lob piece id; app/api/webhooks/lob-events
  // proves or contradicts it as the piece moves.
  void (async () => {
    const { recordOutcomeClaim } = await import("@/lib/outcomes/reconciliation-ledger")
    await recordOutcomeClaim({
      brokerageId: params.brokerageId,
      channel: "direct_mail",
      // Lob's SDK types id as optional; a piece with no id cannot be reconciled, so
      // the claim records that honestly rather than coercing a fake reference.
      providerRef: data.id ?? null,
      claimedStatus: "accepted_by_lob",
      entityType: "direct_mail",
      contactId: params.contactId ?? null,
      leadId: params.leadId ?? null,
      claimedByManager: "campaign_orchestrator",
    })
  })().catch(() => {})

  return { success: true, providerKey, messageId: data.id, budgetWarning: mailBudget.warning }
}

// ─── VIDEO (superadmin-controlled, system-only) ───────────────────────────────
// video is SYSTEM_ONLY and the engine is PLATFORM-LOCKED to D-ID + ElevenLabs —
// agent's own avatar (did_photo_url / did_video_url) + cloned voice
// (elevenlabs_voice_id) from agent_voice_profiles. HeyGen is NOT a selectable or
// reachable path: there is no HeyGen branch.

export interface DispatchVideoParams extends DispatchActorContext {
  /** Rendered narration script (the D-ID avatar reads this). */
  templateId: string
  recipientEmail: string
  recipientName?: string
  scriptVars?: Record<string, string>
  metadata?: Record<string, unknown>
}

export async function dispatchVideo(params: DispatchVideoParams): Promise<DispatchResult> {
  // ── AUTONOMY GATE: hold an autonomous send from a manager outside its trust boundary ──
  const autonomyHeld = await autonomyGate(params)
  if (autonomyHeld) return autonomyHeld
  // ── De-Conflict gate (over-touch suppression) ────────────────────────────
  // OWNER RULING: video is NOT a channel. The channels are email / phone /
  // voicedrop / in-app / sms / blog / direct mail / ad / newsletter / podcast —
  // a video is DELIVERED IN an sms or an email. This function takes a
  // recipientEmail and sends over email, so the send consumes the CONTACT'S
  // EMAIL ALLOWANCE and is counted against it. A "video" cap counted nothing:
  // no ledger stores 'video' as a distinct budget, so it capped one imaginary
  // lane while the real email lane stayed uncounted for this send.
  //
  // NOT REINVENTED HERE: the old comment claimed a "1 video / 21 days" render
  // budget. D-ID render cost IS real, but it is a SPEND control, not an
  // over-touch control, and the platform already meters renders (usageType:
  // "video_renders" below). Adding a second cap shaped like a channel is how
  // the video-as-channel drift started; a render budget belongs on the metering
  // side and is the owner's call, not something to smuggle back in here.
  if (params.contactId) {
    const deferred = await deconflictGate({
      brokerageId:  params.brokerageId,
      channel:      "email",
      contactId:    params.contactId,
      recipientEmail: params.recipientEmail,
      systemSource: params.systemSource,
    })
    if (deferred) return deferred
  }

  const { providerKey } = await resolveProvider({
    providerType: "video",
    actorContext: {
      userId: params.userId ?? params.brokerageId,
      brokerageId: params.brokerageId,
      teamId: params.teamId,
    },
  })

  // BUSINESS RULE (platform-locked): the avatar/explainer video engine is D-ID +
  // ElevenLabs ONLY. No provider selection, no HeyGen cost-fallback.
  return dispatchVideoViaDID({ params, providerKey })
}

// ─── D-ID + ElevenLabs path (default per plan) ────────────────────────────────
async function dispatchVideoViaDID({
  params,
  providerKey,
}: {
  params: DispatchVideoParams
  providerKey: string
}): Promise<DispatchResult> {
  const didApiKey = process.env.DID_API_KEY
  const elApiKey = process.env.ELEVENLABS_API_KEY

  if (!didApiKey || !elApiKey) {
    return {
      success: false,
      providerKey,
      error:
        "Video provider (D-ID + ElevenLabs) not configured. Set DID_API_KEY and ELEVENLABS_API_KEY in the platform Settings → Providers page.",
    }
  }

  // Resolve agent's D-ID + ElevenLabs identity profile.
  // agent_voice_profiles.agent_id FKs to agents(id), NOT users(id).
  // Callers pass users.id (params.userId), so we resolve through the
  // canonical helper so future producers don't re-discover the gotcha.
  const { createServiceClient } = await import("@/lib/supabase/service")
  const supabase = createServiceClient()

  // IDENTITY CLASS. params.agentId is ALREADY an agents id — feeding it to a
  // users→agents resolver looked up `agents WHERE user_id = <an agents id>`,
  // matched nothing, and returned the misleading "Voice clone not set up" for
  // an agent whose clone existed. Only params.userId needs resolving.
  let agentRecordId: string | null = params.agentId ?? null
  if (!agentRecordId) {
    if (!params.userId) {
      return { success: false, providerKey, error: "Cannot generate video — agent ID missing" }
    }
    const { resolveUserIdToAgentRecord } = await import("@/lib/kernel/agent-identity-resolver")
    agentRecordId = await resolveUserIdToAgentRecord(params.userId, params.brokerageId)
  }
  if (!agentRecordId) {
    return { success: false, providerKey, error: "Voice clone not set up. The agent must complete Settings → Voice & Avatar before videos can be generated." }
  }

  const { data: didProfile } = await supabase
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id, did_photo_url, did_video_url, default_expression, expression_intensity")
    .eq("agent_id", agentRecordId)
    .maybeSingle()

  if (!didProfile?.elevenlabs_voice_id) {
    return {
      success: false,
      providerKey,
      error: "Voice clone not set up. The agent must complete Settings → Voice & Avatar before videos can be generated.",
    }
  }

  const sourceUrl = didProfile.did_video_url ?? didProfile.did_photo_url
  if (!sourceUrl) {
    return {
      success: false,
      providerKey,
      error: "Avatar not set up. The agent must upload a headshot or video clip in Settings → Voice & Avatar.",
    }
  }

  const isVideoSource = !!didProfile.did_video_url

  // Render the script with template variables filled in.
  const renderedScript = (params.scriptVars ? Object.entries(params.scriptVars) : []).reduce(
    (acc, [k, v]) => acc.replace(new RegExp(`{{\\s*${k}\\s*}}`, "g"), String(v ?? "")),
    String(params.templateId ?? "")
  ) || JSON.stringify(params.scriptVars ?? {})

  // ─── 1. Generate audio via ElevenLabs TTS ───────────────────────────────────
  const ttsRes = await callConnector<Buffer>({
    connector: "elevenlabs",
    baseUrl: "https://api.elevenlabs.io",
    path: `/v1/text-to-speech/${didProfile.elevenlabs_voice_id}`,
    method: "POST",
    auth: { style: "header", name: "xi-api-key", value: elApiKey },
    headers: { Accept: "audio/mpeg" },
    responseType: "arraybuffer",
    body: { text: renderedScript, model_id: "eleven_multilingual_v2" },
  })

  if (!ttsRes.ok || !ttsRes.data) {
    return { success: false, providerKey: "did", error: `ElevenLabs TTS error: ${ttsRes.error ?? `HTTP ${ttsRes.status}`}` }
  }

  // For D-ID we need a hosted audio URL — write to Supabase storage.
  const audioPath = `isa-videos/${agentRecordId}/${Date.now()}.mp3`
  const { error: uploadError } = await supabase.storage
    .from("media")
    .upload(audioPath, new Uint8Array(ttsRes.data), { contentType: "audio/mpeg", upsert: false })
  if (uploadError) {
    return { success: false, providerKey: "did", error: `Failed to host audio: ${uploadError.message}` }
  }
  const { data: pub } = supabase.storage.from("media").getPublicUrl(audioPath)
  const audioUrl = pub.publicUrl

  // ─── 2. Submit to D-ID ──────────────────────────────────────────────────────
  // driver_expressions controls facial affect — without it the avatar reads
  // monotone, which is the #1 reason talking-head videos feel "uncanny" in
  // real-estate marketing. Default is a warm "happy" at 0.7 intensity (per
  // m112); per-agent override is read from agent_voice_profiles.
  const expression = (didProfile as { default_expression?: string }).default_expression ?? "happy"
  const intensity  = Number((didProfile as { expression_intensity?: number }).expression_intensity ?? 0.7)
  const driverExpressions = {
    expressions: [{ start_frame: 0, expression, intensity }],
  }

  const didPayload = isVideoSource
    ? {
        source_url: sourceUrl,
        script: { type: "audio", audio_url: audioUrl },
        config: { stitch: true, result_format: "mp4", driver_expressions: driverExpressions },
      }
    : {
        source_url: sourceUrl,
        script: { type: "audio", audio_url: audioUrl },
        driver_url: "bank://natural",
        config: { stitch: true, result_format: "mp4", fluent: true, pad_audio: 0.0, driver_expressions: driverExpressions },
      }

  const didRes = await callConnector<{ id?: string }>({
    connector: "did",
    baseUrl: "https://api.d-id.com",
    path: isVideoSource ? "/clips" : "/talks",
    method: "POST",
    auth: { style: "basic", username: didApiKey, password: "" },
    body: didPayload,
  })

  if (!didRes.ok) {
    return { success: false, providerKey: "did", error: `D-ID API error: ${didRes.error ?? `HTTP ${didRes.status}`}` }
  }

  const didData = didRes.data ?? {}

  void logVendorUsage({
    vendorName: "did",
    usageType: "video_renders",
    unitCount: 1,
    estimatedCost: 0.3, // D-ID + ElevenLabs ~$0.30/render combined
    systemSource: params.systemSource ?? "dispatch",
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    leadId: params.leadId,
    metadata: {
      did_talk_id: didData.id,
      mode: isVideoSource ? "clip" : "talk",
      recipient_email: params.recipientEmail,
      provider_key: "did",
      ...(params.metadata ?? {}),
    },
  })

  return { success: true, providerKey: "did", messageId: didData.id }
}
