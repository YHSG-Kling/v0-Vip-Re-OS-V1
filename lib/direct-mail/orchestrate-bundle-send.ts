/**
 * lib/direct-mail/orchestrate-bundle-send.ts
 *
 * Wave 37 item #3 — multi-channel bundle dispatcher. Loads a bundle
 * + its ordered items, fires each item through the appropriate
 * channel orchestrator, stamps a shared bundle_dispatch_id on every
 * resulting campaign row, and writes one campaign_bundle_dispatches
 * audit row with per-channel outcomes.
 *
 * Channels: direct_mail_postcard / direct_mail_letter (orchestratePresetSend), email, sms, voicedrop, portal_push,
 * social_post, podcast_episode, ad_retarget — each through its own preset orchestrator (lazy-imported below, so a caller
 * that only drains follow-ons never loads the mail renderer's graph).
 *
 * Cross-channel attribution: the bundle_dispatch_id stamp on each
 * piece's underlying row gives the analytics view + the
 * marketing-agent snapshot a way to ask "what did THIS bundle drive
 * across channels" rather than tallying per-channel one at a time.
 *
 * ── WAVE 153 (lane 153I — convergence row 71; owner rulings 14 + 17, wave-150 "order only") ─────────────────────────────
 * MEASURED at 34124d98: `for (const item of items)` fired EVERY item in ONE synchronous pass at the moment of the click —
 * while the builder (app/settings/campaign-bundles/client.tsx, wave 150 lane 150Z) tells the author "Items go out in this
 * order; the OS decides when each follow-on is useful", and lib/marketing/creative-playbooks.ts (150SZ) removed the offsets
 * because "WHEN a follow-on goes is the ONE arbiter's decision at dispatch". Three consequences: a contact received the
 * postcard, the email, the text and the voicemail in the same minute; no follow-on was ever persisted, so nothing could
 * resume, retry or stop it; and `channel_outcomes[item.channel]` let the second item on one channel overwrite the first.
 *
 * NOW (no new table, no new cron, no new manager, no central follow-up service):
 *   · The FIRST item goes on the person's click (the agent's explicit send — the same rule as a sequence's first step).
 *   · Each later item is a PERSISTED FOLLOW-ON on the campaign orchestrator's own queue, `orchestrator_tasks`
 *     (TABLE_MANAGER → campaign_orchestrator), task_type BUNDLE_FOLLOW_ON_TASK, written only after its ORIGIN item reached a
 *     terminal state: origin item, bundle, dispatch, tenant, audience (contact / lead ids — never PII), dependency, timing
 *     policy (the arbiter's), the governance planes it will pass, expected evidence and an idempotency key
 *     (`bundle_follow_on:<dispatch>:<item>`, pre-read + m931's partial UNIQUE index → 23505 reads as "already persisted").
 *   · The EXISTING drain — app/api/cron/queue-drain/route.ts drainOrchestratorTasks, every 5 minutes, which used to close
 *     any task type but `publish_scheduled_post` as "no executor registered" — hands each due follow-on to
 *     executeBundleFollowOnTask below, and once per tick to recoverStaleBundleFollowOns.
 *   · The stable ITEM IDENTITY is campaign_bundle_items.id: app/actions/campaign-bundles.ts upsertCampaignBundle now keeps
 *     an item's id while its asset (channel, preset — m160's UNIQUE (bundle_id, channel, preset_id)) is unchanged instead of
 *     deleting and re-inserting every item on each edit.
 *
 * GOVERNANCE — the existing planes, each for what it decides:
 *   · dependency / order: structural — a follow-on exists only once its origin is terminal (depends_on recorded);
 *   · person-facing touches (email / sms / voicedrop / mail / portal): the Contact-engagement arbiter
 *     (arbitratePlannedTouch — send now, a bounded wait, or HALT when no lawful channel is left = a suppressed Contact);
 *   · outbound policy, consent, DNC, quiet hours, de-confliction and spend: lib/providers/dispatch.ts inside each channel
 *     orchestrator (unchanged — a bundle is never a way around them); paid audience work (ad_retarget) stays with the
 *     Ads Manager's launcher and its budget gates; social / podcast items stage for their own approval-gated publishers.
 *   · evidence: the task row (status, attempts, last_error, payload.outcome incl. the arbiter's choice) + the dispatch's
 *     channel_outcomes (now also keyed per item) + every send's own agent_action_ledger row written by dispatch.ts.
 *
 * NEVER TWICE. A follow-on is persisted at most once (idempotency key); a drain CLAIMS it pending → running with a counted
 * compare-and-set (a concurrent or replayed drain matches nothing and skips); a retry happens ONLY after a DEFINITIVE
 * refusal (the orchestrator said nothing was sent), bounded by the de-confliction policy's MAX_DEFERS; a throw mid-send or
 * a claim that went stale is "outcome unknown" → failed, never re-sent automatically (a person decides).
 */
import "server-only"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import type { OrchestratePresetSendArgs } from "./orchestrate-preset-send"

export interface OrchestrateBundleSendArgs {
  brokerageId: string
  bundleId:    string
  /** Recipient — either lead OR contact. */
  leadId?:    string
  contactId?: string
  userId?:    string
  agentId?:   string
  /** Shared recipient details — passed to every channel that needs them. */
  recipientName:  string
  mailingAddress: string
  city:  string
  state: string
  zip:   string
  /** Email + SMS reach details. When omitted, the dispatcher tries
   *  to resolve from the contact_id / lead_id row. */
  recipientFirstName?: string | null
  recipientLastName?:  string | null
  recipientEmail?: string | null
  recipientPhone?: string | null
  qrScanUrl?: string | null
  teamId?:      string | null
  agentUserId?: string | null
  systemSource?: string
}

export interface BundleChannelOutcome {
  channel:    string
  preset_id:  string | null
  success:    boolean
  messageId?: string
  error?:     string
  rendered?:  boolean
}

export interface OrchestrateBundleSendResult {
  ok:                 boolean
  bundleDispatchId?:  string
  bundleName?:        string
  channelOutcomes:    BundleChannelOutcome[]
  error?:             string
  /** WAVE 153 (153I): the next item, persisted as a follow-on the arbiter times — null when the bundle had one item. */
  followOn?: { scheduled: boolean; channel: string | null; remaining: number; reason?: string } | null
}

interface BundleItem {
  id:          string
  channel:     string
  preset_id:   string | null
  order_index: number
}

/** THE task type of a persisted bundle follow-on on orchestrator_tasks (one spelling; the drain route reads it). */
export const BUNDLE_FOLLOW_ON_TASK = "bundle_follow_on"

