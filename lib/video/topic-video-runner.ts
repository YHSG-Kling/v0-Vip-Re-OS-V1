// lib/video/topic-video-runner.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE AUTONOMOUS TOPIC-POOL VIDEO RUNNER (wave 82, lane 82C).
//
// Called from the EXISTING daily video-plays cron (app/api/cron/video-plays —
// CRON_REGISTRY "30 15 * * *"); no new cron. Per tenant, on the tenant's own
// weekday(s) (topic-video.ts isTopicVideoDay):
//
//   1. PERSONA of the week + in-season categories (topic-video.ts),
//   2. ONE topic from the ONE pool — pickTopics (freshness, the tenant's own
//      city/state/zip as the territory boost, per-persona performance learning,
//      the 30-day office claim) — never a second pool,
//   3. the fronting agent (rotated through the tenant's active agents) and the
//      host their twin supports (avatar when the D-ID twin can render, else the
//      cloned-voice voiceover),
//   4. the archetype by rule, the script written COMPLIANCE-FIRST through the
//      routed, booked model lane (generateObjectRouted, feature
//      video_script_generation, brokerageId from the tenant row the cron read —
//      a system job has no session; the tenant is the row being processed),
//      scanned for hard fair-housing flags (a flag skips the topic, never ships),
//   5. commissioned through the ONE Director rail (commissionCustomVideo →
//      compliance gate, plan-before-send gate, status pending_review — every
//      customer-facing video waits for a human approval), and
//   6. the CLAIM recorded (logTopicUses, asset_id = the video project) AFTER the
//      asset exists — which is what the performance aggregator joins engagement
//      to, so next week's pick learns from this one.
//
// Every skip is counted BY NAME in the result — "nothing happened" is never silent.

import "server-only"
import { z } from "zod"
import {
  isTopicVideoDay, personaForWeek, seasonalCategories, topicCategoriesForPersona,
  topicVideoBrief, topicScriptPrompt, topicScriptWords, isoWeek,
} from "./topic-video"
import { planCustomVideo } from "./custom-video-archetypes"
import type { HostKind } from "./duration-model"
import type { BodyVisualAssets } from "./body-visual-model"

export interface TopicVideoRunResult {
  tenantsConsidered: number
  tenantsDue: number
  topicVideos: number
  skipped: Record<string, number>
  errors: number
}

const TopicScriptSchema = z.object({
  script: z.string().min(20).max(2400),
  title: z.string().min(2).max(80),
  bullets: z.array(z.string().min(1).max(60)).min(1).max(4),
})

/** Agents probed for a ready twin per tenant per run (each probe is a presenter lookup). */
const MAX_TWIN_PROBES = 5

