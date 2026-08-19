"use server"

/**
 * app/actions/campaign-bundle-dispatch.ts
 *
 * THE SEND SIDE OF A CAMPAIGN BUNDLE.
 *
 * `lib/direct-mail/orchestrate-bundle-send.ts:orchestrateBundleSend` is the
 * multi-channel dispatcher — it walks a bundle's ordered items and fires each
 * one through its channel orchestrator (postcard / letter / email / sms /
 * voicedrop / portal push / social / podcast / ad retarget), stamps a shared
 * bundle_dispatch_id on every resulting campaign row, and writes the
 * campaign_bundle_dispatches audit row that /api/cron/bundle-attribution-rollup
 * reads to answer "what did THIS bundle drive across channels".
 *
 * It had no caller anywhere in the tree. The builder at
 * /settings/campaign-bundles can create, edit and deactivate bundles and says
 * so in its own copy — "Nothing sends until you dispatch it" — and there was no
 * dispatch. campaign_bundle_dispatches has never had a writer, so the
 * attribution cron has always had nothing to roll up.
 *
 * This action is the missing seam and nothing more: the dispatcher is
 * `import "server-only"` and cannot be reached from a client component, so a
 * server action is what stands between the two. It lives in its own file rather
 * than in app/actions/campaign-bundles.ts (CRUD) because dispatching is a send,
 * not an edit, and the two want different gates.
 *
 * GATE. This is a `"use server"` export that takes a bundle id and a contact id
 * and SENDS OUTBOUND MESSAGES on both. Everything below is proved from the
 * session, never from the caller's arguments:
 *   · the caller is authenticated and has a brokerage (resolveWriteContext);
 *   · the contact is in that brokerage (cookie client, so RLS applies to the
 *     check itself), and it fails CLOSED on a refused read;
 *   · the brokerageId handed to the dispatcher is the SESSION's, so the
 *     dispatcher's own `bundle.brokerage_id !== args.brokerageId` check cannot
 *     be satisfied by a bundle from another tenant.
 * Per-piece compliance is unchanged and still applies inside each channel
 * orchestrator — consent, DNC, opt-out, quiet hours and suppression are not
 * bypassed by bundling.
 */

import { resolveWriteContext } from "@/lib/platform/acting-context"
import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"

export interface SendCampaignBundleResult {
  success: boolean
  error?: string
  bundleName?: string
  bundleDispatchId?: string
  channelOutcomes?: Array<{
    channel: string
    success: boolean
    error?: string
  }>
}

export async function sendCampaignBundleToContactAction(params: {
  bundleId: string
  contactId: string
}): Promise<SendCampaignBundleResult> {
  if (!isValidUUID(params.bundleId) || !isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid bundle or contact id" }
  }

  // resolveWriteContext re-validates the acting grant at call time and REFUSES
  // a read-only act-as session outright — an impersonating investigator must
  // not be able to make the platform send mail as the tenant.
  const ctx = await resolveWriteContext()
  if (!ctx.ok || !ctx.brokerageId) {
    return { success: false, error: (ctx as { error?: string }).error ?? "Unauthorized" }
  }
  const brokerageId = ctx.brokerageId

  // Prove the contact is in the caller's tenant through the COOKIE client, so
  // RLS applies to the check and not just the predicate. supabase-js RESOLVES a
  // refused query, which is why the error branch is explicit: a check that
  // cannot be run must refuse, not pass.
  const supabase = await createClient()
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone")
    .eq("id", params.contactId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (contactError) return { success: false, error: "Could not verify that contact" }
  if (!contact) return { success: false, error: "Contact not found" }

  const recipientName =
    `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Neighbor"

  // Direct-mail items need a deliverable address. A bundle with no mail item
  // does not need one, so a missing address is NOT a refusal here — the
  // dispatcher records `no deliverable address` against the mail item only and
  // still runs the digital ones. Empty strings are what the mail orchestrator
  // already treats as "no address on file".
  const { resolveMailingAddressForContact } = await import("@/lib/contacts/resolve-mailing-address")
  const address = await resolveMailingAddressForContact({ contactId: params.contactId, brokerageId })

  const { orchestrateBundleSend } = await import("@/lib/direct-mail/orchestrate-bundle-send")
  const result = await orchestrateBundleSend({
    brokerageId,
    bundleId:  params.bundleId,
    contactId: params.contactId,
    userId:    ctx.userId ?? undefined,
    // agents.id, NOT users.id — a disjoint id space. The preset orchestrators
    // take the agents-class id; ctx.agentId is already that.
    agentId:     ctx.agentId ?? undefined,
    agentUserId: ctx.userId ?? null,
    recipientName,
    mailingAddress: address?.street ?? "",
    city:           address?.city   ?? "",
    state:          address?.state  ?? "",
    zip:            address?.zip    ?? "",
    recipientFirstName: contact.first_name ?? null,
    recipientLastName:  contact.last_name ?? null,
    recipientEmail:     contact.email ?? null,
    recipientPhone:     contact.phone ?? null,
    systemSource:       "crm_contact_bundle_send",
  })

  if (!result.ok) {
    return {
      success: false,
      error: result.error ?? "The bundle did not send.",
      bundleName: result.bundleName,
      channelOutcomes: result.channelOutcomes.map((o) => ({
        channel: o.channel,
        success: o.success,
        error:   o.error,
      })),
    }
  }

  return {
    success: true,
    bundleName: result.bundleName,
    bundleDispatchId: result.bundleDispatchId,
    channelOutcomes: result.channelOutcomes.map((o) => ({
      channel: o.channel,
      success: o.success,
      error:   o.error,
    })),
  }
}
