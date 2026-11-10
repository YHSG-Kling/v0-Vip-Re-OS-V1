"use server"

/**
 * app/actions/transactions/cda-coach.ts — THE AI SPLIT COACH, THE MODEL DOOR (wave 151, lane 151K; closes lane 150XY "Still open 1").
 *
 * Owner (wave 142, in force): "AI MUST NOT FILL THE CDA (it may explain waterfall figures when asked)." Owner (wave 151, 151K):
 * "AI may coach commission calculations but does not fill the CDA." CLAUDE.md §5: commission is off agent-facing display — the
 * coach explains the ORDER and the WHY of the waterfall and, in words, where the agent's own entries disagree with the deterministic
 * check (lib/commission/cda-discrepancy.ts); it never proposes a number. The engine's computed amounts are never handed to the
 * model; a deterministic filter (lib/commission/cda-coach-rule.ts filterCoachWords) withholds any figure the agent did not type and
 * the contract does not state. Nothing here writes closing_disclosure_agreement (CDA_FILL_RULE.aiFills stays false).
 *
 * Every export is a public endpoint (CLAUDE.md §4): the tenant is the SESSION's (requireAuth), the caller must be the CDA's
 * assigned agent or a seat on the CDA approval roster, and the service client is used only AFTER that gate. The model is the
 * platform's ONE AI entry point (lib/ai generateAIResponse), routed by the feature key and booked to the session tenant on
 * ai_tool_usage (CLAUDE.md §5 — AI is platform-covered, metered). No model is named here.
 */

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { CDA_APPROVE_ROLES } from "@/lib/transactions/cda-signing-policy"
import { resolveCdaMode } from "@/lib/transactions/cda-closing-policy"
import { buildCdaContractVerdict, expectedGrossFromTerms, sumOutstandingAgentFees } from "@/lib/commission/cda-discrepancy"
import { CDA_COACH_RULE, allowedFigureSet, buildCoachBrief, filterCoachWords, type CoachDiscrepancyWords, type CoachStructure } from "@/lib/commission/cda-coach-rule"

