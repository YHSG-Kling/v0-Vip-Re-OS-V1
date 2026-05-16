"use server"

/**
 * Agent-side server actions for showing prep.
 *
 *   loadUpcomingShowingsForAgent  list page — every showing in the next
 *                                 7 days with briefing status
 *   loadShowingBriefing           detail page — the persisted briefing for one
 *                                 showing, or null if not yet generated
 *   regenerateShowingBriefing     on-demand "rebuild this brief now" button
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { buildShowingBriefing, persistShowingBriefing, type ShowingBriefing } from "@/lib/showings/showing-brief"

export interface UpcomingShowing {
  id:               string
  scheduledAt:      string | null
  durationMinutes:  number | null
  status:           string | null
  listingAddress:   string | null
  buyerName:        string | null
  hasBriefing:      boolean
  briefingGeneratedAt: string | null
}

export async function loadUpcomingShowingsForAgent(): Promise<{ rows: UpcomingShowing[] } | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { error: "No agent profile" }

  const fromIso = new Date(Date.now() - 2 * 3_600_000).toISOString()  // include 2h history so just-completed shows up
  const toIso   = new Date(Date.now() + 7 * 86_400_000).toISOString()

  const { data: showings } = await svc
    .from("showings")
    .select(`
      id, scheduled_at, duration_minutes, status,
      listing:listing_id (address),
      contact:contact_id (first_name, last_name),
      external_address
    `)
    .eq("agent_id", agentRow.id)
    .gte("scheduled_at", fromIso)
    .lt("scheduled_at", toIso)
    .order("scheduled_at", { ascending: true })
    .limit(50)

  const ids = (showings ?? []).map((s: { id: string }) => s.id)
  let briefingMap = new Map<string, string>()
  if (ids.length > 0) {
    const { data: existing } = await svc
      .from("showing_briefings")
      .select("showing_id, generated_at")
      .in("showing_id", ids)
    for (const b of existing ?? []) briefingMap.set(b.showing_id, b.generated_at)
  }

  const rows: UpcomingShowing[] = (showings ?? []).map((s: any) => ({
    id:                  s.id,
    scheduledAt:         s.scheduled_at ?? null,
    durationMinutes:     s.duration_minutes ?? null,
    status:              s.status ?? null,
    listingAddress:      s.listing?.address ?? s.external_address ?? null,
    buyerName:           s.contact ? `${s.contact.first_name ?? ""} ${s.contact.last_name ?? ""}`.trim() || null : null,
    hasBriefing:         briefingMap.has(s.id),
    briefingGeneratedAt: briefingMap.get(s.id) ?? null,
  }))

  return { rows }
}

export async function loadShowingBriefing(showingId: string): Promise<{ briefing: ShowingBriefing | null; showingScheduledAt: string | null; canRegenerate: boolean } | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  const svc = createServiceClient()
  // Verify the agent owns this showing
  const [{ data: agentRow }, { data: showing }] = await Promise.all([
    svc.from("agents").select("id, brokerage_id").eq("user_id", user.id).maybeSingle(),
    svc.from("showings").select("id, agent_id, brokerage_id, scheduled_at").eq("id", showingId).maybeSingle(),
  ])
  if (!agentRow?.id) return { error: "No agent profile" }
  if (!showing) return { error: "Showing not found" }
  if (showing.agent_id !== agentRow.id) return { error: "Not your showing" }

  // Pull persisted briefing
  const { data: row } = await svc
    .from("showing_briefings")
    .select("*")
    .eq("showing_id", showingId)
    .maybeSingle()

  const briefing: ShowingBriefing | null = row
    ? {
        showingId:          row.showing_id,
        scheduledAt:        showing.scheduled_at ?? null,
        durationMinutes:    null,
        accessInstructions: null,
        buyer:              (row.buyer_snapshot ?? {}) as any,
        property:           (row.listing_snapshot ?? {}) as any,
        matchup:            (row.matchup ?? []) as any,
        recentSignals:      [],
        predictedNextAction: null,
        recentComps:        (row.recent_comps ?? []) as any,
        buyerAlsoConsidered: (row.buyer_also_considered ?? []) as any,
        aiSummary:          row.ai_summary ?? null,
        aiTalkingPoints:    (row.ai_talking_points ?? []) as string[],
        aiObjections:       (row.ai_objections ?? []) as string[],
        aiRiskFlags:        (row.ai_risk_flags ?? []) as string[],
        modelUsed:          row.ai_model_used ?? null,
      }
    : null

  return { briefing, showingScheduledAt: showing.scheduled_at ?? null, canRegenerate: true }
}

export async function regenerateShowingBriefing(showingId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const [{ data: agentRow }, { data: showing }] = await Promise.all([
    svc.from("agents").select("id").eq("user_id", user.id).maybeSingle(),
    svc.from("showings").select("id, agent_id, brokerage_id").eq("id", showingId).maybeSingle(),
  ])
  if (!agentRow?.id) return { success: false, error: "No agent profile" }
  if (!showing) return { success: false, error: "Showing not found" }
  if (showing.agent_id !== agentRow.id) return { success: false, error: "Not your showing" }
  if (!showing.brokerage_id) return { success: false, error: "Showing missing brokerage" }

  try {
    const brief = await buildShowingBriefing(showingId)
    if (!brief) return { success: false, error: "Could not build briefing" }
    const persisted = await persistShowingBriefing(brief, showing.brokerage_id, agentRow.id)
    if (!persisted) return { success: false, error: "Could not save briefing" }
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Generation failed" }
  }
}
