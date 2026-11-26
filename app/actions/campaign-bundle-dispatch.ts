"use server"

/**
 * app/actions/campaign-bundle-dispatch.ts
 *
 * THE SEND SIDE OF A CAMPAIGN BUNDLE.
 *
 * `lib/direct-mail/orchestrate-bundle-send.ts:orchestrateBundleSend` is the
 * multi-channel dispatcher — it sends the bundle's FIRST item now and persists
 * each later item as a follow-on the arbiter times (wave 153, lane 153I — row 71;
 * drained by app/api/cron/queue-drain), each through its channel orchestrator
 * (postcard / letter / email / sms / voicedrop / portal push / social / podcast /
 * ad retarget), stamps a shared
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
  /** WAVE 153 (153I, row 71): the next piece, persisted as a follow-on the OS times for this person (null = one-piece bundle). */
  followOn?: { scheduled: boolean; channel: string | null; remaining: number } | null
}

/** The dispatcher's codes in the sender's words (what happened · whether it is saved · what to do) — never a raw code. */
const OUTCOME_WORDS: Readonly<Record<string, string>> = Object.freeze({
  no_recipient_email: "Not sent — there is no email address on file for this contact.",
  no_recipient_phone: "Not sent — there is no phone number on file for this contact.",
  preset_deactivated: "Not sent — this piece was turned off in the bundle's presets.",
  preset_not_found: "Not sent — this piece no longer exists; edit the bundle to replace it.",
  preset_id_required: "Not sent — this step has no piece picked; edit the bundle to choose one.",
  bundle_not_found: "That bundle no longer exists.",
  bundle_deactivated: "That bundle is turned off. Turn it back on under Settings → Campaign bundles to send it.",
  bundle_has_no_items: "That bundle has no pieces yet. Add one under Settings → Campaign bundles.",
  bundle_items_unreadable: "The bundle's pieces could not be loaded right now, so nothing was sent. Try again in a moment.",
  tenant_mismatch: "That bundle is not part of your account.",
})
const inWords = (code: string | undefined): string | undefined => (code ? OUTCOME_WORDS[code] ?? code : code)

export async function sendCampaignBundleToContactAction(params: {
  bundleId: string
  contactId: string
  /** WAVE 154 (lane 154H): the marketing campaign this send belongs to (optional). Verified below against the SESSION tenant
   *  through the cookie client; an unverifiable id is dropped (the send still goes, unattributed), never trusted from the body. */
  marketingCampaignId?: string | null
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

  // campaign_bundle_dispatches.lead_id (m611 FK, unapplied) — the dispatcher
  // (lib/direct-mail/orchestrate-bundle-send.ts:125) has always written
  // `args.leadId ?? null`, but this, its sole caller, never supplied leadId,
  // so every row landed null and app/api/cron/bundle-attribution-rollup/
  // route.ts's LEAD-recipient attribution branch (it reads lead_id back and
  // counts mail_response_tracking / conversions against it) never had
  // anything to find for a contact-side send. This action is contact-only by
  // design (`sendCampaignBundleToContactAction`), so leadId here is never the
  // send TARGET — it is the lead this same contact converted FROM, resolved
  // through the cookie client so RLS still scopes it to the caller's tenant.
  // `leads.contact_id = contacts.id` is the LINK stamped at conversion
  // (lib/contact-promotion/history-carry.ts) — never contacts.contact_id,
  // an unrelated secondary uuid on the same table (CLAUDE.md §3 trap). A
  // contact can in principle trace back to more than one lead after a dedup
  // merge, so this picks the most recently converted one; a miss (a contact
  // that was never a lead) leaves lead_id null exactly as before, and the
  // rollup's `if (d.lead_id)` branch simply does not run for it.
  const { data: sourceLead } = await supabase
    .from("leads")
    .select("id")
    .eq("contact_id", params.contactId)
    .eq("brokerage_id", brokerageId)
    .order("converted_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const leadId = (sourceLead?.id as string | undefined) ?? undefined

  // Direct-mail items need a deliverable address. A bundle with no mail item
  // does not need one, so a missing address is NOT a refusal here — the
  // dispatcher records `no deliverable address` against the mail item only and
  // still runs the digital ones. Empty strings are what the mail orchestrator
  // already treats as "no address on file".
  const { resolveMailingAddressForContact } = await import("@/lib/contacts/resolve-mailing-address")
  const address = await resolveMailingAddressForContact({ contactId: params.contactId, brokerageId })

  // WAVE 82D — the bundle's printed postcard carries a TRACKED QR (81D open
  // item). One registered code per bundle through THE ONE minter (idempotent
  // per label, tenant-owned); a refused mint sends without a QR, honestly null.
  let bundleQr: { scanUrl: string } | null = null
  try {
    const { mintTrackedQr } = await import("@/lib/marketing/tracked-qr")
    bundleQr = await mintTrackedQr({ brokerageId, agentId: ctx.agentId ?? null, label: `campaign_bundle:${params.bundleId}`, purpose: "campaign" })
  } catch (err) {
    console.error("[campaign-bundle-dispatch] tracked QR unavailable:", (err as Error)?.message)
  }

  // The campaign, verified in THIS tenant under RLS (a refused or empty read leaves the send unattributed, never mis-attributed).
  let marketingCampaignId: string | null = null
  if (params.marketingCampaignId && isValidUUID(params.marketingCampaignId)) {
    const { data: camp, error: campErr } = await supabase.from("marketing_campaigns").select("id").eq("id", params.marketingCampaignId).eq("brokerage_id", brokerageId).maybeSingle()
    if (campErr) console.error(`[campaign-bundle-dispatch] campaign not verified (sent unattributed): ${campErr.message}`)
    marketingCampaignId = (camp?.id as string | undefined) ?? null
  }

  const { orchestrateBundleSend } = await import("@/lib/direct-mail/orchestrate-bundle-send")
  const result = await orchestrateBundleSend({
    marketingCampaignId,
    brokerageId,
    bundleId:  params.bundleId,
    contactId: params.contactId,
    leadId,
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
    qrScanUrl:          bundleQr?.scanUrl ?? null,
    systemSource:       "crm_contact_bundle_send",
  })

  const followOn = result.followOn
    ? { scheduled: result.followOn.scheduled, channel: result.followOn.channel, remaining: result.followOn.remaining }
    : null

  if (!result.ok) {
    return {
      success: false,
      error: inWords(result.error) ?? "The bundle did not send.",
      bundleName: result.bundleName,
      channelOutcomes: result.channelOutcomes.map((o) => ({
        channel: o.channel,
        success: o.success,
        error:   inWords(o.error),
      })),
      followOn,
    }
  }

  return {
    success: true,
    bundleName: result.bundleName,
    bundleDispatchId: result.bundleDispatchId,
    channelOutcomes: result.channelOutcomes.map((o) => ({
      channel: o.channel,
      success: o.success,
      error:   inWords(o.error),
    })),
    followOn,
  }
}
