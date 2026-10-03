// lib/agents/recruit-outreach-producer.ts
//
// RECRUITING MANAGER (the 11th Claude manager, m215) — keeps the talent pipeline warm
// without the broker chasing it. As a recruit advances a stage (or goes stale with no
// contact), the Recruiting Manager PROPOSES the next, stage-appropriate outreach into
// the client-message gate. The broker approves/edits in the Command Center; approving
// sends it. Recruiting is governed on the SAME egress as every client-facing message —
// nothing reaches a prospective agent autonomously.
//
// Stage-aware copy, idempotent (one pending recruiting proposal per recruit at a time),
// and consent-irrelevant here (B2B recruiting of licensed agents, internal review
// before any send). Pure builders are unit-tested; the producers are live-probed.

import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun, sanitizeCompNoun } from "@/lib/compliance/client-text-guard"

export type RecruitStatus = "prospect" | "contacted" | "interviewing" | "offer_extended" | "joined" | "declined"
/** The non-terminal stages the Recruiting Manager reaches out on — DERIVED from RecruitStatus
 *  (2026-08-31; it was a second hand-spelled union, so renaming a stage could silently sever the
 *  outreach subset from the full vocabulary). joined/declined are the terminal exclusions. */
export type RecruitOutreachStage = Exclude<RecruitStatus, "joined" | "declined">

export interface RecruitLite {
  first_name: string | null
  last_name: string | null
  current_brokerage: string | null
  years_experience: number | null
  annual_volume: number | null
}

/** Stages we proactively reach out on. joined/declined are terminal — no outreach.
 *  Returns the named RecruitOutreachStage instead of a third hand-spelled copy of the union. */
export function recruitStageNeedsOutreach(status: string): status is RecruitOutreachStage {
  return status === "prospect" || status === "contacted" || status === "interviewing" || status === "offer_extended"
}

/** Pure: the stage-appropriate recruiting outreach copy. No fabricated specifics — only the
 *  recruit's own recorded fields are referenced, and EVERY interpolated field goes through the
 *  COMP-CLAIM guard: recruit names arrive from SCRAPED sources and display names are free text, so a
 *  poisoned "$0 fees forever / 100% split" tail must never become a written comp promise (contractual
 *  exposure). The templates themselves never state comp figures. */
export function buildRecruitOutreach(
  recruit: RecruitLite, status: RecruitOutreachStage, brokerageName: string, recruiterName: string,
): { subject: string; body: string } {
  const name = sanitizeCompNoun(recruit.first_name ?? "", 40) ?? "there"
  const brand = sanitizeCompNoun(brokerageName, 80) ?? "our brokerage"
  const recruiter = sanitizeCompNoun(recruiterName, 60) ?? "Our team"
  const volNote = recruit.annual_volume != null && recruit.annual_volume > 0
    ? ` Your production speaks for itself, and we think you'd do even more here.`
    : ""

  switch (status) {
    case "prospect":
      return {
        subject: `${name}, a quick hello from ${brand}`,
        body: [
          `Hi ${name},`,
          `I came across your work and wanted to introduce ${brand}.${volNote} We're growing intentionally and building around agents who want better tools and real support.`,
          `Open to a casual 15-minute conversation — no pitch, just to compare notes?`,
          `— ${recruiter}`,
        ].join("\n\n"),
      }
    case "contacted":
      return {
        subject: `${name}, following up`,
        body: [
          `Hi ${name},`,
          `Circling back on my note about ${brand}. I know timing is everything — even if now isn't right, I'd value staying in touch.`,
          `Would a short call next week work?`,
          `— ${recruiter}`,
        ].join("\n\n"),
      }
    case "interviewing":
      return {
        subject: `Great talking, ${name} — next steps`,
        body: [
          `Hi ${name},`,
          `I really enjoyed our conversation. To help you picture the move, I can put together what your first 90 days at ${brand} would look like — tools, support, and how we'd ramp your pipeline.`,
          `Want me to send that over?`,
          `— ${recruiter}`,
        ].join("\n\n"),
      }
    case "offer_extended":
      return {
        subject: `${name}, your offer to join ${brand}`,
        body: [
          `Hi ${name},`,
          `We'd love to have you. Happy to walk through every detail of the offer and answer anything — no pressure, just clarity.`,
          `When's a good time to talk it through?`,
          `— ${recruiter}`,
        ].join("\n\n"),
      }
  }
}

