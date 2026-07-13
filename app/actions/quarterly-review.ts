"use server"

/**
 * app/actions/quarterly-review.ts — the QBR + adoption-pulse loader
 * (tenant concierge #32 + #23/#31). Every number is a real trailing-90d
 * count from the tenant's own tables; the pure composers
 * (lib/intelligence/quarterly-review + adoption-pulse) turn them into the
 * review + the "who needs a hand" ranking. Principal-gated via the ONE
 * shared tier-parity rule (solo agent = own principal).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isTenancyPrincipal } from "@/lib/kernel/tenancy-principal"
import { composeQuarterlyReview, type QuarterlyReview } from "@/lib/intelligence/quarterly-review"
import { rankNeedsHelp, type PulseEntry } from "@/lib/intelligence/adoption-pulse"
import { decideExpansionSuggestion } from "@/lib/platform/expansion-advisor"

export async function getQuarterlyReviewAction(): Promise<
  | { ok: true; review: QuarterlyReview; pulse: PulseEntry[] }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: me } = await supabase.from("users").select("brokerage_id, role").eq("id", user.id).maybeSingle()
  const brokerageId = (me as any)?.brokerage_id as string | null
  if (!brokerageId) return { ok: false, error: "No brokerage" }
  const svc = createServiceClient()
  const principal = await isTenancyPrincipal(svc, { userId: user.id, brokerageId, role: String((me as any)?.role ?? "") })
  if (!principal) return { ok: false, error: "Principals only" }

  const now = new Date()
  const since = new Date(now.getTime() - 90 * 86_400_000)
  const sinceIso = since.toISOString()
  const since14 = new Date(now.getTime() - 14 * 86_400_000).toISOString()
  const since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString()

  const [
    { data: brk },
    { data: closedTx },
    { count: activeDeals },
    { count: newContacts },
    { count: approvals },
    { count: autoActs },
    { count: conflicts },
    { count: gifts },
    { count: briefingsOpened },
    { data: social },
    { data: agentRows },
  ] = await Promise.all([
    svc.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle(),
    svc.from("transactions").select("purchase_price").eq("brokerage_id", brokerageId).eq("status", "closed").gte("close_date", sinceIso.slice(0, 10)),
    svc.from("transactions").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).not("status", "in", '("closed","cancelled")'),
    svc.from("contacts").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).gte("created_at", sinceIso),
    svc.from("agent_client_messages").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).not("approved_at", "is", null).gte("created_at", sinceIso),
    svc.from("policy_decisions").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).ilike("recommended_action", "auto_%").gte("created_at", sinceIso),
    svc.from("policy_decisions").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("target_type", "transaction_deadline").eq("decision", "amber").gte("created_at", sinceIso),
    svc.from("client_gifts").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).gte("created_at", sinceIso),
    svc.from("ai_daily_briefings").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).not("opened_at", "is", null).gte("briefing_date", sinceIso.slice(0, 10)),
    svc.from("social_media_accounts").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(1).maybeSingle(),
    svc.from("agents").select("id, user_id, is_active").eq("brokerage_id", brokerageId).eq("is_active", true).limit(50),
  ])

  const agents = (agentRows ?? []) as Array<{ id: string; user_id: string | null }>
  const { data: grants } = await svc.from("managed_agents")
    .select("config").eq("brokerage_id", brokerageId).not("config", "is", null).limit(20)
  let grantsHeld = 0
  for (const g of ((grants ?? []) as Array<{ config: any }>)) {
    grantsHeld += Object.keys(g.config?.doc_kernel_grants ?? {}).length + Object.keys(g.config?.marketing_grants ?? {}).length
  }

  const unusedRails: string[] = []
  if (!social) unusedRails.push("Social publishing isn't connected — the cadence engine is idle.")
  if ((gifts ?? 0) === 0) unusedRails.push("No gifts ordered — the Gift Studio has your recent closings queued.")

  const closedRows = (closedTx ?? []) as Array<{ purchase_price: number | null }>
  const { count: locationCount } = await svc.from("locations")
    .select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
  const expansion = decideExpansionSuggestion({
    planTier: (brk as any)?.plan_tier ?? null,
    activeAgents: agents.length,
    locations: locationCount ?? 0,
  })

  const review = composeQuarterlyReview({
    windowLabel: `${since.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
    planTier: (brk as any)?.plan_tier ?? null,
    closedDeals: closedRows.length,
    closedVolume: closedRows.reduce((s, t) => s + (t.purchase_price ?? 0), 0),
    activeDeals: activeDeals ?? 0,
    newContacts: newContacts ?? 0,
    approvals: approvals ?? 0,
    autonomousActs: autoActs ?? 0,
    grantsHeld,
    conflictsCaught: conflicts ?? 0,
    giftsOrdered: gifts ?? 0,
    briefingsOpened: briefingsOpened ?? 0,
    unusedRails,
    expansion,
  })

  // ADOPTION PULSE — who needs a hand (per-agent, capped, thresholded).
  let pulse: PulseEntry[] = []
  try {
    const agentIds = agents.map((a) => a.id)
    const userIds = agents.map((a) => a.user_id).filter(Boolean) as string[]
    if (agentIds.length > 1) {
      const [{ data: overdue }, { data: stale }, { data: acts }, { data: briefs }, { data: names }] = await Promise.all([
        svc.from("tasks").select("assigned_to_agent_id").in("assigned_to_agent_id", agentIds).neq("status", "completed").lt("due_date", now.toISOString()).limit(1000),
        svc.from("contacts").select("agent_id").in("agent_id", agentIds).lt("last_contacted_at", since30).limit(1000),
        svc.from("activities").select("agent_id").in("agent_id", agentIds).gte("created_at", since14).limit(1000),
        svc.from("ai_daily_briefings").select("user_id").in("user_id", userIds).not("opened_at", "is", null).gte("briefing_date", since14.slice(0, 10)).limit(500),
        svc.from("users").select("id, first_name, last_name").in("id", userIds),
      ])
      const countBy = (rows: any[] | null, key: string) => {
        const m = new Map<string, number>()
        for (const r of (rows ?? [])) { const k = r[key]; if (k) m.set(k, (m.get(k) ?? 0) + 1) }
        return m
      }
      const overdueBy = countBy(overdue, "assigned_to_agent_id")
      const staleBy = countBy(stale, "agent_id")
      const actsBy = countBy(acts, "agent_id")
      const briefedUsers = new Set(((briefs ?? []) as any[]).map((b) => b.user_id))
      const nameByUser = new Map(((names ?? []) as any[]).map((u) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || "Agent"]))
      pulse = rankNeedsHelp(agents.map((a) => ({
        agentId: a.id,
        name: (a.user_id && nameByUser.get(a.user_id)) || "Agent",
        overdueTasks: overdueBy.get(a.id) ?? 0,
        staleContacts: staleBy.get(a.id) ?? 0,
        activities14d: actsBy.get(a.id) ?? 0,
        briefingOpened14d: a.user_id ? briefedUsers.has(a.user_id) : true,
      })))
    }
  } catch { /* pulse is best-effort — the QBR stands without it */ }

  return { ok: true, review, pulse }
}
