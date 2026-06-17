// lib/intelligence/stuck-stage-detector-runner.ts
//
// Live side of the STUCK-STAGE DETECTOR — for a contact, work out how long they've sat in their
// current lifecycle stage (from the latest lifecycle_events transition, falling back to the contact's
// updated_at), whether anyone's already working it (a future next_followup_at = being worked), and
// run the pure detector. If they're stuck with nothing in motion, surface it to the manager who owns
// that stage on the bus. Idempotent per (contact, stage). Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { detectStuckStage, ownerForStage, expectedDwellForStage } from "./stuck-stage-detector"
import { getPredictorTuning } from "./predictor-learning-runner"
import { shouldFireWithTuning } from "./predictor-learning"

type Svc = ReturnType<typeof createServiceClient>
const DAY = 86_400_000

export interface StuckStageArgs { brokerageId: string; contactId: string; now?: string }

export async function detectAndPublishStuckStage(args: StuckStageArgs, client?: Svc): Promise<{ published: boolean; stuck: boolean; stage: string | null; severity: string }> {
  const svc = client ?? createServiceClient()
  const nowMs = new Date(args.now ?? new Date().toISOString()).getTime()

  const { data: contact } = await svc.from("contacts")
    .select("lifecycle_state, nurture_status, next_followup_at, updated_at").eq("id", args.contactId).maybeSingle()
  if (!contact) return { published: false, stuck: false, stage: null, severity: "none" }
  const stage = ((contact as any).lifecycle_state ?? (contact as any).nurture_status ?? "").toString()
  if (!stage) return { published: false, stuck: false, stage: null, severity: "none" }

  // When did they enter this stage? The latest lifecycle_events transition, else the contact's updated_at.
  let stageEntryMs = new Date((contact as any).updated_at ?? new Date(nowMs).toISOString()).getTime()
  const { data: ev } = await svc.from("lifecycle_events")
    .select("created_at").eq("entity_type", "contact").eq("entity_id", args.contactId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle()
  if ((ev as any)?.created_at) { const t = new Date((ev as any).created_at).getTime(); if (Number.isFinite(t)) stageEntryMs = t }
  const daysInStage = Math.max(0, Math.floor((nowMs - stageEntryMs) / DAY))

  // Already being worked? A future-dated next_followup_at means someone's on it.
  const followAt = (contact as any).next_followup_at
  const hasOpenAction = !!followAt && new Date(followAt).getTime() > nowMs

  const result = detectStuckStage({ stage, daysInStage, expectedMaxDays: expectedDwellForStage(stage), hasOpenAction })
  if (!result.stuck) return { published: false, stuck: false, stage, severity: result.severity }

  // SELF-IMPROVING — consult the brokerage's stuck-stage track record; if its nudges have been
  // missing, only surface the strongest (overdue) cases. Honest on thin data.
  const tuning = await getPredictorTuning(svc, args.brokerageId, "stuck_stage").catch(() => null)
  if (tuning && !shouldFireWithTuning(result.severity, tuning)) {
    return { published: false, stuck: true, stage, severity: result.severity }
  }

  const owner = ownerForStage(stage)

  // Idempotent — one stall surface per (contact, stage) within the window.
  const since = new Date(nowMs - 14 * DAY).toISOString()
  const { data: prior } = await svc.from("manager_signals")
    .select("id").eq("brokerage_id", args.brokerageId).eq("signal_type", "stage_stalled")
    .eq("contact_id", args.contactId).gte("created_at", since).ilike("message", `%${stage}%`).limit(1).maybeSingle()
  if (prior) return { published: false, stuck: true, stage, severity: result.severity }

  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const r = await publishManagerSignal({
      brokerageId: args.brokerageId, fromManager: "data_steward", toManager: owner as any,
      signalType: "stage_stalled",
      message: `Stuck in "${stage}" (${result.severity}): ${result.reason}.`,
      entityType: "contact", entityId: args.contactId, contactId: args.contactId,
      payload: { stage, daysInStage, severity: result.severity, owner },
    }, svc)
    return { published: !!(r as any).ok, stuck: true, stage, severity: result.severity }
  } catch {
    return { published: false, stuck: true, stage, severity: result.severity }
  }
}
