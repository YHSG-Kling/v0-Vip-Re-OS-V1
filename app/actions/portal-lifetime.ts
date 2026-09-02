"use server"

import { createClient } from "@/lib/supabase/server"
import { bestEffort } from "@/lib/db/best-effort"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { resolveContactOwnerAgent } from "@/lib/identity/resolve-contact-owner"
import { validateTestimonialSubmission, type TestimonialKind } from "@/lib/testimonials/testimonial-policy"
import { isNextMoveIntent, nextStepForIntent, type NextMoveIntent } from "@/lib/portal/next-move"
import {
  validateHomeQuestion,
  buildHomeAssistantSystemPrompt,
  fallbackHomeAnswer,
  type HomeFacts,
} from "@/lib/portal/home-assistant"
import { computeHomeWealthStory } from "@/lib/portal/home-wealth"
import { normalizeLifetimeSegment, type LifetimeSegment } from "@/lib/portal/lifetime-segment"

// ─── Auth helper ──────────────────────────────────────────────────────────────
// Previously this file was missing "use server" yet was imported from
// client components (referral forms, etc.) — so it was both a build-
// inconsistency AND every function ran without auth, trusting a caller-
// supplied contactId to scope everything. Any signed-in (or unauth'd
// during server render) caller could enumerate any contact's referrals,
// transaction history, home value estimates, brokerage vendor list, and
// even SUBMIT referrals attributed to another tenant's contact.
//
// requireContactAccess() allows the contact themselves (portal session)
// or any agent/admin in the contact's brokerage.
async function requireContactAccess(contactId: string): Promise<
  | { ok: true; userId: string; brokerageId: string; isContactSelf: boolean }
  | { ok: false }
> {
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { ok: false }

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("brokerage_id, contact_user_id, email")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact || !contact.brokerage_id) return { ok: false }

  const isContactSelf =
    contact.contact_user_id === authUser.id ||
    !!(contact.email && authUser.email && contact.email.toLowerCase() === authUser.email.toLowerCase())

  if (isContactSelf) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: true }
  }

  const { data: callerRow } = await svc
    .from("users").select("brokerage_id, user_type").eq("id", authUser.id).maybeSingle()
  // SCOPE LADDER (staff roster): 'superadmin' removed — dead as users.user_type
  // (0 live rows); broker_owner added — storable same-tenant seat that owns the brokerage.
  if (callerRow?.brokerage_id === contact.brokerage_id && ["agent","team_lead","tc","admin","broker","broker_owner"].includes(((callerRow as any)?.user_type) ?? "")) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: false }
  }

  return { ok: false }
}

// ─── SUBMIT CLIENT TESTIMONIAL (text or video) ───────────────────────────────
// The newly-closed / lifetime client leaves a testimonial IN THE PORTAL — a few words OR a short video —
// that the agent can use in marketing. Captured to agent_reviews with is_published=false (the agent
// approves before using). The agent is notified; a VIDEO testimonial is also handed to the Asset Manager
// to become a Director marketing reel (Sphere → Asset Manager). Scoped to the contact themselves.
export async function submitClientTestimonial(params: {
  contactId: string
  kind: TestimonialKind
  body?: string | null
  videoUrl?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok || !access.isContactSelf) return { ok: false, error: "Not allowed" }

  const valid = validateTestimonialSubmission({ kind: params.kind, body: params.body, videoUrl: params.videoUrl })
  if (!valid.ok) return { ok: false, error: valid.reason }

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts").select("first_name, last_name, agent_id").eq("id", params.contactId).maybeSingle()
  if (!contact) return { ok: false, error: "Contact not found" }

  const reviewerName = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || "A client"
  // Most-recent closed transaction (attribution; best-effort).
  const { data: txn } = await svc
    .from("transactions").select("id")
    .eq("contact_id", params.contactId).eq("brokerage_id", access.brokerageId).eq("status", "closed")
    .order("close_date", { ascending: false }).limit(1).maybeSingle()

  const { error: insErr } = await svc.from("agent_reviews").insert({
    brokerage_id:   access.brokerageId,
    agent_id:       contact.agent_id ?? null,
    contact_id:     params.contactId,
    transaction_id: (txn as { id?: string } | null)?.id ?? null,
    reviewer_name:  reviewerName,
    kind:           params.kind,
    review_text:    params.kind === "text" ? (valid.cleanBody ?? null) : null,
    video_url:      params.kind === "video" ? ((params.videoUrl ?? "").trim() || null) : null,
    // 'internal' = captured in-app (not a public Google/Zillow review); kind distinguishes text vs video.
    platform:       "internal",
    is_published:   false, // the agent approves before using it in marketing
  })
  if (insErr) return { ok: false, error: insErr.message }

  // Surface to the agent so they can approve + use it.
  try {
    const agent = contact.agent_id ? await resolveContactOwnerAgent(svc, contact.agent_id) : null
    const agentUserId = (agent as { user_id?: string | null; id?: string | null } | null)?.user_id
      ?? (agent as { id?: string | null } | null)?.id ?? null
    if (agentUserId) {
      await svc.from("notifications").insert({
        user_id: agentUserId, brokerage_id: access.brokerageId, type: "client_testimonial_received",
        title: params.kind === "video" ? "🎥 A client left you a video testimonial" : "⭐ A client left you a testimonial",
        body: `${reviewerName} shared a ${params.kind} testimonial from their portal. Review and approve it to use in your marketing${params.kind === "video" ? " — your Asset Manager is turning it into a reel." : "."}`,
        // priority CHECK: low|medium|high|critical ('normal' is rejected → silent drop)
        entity_type: "contact", entity_id: params.contactId, priority: "medium", is_read: false,
      }).then(() => {}, () => {})
    }
    // MULTI-MANAGER: a VIDEO testimonial is gold — the Sphere of Influence HANDS it to the Asset Manager
    // (video director) to commission a gated social-proof reel from the clip (Sphere decides → Asset
    // creates → on completion Campaign Orchestrator distributes). Idempotent per contact.
    if (params.kind === "video") {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      await publishManagerSignal({
        brokerageId: access.brokerageId, fromManager: "sphere_of_influence", toManager: "asset_manager",
        signalType: "testimonial_reel_handoff", entityType: "contact", entityId: params.contactId,
        contactId: params.contactId,
        message: `${reviewerName} left a VIDEO testimonial — commission a gated social-proof reel from it.`,
        payload: { video_url: (params.videoUrl ?? "").trim(), reviewer_name: reviewerName },
      }, svc).then(() => {}, () => {})
    }
  } catch { /* notification + handoff are best-effort — never block the testimonial capture */ }

  return { ok: true }
}

