/**
 * lib/video/render-from-approval.ts — RENDER AN APPROVED VIDEO SCRIPT, with no
 * session (wave 87, lane 87D).
 *
 * THE GAP (lane 86F3's open item, verbatim): "Unattended render. A
 * video.script_approved event can only notify. Rendering from an event needs a
 * session-free submitVideoGenerationJob plus an avatar choice." And a second
 * gap under it, found while building this: the event had NO EMITTER — the one
 * gated approval writer (app/actions/video-generation.ts
 * updateScriptApprovalStatus) and the shared queue transition
 * (lib/kernel/approval-queue-aggregator.ts applyMarketingAssetApproval) both
 * approved the script and dispatched nothing, so even the notification never
 * fired. Both now emit through the ONE dispatching core
 * (lib/events/lifecycle-event-core.ts recordLifecycleEvent), and the hub's
 * reaction (lib/video/video-event-reactions.ts reactToVideoScriptApproved)
 * calls this.
 *
 * WHY NOT submitVideoGenerationJob (lib/kernel/video.ts). It is the studio's
 * SESSION door: the cookie client, auth.getUser() as the actor, and a caller-
 * supplied avatar id. Making it session-free would mean a second, parameter-
 * trusting door on a public module. The unattended render already has a rail
 * that is session-free, metered and gated end to end — the Director:
 *
 *   commissionVideo (lib/video/video-director.ts)
 *     → gateVideoCreation (the 86B tier meter; refuses only a tier that
 *       excludes video) → the hook gate → the content contract → the body-
 *       visual plan → readyVisualPlanForDispatch (lib/video/plan-asset-
 *       readiness.ts: read the plan, check the buckets, create only what is
 *       honest, gate) → the staged row (status 'queued') → meterVideoCreation
 *   → app/api/cron/director-reel-render (every 5 min)
 *       avatar  → lib/did generateVideo (submitOnly; consent gate inside)
 *       voice   → prepareReelVoiceover → the composition render (wave 87)
 *   → poll-did-videos / render-composition → completion
 *   → the stuck-render watchdog (lib/video/video-pipeline-reaper.ts
 *     sweepStuckVideoRenders, every director-reel-render tick) — a row can
 *     never sit in 'queued' / 'generating' forever; every failure writes
 *     status 'failed' + error_message.
 *
 * So this core decides only what that rail cannot: WHICH AGENT fronts the
 * video (agents.id resolved in the tenant, users.id crossed from it — §3), the
 * HOST (the agent's D-ID twin first; voiceover when there is none), the SHAPE
 * (lib/video/approval-render-plan.ts, pure), and the idempotency key; then
 * commissions it. The approved text is the narration VERBATIM — the Director's
 * hook drafter is handed the approved hook (its copyGenerator seam), so no
 * model spend and no words nobody approved.
 *
 * COMPLIANCE-FIRST, BOTH HALVES (CLAUDE.md §5). The approval itself is the
 * human release of any hold (lib/video/video-render-hold.ts). The script is
 * still POST-CHECKED here (postcheckScript on the service client — warnings
 * pass through and are persisted on the staged row), and the Director's hook
 * gate runs evaluateOutbound on what goes on screen.
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed:
 * the EVENT ROW's tenant, which the emitters wrote from a session (the gated
 * approval action) or a tenant-checked queue row.
 */
import "server-only"
import {
  approvalRenderDiscriminator, approvalScriptSide, approvedTextHash, chooseApprovalRenderHost, planApprovalRender,
  priorAttemptVerdict, type ApprovedScriptRow, type HostChoice, type TwinReadiness,
} from "./approval-render-plan"

export interface ApprovalRenderOutcome {
  ok: boolean
  status: "staged" | "already_staged" | "refused" | "blocked" | "failed"
  reason: string
  host?: HostChoice["host"]
  hostReason?: string
  videoProjectId?: string
  compositionId?: string
  /** users.id of the fronting agent — the notification recipient. */
  agentUserId?: string | null
  /** Advisory compliance + structure findings persisted on the staged row. */
  warnings: string[]
}

const refuse = (reason: string, extra: Partial<ApprovalRenderOutcome> = {}): ApprovalRenderOutcome =>
  ({ ok: false, status: "refused", reason, warnings: [], ...extra })

