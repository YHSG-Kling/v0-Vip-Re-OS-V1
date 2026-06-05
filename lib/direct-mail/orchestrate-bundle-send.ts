/**
 * lib/direct-mail/orchestrate-bundle-send.ts
 *
 * Wave 37 item #3 — multi-channel bundle dispatcher. Loads a bundle
 * + its ordered items, fires each item through the appropriate
 * channel orchestrator, stamps a shared bundle_dispatch_id on every
 * resulting campaign row, and writes one campaign_bundle_dispatches
 * audit row with per-channel outcomes.
 *
 * v1 channels:
 *   · direct_mail_postcard / direct_mail_letter → orchestratePresetSend
 *
 * Future channels (each lands as a separate dispatcher behind the
 * same switch):
 *   · email → orchestrate-email-preset-send (writes
 *     email_campaigns row + dispatches via SendGrid/Resend)
 *   · social_post → social-post-preset-publish
 *   · sms → orchestrate-sms-preset-send
 *
 * Cross-channel attribution: the bundle_dispatch_id stamp on each
 * piece's underlying row gives the analytics view + the
 * marketing-agent snapshot a way to ask "what did THIS bundle drive
 * across channels" rather than tallying per-channel one at a time.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { orchestratePresetSend, type OrchestratePresetSendArgs } from "./orchestrate-preset-send"
import { orchestrateEmailPresetSend } from "@/lib/email/orchestrate-email-preset-send"
import { orchestrateSmsPresetSend } from "@/lib/sms/orchestrate-sms-preset-send"
import { orchestrateSocialPresetPublish } from "@/lib/social/orchestrate-social-preset-publish"
import { orchestratePortalPushSend } from "@/lib/portal/orchestrate-portal-push-send"
import { orchestrateVoicedropSend } from "@/lib/voicedrop/orchestrate-voicedrop-send"

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
}

interface BundleItem {
  channel:    string
  preset_id:  string | null
  order_index: number
  send_after_minutes: number
}

export async function orchestrateBundleSend(
  args: OrchestrateBundleSendArgs,
): Promise<OrchestrateBundleSendResult> {
  const svc = createServiceClient()

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

  const { data: itemRows } = await svc
    .from("campaign_bundle_items")
    .select("channel, preset_id, order_index, send_after_minutes")
    .eq("bundle_id", args.bundleId)
    .order("order_index", { ascending: true })
  const items = (itemRows ?? []) as BundleItem[]
  if (items.length === 0) {
    return { ok: false, channelOutcomes: [], bundleName: bundle.name, error: "bundle_has_no_items" }
  }

  // 2. Open the per-(bundle, recipient) dispatch row up front so each
  // channel's downstream campaign row can stamp bundle_dispatch_id
  // immediately.
  const { data: dispatchRow, error: dispatchInsertErr } = await svc
    .from("campaign_bundle_dispatches")
    .insert({
      bundle_id:    args.bundleId,
      brokerage_id: args.brokerageId,
      contact_id:   args.contactId ?? null,
      lead_id:      args.leadId ?? null,
      dispatched_at: new Date().toISOString(),
    })
    .select("id")
    .single()
  if (dispatchInsertErr || !dispatchRow) {
    return { ok: false, channelOutcomes: [], bundleName: bundle.name, error: dispatchInsertErr?.message ?? "dispatch_row_insert_failed" }
  }
  const bundleDispatchId = dispatchRow.id as string

  // 3. Fan out per item. v1 only routes direct_mail_* through the
  // existing preset orchestrator; other channels record a non-
  // success outcome until their dispatchers land.
  const outcomes: BundleChannelOutcome[] = []
  const channelOutcomesJsonb: Record<string, unknown> = {}

  for (const item of items) {
    let outcome: BundleChannelOutcome
    if ((item.channel === "direct_mail_postcard" || item.channel === "direct_mail_letter") && item.preset_id) {
      const presetArgs: OrchestratePresetSendArgs = {
        brokerageId:    args.brokerageId,
        presetId:       item.preset_id,
        leadId:         args.leadId,
        contactId:      args.contactId,
        userId:         args.userId,
        agentId:        args.agentId,
        recipientName:  args.recipientName,
        mailingAddress: args.mailingAddress,
        city:           args.city,
        state:          args.state,
        zip:            args.zip,
        qrScanUrl:      args.qrScanUrl ?? null,
        teamId:         args.teamId,
        agentUserId:    args.agentUserId,
        systemSource:   args.systemSource ?? `bundle:${bundle.name}`,
      }
      const r = await orchestratePresetSend(presetArgs)
      outcome = {
        channel:    item.channel,
        preset_id:  item.preset_id,
        success:    r.success,
        messageId:  r.messageId,
        error:      r.error,
        rendered:   r.rendered,
      }

      // Stamp bundle_dispatch_id on the campaign row the preset
      // dispatcher just wrote. The preset orchestrator inserts the
      // direct_mail_campaigns row via dispatchDirectMail's vendor
      // log path; we patch the FK in here.
      if (r.success && r.messageId) {
        await svc
          .from("direct_mail_campaigns")
          .update({ bundle_dispatch_id: bundleDispatchId })
          .eq("brokerage_id", args.brokerageId)
          .eq("lob_order_id", r.messageId)
      }
    } else if (item.channel === "email" && item.preset_id) {
      // Wave 37 — email channel via dispatchEmail (compliance gate
      // still applies per piece for suppression + opt-out + repr).
      // Resolve to-email from args or fall back to the contact row.
      let toEmail = args.recipientEmail ?? null
      if (!toEmail && args.contactId) {
        const { data } = await svc.from("contacts").select("email").eq("id", args.contactId).maybeSingle()
        toEmail = (data?.email as string | null) ?? null
      }
      if (!toEmail) {
        outcome = { channel: item.channel, preset_id: item.preset_id, success: false, error: "no_recipient_email" }
      } else {
        const r = await orchestrateEmailPresetSend({
          brokerageId: args.brokerageId,
          presetId:    item.preset_id,
          contactId:   args.contactId,
          leadId:      args.leadId,
          toEmail,
          recipientFirstName: args.recipientFirstName,
          recipientLastName:  args.recipientLastName,
          teamId:      args.teamId,
          agentUserId: args.agentUserId,
          systemSource: args.systemSource ?? `bundle:${bundle.name}`,
        })
        outcome = {
          channel:   item.channel,
          preset_id: item.preset_id,
          success:   r.success,
          messageId: r.messageId,
          error:     r.error,
        }
      }
    } else if (item.channel === "sms" && item.preset_id) {
      // Wave 37 — SMS via dispatchSms (TCPA + sms_opt_out enforced).
      let toPhone = args.recipientPhone ?? null
      if (!toPhone && args.contactId) {
        const { data } = await svc.from("contacts").select("phone").eq("id", args.contactId).maybeSingle()
        toPhone = (data?.phone as string | null) ?? null
      }
      if (!toPhone) {
        outcome = { channel: item.channel, preset_id: item.preset_id, success: false, error: "no_recipient_phone" }
      } else {
        const r = await orchestrateSmsPresetSend({
          brokerageId: args.brokerageId,
          presetId:    item.preset_id,
          contactId:   args.contactId,
          leadId:      args.leadId,
          toPhone,
          recipientFirstName: args.recipientFirstName,
          teamId:      args.teamId,
          agentUserId: args.agentUserId,
          systemSource: args.systemSource ?? `bundle:${bundle.name}`,
        })
        outcome = {
          channel:   item.channel,
          preset_id: item.preset_id,
          success:   r.success,
          messageId: r.messageId,
          error:     r.error,
        }
      }
    } else if (item.channel === "portal_push" && item.preset_id && args.contactId) {
      // Wave 38 — portal card insert. No external egress, no TCPA.
      // Requires contactId (leads don't have portal accounts).
      const r = await orchestratePortalPushSend({
        brokerageId: args.brokerageId,
        presetId:    item.preset_id,
        contactId:   args.contactId,
        teamId:      args.teamId,
        agentUserId: args.agentUserId,
        systemSource: args.systemSource ?? `bundle:${bundle.name}`,
      })
      outcome = { channel: item.channel, preset_id: item.preset_id, success: r.success, messageId: r.messageId, error: r.error }
    } else if (item.channel === "voicedrop" && item.preset_id) {
      // Wave 38 — ringless voicemail. TCPA gate applies; phone
      // resolved from args.recipientPhone or contact.phone.
      let toPhone = args.recipientPhone ?? null
      if (!toPhone && args.contactId) {
        const { data } = await svc.from("contacts").select("phone").eq("id", args.contactId).maybeSingle()
        toPhone = (data?.phone as string | null) ?? null
      }
      if (!toPhone) {
        outcome = { channel: item.channel, preset_id: item.preset_id, success: false, error: "no_recipient_phone" }
      } else {
        const r = await orchestrateVoicedropSend({
          brokerageId: args.brokerageId,
          presetId:    item.preset_id,
          contactId:   args.contactId,
          leadId:      args.leadId,
          toPhone,
          recipientFirstName: args.recipientFirstName,
          teamId:      args.teamId,
          agentUserId: args.agentUserId,
          systemSource: args.systemSource ?? `bundle:${bundle.name}`,
        })
        outcome = { channel: item.channel, preset_id: item.preset_id, success: r.success, messageId: r.jobId, error: r.error }
      }
    } else if (item.channel === "social_post" && item.preset_id) {
      // Wave 37 — social: stages N platform-specific social_posts
      // rows for the existing publish-social-posts cron to dispatch.
      const r = await orchestrateSocialPresetPublish({
        brokerageId: args.brokerageId,
        presetId:    item.preset_id,
        teamId:      args.teamId,
        agentUserId: args.agentUserId,
        systemSource: args.systemSource ?? `bundle:${bundle.name}`,
      })
      outcome = {
        channel:   item.channel,
        preset_id: item.preset_id,
        success:   r.success,
        // r.socialPostIds[0] used as the synthetic "messageId" so the
        // dispatch ledger has at least one id to reference.
        messageId: r.socialPostIds?.[0],
        error:     r.error,
      }
    } else {
      // preset_id missing.
      outcome = {
        channel:    item.channel,
        preset_id:  item.preset_id,
        success:    false,
        error:      "preset_id_required",
      }
    }
    outcomes.push(outcome)
    channelOutcomesJsonb[item.channel] = {
      success:    outcome.success,
      message_id: outcome.messageId ?? null,
      error:      outcome.error ?? null,
      rendered:   outcome.rendered ?? null,
      preset_id:  outcome.preset_id,
    }
  }

  // 4. Persist the channel outcomes blob on the dispatch row.
  await svc
    .from("campaign_bundle_dispatches")
    .update({
      channel_outcomes: channelOutcomesJsonb,
      updated_at:       new Date().toISOString(),
    })
    .eq("id", bundleDispatchId)

  const anyOk = outcomes.some((o) => o.success)
  return {
    ok:               anyOk,
    bundleDispatchId,
    bundleName:       bundle.name,
    channelOutcomes:  outcomes,
  }
}
