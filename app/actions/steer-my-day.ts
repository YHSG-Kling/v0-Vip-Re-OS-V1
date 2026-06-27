"use server"

// app/actions/steer-my-day.ts
// ─────────────────────────────────────────────────────────────────────────────
// STEER MY DAY (visual) — the agent's whole-funnel morning cockpit, surfaced on the briefing
// dashboard. The deterministic, signal-fused "work these first" queue (lead-warmth + relationship
// health across the funnel) that complements the LLM daily narrative. Agent-scoped (their OWN
// book, never broker oversight) via getAgentContext. The loader (getSteerMyDay) already exists +
// is tested + powers the voice admin; this adds the visual surface, with names enriched for display.

import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"
import { getSteerMyDay } from "@/lib/intelligence/steer-my-day-runner"

export interface SteerMyDayItemView {
  kind: "contact" | "lead"
  id: string
  name: string
  band: string
  drivers: string[]
}

export interface SteerMyDayView {
  headline: string
  planned: { total: number; willSend: number; blocked: number }
  items: SteerMyDayItemView[]
}

export async function loadSteerMyDay(): Promise<{ success: boolean; data?: SteerMyDayView; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  try {
    const svc = createServiceClient()
    const digest = await getSteerMyDay(svc, ctx.brokerageId, { agentId: ctx.agentId ?? undefined, topN: 5 })

    // Enrich the work-first IDs with names for display (best-effort).
    const contactIds = digest.workFirst.filter((w) => w.kind === "contact").map((w) => w.id)
    const leadIds = digest.workFirst.filter((w) => w.kind === "lead").map((w) => w.id)
    const [contactsRes, leadsRes] = await Promise.all([
      contactIds.length ? svc.from("contacts").select("id, first_name, last_name").in("id", contactIds) : Promise.resolve({ data: [] as any[] }),
      leadIds.length ? svc.from("leads").select("id, first_name, last_name").in("id", leadIds) : Promise.resolve({ data: [] as any[] }),
    ])
    const nameOf = (rows: any[] | null, id: string) => {
      const r = (rows ?? []).find((x) => x.id === id)
      const n = [r?.first_name, r?.last_name].filter(Boolean).join(" ").trim()
      return n || "Someone in your book"
    }
    const items: SteerMyDayItemView[] = digest.workFirst.map((w) => ({
      kind: w.kind, id: w.id, band: w.band, drivers: w.drivers ?? [],
      name: w.kind === "contact" ? nameOf(contactsRes.data, w.id) : nameOf(leadsRes.data, w.id),
    }))
    return { success: true, data: { headline: digest.headline, planned: digest.planned, items } }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "failed" }
  }
}
