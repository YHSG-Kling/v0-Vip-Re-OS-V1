// lib/kernel/manager-signals.ts
//
// THE INTER-MANAGER BUS — managers talking to one another, first-class. Until now the
// 11 Claude managers ran closed loops with point-to-point handoffs buried in code. This
// makes every manager-to-manager conversation explicit, auditable, and actionable:
//
//   publishManagerSignal()  — a manager announces an outcome addressed to another manager
//   consumeManagerSignals() — the addressed manager reads its open inbox and ACTS (usually
//                             by proposing a governed deliverable into the gate), then marks
//                             the signal consumed WITH what it did.
//   loadRecentManagerTalk() — the Command Center's "managers talking" feed.
//
// First wired conversation (the proof): AI ISA finishes a dial batch → publishes per-outcome
// signals — appointment_set → the side-appropriate concierge ("your client booked, prep the
// next step"); cold call result → back into propensity as a cooldown. More conversations
// join the same bus (deal closed → Sphere, recruit joined → Recruiting → Deal Coordinator…).
//
// NOT server-only (by convention, like command-center.ts) so simulators drive it end-to-end.
// Only ever writes through a caller-supplied/service client — never import client-side.

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

export interface ManagerSignal {
  id: string
  fromManager: ManagerKey
  toManager: ManagerKey
  signalType: string
  message: string
  entityType: string | null
  entityId: string | null
  contactId: string | null
  payload: Record<string, unknown>
  status: "open" | "consumed" | "expired"
  createdAt: string
}

export interface PublishSignalInput {
  brokerageId: string
  fromManager: ManagerKey
  toManager: ManagerKey
  signalType: string
  message: string
  entityType?: string | null
  entityId?: string | null
  contactId?: string | null
  payload?: Record<string, unknown>
  /** Idempotency: when set, skip publishing if an OPEN signal with the same
   *  (to_manager, signal_type, entity_id) already exists. Default true. */
  dedupe?: boolean
}

/** Pure: both ends of a signal must be real registered managers. */
export function validSignalRoute(from: string, to: string): boolean {
  return from in MANAGERS && to in MANAGERS && from !== to
}

/** A manager announces an outcome to another manager. Idempotent per open (to, type, entity). */
export async function publishManagerSignal(
  input: PublishSignalInput, client?: Svc,
): Promise<{ ok: boolean; signalId?: string; reason?: string }> {
  const supabase = client ?? createServiceClient()
  if (!validSignalRoute(input.fromManager, input.toManager)) {
    return { ok: false, reason: `invalid route ${input.fromManager} → ${input.toManager}` }
  }
  if (input.dedupe !== false && input.entityId) {
    const { data: existing } = await supabase
      .from("manager_signals").select("id")
      .eq("brokerage_id", input.brokerageId).eq("to_manager", input.toManager)
      .eq("signal_type", input.signalType).eq("entity_id", input.entityId)
      .eq("status", "open").limit(1).maybeSingle()
    if (existing) return { ok: true, signalId: (existing as { id: string }).id, reason: "already open (deduped)" }
  }
  const { data, error } = await supabase.from("manager_signals").insert({
    brokerage_id: input.brokerageId,
    from_manager: input.fromManager,
    to_manager: input.toManager,
    signal_type: input.signalType,
    message: input.message,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    contact_id: input.contactId ?? null,
    payload: input.payload ?? {},
  }).select("id").single()
  if (error || !data) return { ok: false, reason: error?.message ?? "insert failed" }
  return { ok: true, signalId: (data as { id: string }).id }
}

/**
 * Stage the lead's persona POSTCARD as a GATED direct_mail_campaigns row — the
 * direct-mail half of the multi-manager outreach play. Copy is BRAND-VOICED + them-first
 * (draftPostcardCopy → the brand-voice + compliance-redraft path, falling back to a
 * grounded line when the gateway is unavailable — never a stub), carrying a tracked
 * book-a-consult QR. NEVER calls dispatchDirectMail — a human approves before any Lob
 * send. Idempotent per (lead): one open pending postcard per lead. Returns an action
 * string, or null on insert failure.
 */
async function proposeLeadIntroPostcard(
  supabase: Svc, brokerageId: string, agentUserId: string, lead: Record<string, any>,
): Promise<string | null> {
  const leadId = lead.id as string
  const firstName = (lead.first_name as string | null) || "there"
  const interest = (lead.property_interest as string | null)?.trim() || "your move"

  // Idempotency — one still-gated proposed lead-intro postcard per lead.
  const { data: existing } = await supabase.from("direct_mail_campaigns").select("id")
    .eq("brokerage_id", brokerageId).eq("lead_id", leadId)
    .eq("target_audience", "ai_isa_lead_intro").eq("approval_status", "pending").maybeSingle()
  if (existing?.id) return "persona postcard already proposed (gated, deduped)"

  // Tracked book-a-consult QR (kind 'lead_intro' → book_meeting /book). Best-effort.
  let qrCodeId: string | null = null
  try {
    const { mintVideoQr } = await import("@/lib/video/video-qr")
    const minted = await mintVideoQr({ brokerageId, agentUserId, kind: "lead_intro", leadId }, supabase)
    qrCodeId = minted?.qrCodeId ?? null
  } catch { /* a postcard proposal must still land without a QR */ }

  // BRAND-VOICED, them-first copy — the brand-voice + compliance-redraft generator, NOT a
  // static Lob template. A grounded fallback keeps the piece real when the gateway is down.
  let copyText =
    `Hi ${firstName} — whenever you're ready to talk about ${interest}, I'm here to help, ` +
    `no pressure at all. Scan the code to book a quick, friendly chat on your schedule.`
  try {
    const { draftPostcardCopy } = await import("@/lib/direct-mail/draft-copy")
    const drafted = await draftPostcardCopy({
      brokerageId, agentUserId, contactId: null,
      persona: (lead.motivation_type as string | null) ?? "other",
      qrDestinationType: "book_meeting",
    })
    if (drafted.ok) copyText = `${drafted.copy.headline} — ${drafted.copy.body} ${drafted.copy.cta}`.trim()
  } catch { /* keep the grounded fallback copy */ }

  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || "there"
  const { data: campaign, error } = await supabase.from("direct_mail_campaigns").insert({
    brokerage_id: brokerageId, agent_id: agentUserId, lead_id: leadId,
    campaign_name: `AI ISA intro postcard — ${name}`.slice(0, 120),
    target_audience: "ai_isa_lead_intro", quantity: 1, piece_type: "postcard",
    copy_text: copyText, qr_code_id: qrCodeId, is_ai_generated: true,
    approval_status: "pending", status: "planning", created_at: new Date().toISOString(),
  }).select("id").maybeSingle()
  if (error || !campaign) return null
  return `staged the brand-voiced persona postcard (gated pending approval)`
}

/** A signal handler: acts on one signal, returns the action taken (or null to leave open). */
export type SignalHandler = (signal: ManagerSignal, ctx: { brokerageId: string; supabase: Svc }) => Promise<string | null>

/** Resolve a users.id to notify for a contact — the contact's assigned agent. Best-effort. */
async function resolveLoanAgentUser(supabase: Svc, contactId: string): Promise<string | null> {
  const { data: c } = await supabase.from("contacts").select("agent_id").eq("id", contactId).maybeSingle()
  const agentId = (c as any)?.agent_id
  if (!agentId) return null
  const { data: a } = await supabase.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  return (a as any)?.user_id ?? null
}

/** The registered conversations — to_manager:signal_type → handler. Handlers act by
 *  proposing GOVERNED deliverables (the gate), never autonomous sends. */
