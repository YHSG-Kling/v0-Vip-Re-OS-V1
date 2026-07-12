/**
 * app/api/cron/farm-mail-weekly/route.ts
 *
 * Wave 36 — weekly farm-mail dispatcher. Walks every active agent
 * with at least one active farm_territory row, and for each one
 * fires dispatchFarmMail which:
 *   - resolves the agent's farm zip set
 *   - finds contacts in those zips with verified mailing addresses
 *   - groups by contact_persona
 *   - per persona, pulls a FRESH topic from content_topic_bank scored
 *     by per-(asset_type='direct_mail_postcard', persona) performance
 *   - orchestrates a branded postcard send with that topic woven into
 *     the AI copy via topicHook
 *   - records a content_topic_uses row to close the self-learning loop
 *
 * Schedule: 0 8 * * 4 — Thursday 08:00 UTC. Thursday so the postcards
 * land Saturday-Monday (Lob first-class transit is 4-7 days; weekend
 * mail saturates the recipient on a weekend when they actually read it).
 *
 * Budget guards (read from global_settings + per-brokerage settings,
 * with cron-level defaults):
 *   - FARM_MAIL_MAX_PER_AGENT_PER_WEEK = 50 contacts (≈ $39/agent/week)
 *   - FARM_MAIL_MAX_PER_BROKERAGE_PER_WEEK = 1000 contacts
 *   - dryRun=true when ?dry=1 — admin can preview without spend
 *   - FARM_MAIL_ENABLED brokerage flag — opt-in, default off
 *
 * The cron does NOT bypass the verification gate, the de-conflict gate
 * (30-day per-contact cap), the direct_mail_opt_out flag, the dnc_
 * status flag, or the Fair Housing compliance gate. All of those still
 * apply per-piece inside the orchestrator.
 *
 * Auth: CRON_SECRET. Same Bearer + ?secret= dual scheme as the other
 * marketing crons.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchFarmMail, type DispatchFarmMailResult } from "@/lib/farm-mail/dispatch-farm-mail"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

const DEFAULT_MAX_PER_AGENT     = 50
const DEFAULT_MAX_PER_BROKERAGE = 1000

interface AgentRow {
  id:           string
  user_id:      string | null
  brokerage_id: string
  users?:       { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null } | null
}

export async function GET(req: NextRequest) {
  const auth     = req.headers.get("authorization")?.replace("Bearer ", "")
  const url      = new URL(req.url)
  const qs       = url.searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return unauthorized()

  const dryRun         = url.searchParams.get("dry") === "1"
  const scopeBrokerage = url.searchParams.get("brokerage_id")  // dev-mode targeted run

  const svc = createServiceClient()

  // Per-brokerage opt-in lives on brokerage_brand_settings.metadata
  // (Wave 36: any brokerage that has set { farm_mail_enabled: true }
  // there will be included). Brokerages without explicit opt-in are
  // skipped so we never blast a tenant who hasn't budgeted for it.
  const { data: brokerages } = await svc
    .from("brokerages")
    .select("id, name, lob_fallback_template_id, farm_mail_enabled, farm_mail_max_per_week")
    .eq("farm_mail_enabled", true)
    .limit(500)

  const tenantRows = (brokerages ?? []) as Array<{
    id: string
    name: string | null
    lob_fallback_template_id: string | null
    farm_mail_enabled: boolean | null
    farm_mail_max_per_week: number | null
  }>

  const tenantScope = scopeBrokerage
    ? tenantRows.filter((b) => b.id === scopeBrokerage)
    : tenantRows

  const results: Array<{
    brokerage_id:   string
    brokerage_name: string | null
    agent_id:       string
    outcome:        DispatchFarmMailResult | { ok: false; error: string }
  }> = []

  for (const broker of tenantScope) {
    if (!broker.lob_fallback_template_id) {
      results.push({
        brokerage_id:   broker.id,
        brokerage_name: broker.name,
        agent_id:       "",
        outcome:        { ok: false, error: "no_lob_fallback_template_id_configured" },
      })
      continue
    }

    // Fetch agents with at least one active farm_territory in this brokerage.
    const { data: agents } = await svc
      .from("agents")
      .select("id, user_id, brokerage_id, is_active, users(first_name, last_name, email, phone)")
      .eq("brokerage_id", broker.id)
      .eq("is_active", true)
      .limit(500)
    const agentRows = ((agents ?? []) as unknown as Array<AgentRow & { is_active: boolean }>).filter((a) => !!a.id)

    // Pre-filter to agents with at least one active farm_territory row
    // so we don't dispatch (no-op) agents who haven't set a farm.
    const { data: territoryHolders } = await svc
      .from("farm_territories")
      .select("agent_id")
      .eq("brokerage_id", broker.id)
      .eq("is_active", true)
      .not("agent_id", "is", null)
    const eligibleAgentIds = new Set(
      ((territoryHolders ?? []) as Array<{ agent_id: string | null }>)
        .map((t) => t.agent_id)
        .filter((id): id is string => !!id),
    )
    const eligibleAgents = agentRows.filter((a) => eligibleAgentIds.has(a.id))

    const perAgentCap = broker.farm_mail_max_per_week ?? DEFAULT_MAX_PER_AGENT
    let brokerageRemainingCap = DEFAULT_MAX_PER_BROKERAGE

    for (const agent of eligibleAgents) {
      if (brokerageRemainingCap <= 0) {
        results.push({
          brokerage_id:   broker.id,
          brokerage_name: broker.name,
          agent_id:       agent.id,
          outcome:        { ok: false, error: "brokerage_weekly_cap_reached" },
        })
        continue
      }
      const capForThisAgent = Math.min(perAgentCap, brokerageRemainingCap)

      try {
        const outcome = await dispatchFarmMail({
          brokerageId:        broker.id,
          agentId:            agent.id,
          maxRecipients:      capForThisAgent,
          dryRun,
          fallbackTemplateId: broker.lob_fallback_template_id,
        })
        const sent = outcome.byPersona.reduce((acc, p) => acc + p.sent, 0)
        brokerageRemainingCap -= sent
        results.push({
          brokerage_id:   broker.id,
          brokerage_name: broker.name,
          agent_id:       agent.id,
          outcome,
        })
      } catch (e) {
        results.push({
          brokerage_id:   broker.id,
          brokerage_name: broker.name,
          agent_id:       agent.id,
          outcome:        { ok: false, error: (e as Error).message },
        })
      }
    }
  }

  // THE APPROVED-CAMPAIGN DRAIN — same mail heartbeat: approved 'planning'
  // campaign rows that carry their recipient mail through the shared
  // orchestrator (every gate applies); audience rows stay with their own
  // dispatchers. Approval is the last human stop — nothing strands after it.
  let drained = 0
  if (!dryRun) {
    try {
      const { runDirectMailCampaignDrain } = await import("@/lib/direct-mail/campaign-drain")
      const { data: allBrokerages } = await svc.from("brokerages").select("id").is("deleted_at", null)
      for (const b of ((allBrokerages ?? []) as Array<{ id: string }>)) {
        const r = await runDirectMailCampaignDrain(svc as any, { brokerageId: b.id })
        drained += r.sent
      }
    } catch (e) {
      console.error("[farm-mail-weekly] campaign drain failed (non-fatal):", e)
    }
  }

  return NextResponse.json({
    ran_at:               new Date().toISOString(),
    dry_run:              dryRun,
    brokerages_processed: tenantScope.length,
    agents_processed:     results.length,
    approved_campaigns_drained: drained,
    results,
  })
}
