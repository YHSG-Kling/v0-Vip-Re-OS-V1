// lib/kernel/onboarding-fallbehind.ts
//
// ONBOARDING FALL-BEHIND → BROKER INTERVENTION (recruiting_manager) — the tiered risk + broker handoff the
// onboarding journey needs. The existing onboarding-reminders nudges the AGENT; this adds the other half:
// when a new agent falls materially behind (red risk), the broker gets ONE gated intervention with a
// specific check-in script, so a stalling ramp is caught early (the strongest first-year-failure predictor).
// Reuses journeyProgress + fallBehindRisk (pure) and the gated proposal rail. Best-effort; never throws.

import { createServiceClient } from "@/lib/supabase/service"
import { journeyProgress, fallBehindRisk, type JourneyStep } from "@/lib/kernel/onboarding-journey"

type Svc = ReturnType<typeof createServiceClient>

export interface FallBehindResult { scanned: number; red: number; yellow: number; interventions: number }

/**
 * Scan a brokerage's ACTIVE onboarding agents for fall-behind risk and, on RED, propose ONE gated broker
 * intervention (deduped per agent + ISO week). Yellow is left to the agent-facing reminder. Best-effort.
 */
export async function runOnboardingFallBehind(svc: Svc, params: { brokerageId: string; now?: Date }): Promise<FallBehindResult> {
  const out: FallBehindResult = { scanned: 0, red: 0, yellow: 0, interventions: 0 }
  const now = params.now ?? new Date()

  const { data: obs } = await svc.from("agent_onboarding")
    .select("agent_id, current_day, start_date, status")
    .eq("brokerage_id", params.brokerageId).eq("status", "in_progress").limit(1000)
  const rows = (obs ?? []) as any[]
  if (rows.length === 0) return out

  const { data: stepRows } = await svc.from("onboarding_steps").select("id, day_number, required, target_role").or(`brokerage_id.eq.${params.brokerageId},brokerage_id.is.null`).limit(300)
  const steps: JourneyStep[] = ((stepRows ?? []) as any[]).filter((s) => !s.target_role || s.target_role === "agent").map((s) => ({ id: s.id, name: "", dayNumber: s.day_number ?? 1, required: !!s.required }))

  const week = `${now.getUTCFullYear()}-W${Math.ceil((((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86_400_000) + 1) / 7)}`

  for (const o of rows) {
    out.scanned++
    try {
      const day = o.current_day ?? (o.start_date ? Math.max(1, Math.floor((now.getTime() - Date.parse(o.start_date)) / 86_400_000) + 1) : 1)
      const { data: done } = await svc.from("agent_step_completions").select("step_id").eq("agent_id", o.agent_id).limit(500)
      const completed = new Set(((done ?? []) as any[]).map((r) => r.step_id))
      const prog = journeyProgress(day, steps, completed)
      const risk = fallBehindRisk(day, prog.overallPct)
      if (risk === "yellow") { out.yellow++; continue }
      if (risk !== "red") continue
      out.red++

      // Agent name for the intervention.
      const { data: ag } = await svc.from("agents").select("users(first_name, last_name)").eq("id", o.agent_id).maybeSingle()
      const name = [ (ag as any)?.users?.first_name, (ag as any)?.users?.last_name ].filter(Boolean).join(" ").trim() || "This new agent"

      const dedupeTag = `ONBOARDING FALL-BEHIND — agent:${o.agent_id} ${week}`
      const { data: prior } = await svc.from("agent_client_messages").select("id")
        .eq("brokerage_id", params.brokerageId).eq("entity_type", "agent").eq("entity_id", o.agent_id)
        .eq("agent_kind", "recruiting_manager").ilike("rationale", `${dedupeTag}%`).limit(1).maybeSingle()
      if (prior) continue

      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId: params.brokerageId, agentKind: "recruiting_manager", entityType: "agent", entityId: o.agent_id,
        recipientContactId: null, audience: "agent",
        subject: `${name} is falling behind on onboarding (Phase ${prog.phase})`,
        body: [
          `${name} is on day ${day} of their 90-day journey but only ${prog.overallPct}% through the required steps — a stalled ramp is the strongest first-year-failure signal.`,
          `A 10-minute check-in TODAY is the highest-leverage move. Find the specific step they're stuck on and clear it WITH them (or pair them with their mentor). Getting the next milestone done resets momentum.`,
          `Opener: "You're close on your setup — let's knock out the next step together right now. Which part felt confusing or stuck?"`,
        ].join("\n\n"),
        rationale: `${dedupeTag} — day ${day}, ${prog.overallPct}% complete, Phase ${prog.phase}; review before it reaches the broker.`,
        channel: "portal",
      }, svc)
      if (res.ok) out.interventions++
    } catch { /* keep going */ }
  }
  return out
}

/** Autonomous: run fall-behind detection across every brokerage (rides the daily onboarding-reminders cron). */
export async function runOnboardingFallBehindAll(svc: Svc, now?: Date): Promise<{ brokerages: number; red: number; interventions: number }> {
  const out = { brokerages: 0, red: 0, interventions: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runOnboardingFallBehind(svc, { brokerageId: b.id, now }); out.red += r.red; out.interventions += r.interventions } catch { /* keep going */ }
  }
  return out
}
