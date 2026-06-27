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
    const digest = await getSteerMyDay(svc, ctx.brokerageId, { agentId: ctx.agentId ?? undefined, topN: 8 })

    // AGENTS WORK CONTACTS, NOT LEADS. A lead with no contact record is brokerage/ISA-owned, never
    // the agent's book — so the agent's cockpit shows only CONTACTS (drop lead-only work items).
    // Then take the top 5 contacts that need them first.
    const contactWork = digest.workFirst.filter((w) => w.kind === "contact").slice(0, 5)
    const contactIds = contactWork.map((w) => w.id)
    const contactsRes = contactIds.length
      ? await svc.from("contacts").select("id, first_name, last_name").in("id", contactIds)
      : { data: [] as any[] }
    const nameOf = (rows: any[] | null, id: string) => {
      const r = (rows ?? []).find((x) => x.id === id)
      const n = [r?.first_name, r?.last_name].filter(Boolean).join(" ").trim()
      return n || "Someone in your book"
    }
    const items: SteerMyDayItemView[] = contactWork.map((w) => ({
      kind: w.kind, id: w.id, band: w.band, drivers: w.drivers ?? [],
      name: nameOf(contactsRes.data, w.id),
    }))
    // Contacts-only headline (the digest's mentions leads, which agents don't see).
    const n = items.length
    const sendsPart = digest.planned.willSend > 0 || digest.planned.blocked > 0
      ? ` · your team plans ${digest.planned.willSend} send${digest.planned.willSend === 1 ? "" : "s"} today${digest.planned.blocked > 0 ? ` (${digest.planned.blocked} held by the gates)` : ""}`
      : ""
    const headline = (n > 0 ? `${n} client${n === 1 ? "" : "s"} slipping — work ${n === 1 ? "it" : "them"} first` : "no one slipping — you're on top of it") + sendsPart
    return { success: true, data: { headline, planned: digest.planned, items } }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "failed" }
  }
}
