// lib/education/client-education-curriculum.ts
//
// CLIENT EDUCATION CURRICULUM — the OS teaches the CLIENTS, not just the agents. The education-delivery
// producer already pushes the right lesson to a buyer/seller at the right stage and the portal renders it,
// but it can only deliver modules that EXIST. This authors the persona- and stage-tuned client modules —
// "what happens at this stage" + "what you should do next" in plain, reassuring language — so every
// buyer, seller, and lifetime client has rich guidance waiting. Each becomes a gated learning_modules
// draft (audience_roles ['customer'], stage/persona tagged) which the existing learning-router + concierge
// delivery then push to the portal. Same canonical rail as agent education — no parallel path. Pure
// syllabus is testable; the model + persistence live in client-education-authoring.ts.

import { createServiceClient } from "@/lib/supabase/service"
import { authorClientModule, persistClientModule } from "@/lib/education/client-education-authoring"

type Svc = ReturnType<typeof createServiceClient>

export interface ClientTopic {
  /** Stable tag suffix, unique across the syllabus. */
  key: string
  title: string
  /** buyer | seller stage module, or persona entry module. */
  kind: "buyer_stage" | "seller_stage" | "persona"
  /** For stage modules: the milestone key it maps to (stage_tags + milestone_key). */
  milestone?: string
  /** For persona modules: the contact_persona it serves (audience_personas). */
  persona?: string
  brief: string
}

/** Curated, highest-anxiety client moments — where a client most needs "what now / what to do". */
export const CLIENT_SYLLABUS: ClientTopic[] = [
  // BUYER stages
  { key: "buyer_pre_approved", title: "You're pre-approved — what it means and what's next", kind: "buyer_stage", milestone: "pre_approved", brief: "Explain to a buyer what pre-approval actually means (vs pre-qualification), how it shapes their search and offer strength, and the do's/don'ts to protect it — plain, encouraging language." },
  { key: "buyer_offer_accepted", title: "You're under contract — what happens next", kind: "buyer_stage", milestone: "offer_accepted", brief: "Walk a buyer through what happens the moment their offer is accepted: earnest money, timelines, inspection/appraisal/financing, and what THEY need to do at each step. Reassuring, plain-language." },
  { key: "buyer_clear_to_close", title: "Clear to close — your final week", kind: "buyer_stage", milestone: "clear_to_close", brief: "Guide a buyer through the final week: reviewing the Closing Disclosure, the wire-fraud warning (verify wiring instructions by phone), what to bring to closing, and the closing-day sequence — calm and specific." },
  { key: "buyer_inspection", title: "Your inspection results — how to decide on repairs", kind: "buyer_stage", milestone: "inspection_completed", brief: "Help a buyer read an inspection report: what's normal, what's a real concern, and how repair negotiations work — without scaring them off a good home." },
  { key: "buyer_appraisal_low", title: "If your appraisal comes in low — your options", kind: "buyer_stage", milestone: "appraisal_completed", brief: "Explain a low appraisal in plain terms and the buyer's real options (renegotiate, cover the gap, dispute, walk) so they don't panic." },
  { key: "buyer_closed", title: "You're a homeowner — your first 30 days", kind: "buyer_stage", milestone: "closed", brief: "A new homeowner's first-30-days checklist: utilities, home maintenance, warranty, taxes, and how to stay in touch with their agent for the long haul." },
  // SELLER stages
  { key: "seller_listing_agreement", title: "Your listing agreement & commission, explained (post-NAR)", kind: "seller_stage", milestone: "listing_agreement_signed", brief: "Explain the listing agreement and how commission works after the NAR settlement: what changed, buyer-agent compensation options, and what the seller's net proceeds look like — clear and non-salesy." },
  { key: "seller_listing_live", title: "Your home is live — how showings and feedback work", kind: "seller_stage", milestone: "listing_live", brief: "Prepare a seller for going live: showing logistics, keeping the home ready, how feedback works, and when to expect offers — set realistic expectations." },
  { key: "seller_no_offer", title: "A few weeks in with no offer — is that normal?", kind: "seller_stage", milestone: "no_offer_extended", brief: "Reassure and level with a seller whose listing has gone 2-3 weeks without an offer: the psychology of days-on-market, what the data says for their market, and the honest options (staging, photos, price) — without blame." },
  { key: "seller_multiple_offers", title: "Multiple offers — how to choose the best one", kind: "seller_stage", milestone: "multiple_offers", brief: "Guide a seller through multiple offers: comparing beyond price (financing, contingencies, timeline), how escalation clauses work, and the highest-and-best process — confident and fair." },
  { key: "seller_offer_received", title: "Evaluating offers — price isn't everything", kind: "seller_stage", milestone: "offer_received", brief: "Teach a seller to weigh an offer beyond price: financing strength, contingencies, timeline, and terms — how to compare and counter." },
  { key: "seller_repairs", title: "Handling the buyer's repair requests", kind: "seller_stage", milestone: "inspection_period", brief: "Guide a seller through a buyer's repair requests: what's reasonable, how to counter, credits vs repairs, and keeping the deal together." },
  { key: "seller_closed", title: "Home sold — moving out and what's next", kind: "seller_stage", milestone: "closed", brief: "A seller's close-out: final walkthrough, moving logistics, proceeds/taxes, and staying connected for their next move or a referral." },
  // PERSONA entry modules
  { key: "persona_first_time", title: "First-time buyer? Here's what to expect, start to finish", kind: "persona", persona: "first_time_buyer", brief: "A warm, complete first-time-buyer orientation: the journey overview, what each step means, common fears addressed, and what a great agent does for them." },
  { key: "persona_senior_downsizing", title: "Downsizing with less stress — a right-sizing playbook", kind: "persona", persona: "senior_downsizing", brief: "A senior-downsizing playbook: timing the sale + purchase, decluttering, equity, and the emotional side — patient and respectful." },
  { key: "persona_lifetime_equity", title: "Your home's value and your neighborhood, explained", kind: "persona", persona: "past_client", brief: "A lifetime-client nurture module: how to read their home's value over time, local market shifts, and when refinancing or a move makes sense — no pressure." },
]

