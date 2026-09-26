/**
 * ISA HANDOFF BRIEF GENERATOR
 *
 * At the moment a lead is qualified, this generator pulls together everything
 * the ISA captured during qualification and assembles a structured brief that:
 *   - Is written to leads.isa_handoff_brief (jsonb)
 *   - Is carried forward to contacts.isa_handoff_brief on conversion
 *   - Renders as the "Qualification Summary" card the agent sees the moment
 *     the contact lands in their CRM
 *
 * Pulls from:
 *   - leads.* (motivation, timeline, budget, urgency, lender_status, equity_estimate, persona)
 *   - ai_isa_qualifications (qualification_signals — confirmedIntent, urgency, etc.)
 *   - ai_isa_calls (call durations + outcomes)
 *   - ai_isa_activities (touchpoints — emails, replies, calls)
 */

import { createServiceClient } from "@/lib/supabase/service"
import { timelineLabel } from "@/constants/crm-standards"

export interface IsaHandoffBrief {
  generatedAt: string
  qualificationScore: number | null
  contactType: "buyer" | "seller" | "investor" | "both" | null
  summary: string
  motivation: {
    type: string | null
    confidence: number | null
    detail: string | null
  }
  timeline: {
    label: string | null
    months: number | null
    raw: string | null
  }
  urgency: "low" | "medium" | "high" | "urgent" | null
  budget: {
    min: number | null
    max: number | null
    formattedRange: string | null
  }
  property: {
    address: string | null
    zipCode: string | null
    type: string | null
    beds: number | null
    baths: number | null
  }
  lender: {
    status: "cash" | "pre_approved" | "needs_pre_approval" | "unknown" | null
    notes: string | null
  }
  equity: {
    estimate: number | null
    formatted: string | null
  }
  conversationHistory: Array<{
    when: string
    channel: "email" | "sms" | "call" | "form" | "other"
    summary: string
    outcome: string | null
  }>
  suggestedNextStep: {
    action: string
    reason: string
    cta: "schedule_consultation" | "send_message" | "schedule_listing_appointment" | "schedule_tour" | null
  }
}