/** The fronting agent of a library script: agents.id + users.id, both IN the tenant. */
async function resolveFrontingAgent(
  svc: any, brokerageId: string, row: { agent_id: string | null; created_by: string | null },
): Promise<{ ok: true; agentId: string; agentUserId: string } | { ok: false; reason: string }> {
  if (row.agent_id) {
    const { data, error } = await svc.from("agents").select("id, user_id")
      .eq("id", row.agent_id).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `agents read refused: ${error.message}` }
    const a = data as { id: string; user_id: string | null } | null
    if (!a) return { ok: false, reason: `agents.id=${row.agent_id} is not in brokerage ${brokerageId}` }
    if (!a.user_id) return { ok: false, reason: `agents.id=${a.id} has no users row — nobody can front the video` }
    return { ok: true, agentId: a.id, agentUserId: a.user_id }
  }
  if (row.created_by) {
    const { resolveAgentIdInBrokerage } = await import("@/lib/kernel/agent-identity")
    const agentId = await resolveAgentIdInBrokerage(svc, row.created_by, brokerageId)
    if (!agentId) return { ok: false, reason: `the script's author (users.id=${row.created_by}) holds no agents row in brokerage ${brokerageId}` }
    return { ok: true, agentId, agentUserId: row.created_by }
  }
  return { ok: false, reason: "the script names no agent and no author — nobody fronts the video" }
}

/**
 * D-ID FIRST: can the agent's twin render, and would D-ID accept its face?
 * Reuses the two survivors — never a second resolver: presenter-media (the
 * render worker's own readiness check) and the consent gate lib/did/index.ts
 * generateVideo runs before any submit.
 */
async function twinReadiness(svc: any, brokerageId: string, agentId: string, agentUserId: string): Promise<TwinReadiness> {
  try {
    const { resolveAgentPresenterMedia } = await import("@/lib/video/presenter-media")
    const presenter = await resolveAgentPresenterMedia({ agentUserId, brokerageId }, svc)
    if (!presenter.canRender) return { canRender: false, consentOk: false, reason: "no D-ID actor id or avatar source (Settings → Voice & Avatar)" }
    if (presenter.actorId) return { canRender: true, consentOk: true }
    const { requireConsentForVideoAvatarSource } = await import("@/lib/did/avatar-consent-gate")
    const consent = await requireConsentForVideoAvatarSource(svc, agentId, presenter.avatarImageUrl)
    return consent.ok
      ? { canRender: true, consentOk: true }
      : { canRender: true, consentOk: false, reason: consent.refusal.message }
  } catch (e) {
    // A readiness check that cannot run never guesses an avatar (a guessed
    // avatar spends D-ID credits on a face that may be refused) — voiceover.
    return { canRender: false, consentOk: false, reason: `twin readiness could not be read (${(e as Error).message})` }
  }
}

/**
 * Injectable seams (the proof executes this core with no network): the
 * Director commission, the twin probe and the post-check. Production passes
 * none — each defaults to its survivor.
 */
export interface ApprovalRenderDeps {
  commission?: typeof import("@/lib/video/video-director").commissionVideo
  twin?: (svc: any, brokerageId: string, agentId: string, agentUserId: string) => Promise<TwinReadiness>
  postcheck?: (actor: { userId: string; brokerageId: string }, script: string, side: "buyer" | "seller", svc: any) => Promise<string[] | undefined>
  loadOverrides?: (brokerageId: string, svc: any) => Promise<import("@/lib/video/body-visual-model").BodyVisualRuleOverride[] | null>
}

