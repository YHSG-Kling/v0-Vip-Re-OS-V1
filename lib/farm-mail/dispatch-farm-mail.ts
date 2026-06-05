/**
 * lib/farm-mail/dispatch-farm-mail.ts
 *
 * Wave 36 — content-bank-fed persona farm mail. This is where the
 * platform's content_topic_bank meets the direct-mail pipeline: an
 * agent's weekly farm send pulls a FRESH, persona-targeted topic
 * from the bank, weaves it into AI-drafted compliance-gated copy,
 * renders a branded postcard, and ships through Lob — all within
 * the agent's assigned farm_territories zip codes.
 *
 * Flow:
 *   1. Resolve the agent's farm_territories → zip code set
 *   2. Find contacts in those zips with verified mailing addresses
 *      + no direct_mail_opt_out + no recent farm send (30d cooldown)
 *   3. Group by contact_persona (the bank picks topics per persona)
 *   4. Per persona, pickTopics({assetType:'direct_mail_postcard',
 *      recipientPersona}) — the bank's per-(asset_type, persona)
 *      performance scoring (Wave 26 content_asset_persona_performance)
 *      means the topic returned for "downsize" recipients is the one
 *      that historically engaged downsizers, not the global #1
 *   5. orchestrateRenderAndSend with topicHook in the copy context
 *   6. Log a content_topic_uses row (asset_type='direct_mail_postcard',
 *      asset_id=direct_mail_campaigns.id) so the next cycle's pickTopics
 *      sees the topic as 'consumed' and the aggregator can attribute
 *      QR scans + delivery outcomes back to the topic
 *
 * Multi-agent coordination: the topic pick is brokerage-wide, so two
 * agents on the same brokerage farming overlapping personas won't pick
 * the same topic in the same week — the bank's `markUsed=true` flip
 * is global.
 *
 * Self-learning loop: every send writes a content_topic_uses row;
 * scans on the printed QR write qr_scan_events; the aggregator joins
 * the two and updates content_asset_persona_performance.performance_
 * score on the (topic_id, asset_type='direct_mail_postcard', persona)
 * key. Next week's pickTopics for that persona sees the updated score.
 * No additional plumbing — the existing aggregator already covers it
 * once direct_mail_postcard is in its asset_type allowlist.
 *
 * Cost gate: dryRun=true returns the planned dispatches without
 * actually mailing. maxRecipients caps each agent's per-cycle spend.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { pickTopics, type TopicCandidate } from "@/lib/content-intel/topic-bank"
import { orchestrateRenderAndSend } from "@/lib/direct-mail/orchestrate-send"
import { resolveMailingAddressForContact } from "@/lib/contacts/resolve-mailing-address"
import type { Persona } from "@/lib/kernel/types"

export interface DispatchFarmMailArgs {
  brokerageId: string
  /** Agent who owns the farm. Reads agents.id directly. */
  agentId:     string
  /** Stop after mailing this many contacts (protects against blowing
   *  the agent's monthly mail budget on one cron run). Default 50. */
  maxRecipients?: number
  /** When true, returns the planned dispatches without calling Lob.
   *  Returns the copy + brand + recipient list the orchestrator WOULD
   *  have processed. Used by the admin UI's "preview farm send" button
   *  and by the live-test harness. */
  dryRun?: boolean
  /** Brokerage-level fall-back Lob template id for when render/copy
   *  fails — same pattern as pre-listing kit. */
  fallbackTemplateId: string
  /** Caller can scope to a specific persona (otherwise we group by
   *  every persona present in the contact set). */
  onlyPersona?: Persona
}

export interface FarmMailRecipient {
  contactId:   string
  firstName:   string | null
  lastName:    string | null
  persona:     string
  zip:         string
  topicId:     string | null
  topicTitle:  string | null
}

export interface DispatchFarmMailResult {
  ok:                   boolean
  agentId:              string
  zipsFarmed:           string[]
  recipientsConsidered: number
  /** Per-persona dispatch outcomes. */
  byPersona: Array<{
    persona:        string
    topicId:        string | null
    topicTitle:     string | null
    recipientCount: number
    sent:           number
    rendered:       number
    failed:         number
    fellBack:       number
  }>
  /** When dryRun=true, the recipient + topic plan that WOULD have
   *  been mailed. Each item has the persona, the picked topic, and
   *  the recipient details. */
  plan?: FarmMailRecipient[]
  error?: string
}