type Svc = ReturnType<typeof createServiceClient>

// ─── The recipient + sender a single item is dispatched with ─────────────────────────────────────────────────────

interface ItemSender {
  brokerageId: string
  bundleName: string
  bundleDispatchId: string
  leadId?: string
  contactId?: string
  userId?: string
  agentId?: string
  teamId?: string | null
  agentUserId?: string | null
  qrScanUrl?: string | null
  systemSource?: string
}

interface ItemRecipient {
  recipientName: string
  mailingAddress: string
  city: string
  state: string
  zip: string
  recipientFirstName?: string | null
  recipientLastName?: string | null
  recipientEmail?: string | null
  recipientPhone?: string | null
}

/**
 * ONE item through its channel orchestrator. The body is the per-item branch the single pass used to run in its loop,
 * unchanged in behaviour; the orchestrators are lazy-imported so only the channel that sends loads its graph.
 */
async function dispatchBundleItem(svc: Svc, item: Pick<BundleItem, "channel" | "preset_id">, s: ItemSender, r: ItemRecipient): Promise<BundleChannelOutcome> {
  const source = s.systemSource ?? `bundle:${s.bundleName}`
  if ((item.channel === "direct_mail_postcard" || item.channel === "direct_mail_letter") && item.preset_id) {
    const { orchestratePresetSend } = await import("./orchestrate-preset-send")
    const presetArgs: OrchestratePresetSendArgs = {
      brokerageId:    s.brokerageId,
      presetId:       item.preset_id,
      leadId:         s.leadId,
      contactId:      s.contactId,
      userId:         s.userId,
      agentId:        s.agentId,
      recipientName:  r.recipientName,
      mailingAddress: r.mailingAddress,
      city:           r.city,
      state:          r.state,
      zip:            r.zip,
      qrScanUrl:      s.qrScanUrl ?? null,
      teamId:         s.teamId,
      agentUserId:    s.agentUserId,
      systemSource:   source,
    }
    const res = await orchestratePresetSend(presetArgs)
    // Stamp bundle_dispatch_id on the campaign row the preset dispatcher just wrote (direct_mail_campaigns via
    // dispatchDirectMail's vendor log path). count="exact" detects a stamp that matched zero rows — loud, because the
    // bundle-attribution-rollup tick would otherwise silently miss this dispatch.
    if (res.success && res.messageId) {
      const { count: stampedRows, error: stampErr } = await svc
        .from("direct_mail_campaigns")
        .update({ bundle_dispatch_id: s.bundleDispatchId }, { count: "exact" })
        .eq("brokerage_id", s.brokerageId)
        .eq("lob_order_id", res.messageId)
      if (stampErr) {
        console.error("[bundle-send] bundle_dispatch_id stamp failed:", stampErr.message, { bundleDispatchId: s.bundleDispatchId, lob_order_id: res.messageId })
      } else if ((stampedRows ?? 0) === 0) {
        console.warn("[bundle-send] bundle_dispatch_id stamp matched 0 rows — attribution will drop", { bundleDispatchId: s.bundleDispatchId, lob_order_id: res.messageId, brokerage_id: s.brokerageId })
      }
    }
    return { channel: item.channel, preset_id: item.preset_id, success: res.success, messageId: res.messageId, error: res.error, rendered: res.rendered }
  }
  if (item.channel === "email" && item.preset_id) {
    // Email via dispatchEmail (suppression + opt-out + compliance gate per piece).
    let toEmail = r.recipientEmail ?? null
    if (!toEmail && s.contactId) {
      const { data } = await svc.from("contacts").select("email").eq("id", s.contactId).eq("brokerage_id", s.brokerageId).maybeSingle()
      toEmail = (data?.email as string | null) ?? null
    }
    if (!toEmail) return { channel: item.channel, preset_id: item.preset_id, success: false, error: "no_recipient_email" }
    const { orchestrateEmailPresetSend } = await import("@/lib/email/orchestrate-email-preset-send")
    const res = await orchestrateEmailPresetSend({
      brokerageId: s.brokerageId, presetId: item.preset_id, contactId: s.contactId, leadId: s.leadId, toEmail,
      recipientFirstName: r.recipientFirstName, recipientLastName: r.recipientLastName,
      teamId: s.teamId, agentUserId: s.agentUserId, systemSource: source,
    })
    return { channel: item.channel, preset_id: item.preset_id, success: res.success, messageId: res.messageId, error: res.error }
  }
  if (item.channel === "sms" && item.preset_id) {
    // SMS via dispatchSms (TCPA + sms_opt_out enforced).
    let toPhone = r.recipientPhone ?? null
    if (!toPhone && s.contactId) {
      const { data } = await svc.from("contacts").select("phone").eq("id", s.contactId).eq("brokerage_id", s.brokerageId).maybeSingle()
      toPhone = (data?.phone as string | null) ?? null
    }
    if (!toPhone) return { channel: item.channel, preset_id: item.preset_id, success: false, error: "no_recipient_phone" }
    const { orchestrateSmsPresetSend } = await import("@/lib/sms/orchestrate-sms-preset-send")
    const res = await orchestrateSmsPresetSend({
      brokerageId: s.brokerageId, presetId: item.preset_id, contactId: s.contactId, leadId: s.leadId, toPhone,
      recipientFirstName: r.recipientFirstName, teamId: s.teamId, agentUserId: s.agentUserId, systemSource: source,
    })
    return { channel: item.channel, preset_id: item.preset_id, success: res.success, messageId: res.messageId, error: res.error }
  }
  if (item.channel === "portal_push" && item.preset_id && s.contactId) {
    // Portal card insert — no external egress, no TCPA. Requires a contact (leads have no portal accounts).
    const { orchestratePortalPushSend } = await import("@/lib/portal/orchestrate-portal-push-send")
    const res = await orchestratePortalPushSend({ brokerageId: s.brokerageId, presetId: item.preset_id, contactId: s.contactId, teamId: s.teamId, agentUserId: s.agentUserId, systemSource: source })
    return { channel: item.channel, preset_id: item.preset_id, success: res.success, messageId: res.messageId, error: res.error }
  }
  if (item.channel === "voicedrop" && item.preset_id) {
    // Ringless voicemail — TCPA gate applies.
    let toPhone = r.recipientPhone ?? null
    if (!toPhone && s.contactId) {
      const { data } = await svc.from("contacts").select("phone").eq("id", s.contactId).eq("brokerage_id", s.brokerageId).maybeSingle()
      toPhone = (data?.phone as string | null) ?? null
    }
    if (!toPhone) return { channel: item.channel, preset_id: item.preset_id, success: false, error: "no_recipient_phone" }
    const { orchestrateVoicedropSend } = await import("@/lib/voicedrop/orchestrate-voicedrop-send")
    const res = await orchestrateVoicedropSend({
      brokerageId: s.brokerageId, presetId: item.preset_id, contactId: s.contactId, leadId: s.leadId, toPhone,
      recipientFirstName: r.recipientFirstName, teamId: s.teamId, agentUserId: s.agentUserId, systemSource: source,
    })
    return { channel: item.channel, preset_id: item.preset_id, success: res.success, messageId: res.jobId, error: res.error }
  }
  if (item.channel === "social_post" && item.preset_id) {
    // Stages platform-specific social_posts rows for the approval-gated publish-social-posts cron.
    const { orchestrateSocialPresetPublish } = await import("@/lib/social/orchestrate-social-preset-publish")
    const res = await orchestrateSocialPresetPublish({ brokerageId: s.brokerageId, presetId: item.preset_id, teamId: s.teamId, agentUserId: s.agentUserId, systemSource: source })
    return { channel: item.channel, preset_id: item.preset_id, success: res.success, messageId: res.socialPostIds?.[0], error: res.error }
  }
  if (item.channel === "podcast_episode" && item.preset_id) {
    // Stages podcast_distribution_log rows; the podcast publish cron walks them.
    const { orchestratePodcastPresetPublish } = await import("@/lib/podcast/orchestrate-podcast-preset-publish")
    const res = await orchestratePodcastPresetPublish({ brokerageId: s.brokerageId, presetId: item.preset_id, teamId: s.teamId, agentUserId: s.agentUserId, systemSource: source })
    return { channel: item.channel, preset_id: item.preset_id, success: res.success, messageId: res.distributionLogIds?.[0], error: res.error }
  }
  if (item.channel === "ad_retarget" && item.preset_id) {
    // Queues an ad_campaigns row for the ad-launcher (the Ads Manager's budget gates decide the spend).
    const { orchestrateAdRetargetSend } = await import("@/lib/ads/orchestrate-ad-retarget-send")
    const res = await orchestrateAdRetargetSend({ brokerageId: s.brokerageId, presetId: item.preset_id, teamId: s.teamId, agentUserId: s.agentUserId, bundleDispatchId: s.bundleDispatchId, systemSource: source })
    return { channel: item.channel, preset_id: item.preset_id, success: res.success, messageId: res.adCampaignId, error: res.error }
  }
  return { channel: item.channel, preset_id: item.preset_id, success: false, error: "preset_id_required" }
}