type ActionResult<T> = ({ success: true } & T) | { success: false; error: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COACH_FEATURE = "cda_commission_coach"

export async function explainCdaArithmeticAction(input: { cdaId: string; question?: string | null }): Promise<ActionResult<{ sentences: string[]; withheld: number; discrepancies: CoachDiscrepancyWords[]; structure: CoachStructure; rule: typeof CDA_COACH_RULE }>> {
  if (!UUID.test(String(input?.cdaId ?? ""))) return { success: false, error: "invalid_cda" }
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }

  // the gate: the CDA's assigned agent (agents.id both sides) or a seat on the approval roster — then the service client
  const { data: cda, error: cErr } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, agent_id, gross_commission, agent_net, brokerage_net, uses_cda")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (cErr) return { success: false, error: `cda_read_refused: ${cErr.message}` }
  if (!cda || cda.brokerage_id !== auth.brokerageId) return { success: false, error: "not_found" }
  const isAgent = !!auth.agentId && auth.agentId === cda.agent_id
  const isRoster = CDA_APPROVE_ROLES.has(String(auth.userType ?? "").toLowerCase())
  if (!isAgent && !isRoster) return { success: false, error: "forbidden: the CDA's agent or the approval roster may ask the coach" }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient() as unknown as { from: (t: string) => any }
  const brokerageId = cda.brokerage_id as string
  const agentRecordId = cda.agent_id as string | null

  const [{ data: txn, error: tErr }, { data: brk, error: bErr }, { data: profile, error: pErr }, { data: cap, error: capErr }, { data: fees, error: fErr }, { data: refs, error: rErr }] = await Promise.all([
    svc.from("transactions").select("id, purchase_price, commission_percentage, estimated_commission").eq("id", cda.transaction_id).eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("brokerages").select("offers_cda, non_cda_payout_default").eq("id", brokerageId).maybeSingle(),
    agentRecordId ? svc.from("agent_commission_profiles").select("split_percent, cap_amount").eq("agent_id", agentRecordId).eq("is_active", true).order("effective_date", { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null, error: null }),
    agentRecordId ? svc.from("agent_cap_tracking").select("cap_amount, cap_paid_to_date").eq("agent_id", agentRecordId).eq("brokerage_id", brokerageId).order("cap_paid_to_date", { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null, error: null }),
    agentRecordId ? svc.from("agent_fee_charges").select("amount, status, paid_at").eq("agent_id", agentRecordId).eq("brokerage_id", brokerageId).in("status", ["open", "overdue"]) : Promise.resolve({ data: [], error: null }),
    svc.from("referrals").select("id").eq("brokerage_id", brokerageId).eq("transaction_id", cda.transaction_id).limit(1),
  ])
  for (const [what, e] of [["transaction", tErr], ["brokerage", bErr], ["agreement", pErr], ["cap", capErr], ["fees", fErr], ["referral", rErr]] as Array<[string, { message: string } | null]>) {
    if (e) return { success: false, error: `${what}_read_refused: ${e.message}` }
  }
  const t = (txn ?? {}) as { purchase_price?: number | null; commission_percentage?: number | null; estimated_commission?: number | null }
  const b = (brk ?? {}) as { offers_cda?: boolean | null; non_cda_payout_default?: string | null }
  const capAmount = Number((cap as { cap_amount?: number } | null)?.cap_amount ?? (profile as { cap_amount?: number } | null)?.cap_amount ?? 0)
  const capPaid = Number((cap as { cap_paid_to_date?: number } | null)?.cap_paid_to_date ?? 0)
  const capReached = capAmount > 0 && capPaid >= capAmount
  const contractSplit = (profile as { split_percent?: number | null } | null)?.split_percent ?? null
  const outstandingFees = sumOutstandingAgentFees((fees ?? []) as Array<{ amount?: number | null; status?: string | null; paid_at?: string | null }>)

  // the deterministic check — stripped to WORDS before the model sees it (field + severity; never the expected figure)
  const verdict = buildCdaContractVerdict({
    computedGross: Number(cda.gross_commission ?? 0),
    computedAgentNet: Number(cda.agent_net ?? 0),
    expectedGross: expectedGrossFromTerms({ estimated_commission: t.estimated_commission ?? null, purchase_price: t.purchase_price ?? null, commission_percentage: t.commission_percentage ?? null }),
    contractSplitPct: contractSplit == null ? null : capReached ? 100 : contractSplit,
  })
  const discrepancies: CoachDiscrepancyWords[] = verdict.discrepancies.map((d) => ({ field: d.field, severity: d.severity }))

  const structure: CoachStructure = {
    referralApplies: ((refs ?? []) as unknown[]).length > 0,
    capReached,
    teamSplitApplies: null, // not read here: the team agreement in force is the engine's reading (stage 08); the coach says "unknown"
    outstandingFeesExist: outstandingFees > 0,
    cdaMode: resolveCdaMode({ offersCda: b.offers_cda ?? null, nonCdaPayoutDefault: b.non_cda_payout_default ?? null }).mode,
  }
  const figures = {
    agentEntered: { grossCommission: num(cda.gross_commission), agentNet: num(cda.agent_net), brokerageNet: num(cda.brokerage_net) },
    contract: { purchasePrice: num(t.purchase_price), commissionPercentage: num(t.commission_percentage) },
  }
  const brief = buildCoachBrief({ structure, figures, discrepancies, question: input.question ?? null })

  // THE ONE AI ENTRY POINT — routed by feature, booked to the session tenant; the model is never named here.
  let text: string
  try {
    const { generateAIResponse } = await import("@/lib/ai")
    const res = await generateAIResponse({
      system: brief.system, prompt: brief.prompt, temperature: 0.2, maxTokens: 700,
      metadata: { userId: auth.userId, brokerageId, agentId: auth.agentId ?? null, teamId: null, feature: COACH_FEATURE },
    })
    text = res.text
  } catch (e) {
    return { success: false, error: `coach_unavailable: ${e instanceof Error ? e.message : String(e)}` }
  }
  const filtered = filterCoachWords(text, allowedFigureSet(figures))

  // LAW 5 — who asked, what the check said, how many figures were withheld (best effort; the explanation is already the agent's)
  try {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    await withActionLedger<{ ok: true }>(
      {
        brokerageId, action: "cda.coach.explain", actor: { type: "user", userId: auth.userId, agentId: auth.agentId ?? null },
        subject: { type: "transaction", id: cda.transaction_id as string, ref: cda.id as string }, reasonCode: "HUMAN_REQUESTED",
        reasonDetail: `CDA coach explained the waterfall${discrepancies.length ? ` (${discrepancies.map((d) => d.field).join(", ")} flagged)` : ""}`.slice(0, 500),
        riskClass: "LOW_RISK_WRITE", systemSource: "cda_coach",
        detail: { feature: COACH_FEATURE, withheld: filtered.withheld, discrepancies, structure, fills_cda: CDA_COACH_RULE.fillsCda },
      },
      async () => ({ ok: true as const }),
      { settle: () => ({ status: "executed", outcome: "explained" }), replay: () => ({ ok: true as const }) },
      { client: svc as never },
    )
  } catch (e) {
    console.error("[cda-coach] ledger row not written:", e instanceof Error ? e.message : String(e))
  }
  return { success: true, sentences: filtered.sentences, withheld: filtered.withheld, discrepancies, structure, rule: CDA_COACH_RULE }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
