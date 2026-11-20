"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"

// WAVE 155 (lane 155R4, G12): each write below leaves ONE agent_action_ledger receipt through ledgerSessionAction
// (lib/kernel/action-ledger.ts, the one helper): the SESSION user, the session's tenant (getAgentContext), the subject's opaque
// id and what changed — never prompt text or event payloads. NO cycle / idempotencyKey: a second save runs and records again.
// `refused` maps the helper's typed refusal (a malformed name) onto the export's own failure shape.
async function withSessionReceipt<T, R>(who: { userId: string; brokerageId: string | null } | null, action: string, subject: { type: string; id?: string | null }, riskClass: string, detail: Record<string, unknown>, run: () => Promise<T>, refused: (error: string) => R): Promise<T | R> {
  if (!who?.userId || !who.brokerageId) return run()
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const sid = subject.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subject.id) ? subject.id : null
  let ran = false
  const r = await ledgerSessionAction({ brokerageId: who.brokerageId, action, actor: { type: "user", userId: who.userId }, subject: { type: subject.type, id: sid, ref: sid ? null : subject.id ?? null }, riskClass, reasonCode: "HUMAN_REQUESTED", detail }, () => { ran = true; return run() })
  return ran ? (r as T) : refused((r as { error?: string }).error ?? "The action was not recorded and did not run.")
}

// Get auto-response settings for the current agent
export async function getAutoResponseSettings() {
  const supabase = await createClient()
  const { agentId } = await getAgentContext()

  if (!agentId) {
    return { success: false, error: "Not authenticated", settings: null }
  }

  const { data, error } = await supabase
    .from("auto_response_settings")
    .select("*")
    .eq("agent_id", agentId)
    .single()

  if (error && error.code !== "PGRST116") {
    console.error("Error fetching auto-response settings:", error)
    return { success: false, error: error.message, settings: null }
  }

  // Return default settings if none exist (live schema columns only).
  if (!data) {
    return {
      success: true,
      settings: {
        is_enabled: false,
        tone: "professional",
        delay_minutes: 5,
        keywords: [],
        custom_prompt: null,
      },
    }
  }

  return { success: true, settings: data }
}