function fmtCurrency(n: number | null | undefined): string | null {
  if (n == null) return null
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1000)}k`
  return `$${n}`
}

function deriveContactType(motivationType: string | null): IsaHandoffBrief["contactType"] {
  if (!motivationType) return null
  const m = motivationType.toLowerCase()
  if (m.includes("investor")) return "investor"
  if (m.includes("seller")) return "seller"
  if (m.includes("both")) return "both"
  if (m.includes("buyer")) return "buyer"
  return null
}

function urgencyFromSignals(urgency: string | null, timeline: string | null): IsaHandoffBrief["urgency"] {
  if (urgency === "urgent" || urgency === "high" || urgency === "medium" || urgency === "low") return urgency
  if (!timeline) return null
  const t = timeline.toLowerCase()
  if (t.includes("immediate") || t.includes("asap") || t.includes("this week")) return "urgent"
  if (t.includes("month") && /\b[12]\b/.test(t)) return "high"
  if (t.includes("3 month") || t.includes("90 day")) return "medium"
  return "low"
}

/**
 * Compose the handoff brief from all ISA-captured data and write it to the
 * lead. Returns the brief.
 */
export async function generateAndStoreHandoffBrief(params: {
  leadId: string
  brokerageId: string
}): Promise<IsaHandoffBrief | null> {
  const { leadId, brokerageId } = params
  const supabase = createServiceClient()

  // 1. Load lead
  const { data: leadData } = await supabase
    .from("leads")
    .select(
      "id, first_name, last_name, motivation_type, motivation_confidence, " +
        "timeline, urgency_level, budget_min, budget_max, lender_status, " +
        "equity_estimate, property_interest, property_zip_code, persona, lead_score"
    )
    .eq("id", leadId)
    .single()

  if (!leadData) return null

  const lead = leadData as unknown as {
    id: string
    first_name: string | null
    last_name: string | null
    motivation_type: string | null
    motivation_confidence: number | null
    timeline: string | null
    urgency_level: string | null
    budget_min: number | null
    budget_max: number | null
    lender_status: "cash" | "pre_approved" | "needs_pre_approval" | "unknown" | null
    equity_estimate: number | null
    property_interest: string | null
    property_zip_code: string | null
    persona: string | null
    lead_score: number | null
  }

  // 2. Load latest qualification signals
  const { data: qualRow } = await supabase
    .from("ai_isa_qualifications")
    .select("qualification_score, qualification_signals, qualified_at, notes")
    .eq("lead_id", leadId)
    .order("qualified_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // 3. Load conversation/touch history
  const [{ data: activities }, { data: calls }] = await Promise.all([
    supabase
      .from("ai_isa_activities")
      .select("activity_type, outcome, summary, channel, created_at")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true })
      .limit(20),
    supabase
      .from("ai_isa_calls")
      .select("appointment_set, appointment_datetime, ai_response_summary, created_at")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true })
      .limit(10),
  ])

  // 4. Build conversation history
  const history: IsaHandoffBrief["conversationHistory"] = []
  for (const a of activities ?? []) {
    const row = a as {
      activity_type: string | null
      channel: string | null
      summary: string | null
      outcome: string | null
      created_at: string
    }
    const activityType = row.activity_type ?? ""
    const chanHint = `${row.channel ?? ""} ${activityType}`
    let channel: IsaHandoffBrief["conversationHistory"][number]["channel"] = "other"
    if (chanHint.includes("email")) channel = "email"
    else if (chanHint.includes("sms") || chanHint.includes("text")) channel = "sms"
    else if (chanHint.includes("call") || chanHint.includes("phone")) channel = "call"
    else if (chanHint.includes("form")) channel = "form"

    history.push({
      when: row.created_at,
      channel,
      summary: row.summary ?? activityType.replace(/_/g, " "),
      outcome: row.outcome ?? null,
    })
  }
  for (const c of calls ?? []) {
    const cc = c as { appointment_set: boolean; ai_response_summary: string | null; created_at: string }
    history.push({
      when: cc.created_at,
      channel: "call",
      summary: cc.ai_response_summary ?? "Call",
      outcome: cc.appointment_set ? "appointment_set" : null,
    })
  }
  history.sort((a, b) => a.when.localeCompare(b.when))

  // 5. Suggested next step (rules — the agent can override)
  const contactType = deriveContactType(lead.motivation_type)
  const urgency = urgencyFromSignals(lead.urgency_level, lead.timeline)
  let suggestedAction = "Make first agent contact within 24 hours"
  let suggestedReason = "Standard SLA for newly qualified leads"
  let suggestedCta: IsaHandoffBrief["suggestedNextStep"]["cta"] = "send_message"

  if (contactType === "seller") {
    suggestedAction = "Schedule listing consultation this week"
    suggestedReason = "Motivation is hot — strike while urgency is high"
    suggestedCta = "schedule_listing_appointment"
  } else if (contactType === "buyer") {
    suggestedAction = "Schedule property tour or buyer consultation"
    suggestedReason = "Buyer is actively looking and verified financially"
    suggestedCta = "schedule_tour"
  } else if (contactType === "investor") {
    suggestedAction = "Send qualifying property list + ROI analysis"
    suggestedReason = "Investor responds to data — lead with the deal, not the relationship"
    suggestedCta = "send_message"
  }

  if (urgency === "urgent" || urgency === "high") {
    suggestedAction = `Call NOW — ${suggestedAction.toLowerCase()}`
  }

  // 6. Compose summary line
  const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || "Contact"
  const motivationLabel = (lead.motivation_type ?? "").replace(/_/g, " ").trim()
  const summary =
    motivationLabel && lead.timeline
      ? `${fullName} — ${motivationLabel}, ${timelineLabel(lead.timeline)}`
      : motivationLabel
      ? `${fullName} — ${motivationLabel}`
      : `${fullName} — qualified by ISA`

  // 7. Assemble brief
  const brief: IsaHandoffBrief = {
    generatedAt: new Date().toISOString(),
    qualificationScore:
      (qualRow as { qualification_score: number | null } | null)?.qualification_score ?? lead.lead_score ?? null,
    contactType,
    summary,
    motivation: {
      type: lead.motivation_type,
      confidence: lead.motivation_confidence,
      detail: (qualRow as { notes: string | null } | null)?.notes ?? null,
    },
    timeline: {
      // The canonical bucket label (constants/crm-standards.ts TIMELINE_LABELS) — this field is
      // rendered verbatim by the qualification summary card, and it used to carry the raw DB
      // value ("1-3_months"). `raw` keeps the stored value for anything that parses it.
      label: timelineLabel(lead.timeline),
      months: parseTimelineMonths(lead.timeline),
      raw: lead.timeline,
    },
    urgency,
    budget: {
      min: lead.budget_min,
      max: lead.budget_max,
      formattedRange:
        lead.budget_min || lead.budget_max
          ? `${fmtCurrency(lead.budget_min) ?? "?"} - ${fmtCurrency(lead.budget_max) ?? "?"}`
          : null,
    },
    property: {
      address: lead.property_interest,
      zipCode: lead.property_zip_code,
      type: null,
      beds: null,
      baths: null,
    },
    lender: {
      status: lead.lender_status,
      notes: null,
    },
    equity: {
      estimate: lead.equity_estimate,
      formatted: fmtCurrency(lead.equity_estimate),
    },
    conversationHistory: history,
    suggestedNextStep: {
      action: suggestedAction,
      reason: suggestedReason,
      cta: suggestedCta,
    },
  }

  // 8. Persist to lead
  await supabase
    .from("leads")
    .update({
      isa_handoff_brief: brief as unknown as Record<string, unknown>,
      qualification_summary: summary,
      updated_at: new Date().toISOString(),
    })
    .eq("id", leadId)

  return brief
}

function parseTimelineMonths(timeline: string | null): number | null {
  if (!timeline) return null
  const m = timeline.match(/(\d+)\s*(month|months|mo)/i)
  if (m) return parseInt(m[1], 10)
  const d = timeline.match(/(\d+)\s*(day|days)/i)
  if (d) return Math.ceil(parseInt(d[1], 10) / 30)
  if (/immediate|asap|now/i.test(timeline)) return 0
  if (/this week/i.test(timeline)) return 0
  if (/this month/i.test(timeline)) return 1
  return null
}
