/**
 * lib/video/video-event-reactions.ts — THE orchestrator's video event reactions,
 * callable with no session (lane 86F3, wave 86).
 *
 * THE DEFECT. lib/orchestrator/internal.ts EVENT_HANDLERS routed video.generated
 * (recorded), video.script_approved, video.published and video.high_engagement
 * (DISPATCHED) to app/actions/video-content.ts — "use server" exports (public
 * endpoints taking video_id / script_id / user_id from the browser) whose first
 * line built the COOKIE client. The orchestrator dispatches from cron
 * (poll-did-videos, render-composition) and from logEventAndTrigger's webhook
 * callers with no cookie: every notification, task, publish stamp and approval
 * write read or wrote nothing under RLS and the handler returned success. None of
 * their updates carried a tenant predicate (an id from the payload was the whole
 * WHERE clause). The last OPEN "orchestrator event-bus lane" group in
 * scripts/sessionless-use-server-census.ts.
 *
 * THE SHAPE (template lib/transactions/dotloop-document-sync.ts): server-only,
 * client-injected, the tenant is the EVENT ROW's brokerage_id. The video project /
 * script the payload names must be in it; the recipient (payload.user_id, else the
 * row's user_id) is PROVEN a users row of it through the ONE notifications tenant
 * resolver (lib/notifications/recipient-tenant.ts); the task assignee is the
 * agents row of that user IN the tenant (users.id and agents.id are disjoint, §3 —
 * resolved, never substituted). Every write is counted and returned.
 *
 * WHAT A REACTION MAY NOT DO (86B's rails, not bypassed):
 *   · No video is CREATED here. Creation — the tier-metered gate
 *     (lib/video/video-metering.ts gateVideoCreation / meterVideoCreation) and the
 *     fair-housing render hold — lives in lib/kernel/content-creators.ts
 *     createVideoProject, and a render is submitted by lib/kernel/video.ts
 *     submitVideoGenerationJob (hold + slot claim + provider job). A reaction that
 *     flipped ai_video_projects.status to "generating" (as approveAndGenerateVideo
 *     did) without a provider job WEDGED the project: the poller chases
 *     provider_job_id, so a job-less "generating" row never completes.
 *   · No script is APPROVED here. video_scripts_library.approval_status has ONE
 *     gated writer (app/actions/video-generation.ts updateScriptApprovalStatus —
 *     the isAdminOrBroker gate — beside applyMarketingAssetApproval; see
 *     manager-registry video_script_approval_single_writer). The event REPORTS an
 *     approval; re-writing it here with the payload's user as approver was a third,
 *     ungated writer.
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed.
 */
import "server-only"
import { resolveRecipientBrokerageId } from "@/lib/notifications/recipient-tenant"

export interface VideoEventOutcome { success: boolean; written: string[]; skipped: string[]; error?: string }

const outcome = (): VideoEventOutcome => ({ success: true, written: [], skipped: [] })
const fail = (error: string): VideoEventOutcome => ({ success: false, written: [], skipped: [], error })

async function projectInTenant(
  svc: any,
  brokerageId: string,
  videoId: string | null | undefined,
): Promise<{ ok: true; row: { id: string; status: string | null } } | { ok: false; error: string }> {
  if (!videoId) return { ok: false, error: "No video_id on the video event" }
  const { data, error } = await svc
    .from("ai_video_projects").select("id, status").eq("id", videoId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `Video project read refused: ${error.message}` }
  if (!data) return { ok: false, error: `Video project ${videoId} is not in brokerage ${brokerageId}` }
  return { ok: true, row: data }
}

interface NotificationFields {
  type: string
  title: string
  body: string
  entity_type: string
  entity_id: string
  priority?: "low" | "medium" | "high"
}

/** One notifications row — only when the recipient's users.brokerage_id IS the tenant. */
async function notifyInTenant(
  svc: any,
  brokerageId: string,
  userId: string | null | undefined,
  row: NotificationFields,
  out: VideoEventOutcome,
): Promise<void> {
  if (!userId) { out.skipped.push("notification: no recipient on the event"); return }
  const tenant = await resolveRecipientBrokerageId(svc, userId)
  if (!tenant.ok) { out.skipped.push(`notification: ${tenant.reason}`); return }
  if (tenant.brokerageId !== brokerageId) { out.skipped.push(`notification: recipient ${userId} is not in brokerage ${brokerageId}`); return }
  // The row is written as an EXPLICIT literal — never `{ ...row, … }` — so the tenant stamp
  // is provable at the write (scripts/ai-insight-tenant-guard.ts cannot see through a spread).
  const { data, error } = await svc.from("notifications").insert({
    user_id: userId,
    brokerage_id: brokerageId,
    type: row.type,
    title: row.title,
    body: row.body,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    priority: row.priority ?? "medium",
  }).select("id").maybeSingle()
  if (error || !data) out.skipped.push(`notification refused: ${error?.message ?? "no row returned"}`)
  else out.written.push("notification")
}

const recipientOf = (payload: Record<string, any>, actorUserId: string | null | undefined) =>
  (payload?.user_id ?? payload?.agent_user_id ?? actorUserId ?? null) as string | null

/** video.generated — recorded in EVENT_HANDLERS (the hub's local handleVideoGenerated is in force). */
export async function reactToVideoReady(
  svc: any,
  brokerageId: string,
  payload: Record<string, any>,
  actorUserId: string | null | undefined,
): Promise<VideoEventOutcome> {
  if (!brokerageId) return fail("No brokerageId — video events are never acted on untenanted")
  const project = await projectInTenant(svc, brokerageId, payload?.video_id)
  if (!project.ok) return fail(project.error)
  const out = outcome()
  await notifyInTenant(svc, brokerageId, recipientOf(payload, actorUserId), {
    type: "video_ready",
    title: "Video Ready for Review",
    body: `Your ${payload?.video_type ?? ""} video is ready. Review and publish when ready.`.replace("  ", " "),
    entity_type: "video",
    entity_id: project.row.id,
  }, out)
  return out
}

