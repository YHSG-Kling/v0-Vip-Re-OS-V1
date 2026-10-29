// lib/video/video-staging.ts
// ─────────────────────────────────────────────────────────────────────────────
// NON-LISTING VIDEOS ARE STAGED (wave 146, lane 146F — owner ruling 4, contract C5).
//
// OWNER (2026-10-29): "Automatic non listing videos need to be staged." Generated → playable → rights/branding checked →
// intended audience/channel chosen → approver assigned → approved → published per policy. No unapproved automatic YouTube /
// social / CTV publishing; the YouTube queue holds only approved public non-personal video. Ruling 9: the TENANT approves its
// own assets — the approver comes from the real authority hierarchy (contract C5, lib/kernel/approval-authority.ts approverFor),
// the brokerage only where policy or law imposes it.
//
// WHAT WAS THERE (audited at bf67aa63):
//   · the autonomous producers (lib/video/topic-video-runner.ts, the Director rail, the explainer, the education module) stage
//     `pending_review` rows — the HUMAN gate existed — but NO stage between "rendered" and "approved" was recorded: nobody
//     checked rights or branding before the approval, no audience / channel was chosen, and no approver was ASSIGNED — the
//     approval doors (lib/kernel/approval-queue-aggregator.ts applyMarketingAssetApproval, app/actions/marketing-ai-approvals.ts)
//     never even record WHO approved (approved_by stays null);
//   · the two AUTOMATIC public doors acted on approval_status alone: lib/video/youtube-publish.ts queueYouTubeAutoPublish (the
//     YouTube rail) and lib/geo/publish-video-landing.ts publishVideoProjectLanding (the /v/[slug] page, every 30 min) — and the
//     latter never asked lib/video/public-video.ts classifyPublicVideo at all, so an approved PERSONAL video (an agent intro or
//     a home-anniversary clip filed for ONE contact with usage_intent 'public_marketing', a client explainer) became a public
//     page. Live census 2026-10-29: 0 ai_video_projects rows — the path is exposed, nothing leaked yet.
//
// THE STAGES (VIDEO_STAGES), recorded on the asset (ai_video_projects.video_metadata.staging — no new table, no new status
// column: the video's own approval_status stays THE approval state, the staging record is its evidence):
//   generated               the row exists (a producer made it)
//   playable                finished + a hosted file (playable output is the completion rule — lib/video/playable-output.ts)
//   rights_branding_checked rights: a testimonial needs a VERIFIED consent on record; a licensed music bed its licence; a D-ID
//                           likeness is enforced at render submit (lib/did/avatar-consent-gate.ts). branding: the survivor
//                           lib/kernel/brand-compliance.ts checkBrandCompliance('video') — the verbal disclosure + the visual
//                           brand overlay advertising law requires on public marketing
//   audience_channel_chosen classifyPublicVideo's audience (public marketing, addressed to nobody) and the channels the tenant's
//                           policy permits (video_auto_publish → youtube; the /v landing page)
//   approver_assigned       C5 approverFor({ brokerageId, assetKind: 'non_listing_video', scope: { teamId, agentId } }) — the
//                           assigned person(s) are told at once
//   approved                approval_status approved BY an assigned approver (approved_by recorded — approveStagedVideo)
//   published               the rail published it (status published / the landing page / the YouTube write-back)
// stagedPublicationVerdict(row, channel) is THE check every automatic public door calls; a listing video keeps its own rail
// (listing marketing has the Coming Soon / MLS rules — lib/marketing/listing-public-address.ts) and is judged by
// classifyPublicVideo alone, unchanged.
//
// Not server-only: the proof drives it in memory with seams; the brand survivor, the C5 resolver, the bell and the approval
// cascade are lazy imports at their call.

import { classifyPublicVideo, PUBLIC_MARKETING_VIDEO_TYPES, readVideoAutoPublishPolicy } from "./public-video"
import { VIDEO_FINISHED_STATUSES } from "./video-status"

type Db = { from: (table: string) => any }

/** Listing marketing kinds — staged by their own listing rails, not here. Every value is in PUBLIC_MARKETING_VIDEO_TYPES. */
export const LISTING_VIDEO_TYPES = ["coming_soon", "just_listed", "just_sold", "listing_promo", "open_house_promo"] as const
const LISTING = new Set<string>(LISTING_VIDEO_TYPES)