export const SIGNAL_HANDLERS: Record<string, SignalHandler> = {
  // AI ISA → concierge: a dial-batch call booked an appointment. The concierge proposes
  // the prep follow-up to the client through the gate.
  "shopping_agent:isa_call_appointment": async (signal, ctx) => {
    if (!signal.contactId) return null
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: ctx.brokerageId, agentKind: "shopping_agent", entityType: "contact",
      entityId: signal.contactId, recipientContactId: signal.contactId, audience: "buyer",
      subject: "Looking forward to our appointment",
      body: "Great speaking with you! Ahead of our appointment I'll pull together homes matched to what you described — reply here with anything you'd like me to include.",
      rationale: `AI ISA booked an appointment on a dial-batch call — prep follow-up (signal ${signal.signalType}).`,
      channel: "portal",
    }, ctx.supabase)
    return res.ok ? `proposed buyer prep follow-up (gate message ${res.id})` : null
  },
  // Deal Coordinator → Sphere: a deal closed — the client crossed into LIFETIME territory.
  // The Sphere proposes the lifetime welcome to the client through the gate.
  "sphere_of_influence:deal_closed": async (signal, ctx) => {
    if (!signal.contactId) return null
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: ctx.brokerageId, agentKind: "sphere_of_influence", entityType: "contact",
      entityId: signal.contactId, recipientContactId: signal.contactId, audience: "buyer",
      subject: "Congratulations — and welcome to the family",
      body: "Congratulations on your closing! From here on I'm your home's ongoing resource — annual value updates, trusted vendors whenever something needs fixing, and a real person to call before any move. Welcome to the family.",
      rationale: `Deal closed (${signal.message}) — Sphere lifetime welcome (signal ${signal.signalType}).`,
      channel: "portal",
    }, ctx.supabase)
    return res.ok ? `proposed lifetime welcome (gate message ${res.id})` : null
  },
  // Asset Manager → Campaign Orchestrator: a published landing page AI search persistently never cites.
  // The Orchestrator proposes a ONE-TAP gated regenerate_faq action (rebuild the FAQ + schema.org block
  // from fresh demand topics). Deduped so a re-fired gap signal never stacks duplicate proposals.
  "campaign_orchestrator:geo_visibility_gap": async (signal, ctx) => {
    if (!signal.entityId) return null  // the lead_capture_form id
    const { data: existing } = await ctx.supabase
      .from("marketing_agent_actions")
      .select("id")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("action_type", "regenerate_faq")
      .in("status", ["proposed", "approved"])
      .contains("action_input", { form_id: signal.entityId })
      .maybeSingle()
    if (existing) return "FAQ regeneration already proposed for this page"
    const { recordProposedActions } = await import("@/lib/agents/marketing-agent-actions")
    const res = await recordProposedActions({
      brokerageId: ctx.brokerageId,
      managedAgentSessionId: null,
      actions: [{
        action_type: "regenerate_faq",
        action_input: { form_id: signal.entityId, slug: (signal.payload as any)?.slug ?? null },
        rationale: signal.message,
      }],
    })
    return res.inserted > 0 ? `proposed FAQ regeneration for ${(signal.payload as any)?.slug ?? signal.entityId}` : null
  },
  // Data Steward → Campaign Orchestrator: the lead-source learner found a money-pit / a winner that's
  // off. The Orchestrator proposes a ONE-TAP gated reallocate_lead_sources action for that market.
  // Deduped per market so a re-fired waste signal never stacks duplicate proposals.
  "campaign_orchestrator:lead_source_waste": async (signal, ctx) => {
    if (!signal.entityId) return null  // the lead_scraping_market id
    const enable = ((signal.payload as any)?.enable ?? []) as string[]
    const disable = ((signal.payload as any)?.disable ?? []) as string[]
    if (enable.length === 0 && disable.length === 0) return "no source changes to propose"
    const { data: existing } = await ctx.supabase
      .from("marketing_agent_actions")
      .select("id").eq("brokerage_id", ctx.brokerageId).eq("action_type", "reallocate_lead_sources")
      .in("status", ["proposed", "approved"]).contains("action_input", { market_id: signal.entityId }).maybeSingle()
    if (existing) return "source reallocation already proposed for this market"
    const { recordProposedActions } = await import("@/lib/agents/marketing-agent-actions")
    const res = await recordProposedActions({
      brokerageId: ctx.brokerageId, managedAgentSessionId: null,
      actions: [{ action_type: "reallocate_lead_sources", action_input: { market_id: signal.entityId, enable, disable }, rationale: signal.message }],
    })
    return res.inserted > 0 ? `proposed source reallocation for market ${signal.entityId}` : null
  },
  // Listing Concierge → Shopping Agent: a price drop on an IN-HOUSE listing — inventory
  // talking to demand. The buyer side re-matches: every buyer who SAVED this listing gets
  // a price-improved alert proposed into the gate (capped, never autonomous).
  "shopping_agent:price_reduced": async (signal, ctx) => {
    if (!signal.entityId) return null
    const { data: savers } = await ctx.supabase
      .from("saved_properties")
      .select("contact_id, property_address")
      .eq("brokerage_id", ctx.brokerageId).eq("listing_id", signal.entityId)
      .eq("dismissed", false).not("contact_id", "is", null)
      .limit(5)
    const rows = (savers ?? []) as Array<{ contact_id: string; property_address: string | null }>
    if (rows.length === 0) return "no saved-property buyers to alert"
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    let proposed = 0
    for (const r of rows) {
      const res = await proposeClientMessage({
        brokerageId: ctx.brokerageId, agentKind: "shopping_agent", entityType: "listing",
        entityId: signal.entityId, recipientContactId: r.contact_id, audience: "buyer",
        subject: "Price improved on a home you saved",
        body: `Good news — ${r.property_address ?? "a home you saved"} just had a price improvement. Want a fresh look before others notice? Reply here and I'll set up a showing.`,
        rationale: `Price reduced on an in-house listing — re-match alert for a buyer who saved it (signal ${signal.signalType}).`,
        channel: "portal",
      }, ctx.supabase)
      if (res.ok) proposed += 1
    }
    return proposed > 0 ? `alerted ${proposed} saved-property buyer${proposed === 1 ? "" : "s"} (gated)` : null
  },
  // Deal Coordinator → Recruiting Manager: a RECRUITED agent just closed their FIRST deal.
  // Recruiting ROI gets its first real production datapoint + the broker gets the
  // celebration moment.
  "recruiting_manager:agent_first_close": async (signal, ctx) => {
    const agentId = (signal.payload?.agent_id as string | undefined) ?? null
    if (!agentId) return null
    const commission = Number(signal.payload?.commission_amount ?? 0)
    // First production datapoint (year 1) — recruiting_analytics.
    await ctx.supabase.from("recruiting_analytics").insert({
      brokerage_id: ctx.brokerageId, recruited_agent_id: agentId, year_number: 1,
      gross_commission_generated: commission, transaction_count: 1, computed_at: new Date().toISOString(),
    })
    // Celebrate to the brokerage managers.
    const { data: mgrs } = await ctx.supabase.from("users").select("id")
      .eq("brokerage_id", ctx.brokerageId).in("user_type", ["broker", "broker_admin", "admin"]).limit(10)
    for (const m of (mgrs ?? []) as Array<{ id: string }>) {
      await ctx.supabase.from("notifications").insert({
        user_id: m.id, brokerage_id: ctx.brokerageId, type: "recruiting_milestone",
        title: "A recruited agent just closed their first deal 🎉",
        body: signal.message, entity_type: "recruit", entity_id: signal.entityId,
        priority: "medium", is_read: false,
      })
    }
    return `recorded first-production datapoint${commission > 0 ? ` ($${Math.round(commission).toLocaleString()} GCI)` : ""} + celebrated to the broker`
  },
  // Commission & Cap Forecaster (Deal Coordinator) → Recruiting Manager: a CURRENT agent
  // HIT/crossed their commission cap. This is RECRUITING PROOF — a real production datapoint
  // the recruiter can cite to talent ("agents here hit and blow past cap"). We deliberately
  // do NOT write recruiting_analytics here: recruited_agent_id (NOT NULL) means a RECRUITED
  // agent, and a tenured agent crushing cap is not a recruit — misusing that column would
  // corrupt recruiting-ROI reporting. So we surface the talking point to the broker/admins
  // (the recruiting decision-makers), honestly, and leave the durable proof to the place it
  // belongs (the agent's own production), not a fabricated recruit row.
  "recruiting_manager:agent_crushed_cap": async (signal, ctx) => {
    const agentId = (signal.payload?.agent_id as string | undefined) ?? null
    if (!agentId) return null
    const { data: mgrs } = await ctx.supabase.from("users").select("id")
      .eq("brokerage_id", ctx.brokerageId).in("user_type", ["broker", "broker_admin", "admin"]).limit(10)
    const managerIds = (mgrs ?? []) as Array<{ id: string }>
    if (managerIds.length === 0) return "no broker/admin to surface the recruiting proof to"
    let notified = 0
    for (const m of managerIds) {
      const { error } = await ctx.supabase.from("notifications").insert({
        user_id: m.id, brokerage_id: ctx.brokerageId, type: "recruiting_proof",
        title: "Recruiting proof: an agent just blew past cap 🚀",
        body: `${signal.message} Cite this in talent conversations — real, current production beats any pitch.`,
        entity_type: "agent", entity_id: agentId, priority: "medium", is_read: false,
      })
      if (!error) notified += 1
    }
    return notified > 0 ? `surfaced post-cap production as recruiting proof to ${notified} broker/admin${notified === 1 ? "" : "s"}` : null
  },
  // Commission & Cap Forecaster (Deal Coordinator) → Recruiting Manager: a CURRENT agent is
  // STALLING (real pipeline but projected to badly miss, or zero production with a thin
  // pipeline). Recruiting "manages agents", so this is a COACHING prompt — surfaced to the
  // responsible MANAGER (broker/admin), never an autonomous message to the agent. The human
  // decides the intervention.
  "recruiting_manager:agent_stalling": async (signal, ctx) => {
    const agentId = (signal.payload?.agent_id as string | undefined) ?? null
    if (!agentId) return null
    const { data: mgrs } = await ctx.supabase.from("users").select("id")
      .eq("brokerage_id", ctx.brokerageId).in("user_type", ["broker", "broker_admin", "admin"]).limit(10)
    const managerIds = (mgrs ?? []) as Array<{ id: string }>
    if (managerIds.length === 0) return "no broker/admin to route the coaching prompt to"
    let notified = 0
    for (const m of managerIds) {
      const { error } = await ctx.supabase.from("notifications").insert({
        user_id: m.id, brokerage_id: ctx.brokerageId, type: "agent_coaching",
        title: "Coaching prompt: an agent is tracking behind",
        body: `${signal.message} A check-in now — pipeline review, accountability, or a skills touch — is the highest-leverage management move.`,
        entity_type: "agent", entity_id: agentId, priority: "medium", is_read: false,
      })
      if (!error) notified += 1
    }
    return notified > 0 ? `routed a coaching prompt to ${notified} responsible manager${notified === 1 ? "" : "s"}` : null
  },
  // Marketing → Ads Manager: an organic content week outperformed — propose promoting it
  // as PAID. Lands in the existing ads approval queue (governed spend, human-approved).
  "ads_manager:content_winner": async (signal, ctx) => {
    // ad_manager_actions.action_type CHECK: launch_ad_campaign | pause | shift_budget |
    // scale_ad_creative — promoting an organic winner = launching a campaign from it.
    const { error } = await ctx.supabase.from("ad_manager_actions").insert({
      brokerage_id: ctx.brokerageId,
      action_type: "launch_ad_campaign",
      action_input: { source: "content_winner", ...((signal.payload ?? {}) as Record<string, unknown>) },
      rationale: `Organic winner: ${signal.message} — promote it as paid before it goes stale.`,
      status: "proposed",
      proposed_at: new Date().toISOString(),
    })
    return error ? null : "proposed paid promotion in the ads approval queue"
  },
  // Asset Manager → Campaign Orchestrator: a render FINISHED. The Campaign Orchestrator
  // proposes ONE coordinated multi-channel distribution as a GATED draft (social_posts
  // status='draft', approval_status='pending') — nothing auto-publishes; a human approves
  // it in the Command Center. Idempotent: skips if a draft already carries this video.
  "campaign_orchestrator:video_ready": async (signal, ctx) => {
    if (!signal.entityId) return null
    const title = (signal.payload?.title as string | undefined) ?? "Your finished video"
    const kind = (signal.payload?.kind as string | undefined) ?? null
    const { proposeGatedVideoDistribution } = await import("@/lib/kernel/video")
    const res = await proposeGatedVideoDistribution({
      brokerageId: ctx.brokerageId,
      projectId: signal.entityId,
      title,
      description: `${title} — share-ready ${kind ?? "video"}. Reach your audience across channels.`,
      tags: kind ? [kind] : [],
    }, ctx.supabase as any)
    if (!res.ok) return res.reason === "draft already exists for this project"
      ? "coordinated distribution already proposed (gated, deduped)"
      : null
    return res.created
      ? "proposed a gated multi-channel distribution draft (pending approval)"
      : "coordinated distribution already proposed (gated, deduped)"
  },
  // Asset Manager → Ads Manager: a PROMOTABLE render (just_listed / just_sold /
  // open_house) finished. Mirrors content_winner — propose paid promotion into the
  // governed ad_manager_actions queue (status='proposed'); human-approved spend only.
  "ads_manager:video_ready": async (signal, ctx) => {
    // ad_manager_actions.action_type CHECK: launch_ad_campaign | pause_ad_campaign |
    // shift_ad_budget | scale_ad_creative — promoting a finished reel = launching a campaign.
    const { error } = await ctx.supabase.from("ad_manager_actions").insert({
      brokerage_id: ctx.brokerageId,
      action_type: "launch_ad_campaign",
      action_input: { source: "video_ready", video_project_id: signal.entityId, ...((signal.payload ?? {}) as Record<string, unknown>) },
      rationale: `Promotable video finished: ${signal.message} — promote it as paid while the moment is fresh.`,
      status: "proposed",
      proposed_at: new Date().toISOString(),
    })
    return error ? null : "proposed paid video promotion in the ads approval queue"
  },
  // Asset Manager → Campaign Orchestrator: a render FAILED compliance/redraft (or the
  // provider rejected it). The Orchestrator escalates so the failure is never invisible —
  // it routes a Command Center notification to the responsible agent + the brokerage
  // managers. No silent dead reels.
  "campaign_orchestrator:video_compliance_failed": async (signal, ctx) => {
    if (!signal.entityId) return null
    let notified = 0
    // Responsible agent for this video, when resolvable.
    const agentId = (signal.payload?.agent_id as string | undefined) ?? null
    if (agentId) {
      const { error } = await ctx.supabase.from("notifications").insert({
        user_id: agentId, brokerage_id: ctx.brokerageId, type: "video_compliance_failed",
        title: "A video render failed — needs your attention",
        body: `${signal.message} Review the source content; the coordinated distribution is paused until a clean render is produced.`,
        entity_type: "video_project", entity_id: signal.entityId, priority: "high", is_read: false,
      })
      if (!error) notified += 1
    }
    // Brokerage managers (broker/admin) — so a failure surfaces to the people who own it.
    const { data: mgrs } = await ctx.supabase.from("users").select("id")
      .eq("brokerage_id", ctx.brokerageId).in("user_type", ["broker", "broker_admin", "admin"]).limit(10)
    for (const m of (mgrs ?? []) as Array<{ id: string }>) {
      const { error } = await ctx.supabase.from("notifications").insert({
        user_id: m.id, brokerage_id: ctx.brokerageId, type: "video_compliance_failed",
        title: "Video render failed compliance",
        body: `${signal.message} Surfaced so it isn't lost — no distribution or spend proposed for a failed render.`,
        entity_type: "video_project", entity_id: signal.entityId, priority: "medium", is_read: false,
      })
      if (!error) notified += 1
    }
    return notified > 0
      ? `escalated the failed render to ${notified} responsible recipient${notified === 1 ? "" : "s"} (no silent dead reel)`
      : null
  },
  // AI ISA → Asset Manager: the ISA QUALIFIED a lead and DELEGATES the persona-matched
  // 1:1 intro reel to the Asset Manager (the team's video director). The Asset Manager
  // builds the creative brief from the lead's REAL facts and commissions the reel through
  // the Director (format → tracked book-a-consult QR → compliance gate → a GATED
  // ai_video_projects row). Nothing auto-publishes; when the reel finishes the completion
  // publisher hands it 1:1 to the Campaign Orchestrator (lead_outreach_ready). This is the
  // multi-manager outreach play — every hop shows on the "managers talking" feed.
  "asset_manager:lead_creative_handoff": async (signal, ctx) => {
    const leadId = signal.entityId
    if (!leadId) return null
    const { data: lead } = await ctx.supabase.from("leads")
      .select("id, first_name, last_name, email, email_verified, property_interest, timeline, motivation_type, budget_min, budget_max, enrichment_profile, brokerage_id, agent_id, mailing_address, mailing_city, mailing_state, mailing_zip, mailing_address_verified")
      .eq("id", leadId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    if (!lead) return null
    const l = lead as Record<string, any>

    // Resolve the on-screen presenter (ai_video_projects.agent_id → users.id): the lead's
    // assigned agent when present, else a brokerage broker/owner so the reel still carries a
    // real human's brand. No presenter on file → the reel is honestly deferred (the email
    // first-touch already went out); we never fabricate an identity.
    let agentUserId: string | null = null
    if (l.agent_id) {
      const { data: a } = await ctx.supabase.from("agents").select("user_id").eq("id", l.agent_id).maybeSingle()
      agentUserId = (a as any)?.user_id ?? null
    }
    if (!agentUserId) {
      const { data: broker } = await ctx.supabase.from("users").select("id")
        .eq("brokerage_id", ctx.brokerageId).in("user_type", ["broker_owner", "broker", "broker_admin"])
        .order("created_at", { ascending: true }).limit(1).maybeSingle()
      agentUserId = (broker as any)?.id ?? null
    }
    if (!agentUserId) return "no presenter on file (no agent / broker) — intro reel deferred; email first-touch already sent"

    const parts: string[] = []

    // ── (a) The persona INTRO REEL — only when there's a usable email to embed it in.
    //    (A direct-mail-only lead skips the reel and gets the postcard below.)
    const emailUsable = !!(l.email && l.email_verified === true)
    if (emailUsable) {
      const { buildLeadIntroReelBrief } = await import("@/lib/ai-isa/lead-reel-brief")
      const { commissionVideo } = await import("@/lib/video/video-director")
      const { realCopyGenerator } = await import("@/lib/kernel/ai-copy")
      const brief = buildLeadIntroReelBrief({
        leadId: l.id,
        firstName: l.first_name ?? "there",
        propertyInterest: l.property_interest ?? null,
        timeline: l.timeline ?? null,
        motivationType: l.motivation_type ?? null,
        budgetMin: l.budget_min ?? null,
        budgetMax: l.budget_max ?? null,
        enrichment: (l.enrichment_profile ?? null) as { age?: number | null; age_range?: string | null } | null,
      })
      const r = await commissionVideo(
        brief.situation,
        { brokerageId: ctx.brokerageId, agentUserId, leadId: l.id, title: brief.title, persona: brief.persona, extraFacts: brief.extraFacts, copyGenerator: realCopyGenerator },
        ctx.supabase,
      )
      if (r.status === "already_staged") parts.push(`intro reel already commissioned (${r.compositionId}, deduped)`)
      else if (r.ok) parts.push(`commissioned the persona intro reel (${r.compositionId}, gated) — hands to the Campaign Orchestrator on completion`)
      else if (r.status === "blocked") parts.push(`intro reel blocked at the compliance gate (${(r.violations ?? []).join("; ").slice(0, 120)})`)
    }

    // ── (b) The persona POSTCARD — when the mailing address is VERIFIED. Brand-voiced,
    //    them-first copy (draftPostcardCopy → the brand-voice + compliance-redraft path,
    //    NOT a static Lob template), staged GATED (direct_mail_campaigns approval_status
    //    'pending'/status 'planning' — a human approves before any Lob send). Idempotent.
    const mailingVerified = l.mailing_address_verified === true &&
      !!(l.mailing_address && l.mailing_city && l.mailing_state && l.mailing_zip)
    if (mailingVerified) {
      const postcard = await proposeLeadIntroPostcard(ctx.supabase, ctx.brokerageId, agentUserId, l)
      if (postcard) parts.push(postcard)
    }

    if (parts.length === 0) return "no usable channel for the persona creative (email unverified, mailing unverified) — deferred"
    return parts.join("; ")
  },
  // Asset Manager → Campaign Orchestrator: a lead's persona intro reel FINISHED. The
  // Orchestrator proposes ONE gated, 1:1 follow-up EMAIL to that lead embedding the reel —
  // email only (the canonical lead-channel rule: an unconsented lead is never SMS/phone/
  // social, and a personalized lead reel is never broadcast). A human approves it in the
  // Command Center before it sends. Idempotent per (lead, reel).
  "campaign_orchestrator:lead_outreach_ready": async (signal, ctx) => {
    const leadId = (signal.payload?.lead_id as string | undefined) ?? null
    const videoUrl = (signal.payload?.video_url as string | undefined) ?? null
    if (!leadId || !videoUrl) return null
    const { data: lead } = await ctx.supabase.from("leads")
      .select("id, first_name, brokerage_id").eq("id", leadId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    if (!lead) return null
    const firstName = (lead as any).first_name || "there"
    const subject = `A quick personal hello, ${firstName}`

    // Idempotency: one proposed/approved reel-email per lead.
    const { data: dup } = await ctx.supabase.from("agent_client_messages").select("id")
      .eq("brokerage_id", ctx.brokerageId).eq("recipient_lead_id", leadId)
      .eq("subject", subject).in("status", ["proposed", "approved"]).limit(1).maybeSingle()
    if (dup) return "reel follow-up already proposed for this lead (gated, deduped)"

    const body = [
      `Hi ${firstName},`,
      "",
      `I put together a short, personal video just for you — it's a quick hello and a look at how I can help with your move. No pressure at all; watch whenever it's convenient:`,
      "",
      videoUrl,
      "",
      `If anything in it is useful, just reply to this email and I'll take it from there.`,
    ].join("\n")

    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: ctx.brokerageId, agentKind: "campaign_orchestrator", entityType: "lead",
      entityId: leadId, recipientLeadId: leadId, audience: "lead",
      subject, body, channel: "email",
      rationale: `Persona intro reel finished for ${firstName} — propose the gated 1:1 email embedding it (email only; never broadcast).`,
    }, ctx.supabase)
    return res.ok ? `proposed the gated 1:1 reel email to the lead (approval ${res.id})` : null
  },
  // Deal Coordinator → Finance Manager: a deal worsened and the LOAN side is the risk. Finance
  // opens a drive-to-done task (assigned to the TC) and keeps the TC + agent aware — work the
  // loan, confirm the clear-to-close ETA. NOT the broker (operational). Part of the Deal-Save Huddle.
  "finance_manager:deal_save_huddle": async (signal, ctx) => {
    if (!signal.entityId) return null
    const play = (signal.payload?.play as string | undefined) ?? "Work the financing side and confirm the clear-to-close ETA."
    const cats = (signal.payload?.categories as string[] | undefined) ?? []
    const { resolveTransactionTeamUsers, notifyDealTeam } = await import("@/lib/kernel/deal-save-huddle")
    const team = await resolveTransactionTeamUsers(ctx.supabase, signal.entityId)
    const priority = signal.payload?.risk_level === "critical" ? "high" : "medium"
    const title = `[Deal-Save Huddle · Finance] ${cats.join(", ") || "financing"}`
    const { data: dup } = await ctx.supabase.from("transaction_tasks").select("id")
      .eq("transaction_id", signal.entityId).eq("title", title).in("status", ["pending", "in_progress"]).limit(1).maybeSingle()
    let opened = false
    if (!dup) {
      const { error } = await ctx.supabase.from("transaction_tasks").insert({
        transaction_id: signal.entityId, brokerage_id: ctx.brokerageId, title, description: play,
        priority, category: "financing", ai_generated: true, status: "pending",
        assigned_user_id: team.coordinatorUserId ?? null,
      })
      opened = !error
    }
    await notifyDealTeam(ctx.supabase, {
      team, brokerageId: ctx.brokerageId, transactionId: signal.entityId,
      type: "deal_save_huddle", title: "Deal at risk — financing", body: play, priority: priority as "high" | "medium",
    })
    return opened ? "opened a financing drive-to-done task (TC + agent notified)" : "financing task already open; TC + agent kept aware"
  },
  // Deal Coordinator → Finance Manager: an URGENT closing pending action owned by the LENDER
  // (e.g. clear-to-close not received N days out). Finance opens a gated drive-to-done task — not
  // a buried dashboard item. From closing-orchestration; routed by suggested_recipient='lender'.
  "finance_manager:transaction_action_pending": async (signal, ctx) => {
    if (!signal.entityId) return null
    const headline = (signal.payload?.headline as string | undefined) ?? signal.message
    const detail = (signal.payload?.detail as string | undefined) ?? ""
    const actionType = (signal.payload?.actionType as string | undefined) ?? "closing_action"
    const title = `[Closing · Finance] ${headline}`.slice(0, 180)
    const { resolveTransactionTeamUsers } = await import("@/lib/kernel/deal-save-huddle")
    const team = await resolveTransactionTeamUsers(ctx.supabase, signal.entityId)
    const { data: dup } = await ctx.supabase.from("transaction_tasks").select("id")
      .eq("transaction_id", signal.entityId).eq("title", title).in("status", ["pending", "in_progress"]).limit(1).maybeSingle()
    if (dup) return "closing finance task already open (deduped)"
    const { error } = await ctx.supabase.from("transaction_tasks").insert({
      transaction_id: signal.entityId, brokerage_id: ctx.brokerageId, title, description: detail || headline,
      priority: signal.payload?.severity === "urgent" ? "high" : "medium", category: "closing",
      ai_generated: true, status: "pending", assigned_user_id: team.coordinatorUserId ?? null,
    })
    return error ? null : `opened a gated closing task for the lender item (${actionType})`
  },
  // Deal Coordinator → Compliance Officer: an URGENT closing pending action owned by a
  // deadline-bearing vendor (title/escrow/inspection). Compliance flags the TC + agent so the
  // deadline exposure doesn't lapse unseen. From closing-orchestration.
  "compliance_officer:transaction_action_pending": async (signal, ctx) => {
    if (!signal.entityId) return null
    const headline = (signal.payload?.headline as string | undefined) ?? signal.message
    const detail = (signal.payload?.detail as string | undefined) ?? ""
    const { resolveTransactionTeamUsers, notifyDealTeam } = await import("@/lib/kernel/deal-save-huddle")
    const team = await resolveTransactionTeamUsers(ctx.supabase, signal.entityId)
    const notified = await notifyDealTeam(ctx.supabase, {
      team, brokerageId: ctx.brokerageId, transactionId: signal.entityId,
      type: "transaction_action_pending", title: `Closing deadline exposure — ${headline}`.slice(0, 120),
      body: detail || headline, priority: "high",
    })
    return notified > 0 ? `flagged the closing deadline exposure to the TC + agent (${notified})` : "deadline exposure noted (no TC/agent resolved)"
  },
  // Deal Coordinator → Finance Manager: a financing client's rate lock is expiring vs the close
  // date. Finance opens a gated drive-to-done task — confirm an extension/relock before the rate
  // (or the deal) is lost. Was feed-only ("worth watching"); now actioned.
  "finance_manager:rate_lock_watch": async (signal, ctx) => {
    if (!signal.entityId) return null
    const status = (signal.payload?.status as string | undefined) ?? "expiring"
    const days = signal.payload?.daysToExpiry as number | undefined
    const title = "[Rate Lock] confirm extension / relock"
    const { data: dup } = await ctx.supabase.from("transaction_tasks").select("id")
      .eq("transaction_id", signal.entityId).eq("title", title).in("status", ["pending", "in_progress"]).limit(1).maybeSingle()
    if (dup) return "rate-lock task already open (deduped)"
    const { error } = await ctx.supabase.from("transaction_tasks").insert({
      transaction_id: signal.entityId, brokerage_id: ctx.brokerageId, title,
      description: `Rate lock ${status}${typeof days === "number" ? ` (${days}d to expiry)` : ""}. Confirm extension status/cost with the lender or prepare to relock before close.`,
      priority: status === "expired" ? "high" : "medium", category: "financing", ai_generated: true, status: "pending",
    })
    return error ? null : "opened a rate-lock financing task (confirm extension/relock)"
  },
  // Deal Coordinator → Compliance Officer: a deal worsened and the DEADLINE/CONTINGENCY clock is
  // the risk. Compliance flags the exposure to the TC + agent (the people who work the deal — NOT
  // the broker) so a slipping contingency never lapses unseen. Part of the Deal-Save Huddle.
  "compliance_officer:deal_save_huddle": async (signal, ctx) => {
    if (!signal.entityId) return null
    const play = (signal.payload?.play as string | undefined) ?? "Verify the contingency clock; flag any slipping deadline."
    const { resolveTransactionTeamUsers, notifyDealTeam } = await import("@/lib/kernel/deal-save-huddle")
    const team = await resolveTransactionTeamUsers(ctx.supabase, signal.entityId)
    const notified = await notifyDealTeam(ctx.supabase, {
      team, brokerageId: ctx.brokerageId, transactionId: signal.entityId,
      type: "deal_save_huddle", title: "Deal at risk — deadline/contingency exposure", body: play, priority: "high",
    })
    return notified > 0 ? `flagged the deadline/contingency exposure to the TC + agent (${notified})` : "deadline exposure noted (no TC/agent resolved to notify)"
  },
    // Recruiting Manager → Deal Coordinator: a recruit just became an ACTIVE AGENT (no
  // contacts yet — the rule). The Deal Coordinator sets up first-deal onboarding support:
  // assigns the published agent-audience learning path + welcomes the new agent.
  "deal_coordinator:recruit_activated": async (signal, ctx) => {
    const agentUserId = (signal.payload?.user_id as string | undefined) ?? null
    if (!agentUserId) return null
    // Assign up to 3 published agent-audience learning modules (idempotent per
    // uq_la_agent_module via upsert-ignore).
    const { data: mods } = await ctx.supabase
      .from("learning_modules")
      .select("id")
      .eq("brokerage_id", ctx.brokerageId).eq("status", "published")
      .contains("audience_roles", ["agent"])
      .limit(3)
    let assigned = 0
    for (const m of (mods ?? []) as Array<{ id: string }>) {
      const { error } = await ctx.supabase.from("learning_assignments").upsert({
        brokerage_id: ctx.brokerageId, module_id: m.id, agent_user_id: agentUserId,
        status: "open", signal_source: "recruit_activated",
      }, { onConflict: "agent_user_id,module_id", ignoreDuplicates: true })
      if (!error) assigned += 1
    }
    // Welcome the new agent with their first-deal support kickoff.
    await ctx.supabase.from("notifications").insert({
      user_id: agentUserId, brokerage_id: ctx.brokerageId, type: "agent_onboarding",
      title: "Welcome aboard — your first-deal support is ready",
      body: assigned > 0
        ? `Your onboarding learning path (${assigned} module${assigned === 1 ? "" : "s"}) is assigned. The Deal Coordinator has your back on your first transaction.`
        : "The Deal Coordinator has your back on your first transaction — your onboarding kickoff is ready.",
      entity_type: "recruit", entity_id: signal.entityId, priority: "medium", is_read: false,
    })
    return `assigned ${assigned} onboarding module(s) + welcomed the new agent`
  },
    "listing_concierge:isa_call_appointment": async (signal, ctx) => {
    if (!signal.contactId) return null
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: ctx.brokerageId, agentKind: "listing_concierge", entityType: "contact",
      entityId: signal.contactId, recipientContactId: signal.contactId, audience: "seller",
      subject: "Looking forward to our appointment",
      body: "Great speaking with you! Ahead of our appointment I'll prepare a current market position for your home — reply here with anything you'd like me to cover.",
      rationale: `AI ISA booked an appointment on a dial-batch call — listing prep follow-up (signal ${signal.signalType}).`,
      channel: "portal",
    }, ctx.supabase)
    return res.ok ? `proposed seller prep follow-up (gate message ${res.id})` : null
  },
  // AI ISA — Data Steward → AI ISA: the Listing Inventory Radar promoted a bench-scraped
  // hot seller candidate THROUGH THE GATE into a `leads` row (ai_isa_owner=true, NO portal —
  // NOT a contact) and carried the seller-intent score + reasons onto the lead. This is the
  // DEFAULT route for a raw scraped seller lead: the AI ISA owns it, so the bus PRIORITIZES it
  // for qualification (lead_score floor already stamped by the runner; here we record the
  // prioritization on the ISA activity ledger). It NEVER proposes a PORTAL client message — the
  // lead is not a contact. It DOES extend a channel-appropriate, VERIFICATION-GATED nurture push
  // (the conversion play lead→contact) on the lead's OWN verified channels: when
  // leads.email_verified, a Director "thinking of selling?" reel is commissioned + its EMAIL
  // delivery PROPOSED (agent_client_messages, gated); when leads.mailing_address_verified, a
  // POSTCARD is PROPOSED (direct_mail_campaigns approval_status='pending', carrying its QR).
  // Each channel is independent + idempotent per (lead, channel); a false/missing flag → that
  // channel is skipped honestly; NOTHING auto-sends. The seller portal relationship still only
  // begins after AI ISA qualifies → conversion → contact (the listing_concierge path).
  "ai_isa:seller_intent_hot": async (signal, ctx) => {
    const p = (signal.payload ?? {}) as Record<string, unknown>
    const leadId = (p.lead_id as string | undefined) ?? null
    if (!leadId) return null
    const intentScore = typeof p.intent_score === "number" ? p.intent_score : 0
    const reasons = Array.isArray(p.reasons) ? (p.reasons as string[]) : []
    const propertyAddress = (p.property_address as string | undefined) ?? null

    // Confirm the gated lead exists + is ISA-owned and not a contact (defensive — the runner
    // promotes through the gate; we never act on a non-existent or already-converted lead here).
    const { data: lead } = await ctx.supabase
      .from("leads")
      .select("id, ai_isa_owner, contact_id, lead_score")
      .eq("id", leadId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    const l = lead as { ai_isa_owner?: boolean; contact_id?: string | null; lead_score?: number | null } | null
    if (!l || l.contact_id) return null // converted/contact-backed → not this handler's job

    // Record the prioritization on the AI-ISA activity ledger so the lead surfaces ahead of
    // the queue for qualification. No client message, no reel — a lead is not a contact.
    const { error } = await ctx.supabase.from("ai_isa_activities").insert({
      brokerage_id: ctx.brokerageId,
      lead_id: leadId,
      activity_type: "seller_intent_prioritized",
      summary: `Listing Inventory Radar: seller-intent ${(intentScore * 100).toFixed(0)}/100${propertyAddress ? ` (${propertyAddress})` : ""} — prioritized for qualification.`,
      qualifying_response: { source: "listing_inventory_radar", intent_score: intentScore, reasons, property_address: propertyAddress },
      created_at: new Date().toISOString(),
    })
    if (error) return null
    // Bump last_activity_at so the ISA workspace queue (ordered by it) floats this lead up.
    await ctx.supabase.from("leads")
      .update({ last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", leadId).eq("brokerage_id", ctx.brokerageId)

    const actions = [`prioritized ISA-owned lead ${leadId} for seller-intent qualification (${(intentScore * 100).toFixed(0)}/100)`]

    // ── NURTURE OUTREACH (additive, GATED, VERIFICATION-conditioned) ──
    // The lead is not a contact (no portal). The conversion push lead→contact goes
    // out on the LEAD's verified channels only: a Director "thinking of selling?"
    // reel EMAILED when leads.email_verified, a POSTCARD when
    // leads.mailing_address_verified. Each channel is independent + idempotent per
    // (lead, channel); a false/missing flag → that channel is skipped honestly.
    // NOTHING auto-sends — each channel proposes a GATED deliverable a human approves.
    // Requires a real agent on the brokerage (ai_video_projects.agent_id FK → users.id
    // + qr_codes.agent_id); honest skip when absent.
    try {
      const { data: agentRow } = await ctx.supabase
        .from("agents").select("user_id")
        .eq("brokerage_id", ctx.brokerageId).not("user_id", "is", null)
        .limit(1).maybeSingle()
      const agentUserId = (agentRow as { user_id?: string } | null)?.user_id ?? null
      if (agentUserId) {
        const { proposeLeadNurture } = await import("@/lib/ai-isa/lead-nurture")
        const nurture = await proposeLeadNurture(
          { brokerageId: ctx.brokerageId, leadId, agentUserId, intentScore, propertyAddress },
          ctx.supabase,
        )
        if (nurture.actions.length > 0) actions.push(...nurture.actions)
        else if (!nurture.channels.email && !nurture.channels.postcard) {
          actions.push("no verified channel (email/mailing address) — prioritized only, no outreach proposed")
        }
      } else {
        actions.push("no agent on the brokerage — prioritized only (reel/QR need a real agent)")
      }
    } catch (e) {
      console.error("[ai_isa:seller_intent_hot] lead-nurture skipped:", (e as Error).message)
    }

    return `${actions.join("; ")} (not a contact — EMAIL + DIRECT MAIL only, no portal card)`
  },
  // LISTING INVENTORY RADAR — Data Steward → Listing Concierge: a seller candidate that has
  // ALREADY converted to a CRM contact (portal-eligible, post-qualification) scored HOT. ONLY
  // a contact-backed candidate reaches this handler (the runner routes non-contacts to ai_isa).
  // The Listing Concierge turns it into GATED seller deliverables: (1) a "thinking of selling?"
  // brief into the approval gate (audience 'agent'); (2) when a real agent exists, a gated CMA
  // flag + a Director-commissioned listing/explainer reel. Nothing auto-sends; each enrichment
  // honestly skips when its prerequisite (agent / key) is absent. A non-contact NEVER lands here.
  "listing_concierge:seller_intent_hot": async (signal, ctx) => {
    if (!signal.entityId) return null
    const p = (signal.payload ?? {}) as Record<string, unknown>
    const intentScore = typeof p.intent_score === "number" ? p.intent_score : 0
    const propertyAddress = (p.property_address as string | undefined) ?? null
    const reasons = Array.isArray(p.reasons) ? (p.reasons as string[]) : []
    const contactBacked = p.contact_backed === true && !!signal.contactId

    // GUARD: this is the contact-backed seller path ONLY. A raw scraped lead that is not yet
    // a CRM contact must never receive a client-facing seller deliverable — it routes to
    // ai_isa instead. Refuse to act on a non-contact (defends the gate even if mis-routed).
    if (!contactBacked) return null

    const actions: string[] = []

    // (1) GATED "thinking of selling?" prospecting brief — audience 'agent'.
    const { composeProspectingBriefFallback } = await import("@/lib/kernel/listing-inventory-radar")
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const briefBody = composeProspectingBriefFallback({
      rawLeadId: signal.entityId,
      signals: { source: (p.source as string) ?? "" },
      propertyAddress,
      intentScore,
      reasons,
    } as any)
    const brief = await proposeClientMessage({
      brokerageId: ctx.brokerageId,
      agentKind: "listing_concierge",
      entityType: "raw_scraped_lead",
      entityId: signal.entityId,
      recipientContactId: signal.contactId, // contact-backed only
      audience: "agent",
      subject: `Seller-intent radar: ${propertyAddress ?? "a high-intent listing candidate"}`,
      body: briefBody,
      rationale: `LISTING INVENTORY RADAR — seller candidate (CRM contact) scored ${(intentScore * 100).toFixed(0)}/100 intent; "thinking of selling?" play proposed (gated, agent audience; owner is a CRM contact, consent respected).`,
      channel: "portal",
    }, ctx.supabase)
    if (!brief.ok) return null
    actions.push(`proposed gated 'thinking of selling?' brief (gate message ${brief.id})`)

    // The optional enrichments require a REAL agent on this brokerage (users.id for the
    // video FK + agents.id for the CMA). Resolve once; honest skip when absent.
    if (signal.contactId) {
      const { data: agentRow } = await ctx.supabase
        .from("agents")
        .select("id, user_id")
        .eq("brokerage_id", ctx.brokerageId)
        .not("user_id", "is", null)
        .limit(1)
        .maybeSingle()
      const agentId = (agentRow as { id?: string } | null)?.id ?? null
      const agentUserId = (agentRow as { user_id?: string } | null)?.user_id ?? null

      // (3) DIRECTOR-COMMISSIONED 'thinking of selling?' reel — GATED (pending_review),
      //     keyed on the contact so it's idempotent and never auto-publishes.
      if (agentUserId) {
        try {
          const { commissionVideo } = await import("@/lib/video/video-director")
          const reel = await commissionVideo(
            { kind: "explainer", tier: "solo_agent", targetChannel: "email",
              facts: { topic: "thinking of selling?", property_address: propertyAddress ?? undefined } },
            { brokerageId: ctx.brokerageId, agentUserId, contactId: signal.contactId,
              title: `Thinking of selling? — ${propertyAddress ?? "your home"}` },
            ctx.supabase as any,
          )
          if (reel.ok && (reel.status === "staged" || reel.status === "already_staged")) {
            actions.push(`commissioned a gated 'thinking of selling?' reel (${reel.status})`)
          }
        } catch (e) {
          console.error("[seller_intent_hot] reel commission skipped:", (e as Error).message)
        }
      }

      // (2) Note the gated CMA availability to the agent. We do NOT auto-generate the CMA
      //     here (generateAICMA is an authenticated agent action requiring property facts
      //     the scrape row may not carry) — we surface it as the next gated step in the
      //     brief's rationale. The agent triggers it from the contact with one tap. This
      //     keeps the play honest: no fabricated property specs feeding a valuation.
      actions.push(agentId ? "flagged a gated CMA as the next step (agent-triggered)" : "no agent for CMA — brief only")
    }

    return actions.join("; ")
  },
  // Showing-feedback router → Listing Concierge: the week's buyer-showing feedback on an in-house
  // listing pointed at a PLAY (price pressure / strong interest / presentation). The concierge ACTS:
  // it proposes a GATED seller recommendation (never auto-sent) so the feedback drives the team, not
  // a task that rots in a list. Manager-orchestrated, not linear.
  "listing_concierge:showing_feedback_routed": async (signal, ctx) => {
    if (!signal.contactId) return null // need the seller contact to address the recommendation
    const p = (signal.payload ?? {}) as Record<string, unknown>
    const play = (p.play as string | undefined) ?? null
    const points = Array.isArray(p.coachingPoints) ? (p.coachingPoints as string[]).slice(0, 4) : []
    const addr = (p.property_address as string | undefined) ?? "your home"
    if (!play) return null

    const copy: Record<string, { subject: string; body: string }> = {
      price_pressure: {
        subject: "What this week's showings are telling us",
        body: `I've been reading the feedback from this week's showings on ${addr}, and a pattern is emerging around price. ${points.length ? `Buyers keep mentioning: ${points.join("; ")}. ` : ""}I'd like to walk you through the numbers and a strategic adjustment that gets us in front of the right buyers — do you have a few minutes this week?`,
      },
      strong_interest: {
        subject: "Strong interest on your home this week",
        body: `Good news — the showings on ${addr} are drawing real interest. ${points.length ? `Buyers are responding to: ${points.join("; ")}. ` : ""}While the attention is hot, let's talk about the best way to turn it into offers — whether that's inviting them in or holding firm. When can we connect?`,
      },
      presentation_coaching: {
        subject: "A couple of quick wins before the next showings",
        body: `The feedback on ${addr} is close — a few small presentation tweaks could tip the next buyers over. ${points.length ? `What's coming up: ${points.join("; ")}. ` : ""}These are quick, low-cost fixes. Want me to put together a short prep list?`,
      },
    }
    const msg = copy[play]
    if (!msg) return null

    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: ctx.brokerageId, agentKind: "listing_concierge", entityType: "listing",
      entityId: signal.entityId, recipientContactId: signal.contactId, audience: "seller",
      subject: msg.subject, body: msg.body,
      rationale: `SHOWING-FEEDBACK ROUTING — the week's buyer feedback routed the "${play}" play; gated seller recommendation proposed (manager-orchestrated, not a passive task).`,
      channel: "portal",
    }, ctx.supabase)
    return res.ok ? `proposed a gated "${play}" seller recommendation (message ${res.id})` : null
  },
  // Stall predictor → Listing Concierge: a listing is heading for a stall (DOM past the area's pace,
  // showings drying up, no offers) BEFORE it expires. The concierge gets ahead of it with a GATED
  // seller recommendation — a marketing refresh while there's still time, or an early price
  // conversation. Catching it early is the whole point (relist_recovery is the after-the-fact net).
  "listing_concierge:listing_stall_predicted": async (signal, ctx) => {
    if (!signal.contactId) return null
    const p = (signal.payload ?? {}) as Record<string, unknown>
    const play = (p.play as string | undefined) ?? null
    const reasons = Array.isArray(p.reasons) ? (p.reasons as string[]).slice(0, 3) : []
    const addr = (p.property_address as string | undefined) ?? "your home"
    if (!play || play === "hold") return null

    const copy: Record<string, { subject: string; body: string }> = {
      marketing_refresh: {
        subject: "Let's get fresh eyes on your home",
        body: `I'm watching the activity on ${addr} closely and want to get ahead of something before it becomes an issue. ${reasons.length ? `What I'm seeing: ${reasons.join("; ")}. ` : ""}I'd like to refresh the marketing — new photos in the feed, a fresh push to buyers, maybe a new reel — to put it back in front of the right people. Can I run that for you this week?`,
      },
      price_strategy: {
        subject: "A quick strategy check on your listing",
        body: `I want to get ahead of the numbers on ${addr} before it sits too long. ${reasons.length ? `What I'm seeing: ${reasons.join("; ")}. ` : ""}Homes that linger get stale in buyers' minds, so I'd rather make a smart, proactive move now than react later. Do you have a few minutes to talk strategy this week?`,
      },
    }
    const msg = copy[play]
    if (!msg) return null

    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: ctx.brokerageId, agentKind: "listing_concierge", entityType: "listing",
      entityId: signal.entityId, recipientContactId: signal.contactId, audience: "seller",
      subject: msg.subject, body: msg.body,
      rationale: `LISTING-STALL PREDICTOR — predicted a stall (${(p.risk as string) ?? "elevated"} risk) BEFORE expiry; gated "${play}" recommendation proposed so the team gets ahead of it (manager-orchestrated, early).`,
      channel: "portal",
    }, ctx.supabase)
    return res.ok ? `proposed a gated early "${play}" recommendation (message ${res.id})` : null
  },
  // Buyer-stall predictor → Shopping Agent: a buyer has toured a lot with no offer (fatigue /
  // expectations / drifting away). The Shopping Agent resets the conversation with a GATED buyer
  // message — recalibrate expectations, or re-energize with fresh matches. Never auto-sent.
  "shopping_agent:buyer_stall_predicted": async (signal, ctx) => {
    if (!signal.contactId) return null
    const p = (signal.payload ?? {}) as Record<string, unknown>
    const play = (p.play as string | undefined) ?? null
    const reasons = Array.isArray(p.reasons) ? (p.reasons as string[]).slice(0, 2) : []
    if (!play || play === "hold") return null

    const copy: Record<string, { subject: string; body: string }> = {
      recalibrate: {
        subject: "Let's find your home faster",
        body: `We've seen some great homes together, and I want to make sure we're zeroed in on the one that's truly right for you. ${reasons.length ? `I've noticed ${reasons.join("; ")}. ` : ""}Could we take 15 minutes to revisit your must-haves and the numbers? Sometimes a small adjustment to the target opens up exactly what you're looking for — and I'd rather get you there sooner than later.`,
      },
      re_energize: {
        subject: "A fresh look — new homes for you",
        body: `It's been a little while since we were out looking, and the inventory has shifted. ${reasons.length ? `${reasons.join("; ")}. ` : ""}I'd love to pull a fresh set of homes matched to what you described and get you back out there. Want me to put together a new short list this week?`,
      },
    }
    const msg = copy[play]
    if (!msg) return null

    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: ctx.brokerageId, agentKind: "shopping_agent", entityType: "contact",
      entityId: signal.contactId, recipientContactId: signal.contactId, audience: "buyer",
      subject: msg.subject, body: msg.body,
      rationale: `BUYER-STALL PREDICTOR — buyer touring without writing an offer; gated "${play}" reset proposed so the agent gets ahead of fatigue/drift (manager-orchestrated).`,
      channel: "portal",
    }, ctx.supabase)
    return res.ok ? `proposed a gated buyer "${play}" reset (message ${res.id})` : null
  },
  // Loan-milestone sync → Deal Coordinator: a financing milestone landed. Keep the buyer + agent on
  // the same page — propose a GATED buyer update (when the milestone is buyer-appropriate) and notify
  // the agent. A denial NEVER auto-messages the buyer (sensitive — the agent calls personally).
  "deal_coordinator:loan_milestone": async (signal, ctx) => {
    if (!signal.contactId) return null
    const p = (signal.payload ?? {}) as Record<string, unknown>
    const audience = (p.audience as string | undefined) ?? "agent"
    const buyerMessage = (p.buyerMessage as string | null | undefined) ?? null
    const agentNote = (p.agentNote as string | undefined) ?? null
    const milestone = (p.milestone as string | undefined) ?? "update"
    const actions: string[] = []

    // (1) Gated buyer update — only when the plan provides one (denials carry null).
    if ((audience === "buyer" || audience === "both") && buyerMessage) {
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId: ctx.brokerageId, agentKind: "deal_coordinator", entityType: "contact",
        entityId: signal.contactId, recipientContactId: signal.contactId, audience: "buyer",
        subject: "An update on your loan",
        body: buyerMessage,
        rationale: `LOAN-MILESTONE SYNC — "${milestone}" milestone; gated buyer update so they're never in the dark.`,
        channel: "portal",
      }, ctx.supabase)
      if (res.ok) actions.push(`proposed a gated buyer loan update (message ${res.id})`)
    }

    // (2) Notify the agent (the prompt to act / the sensitive-call flag).
    if (agentNote) {
      const agentUserId = await resolveLoanAgentUser(ctx.supabase, signal.contactId)
      if (agentUserId) {
        const { error } = await ctx.supabase.from("notifications").insert({
          user_id: agentUserId, brokerage_id: ctx.brokerageId,
          title: `Loan update: ${milestone.replace(/_/g, " ")}`, body: agentNote,
          type: "loan_milestone", entity_type: "contact", entity_id: signal.contactId,
          priority: milestone === "denied" || milestone === "delay" ? "high" : "medium", is_read: false,
        })
        if (!error) actions.push("notified the agent")
      }
    }
    return actions.length ? actions.join("; ") : null
  },
  // Inbound seller intent → Listing Concierge: a homeowner asked "what's my home worth" (a home-value
  // tool / valuation magnet) — the strongest INBOUND seller signal. The concierge responds like a
  // human listing lead: a GATED follow-up offering a precise CMA beyond the instant estimate. Never
  // auto-sent. (Distinct from the outbound scraped seller_intent_hot, which is raw-lead-shaped.)
  "listing_concierge:home_value_seller_intent": async (signal, ctx) => {
    if (!signal.contactId) return null
    const p = (signal.payload ?? {}) as Record<string, unknown>
    const addr = (p.property_address as string | undefined) ?? "your home"
    const est = typeof p.estimated_value === "number" ? p.estimated_value : null
    const estLine = est ? ` The instant tool put it around $${Math.round(est).toLocaleString()}, but` : " The instant estimate is a starting point —"

    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: ctx.brokerageId, agentKind: "listing_concierge", entityType: "contact",
      entityId: signal.contactId, recipientContactId: signal.contactId, audience: "seller",
      subject: `A precise value for ${addr}`,
      body: `Thanks for checking your home's value!${estLine} an automated number can't see what makes ${addr} special — recent upgrades, the exact block, how it shows. I'd be glad to put together a precise, no-obligation comparative market analysis (CMA) with real local comps so you have an accurate number whether you're just curious or starting to think about a move. Want me to prepare it?`,
      rationale: `INBOUND SELLER INTENT (${(p.intent_strength as string) ?? "warm"}) — homeowner requested a home value; gated CMA-offer follow-up proposed so the team responds like a listing lead (manager-orchestrated, not a lead left in the inbox).`,
      channel: "portal",
    }, ctx.supabase)
    return res.ok ? `proposed a gated CMA-offer follow-up to the homeowner (message ${res.id})` : null
  },
  // autopsy has already classified the failure reason and proposed a gated coaching
  // brief (proposeClientMessage). The Recruiting Manager's handler here surfaces a
  // NOTIFICATION to the broker/team-lead so the coaching prompt is never invisible —
  // it reaches both the gated message inbox AND the notifications rail. The agent
  // development charter (recruiter_agent_mgmt) already owns this notification pattern.
  "recruiting_manager:deal_autopsy_completed": async (signal, ctx) => {
    const p = (signal.payload ?? {}) as Record<string, unknown>
    const reason = (p.failure_reason as string | undefined) ?? "other"
    const agentId = (p.agent_id as string | undefined) ?? null
    const confidence = typeof p.confidence === "number" ? p.confidence : 0
    const purchasePrice = typeof p.purchase_price === "number" ? p.purchase_price : null
    const daysUnder = typeof p.days_under_contract === "number" ? p.days_under_contract : null

    const priceStr = purchasePrice ? `$${Math.round(purchasePrice).toLocaleString()}` : "unknown price"
    const daysStr = daysUnder != null ? `${daysUnder} days under contract` : ""
    const confStr = `${Math.round(confidence * 100)}% confidence`

    // Notify broker/admins so the coaching prompt reaches the people who develop agents.
    const { data: mgrs } = await ctx.supabase.from("users").select("id")
      .eq("brokerage_id", ctx.brokerageId).in("user_type", ["broker", "broker_admin", "admin"]).limit(10)
    let notified = 0
    for (const m of (mgrs ?? []) as Array<{ id: string }>) {
      const { error } = await ctx.supabase.from("notifications").insert({
        user_id: m.id, brokerage_id: ctx.brokerageId, type: "deal_autopsy",
        title: `Deal autopsy: ${reason.replace(/_/g, " ")} — ${priceStr}`,
        body: `A ${priceStr} deal fell through (${reason.replace(/_/g, " ")}, ${confStr}${daysStr ? `, ${daysStr}` : ""}). A coaching brief has been proposed for review. ${signal.message}`,
        entity_type: "transaction", entity_id: signal.entityId,
        priority: "medium", is_read: false,
      })
      if (!error) notified += 1
    }
    // If the failing agent exists, notify them as well so they see the coaching ping.
    if (agentId) {
      await ctx.supabase.from("notifications").insert({
        user_id: agentId, brokerage_id: ctx.brokerageId, type: "deal_autopsy",
        title: `Deal autopsy ready — ${reason.replace(/_/g, " ")}`,
        body: `Your ${priceStr} deal was autopsied (${reason.replace(/_/g, " ")}, ${confStr}). Your manager has a coaching brief queued. Check in this week.`,
        entity_type: "transaction", entity_id: signal.entityId, priority: "low", is_read: false,
      }).then()
    }
    return notified > 0
      ? `deal-autopsy coaching prompt surfaced to ${notified} broker/admin${notified === 1 ? "" : "s"}${agentId ? " + agent notified" : ""}`
      : "no broker/admin to surface deal-autopsy coaching prompt to"
  },
  // Data Steward → Sphere: the consent-recovery chain exhausted every step (no fallback
  // channel, enrichment re-run found nothing). The Sphere releases the relationship
  // RESPECTFULLY: nurture_status='withdrawn' (history kept, never a delete), agent told.
  // entity_id carries the contact (contact_id stays null so Team Plays never folds a
  // withdraw into a client-facing play).
  "sphere_of_influence:contact_withdrawn": async (signal, ctx) => {
    if (!signal.entityId) return null
    const { data: updated } = await ctx.supabase.from("contacts")
      .update({ nurture_status: "withdrawn" })
      .eq("id", signal.entityId).eq("brokerage_id", ctx.brokerageId)
      .select("id, first_name, last_name").maybeSingle()
    if (!updated) return null
    const { resolveResponsibleAgentUserId } = await import("@/lib/intelligence/mobile-approval-queue")
    const agentUserId = await resolveResponsibleAgentUserId(ctx.supabase, {
      recipient_contact_id: signal.entityId, entity_type: "contact", entity_id: signal.entityId,
    })
    if (agentUserId) {
      const name = [(updated as any).first_name, (updated as any).last_name].filter(Boolean).join(" ").trim() || "A contact"
      await ctx.supabase.from("notifications").insert({
        user_id: agentUserId, brokerage_id: ctx.brokerageId, type: "consent_withdrawn",
        title: `${name} released — every channel revoked`,
        body: `${name} revoked every channel and the enrichment re-run found no new contact info. The relationship is marked withdrawn — history kept, nothing further will be proposed. If they ever reach out, the chain reopens automatically.`,
        entity_type: "contact", entity_id: signal.entityId, priority: "medium", is_read: false,
      })
    }
    return "relationship marked withdrawn (nurture_status) + agent informed — history preserved"
  },
}

