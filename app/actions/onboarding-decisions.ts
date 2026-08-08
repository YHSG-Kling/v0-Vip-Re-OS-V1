"use server"

/**
 * app/actions/onboarding-decisions.ts
 *
 * THE ONBOARDING DECISION ROOM's actions. The one genuinely new act is
 * adopting the proposed AI assistant identity — a real go-live item:
 * the site chat, phone reception, and briefings speak as a NAMED
 * assistant the moment the brokerage-scope ai_identity_profiles row
 * exists (the tier cascade agent→team→brokerage already resolves it).
 * Principal-gated via the ONE shared tenancy rule (a solo agent is
 * their own principal; a team lead governs a team signup).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  attachLessons,
  composeOnboardingDecisions,
  loadOnboardingDecisionFacts,
  type OnboardingDecision,
} from "@/lib/onboarding/onboarding-decisions"

async function loadMember(): Promise<
  | { ok: true; userId: string; brokerageId: string; role: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: row } = await supabase
    .from("users").select("brokerage_id, user_type, role").eq("id", user.id).maybeSingle()
  if (!row?.brokerage_id) return { ok: false, error: "No brokerage" }
  return {
    ok: true,
    userId: user.id,
    brokerageId: (row as any).brokerage_id,
    role: String((row as any).role ?? (row as any).user_type ?? "agent"),
  }
}

/**
 * The client-callable re-read of the decision list.
 *
 * MERGED (wave 4 slice 2): this used to return `composeOnboardingDecisions(facts)`
 * raw, while the server card that renders the same list
 * (app/components/onboarding/setup-readiness-card.tsx) also runs `attachLessons`,
 * which hangs the /academy/module/… link off each decision. Swapping this
 * action's output into the rendered list would therefore have SILENTLY DROPPED
 * every lesson link. It now composes the identical shape, so the two are
 * interchangeable — which is the point: DecisionRoom can replace its list with
 * server truth instead of hand-writing an optimistic "done" card.
 */
export async function getOnboardingDecisionsAction(): Promise<
  | { ok: true; decisions: OnboardingDecision[] }
  | { ok: false; error: string }
> {
  const m = await loadMember()
  if (!m.ok) return { ok: false, error: m.error }
  const svc = createServiceClient()
  const facts = await loadOnboardingDecisionFacts(svc as any, { brokerageId: m.brokerageId })
  return {
    ok: true,
    decisions: attachLessons(composeOnboardingDecisions(facts), facts.moduleIdByTopic ?? new Map()),
  }
}

export async function adoptAssistantIdentityAction(): Promise<
  | { ok: true; assistantName: string }
  | { ok: false; error: string }
> {
  const m = await loadMember()
  if (!m.ok) return { ok: false, error: m.error }
  const svc = createServiceClient()

  const { isTenancyPrincipal } = await import("@/lib/kernel/tenancy-principal")
  const principal = await isTenancyPrincipal(svc as any, { userId: m.userId, brokerageId: m.brokerageId, role: m.role })
  if (!principal) return { ok: false, error: "Only the tenancy's principal can set the assistant identity" }

  // Idempotent: the brokerage-scope identity is UNIQUE(scope_type, scope_id).
  const { data: existing } = await svc.from("ai_identity_profiles")
    .select("id, assistant_name")
    .eq("scope_type", "brokerage").eq("scope_id", m.brokerageId)
    .maybeSingle()
  if (existing) return { ok: true, assistantName: (existing as any).assistant_name ?? "your assistant" }

  const { data: brk } = await svc.from("brokerages").select("name").eq("id", m.brokerageId).maybeSingle()
  const brandName = ((brk as any)?.name as string | null)?.trim() || "Our Team"
  const assistantName = `${brandName} Assistant`

  const { error } = await svc.from("ai_identity_profiles").insert({
    scope_type: "brokerage",
    scope_id: m.brokerageId,
    brokerage_id: m.brokerageId,
    assistant_name: assistantName,
    tone: "warm",
    formality_level: "semi_formal",
    active: true,
    welcome_message: `Hi, I'm ${assistantName} — ask me about our listings, the market, or how we work. A human is always one message away.`,
  })
  if (error) return { ok: false, error: error.message }

  // The adoption is a governance act — it goes on the SAME policy ledger.
  try {
    const { recordPolicyDecision } = await import("@/lib/documents/policy-decisions")
    await recordPolicyDecision(svc as any, {
      brokerageId: m.brokerageId,
      targetType: "ai_identity",
      targetId: "brokerage",
      verdict: {
        decision: "green",
        reasons: ["principal adopted the proposed assistant identity at onboarding"],
        recommendedAction: "assistant_identity_adopted",
        requiredApproverRole: null,
      },
      evidence: { adopted_by_user_id: m.userId, assistant_name: assistantName },
    })
  } catch { /* ledger best-effort */ }

  return { ok: true, assistantName }
}
