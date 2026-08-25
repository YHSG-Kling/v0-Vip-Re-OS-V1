// lib/kernel/ai-sentinel.ts
//
// THE AI SENTINEL — license-risk sentiment escalation.
//
// The live-kernel equivalent of the legacy workflows/negative-feedback-escalation.json
// ("scan inbound comms for license-risk sentiment → halt automation + alert the broker
// immediately"). It protects the brokerage's LICENSE and BRAND: a complaint that could
// become a state-board or Fair-Housing complaint must INSTANTLY halt AI automation on
// the contact and escalate to a human broker — the AI never tries to talk its way out
// of a legal threat.
//
// ── The tier ABOVE plain opt-out ──────────────────────────────────────────────
// The SEED that already exists — detectNegativeIntent + haltEngagementForNegativeReply
// (lib/ai-isa/conversation-handler.ts) — is BINARY: "not interested / stop" → DNC. The
// Sentinel is the RISK-TIERED elevation on top of it. Not every angry word is a license
// risk; an explicit threat to report you to the board, a discrimination accusation, or a
// "my lawyer will be in touch" is. classifyLicenseRisk separates:
//   · 'critical' — explicit complaint / board / lawyer / discrimination / Fair-Housing
//                  grievance / threat. HALT + escalate to the broker (notification
//                  priority 'critical').
//   · 'elevated' — strong dissatisfaction / escalation language ("furious", "this is
//                  unacceptable", "I want to speak to your manager"). HALT + escalate
//                  (priority 'high') — a human reviews before automation resumes.
//   · 'none'     — normal flow continues (no-op). The Sentinel is HONEST: it never
//                  fabricates a risk where there is none.
//
// ── Reuse, never rebuild ──────────────────────────────────────────────────────
//   · HALT     — the SAME halt the opt-out seed uses (contacts.isa_reengage_allowed=false
//                + dnc-on-critical, leads.call_stop_flag) so the ISA goes dormant on the
//                contact exactly as it does for an opt-out.
//   · ESCALATE — the EXISTING notifications rail to broker/admin/compliance users (the
//                same shape fire-drills.ts and manager-signals.ts use), priority by tier.
//                A license-risk message NEVER gets an AI auto-reply — it pages a human.
//   · RECORD   — the canonical `activities` ledger (free-text activity_type, like the
//                opt-out seed's 'lead_opted_out') + an audit line on the manager_signals
//                bus. No fabricated table.
//
// ── Fair-Housing reuse ────────────────────────────────────────────────────────
// Protected-class grievance detection reuses the ENCODED FAIR_HOUSING_PATTERNS (the
// single source of truth the content gates share) — the Sentinel never invents legal
// rules. A complainant invoking a protected class against the brokerage ("you steered me
// away because I have kids") is a CRITICAL license risk.
//
// NOT server-only (simulator-driven, like the rest of the kernel loaders). Only ever
// writes through a caller-supplied / service client — never import client-side.

import { createServiceClient } from "@/lib/supabase/service"
import { FAIR_HOUSING_PATTERNS } from "@/lib/compliance-rules/fair-housing-patterns"

type Svc = ReturnType<typeof createServiceClient>

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — PURE classifier (deterministic patterns, no I/O, testable)
// ─────────────────────────────────────────────────────────────────────────────

export type LicenseRiskTier = "none" | "elevated" | "critical"

export interface LicenseRiskClassification {
  tier: LicenseRiskTier
  /** Human-readable matched signals, e.g. "legal threat: lawyer", "fair-housing grievance". */
  signals: string[]
}

/**
 * CRITICAL signals — an explicit move toward a regulator / court / discrimination
 * grievance. Each is phrased as a license/brand risk a human broker must own NOW.
 * Patterns are intentionally narrow (a complaint AGAINST the brokerage), not generic
 * profanity — honesty over noise.
 */
const CRITICAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  // Regulatory / board / licensing complaints
  { label: "board/license complaint", pattern: /\b(report|reporting|reported|reporting\s+you)\b[\s\S]{0,40}?\b(real\s+estate\s+commission|real\s+estate\s+board|licensing\s+board|license\s+board|state\s+board|department\s+of\s+real\s+estate|the\s+dre|the\s+nar|association\s+of\s+realtors|realtor\s+board)\b/i },
  { label: "board/license complaint", pattern: /\b(report|reporting|reported)\s+(you|your\s+brokerage|your\s+agency|this)\s+to\s+(the\s+)?(board|commission|state)\b/i },
  { label: "board/license complaint", pattern: /\b(file|filing|filed)\s+(a\s+)?(formal\s+)?(complaint|grievance)\b/i },
  { label: "board/license complaint", pattern: /\b(license|licence)\s+(complaint|revoked|pulled|suspended|investigation)\b/i },
  { label: "regulatory complaint", pattern: /\b(report\s+you\s+to|complaint\s+to|contact)\s+(the\s+)?(hud|attorney\s+general|ftc|cfpb|bbb|better\s+business\s+bureau)\b/i },
  // Legal threats
  { label: "legal threat: lawyer", pattern: /\b(my|our|a)\s+(lawyer|attorney|legal\s+team|counsel|solicitor)\b/i },
  { label: "legal threat: lawyer", pattern: /\b(lawyer|attorney)\s+(will\s+)?(be\s+in\s+touch|contact|call|reach\s+out|handle)\b/i },
  { label: "legal threat: sue", pattern: /\b(sue|suing|lawsuit|litigation|legal\s+action|take\s+(you|this)\s+to\s+court|see\s+you\s+in\s+court|press\s+charges)\b/i },
  { label: "legal threat: breach", pattern: /\b(breach\s+of\s+(contract|duty|fiduciary)|fraud|fraudulent|misrepresentation|negligence|liable|damages)\b/i },
  // Discrimination / Fair-Housing accusations (the brokerage is being ACCUSED)
  { label: "discrimination accusation", pattern: /\b(discriminat\w+|steered|steering|redlining|fair\s+housing|civil\s+rights|protected\s+class)\b/i },
  { label: "discrimination accusation", pattern: /\b(because\s+(of\s+)?my|due\s+to\s+my)\s+(race|color|colour|religion|national\s+origin|sex|gender|disability|familial\s+status|family\s+status|kids|children|age|ethnicity|nationality|orientation)\b/i },
]

/**
 * ELEVATED signals — strong dissatisfaction / escalation language that is NOT yet an
 * explicit legal/regulatory move, but is hot enough that a human (not the AI) should
 * take the next message. Below critical, above plain "not interested".
 */
const ELEVATED_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "escalation demand", pattern: /\b(speak|talk)\s+to\s+(your|a)\s+(manager|supervisor|broker|boss|superior)\b/i },
  { label: "escalation demand", pattern: /\b(escalate|escalating)\b/i },
  { label: "severe dissatisfaction", pattern: /\b(unacceptable|outraged?|outrageous|furious|appalled|disgusted|disgraceful|disgrace|ridiculous|insulting|insulted)\b/i },
  { label: "severe dissatisfaction", pattern: /\b(worst|horrible|terrible|awful)\s+(experience|service|agent|brokerage|company|realtor)\b/i },
  { label: "formal complaint intent", pattern: /\b(formal\s+complaint|i\s+(want|am\s+going|intend)\s+to\s+complain|leaving\s+a\s+(bad|negative|one\s*star)\s+review)\b/i },
  { label: "accusation of dishonesty", pattern: /\b(you\s+(lied|are\s+lying|deceived|scammed|cheated)|liar|scam|dishonest|misled\s+me)\b/i },
  { label: "demand to be left alone (hostile)", pattern: /\b(harass\w*|stop\s+harassing|this\s+is\s+harassment)\b/i },
]

/**
 * classifyLicenseRisk — PURE text → {tier, signals}.
 *
 * Deterministic. 'critical' wins over 'elevated' wins over 'none'. The Fair-Housing
 * pattern set is folded into the critical tier (a protected-class grievance against the
 * brokerage is a license risk). Honest: no match → {tier:'none', signals:[]} and the
 * normal flow continues untouched.
 */
export function classifyLicenseRisk(text: string): LicenseRiskClassification {
  const input = (text ?? "").toString()
  if (!input.trim()) return { tier: "none", signals: [] }

  const criticalSignals: string[] = []
  const elevatedSignals: string[] = []

  for (const { label, pattern } of CRITICAL_PATTERNS) {
    if (pattern.test(input)) criticalSignals.push(label)
  }

  // Fair-Housing / protected-class language — REUSE the encoded patterns (never invent
  // legal rules). These patterns were authored for OUTBOUND content steering, but a match
  // on an INBOUND grievance is exactly a protected-class complaint against the brokerage.
  for (const fh of FAIR_HOUSING_PATTERNS) {
    if (input.match(fh.pattern) !== null) {
      criticalSignals.push(`fair-housing grievance: ${fh.phrase}`)
    }
  }

  for (const { label, pattern } of ELEVATED_PATTERNS) {
    if (pattern.test(input)) elevatedSignals.push(label)
  }

  if (criticalSignals.length > 0) {
    return { tier: "critical", signals: dedupe(criticalSignals) }
  }
  if (elevatedSignals.length > 0) {
    return { tier: "elevated", signals: dedupe(elevatedSignals) }
  }
  return { tier: "none", signals: [] }
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr))
}

