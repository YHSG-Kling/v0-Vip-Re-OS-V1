// lib/transactions/buyer-representation.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE "is this buyer OURS?" read for an offer on OUR listing (wave 93 lane 93D2).
//
// Three places asked it, each with its own copy of the same one-liner —
// `!!contacts.buyer_stage`:
//   · lib/transactions/offer-bridge.ts       — deal_type (buyer | seller | dual) + client linkage
//   · lib/kernel/offers.ts                   — which side's portal an offer event reaches
//   · lib/kernel/resolve-event-contacts.ts   — the same gate for every kernel fan-out
// contacts.buyer_stage has a column DEFAULT of 'BUYER_CONTACT_CREATED' (live, 2026-10-01), so that
// test was true for EVERY contact: an outside buyer's offer became 'dual' agency, and the other
// brokerage's client got our "Your offer was uploaded" / "You're under contract!" cards. Proven live
// in the wave-93c walk. The three copies are merged here; each call site names this file.
//
// The buyer is ours when either is true:
//   1. the buyer ladder has MOVED past its default (buyerStageShowsRepresentation — pure), or
//   2. an ACTIVE buyer-broker agreement names them — the representation instrument itself, the same
//      test lib/kernel/compliance/active-representation.ts:48 and lib/buyer-broker/gate.ts:57 apply.
//
// A refused read is returned, never read as "not ours" silently (CLAUDE.md §3 — supabase-js resolves
// refusals). Callers decide: the bridge logs and falls back to the evidence it has.

import type { SupabaseClient } from "@supabase/supabase-js"
import { buyerStageShowsRepresentation } from "./deal-type-resolver"

export interface BuyerRepresentation {
  ours: boolean
  /** Why the answer may be incomplete — a refused read. Empty when both reads ran. */
  refusals: string[]
}

export async function readBuyerRepresentation(
  client: SupabaseClient,
  params: { contactId: string; brokerageId?: string | null },
): Promise<BuyerRepresentation> {
  const refusals: string[] = []
  let bbaQuery = client
    .from("buyer_broker_agreements")
    .select("id")
    .eq("buyer_contact_id", params.contactId)
    .eq("status", "active")
  if (params.brokerageId) bbaQuery = bbaQuery.eq("brokerage_id", params.brokerageId)
  const [{ data: contact, error: contactErr }, { data: bba, error: bbaErr }] = await Promise.all([
    client.from("contacts").select("buyer_stage").eq("id", params.contactId).maybeSingle(),
    bbaQuery.limit(1),
  ])
  if (contactErr) refusals.push(`buyer stage read refused: ${contactErr.message}`)
  if (bbaErr) refusals.push(`buyer-broker agreement read refused: ${bbaErr.message}`)
  const ours =
    buyerStageShowsRepresentation((contact as { buyer_stage?: string | null } | null)?.buyer_stage) ||
    ((bba ?? []) as unknown[]).length > 0
  return { ours, refusals }
}