/** The broadcast kinds that are NOT listing marketing — the kinds ruling 4 stages. Derived, never restated. */
export const NON_LISTING_PUBLIC_VIDEO_TYPES = PUBLIC_MARKETING_VIDEO_TYPES.filter((t) => !LISTING.has(t))
const NON_LISTING = new Set<string>(NON_LISTING_PUBLIC_VIDEO_TYPES)

export const VIDEO_STAGES = ["generated", "playable", "rights_branding_checked", "audience_channel_chosen", "approver_assigned", "approved", "published"] as const
export type VideoStage = (typeof VIDEO_STAGES)[number]

/** The automatic public doors a staged video may be chosen for. */
export const STAGED_VIDEO_CHANNELS = ["youtube", "landing_page"] as const
export type StagedVideoChannel = (typeof STAGED_VIDEO_CHANNELS)[number]

/** C5 assetKind for this asset class (lib/kernel/approval-authority.ts APPROVAL_ASSET_KINDS 'video'). */
export const VIDEO_STAGING_ASSET_KIND = "video" as const

/** notifications.type of the bell the assigned approver gets. */
const VIDEO_STAGED_NOTIFICATION_TYPE = "video_staged_for_approval"

export interface VideoStagingRecord {
  version: 1
  staged_at: string
  playable: { ok: boolean; basis: string }
  rights: { ok: boolean; checks: Array<{ key: string; ok: boolean; detail: string }> }
  branding: { ok: boolean; violations: string[]; basis: string }
  audience: "public_marketing" | "personal"
  channels: StagedVideoChannel[]
  /** user_ids = whose approval counts; primary_user_ids = who was asked (C5's primary / permitted split). */
  approver: { user_ids: string[]; primary_user_ids?: string[]; basis: string; assigned_at: string } | null
  blockers: string[]
}

export interface StageableVideoRow {
  id: string
  brokerage_id?: string | null
  agent_id?: string | null
  video_type?: string | null
  audience_type?: string | null
  usage_intent?: string | null
  contact_id?: string | null
  learning_module_id?: string | null
  approval_status?: string | null
  approved_by?: string | null
  status?: string | null
  compliance_status?: string | null
  video_url?: string | null
  video_provider?: string | null
  is_published?: boolean | null
  video_metadata?: Record<string, unknown> | null
}

/** PURE. Is this a kind ruling 4 stages? */
function isNonListingPublicKind(videoType: string | null | undefined): boolean {
  return NON_LISTING.has(String(videoType ?? ""))
}

/** The staging record on the row, when one was written in this shape. */
function stagingOf(row: Pick<StageableVideoRow, "video_metadata">): VideoStagingRecord | null {
  const s = (row.video_metadata as { staging?: unknown } | null | undefined)?.staging
  return s && typeof s === "object" && (s as { version?: unknown }).version === 1 ? (s as VideoStagingRecord) : null
}

const isPlayable = (r: StageableVideoRow) => (VIDEO_FINISHED_STATUSES as readonly string[]).includes(String(r.status ?? "")) && !!r.video_url && /^https?:\/\/\S+$/.test(String(r.video_url))

/**
 * PURE. The furthest stage this video has reached and what blocks the next one. Stages are cumulative: a video is
 * `approved` only if it also passed every earlier stage.
 */