// ─── The follow-on contract (pure) ─────────────────────────────────────────────────────────────────────────────

/** A touch that reaches THE PERSON (the Contact-engagement arbiter decides it) → the arbiter's channel spelling. */
const PERSON_FACING_ARBITER_CHANNEL: Readonly<Record<string, string>> = Object.freeze({
  email: "email", sms: "sms", voicedrop: "voice_drop", direct_mail_postcard: "direct_mail", direct_mail_letter: "direct_mail", portal_push: "in_app",
})
/** Broadcast / audience work — never a touch to this person: the governing plane named on the record. */
const AUDIENCE_PLANE: Readonly<Record<string, string>> = Object.freeze({
  social_post: "social approval gate (publish-social-posts)", podcast_episode: "podcast distribution (distribute-podcast-episodes)", ad_retarget: "ads_manager launcher budget gates",
})

/** Codes and phrases that mean a GATE refused (policy / consent / a missing asset) — never retried, the item is cancelled. */
const CANCEL_CODES: ReadonlySet<string> = new Set(["preset_id_required", "preset_not_found", "preset_deactivated", "tenant_mismatch", "no_recipient_email", "no_recipient_phone"])
const POLICY_REFUSAL = /\b(consent|opt(?:ed)?[\s_-]?out|unsubscrib\w*|suppress\w*|dnc|do[\s_-]not[\s_-]contact|quiet[\s_-]hours|compliance|autonomy|not permitted|forbidden|blocked|sender address refused|no deliverable address|fair[\s_-]housing)\b/i

/** cancel = a gate's verdict that will not change on retry; retry = the provider refused, nothing was sent. */
function classifyRefusal(error: string | null | undefined): "cancel" | "retry" {
  const e = (error ?? "").trim()
  if (CANCEL_CODES.has(e)) return "cancel"
  if (POLICY_REFUSAL.test(e)) return "cancel"
  return "retry"
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v)

interface FollowOnPayload {
  idempotency_key: string
  bundle_id: string
  bundle_dispatch_id: string
  bundle_item_id: string
  origin_item_id: string | null
  depends_on: string[]
  item: { channel: string; preset_id: string | null; order_index: number }
  audience: { contact_id: string | null; lead_id: string | null }
  sender: { user_id: string | null; agent_id: string | null; agent_user_id: string | null; team_id: string | null }
  qr_scan_url: string | null
  system_source: string | null
  timing: { policy: "arbiter"; planner: "sequence_step"; person_facing: boolean; arbiter_waits: number }
  governance: { contact_engagement: string | null; outbound: string; audience: string | null }
  expected_evidence: string[]
  deferrals: number
  outcome?: Record<string, unknown>
}

const followOnKey = (dispatchId: string, itemId: string) => `${BUNDLE_FOLLOW_ON_TASK}:${dispatchId}:${itemId}`

interface ChainContext {
  brokerageId: string
  bundleId: string
  bundleDispatchId: string
  audience: FollowOnPayload["audience"]
  sender: FollowOnPayload["sender"]
  qrScanUrl: string | null
  systemSource: string | null
}

function payloadFor(ctx: ChainContext, item: BundleItem, originItemId: string | null): FollowOnPayload {
  const arbiterChannel = PERSON_FACING_ARBITER_CHANNEL[item.channel] ?? null
  return {
    idempotency_key: followOnKey(ctx.bundleDispatchId, item.id),
    bundle_id: ctx.bundleId,
    bundle_dispatch_id: ctx.bundleDispatchId,
    bundle_item_id: item.id,
    origin_item_id: originItemId,
    depends_on: originItemId ? [originItemId] : [],
    item: { channel: item.channel, preset_id: item.preset_id, order_index: item.order_index },
    audience: ctx.audience,
    sender: ctx.sender,
    qr_scan_url: ctx.qrScanUrl,
    system_source: ctx.systemSource,
    timing: { policy: "arbiter", planner: "sequence_step", person_facing: arbiterChannel !== null, arbiter_waits: 0 },
    governance: {
      contact_engagement: arbiterChannel ? `arbitratePlannedTouch(${arbiterChannel})` : null,
      outbound: "lib/providers/dispatch.ts (consent · DNC · quiet hours · de-confliction · spend)",
      audience: AUDIENCE_PLANE[item.channel] ?? null,
    },
    expected_evidence: ["channel_outcome", "provider_message_id", "agent_action_ledger"],
    deferrals: 0,
  }
}