/** Notification priority per risk tier (notifications.priority CHECK: low|medium|high|critical). */
function priorityForTier(tier: Exclude<LicenseRiskTier, "none">): "high" | "critical" {
  return tier === "critical" ? "critical" : "high"
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — LIVE: halt automation + escalate to the broker + record the incident
// ─────────────────────────────────────────────────────────────────────────────

export interface RunSentinelParams {
  /** A contacts.id OR a leads.id — at least one identifies who the comm is from. */
  contactId?: string | null
  leadId?: string | null
  /** The inbound message text the Sentinel scans. */
  text: string
  brokerageId: string
}

export interface RunSentinelResult {
  tier: LicenseRiskTier
  signals: string[]
  /** True when automation was halted on the contact/lead (tier !== 'none'). */
  halted: boolean
  /** Number of broker/admin/compliance recipients escalated to. */
  escalated: number
  /** True when this (contact, incident) was already handled — idempotent rerun. */
  alreadyHandled: boolean
  /** activities.id of the recorded incident, when one was written. */
  incidentId?: string
  reason?: string
}

/**
 * runSentinelOnInbound — the live capstone. Scans an inbound message; on a license risk:
 *   1. HALT automation on the contact/lead (reuse the opt-out seed's halt fields).
 *   2. ESCALATE to the human broker via the EXISTING notifications rail (priority by tier).
 *   3. RECORD the incident on the canonical `activities` ledger + a manager_signals audit line.
 *
 * NEVER auto-replies — a license-risk message halts and pages a human. Idempotent per
 * (contact|lead, incident): a rerun on the same open incident does NOT double-escalate.
 * Honest: tier 'none' → pure no-op, the normal AI reply flow continues.
 */
export async function runSentinelOnInbound(
  params: RunSentinelParams,
  client?: Svc,
): Promise<RunSentinelResult> {
  const { text, brokerageId } = params
  const contactId = params.contactId ?? null
  const leadId = params.leadId ?? null

  const classification = classifyLicenseRisk(text)
  const { tier, signals } = classification

  // tier 'none' → no-op. Normal flow continues; the Sentinel adds nothing.
  if (tier === "none") {
    return { tier, signals, halted: false, escalated: 0, alreadyHandled: false }
  }

  if (!contactId && !leadId) {
    return { tier, signals, halted: false, escalated: 0, alreadyHandled: false, reason: "no contact or lead id" }
  }

  const supabase = client ?? createServiceClient()
  const now = new Date().toISOString()
  const entityType = contactId ? "contact" : "lead"
  const entityId = (contactId ?? leadId) as string

  // ── Idempotency: one sentinel incident per (entity) per window ──────────────
  // The incident escalation is notification-keyed on (type, entity_type, entity_id)
  // within 24h — covers BOTH contact and lead incidents identically (a lead has no
  // contact_id on the activities ledger, so the notification key is the durable one).
  // A rerun on the same still-open incident must NOT double-halt-escalate-record.
  const incidentActivityType = "ai_sentinel_license_risk"
  const { data: existingEscalation } = await supabase
    .from("notifications")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("type", "ai_sentinel_license_risk")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .gte("created_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
    .limit(1)
    .maybeSingle()

  if (existingEscalation) {
    return {
      tier,
      signals,
      halted: true,
      escalated: 0,
      alreadyHandled: true,
      reason: "sentinel incident already open for this entity (deduped)",
    }
  }

  // ── 1. HALT automation on the contact / lead (reuse the opt-out halt fields) ─
  let halted = false
  if (contactId) {
    const update: Record<string, unknown> = {
      isa_reengage_allowed: false,
      updated_at: now,
    }
    // A CRITICAL license risk (board/lawyer/discrimination) suppresses outreach hard,
    // exactly like the opt-out seed's DNC. ELEVATED halts ISA re-engagement and parks
    // the relationship for human review WITHOUT a permanent DNC (a human may re-open it).
    if (tier === "critical") {
      update.dnc_status = true
    } else {
      update.nurture_status = "paused_sentinel_review"
    }
    const { error } = await supabase
      .from("contacts")
      .update(update)
      .eq("id", contactId)
      .eq("brokerage_id", brokerageId)
    halted = !error
  } else if (leadId) {
    // Leads halt via the same fields the opt-out seed sets on a lead.
    const { error } = await supabase
      .from("leads")
      .update({
        call_stop_flag: true,
        ai_isa_owner: false,
        lifecycle_state: tier === "critical" ? "do_not_contact" : "needs_review",
        updated_at: now,
      })
      .eq("id", leadId)
      .eq("brokerage_id", brokerageId)
    halted = !error
  }

  // ── 2. ESCALATE to the human broker via the EXISTING notifications rail ──────
  // Broker / admin / compliance officer are the license-risk owners (the manager-signals
  // pattern routes to broker/admin; compliance_officer is the natural co-owner of a
  // license/Fair-Housing risk). priority by tier.
  // TIER-SAFE — broker/admin/compliance staff, or the solo agent when there's no separate oversight.
  const { resolveOrgRecipients } = await import("@/lib/kernel/org-recipients")
  const recipientRows = (await resolveOrgRecipients(supabase, brokerageId, { roles: ["broker", "admin", "compliance_officer"], limit: 20 })).map((id) => ({ id }))
  const priority = priorityForTier(tier)
  const signalLine = signals.join("; ")
  const excerpt = text.trim().slice(0, 280)
  const title =
    tier === "critical"
      ? "🚨 LICENSE RISK — AI automation HALTED, broker action needed"
      : "⚠️ Escalation risk — AI automation paused, review needed"
  const body = [
    `The AI Sentinel detected ${tier === "critical" ? "a LICENSE/LEGAL risk" : "strong escalation language"} in an inbound message and HALTED all AI automation on this ${entityType}.`,
    `Matched signals: ${signalLine}.`,
    `Message: "${excerpt}"`,
    `No automated reply was sent — this is yours to handle.`,
  ].join("\n")

  let escalated = 0
  for (const r of recipientRows) {
    const { error } = await supabase.from("notifications").insert({
      user_id: r.id,
      brokerage_id: brokerageId,
      type: "ai_sentinel_license_risk",
      title,
      body,
      priority,
      entity_type: entityType,
      entity_id: entityId,
      is_read: false,
    })
    if (!error) escalated += 1
  }

  // ── 3. RECORD the incident on the canonical activities ledger ───────────────
  // Mirrors the opt-out seed's activity write (free-text activity_type, no fabricated
  // table). status 'open' so the idempotency lookup + the timeline both see it.
  let incidentId: string | undefined
  // The incident row IS the halt record AND the idempotency key for it — if it
  // is rejected, the lookup that suppresses a duplicate halt finds nothing and
  // the Sentinel re-escalates. `{ data }` alone cannot see a refusal.
  const { data: incident, error: incidentError } = await supabase
    .from("activities")
    .insert({
      contact_id: contactId, // null for a lead — honest (activities has no lead_id column)
      brokerage_id: brokerageId,
      activity_type: incidentActivityType,
      title: `AI Sentinel: ${tier} license-risk halt`,
      description: [
        `AI automation halted on this ${entityType}. Escalated to ${escalated} broker/compliance recipient${escalated === 1 ? "" : "s"}.`,
        `Signals: ${signalLine}.`,
        `Message: "${excerpt}"`,
      ].join(" "),
      status: "open",
      notes: JSON.stringify({
        tier,
        signals,
        entity_type: entityType,
        entity_id: entityId,
        no_auto_reply: true,
        source: "ai_sentinel",
      }),
      created_at: now,
    })
    .select("id")
    .maybeSingle()
  if (incidentError) {
    console.error("[ai-sentinel] license-risk incident activity REJECTED — the halt has no compliance record and will not de-duplicate:", incidentError.message)
  }
  incidentId = (incident as { id?: string } | null)?.id

  // Audit line on the manager bus — the Command Center talk feed shows the Sentinel
  // convening the broker. AI ISA (the manager that owns inbound lead comms) raises it to
  // the Campaign Orchestrator (the governance/Command-Center hub the other escalations
  // route through, e.g. fire-drills). Consumed inline — the human action is the broker's,
  // not another manager's, so there is no dangling open business on the bus.
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const pub = await publishManagerSignal(
      {
        brokerageId,
        fromManager: "ai_isa",
        toManager: "campaign_orchestrator",
        signalType: "license_risk_escalated",
        message: `AI Sentinel: ${tier} license risk on a ${entityType} — automation halted, ${escalated} broker/compliance recipient(s) paged. Signals: ${signalLine}.`,
        entityType,
        entityId,
        contactId: contactId ?? null,
        payload: { tier, signals, no_auto_reply: true },
      },
      supabase,
    )
    if (pub.ok && pub.signalId && !pub.reason) {
      await supabase
        .from("manager_signals")
        .update({
          status: "consumed",
          consumed_at: now,
          consumed_action: `license-risk escalation executed: automation halted on the ${entityType} + broker/compliance paged (priority ${priority}); no auto-reply`,
        })
        .eq("id", pub.signalId)
    }
  } catch (e) {
    // The bus audit line is non-blocking — a halt + escalation must never depend on it.
    console.error("[ai-sentinel] manager-signal audit skipped:", (e as Error).message)
  }

  return {
    tier,
    signals,
    halted,
    escalated,
    alreadyHandled: false,
    incidentId,
  }
}