function videoStageOf(row: StageableVideoRow): { stage: VideoStage; blockers: string[] } {
  const s = stagingOf(row)
  if (!isPlayable(row)) return { stage: "generated", blockers: ["not playable yet (no finished, hosted file)"] }
  if (!s) return { stage: "playable", blockers: ["not staged — rights and branding not checked"] }
  if (!s.rights.ok || !s.branding.ok) return { stage: "playable", blockers: s.blockers.length ? s.blockers : ["rights or branding check failed"] }
  if (s.audience !== "public_marketing" || s.channels.length === 0) return { stage: "rights_branding_checked", blockers: [s.audience === "personal" ? "a personal video is never broadcast — it stays with its own delivery rail" : "no channel is permitted by the tenant's policy"] }
  if (!s.approver || s.approver.user_ids.length === 0) return { stage: "audience_channel_chosen", blockers: ["no approver assigned by the authority hierarchy"] }
  const approved = row.approval_status === "approved" || row.approval_status === "published"
  if (!approved) return { stage: "approver_assigned", blockers: ["awaiting the assigned approver"] }
  if (!row.approved_by) return { stage: "approver_assigned", blockers: ["approved without a recorded approver — approve it on the Video Staging screen"] }
  if (!s.approver.user_ids.includes(row.approved_by)) return { stage: "approver_assigned", blockers: ["approved by someone the authority hierarchy did not assign"] }
  const yt = (row.video_metadata as { youtube?: { video_id?: unknown } } | null | undefined)?.youtube
  if (row.status === "published" || row.is_published === true || (yt && typeof yt === "object" && !!yt.video_id)) return { stage: "published", blockers: [] }
  return { stage: "approved", blockers: [] }
}

/**
 * PURE. THE check every AUTOMATIC public door calls before it publishes (the YouTube rail, the /v landing page). A personal /
 * client / in-house / MLS / unapproved video never passes (classifyPublicVideo); a NON-LISTING kind passes only when it was
 * staged, its rights + branding passed, the door is one of its chosen channels, and an ASSIGNED approver approved it. A listing
 * kind keeps its own rail and is judged by classifyPublicVideo alone.
 */
export function stagedPublicationVerdict(row: StageableVideoRow, channel: StagedVideoChannel): { ok: true; staged: boolean } | { ok: false; reason: string } {
  const pub = classifyPublicVideo(row)
  if (!pub.public) return { ok: false, reason: `not a public marketing video: ${pub.reason}` }
  if (!isNonListingPublicKind(row.video_type)) return { ok: true, staged: false }
  const s = stagingOf(row)
  if (!s) return { ok: false, reason: "a non-listing video publishes only after staging (rights, branding, audience, channel, approver) — not staged" }
  if (!s.channels.includes(channel)) return { ok: false, reason: `staging did not choose the ${channel} channel (chosen: ${s.channels.join(", ") || "none"})` }
  const stage = videoStageOf(row)
  if (stage.stage !== "approved" && stage.stage !== "published") return { ok: false, reason: `staged to "${stage.stage}" — ${stage.blockers.join("; ")}` }
  return { ok: true, staged: true }
}

// ── C5 — the approver from the authority hierarchy ───────────────────────────

export interface ApproverRequest { brokerageId: string; assetKind: typeof VIDEO_STAGING_ASSET_KIND; scope: { teamId?: string; agentId?: string } }
/** userIds = everyone whose approval COUNTS (the owner + the oversight chain, or the brokerage roster when policy/law requires
 *  it); primaryUserIds = who is ASKED first (the bell). */
export interface ApproverAnswer { ok: boolean; userIds: string[]; primaryUserIds?: string[]; basis: string; reason?: string }
export type ApproverResolver = (req: ApproverRequest, svc: Db) => Promise<ApproverAnswer>

/**
 * THE C5 RESOLVER — lane 146E's lib/kernel/approval-authority.ts approverFor({ brokerageId, assetKind, scope: { teamId, agentId } })
 * on the existing seat roster / team lead / tenant publication policy: the tenant's own asset is approved by its owner (the
 * agent), with their team lead and the brokerage roster as oversight; the brokerage is the REQUIRED approver only where the
 * tenant's policy or a recorded legal requirement says so (ruling 9). Read in the video's tenant on the caller's client. Its
 * refusal (or a throw) assigns NOBODY — fail closed: no approver, no automatic publication. Only the contract's NAME and INPUT
 * are relied on; the answer is read defensively.
 */