/** The dispatch's per-item evidence: the item's own entry, and the first SUCCESS per channel (the rollup's reader contract). */
async function recordItemOutcome(svc: Svc, brokerageId: string, dispatchId: string, itemId: string, outcome: BundleChannelOutcome & { status: string }): Promise<void> {
  const { data: d, error } = await svc.from("campaign_bundle_dispatches").select("channel_outcomes").eq("id", dispatchId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) { console.error(`[bundle-send] dispatch ${dispatchId} outcomes unreadable — item ${itemId} evidence stays on its task row: ${error.message}`); return }
  const prior = ((d as { channel_outcomes?: Record<string, unknown> } | null)?.channel_outcomes ?? {}) as Record<string, unknown>
  const entry = { success: outcome.success, message_id: outcome.messageId ?? null, error: outcome.error ?? null, rendered: outcome.rendered ?? null, preset_id: outcome.preset_id, status: outcome.status, item_id: itemId }
  const items = { ...((prior.items as Record<string, unknown> | undefined) ?? {}), [itemId]: entry }
  const channelPrior = prior[outcome.channel] as { success?: boolean } | undefined
  const next: Record<string, unknown> = { ...prior, items }
  // Never overwrite a channel's recorded success with a later item's failure (the old single pass did, by key).
  if (!channelPrior || (!channelPrior.success && outcome.success)) next[outcome.channel] = entry
  await sentinelWrite(svc, svc.from("campaign_bundle_dispatches").update({ channel_outcomes: next, updated_at: new Date().toISOString() })
    .eq("id", dispatchId).eq("brokerage_id", brokerageId), { table: "campaign_bundle_dispatches", flow: "campaign_bundle_dispatches_write", reason: "channel-outcome blob for reporting; each channel's own rows and the follow-on task row already hold the evidence" })
}

/**
 * Persist ONE follow-on (idempotent). `status` is "pending" for a follow-on the drain will decide, or the terminal status of
 * the first item (its record is the chain's root evidence). Returns whether a NEW row landed.
 */
async function persistFollowOnRecord(svc: Svc, ctx: ChainContext, item: BundleItem, originItemId: string | null, opts: { status: "pending" | "completed" | "failed" | "cancelled"; outcome?: Record<string, unknown>; lastError?: string | null; now: Date }): Promise<{ persisted: boolean; duplicate: boolean; error?: string }> {
  const payload = payloadFor(ctx, item, originItemId)
  if (opts.outcome) payload.outcome = opts.outcome
  const { data: prior, error: readErr } = await svc.from("orchestrator_tasks").select("id")
    .eq("brokerage_id", ctx.brokerageId).eq("task_type", BUNDLE_FOLLOW_ON_TASK).eq("payload->>idempotency_key", payload.idempotency_key).limit(1).maybeSingle()
  if (readErr) return { persisted: false, duplicate: false, error: `follow-on read refused: ${readErr.message}` }
  if (prior) return { persisted: false, duplicate: true }
  const terminal = opts.status !== "pending"
  const { error } = await svc.from("orchestrator_tasks").insert({
    brokerage_id: ctx.brokerageId, task_type: BUNDLE_FOLLOW_ON_TASK, status: opts.status, payload,
    scheduled_for: opts.now.toISOString(), attempts: terminal ? 1 : 0, last_error: opts.lastError ?? null,
    executed_at: terminal ? opts.now.toISOString() : null, created_at: opts.now.toISOString(), updated_at: opts.now.toISOString(),
  })
  if (error) {
    if ((error as { code?: string }).code === "23505") return { persisted: false, duplicate: true }
    return { persisted: false, duplicate: false, error: `follow-on insert refused: ${error.message}` }
  }
  return { persisted: true, duplicate: false }
}

/** The bundle's items NOW (tenant-pinned), in order. A refused read is reported, never read as "no items". */
async function loadItems(svc: Svc, brokerageId: string, bundleId: string): Promise<{ items: BundleItem[]; error: string | null }> {
  const { data, error } = await svc.from("campaign_bundle_items").select("id, channel, preset_id, order_index")
    .eq("bundle_id", bundleId).eq("brokerage_id", brokerageId).order("order_index", { ascending: true })
  if (error) return { items: [], error: error.message }
  return { items: ((data ?? []) as BundleItem[]).slice().sort((a, b) => a.order_index - b.order_index), error: null }
}

/** After an item is terminal: persist the NEXT item (the first with a later order) as a pending follow-on. */
async function persistNextFollowOn(svc: Svc, ctx: ChainContext, origin: { itemId: string; orderIndex: number }, now: Date): Promise<{ scheduled: boolean; channel: string | null; remaining: number; reason?: string }> {
  const { items, error } = await loadItems(svc, ctx.brokerageId, ctx.bundleId)
  if (error) return { scheduled: false, channel: null, remaining: 0, reason: `the bundle's items could not be read (${error}) — the chain stops here, honestly` }
  const later = items.filter((i) => i.order_index > origin.orderIndex && i.id !== origin.itemId)
  const next = later[0]
  if (!next) return { scheduled: false, channel: null, remaining: 0, reason: "the bundle has no later item" }
  const r = await persistFollowOnRecord(svc, ctx, next, origin.itemId, { status: "pending", now })
  if (r.error) return { scheduled: false, channel: next.channel, remaining: later.length, reason: r.error }
  return { scheduled: true, channel: next.channel, remaining: later.length, reason: r.duplicate ? "already persisted (idempotent)" : undefined }
}

// ─── The click: the first item now, the rest as follow-ons ────────────────────────────────────────────────────────

/**
 * `opts` (wave 153, lane 153I — for lane 153H's OS-arbitration canary C5 and this lane's proof): an injected client and channel
 * seam, so "complete an item → exactly ONE persisted follow-on → drained through arbitratePlannedTouch → a replay persists no
 * second follow-on" can be driven end to end: orchestrateBundleSend(args, { client }) → executeBundleFollowOnTask(client, task)
 * → executeBundleFollowOnTask(client, task) again (skipped — the claim matches nothing). Production passes neither.
 */