const DEFAULT_MAX_RECIPIENTS = 50
const FARM_COOLDOWN_DAYS     = 30

export async function dispatchFarmMail(
  args: DispatchFarmMailArgs,
): Promise<DispatchFarmMailResult> {
  const svc = createServiceClient()
  const maxRecipients = args.maxRecipients ?? DEFAULT_MAX_RECIPIENTS

  // 1. Resolve farm zip codes for this agent + the agent's team_id +
  //    user_id for the brand cascade. Pulled in one query so the
  //    cascade info is available throughout the dispatch loop.
  const { data: agentRow } = await svc
    .from("agents")
    .select("user_id, team_id")
    .eq("id", args.agentId)
    .eq("brokerage_id", args.brokerageId)
    .maybeSingle()
  const agentUserId: string | null = (agentRow?.user_id as string | undefined) ?? null
  const agentTeamId: string | null = (agentRow?.team_id as string | undefined) ?? null

  const { data: territories } = await svc
    .from("farm_territories")
    .select("zip_codes")
    .eq("agent_id", args.agentId)
    .eq("brokerage_id", args.brokerageId)
    .eq("is_active", true)
  const zipSet = new Set<string>()
  for (const t of (territories ?? []) as Array<{ zip_codes: string[] | null }>) {
    for (const z of t.zip_codes ?? []) if (z) zipSet.add(z)
  }
  const zips = [...zipSet]
  if (zips.length === 0) {
    return {
      ok: true,
      agentId: args.agentId,
      zipsFarmed: [],
      recipientsConsidered: 0,
      byPersona: [],
      error: "no_active_farm_territories",
    }
  }

  // 2. Find candidates: contacts in those zips with verified mailing
  //    address, no opt-out, no recent farm send.
  const cutoff = new Date(Date.now() - FARM_COOLDOWN_DAYS * 86_400_000).toISOString()
  // Contacts recently mailed (target_audience='farm_mail') in cooldown
  // window — we exclude them.
  const { data: recentlyMailed } = await svc
    .from("direct_mail_campaigns")
    .select("contact_id")
    .eq("brokerage_id", args.brokerageId)
    .eq("target_audience", "farm_mail")
    .gte("created_at", cutoff)
  const recentSet = new Set(
    ((recentlyMailed ?? []) as Array<{ contact_id: string | null }>)
      .map((r) => r.contact_id)
      .filter((id): id is string => !!id),
  )

  const { data: candidates } = await svc
    .from("contacts")
    .select("id, first_name, last_name, contact_persona, zip_code, mailing_address, mailing_address_verified, direct_mail_opt_out, dnc_status")
    .eq("brokerage_id", args.brokerageId)
    .eq("mailing_address_verified", true)
    .in("zip_code", zips)
    .neq("dnc_status", true)
    .neq("direct_mail_opt_out", true)
    .limit(maxRecipients * 4) // overfetch then de-dupe + cooldown filter

  type C = {
    id: string
    first_name: string | null
    last_name: string | null
    contact_persona: string | null
    zip_code: string | null
    mailing_address: string | null
  }
  const candidateContacts = ((candidates ?? []) as unknown as C[])
    .filter((c) => !recentSet.has(c.id))
    .filter((c) => !!c.mailing_address && !!c.zip_code)
    .slice(0, maxRecipients)

  // 3. Group by persona (default to "other" when unset).
  const byPersonaMap = new Map<string, C[]>()
  for (const c of candidateContacts) {
    const p = args.onlyPersona ?? (c.contact_persona ?? "other")
    if (args.onlyPersona && c.contact_persona && c.contact_persona !== args.onlyPersona) continue
    const arr = byPersonaMap.get(p) ?? []
    arr.push(c)
    byPersonaMap.set(p, arr)
  }

  // 4. Per persona, pick a topic + dispatch.
  const plan: FarmMailRecipient[] = []
  const outcomes: DispatchFarmMailResult["byPersona"] = []

  for (const [persona, contacts] of byPersonaMap.entries()) {
    // pickTopics is per-(brokerage, asset_type, persona). markUsed=true
    // ONLY for the real path — dryRun shouldn't mutate the bank.
    const topics: TopicCandidate[] = await pickTopics({
      brokerageId:        args.brokerageId,
      assetType:          "direct_mail_postcard",
      recipientPersona:   persona,
      limit:              1,
      markUsed:           !args.dryRun,
    })
    const topic = topics[0] ?? null

    if (args.dryRun) {
      for (const c of contacts) {
        plan.push({
          contactId:  c.id,
          firstName:  c.first_name,
          lastName:   c.last_name,
          persona,
          zip:        c.zip_code ?? "",
          topicId:    topic?.id ?? null,
          topicTitle: topic?.topic_title ?? null,
        })
      }
      outcomes.push({
        persona,
        topicId:        topic?.id ?? null,
        topicTitle:     topic?.topic_title ?? null,
        recipientCount: contacts.length,
        sent: 0, rendered: 0, failed: 0, fellBack: 0,
      })
      continue
    }

    // Real path — orchestrate one piece per contact.
    let sent = 0, rendered = 0, failed = 0, fellBack = 0
    for (const c of contacts) {
      const address = await resolveMailingAddressForContact({
        contactId:   c.id,
        brokerageId: args.brokerageId,
      })
      if (!address) { failed++; continue }

      const result = await orchestrateRenderAndSend({
        brokerageId: args.brokerageId,
        contactId:   c.id,
        userId:      args.agentId,
        agentId:     args.agentId,
        recipientName:  [c.first_name, c.last_name].filter(Boolean).join(" ") || "Neighbor",
        mailingAddress: address.street,
        city:           address.city,
        state:          address.state,
        zip:            address.zip,
        pieceType:      "postcard",
        copyCtx: {
          brokerageId: args.brokerageId,
          teamId:      agentTeamId,
          agentUserId,
          contactId:   c.id,
          persona,
          qrDestinationType: "cma_form",
          hookFacts: { farmZip: c.zip_code ?? undefined },
          topicHook: topic ? {
            topicId:    topic.id,
            title:      topic.topic_title,
            valueAngle: topic.value_angle,
          } : undefined,
        },
        fallbackTemplateId: args.fallbackTemplateId,
        systemSource:       "farm_mail",
      })

      if (result.success) sent++
      else failed++
      if (result.rendered) rendered++
      else fellBack++

      // Record the direct_mail_campaigns row.
      const { data: dmCampaign } = await svc
        .from("direct_mail_campaigns")
        .insert({
          brokerage_id:    args.brokerageId,
          agent_id:        args.agentId,
          contact_id:      c.id,
          campaign_name:   `Farm Mail - ${persona} - ${c.zip_code ?? ""}`,
          target_audience: "farm_mail",
          quantity:        1,
          status:          result.success ? "sent" : "failed",
          piece_type:      "postcard",
          lob_order_id:    result.messageId ?? null,
          mailing_date:    result.success ? new Date().toISOString().slice(0, 10) : null,
          pieces_mailed:   result.success ? 1 : 0,
          is_ai_generated: true,
          approval_status: result.rendered ? "auto_approved" : "fell_back",
          created_at:      new Date().toISOString(),
        })
        .select("id")
        .single()

      // Close the self-learning loop: log the topic use against this
      // campaign so the aggregator joins it to qr_scan_events later.
      if (topic && dmCampaign?.id) {
        await svc.from("content_topic_uses").insert({
          topic_id:     topic.id,
          brokerage_id: args.brokerageId,
          asset_type:   "direct_mail_postcard",
          asset_id:     dmCampaign.id,
          used_at:      new Date().toISOString(),
        })
      }
    }

    outcomes.push({
      persona,
      topicId:        topic?.id ?? null,
      topicTitle:     topic?.topic_title ?? null,
      recipientCount: contacts.length,
      sent, rendered, failed, fellBack,
    })
  }

  return {
    ok: true,
    agentId: args.agentId,
    zipsFarmed: zips,
    recipientsConsidered: candidateContacts.length,
    byPersona: outcomes,
    plan: args.dryRun ? plan : undefined,
  }
}
