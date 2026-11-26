/**
 * scripts/canaries/lead.ts — LEAD canary:
 *   acquisition → dedup → enrichment → gate → lead → AI ISA → positive intent → contact
 * through lib/lead-pipeline/canonical-lead-eligibility.ts (identity gate), fuzzy-matcher.ts
 * (dedup), lib/enrichment/lead-enrichment-core.ts queueLeadEnrichment (the one enrichment
 * queue writer), lib/ai-isa/qualification-core.ts (the ISA's verdict math) and
 * lib/kernel/crm.ts convertLeadToContact (the qualified-only conversion door).
 * CLAUDE.md §5: leads belong to the BROKERAGE; a lead reaches an agent only once qualified.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"

export async function run() {
  const c = canary("Lead: acquisition → dedup → enrichment → gate → lead → AI ISA → positive intent → contact")
  const B = uuid(), U = uuid(), AG = uuid(), OLD = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-lead` }],
    users: [{ id: U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
    leads: [{ id: OLD, brokerage_id: B, first_name: "Dana", last_name: "Canary", email: `dana@${CANARY_EMAIL_DOMAIN}`, phone: "5125550199", phone_digits: "5125550199", lead_type: "buyer", lead_stage: "new", is_active: true, notes: CANARY_TAG }],
  })
  setSvc(svc)
  const { isLeadEligibleIdentity } = await import("../../lib/lead-pipeline/canonical-lead-eligibility")
  const { calculateFuzzyMatch, isConfidentMatch } = await import("../../lib/lead-pipeline/fuzzy-matcher")
  const cand = { first_name: "Jordan", last_name: "Canary", email: `jordan@${CANARY_EMAIL_DOMAIN}`, phone: "5125550123" }
  c.step("acquisition: a real person with a reachable channel passes the canonical identity gate", isLeadEligibleIdentity(cand as never), "")
  c.step("POSITIVE CONTROL: a placeholder identity with no channel is refused by the same gate", !isLeadEligibleIdentity({ first_name: "Test", last_name: "User", email: null, phone: null } as never), "")
  const dup = calculateFuzzyMatch({ first_name: "Dana", last_name: "Canary", email: `dana@${CANARY_EMAIL_DOMAIN}`, phone: "5125550199" } as never, svc.tables.leads![0] as never)
  const distinct = calculateFuzzyMatch(cand as never, svc.tables.leads![0] as never)
  c.step("dedup: the same person again is a CONFIDENT match (would merge, never a second lead)", isConfidentMatch(dup), `score ${JSON.stringify(dup).slice(0, 80)}`)
  c.step("dedup: a different person is NOT a confident match", !isConfidentMatch(distinct), "")
  const { data: ins, error: insErr } = await svc.from("leads").insert({ brokerage_id: B, ...cand, phone_digits: cand.phone, lead_type: "buyer", source: "website", source_family: "acquisition", source_channel: "digital", lifecycle_state: "raw", lead_stage: "new", is_active: true, ai_isa_owner: true, lead_score: 0, notes: CANARY_TAG, created_at: nowIso() }).select("id").single()
  const L = (ins as { id: string } | null)?.id ?? ""
  c.step("lead: the BROKERAGE-owned lead row lands (ai_isa_owner, no agent)", !insErr && !!L, insErr?.message ?? L)
  const { queueLeadEnrichment } = await import("../../lib/enrichment/lead-enrichment-core")
  const q = await queueLeadEnrichment({ leadId: L, brokerageId: B, triggerType: "lead_captured", supabase: svc as never })
  const queued = (svc.tables.lead_enrichment_queue ?? []).filter((r) => r.lead_id === L && r.brokerage_id === B)
  c.step("enrichment: queueLeadEnrichment runs its guards and answers with a DECLARED outcome (queue row or a named refusal)", typeof (q as { outcome?: unknown }).outcome === "string" || typeof (q as { queued?: unknown }).queued === "boolean", `${JSON.stringify(q).slice(0, 140)} rows=${queued.length}`)
  const { convertLeadToContact } = await import("../../lib/kernel/crm")
  const early = await convertLeadToContact({ leadId: L, brokerageId: B, agentId: AG, tcpaConsent: true, consentSource: CANARY_TAG })
  c.step("gate: an UNQUALIFIED lead cannot reach an agent (conversion refused server-side)", !early.success && /qualified/i.test(early.error ?? ""), early.error ?? "converted")
  const { deriveQualificationSignals, qualificationScoreFor } = await import("../../lib/ai-isa/qualification-core")
  const sig = deriveQualificationSignals({ messageText: "yes we are ready and want to schedule a tour this week, interested in the 3 bed", conversationCount: 3, timeline: "1-3", leadScore: 60 })
  const score = qualificationScoreFor(sig)
  c.step("AI ISA: the qualification core reads POSITIVE INTENT (confirmedIntent, readinessForAgent, score ≥ 50)", sig.confirmedIntent && sig.readinessForAgent && score >= 50, `score ${score} urgency ${sig.urgency}`)
  const { data: st, error: stErr } = await svc.from("leads").update({ lead_stage: "qualified", lead_score: score, lead_temperature: "hot", updated_at: nowIso() }).eq("id", L).eq("brokerage_id", B).select("id")
  c.step("AI ISA: the verdict is written (lead_stage qualified) — counted", !stErr && (st ?? []).length === 1, stErr?.message ?? "")
  const conv = await convertLeadToContact({ leadId: L, brokerageId: B, agentId: AG, tcpaConsent: true, consentSource: CANARY_TAG })
  const contact = svc.tables.contacts?.find((x) => x.id === conv.contactId)
  const lead = svc.tables.leads?.find((x) => x.id === L)
  c.step("positive intent → contact: convertLeadToContact succeeds, contact.agent_id is the AGENTS id class", conv.success && !!contact && contact.agent_id === AG && contact.brokerage_id === B, conv.error ?? `contact ${conv.contactId}`)
  c.step("handoff: lead.contact_id set, ai_isa_owner released, lead inactive (the ISA goes dormant)", !!lead && lead.contact_id === conv.contactId && lead.ai_isa_owner === false && lead.is_active === false, `ai_isa_owner=${lead?.ai_isa_owner} is_active=${lead?.is_active}`)
  const again = await convertLeadToContact({ leadId: L, brokerageId: B, agentId: AG, tcpaConsent: true, consentSource: CANARY_TAG })
  c.step("idempotency: converting again returns the SAME contact (isDuplicate), never a second person", again.success && again.contactId === conv.contactId && (svc.tables.contacts ?? []).filter((x) => x.brokerage_id === B).length === 1, "")
  c.step("evidence: lifecycle/activity rows were written for the conversion", (svc.tables.lifecycle_events ?? []).length + (svc.tables.activities ?? []).length + (svc.tables.lead_activities ?? []).length > 0, `lifecycle=${(svc.tables.lifecycle_events ?? []).length} activities=${(svc.tables.activities ?? []).length}`)
  c.blind("The ISA CONVERSATION (LLM) is not run: the verdict math is driven with a scripted positive-intent transcript; the model lane is ai-isa-qualification-simulator's.")
  c.blind("Enrichment PROVIDERS are never called — only the queue writer and its guards run; the drain is enrichment-one-rail-guard's.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