// ─── SUBMIT "YOUR NEXT MOVE" INTENT ──────────────────────────────────────────
// The client TAPS a self-directed next-move option in their lifetime portal
// (move up / right-size / invest / refinance / improve / explore). A client-
// INITIATED re-transaction intent is the cleanest, most compliant lead signal
// there is — it loops the human agent in AND puts it on the manager bus: the AI
// ISA hands it to the Sphere Manager (lifetime owner), who delegates the right
// next step (buyer consult+CMA / finance review / vendor intro). No protected-
// class targeting — equity/tenure only, opt-in.
export async function submitNextMoveIntent(params: {
  contactId: string
  intent: NextMoveIntent
  note?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok || !access.isContactSelf) return { ok: false, error: "Not allowed" }
  if (!isNextMoveIntent(params.intent)) return { ok: false, error: "Unknown intent" }

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts").select("first_name, last_name, agent_id").eq("id", params.contactId).maybeSingle()
  if (!contact) return { ok: false, error: "Contact not found" }

  const clientName = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || "A client"
  const note = (params.note ?? "").toString().trim().slice(0, 500) || null
  const nextStep = nextStepForIntent(params.intent)

  // Surface to the agent (portal message + notification + kernel event) so a hot
  // re-transaction signal is never lost. agent_id can legitimately be null.
  try {
    if (contact.agent_id) {
      await svc.from("client_portal_messages").insert({
        contact_id: params.contactId,
        agent_id: contact.agent_id,
        brokerage_id: access.brokerageId,
        direction: "client_to_agent",
        channel: "portal",
        read: false,
        body: `Next-move intent: ${params.intent.replace(/_/g, " ")}${note ? ` — "${note}"` : ""}`,
      }).then(() => {}, () => {})

      const agent = await resolveContactOwnerAgent(svc, contact.agent_id)
      const agentUserId = (agent as { user_id?: string | null; id?: string | null } | null)?.user_id
        ?? (agent as { id?: string | null } | null)?.id ?? null
      if (agentUserId) {
        await svc.from("notifications").insert({
          user_id: agentUserId, brokerage_id: access.brokerageId, type: "next_move_intent",
          title: "🏡 A past client is thinking about their next move",
          body: `${clientName} tapped "${params.intent.replace(/_/g, " ")}" in their portal. Proposed next step: ${nextStep}.`,
          entity_type: "contact", entity_id: params.contactId, priority: "high", is_read: false,
        }).then(() => {}, () => {})
      }

      await svc.from("lifecycle_events").insert({
        brokerage_id: access.brokerageId,
        event_type: KernelEvent.MESSAGE_FROM_CONTACT,
        entity_type: "contact",
        entity_id: params.contactId,
        actor_user_id: contact.agent_id,
        metadata: { contact_id: params.contactId, agent_id: contact.agent_id, type: "next_move_intent", intent: params.intent, note },
      }).then(() => {}, () => {})
    }

    // MULTI-MANAGER: AI ISA (hears the client) hands the intent to the Sphere
    // Manager (lifetime relationship owner), who delegates the concrete next step.
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    await publishManagerSignal({
      brokerageId: access.brokerageId, fromManager: "ai_isa", toManager: "sphere_of_influence",
      signalType: "next_move_intent", entityType: "contact", entityId: params.contactId,
      contactId: params.contactId,
      message: `${clientName} signaled a "${params.intent.replace(/_/g, " ")}" next-move intent — delegate: ${nextStep}.`,
      payload: { intent: params.intent, note, next_step: nextStep },
    }, svc).then(() => {}, () => {})
  } catch { /* notification + handoff are best-effort — never block intent capture */ }

  return { ok: true }
}

