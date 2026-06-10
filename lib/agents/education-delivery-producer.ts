// lib/agents/education-delivery-producer.ts
//
// EDUCATION DELIVERY AS A GOVERNED DELIVERABLE — push the RIGHT explainer to the
// client at the RIGHT moment, human-approved. The portal already lets a client BROWSE
// stage-gated lessons; this is the proactive half: when a client reaches a lifecycle
// stage, the side-appropriate concierge (Shopping Agent for buyers, Listing Concierge
// for sellers) PROPOSES the best-matched lesson into the client-message gate AND records
// a learning_assignment, so the broker approves and it reaches the client as a timely,
// branded touch instead of a lesson they may never open.
//
// Reuses the existing module matcher (pickLearningModulesForActor) — no duplicate
// scoring logic. Idempotent: a given (contact, module) is proposed once. Pure side
// resolution + copy are unit-tested; the producer is live-probed.

import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

type Svc = ReturnType<typeof createServiceClient>

/** Which concierge owns the delivery, by the client's side of the deal. */
export function conciergeForSide(side: "buyer" | "seller" | null): "shopping_agent" | "listing_concierge" {
  return side === "seller" ? "listing_concierge" : "shopping_agent"
}

/** Pure: the client-safe education nudge copy. */
export function buildEducationDelivery(
  moduleTitle: string, moduleSummary: string | null, estimatedMinutes: number | null, agentName: string,
): { subject: string; body: string } {
  const title = sanitizeProperNoun(moduleTitle, 100) ?? "a quick lesson"
  const who = sanitizeProperNoun(agentName, 60) ?? "Your Agent"
  const mins = estimatedMinutes && estimatedMinutes > 0 ? ` (about ${estimatedMinutes} min)` : ""
  const why = moduleSummary ? ` ${moduleSummary}` : ""
  return {
    subject: `For where you are now: ${title}`,
    body: [
      `Hi,`,
      `You're at the point where this helps most — I put together "${title}"${mins} for you.${why}`,
      `It's in your portal whenever you're ready. Happy to talk through any of it.`,
      `— ${who}`,
    ].join("\n\n"),
  }
}

/** Resolve the client's deal side + agent name (best-effort). */
async function resolveClientContext(supabase: Svc, brokerageId: string, contactId: string): Promise<{ side: "buyer" | "seller" | null; agentName: string }> {
  let side: "buyer" | "seller" | null = null
  const { data: txn } = await supabase
    .from("transactions")
    .select("deal_type")
    .eq("brokerage_id", brokerageId)
    .or(`contact_id.eq.${contactId},buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
    .not("status", "in", "(lost,closed)")
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle()
  const dt = (txn as { deal_type?: string | null } | null)?.deal_type ?? null
  if (dt === "seller") side = "seller"
  else if (dt === "buyer") side = "buyer"

  let agentName = "Your Agent"
  const { data: c } = await supabase.from("contacts").select("agent_id, contact_type").eq("id", contactId).maybeSingle()
  const cc = c as { agent_id?: string | null; contact_type?: string | null } | null
  if (!side && cc?.contact_type) side = cc.contact_type === "seller" ? "seller" : cc.contact_type === "buyer" ? "buyer" : null
  if (cc?.agent_id) {
    const { data: a } = await supabase.from("agents").select("user_id").eq("id", cc.agent_id).maybeSingle()
    const uid = (a as { user_id?: string | null } | null)?.user_id ?? null
    if (uid) {
      const { data: u } = await supabase.from("users").select("first_name, last_name").eq("id", uid).maybeSingle()
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) agentName = full
    }
  }
  return { side, agentName }
}

/**
 * Propose the best-matched lesson for a client into the gate + record the assignment.
 * Idempotent: skips a module already assigned to (or proposed for) this contact.
 */
export async function produceEducationDelivery(
  brokerageId: string, contactId: string, client?: Svc,
): Promise<{ proposed: boolean; moduleId?: string; reason?: string }> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId || !contactId) return { proposed: false, reason: "missing ids" }

  const { pickLearningModulesForActor } = await import("@/lib/learning-router/composer")
  const picks = await pickLearningModulesForActor({ supabase, actorKind: "customer", actorId: contactId, limit: 3 })
  if (picks.length === 0) return { proposed: false, reason: "no matching module" }

  // Take the highest-scored module the contact hasn't already been assigned.
  let chosen: typeof picks[number] | null = null
  for (const p of picks) {
    const { data: existingAssign } = await supabase
      .from("learning_assignments")
      .select("id").eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("module_id", p.id)
      .limit(1).maybeSingle()
    if (existingAssign) continue
    const { data: existingMsg } = await supabase
      .from("agent_client_messages")
      .select("id").eq("brokerage_id", brokerageId).eq("entity_type", "learning_module").eq("entity_id", p.id)
      .eq("recipient_contact_id", contactId).limit(1).maybeSingle()
    if (existingMsg) continue
    chosen = p
    break
  }
  if (!chosen) return { proposed: false, reason: "all top modules already delivered" }

  const { side, agentName } = await resolveClientContext(supabase, brokerageId, contactId)
  const manager = conciergeForSide(side)

  // Record the assignment (status='open') so the portal feed + completion tracking pick it up.
  await supabase.from("learning_assignments").insert({
    brokerage_id: brokerageId, module_id: chosen.id, contact_id: contactId,
    signal_source: chosen.signalSource, signal_metadata: chosen.signalMetadata,
    priority_score: chosen.priorityScore, status: "open",
  })

  // Propose the nudge into the gate (the side-appropriate concierge).
  const msg = buildEducationDelivery(chosen.title, chosen.summary, chosen.estimatedMinutes, agentName)
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const res = await proposeClientMessage({
    brokerageId, agentKind: manager, entityType: "learning_module", entityId: chosen.id,
    recipientContactId: contactId, audience: side === "seller" ? "seller" : "buyer",
    subject: msg.subject, body: msg.body,
    rationale: `Stage-matched lesson "${sanitizeProperNoun(chosen.title, 80) ?? "lesson"}" (${chosen.signalSource}) — review/edit before it reaches the client.`,
    channel: "portal",
  }, supabase)
  return res.ok ? { proposed: true, moduleId: chosen.id } : { proposed: false, reason: res.error }
}
