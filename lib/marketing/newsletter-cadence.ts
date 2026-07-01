// ─── NEWSLETTER AUTO-CADENCE STAGER (session-free) ───────────────────────────
// Newsletter was the last standalone marketing type with no auto-cadence — a human had to
// build one every cycle. This stages a GATED newsletter draft from the topics pool on the
// agent's cadence, so the AI marketing studio produces it and the human just approves. The
// per-recipient section content is resolved at SEND time by the existing publish-newsletters
// path (pickTopics per recipient) — the cadence only needs to stage the gated envelope.
// Session-free (service client) so the cron can drive it. Idempotent: one per agent per day.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface StageNewsletterInput {
  brokerageId: string
  /** agents.id — newsletter_campaigns.agent_id FK → agents.id. */
  agentsId: string
  categories?: string[] | null
  persona?: string | null
}

export interface StageNewsletterResult {
  staged: boolean
  campaignId?: string
  subject?: string
  reason?: string
}

export async function stageNewsletterFromCadence(
  input: StageNewsletterInput,
  client?: Svc,
  opts?: { now?: Date },
): Promise<StageNewsletterResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()

  // Idempotency — one auto-staged newsletter per agent per day (mirrors the blog cadence tick).
  const { count } = await svc
    .from("newsletter_campaigns")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", input.brokerageId)
    .eq("agent_id", input.agentsId)
    .eq("is_ai_generated", true)
    .eq("status", "draft")
    .gte("created_at", todayStart)
  if ((count ?? 0) > 0) return { staged: false, reason: "already_staged_today" }

  // Pull a fresh topic from the pool — persona-aware, competitor-fed, repeat-avoidant.
  let topicTitle: string | null = null
  try {
    const { pickTopics } = await import("@/lib/content-intel/topic-bank")
    const topics = await pickTopics({
      brokerageId: input.brokerageId,
      categoriesAny: input.categories ?? undefined,
      limit: 3,
      recipientPersona: input.persona ?? undefined,
      markUsed: false, // the send-time resolver picks + marks per recipient; don't burn topics at staging
    })
    if (topics.length > 0) topicTitle = topics[0].topic_title ?? null
  } catch { /* topic pool best-effort — the evergreen subject below keeps it real */ }

  const monthLabel = now.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
  const subject = topicTitle || `Your ${monthLabel} real-estate update`

  const { data, error } = await svc
    .from("newsletter_campaigns")
    .insert({
      campaign_name: `Auto newsletter — ${now.toISOString().slice(0, 10)}`,
      subject_line: subject,
      status: "draft",
      approval_status: "pending_review", // GATED — a human approves before publish-newsletters sends it
      is_ai_generated: true,
      brokerage_id: input.brokerageId,
      agent_id: input.agentsId,
    })
    .select("id")
    .maybeSingle()

  if (error || !data) return { staged: false, reason: error?.message ?? "insert_failed" }
  return { staged: true, campaignId: (data as { id: string }).id, subject }
}