export function clientTag(t: ClientTopic): string {
  return t.kind === "persona" ? `client:persona:${t.persona}` : `client:${t.kind === "buyer_stage" ? "buyer" : "seller"}:${t.milestone}`
}

export interface ClientEducationResult { topics: number; authored: number }

/** Author the missing client-education modules for one brokerage. Best-effort. */
export async function runClientEducationCurriculum(svc: Svc, params: { brokerageId: string; maxPerRun?: number }): Promise<ClientEducationResult> {
  const out: ClientEducationResult = { topics: CLIENT_SYLLABUS.length, authored: 0 }
  const cap = params.maxPerRun ?? 3
  for (const topic of CLIENT_SYLLABUS) {
    if (out.authored >= cap) break
    const tag = clientTag(topic)
    const { data: existing } = await svc.from("learning_modules")
      .select("id").eq("brokerage_id", params.brokerageId).eq("is_ai_generated", true).contains("gap_tags", [tag]).limit(1).maybeSingle()
    if (existing) continue

    const curriculum = await authorClientModule(topic).catch(() => null)
    if (!curriculum) continue
    const ok = await persistClientModule(svc, params.brokerageId, tag, topic, curriculum)
    if (ok) out.authored++
  }
  return out
}

/** Autonomous: author client education for every brokerage missing it (rides the education-delivery cron). */
export async function runClientEducationCurriculumAll(svc: Svc): Promise<{ brokerages: number; authored: number }> {
  const out = { brokerages: 0, authored: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runClientEducationCurriculum(svc, { brokerageId: b.id }); out.authored += r.authored } catch { /* keep going */ }
  }
  return out
}