/**
 * video.script_approved — DISPATCHED. The approval already happened (by the one
 * gated writer); this reaction VERIFIES it on the row and tells the agent the
 * project is ready to render from the studio. It neither re-approves nor fakes a
 * "generating" status (see the header).
 */
export async function reactToVideoScriptApproved(
  svc: any,
  brokerageId: string,
  payload: Record<string, any>,
  actorUserId: string | null | undefined,
): Promise<VideoEventOutcome> {
  if (!brokerageId) return fail("No brokerageId — video events are never acted on untenanted")
  const scriptId = payload?.script_id
  if (!scriptId) return fail("No script_id on the video.script_approved payload")
  const { data: script, error: sErr } = await svc
    .from("video_scripts_library").select("id, approval_status").eq("id", scriptId).eq("brokerage_id", brokerageId).maybeSingle()
  if (sErr) return fail(`Video script read refused: ${sErr.message}`)
  if (!script) return fail(`Video script ${scriptId} is not in brokerage ${brokerageId}`)
  if (script.approval_status !== "approved") {
    return fail(`video.script_approved names script ${scriptId}, whose approval_status is "${script.approval_status}" — the event claims an approval the row does not carry`)
  }
  const out = outcome()
  let entityId: string = script.id
  if (payload?.video_id) {
    const project = await projectInTenant(svc, brokerageId, payload.video_id)
    if (!project.ok) return fail(project.error)
    entityId = project.row.id
  }
  await notifyInTenant(svc, brokerageId, recipientOf(payload, actorUserId), {
    type: "video_script_approved",
    title: "Video Script Approved",
    body: "Your video script was approved. Open the video studio to render it.",
    entity_type: "video",
    entity_id: entityId,
  }, out)
  return out
}

/** video.published — DISPATCHED. Stamps the project published (tenant-pinned, counted) and tells the agent. */
export async function reactToVideoPublished(
  svc: any,
  brokerageId: string,
  payload: Record<string, any>,
  actorUserId: string | null | undefined,
): Promise<VideoEventOutcome> {
  if (!brokerageId) return fail("No brokerageId — video events are never acted on untenanted")
  const project = await projectInTenant(svc, brokerageId, payload?.video_id)
  if (!project.ok) return fail(project.error)
  const { data: stamped, error: upErr } = await svc
    .from("ai_video_projects")
    .update({ status: "published", is_published: true, published_at: new Date().toISOString() })
    .eq("id", project.row.id)
    .eq("brokerage_id", brokerageId)
    .select("id")
  if (upErr) return fail(`Video publish stamp refused: ${upErr.message}`)
  if (!stamped?.length) return fail(`Video publish stamp matched no row in brokerage ${brokerageId}`)
  const out = outcome()
  out.written.push("publish_stamp")
  const platforms = Array.isArray(payload?.platforms) ? (payload.platforms as string[]) : []
  await notifyInTenant(svc, brokerageId, recipientOf(payload, actorUserId), {
    type: "video_published",
    title: "Video Published!",
    body: `Your video has been published to ${platforms.join(", ") || "your channels"}.`,
    entity_type: "video",
    entity_id: project.row.id,
  }, out)
  return out
}

/** video.high_engagement — DISPATCHED. The bell, plus a reply task when comments pile up. */
export async function reactToVideoHighEngagement(
  svc: any,
  brokerageId: string,
  payload: Record<string, any>,
  actorUserId: string | null | undefined,
): Promise<VideoEventOutcome> {
  if (!brokerageId) return fail("No brokerageId — video events are never acted on untenanted")
  const project = await projectInTenant(svc, brokerageId, payload?.video_id)
  if (!project.ok) return fail(project.error)
  const out = outcome()
  const userId = recipientOf(payload, actorUserId)
  const count = Number(payload?.engagement_count) || 0
  const kind = String(payload?.engagement_type ?? "engagements")
  await notifyInTenant(svc, brokerageId, userId, {
    type: "video_engagement",
    title: "Video Performing Well!",
    body: `Your video has ${count} ${kind}. Great job!`,
    entity_type: "video",
    entity_id: project.row.id,
  }, out)

  if (kind === "comments" && count > 5) {
    // tasks.brokerage_id + assigned_to_agent_id are NOT NULL (pass 5). The assignee
    // is the recipient's agents row IN this tenant — resolved, never substituted.
    if (!userId) {
      out.skipped.push("task: no recipient on the event")
    } else {
      const { data: agents, error: aErr } = await svc
        .from("agents").select("id").eq("user_id", userId).eq("brokerage_id", brokerageId).limit(1)
      const agentId = ((agents ?? [])[0]?.id as string | undefined) ?? null
      if (aErr) out.skipped.push(`task: agent lookup refused: ${aErr.message}`)
      else if (!agentId) out.skipped.push(`task: user ${userId} holds no agents row in this brokerage`)
      else {
        const { data: task, error: tErr } = await svc.from("tasks").insert({
          brokerage_id: brokerageId,
          assigned_to_agent_id: agentId,
          title: "Respond to video comments",
          description: `Your video has ${count} comments. Engage with your audience!`,
          due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          priority: "medium",
        }).select("id").maybeSingle()
        if (tErr || !task) out.skipped.push(`task refused: ${tErr?.message ?? "no row returned"}`)
        else out.written.push("task")
      }
    }
  }
  return out
}
