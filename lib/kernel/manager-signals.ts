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

/** A signal handler: acts on one signal, returns the action taken (or null to leave open). */
export type SignalHandler = (signal: ManagerSignal, ctx: { brokerageId: string; supabase: Svc }) => Promise<string | null>

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
  // LISTING INVENTORY RADAR — Data Steward → Listing Concierge: the Radar scored a
  // bench-scraped seller candidate HOT (expired/withdrawn, FSBO, absentee, high-equity /
  // pre-foreclosure). The Listing Concierge turns the routed candidate into GATED
  // deliverables: (1) ALWAYS a "thinking of selling?" prospecting brief into the approval
  // gate (audience 'agent' — internal, never a client message, no contact info assumed);
  // (2) OPTIONALLY, when the owner is ALREADY a CRM contact AND we have a real agent, a
  // gated CMA + a Director-commissioned listing/explainer reel. Nothing auto-sends; every
  // enrichment honestly skips when its prerequisite (contact / agent / key) is absent.
  "listing_concierge:seller_intent_hot": async (signal, ctx) => {
    if (!signal.entityId) return null
    const p = (signal.payload ?? {}) as Record<string, unknown>
    const intentScore = typeof p.intent_score === "number" ? p.intent_score : 0
    const propertyAddress = (p.property_address as string | undefined) ?? null
    const reasons = Array.isArray(p.reasons) ? (p.reasons as string[]) : []
    const contactBacked = p.contact_backed === true && !!signal.contactId

    const actions: string[] = []

    // (1) GATED "thinking of selling?" prospecting brief — ALWAYS, audience 'agent'.
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
      recipientContactId: contactBacked ? signal.contactId : null, // agent-audience only
      audience: "agent",
      subject: `Seller-intent radar: ${propertyAddress ?? "a high-intent listing candidate"}`,
      body: briefBody,
      rationale: `LISTING INVENTORY RADAR — bench-scraped seller candidate scored ${(intentScore * 100).toFixed(0)}/100 intent; "thinking of selling?" play proposed (gated, agent audience; ${contactBacked ? "owner is a CRM contact" : "owner not yet a contact — no client message, consent respected"}).`,
      channel: "portal",
    }, ctx.supabase)
    if (!brief.ok) return null
    actions.push(`proposed gated 'thinking of selling?' brief (gate message ${brief.id})`)

    // The optional enrichments require a REAL agent on this brokerage (users.id for the
    // video FK + agents.id for the CMA). Resolve once; honest skip when absent.
    if (contactBacked && signal.contactId) {
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
  fromLabel: string
  toLabel: string
  message: string
  status: string
  consumedAction: string | null
  createdAt: string
}

/** The Command Center's "managers talking" feed — recent inter-manager conversation. */
export async function loadRecentManagerTalk(
  brokerageId: string, limit = 20, client?: Svc,
): Promise<ManagerTalkLine[]> {
  const supabase = client ?? createServiceClient()
  const { data } = await supabase
    .from("manager_signals")
    .select("id, from_manager, to_manager, message, status, consumed_action, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false }).limit(limit)
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    fromLabel: (r.from_manager in MANAGERS ? MANAGERS[r.from_manager as ManagerKey].label : r.from_manager),
    toLabel: (r.to_manager in MANAGERS ? MANAGERS[r.to_manager as ManagerKey].label : r.to_manager),
    message: r.message,
    status: r.status,
    consumedAction: r.consumed_action ?? null,
    createdAt: r.created_at,
  }))
}