// ─── ASK YOUR HOME ANYTHING ──────────────────────────────────────────────────
// A home assistant scoped to THE CLIENT'S OWN home. Routes through the compliance-
// railed AI gateway (generateTextRouted, feature 'home_assistant_qa') with a hard
// system prompt: stay scoped, no legal/tax/lending/appraisal advice, no value
// guarantees/forecasts, no fair-housing steering, redirect to the agent when a
// human is the right next step. Deterministic fallback floor when the gateway is
// down — the client never sees an error. No persistence (self-serve, no noise);
// AI usage is metered by the gateway.
export async function askHomeAssistant(params: {
  contactId: string
  question: string
}): Promise<{ ok: boolean; answer?: string; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok || !access.isContactSelf) return { ok: false, error: "Not allowed" }

  const valid = validateHomeQuestion(params.question)
  if (!valid.ok) return { ok: false, error: valid.reason }
  const question = valid.clean ?? ""

  // Reuse the same context the portal renders from (it re-checks access).
  const ctx = await getLifetimeContext(params.contactId)
  if (!ctx) return { ok: false, error: "Could not load your home." }

  const wealth = computeHomeWealthStory({
    purchasePrice: ctx.transaction?.sale_price ?? null,
    closeDate: ctx.transaction?.close_date ?? null,
    estimatedValueMid: ctx.homeValueEstimate?.estimated_value_mid,
    estimatedValueLow: ctx.homeValueEstimate?.estimated_value_low,
    estimatedValueHigh: ctx.homeValueEstimate?.estimated_value_high,
    latestGeneratedAt: ctx.homeValueEstimate?.generated_at,
    series: ctx.homeValueSeries,
  })

  const facts: HomeFacts = {
    firstName: ctx.contact?.first_name ?? null,
    agentName: (ctx.agent as { full_name?: string | null } | null)?.full_name ?? null,
    propertyAddress: ctx.transaction?.property_address ?? null,
    purchasePrice: ctx.transaction?.sale_price ?? null,
    closeDate: ctx.transaction?.close_date ?? null,
    currentValue: ctx.homeValueEstimate?.estimated_value_mid ?? null,
    estimatedEquity: wealth.hasEstimate ? wealth.estimatedEquity : null,
    gainPercent: wealth.hasEstimate ? wealth.gainPercent : null,
    marketTrend: ctx.homeValueEstimate?.market_trend ?? null,
    neighborhoodActivityCount: ctx.neighborhoodListings?.length ?? 0,
    vendorCategories: (ctx.preferredVendors ?? [])
      .map((v: { category?: string | null }) => v.category)
      .filter((c): c is string => !!c),
  }

  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { text } = await generateTextRouted({
      feature: "home_assistant_qa",
      system: buildHomeAssistantSystemPrompt(facts),
      prompt: question,
      maxTokens: 400,
      temperature: 0.3,
      brokerageId: access.brokerageId,
      userId: access.userId,
      agentId: ctx.contact?.agent_id ?? undefined,
    })
    const answer = (text ?? "").trim()
    // Empty / gateway-unconfigured → deterministic floor, never an error to the client.
    return { ok: true, answer: answer.length > 0 ? answer : fallbackHomeAnswer(facts) }
  } catch {
    return { ok: true, answer: fallbackHomeAnswer(facts) }
  }
}

