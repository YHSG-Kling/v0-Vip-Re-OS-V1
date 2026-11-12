// lib/agents/offer-ready-detector.ts
// ─────────────────────────────────────────────────────────────────────────────
// AUTONOMOUS OFFER TRIGGER — the upstream signal the Offer Accelerator was missing.
//
// The offer-strategy brief (produceOfferStrategyBrief) fires only on a buyer_stage transition
// to 'offer_strategy', which NOTHING advances autonomously — so the whole accelerator sat idle
// until an agent manually moved the buyer. This detector closes that loop: each weekly buyer
// pass, a buyer who is GENUINELY offer-ready (pre-approved + a fresh active saved target + no
// open offer yet) autonomously gets the gated offer plan surfaced to their agent. The AI
// surfaces, the human releases — no auto-send. Idempotent: produceOfferStrategyBrief dedups one
// brief per buyer journey.

import "server-only"
import type { createServiceClient } from "@/lib/supabase/service"
import { isOfferReady, OFFER_READY_TARGET_WINDOW_DAYS } from "./offer-ready-decision"

export { isOfferReady, OFFER_READY_TARGET_WINDOW_DAYS } from "./offer-ready-decision"
export type { OfferReadyInput, OfferReadyDecision } from "./offer-ready-decision"

type Svc = ReturnType<typeof createServiceClient>

/**
 * runOfferReadyCheck — resolve the real signals for ONE buyer and, when offer-ready, fire the
 * gated Offer Accelerator (produceOfferStrategyBrief — which assembles the comps-grounded plan
 * and hands off the offer-confidence reel). Idempotent + best-effort; never throws to the caller.
 */
export async function runOfferReadyCheck(
  svc: Svc, brokerageId: string, contactId: string,
): Promise<{ fired: boolean; reason: string }> {
  try {
    const sinceIso = new Date(Date.now() - OFFER_READY_TARGET_WINDOW_DAYS * 86_400_000).toISOString()
    const [finRes, targetRes, offerRes] = await Promise.all([
      svc.from("buyer_financial_profiles").select("pre_approval_amount").eq("contact_id", contactId).maybeSingle(),
      svc.from("saved_properties").select("id")
        .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("dismissed", false)
        .not("list_price", "is", null).gte("saved_at", sinceIso).limit(1).maybeSingle(),
      svc.from("offers").select("id").eq("contact_id", contactId).limit(1).maybeSingle(),
    ])
    const decision = isOfferReady({
      preApprovalAmount: (finRes.data as { pre_approval_amount: number | null } | null)?.pre_approval_amount ?? null,
      hasRecentActiveTarget: !!targetRes.data,
      hasOpenOrPastOffer: !!offerRes.data,
    })
    if (!decision.ready) return { fired: false, reason: decision.reason }

    const { produceOfferStrategyBrief } = await import("@/lib/agents/offer-strategy-producer")
    const r = await produceOfferStrategyBrief(brokerageId, contactId, svc)
    // REPORT WHAT HAPPENED, NOT WHAT USUALLY HAPPENS. This read every
    // `proposed === 0` as "already briefed this journey" — which is one of eight
    // possible endings and the only benign one. A refused contact read, a failed
    // dedupe probe or a rejected gate write all produced that same reassuring
    // sentence, so the detector reported a healthy no-op on exactly the runs
    // where something had gone wrong. The producer now names its own outcome;
    // this passes it through instead of guessing.
    return {
      fired:  r.proposed > 0,
      reason: r.proposed > 0
        ? "offer accelerator fired (gated)"
        : `offer accelerator did not fire: ${r.outcome ?? "unknown outcome"}`,
    }
  } catch (e) {
    return { fired: false, reason: `error: ${e instanceof Error ? e.message : String(e)}` }
  }
}