const defaultApproverFor: ApproverResolver = async (req, svc) => {
  const { approverFor } = await import("@/lib/kernel/approval-authority")
  const d = (await approverFor({ brokerageId: req.brokerageId, assetKind: req.assetKind, scope: req.scope, client: svc })) as unknown as {
    ok: boolean; permittedUserIds?: string[]; primaryUserIds?: string[]; basis?: string; reason?: string
  }
  const permitted = Array.isArray(d.permittedUserIds) ? d.permittedUserIds.filter((x) => typeof x === "string" && x) : []
  if (!d.ok || permitted.length === 0) return { ok: false, userIds: [], basis: `approverFor:${d.basis ?? "refused"}`, reason: d.reason ?? "the authority hierarchy named nobody" }
  const primary = (Array.isArray(d.primaryUserIds) ? d.primaryUserIds : []).filter((x) => permitted.includes(x))
  return { ok: true, userIds: permitted, primaryUserIds: primary.length ? primary : permitted, basis: `approverFor:${d.basis ?? "c5"}` }
}

// ── STAGE ────────────────────────────────────────────────────────────────────

export interface StageVideoDeps {
  now?: Date
  approverFor?: ApproverResolver
  /** The brand survivor (lib/kernel/brand-compliance.ts checkBrandCompliance) — seam for the proof. */
  brand?: (a: { brokerageId: string; videoId: string }) => Promise<{ passed: boolean; violations: string[] }>
  /** The approver's bell — seam; default a notifications row per assigned approver. */
  notify?: (a: { brokerageId: string; userIds: string[]; videoId: string; title: string }, svc: Db) => Promise<{ sent: number; errors: string[] }>
}

export type StageVideoResult =
  /** blockers = what the checks FOUND (rights, branding, no approver …); waitingOn = what the next stage waits for (the approver). */
  | { ok: true; staged: true; stage: VideoStage; blockers: string[]; waitingOn: string[]; channels: StagedVideoChannel[]; approverUserIds: string[]; notified: number }
  | { ok: true; staged: false; reason: string }
  | { ok: false; error: string }

const STAGE_COLUMNS = "id, brokerage_id, agent_id, title, video_type, audience_type, usage_intent, contact_id, learning_module_id, approval_status, approved_by, status, compliance_status, video_url, video_provider, is_published, video_metadata"

/**
 * Stage ONE video: run the checks, choose the audience + channels, assign the approver(s), record it on the asset (a counted,
 * tenant-pinned write) and tell the approver(s). Idempotent (re-staging rewrites the same record from the row's current
 * facts; an approved video's approval is never touched). Never throws.
 */