// ─── REQUEST A VENDOR INTRO (maintenance card → marketplace) ─────────────────
// The homeowner taps a maintenance suggestion's "request an intro" — a concierge
// ask routed to their agent (portal message + notification). Light-touch by
// design (no cross-manager workflow): the agent personally connects them with a
// trusted local pro. category is a free-text vendor category; reason is the
// upkeep suggestion that prompted it.
export async function requestVendorIntro(params: {
  contactId: string
  category: string
  reason?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok || !access.isContactSelf) return { ok: false, error: "Not allowed" }

  const category = (params.category ?? "").toString().trim().slice(0, 60)
  if (!category) return { ok: false, error: "Missing category" }
  const reason = (params.reason ?? "").toString().trim().slice(0, 200) || null

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts").select("first_name, last_name, agent_id").eq("id", params.contactId).maybeSingle()
  if (!contact) return { ok: false, error: "Contact not found" }
  if (!contact.agent_id) return { ok: true } // no in-house agent to route to; silently succeed

  const clientName = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || "A client"
  const label = category.replace(/_/g, " ")

  try {
    await svc.from("client_portal_messages").insert({
      contact_id: params.contactId, agent_id: contact.agent_id, brokerage_id: access.brokerageId,
      direction: "client_to_agent", channel: "portal", read: false,
      body: `Vendor intro request: ${label}${reason ? ` — ${reason}` : ""}`,
    }).then(() => {}, () => {})

    const agent = await resolveContactOwnerAgent(svc, contact.agent_id)
    const agentUserId = (agent as { user_id?: string | null; id?: string | null } | null)?.user_id
      ?? (agent as { id?: string | null } | null)?.id ?? null
    if (agentUserId) {
      await svc.from("notifications").insert({
        user_id: agentUserId, brokerage_id: access.brokerageId, type: "vendor_intro_request",
        title: `🔧 ${clientName} wants a ${label} pro`,
        body: `${clientName} asked for an intro to a trusted ${label} provider${reason ? ` (${reason})` : ""}. A quick connection keeps you their go-to resource.`,
        entity_type: "contact", entity_id: params.contactId, priority: "medium", is_read: false,
      }).then(() => {}, () => {})
    }
  } catch { /* best-effort — never block the request */ }

  return { ok: true }
}