// Update auto-response settings
export async function updateAutoResponseSettings(settings: {
  is_enabled?: boolean
  tone?: string
  delay_minutes?: number
  keywords?: string[]
  custom_prompt?: string | null
}) {
  const supabase = await createClient()
  const { agentId, brokerageId, userId } = await getAgentContext()

  if (!agentId) {
    return { success: false, error: "Not authenticated" }
  }
  return withSessionReceipt({ userId, brokerageId }, "ai_isa.auto_response.configure", { type: "agent", id: agentId }, "LOW_RISK_WRITE", { fields: Object.keys(settings ?? {}), is_enabled: settings?.is_enabled ?? null, tone: settings?.tone ?? null, delay_minutes: settings?.delay_minutes ?? null }, async () => {

  // auto_response_settings is keyed by agent_id (NOT NULL, UNIQUE, FK→agents).
  const { error } = await supabase
    .from("auto_response_settings")
    .upsert(
      {
        agent_id: agentId,
        brokerage_id: brokerageId,
        ...settings,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" },
    )

  if (error) {
    console.error("Error updating auto-response settings:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
  }, (error) => ({ success: false, error }))
}

// TOMBSTONE (wave 155, lane 155R29; CLAUDE.md §1 case 2 — the functionality lives elsewhere): generateAIResponse (+ its private
// generateSmartReply) DELETED. Survivor: app/actions/ai-reply-coach.ts:61 generateAIReplyDraft — the reply drafter the product calls
// (app/components/ai-copilot/inline-ai-reply-coach.tsx:8 import, :64 call; conversation-coaching-panel.tsx:9). Nothing imported this
// export (named, dynamic, barrel or string-keyed), and as a "use server" export it was a public door that spent on a model and read any
// contact by id with no tenant predicate. The survivor drafts from the SESSION tenant (requireCallerTenant), injects the contact's
// memory (loadContactMemoryForPrompt, lib/ai-reply-coach/reply-draft-core.ts:142) and lands a draft for a person to accept — this one
// filed a 'queued' ai_auto_response message straight into the thread. Its one unique trait, the conversation-insights summary
// (buildContextWindow), was NOT merged: the survivor already speaks from the kernel's contact memory (one memory per prompt, law 2).

// Track behavioral event for lead scoring.
//
// GATED WRAPPER around the one shared recorder,
// lib/lead-scoring/record-behavioral-event.ts. This action's agent-session gate
// (auth user + getAgentContext) is right for agent-surface callers and
// structurally wrong for everyone else — a portal contact or a provider webhook
// can never hold an agent session, which is why this being the ONLY writer left
// the canonical scorer's behavioural 30% with no event source. The write itself
// now lives in the lib recorder so the portal/webhook call sites and this action
// land the identical row shape; identity and tenant here stay SERVER-RESOLVED
// (session + getAgentContext), never taken from the params.
export async function trackBehavioralEvent(params: {
  contactId: string
  eventType: string
  eventData?: any
  pointsAwarded?: number
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated" }
  }

  // behavioral_patterns is a brokerage pattern-definition CATALOG, not an event log.
  // Per-entity events belong in lead_behavioral_data (keyed by lead_id, event_type NOT NULL).
  const { brokerageId } = await getAgentContext()
  // The recorder keys cost and score on the tenant — a session with no resolvable
  // brokerage cannot record, and saying so beats a null sailing into NOT NULL.
  if (!brokerageId) {
    return { success: false, error: "no tenant context — event not recorded" }
  }
  return withSessionReceipt({ userId: user.id, brokerageId }, "lead_scoring.behavioral_event.record", { type: "contact", id: params.contactId }, "LOW_RISK_WRITE", { event_type: params.eventType, points_stated: params.pointsAwarded ?? null }, async () => {
  const { recordBehavioralEvent } = await import("@/lib/lead-scoring/record-behavioral-event")
  const result = await recordBehavioralEvent({
    brokerageId,
    contactId: params.contactId,
    eventType: params.eventType,
    eventData: params.eventData || {},
    // PASSED THROUGH, NOT DEFAULTED. `|| 0` turned "the caller said nothing about
    // points" into "the caller explicitly said this event is worth zero" — and
    // those are different facts to the recorder's vocabulary gate, which admits an
    // UNSCORED event type only when the caller states what it is worth. With the
    // fabricated zero this endpoint could file any string as an event type and
    // have it score 0 forever while reporting success. `undefined` now means
    // undefined, and an unscored type without stated points is refused with a
    // reason the caller receives.
    pointsAwarded: params.pointsAwarded,
  })

  if (!result.recorded) {
    return { success: false, error: result.reason ?? "not recorded" }
  }

  // Recalculate lead score through the CANONICAL scorer (multi-factor baseline +
  // the behavioural layer that reads this very event log). Behaviour tracking is
  // best-effort telemetry: a scoring failure must not fail the tracking call.
  try {
    const { calculateLeadScore } = await import("@/lib/services/lead-management.service")
    await calculateLeadScore({ id: params.contactId, table: "contacts" })
  } catch (scoreErr) {
    console.error("[ai-auto-response] scoring after behavioural event failed:", scoreErr)
  }

  return { success: true }
  }, (error) => ({ success: false, error }))
}

// ─── THE LEGACY LOCAL SCORER IS GONE ─────────────────────────────────────────
//
// It was the THIRD calculateLeadScore in the repo and had been marked @deprecated
// while still being called on this file's live auto-response path. Two things made
// it worse than a duplicate:
//
//   · It normalised with `min(100, floor(totalPoints / 10))`, so a "hot" score of 70
//     required 700 raw event points — roughly 24 CMA requests or 28 showing requests
//     from one person. Unreachable in practice, which made getHotLeads below (the
//     agent dashboard and /leads) empty by arithmetic.
//   · It wrote lead_scores, which NO authoritative path wrote, while the real score
//     went to contacts.lead_score. Two tables, two formulas, one lead.
//
// What it uniquely got RIGHT was reading lead_behavioral_data as the event log it
// actually is — per-event-type weights, real occurred_at recency,
// event_data.points_awarded as a fallback. Those weights are ported verbatim into
// lib/lead-scoring/behavioral-events.ts and now feed the canonical scorer, which
// also writes the lead_scores snapshot. So this function's asset survives and its
// two defects do not.

// Get lead score for a contact
export async function getLeadScore(contactId: string) {
  const supabase = await createClient()

  // maybeSingle, not single: "no snapshot yet" is an ordinary state for a contact
  // that has never been scored, and .single() turned it into an error the caller had
  // to recognise by PostgREST code.
  const { data, error } = await supabase
    .from("lead_scores")
    .select("*")
    .eq("contact_id", contactId)
    .maybeSingle()

  if (error && error.code !== "PGRST116") {
    console.error("Error fetching lead score:", error)
    return { success: false, error: error.message, score: null }
  }

  if (!data) {
    // No snapshot yet — compute one through the canonical scorer, which writes the
    // lead_scores row, then read it back rather than returning a differently-shaped
    // ad-hoc object (the old local scorer returned its own shape here, so callers
    // saw two different score payloads depending on whether a row existed).
    const ctx = await getAgentContext()
    return withSessionReceipt({ userId: ctx.userId, brokerageId: ctx.brokerageId }, "lead_scoring.score_snapshot.compute", { type: "contact", id: contactId }, "LOW_RISK_WRITE", { reason: "no_snapshot" }, async () => {
    const { calculateLeadScore } = await import("@/lib/services/lead-management.service")
    await calculateLeadScore({ id: contactId, table: "contacts" })
    const { data: fresh } = await supabase
      .from("lead_scores")
      .select("*")
      .eq("contact_id", contactId)
      .maybeSingle()
    return { success: true, score: fresh ?? null }
    }, (error) => ({ success: false, error, score: null }))
  }

  return { success: true, score: data }
}

/** The score at or above which a lead is HOT. Same number priorityTier() uses in
 *  lib/lead-scoring/behavioral-events, stated once so the list and the tier label
 *  cannot disagree about what "hot" means. */
const HOT_LEAD_SCORE = 70

// Get hot leads (priority scoring) - using actual schema columns
// Schema: id, contact_id, agent_id, score, score_factors, ai_confidence, computed_at
export async function getHotLeads(limit = 50) {
  const context = await getAgentContext()
  if (!context?.agentId) {
    return { success: false, error: "Agent context not available", leads: [] }
  }
  
  const { agentId, brokerageId } = context
  const supabase = await createClient()

  // lead_scores is UNIQUE (contact_id) — one current row per contact, verified
  // against the live schema — so ranking by score and taking `limit` needs no
  // dedupe. The canonical scorer upserts on contact_id to keep it that way.
  const { data, error } = await supabase
    .from("lead_scores")
    .select("id, contact_id, agent_id, score, score_factors, ai_confidence, computed_at")
    .eq("agent_id", agentId)
    .gte("score", HOT_LEAD_SCORE)
    .order("score", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("Error fetching hot leads:", error)
    // Fallback: query contacts directly with high intent_score
    const { data: contactsData, error: contactsError } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, email, phone, contact_type, source, lead_score, lead_temperature, created_at")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      // 'hot' is a TEMPERATURE, not a status — no writer has ever stored it on
      // contacts.status (the phantom clause matched nothing); the hot flag lives
      // on contacts.lead_temperature (live CHECK: cold/hot/warm).
      .or(`lead_score.gte.${HOT_LEAD_SCORE},lead_temperature.eq.hot`)
      .order("lead_score", { ascending: false, nullsFirst: false })
      .limit(limit)

    if (contactsError) {
      console.error("Error fetching contacts fallback:", contactsError)
      return { success: false, error: contactsError.message, leads: [] }
    }

    // Map contacts to the expected hot leads format
    return {
      success: true,
      leads: (contactsData || []).map(c => ({
        id: c.id,
        contact_id: c.id,
        agent_id: agentId,
        // contacts.lead_score IS the canonical current score — the fallback reads the
        // same number the snapshot would carry, not intent_score/engagement_score,
        // which are enrichment signals and never were this score.
        score: c.lead_score ?? HOT_LEAD_SCORE,
        score_factors: { temperature: c.lead_temperature },
        ai_confidence: 0.8,
        computed_at: new Date().toISOString(),
        contacts: c,
      })),
    }
  }

  // Fetch contacts separately to avoid relationship issues
  const leads = data || []
  if (leads.length > 0) {
    const contactIds = leads.map(l => l.contact_id).filter(Boolean)
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, email, phone, contact_type, source, created_at")
        .in("id", contactIds)
        .eq("brokerage_id", brokerageId)

      const contactMap = new Map(contacts?.map(c => [c.id, c]) || [])
      return {
        success: true,
        leads: leads.map(l => ({
          ...l,
          contacts: contactMap.get(l.contact_id) || null,
        })),
      }
    }
  }

  return { success: true, leads: [] }
}