function bump(r: TopicVideoRunResult, why: string) { r.skipped[why] = (r.skipped[why] ?? 0) + 1 }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runTopicPoolVideos(svc: any, now: Date = new Date()): Promise<TopicVideoRunResult> {
  const out: TopicVideoRunResult = { tenantsConsidered: 0, tenantsDue: 0, topicVideos: 0, skipped: {}, errors: 0 }
  const { data: tenants, error: tenantErr } = await svc.from("brokerages")
    .select("id, city, state, zip, is_demo")
    .eq("is_active", true).is("deleted_at", null).limit(2000)
  if (tenantErr) {
    console.error("[topic-video-runner] brokerages read refused:", tenantErr.message)
    out.errors += 1
    return out
  }
  const season = seasonalCategories(now.getUTCMonth())
  const { pickTopics } = await import("@/lib/content-intel/topic-bank")
  const { logTopicUses } = await import("@/lib/content-intel/performance-aggregator")
  const { commissionCustomVideo } = await import("./video-director")

  for (const t of (tenants ?? []) as Array<{ id: string; city: string | null; state: string | null; zip: string | null; is_demo: boolean | null }>) {
    out.tenantsConsidered += 1
    if (t.is_demo) { bump(out, "demo_tenant"); continue }
    if (!isTopicVideoDay(t.id, now)) { bump(out, "not_this_tenants_day"); continue }
    out.tenantsDue += 1
    try {
      // ── the fronting agent (rotated) ──
      const { data: agents, error: agentErr } = await svc.from("agents")
        .select("id, user_id").eq("brokerage_id", t.id).eq("is_active", true).not("user_id", "is", null)
        .order("created_at", { ascending: true }).limit(200)
      if (agentErr) { bump(out, "agents_read_refused"); continue }
      const roster = (agents ?? []) as Array<{ id: string; user_id: string }>
      if (roster.length === 0) { bump(out, "no_active_agent"); continue }
      // THE HOST IS DERIVED, NOT ASSUMED: a topic video carries no photos, screens,
      // stat cards or client clips, and the only needs-free archetypes
      // (education_explainer, talking_head_message) are registered on the AVATAR
      // host alone (custom-video-archetypes.ts archetypeHosts — the composition
      // registry has no voiceover explainer). So the fronting agent is the next one
      // in the rotation whose D-ID twin can render; at most MAX_TWIN_PROBES are
      // probed (cost-down), and a tenant with no ready twin is skipped BY NAME.
      const start = (isoWeek(now) * 7 + now.getUTCDay()) % roster.length
      let agent: { id: string; user_id: string } | null = null
      const { resolveAgentPresenterMedia } = await import("./presenter-media")
      for (let i = 0; i < Math.min(MAX_TWIN_PROBES, roster.length); i++) {
        const candidate = roster[(start + i) % roster.length]
        try {
          const p = await resolveAgentPresenterMedia({ agentUserId: candidate.user_id, brokerageId: t.id }, svc)
          if (p.canRender) { agent = candidate; break }
        } catch { /* probe the next agent */ }
      }
      if (!agent) { bump(out, "no_twin_ready"); continue }

      // ── ONE topic from the ONE pool ──
      const persona = personaForWeek(now, t.id)
      const topics = await pickTopics({
        brokerageId: t.id,
        categoriesAny: topicCategoriesForPersona(persona),
        limit: 1,
        markUsed: false, // the claim is logged AFTER the asset exists (below)
        recipientLocation: { city: t.city, state: t.state, zip_code: t.zip },
        recipientPersona: persona,
        assetType: "situational_reel",
        agentId: agent.id,
        boostCategories: season.categories,
      })
      const topic = topics[0]
      if (!topic) { bump(out, "pool_empty_for_persona"); continue }

      // ── host: the fronting agent's twin (chosen above because it can render) ──
      const host: HostKind = "avatar"
      const assets: BodyVisualAssets = {
        avatarClip: true, brollClips: 0, propertyPhotos: 0, screenshots: 0,
        statCards: 0, clientFootage: 0, chartData: false,
      }

      // ── shape by rule, then the script (compliance-first) ──
      const first = topicVideoBrief({ topic, persona, host, assets })
      const planned = planCustomVideo(first.brief)
      if (!planned.ok) { bump(out, "unplanned"); console.warn("[topic-video-runner] unplanned:", planned.reason); continue }
      const words = topicScriptWords(planned.plan.band.targetSeconds, host)

      const { generateObjectRouted } = await import("@/lib/ai/models")
      const { buildComplianceSystemBlocks, detectFairHousingRedFlags } = await import("./script-compliance")
      const { withSpokenScriptStandards, scanForAiTells } = await import("./realism-profile")
      const system = (await buildComplianceSystemBlocks(t.id, undefined, svc)).join("\n\n")
      const basePrompt = withSpokenScriptStandards(topicScriptPrompt({ topic, persona, words, archetype: first.choice.archetype }))
      const draft = async (prompt: string) => (await generateObjectRouted({
        feature: "video_script_generation",
        brokerageId: t.id,
        userId: agent.user_id,
        agentId: agent.id,
        system,
        prompt,
        schema: TopicScriptSchema,
        maxTokens: 1200,
      })).object
      // REALISM (the §gate every spoken writer passes): AI tells are ADVISORY input to ONE
      // redraft, never a silent block (realism-profile.ts scanForAiTells).
      let object = await draft(basePrompt)
      const tells = scanForAiTells(object.script)
      if (tells.length > 0) {
        object = await draft(`${basePrompt}\n\nRewrite to remove these tells: ${tells.join("; ")}`)
        if (scanForAiTells(object.script).length > 0) bump(out, "ai_tells_after_redraft_advisory")
      }
      const flags = detectFairHousingRedFlags(`${object.title}\n${object.bullets.join("\n")}\n${object.script}`, persona === "seller" ? "seller" : "buyer")
      if (flags.length > 0) { bump(out, "fair_housing_red_flag"); console.warn("[topic-video-runner] script refused:", flags.join("; ")); continue }

      const { brief } = topicVideoBrief({
        topic, persona, host, assets,
        content: { captionScript: object.script, caption: object.script, title: object.title, bullets: object.bullets },
      })
      const r = await commissionCustomVideo(brief, { brokerageId: t.id, agentUserId: agent.user_id, targetChannel: "instagram" }, svc)
      if (!r.ok || !r.videoProjectId || r.status !== "staged") { bump(out, `director_${r.status}`); continue }

      await logTopicUses({ topicIds: [topic.id], brokerageId: t.id, assetType: "situational_reel", assetId: r.videoProjectId, agentId: agent.id })
      out.topicVideos += 1
    } catch (e) {
      out.errors += 1
      console.error("[topic-video-runner] tenant failed:", t.id, (e as Error).message)
    }
  }
  return out
}