export async function renderApprovedVideoScript(
  svc: any,
  brokerageId: string,
  input: { scriptId: string; approvedByUserId?: string | null },
  deps: ApprovalRenderDeps = {},
): Promise<ApprovalRenderOutcome> {
  if (!brokerageId) return refuse("no brokerageId — an approved script is never rendered untenanted")
  if (!input.scriptId) return refuse("no script_id on the approval")

  // 1. THE SCRIPT — in this tenant, and really approved.
  const { data: scriptRow, error: sErr } = await svc.from("video_scripts_library")
    .select("id, title, script_content, script_type, approval_status, agent_id, created_by, listing_id, contact_id")
    .eq("id", input.scriptId).eq("brokerage_id", brokerageId).maybeSingle()
  if (sErr) return { ok: false, status: "failed", reason: `video script read refused: ${sErr.message}`, warnings: [] }
  const row = scriptRow as (ApprovedScriptRow & { approval_status: string | null; agent_id: string | null; created_by: string | null }) | null
  if (!row) return refuse(`video script ${input.scriptId} is not in brokerage ${brokerageId}`)
  if (row.approval_status !== "approved") return refuse(`video script ${row.id} is "${row.approval_status}", not approved — nothing is rendered before a human approves it`)
  const text = (row.script_content ?? "").trim()
  if (!text) return refuse(`video script ${row.id} has no content to render`)

  // 2. THE FRONTING AGENT (agents.id and users.id are disjoint — resolved, never substituted).
  const agent = await resolveFrontingAgent(svc, brokerageId, row)
  if (!agent.ok) return refuse(agent.reason)

  // 3. ONE RENDER PER (script, approved text). A live attempt is never
  //    duplicated; a failed one is retried under the next attempt number.
  const textHash = approvedTextHash(text)
  const { data: prior, error: pErr } = await svc.from("ai_video_projects")
    .select("id, status")
    .eq("brokerage_id", brokerageId)
    .eq("video_metadata->>approved_script_id", row.id)
    .eq("video_metadata->>approved_text_hash", textHash)
    .limit(20)
  // A refused read is not "no prior render" — rendering on it could double-bill.
  if (pErr) return { ok: false, status: "failed", reason: `prior-render read refused: ${pErr.message}`, warnings: [], agentUserId: agent.agentUserId }
  const priorRows = (prior ?? []) as Array<{ id: string; status: string }>
  const verdict = priorAttemptVerdict(priorRows.map((p) => p.status))
  if (verdict.live) {
    const live = priorRows.find((p) => p.status !== "failed")
    return { ok: true, status: "already_staged", reason: "this approved script already has a render in progress or finished", videoProjectId: live?.id, agentUserId: agent.agentUserId, warnings: [] }
  }

  // 4. THE HOST — D-ID first.
  const hostChoice = chooseApprovalRenderHost(await (deps.twin ?? twinReadiness)(svc, brokerageId, agent.agentId, agent.agentUserId))

  // 5. THE SHAPE (pure) under the tenant's live learned rule overrides.
  let overrides: import("@/lib/video/body-visual-model").BodyVisualRuleOverride[] | null = null
  try {
    if (deps.loadOverrides) overrides = await deps.loadOverrides(brokerageId, svc)
    else {
      const { loadBodyVisualRuleOverrides } = await import("@/lib/video/body-visual-rule-ledger")
      overrides = await loadBodyVisualRuleOverrides(brokerageId, svc)
    }
  } catch { overrides = null }
  const planned = planApprovalRender(row, hostChoice.host, { overrides })
  if (!planned.ok) return refuse(planned.reason, { host: hostChoice.host, hostReason: hostChoice.reason, agentUserId: agent.agentUserId })

  // 6. COMPLIANCE-FIRST, the post-check half — advisory, persisted, never silent.
  const side = approvalScriptSide(row.script_type)
  const compliance = deps.postcheck
    ? await deps.postcheck({ userId: agent.agentUserId, brokerageId }, text, side, svc)
    : await (await import("@/lib/video/script-compliance")).postcheckScript(
      { userId: agent.agentUserId, brokerageId }, text, side, { client: svc },
    )
  const warnings = [...(compliance ?? []), ...planned.structure.warnings]

  // 7. COMMISSION on the ONE Director rail (meter, gates, readiness, staged row).
  const commissionVideo = deps.commission ?? (await import("@/lib/video/video-director")).commissionVideo
  const plan = planned.plan
  const result = await commissionVideo(
    {
      kind: "custom",
      tier: "solo_agent",
      targetChannel: "instagram",
      facts: { customPlan: plan, goal: row.title ?? planned.copy.hook, audience: plan.reason },
    },
    {
      brokerageId,
      agentUserId: agent.agentUserId,
      listingId: row.listing_id ?? null,
      contactId: row.contact_id ?? null,
      title: (row.title ?? planned.copy.title).slice(0, 200),
      idempotencyDiscriminator: approvalRenderDiscriminator(row.id, text, verdict.failed),
      // The approved hook IS the hook — no model redraft (the Director still gates it).
      copyGenerator: async () => ({ body: planned.copy.hook }),
      // The host was chosen here, against the twin; learning must not swap the shape.
      formatLearning: false,
      autonomous: true,
      meterFeature: "video_approval_render",
      spokenScript: text,
      complianceWarnings: warnings,
      extraMetadata: {
        approved_script_id: row.id,
        approved_text_hash: textHash,
        approved_by: input.approvedByUserId ?? null,
        render_host: hostChoice.host,
        render_host_reason: hostChoice.reason,
        script_structure: {
          hook: planned.structure.hook, hook_seconds: planned.structure.hookSeconds, hook_within_budget: planned.structure.hookWithinBudget,
          value_beats: planned.structure.valueBeats, cta_present: planned.structure.ctaPresent,
        },
        spoken_seconds_estimate: Number(planned.spokenSeconds.toFixed(1)),
      },
    },
    svc,
  )

  const base = { host: hostChoice.host, hostReason: hostChoice.reason, agentUserId: agent.agentUserId, compositionId: result.compositionId ?? plan.compositionId, warnings }
  if (result.ok && result.videoProjectId) {
    return { ok: true, status: result.status === "already_staged" ? "already_staged" : "staged", reason: result.reason ?? "", videoProjectId: result.videoProjectId, ...base }
  }
  return { ok: false, status: result.status === "blocked" ? "blocked" : "failed", reason: result.reason ?? "the Director refused the commission", ...base }
}
