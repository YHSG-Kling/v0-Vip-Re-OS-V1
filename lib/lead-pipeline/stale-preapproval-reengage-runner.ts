// lib/lead-pipeline/stale-preapproval-reengage-runner.ts
//
// Live side of STALE PRE-APPROVAL RE-ENGAGE (Shopping Agent). Finds OUR pre-contract buyers
// whose mortgage pre-approval is expired/expiring and who've gone quiet — NOT in an active
// deal (financing-pit-stop owns those) and NOT cash — and proposes ONE gated "let's refresh
// your financing" message + routes expired cases to the AI ISA for a re-qualification call.
// Idempotent per contact. Read-mostly; never throws into the caller.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { planPreApprovalReengage, EXPIRING_WINDOW_DAYS, type PreApprovalReengagePlan } from "./stale-preapproval-reengage"
import { generatePersonaCopy, type CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

export interface PreApprovalReengageRunInput {
  brokerageId: string
  now?: string
  copyGenerator?: CopyGenerator
  escalate?: boolean
}

export interface PreApprovalReengageRunResult {
  scanned: number
  reengaged: number
  callsRouted: number
}

const ACTIVE_DEAL_STATUSES = ["active", "under_contract", "pending", "closing"]

export async function runStalePreApprovalReengage(input: PreApprovalReengageRunInput, client?: Svc): Promise<PreApprovalReengageRunResult> {
  const svc = client ?? createServiceClient()
  const now = input.now ?? new Date().toISOString()
  const out: PreApprovalReengageRunResult = { scanned: 0, reengaged: 0, callsRouted: 0 }

  const horizon = new Date(new Date(now).getTime() + EXPIRING_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)

  // Non-cash pre-approvals expiring within the window (or already expired).
  const { data: profiles } = await svc
    .from("buyer_financial_profiles")
    .select("id, contact_id, agent_user_id, is_cash_buyer, pre_approval_expires_at")
    .eq("brokerage_id", input.brokerageId)
    .not("contact_id", "is", null)
    .not("pre_approval_expires_at", "is", null)
    .neq("is_cash_buyer", true)
    .lte("pre_approval_expires_at", horizon)
    .limit(300)

  for (const p of (profiles ?? []) as any[]) {
    out.scanned++

    // Contact: name + last-touch (quiet gate) + still a live buyer.
    const { data: contact } = await svc
      .from("contacts")
      .select("id, first_name, last_name, status, last_contacted_at, agent_id")
      .eq("id", p.contact_id)
      .maybeSingle()
    if (!contact) continue
    const c = contact as any
    if (c.status && ["archived", "inactive"].includes(c.status)) continue

    // In an active deal? financing-pit-stop owns those — skip here.
    const { count: dealCount } = await svc
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .or(`contact_id.eq.${p.contact_id},buyer_contact_id.eq.${p.contact_id}`)
      .in("status", ACTIVE_DEAL_STATUSES)
    const inActiveDeal = (dealCount ?? 0) > 0

    const buyerName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || null
    const plan = planPreApprovalReengage({
      preApprovalExpiresAt: p.pre_approval_expires_at,
      now,
      lastContactedAt: c.last_contacted_at ?? null,
      isCashBuyer: p.is_cash_buyer === true,
      inActiveDeal,
      buyerName,
    })
    if (!plan.eligible || input.escalate === false) continue

    const r = await reengage(svc, {
      brokerageId: input.brokerageId,
      contactId: p.contact_id,
      agentUserId: p.agent_user_id ?? c.agent_id ?? null,
      plan,
      copyGenerator: input.copyGenerator,
    })
    if (r.proposed) out.reengaged++
    if (r.callRouted) out.callsRouted++
  }

  return out
}

async function reengage(
  svc: Svc,
  args: { brokerageId: string; contactId: string; agentUserId: string | null; plan: PreApprovalReengagePlan; copyGenerator?: CopyGenerator },
): Promise<{ proposed: boolean; callRouted: boolean }> {
  const { plan } = args
  // IDEMPOTENCY: one re-engage per (contact, urgency) keyed in the proposal rationale.
  const dedupeKey = `STALE PRE-APPROVAL — contact:${args.contactId}:${plan.urgency}`
  const { data: prior } = await svc
    .from("agent_client_messages")
    .select("id")
    .eq("brokerage_id", args.brokerageId)
    .eq("entity_id", args.contactId)
    .ilike("rationale", `${dedupeKey}%`)
    .limit(1)
    .maybeSingle()
  if (prior) return { proposed: false, callRouted: false }

  const { loadContactPersona } = await import("@/lib/kernel/ai-copy")
  const persona = await loadContactPersona(svc, args.contactId).catch(() => ({ audience: "buyer" as const }))
  const draft = await generatePersonaCopy(
    {
      goal: "a brief, helpful, no-pressure message to a buyer whose mortgage pre-approval has expired (or is about to) — explain why a refresh matters to stay offer-ready, and offer to connect them with their lender",
      facts: [plan.buyerOutreach],
      channel: "portal",
      persona: { ...persona, audience: "buyer", situation: "buyer's mortgage pre-approval is stale" },
      words: 85,
    },
    { body: plan.buyerOutreach },
    { generator: args.copyGenerator },
  )

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const proposed = await proposeClientMessage(
    {
      brokerageId: args.brokerageId,
      agentKind: "shopping_agent",
      entityType: "contact",
      entityId: args.contactId,
      recipientContactId: args.contactId,
      audience: "buyer",
      subject: "Let's keep you offer-ready — quick financing refresh",
      body: draft.body,
      rationale: `${dedupeKey} — ${plan.daysToExpiry}d to expiry. ${plan.agentBrief}`,
      channel: "portal",
    },
    svc,
  )

  let callRouted = false
  if (plan.recommendCall) {
    try {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      const sig = await publishManagerSignal({
        brokerageId: args.brokerageId, fromManager: "shopping_agent", toManager: "ai_isa",
        signalType: "stale_preapproval_reengage",
        message: `${plan.agentBrief} Recommend a re-qualification call.`,
        entityType: "contact", entityId: args.contactId,
        payload: { urgency: plan.urgency, daysToExpiry: plan.daysToExpiry },
      }, svc)
      callRouted = sig.ok
    } catch { /* best-effort */ }
  }

  return { proposed: proposed.ok, callRouted }
}
