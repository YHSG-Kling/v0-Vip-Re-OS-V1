// lib/video/topic-video-runner.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE AUTONOMOUS TOPIC-POOL VIDEO RUNNER (wave 82, lane 82C; wave 83, lane 83B).
//
// Called from the EXISTING daily video-plays cron (app/api/cron/video-plays —
// CRON_REGISTRY "30 15 * * *") as ITS OWN named step (wave 83: it was wrongly
// destructured into the listing-plays const beside runListingBrochures, which
// is a new-listing brochure capability — owner: "does not fit in for the
// capability"); no new cron. Per tenant, on the tenant's own slot days
// (topic-video.ts topicVideoSlotToday, from the tenant's CADENCE —
// brokerage_settings.settings.topic_video_cadence, default 3/week +1 in peak):
//
//   1. the slot's CONTACT PERSONA (contacts.contact_persona vocabulary — wave 83:
//      never contact_type), ASSIGNED from the rotation of the personas the
//      tenant's own book carries, + in-season categories (topic-video.ts),
//   2. ONE topic from the ONE pool — pickTopics (freshness, the tenant's own
//      city/state/zip as the territory boost, per-persona performance learning
//      keyed by that SAME persona, the 30-day office claim — which is what keeps
//      a topic from repeating across the week's slots) — never a second pool,
//   3. the fronting agent (rotated through the tenant's active agents): AVATAR
//      when one of the next MAX_TWIN_PROBES has a D-ID twin that can render,
//      else the rotation's agent on the VOICEOVER host (wave 83 closes 82C's
//      gap: voiceover_explainer, kinetic text under the agent's voice),
//   4. the archetype by rule, the script written COMPLIANCE-FIRST through the
//      routed, booked model lane (generateObjectRouted, feature
//      video_script_generation, brokerageId from the tenant row the cron read —
//      a system job has no session; the tenant is the row being processed),
//      scanned for hard fair-housing flags (a flag skips the topic, never ships),
//      and POST-CHECKED (postcheckScript — warnings pass through, recorded),
//   5. commissioned through the ONE Director rail (commissionCustomVideo →
//      compliance gate, plan-before-send gate, status pending_review — every
//      customer-facing video waits for a human approval), and
//   6. the CLAIM recorded (logTopicUses, asset_id = the video project) AFTER the
//      asset exists — which is what the performance aggregator joins engagement
//      to, so next week's pick learns from this one. The slot's persona is stamped
//      on the staged row (video_metadata.topic_persona — wave 83, lane 83F) so the
//      aggregator's topic-video pass writes situational_reel rows keyed by it.
//
// Every skip is counted BY NAME in the result — "nothing happened" is never silent.

import "server-only"
import { z } from "zod"
import {
  TOPIC_VIDEO_CADENCE_KEY, TOPIC_VIDEO_PERSONA_KEY, personaForSlot, personaRotation, resolveTopicVideoCadence, seasonalCategories,
  topicCategoriesForPersona, topicPersonaSide, topicScriptPrompt, topicScriptWords, topicVideoBrief,
  topicVideoContent, topicVideoSlotToday, topicVideosPerWeek, isoWeek,
} from "./topic-video"
import { planCustomVideo } from "./custom-video-archetypes"
import type { HostKind } from "./duration-model"
import type { BodyVisualAssets } from "./body-visual-model"

export interface TopicVideoRunResult {
  tenantsConsidered: number
  tenantsDue: number
  topicVideos: number
  /** How many staged on each host — the voiceover path is visible, never folded in. */
  byHost: Record<string, number>
  skipped: Record<string, number>
  errors: number
}

const TopicScriptSchema = z.object({
  script: z.string().min(20).max(2400),
  title: z.string().min(2).max(80),
  hook: z.string().min(3).max(120),
  bullets: z.array(z.string().min(1).max(60)).min(1).max(4),
})

/** Agents probed for a ready twin per tenant per run (each probe is a presenter lookup). */
const MAX_TWIN_PROBES = 5
/** Rows of the tenant's book read to learn which contact personas it carries. */
const PERSONA_SAMPLE_ROWS = 2000