export async function orchestrateBundleSend(
  args: OrchestrateBundleSendArgs,
  opts: { client?: Svc; dispatchItem?: FollowOnDeps["dispatchItem"]; now?: () => Date } = {},
): Promise<OrchestrateBundleSendResult> {
  const svc = opts.client ?? createServiceClient()
  const now = (opts.now ?? (() => new Date()))()

  // 1. Load bundle + items (tenant + is_active gate).
  const { data: bundleRow } = await svc
    .from("campaign_bundles")
    .select("id, brokerage_id, name, is_active")
    .eq("id", args.bundleId)
    .maybeSingle()
  const bundle = bundleRow as { id: string; brokerage_id: string; name: string; is_active: boolean } | null
  if (!bundle) return { ok: false, channelOutcomes: [], error: "bundle_not_found" }
  if (bundle.brokerage_id !== args.brokerageId) {
    return { ok: false, channelOutcomes: [], error: "tenant_mismatch" }
  }
  if (!bundle.is_active) {
    return { ok: false, channelOutcomes: [], error: "bundle_deactivated", bundleName: bundle.name }
  }

  const loaded = await loadItems(svc, args.brokerageId, args.bundleId)
  if (loaded.error) return { ok: false, channelOutcomes: [], bundleName: bundle.name, error: "bundle_items_unreadable" }
  const items = loaded.items
  if (items.length === 0) {
    return { ok: false, channelOutcomes: [], bundleName: bundle.name, error: "bundle_has_no_items" }
  }

  // 2. Open the per-(bundle, recipient) dispatch row up front so each channel's downstream campaign row can stamp
  // bundle_dispatch_id immediately.
  const { data: dispatchRow, error: dispatchInsertErr } = await svc
    .from("campaign_bundle_dispatches")
    .insert({
      bundle_id:    args.bundleId,
      brokerage_id: args.brokerageId,
      contact_id:   args.contactId ?? null,
      lead_id:      args.leadId ?? null,
      dispatched_at: now.toISOString(),
    })
    .select("id")
    .single()
  if (dispatchInsertErr || !dispatchRow) {
    return { ok: false, channelOutcomes: [], bundleName: bundle.name, error: dispatchInsertErr?.message ?? "dispatch_row_insert_failed" }
  }
  const bundleDispatchId = dispatchRow.id as string

  // 3. The FIRST item goes on the click (the person's explicit send).
  const first = items[0]
  const sender: ItemSender = {
    brokerageId: args.brokerageId, bundleName: bundle.name, bundleDispatchId,
    leadId: args.leadId, contactId: args.contactId, userId: args.userId, agentId: args.agentId,
    teamId: args.teamId, agentUserId: args.agentUserId, qrScanUrl: args.qrScanUrl ?? null, systemSource: args.systemSource,
  }
  let outcome: BundleChannelOutcome
  try {
    outcome = await (opts.dispatchItem ?? dispatchBundleItem)(svc, first, sender, args)
  } catch (err) {
    outcome = { channel: first.channel, preset_id: first.preset_id, success: false, error: `outcome unknown — the send threw (${(err as Error)?.message ?? String(err)}); never re-sent automatically` }
  }
  const firstStatus: "completed" | "failed" | "cancelled" = outcome.success ? "completed" : classifyRefusal(outcome.error) === "cancel" ? "cancelled" : "failed"

  // 4. Persist the chain: the first item's record (root evidence) and the next item as a pending follow-on.
  const ctx: ChainContext = {
    brokerageId: args.brokerageId, bundleId: args.bundleId, bundleDispatchId,
    audience: { contact_id: args.contactId ?? null, lead_id: args.leadId ?? null },
    sender: { user_id: args.userId ?? null, agent_id: args.agentId ?? null, agent_user_id: args.agentUserId ?? null, team_id: args.teamId ?? null },
    qrScanUrl: args.qrScanUrl ?? null, systemSource: args.systemSource ?? null,
  }
  const root = await persistFollowOnRecord(svc, ctx, first, null, {
    status: firstStatus, now, lastError: outcome.success ? null : outcome.error ?? null,
    outcome: { status: firstStatus, message_id: outcome.messageId ?? null, error: outcome.error ?? null, decided_at: now.toISOString(), decided_by: "the sender's click" },
  })
  if (root.error) console.error(`[bundle-send] first item record not persisted for dispatch ${bundleDispatchId}: ${root.error}`)
  await recordItemOutcome(svc, args.brokerageId, bundleDispatchId, first.id, { ...outcome, status: firstStatus })

  const followOn = items.length > 1
    ? await persistNextFollowOn(svc, ctx, { itemId: first.id, orderIndex: first.order_index }, now)
    : null

  return {
    ok:               outcome.success || followOn?.scheduled === true,
    bundleDispatchId,
    bundleName:       bundle.name,
    channelOutcomes:  [outcome],
    followOn,
  }
}

// ─── The drain: one persisted follow-on at a time ─────────────────────────────────────────────────────────────────

/** What a drain pass did with one follow-on. */
type FollowOnVerdict = "sent" | "waiting" | "retry" | "cancelled" | "failed" | "skipped"

interface ArbiterAnswer {
  decision: { kind: string; waitHours: number | null; rationale: string }
  choice?: string
  halt?: { reason: string } | null
}

/** Seams the proof injects; production lazy-imports the real survivors. */
interface FollowOnDeps {
  now?: () => Date
  /** The Contact-engagement arbiter (default: lib/ai-isa/followup-arbiter.ts arbitratePlannedTouch). */
  arbitrate?: (svc: Svc, input: Record<string, unknown>) => Promise<ArbiterAnswer>
  /** The channel orchestrators (default: dispatchBundleItem above). */
  dispatchItem?: (svc: Svc, item: Pick<BundleItem, "channel" | "preset_id">, s: ItemSender, r: ItemRecipient) => Promise<BundleChannelOutcome>
}

interface ClaimedTask { id: string; brokerage_id: string; payload: FollowOnPayload; attempts: number | null }

/**
 * THE DRAIN of ONE due follow-on — called by app/api/cron/queue-drain/route.ts for every pending task of
 * BUNDLE_FOLLOW_ON_TASK. Claim → re-validate (dispatch, bundle, item, audience) → the arbiter for a person-facing touch →
 * re-resolve the recipient from the live row (no PII is stored on the task) → send through the channel orchestrator →
 * settle (counted) → record the outcome → persist the next item. Never throws.
 */