export async function stageVideoForPublication(svc: Db, input: { brokerageId: string; videoId: string }, deps: StageVideoDeps = {}): Promise<StageVideoResult> {
  try {
    const now = deps.now ?? new Date()
    const { data, error } = await svc.from("ai_video_projects").select(STAGE_COLUMNS).eq("id", input.videoId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (error) return { ok: false, error: `ai_video_projects read refused: ${error.message ?? "unknown"}` }
    const row = data as (StageableVideoRow & { title?: string | null }) | null
    if (!row) return { ok: false, error: "video not found in this brokerage" }
    if (LISTING.has(String(row.video_type ?? ""))) return { ok: true, staged: false, reason: "a listing video — staged by its listing rail" }

    // AUDIENCE — classifyPublicVideo's verdict on everything but the approval it is waiting for.
    const audienceVerdict = classifyPublicVideo({ ...row, approval_status: "approved", status: isPlayable(row) ? (row.status ?? "completed") : "completed", compliance_status: row.compliance_status, video_url: row.video_url ?? "https://pending" })
    const personal = !audienceVerdict.public && ["personal_or_client_kind", "addressed_to_a_contact", "education_module_video", "in_house_audience", "mls_only_cut"].includes(audienceVerdict.reason)
    // A personal / client / in-house / training / MLS video is never broadcast and is not staged for publication — it stays
    // with its own delivery rail (client-video-delivery, the portal welcome video, the education OS). Nothing is written.
    if (personal) return { ok: true, staged: false, reason: `not a broadcast video (${(audienceVerdict as { reason: string }).reason}) — it keeps its own delivery rail` }
    const blockers: string[] = []
    if (!audienceVerdict.public && !personal) blockers.push(`public check: ${audienceVerdict.reason}`)

    // PLAYABLE
    const playable = isPlayable(row)
    if (!playable) blockers.push("not playable yet (no finished, hosted file)")

    // RIGHTS
    const meta = (row.video_metadata ?? {}) as Record<string, any>
    const checks: VideoStagingRecord["rights"]["checks"] = []
    if (row.video_type === "testimonial") {
      const consent = meta.testimonial_consent as { verified?: boolean; recorded_at?: string } | undefined
      checks.push({ key: "testimonial_consent", ok: consent?.verified === true, detail: consent?.verified === true ? `verified ${consent.recorded_at ?? ""}`.trim() : "a testimonial needs the client's verified consent on record before it is public" })
    }
    if (row.video_provider === "did") checks.push({ key: "likeness_consent", ok: true, detail: "enforced at render submit — a video-sourced avatar is refused without a verified on-camera consent (lib/did/avatar-consent-gate.ts)" })
    const musicId = typeof meta.music_asset_id === "string" ? meta.music_asset_id : null
    if (musicId) {
      const m = await svc.from("video_assets").select("id, license_url, license_attribution").eq("id", musicId).maybeSingle()
      if (m.error) checks.push({ key: "music_licence", ok: false, detail: `music asset unreadable: ${m.error.message ?? "unknown"}` })
      else {
        const lic = m.data as { license_url?: string | null; license_attribution?: string | null } | null
        checks.push({ key: "music_licence", ok: !!(lic?.license_url || lic?.license_attribution), detail: lic?.license_url || lic?.license_attribution ? "licence recorded on the music asset" : "the music bed carries no licence record" })
      }
    }
    const rightsOk = checks.every((c) => c.ok)
    for (const c of checks) if (!c.ok) blockers.push(`rights: ${c.detail}`)

    // BRANDING — the survivor's video check (advertising law: verbal disclosure + visual overlay on public marketing).
    let branding: VideoStagingRecord["branding"] = { ok: true, violations: [], basis: "not public marketing — no broadcast branding required" }
    if (!personal) {
      const brand = deps.brand ?? (async (a) => {
        const { checkBrandCompliance } = await import("@/lib/kernel/brand-compliance")
        return checkBrandCompliance({ contentType: "video", contentId: a.videoId, brokerageId: a.brokerageId })
      })
      const b = await brand({ brokerageId: input.brokerageId, videoId: row.id }).catch((e: unknown) => ({ passed: false, violations: [`brand check could not run: ${e instanceof Error ? e.message : String(e)}`] }))
      branding = { ok: b.passed, violations: b.violations, basis: "lib/kernel/brand-compliance.ts checkBrandCompliance('video')" }
      for (const v of b.violations) blockers.push(`branding: ${v}`)
    }

    // CHANNELS — the tenant's policy; a personal video gets none.
    const channels: StagedVideoChannel[] = []
    if (!personal) {
      const policy = await readVideoAutoPublishPolicy(svc, input.brokerageId)
      if (!policy.readable) blockers.push(`tenant policy unreadable — no channel chosen: ${policy.reason}`)
      else {
        channels.push("landing_page")
        if (policy.youtube) channels.push("youtube")
      }
    }

    // APPROVER — C5 (team/agent scope from the video's own agent row, in this tenant).
    let approver: VideoStagingRecord["approver"] = null
    if (!personal) {
      // The video is its agent's OWN asset (ai_video_projects carries no team column — C5 derives the owner's team itself);
      // with no agent it is a brokerage asset.
      const answer = await (deps.approverFor ?? defaultApproverFor)({ brokerageId: input.brokerageId, assetKind: VIDEO_STAGING_ASSET_KIND, scope: row.agent_id ? { agentId: row.agent_id } : {} }, svc)
        .catch((e: unknown): ApproverAnswer => ({ ok: false, userIds: [], basis: "approverFor", reason: e instanceof Error ? e.message : String(e) }))
      if (answer.ok && answer.userIds.length) {
        const permitted = [...new Set(answer.userIds)]
        const primary = (answer.primaryUserIds ?? []).filter((u: string) => permitted.includes(u))
        approver = { user_ids: permitted, primary_user_ids: primary.length ? primary : permitted, basis: answer.basis, assigned_at: now.toISOString() }
      }
      else blockers.push(`no approver assigned: ${answer.reason ?? "the authority hierarchy named nobody"}`)
    }

    const record: VideoStagingRecord = {
      version: 1, staged_at: now.toISOString(), playable: { ok: playable, basis: playable ? "finished status + hosted file (the playable-output completion rule)" : "not finished or not hosted" },
      rights: { ok: rightsOk, checks }, branding, audience: personal ? "personal" : "public_marketing", channels, approver, blockers,
    }
    const patch: Record<string, unknown> = { video_metadata: { ...meta, staging: record }, updated_at: now.toISOString() }
    // A rendered draft enters the ONE approval queue (pending_review) — never approved here.
    if (!personal && playable && (row.approval_status === "draft" || !row.approval_status)) patch.approval_status = "pending_review"
    const w = await svc.from("ai_video_projects").update(patch).eq("id", row.id).eq("brokerage_id", input.brokerageId).select("id")
    if (w.error) return { ok: false, error: `the staging record was refused: ${w.error.message ?? "unknown"}` }
    if (!Array.isArray(w.data) || w.data.length !== 1) return { ok: false, error: "the staging record matched no row" }

    // TELL THE ASSIGNED APPROVER(S) at once — only when there is something for them to approve.
    let notified = 0
    if (approver && playable && record.blockers.length === 0 && row.approval_status !== "approved" && row.approval_status !== "published") {
      const notify = deps.notify ?? defaultNotify
      const n = await notify({ brokerageId: input.brokerageId, userIds: approver.primary_user_ids ?? approver.user_ids, videoId: row.id, title: row.title ?? `${String(row.video_type ?? "video").replace(/_/g, " ")} video` }, svc)
      notified = n.sent
      for (const e of n.errors) console.error(`[video-staging] approver bell refused for video ${row.id}: ${e}`)
    }
    const after = videoStageOf({ ...row, approval_status: (patch.approval_status as string | undefined) ?? row.approval_status, video_metadata: patch.video_metadata as Record<string, unknown> })
    return { ok: true, staged: true, stage: after.stage, blockers: record.blockers, waitingOn: after.blockers, channels, approverUserIds: approver?.user_ids ?? [], notified }
  } catch (e) {
    return { ok: false, error: `stageVideoForPublication threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function defaultNotify(a: { brokerageId: string; userIds: string[]; videoId: string; title: string }, svc: Db): Promise<{ sent: number; errors: string[] }> {
  const out = { sent: 0, errors: [] as string[] }
  for (const userId of a.userIds) {
    const { data: existing, error: readErr } = await svc.from("notifications").select("id").eq("user_id", userId).eq("brokerage_id", a.brokerageId).eq("type", VIDEO_STAGED_NOTIFICATION_TYPE).eq("entity_id", a.videoId).limit(1)
    if (readErr) { out.errors.push(readErr.message ?? "notifications read refused"); continue }
    if ((existing ?? []).length > 0) continue
    const { error } = await svc.from("notifications").insert({
      user_id: userId, brokerage_id: a.brokerageId, type: VIDEO_STAGED_NOTIFICATION_TYPE,
      title: "A video is staged for your approval",
      body: `"${a.title}" passed its rights and branding checks and is waiting for your approval before it can be published.`,
      entity_type: "video", entity_id: a.videoId, is_read: false, priority: "high", channel: "in_app", created_at: new Date().toISOString(),
    })
    if (error) out.errors.push(error.message ?? "notification insert refused")
    else out.sent++
  }
  return out
}

// ── APPROVE ──────────────────────────────────────────────────────────────────

export interface ApproveStagedVideoDeps {
  now?: Date
  /** The ONE approval cascade (lib/kernel/approval-queue-aggregator.ts applyMarketingAssetApproval('video')) — seam. */
  release?: (videoId: string) => Promise<{ ok: true } | { ok: false; error: string }>
  /** C5 again AT APPROVAL — a membership revoked since staging (a team lead who left) no longer counts. */
  approverFor?: ApproverResolver
}

/**
 * The ASSIGNED approver approves a staged video: their user id must be one staging assigned, the video must have passed
 * rights + branding and be playable. Records approved_by / approved_at (a counted, state-fenced write), then runs the ONE
 * approval cascade (the YouTube queue and every other approval consequence). The caller is a session door that verified the
 * tenant and passes the SESSION user. Never throws.
 */
export async function approveStagedVideo(svc: Db, input: { brokerageId: string; videoId: string; approverUserId: string }, deps: ApproveStagedVideoDeps = {}): Promise<{ ok: true; stage: VideoStage } | { ok: false; error: string }> {
  try {
    const now = deps.now ?? new Date()
    const { data, error } = await svc.from("ai_video_projects").select(STAGE_COLUMNS).eq("id", input.videoId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (error) return { ok: false, error: `ai_video_projects read refused: ${error.message ?? "unknown"}` }
    const row = data as StageableVideoRow | null
    if (!row) return { ok: false, error: "video not found in this brokerage" }
    const s = stagingOf(row)
    if (!s) return { ok: false, error: "not staged — stage it first (rights, branding, audience, channel, approver)" }
    const stage = videoStageOf(row)
    if (stage.stage !== "approver_assigned") return { ok: false, error: stage.stage === "approved" || stage.stage === "published" ? "already approved" : `cannot approve at "${stage.stage}": ${stage.blockers.join("; ")}` }
    if (!s.approver || !s.approver.user_ids.includes(input.approverUserId)) return { ok: false, error: "you are not an approver the authority hierarchy assigned to this video" }
    // Re-asked NOW (C5): the assignment was a snapshot; authority is read at the moment of the approval.
    const fresh = await (deps.approverFor ?? defaultApproverFor)({ brokerageId: input.brokerageId, assetKind: VIDEO_STAGING_ASSET_KIND, scope: row.agent_id ? { agentId: row.agent_id } : {} }, svc)
      .catch((e: unknown) => ({ ok: false, userIds: [] as string[], basis: "approverFor", reason: e instanceof Error ? e.message : String(e) }))
    if (!fresh.ok || !fresh.userIds.includes(input.approverUserId)) return { ok: false, error: `you are no longer an approver of this video: ${fresh.reason ?? "the authority hierarchy changed since it was staged"}` }
    const w = await svc.from("ai_video_projects")
      .update({ approval_status: "approved", approved_by: input.approverUserId, approved_at: now.toISOString(), updated_at: now.toISOString() })
      .eq("id", row.id).eq("brokerage_id", input.brokerageId).in("approval_status", ["pending_review", "draft", "approved"]).select("id")
    if (w.error) return { ok: false, error: `approval refused: ${w.error.message ?? "unknown"}` }
    if (!Array.isArray(w.data) || w.data.length !== 1) return { ok: false, error: "the approval matched no row (the video changed state)" }
    const release = deps.release ?? (async (id: string) => {
      const { applyMarketingAssetApproval } = await import("@/lib/kernel/approval-queue-aggregator")
      return applyMarketingAssetApproval("video", id)
    })
    const r = await release(row.id).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
    if (!r.ok) return { ok: false, error: `approved, but the approval cascade refused: ${r.error}` }
    return { ok: true, stage: "approved" }
  } catch (e) {
    return { ok: false, error: `approveStagedVideo threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** The staging board: this tenant's non-listing videos that are staged or awaiting staging, newest first. */
export async function listStagedVideos(svc: Db, input: { brokerageId: string; limit?: number }): Promise<{ videos: Array<{ id: string; title: string | null; videoType: string | null; stage: VideoStage; blockers: string[]; channels: string[]; approverUserIds: string[]; approvalStatus: string | null }>; error: string | null }> {
  const { data, error } = await svc.from("ai_video_projects").select(`${STAGE_COLUMNS}, created_at`)
    .eq("brokerage_id", input.brokerageId).in("video_type", [...NON_LISTING_PUBLIC_VIDEO_TYPES]).is("contact_id", null)
    .order("created_at", { ascending: false }).limit(Math.max(1, Math.min(input.limit ?? 50, 200)))
  if (error) return { videos: [], error: `ai_video_projects read refused: ${error.message ?? "unknown"}` }
  return {
    videos: ((data ?? []) as Array<StageableVideoRow & { title?: string | null }>).map((r) => {
      const st = videoStageOf(r)
      const s = stagingOf(r)
      return { id: r.id, title: r.title ?? null, videoType: r.video_type ?? null, stage: st.stage, blockers: st.blockers, channels: s?.channels ?? [], approverUserIds: s?.approver?.user_ids ?? [], approvalStatus: r.approval_status ?? null }
    }),
    error: null,
  }
}