function bump(r: TopicVideoRunResult, why: string) { r.skipped[why] = (r.skipped[why] ?? 0) + 1 }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runTopicPoolVideos(svc: any, now: Date = new Date()): Promise<TopicVideoRunResult> {
  const out: TopicVideoRunResult = { tenantsConsidered: 0, tenantsDue: 0, topicVideos: 0, byHost: {}, skipped: {}, errors: 0 }
  const { data: tenants, error: tenantErr } = await svc.from("brokerages")
    .select("id, city, state, zip, is_demo")
    .eq("is_active", true).is("deleted_at", null).limit(2000)
  if (tenantErr) {
    console.error("[topic-video-runner] brokerages read refused:", tenantErr.message)
    out.errors += 1
    return out
  }
  // THE CADENCE — one read of every tenant's setting (a system job reading every
  // tenant, like the brokerages read above). A refused read FAILS CLOSED to the
  // default cadence and is counted — never "every tenant switched off".
  const cadenceByTenant = new Map<string, unknown>()
  const { data: cadenceRows, error: cadenceErr } = await svc.from("brokerage_settings")
    .select(`brokerage_id, cadence:settings->${TOPIC_VIDEO_CADENCE_KEY}`).limit(5000)
  if (cadenceErr) { bump(out, "cadence_read_refused_default_used"); console.warn("[topic-video-runner] cadence read refused:", cadenceErr.message) }
  for (const row of (cadenceRows ?? []) as Array<{ brokerage_id: string; cadence: unknown }>) cadenceByTenant.set(row.brokerage_id, row.cadence)

  const season = seasonalCategories(now.getUTCMonth())
  const { pickTopics } = await import("@/lib/content-intel/topic-bank")
  const { logTopicUses } = await import("@/lib/content-intel/performance-aggregator")
  const { commissionCustomVideo } = await import("./video-director")

  for (const t of (tenants ?? []) as Array<{ id: string; city: string | null; state: string | null; zip: string | null; is_demo: boolean | null }>) {
    out.tenantsConsidered += 1
    if (t.is_demo) { bump(out, "demo_tenant"); continue }
    const cadence = resolveTopicVideoCadence(cadenceByTenant.get(t.id))
    if (!cadence.enabled) { bump(out, "cadence_off"); continue }
    const slot = topicVideoSlotToday(t.id, now, cadence)
    if (slot < 0) { bump(out, "not_this_tenants_day"); continue }
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
      // stat cards or client clips. The fronting agent is the next one in the
      // rotation whose D-ID twin can render (at most MAX_TWIN_PROBES probed —
      // cost-down) → the AVATAR host (education_explainer). No ready twin → the
      // rotation's own agent on the VOICEOVER host (voiceover_explainer: kinetic
      // text under their voice) — counted by host, never skipped for want of a twin.
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
      const host: HostKind = agent ? "avatar" : "voiceover"
      if (!agent) { agent = roster[start]; bump(out, "no_twin_ready_voiceover_used") }

      // ── the slot's CONTACT PERSONA — from the tenant's own book (contacts.contact_persona) ──
      const { data: book, error: bookErr } = await svc.from("contacts")
        .select("contact_persona").eq("brokerage_id", t.id).not("contact_persona", "is", null).limit(PERSONA_SAMPLE_ROWS)
      if (bookErr) bump(out, "persona_read_refused_full_roster_used")
      const rotation = personaRotation(((book ?? []) as Array<{ contact_persona: string | null }>).map((r) => r.contact_persona))
      const persona = personaForSlot(now, t.id, slot, topicVideosPerWeek(cadence, now.getUTCMonth()), rotation)

      // ── ONE topic from the ONE pool ──
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

      const assets: BodyVisualAssets = {
        avatarClip: host === "avatar", brollClips: 0, propertyPhotos: 0, screenshots: 0,
        statCards: 0, clientFootage: 0, chartData: false,
      }

      // ── shape by rule, then the script (compliance-first) ──
      const first = topicVideoBrief({ topic, persona, host, assets })
      const planned = planCustomVideo(first.brief)
      if (!planned.ok) { bump(out, "unplanned"); console.warn("[topic-video-runner] unplanned:", planned.reason); continue }
      const words = topicScriptWords(planned.plan.band.targetSeconds, host)
      const side = topicPersonaSide(persona)

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
      const flags = detectFairHousingRedFlags(`${object.title}\n${object.hook}\n${object.bullets.join("\n")}\n${object.script}`, side)
      if (flags.length > 0) { bump(out, "fair_housing_red_flag"); console.warn("[topic-video-runner] script refused:", flags.join("; ")); continue }
      // COMPLIANCE-FIRST IS BOTH HALVES (CLAUDE.md §5; test:video-script-compliance
      // GATE-ROSTER-EVERY-CALLER-POSTCHECKS): the compliance blocks rode the writing prompt
      // above; the written script is now post-checked against the tenant's brand voice and
      // prohibited phrases. Warnings PASS THROUGH (the Director stages pending_review, a
      // person approves) and are PERSISTED on the staged row below — never a silent audit.
      // The service client: this runner is cron-reached with no session (same reason as
      // chapter-video-generator.ts's postcheck).
      const { postcheckScript } = await import("./script-compliance")
      const complianceWarnings = await postcheckScript(
        { userId: agent.user_id, brokerageId: t.id },
        object.script,
        side,
        { client: svc },
      )

      const { brief } = topicVideoBrief({
        topic, persona, host, assets,
        content: topicVideoContent(planned.plan.compositionId, object),
      })
      const r = await commissionCustomVideo(brief, { brokerageId: t.id, agentUserId: agent.user_id, targetChannel: "instagram" }, svc)
      if (!r.ok || !r.videoProjectId || r.status !== "staged") { bump(out, `director_${r.status}`); continue }
      // THE PERSONA STAMP (wave 83, lane 83F) — per-persona learning attributes this
      // video's outcomes to the persona it spoke to, so the persona rides the staged
      // row (video_metadata[TOPIC_VIDEO_PERSONA_KEY]) where the performance aggregator
      // reads it back. video_metadata is MERGED, never replaced (the Director's
      // director_key / composition / cut live there): read it tenant-scoped first; a
      // refused read leaves the stamp off (counted) rather than overwrite what it
      // could not see. Compliance warnings ride the SAME tenant-scoped, counted write.
      const { data: staged, error: stagedErr } = await svc.from("ai_video_projects")
        .select("video_metadata").eq("id", r.videoProjectId).eq("brokerage_id", t.id).maybeSingle()
      const stampable = !stagedErr && !!staged
      if (!stampable) bump(out, "persona_stamp_unreadable")
      const hasWarnings = !!complianceWarnings && complianceWarnings.length > 0
      const patch: Record<string, unknown> = {}
      if (stampable) {
        const meta = (staged as { video_metadata: Record<string, unknown> | null }).video_metadata ?? {}
        patch.video_metadata = { ...meta, [TOPIC_VIDEO_PERSONA_KEY]: persona }
      }
      if (hasWarnings) patch.compliance_violations = complianceWarnings
      if (Object.keys(patch).length > 0) {
        const { data: noted, error: noteErr } = await svc.from("ai_video_projects")
          .update(patch)
          .eq("id", r.videoProjectId).eq("brokerage_id", t.id).select("id")
        const landed = !noteErr && !!noted && noted.length === 1
        if (!landed) console.warn("[topic-video-runner] staged-row stamp not recorded:", noteErr?.message ?? `matched ${noted?.length ?? 0}`)
        if (stampable) bump(out, landed ? "persona_stamped" : "persona_stamp_unrecorded")
        if (hasWarnings) bump(out, landed ? "compliance_warnings_recorded" : "compliance_warnings_unrecorded")
      }

      await logTopicUses({ topicIds: [topic.id], brokerageId: t.id, assetType: "situational_reel", assetId: r.videoProjectId, agentId: agent.id })
      out.topicVideos += 1
      out.byHost[host] = (out.byHost[host] ?? 0) + 1
    } catch (e) {
      out.errors += 1
      console.error("[topic-video-runner] tenant failed:", t.id, (e as Error).message)
    }
  }
  return out
}