type Svc = ReturnType<typeof createServiceClient>

async function resolveBrokerageAndRecruiter(
  supabase: Svc, brokerageId: string, recruiterAgentId: string | null,
): Promise<{ brokerageName: string; recruiterName: string }> {
  let brokerageName = "our brokerage"
  const { data: b } = await supabase.from("brokerages").select("name").eq("id", brokerageId).maybeSingle()
  if ((b as { name?: string } | null)?.name) brokerageName = String((b as { name: string }).name)

  let recruiterName = "Our team"
  if (recruiterAgentId) {
    const { data: a } = await supabase.from("agents").select("user_id").eq("id", recruiterAgentId).maybeSingle()
    const uid = (a as { user_id: string | null } | null)?.user_id ?? null
    if (uid) {
      const { data: u } = await supabase.from("users").select("first_name, last_name").eq("id", uid).maybeSingle()
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) recruiterName = full
    }
  }
  return { brokerageName, recruiterName }
}

/**
 * Propose the next recruiting outreach for one recruit into the gate. Idempotent:
 * skips if a recruiting proposal for this recruit is already pending (proposed/approved).
 */
export async function produceRecruitOutreach(
  brokerageId: string, recruitId: string, client?: Svc,
): Promise<{ proposed: boolean; reason?: string }> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId || !recruitId) return { proposed: false, reason: "missing ids" }

  const { data: rec } = await supabase
    .from("recruits")
    .select("id, brokerage_id, recruiter_agent_id, first_name, last_name, current_brokerage, years_experience, annual_volume, status")
    .eq("id", recruitId).eq("brokerage_id", brokerageId).maybeSingle()
  const r = rec as (RecruitLite & { id: string; brokerage_id: string; recruiter_agent_id: string | null; status: string }) | null
  if (!r) return { proposed: false, reason: "recruit not found" }
  if (!recruitStageNeedsOutreach(r.status)) return { proposed: false, reason: `terminal/no-outreach stage '${r.status}'` }

  // Idempotency — one pending recruiting proposal per recruit.
  const { data: existing } = await supabase
    .from("agent_client_messages")
    .select("id")
    .eq("brokerage_id", brokerageId).eq("entity_type", "recruit").eq("entity_id", recruitId)
    .eq("agent_kind", "recruiting_manager").in("status", ["proposed", "approved"])
    .limit(1).maybeSingle()
  if (existing) return { proposed: false, reason: "already pending" }

  const { brokerageName, recruiterName } = await resolveBrokerageAndRecruiter(supabase, brokerageId, r.recruiter_agent_id)
  const msg = buildRecruitOutreach(r, r.status as RecruitOutreachStage, brokerageName, recruiterName)

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const res = await proposeClientMessage({
    brokerageId, agentKind: "recruiting_manager", entityType: "recruit", entityId: recruitId,
    recipientContactId: null, audience: "agent",
    subject: msg.subject, body: msg.body,
    rationale: `Recruiting outreach for ${sanitizeProperNoun([r.first_name, r.last_name].filter(Boolean).join(" "), 60) ?? "a recruit"} (stage: ${r.status}) — review/edit before it sends.`,
    channel: "portal",
  }, supabase)
  return res.ok ? { proposed: true } : { proposed: false, reason: res.error }
}

/**
 * Sweep recruits in an active (non-terminal) stage that have gone stale (no contact in
 * `staleDays`) and propose the next outreach for each. Idempotent per recruit.
 */
export async function sweepStaleRecruits(
  brokerageId: string, staleDays = 7, client?: Svc,
): Promise<{ proposed: number; scanned: number }> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId) return { proposed: 0, scanned: 0 }

  const staleBefore = new Date(Date.now() - staleDays * 86_400_000).toISOString()
  const { data: recruits } = await supabase
    .from("recruits")
    .select("id, last_contact_date, status")
    .eq("brokerage_id", brokerageId)
    .in("status", ["prospect", "contacted", "interviewing", "offer_extended"])
    .or(`last_contact_date.is.null,last_contact_date.lt.${staleBefore}`)
    .limit(200)

  const rows = (recruits ?? []) as Array<{ id: string }>
  let proposed = 0
  for (const row of rows) {
    const r = await produceRecruitOutreach(brokerageId, row.id, supabase)
    if (r.proposed) proposed += 1
  }
  return { proposed, scanned: rows.length }
}