/**
 * The addressed manager reads its open inbox and acts. Each handled signal is marked
 * consumed WITH the action taken. Signals with no registered handler stay open (a human
 * sees them on the Command Center feed). Returns counts.
 */
export async function consumeManagerSignals(
  params: { brokerageId: string; toManager: ManagerKey; limit?: number },
  client?: Svc,
): Promise<{ consumed: number; skipped: number }> {
  const supabase = client ?? createServiceClient()
  const { data } = await supabase
    .from("manager_signals")
    .select("id, from_manager, to_manager, signal_type, message, entity_type, entity_id, contact_id, payload, status, created_at")
    .eq("brokerage_id", params.brokerageId).eq("to_manager", params.toManager).eq("status", "open")
    .order("created_at", { ascending: true }).limit(params.limit ?? 50)

  let consumed = 0, skipped = 0
  for (const row of (data ?? []) as any[]) {
    const signal: ManagerSignal = {
      id: row.id, fromManager: row.from_manager, toManager: row.to_manager,
      signalType: row.signal_type, message: row.message, entityType: row.entity_type,
      entityId: row.entity_id, contactId: row.contact_id, payload: row.payload ?? {},
      status: row.status, createdAt: row.created_at,
    }
    const handler = SIGNAL_HANDLERS[`${signal.toManager}:${signal.signalType}`]
    if (!handler) { skipped += 1; continue }
    let action: string | null = null
    try { action = await handler(signal, { brokerageId: params.brokerageId, supabase }) }
    catch (e) { console.error(`[manager-signals] handler failed for ${signal.id}:`, e); skipped += 1; continue }
    if (!action) { skipped += 1; continue }
    await supabase.from("manager_signals")
      .update({ status: "consumed", consumed_at: new Date().toISOString(), consumed_action: action })
      .eq("id", signal.id).eq("status", "open")
    consumed += 1
  }
  return { consumed, skipped }
}