export async function executeBundleFollowOnTask(svc: Svc, task: { id: string }, deps: FollowOnDeps = {}): Promise<{ verdict: FollowOnVerdict; reason: string; next?: { scheduled: boolean; channel: string | null; reason?: string } }> {
  const now = (deps.now ?? (() => new Date()))()
  try {
    // 1. CLAIM — pending → running, counted. A concurrent or replayed drain matches nothing.
    const { data: claimedRows, error: claimErr } = await svc.from("orchestrator_tasks")
      .update({ status: "running", updated_at: now.toISOString() })
      .eq("id", task.id).eq("task_type", BUNDLE_FOLLOW_ON_TASK).eq("status", "pending")
      .select("id, brokerage_id, payload, attempts")
    if (claimErr) return { verdict: "skipped", reason: `claim refused: ${claimErr.message}` }
    if (!Array.isArray(claimedRows) || claimedRows.length !== 1) return { verdict: "skipped", reason: "already claimed or no longer pending (another drain took it)" }
    const t = claimedRows[0] as ClaimedTask
    const B = t.brokerage_id
    const p = t.payload

    const settle = async (status: "completed" | "failed" | "cancelled" | "pending", patch: { lastError?: string | null; scheduledFor?: string; payload?: FollowOnPayload; countAttempt?: boolean }): Promise<boolean> => {
      const terminal = status !== "pending"
      const { data: moved, error } = await svc.from("orchestrator_tasks").update({
        status,
        last_error: patch.lastError ? patch.lastError.slice(0, 500) : null,
        ...(patch.scheduledFor ? { scheduled_for: patch.scheduledFor } : {}),
        ...(patch.payload ? { payload: patch.payload } : {}),
        ...(patch.countAttempt ? { attempts: (t.attempts ?? 0) + 1 } : {}),
        ...(terminal ? { executed_at: now.toISOString() } : {}),
        updated_at: now.toISOString(),
      }).eq("id", t.id).eq("brokerage_id", B).eq("status", "running").select("id")
      if (error) { console.error(`[bundle-follow-on] task ${t.id} → ${status} REFUSED: ${error.message}`); return false }
      if (!Array.isArray(moved) || moved.length !== 1) { console.error(`[bundle-follow-on] task ${t.id} → ${status} matched no row (moved under us)`); return false }
      return true
    }
    const withOutcome = (o: Record<string, unknown>): FollowOnPayload => ({ ...p, outcome: { ...(p.outcome ?? {}), ...o, decided_at: now.toISOString() } })

    // 2. The record itself must be readable — an unreadable payload is failed, never guessed at.
    if (!p || !isId(p.bundle_id) || !isId(p.bundle_dispatch_id) || !isId(p.bundle_item_id) || !p.item?.channel) {
      await settle("failed", { lastError: "the follow-on record is unreadable (payload) — nothing was sent", countAttempt: true })
      return { verdict: "failed", reason: "unreadable payload" }
    }
    const ctx: ChainContext = {
      brokerageId: B, bundleId: p.bundle_id, bundleDispatchId: p.bundle_dispatch_id, audience: p.audience ?? { contact_id: null, lead_id: null },
      sender: p.sender ?? { user_id: null, agent_id: null, agent_user_id: null, team_id: null }, qrScanUrl: p.qr_scan_url ?? null, systemSource: p.system_source ?? null,
    }
    const origin = { itemId: p.bundle_item_id, orderIndex: p.item.order_index }
    const hold = async (why: string) => {
      // A read that could not run: fail CLOSED for this tick (no send), re-asked later, bounded by the deferral policy.
      const { decideDeferral } = await import("@/lib/campaign-sequences/deferral-policy")
      const d = decideDeferral(p.deferrals ?? 0, now.getTime())
      if (d.action === "reschedule" && d.nextStepAt) {
        await settle("pending", { lastError: why, scheduledFor: d.nextStepAt, payload: { ...p, deferrals: d.attempt } })
        return { verdict: "retry" as const, reason: why }
      }
      await settle("failed", { lastError: `${why} — gave up after ${d.attempt - 1} re-checks; nothing was sent`, countAttempt: true, payload: withOutcome({ status: "failed", error: why }) })
      const next = await persistNextFollowOn(svc, ctx, origin, now)
      return { verdict: "failed" as const, reason: why, next }
    }
    const stopChain = async (why: string) => {
      await settle("cancelled", { lastError: why, payload: withOutcome({ status: "cancelled", error: why, chain: "stopped" }) })
      await recordItemOutcome(svc, B, p.bundle_dispatch_id, p.bundle_item_id, { channel: p.item.channel, preset_id: p.item.preset_id, success: false, error: why, status: "cancelled" })
      return { verdict: "cancelled" as const, reason: why, next: { scheduled: false, channel: null, reason: "the chain stopped" } }
    }
    const skipItem = async (why: string) => {
      await settle("cancelled", { lastError: why, payload: withOutcome({ status: "cancelled", error: why, chain: "continues" }) })
      await recordItemOutcome(svc, B, p.bundle_dispatch_id, p.bundle_item_id, { channel: p.item.channel, preset_id: p.item.preset_id, success: false, error: why, status: "cancelled" })
      const next = await persistNextFollowOn(svc, ctx, origin, now)
      return { verdict: "cancelled" as const, reason: why, next }
    }

    // 3. RE-VALIDATE against the live rows (tenant-pinned).
    const { data: dispatch, error: dErr } = await svc.from("campaign_bundle_dispatches").select("id, bundle_id, contact_id, lead_id")
      .eq("id", p.bundle_dispatch_id).eq("brokerage_id", B).maybeSingle()
    if (dErr) return await hold(`the dispatch could not be read (${dErr.message})`)
    if (!dispatch) return await stopChain("the bundle dispatch no longer exists in this tenant")
    const { data: bundle, error: bErr } = await svc.from("campaign_bundles").select("id, name, is_active").eq("id", p.bundle_id).eq("brokerage_id", B).maybeSingle()
    if (bErr) return await hold(`the bundle could not be read (${bErr.message})`)
    if (!bundle) return await stopChain("the bundle no longer exists")
    if (!(bundle as { is_active: boolean }).is_active) return await stopChain("the bundle was deactivated after this send — no further items go out")
    const bundleName = (bundle as { name: string }).name
    const { data: liveItem, error: iErr } = await svc.from("campaign_bundle_items").select("id, channel, preset_id, order_index")
      .eq("id", p.bundle_item_id).eq("bundle_id", p.bundle_id).eq("brokerage_id", B).maybeSingle()
    if (iErr) return await hold(`the bundle item could not be read (${iErr.message})`)
    if (!liveItem) return await skipItem("this step was removed from the bundle (or its piece was replaced) after the send began")
    const li = liveItem as BundleItem
    if (li.channel !== p.item.channel || (li.preset_id ?? null) !== (p.item.preset_id ?? null)) return await skipItem("this step's piece changed after the send began — the changed piece is not sent to a person it was never planned for")

    // 4. THE AUDIENCE — still this tenant's, still reachable as planned.
    const contactId = isId(p.audience?.contact_id) ? p.audience.contact_id : null
    const leadId = isId(p.audience?.lead_id) ? p.audience.lead_id : null
    let recipient: ItemRecipient = { recipientName: "Neighbor", mailingAddress: "", city: "", state: "", zip: "" }
    let subject: { type: "contact" | "lead"; id: string } | null = null
    if (contactId) {
      const { data: c, error: cErr } = await svc.from("contacts").select("id, first_name, last_name, email, phone, deleted_at").eq("id", contactId).eq("brokerage_id", B).maybeSingle()
      if (cErr) return await hold(`the contact could not be read (${cErr.message})`)
      const row = c as { first_name: string | null; last_name: string | null; email: string | null; phone: string | null; deleted_at: string | null } | null
      if (!row || row.deleted_at) return await stopChain("the contact is no longer in this tenant's audience (removed or merged)")
      recipient = {
        ...recipient, recipientName: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Neighbor",
        recipientFirstName: row.first_name, recipientLastName: row.last_name, recipientEmail: row.email, recipientPhone: row.phone,
      }
      subject = { type: "contact", id: contactId }
    } else if (leadId) {
      const { data: l, error: lErr } = await svc.from("leads").select("id, first_name, last_name, email, phone, converted_at, mailing_address, mailing_city, mailing_state, mailing_zip").eq("id", leadId).eq("brokerage_id", B).maybeSingle()
      if (lErr) return await hold(`the lead could not be read (${lErr.message})`)
      const row = l as { first_name: string | null; last_name: string | null; email: string | null; phone: string | null; converted_at: string | null; mailing_address: string | null; mailing_city: string | null; mailing_state: string | null; mailing_zip: string | null } | null
      if (!row) return await stopChain("the lead is no longer in this tenant")
      // Conversion finality (the step executor's rule): a converted lead's bundle stops — the contact's own consent governs.
      if (row.converted_at) return await stopChain("the lead became a contact — their own preferences and consent govern from here")
      const { channelRefusalForRecipient } = await import("@/lib/ai-isa/lead-channel-policy")
      const refusal = channelRefusalForRecipient({ contactId: null, leadId }, PERSON_FACING_ARBITER_CHANNEL[p.item.channel] ?? p.item.channel)
      if (refusal && PERSON_FACING_ARBITER_CHANNEL[p.item.channel]) return await skipItem(`a lead is reached by email or mail only (${refusal})`)
      recipient = {
        recipientName: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Neighbor", recipientFirstName: row.first_name, recipientLastName: row.last_name,
        recipientEmail: row.email, recipientPhone: row.phone,
        mailingAddress: row.mailing_address ?? "", city: row.mailing_city ?? "", state: row.mailing_state ?? "", zip: row.mailing_zip ?? "",
      }
      subject = { type: "lead", id: leadId }
    } else {
      return await stopChain("the dispatch names no recipient")
    }

    // 5. THE CONTACT-ENGAGEMENT ARBITER — person-facing touches only. Send now, a bounded wait, or a HALT (no lawful channel).
    const arbiterChannel = PERSON_FACING_ARBITER_CHANNEL[p.item.channel] ?? null
    let decisionNote: Record<string, unknown> | null = null
    if (arbiterChannel && subject) {
      const arbitrate = deps.arbitrate ?? (async (s: Svc, input: Record<string, unknown>) => (await import("@/lib/ai-isa/followup-arbiter")).arbitratePlannedTouch(s as never, input as never) as unknown as ArbiterAnswer)
      let arb: ArbiterAnswer
      try {
        arb = await arbitrate(svc, {
          brokerageId: B, planner: "sequence_step", subject, now,
          options: [{ id: "send_now", kind: "communication", channels: [], why: [`item ${p.item.order_index + 1} of the tenant's bundle "${bundleName}" (${p.item.channel}) follows the previous item, which has finished — the author set the ORDER, the timing is yours`] }],
          planned: "send_now",
          moment: { key: "bundle_follow_on_due", intent: `The next piece of a campaign bundle (${p.item.channel}) is ready for this person — decide whether now is right, or hold it a bounded time.` },
          relationship: { type: subject.type, persona: null, hasAssignedAgent: !!ctx.sender.agent_id },
          requiredChannels: [arbiterChannel],
          blindSpots: ["the bundle's audience and order were set by the sender; the dispatch chokepoint still decides frequency, consent and quiet hours"],
        })
      } catch (err) {
        return await hold(`the arbiter could not be asked (${(err as Error)?.message ?? String(err)})`)
      }
      decisionNote = { choice: arb.choice ?? arb.decision.kind, kind: arb.decision.kind, rationale: String(arb.decision.rationale ?? "").slice(0, 300) }
      if (arb.halt) return await skipItem(`no lawful ${arbiterChannel.replace("_", " ")} channel is left for this person (opted out, no consent or no address) — this piece is not sent`)
      if (arb.decision.kind === "wait" && typeof arb.decision.waitHours === "number" && arb.decision.waitHours > 0) {
        const retryAt = new Date(now.getTime() + arb.decision.waitHours * 3_600_000).toISOString()
        const ok = await settle("pending", { scheduledFor: retryAt, lastError: null, payload: { ...p, timing: { ...p.timing, arbiter_waits: (p.timing?.arbiter_waits ?? 0) + 1 }, outcome: { ...(p.outcome ?? {}), last_decision: decisionNote, held_until: retryAt } } })
        return { verdict: ok ? "waiting" : "skipped", reason: `the arbiter held this piece until ${retryAt}: ${decisionNote.rationale}` }
      }
    }

    // 6. Mail needs the live address (resolved now — never stored on the task).
    if (contactId && (p.item.channel === "direct_mail_postcard" || p.item.channel === "direct_mail_letter")) {
      const { resolveMailingAddressForContact } = await import("@/lib/contacts/resolve-mailing-address")
      const addr = await resolveMailingAddressForContact({ contactId, brokerageId: B })
      recipient = { ...recipient, mailingAddress: addr?.street ?? "", city: addr?.city ?? "", state: addr?.state ?? "", zip: addr?.zip ?? "" }
    }

    // 7. SEND through the channel orchestrator (every dispatch.ts gate still applies).
    const sender: ItemSender = {
      brokerageId: B, bundleName, bundleDispatchId: p.bundle_dispatch_id,
      contactId: contactId ?? undefined, leadId: (isId((dispatch as { lead_id?: string | null }).lead_id) ? (dispatch as { lead_id: string }).lead_id : leadId) ?? undefined,
      userId: ctx.sender.user_id ?? undefined, agentId: ctx.sender.agent_id ?? undefined, agentUserId: ctx.sender.agent_user_id, teamId: ctx.sender.team_id,
      qrScanUrl: ctx.qrScanUrl, systemSource: ctx.systemSource ?? undefined,
    }
    const send = deps.dispatchItem ?? dispatchBundleItem
    let outcome: BundleChannelOutcome
    try {
      outcome = await send(svc, { channel: li.channel, preset_id: li.preset_id }, sender, recipient)
    } catch (err) {
      const why = `outcome unknown — the send threw (${(err as Error)?.message ?? String(err)}); never re-sent automatically`
      await settle("failed", { lastError: why, countAttempt: true, payload: withOutcome({ status: "failed", error: why, decision: decisionNote }) })
      await recordItemOutcome(svc, B, p.bundle_dispatch_id, p.bundle_item_id, { channel: li.channel, preset_id: li.preset_id, success: false, error: why, status: "failed" })
      const next = await persistNextFollowOn(svc, ctx, origin, now)
      return { verdict: "failed", reason: why, next }
    }

    // 8. SETTLE on the orchestrator's truth.
    if (outcome.success) {
      await settle("completed", { countAttempt: true, payload: withOutcome({ status: "completed", message_id: outcome.messageId ?? null, decision: decisionNote }) })
      await recordItemOutcome(svc, B, p.bundle_dispatch_id, p.bundle_item_id, { ...outcome, status: "completed" })
      const next = await persistNextFollowOn(svc, ctx, origin, now)
      return { verdict: "sent", reason: `sent (${outcome.messageId ?? "no provider reference"})`, next }
    }
    if (classifyRefusal(outcome.error) === "cancel") {
      return await skipItem(`a gate refused this piece and it is not retried: ${outcome.error ?? "refused"}`)
    }
    // The provider refused and nothing was sent: retry the SAME piece later, bounded by the de-confliction policy.
    const { decideDeferral } = await import("@/lib/campaign-sequences/deferral-policy")
    const d = decideDeferral(p.deferrals ?? 0, now.getTime())
    if (d.action === "reschedule" && d.nextStepAt) {
      await settle("pending", { scheduledFor: d.nextStepAt, lastError: outcome.error ?? "refused", countAttempt: true, payload: { ...p, deferrals: d.attempt, outcome: { ...(p.outcome ?? {}), last_refusal: outcome.error ?? null, last_decision: decisionNote } } })
      return { verdict: "retry", reason: `the provider refused (${outcome.error ?? "no reason"}) — the same piece is retried at ${d.nextStepAt}, never twice` }
    }
    const why = `the provider refused ${d.attempt - 1} times (${outcome.error ?? "no reason"}) — not retried again`
    await settle("failed", { lastError: why, countAttempt: true, payload: withOutcome({ status: "failed", error: outcome.error ?? null, decision: decisionNote }) })
    await recordItemOutcome(svc, B, p.bundle_dispatch_id, p.bundle_item_id, { ...outcome, status: "failed" })
    const next = await persistNextFollowOn(svc, ctx, origin, now)
    return { verdict: "failed", reason: why, next }
  } catch (err) {
    return { verdict: "skipped", reason: `threw before a send: ${(err as Error)?.message ?? String(err)}` }
  }
}