// ─── SET LIFETIME SEGMENT (staff only) ───────────────────────────────────────
// The agent/staff flags a past client as 'relocated' (left our market) or back to
// 'local_owner'. Neutral market fact only — the REASON (age/health/family) is
// never collected. Switching to 'relocated' moves them to the referral-out +
// stay-in-touch nurture lane (their portal stops showing equity/maintenance/
// next-move they can't use).
export async function setLifetimeSegment(params: {
  contactId: string
  segment: LifetimeSegment
}): Promise<{ ok: boolean; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  // Staff only — a client cannot reclassify their own market segment.
  if (!access.ok || access.isContactSelf) return { ok: false, error: "Not allowed" }

  const segment = normalizeLifetimeSegment(params.segment)
  const svc = createServiceClient()
  const { error } = await svc
    .from("contacts")
    .update({ lifetime_segment: segment })
    .eq("id", params.contactId)
    .eq("brokerage_id", access.brokerageId)
  if (error) return { ok: false, error: error.message }

  // When a client becomes 'relocated', generate their portal welcome ONCE through
  // the brand-voice gateway (NOT hardcoded) with a deterministic floor — and the
  // gateway's Fair-Housing redraft keeps it neutral (never references age/health/
  // why they moved). Stored on the contact so the portal reads it without an LLM
  // call per render. Best-effort: a failure just leaves the card's built-in floor.
  if (segment === "relocated") {
    try {
      const { data: c } = await svc.from("contacts")
        .select("first_name, agent_id, metadata").eq("id", params.contactId).maybeSingle()
      const agent = (c as { agent_id?: string | null } | null)?.agent_id
        ? await resolveContactOwnerAgent(svc, (c as { agent_id?: string | null }).agent_id!)
        : null
      const agentFirst = (agent as { full_name?: string | null } | null)?.full_name?.split(" ")[0] ?? null
      const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
      const welcome = await generateClientMessage({
        brokerageId: access.brokerageId,
        audience: "seller",
        purpose:
          "Warmly reassure a PAST CLIENT who has moved out of our market that we're still their resource from afar. Make two offers, gently and with no pressure: (1) we'll personally connect them with a trusted, hand-picked agent in their NEW area, and (2) we'd be honored to help anyone they refer who's still local. Keep it short and human. NEVER mention or imply age, health, family status, retirement, or the reason they moved.",
        recipientFirstName: (c as { first_name?: string | null } | null)?.first_name ?? null,
        allowNumbers: false,
        fallback: {
          subject: "Wherever you are, you're still family",
          body: `${agentFirst ? `${agentFirst} is` : "We're"} still here for you, even from a distance. If you're moving somewhere new, we'll connect you with a top agent in your new area — hand-picked, no cold searching. And if you know someone buying or selling back here, we'd be honored to take great care of them.`,
        },
      })
      const meta = ((c as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>
      await bestEffort(
        svc.from("contacts").update({
          metadata: { ...meta, relocated_welcome: { subject: welcome.subject, body: welcome.body, generated: welcome.generated } },
        }).eq("id", params.contactId).eq("brokerage_id", access.brokerageId),
        "caches a generated relocation welcome draft on contact metadata; the card renders its own fallback copy when the draft is absent, so a lost cache costs a regeneration and never blocks the segment change (the enclosing catch already said this — it just could not see a RESOLVED refusal)",
      )
    } catch { /* floor lives in the card — never block the segment change */ }
  }

  return { ok: true }
}

// ─── REQUEST A RELOCATION REFERRAL (relocated client → agent in new area) ─────
// A relocated past client taps "help me find a great agent where I'm moving."
// We don't serve their new market — but our agent can place a referral to a
// trusted agent there (goodwill + a referral fee, and the relationship stays
// warm). Routes to the agent AND onto the manager bus (Sphere owns referral-out).
export async function requestRelocationReferral(params: {
  contactId: string
  newArea?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok || !access.isContactSelf) return { ok: false, error: "Not allowed" }

  const newArea = (params.newArea ?? "").toString().trim().slice(0, 120) || null

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts").select("first_name, last_name, agent_id").eq("id", params.contactId).maybeSingle()
  if (!contact) return { ok: false, error: "Contact not found" }

  const clientName = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || "A past client"

  try {
    if (contact.agent_id) {
      await svc.from("client_portal_messages").insert({
        contact_id: params.contactId, agent_id: contact.agent_id, brokerage_id: access.brokerageId,
        direction: "client_to_agent", channel: "portal", read: false,
        body: `Relocation referral request${newArea ? ` — moving to ${newArea}` : ""}.`,
      }).then(() => {}, () => {})

      const agent = await resolveContactOwnerAgent(svc, contact.agent_id)
      const agentUserId = (agent as { user_id?: string | null; id?: string | null } | null)?.user_id
        ?? (agent as { id?: string | null } | null)?.id ?? null
      if (agentUserId) {
        await svc.from("notifications").insert({
          user_id: agentUserId, brokerage_id: access.brokerageId, type: "relocation_referral_request",
          title: `📦 ${clientName} needs an agent in their new area`,
          body: `${clientName} asked for a referral to a trusted agent${newArea ? ` in ${newArea}` : " where they're moving"}. Place the referral — goodwill now, a referral fee at close.`,
          entity_type: "contact", entity_id: params.contactId, priority: "high", is_read: false,
        }).then(() => {}, () => {})
      }
    }

    // MULTI-MANAGER: the Sphere Manager owns referral-out — hand it the request.
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    await publishManagerSignal({
      brokerageId: access.brokerageId, fromManager: "ai_isa", toManager: "sphere_of_influence",
      signalType: "relocation_referral_request", entityType: "contact", entityId: params.contactId,
      contactId: params.contactId,
      message: `${clientName} is relocating${newArea ? ` to ${newArea}` : ""} — place an outbound agent referral.`,
      payload: { new_area: newArea },
    }, svc).then(() => {}, () => {})
  } catch { /* best-effort — never block the request */ }

  return { ok: true }
}

// ─── GET LIFETIME CONTEXT ────────────────────────────────────────────────────
export async function getLifetimeContext(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return null

  const supabase = createServiceClient()

  // Get contact (without broken embedded join) — scoped to brokerage
  const { data: contact } = await supabase
    .from("contacts")
    .select(`
      id,
      first_name,
      last_name,
      buyer_stage,
      agent_id,
      lifetime_segment,
      metadata
    `)
    .eq("id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .maybeSingle()

  if (!contact) return null

  // Brand-voiced relocated welcome (generated at segment-set, floor in the card).
  const relocatedWelcome = ((contact as { metadata?: { relocated_welcome?: { subject?: string; body?: string } } | null }).metadata?.relocated_welcome) ?? null

  // Resolve agent via kernel identity function
  const agentInfo = contact.agent_id
    ? await resolveContactOwnerAgent(supabase, contact.agent_id)
    : null

  // Get closed transaction — scoped to brokerage
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`
      id,
      property_address,
      status,
      close_date,
      sale_price:purchase_price,
      offer_price:purchase_price,
      created_at
    `)
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .eq("status", "closed")
    .order("close_date", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Get latest home value estimate — scoped
  const { data: homeValueEstimate } = await supabase
    .from("home_value_estimates")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Get the value series over time (oldest → newest) so the portal can render
  // the "home wealth story" — purchase price → today's value as a living curve.
  // Realized history only; no forward forecast (compliance-safe).
  const { data: valueSeriesRaw } = await supabase
    .from("home_value_estimates")
    .select("estimated_value_mid, estimated_value_low, estimated_value_high, generated_at")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("generated_at", { ascending: true })
    .limit(24)
  const homeValueSeries = (valueSeriesRaw ?? []).filter(
    (p: any) => typeof p.estimated_value_mid === "number" && p.estimated_value_mid > 0,
  )

  // Get recent touchpoints — scoped
  const { data: touchpoints } = await supabase
    .from("lifetime_customer_touchpoints")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("sent_date", { ascending: false })
    .limit(5)

  // Get referrals submitted by this contact — scoped (live schema column is referred_by)
  const { data: referrals } = await supabase
    .from("referrals")
    .select("*")
    .eq("referred_by", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("created_at", { ascending: false })

  // THE PREFERRED VENDORS A LIFETIME CLIENT SEES. This ran its own `vendors`
  // query and ranked by rating, because `vendors` has no preferred column — but
  // the flag it needed lives on vendor_directory, which premium-placement writes
  // when a vendor PAYS the brokerage for featured placement. Ranking by rating
  // here meant the paid vendor was simply one of the list, in whatever order
  // their star average happened to fall. Same shared resolver as the portal
  // vendors page (m303), so "preferred" means one thing across the product.
  const { resolveContactVendors: resolveLifetimeVendors } = await import("@/lib/vendor-marketplace/resolve-contact-vendors")
  const preferredVendors = (await resolveLifetimeVendors(supabase as never, {
    contactId,
    brokerageId: access.brokerageId,
    teamId: null,
    stage: "forever",
    audienceTags: ["lifetime_customer"],
  })).slice(0, 3)

  // All vendor categories the brokerage marketplace carries (not just preferred) —
  // lets the maintenance card decide "request an intro" vs "browse pros".
  // vendors replaced vendor_directory — vendor_directory was a writer-less legacy twin (burn-down round 4 repoint)
  const { data: allVendorCats } = await supabase
    .from("vendors")
    .select("category")
    .eq("brokerage_id", access.brokerageId)
    .not("category", "is", null)
    .limit(200)
  const vendorCategories = Array.from(
    new Set((allVendorCats ?? []).map((v: { category?: string | null }) => (v.category ?? "").toLowerCase().trim()).filter(Boolean)),
  )

  // Get neighborhood activity (recent listings near same city/address) — scoped
  let neighborhoodListings: any[] = []
  if (transaction?.property_address) {
    // Extract city/zip from address - simple heuristic: last 2 parts after last comma
    const parts = transaction.property_address.split(",").map((p: string) => p.trim())
    const cityState = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
    if (cityState) {
      const { data: nearby } = await supabase
        .from("listings")
        .select("id, address, list_price, status, created_at")
        .eq("brokerage_id", access.brokerageId)
        .ilike("address", `%${cityState}%`)
        .in("status", ["active", "sold", "pending"])
        .neq("id", (transaction as any).listing_id ?? "00000000-0000-0000-0000-000000000000")
        .order("created_at", { ascending: false })
        .limit(5)
      neighborhoodListings = nearby ?? []
    }
  }

  return {
    contact,
    agent: agentInfo,
    transaction,
    relocatedWelcome,
    homeValueEstimate,
    homeValueSeries,
    touchpoints: touchpoints || [],
    referrals: referrals || [],
    preferredVendors,
    vendorCategories,
    neighborhoodListings,
  }
}

// ─── SUBMIT REFERRAL ─────────────────────────────────────────────────────────
export async function submitReferral(data: {
  contactId: string
  referredName: string
  referredContact: string
  relationship?: string
  /** Free-text context from the referring client ("relocating in spring, wants
   *  a yard"). Optional; capped and control-character-stripped below. */
  notes?: string
}) {
  const access = await requireContactAccess(data.contactId)
  if (!access.ok) throw new Error("Forbidden")

  const supabase = createServiceClient()

  // THE CLIENT'S OWN WORDS. The portal form held a `notes` field that was never
  // rendered and never sent, and this action had no parameter for it, so the
  // qualifying context the brokerage's routing wants (§5 — leads belong to the
  // brokerage) was lost on both sides. It lands in `referrals.notes` (TEXT,
  // scripts/180-create-past-client-referral-system.sql:53) behind the
  // contact-line this action already wrote there, and in the agent's portal
  // message, so app/referrals/pipeline/page.tsx:165 and the inbox both show it.
  // Sanitized: control characters out, trimmed, hard cap — a "use server"
  // export is a public endpoint and the body is not trusted for length.
  const REFERRAL_NOTE_MAX = 500
  const clientNote = String(data.notes ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, REFERRAL_NOTE_MAX)

  // Get contact's agent. Note: agent_id can legitimately be NULL when the contact came
  // through the public listing page disclosing they're already represented by another
  // agent (NAR Article 16 — we don't auto-poach). Distinguish "contact missing" (real
  // error) from "contact exists but has no in-house agent" (legitimate state — referral
  // is recorded but routed to the brokerage's referral queue instead of a specific
  // agent).
  const { data: contact } = await supabase
    .from("contacts")
    .select("agent_id, brokerage_id")
    .eq("id", data.contactId)
    .eq("brokerage_id", access.brokerageId)
    .maybeSingle()

  if (!contact) throw new Error("Contact not found")

  // Create referral record using actual referrals schema columns
  const { data: referral, error: referralError } = await supabase
    .from("referrals")
    .insert({
      referred_by: data.contactId,
      referral_name: data.referredName,
      source_contact_name: data.referredName,
      notes:
        data.referredContact +
        (data.relationship ? ` (${data.relationship})` : "") +
        (clientNote ? `\n${clientNote}` : ""),
      status: "received", // CHECK: received|contacted|qualified|assigned|under_contract|closed|lost (no 'new')
      agent_id: contact.agent_id,
      brokerage_id: contact.brokerage_id,
    })
    .select("id")
    .maybeSingle()

  if (referralError) throw referralError

  // Skip the agent-side notification when the contact has no assigned in-house agent
  // (represented buyer case). The referral row is still recorded for the brokerage to
  // route from its referrals queue; the portal message to a specific agent would have
  // no valid recipient.
  if (contact.agent_id) {
    await supabase.from("client_portal_messages").insert({
      contact_id: data.contactId,
      agent_id: contact.agent_id,
      brokerage_id: contact.brokerage_id,
      direction: "client_to_agent",
      channel: "portal",
      read: false,
      body:
        `New referral: ${data.referredName} (${data.referredContact})${data.relationship ? ` - ${data.relationship}` : ""}` +
        (clientNote ? `\nTheir note: ${clientNote}` : ""),
    })

    // Emit kernel event - resolve agent via kernel identity function
    const agentData = await resolveContactOwnerAgent(supabase, contact.agent_id)
    await supabase.from("lifecycle_events").insert({
      brokerage_id: agentData?.brokerage_id,
      event_type: KernelEvent.MESSAGE_FROM_CONTACT,
      entity_type: "contact",
      entity_id: data.contactId,
      actor_user_id: contact.agent_id,
      metadata: {
        contact_id: data.contactId,
        referred_name: data.referredName,
        agent_id: contact.agent_id,
        referral_id: referral?.id,
        type: "referral_submitted",
      },
    })
  }

  return referral
}

// ─── GET REFERRAL HISTORY ────────────────────────────────────────────────────
export async function getReferralHistory(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return []

  const supabase = createServiceClient()

  const { data: referrals } = await supabase
    .from("referrals")
    .select(`
      id,
      referred_name:referral_name,
      referred_contact:source_contact_name,
      referral_status:status,
      notes,
      created_at
    `)
    .eq("referred_by", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("created_at", { ascending: false })

  return referrals || []
}

// ─── GET TRANSACTION HISTORY ─────────────────────────────────────────────────
export async function getTransactionHistory(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return null

  const supabase = createServiceClient()

  // Get closed transaction with milestones — scoped
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`
      id,
      property_address,
      status,
      close_date,
      sale_price:purchase_price,
      offer_price:purchase_price,
      offer_date:contract_date,
      created_at,
      transaction_milestones(
        id,
        milestone_name,
        status,
        completed_date:completed_at,
        target_date
      )
    `)
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .eq("status", "closed")
    .order("close_date", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!transaction) return null

  // Get transaction documents — scoped
  const { data: documents } = await supabase
    .from("transaction_documents")
    .select("id, document_type:doc_type, file_name:doc_label, file_url:storage_url, created_at")
    .eq("transaction_id", transaction.id)
    .eq("brokerage_id", access.brokerageId)
    .order("created_at", { ascending: false })

  return {
    ...transaction,
    documents: documents || [],
  }
}

// ─── GET MARKET UPDATES ──────────────────────────────────────────────────────
export async function getMarketUpdates(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { estimates: [], touchpoints: [] }

  const supabase = createServiceClient()

  // Get home value estimates history — scoped
  const { data: estimates } = await supabase
    .from("home_value_estimates")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("generated_at", { ascending: true })

  // Get market update touchpoints — scoped
  const { data: touchpoints } = await supabase
    .from("lifetime_customer_touchpoints")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    // lifetime_customer_touchpoints has no 'anniversary' — it says home_anniversary.
    .in("touchpoint_type", ["market_update"])
    .order("sent_date", { ascending: false })

  return {
    estimates: estimates || [],
    touchpoints: touchpoints || [],
  }
}

// ─── REQUEST VALUE UPDATE ────────────────────────��───────────────────────────
export async function requestValueUpdate(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) throw new Error("Forbidden")

  const supabase = createServiceClient()

  // Get contact's agent
  const { data: contact } = await supabase
    .from("contacts")
    .select("agent_id, first_name, last_name")
    .eq("id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .single()

  // Two distinct failures wore one message. `!contact` means the row is absent
  // (or belongs to another brokerage) — "not found" is true. `!contact.agent_id`
  // means the row IS here and simply has nobody assigned to receive the request,
  // and telling that client "not found" sends them looking for a record that is
  // sitting right in front of them. Separate the checks; name the real gap.
  if (!contact) throw new Error("Contact not found")
  if (!contact.agent_id) {
    throw new Error("This contact has no assigned agent yet, so there is nobody to send the request to.")
  }

  // Send message to agent
  await supabase.from("client_portal_messages").insert({
    contact_id: contactId,
    brokerage_id: access.brokerageId,
    agent_id: contact.agent_id,
    direction: "client_to_agent",
    body: `${contact.first_name || "Client"} requested an updated home value estimate.`,
    channel: "portal",
    read: false,
    created_at: new Date().toISOString(),
  })

  return { success: true }
}

// ─── GET VENDOR RESOURCES ────────────────────────────────────────────────────
export async function getVendorResources(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return []

  const supabase = createServiceClient()

  // ONE RESOLVER (m303). This ran its own `vendors` query and noted that the
  // curation columns did not exist there — which was true of `vendors` and not
  // true of the system: they live on vendor_directory, which premium-placement
  // writes when a vendor PAYS for featured placement. Reading the bench meant
  // portal visibility, display priority and the preferred badge were all
  // ignored on the surface the placement was sold for. Now routed through the
  // shared resolver so this page and /portal/[contactId]/vendors cannot
  // disagree about who a client should see.
  const { resolveContactVendors } = await import("@/lib/vendor-marketplace/resolve-contact-vendors")
  const curated = await resolveContactVendors(supabase as never, {
    contactId,
    brokerageId: access.brokerageId,
    teamId: null,
    // No transaction context on this surface — the lifetime toolkit is the
    // "forever" stage by definition, and audience tags are unfiltered here.
    stage: "forever",
    audienceTags: ["lifetime_customer"],
  })
  return curated
}

// ─── PROPERTY FEEDBACK (portal) ──────────────────────────────────────────────
/**
 * The buyer's own verdict on a property, from the persona portal.
 *
 * THIS EXISTED AS A LIE. The rating dialog collected a vote AND a comment, then
 * handleRateProperty toasted "Your feedback has been recorded" and closed —
 * calling nothing. Both values were dropped on the floor. That is the most
 * expensive possible place to lose data: a buyer telling their agent, in their
 * own words, why a house does or does not work is the highest-signal input in
 * the whole buyer journey, and the OS threw it away while thanking them for it.
 *
 * The sibling surface (CollaborativeSearchDashboard) already did this properly
 * via rateProperty(), but that lane writes property_family_ratings and needs a
 * collaborative_search_id, which the persona portal has no concept of. The
 * right home is property_feedback, keyed by contact — which is exactly what the
 * agent-side matcher already reads to learn preferences, so a portal rating now
 * feeds the same brain.
 */
export async function submitPropertyFeedback(params: {
  contactId: string
  propertyId: string
  vote: "love" | "like" | "neutral" | "dislike" | "pass"
  comments?: string
}): Promise<{ success: boolean; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  // A 1-5 scale so the agent-side preference learner can rank, alongside the
  // word the buyer actually chose.
  const INTEREST: Record<string, number> = { love: 5, like: 4, neutral: 3, dislike: 2, pass: 1 }

  const supabase = createServiceClient()

  // Prove the voted id against the brokerage's own listings so listing_id can be
  // stamped. This portal is an in-house inventory surface, but its cards can also
  // hold non-listings rows (external search results), so the proof is conditional
  // rather than a refusal: an unproven id keeps listing_id NULL and the vote still
  // records, same as before. Scoped to access.brokerageId — a foreign tenant's
  // listing id must not be stamped into this brokerage's feedback (§4).
  // With listing_id stamped, the agent-side preference learner's `listings(*)`
  // embed (app/actions/ai-property-matching.ts) finally resolves for portal votes
  // — the brain gets the house with the vote instead of "- loved: undefined".
  // property_id stays: a "property_id" holding a listings.id is not a property id
  // (m542 precedent) and now has zero readers — a future-drop candidate for a
  // migration, not an application-code decision.
  const { data: provenListing, error: listingProofError } = await supabase
    .from("listings")
    .select("id")
    .eq("id", params.propertyId)
    .eq("brokerage_id", access.brokerageId)
    .maybeSingle()
  if (listingProofError) {
    // §3: a refused read resolves — log it; the vote still records, unstamped.
    console.error("[portal-lifetime] submitPropertyFeedback: listings proof refused:", listingProofError.message)
  }

  const { error } = await supabase.from("property_feedback").insert({
    contact_id: params.contactId,
    property_id: params.propertyId,
    listing_id: provenListing ? params.propertyId : null,
    brokerage_id: access.brokerageId,
    feedback_type: params.vote,
    interest_level: INTEREST[params.vote] ?? 3,
    notes: params.comments?.trim() || null,
    source: "portal",
    created_at: new Date().toISOString(),
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}