export interface ManagerTalkLine {
  id: string
  /** Registry keys so the UI resolves accent/domain from MANAGERS (no drift). */
  fromKey: string
  toKey: string
  fromLabel: string
  toLabel: string
  message: string
  status: string
  consumedAction: string | null
  createdAt: string
  /** Coordination kind (deferral / handoff / escalation / alert / update) so the feed renders the
   *  negotiation, not a flat log. */
  kind: import("./coordination-kind").CoordinationKind
}

/** The Command Center's "managers talking" feed — recent inter-manager conversation. */
export async function loadRecentManagerTalk(
  brokerageId: string, limit = 20, client?: Svc,
): Promise<ManagerTalkLine[]> {
  const supabase = client ?? createServiceClient()
  const { classifyCoordination } = await import("./coordination-kind")
  const { data } = await supabase
    .from("manager_signals")
    .select("id, from_manager, to_manager, signal_type, message, status, consumed_action, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false }).limit(limit)
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    fromKey: r.from_manager,
    toKey: r.to_manager,
    fromLabel: (r.from_manager in MANAGERS ? MANAGERS[r.from_manager as ManagerKey].label : r.from_manager),
    toLabel: (r.to_manager in MANAGERS ? MANAGERS[r.to_manager as ManagerKey].label : r.to_manager),
    message: r.message,
    status: r.status,
    consumedAction: r.consumed_action ?? null,
    createdAt: r.created_at,
    kind: classifyCoordination(r.signal_type),
  }))
}