/**
 * A follow-on CLAIMED but never settled (the drain died mid-send) is "outcome unknown": it is closed FAILED with that
 * reason — never re-sent automatically, because it may have gone — and the chain continues to the next item (which the
 * arbiter decides on its own). Threshold: completion-tracking's STALE_IN_FLIGHT_MINUTES (one meaning of "no longer in
 * flight"). Called once per queue-drain tick. Never throws.
 */
export async function recoverStaleBundleFollowOns(svc: Svc, deps: Pick<FollowOnDeps, "now"> = {}): Promise<{ recovered: number; errors: string[] }> {
  const now = (deps.now ?? (() => new Date()))()
  const out = { recovered: 0, errors: [] as string[] }
  try {
    const { STALE_IN_FLIGHT_MINUTES } = await import("@/lib/kernel/completion-tracking")
    const cutoff = new Date(now.getTime() - STALE_IN_FLIGHT_MINUTES * 60_000).toISOString()
    const { data, error } = await svc.from("orchestrator_tasks").select("id, brokerage_id, payload")
      .eq("task_type", BUNDLE_FOLLOW_ON_TASK).eq("status", "running").lt("updated_at", cutoff).limit(50)
    if (error) { out.errors.push(`stale follow-ons unreadable: ${error.message}`); return out }
    for (const row of (data ?? []) as Array<{ id: string; brokerage_id: string; payload: FollowOnPayload }>) {
      const why = "outcome unknown — the drain stopped mid-send; this piece is never re-sent automatically (a person can resend it)"
      const { data: moved, error: mErr } = await svc.from("orchestrator_tasks").update({
        status: "failed", last_error: why, executed_at: now.toISOString(), updated_at: now.toISOString(),
        payload: { ...row.payload, outcome: { ...(row.payload?.outcome ?? {}), status: "failed", error: why, decided_at: now.toISOString() } },
      }).eq("id", row.id).eq("brokerage_id", row.brokerage_id).eq("status", "running").lt("updated_at", cutoff).select("id")
      if (mErr) { out.errors.push(`${row.id}: ${mErr.message}`); continue }
      if (!Array.isArray(moved) || moved.length !== 1) continue
      out.recovered++
      const p = row.payload
      if (p && isId(p.bundle_id) && isId(p.bundle_dispatch_id) && isId(p.bundle_item_id) && p.item) {
        const ctx: ChainContext = { brokerageId: row.brokerage_id, bundleId: p.bundle_id, bundleDispatchId: p.bundle_dispatch_id, audience: p.audience, sender: p.sender, qrScanUrl: p.qr_scan_url ?? null, systemSource: p.system_source ?? null }
        await recordItemOutcome(svc, row.brokerage_id, p.bundle_dispatch_id, p.bundle_item_id, { channel: p.item.channel, preset_id: p.item.preset_id, success: false, error: why, status: "failed" })
        await persistNextFollowOn(svc, ctx, { itemId: p.bundle_item_id, orderIndex: p.item.order_index }, now)
      }
    }
  } catch (err) {
    out.errors.push(`threw: ${(err as Error)?.message ?? String(err)}`)
  }
  return out
}
