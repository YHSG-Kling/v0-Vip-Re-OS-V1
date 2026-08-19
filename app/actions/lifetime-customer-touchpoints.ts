"use server"

import { createClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity"
import { resolveAgentId } from "@/lib/kernel/agent-identity"

// System callers (e.g. the daily lifetime-touchpoints cron) have no user session,
// so they pass the owning agentId + a service-role client; UI callers pass neither
// and the acting agent is resolved from the session.
type TouchpointActorOpts = { agentId?: string; client?: SupabaseClient }

async function resolveTouchpointActor(opts: TouchpointActorOpts | undefined) {
  const supabase = opts?.client ?? (await createClient())
  let agentId = opts?.agentId
  if (!agentId) {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) throw new Error("Not authenticated")
    agentId = (await resolveAgentId(supabase, user.id)) ?? undefined
  }
  if (!agentId) throw new Error("Agent profile not found")
  const { data: agentRow } = await supabase
    .from("agents")
    .select("brokerage_id")
    .eq("id", agentId)
    .maybeSingle()
  return { supabase, agentId, brokerageId: agentRow?.brokerage_id ?? null }
}

// (REMOVED) scheduleLifetimeCustomerTouchpoints — the dead fixed-calendar scheduler. It had no callers
// and created the orphaned 'scheduled' rows nothing delivered. Lifetime nurture is now the situational
// model (newsletter baseline + the situational reel rail + equity/anniversary/life-event triggers).

// Send anniversary message
export async function sendAnniversaryMessage(contactId: string, yearsAgo: number, opts?: TouchpointActorOpts) {
  const { supabase, agentId, brokerageId } = await resolveTouchpointActor(opts)

  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, email, phone")
    .eq("id", contactId)
    .single()

  if (!contact) throw new Error("Contact not found")

  if (!contact.email) {
    return { success: false, error: "Contact has no email address for anniversary message" }
  }

  // Brand-voiced via the AI gateway (them-first, Fair-Housing redrafted), with the canned line as the
  // deterministic FALLBACK floor — the app's rule: client-facing copy is AI-generated in the agent's
  // voice, never a hardcoded script; the floor only ships if the gateway is down.
  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
  const anniversaryCopy = await generateClientMessage({
    brokerageId, audience: "buyer", recipientFirstName: contact.first_name,
    purpose: `Warm ${yearsAgo}-year home-anniversary check-in to a past client — celebrate the milestone, stay genuinely in touch, and offer a quick neighborhood market update. No sales pressure.`,
    fallback: {
      subject: "Happy home anniversary!",
      body: `Hi ${contact.first_name}! Can you believe it's been ${yearsAgo} year${yearsAgo > 1 ? "s" : ""} since you closed on your home? Time flies! Hope you're still loving it. Here's a quick market update for your neighborhood...`,
    },
  })
  const message = anniversaryCopy.body

  // GATED EGRESS (informed-audit fix): this send used to go through the raw
  // communication.service path, bypassing consent/DNC/suppression/quiet-hours.
  // It now routes through THE gate (dispatchEmail with contactId) — and the
  // touchpoint row is stamped "sent" ONLY when the gate actually dispatched.
  const { dispatchEmail } = await import("@/lib/providers/dispatch")
  const result = await dispatchEmail({
    brokerageId: brokerageId!,
    from: "Your Agent",
    to: contact.email,
    subject: anniversaryCopy.subject || "Happy home anniversary!",
    html: message,
    channelPurpose: "update",
    systemSource: "lifetime_touchpoints",
    contactId,
    metadata: { touchpoint: "home_anniversary", yearsAgo },
  })
  if (!result.success) {
    return { success: false, error: result.error ?? "Send blocked by compliance gate" }
  }

  const { error } = await supabase.from("lifetime_customer_touchpoints").insert({
    brokerage_id: brokerageId,
    contact_id: contactId,
    agent_id: agentId,
    touchpoint_type: "home_anniversary",
    channel: "email",
    scheduled_date: new Date().toISOString().split("T")[0],
    sent_date: new Date().toISOString().split("T")[0],
    engagement_data: { message },
    status: "sent",
  })

  if (error) throw error

  // Fire the personalized anniversary D-ID + cloned-voice video alongside the
  // email. Gated on contacts.video_opt_out + agent voice profile, idempotent
  // per calendar year via agent_intro_videos (m121). Never throws — a video
  // failure must not block the email touchpoint that just succeeded.
  if (agentId) {
    try {
      const { dispatchAnniversaryVideo } = await import("@/lib/video/intro-video-reactor")
      void dispatchAnniversaryVideo({
        brokerageId,
        contactId,
        agentId,   // agents.id from resolveAgentId — the reactor resolves to users.id internally
        yearsAgo,
        delivery: "portal",
      })
    } catch (err) {
      console.error("[anniversary] video dispatch failed:", err)
    }
  }

  revalidatePath("/lifetime-customers")
  return { success: true }
}

// Send birthday message
export async function sendBirthdayMessage(contactId: string, opts?: TouchpointActorOpts) {
  const { supabase, agentId, brokerageId } = await resolveTouchpointActor(opts)

  const { data: contact } = await supabase.from("contacts").select("first_name, last_name, phone").eq("id", contactId).single()

  if (!contact) throw new Error("Contact not found")
  if (!contact.phone) {
    return { success: false, error: "Contact has no phone number for a birthday text" }
  }

  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
  const birthdayCopy = await generateClientMessage({
    brokerageId, audience: "buyer", recipientFirstName: contact.first_name,
    purpose: "Short, warm birthday wish to a past client — genuine and personal, absolutely no sales pitch.",
    fallback: { subject: "Happy Birthday!", body: `Happy Birthday ${contact.first_name}! Wishing you an amazing year ahead!` },
  })
  const message = birthdayCopy.body

  // INFORMED-AUDIT FIX: this row used to be stamped "sent" with NO send behind
  // it. It now dispatches through THE gate (consent/DNC/quiet-hours) first and
  // records "sent" only when the gate actually dispatched.
  const { dispatchSms } = await import("@/lib/providers/dispatch")
  const result = await dispatchSms({
    brokerageId: brokerageId!,
    to: contact.phone,
    message,
    systemSource: "lifetime_touchpoints",
    contactId,
    metadata: { touchpoint: "birthday" },
  })
  if (!result.success) {
    return { success: false, error: result.error ?? "Send blocked by compliance gate" }
  }

  const { error } = await supabase.from("lifetime_customer_touchpoints").insert({
    brokerage_id: brokerageId,
    contact_id: contactId,
    agent_id: agentId,
    touchpoint_type: "birthday",
    channel: "sms",
    scheduled_date: new Date().toISOString().split("T")[0],
    sent_date: new Date().toISOString().split("T")[0],
    engagement_data: { message },
    status: "sent",
  })

  if (error) throw error

  revalidatePath("/lifetime-customers")
  return { success: true }
}

// Send referral request
export async function sendReferralRequest(contactId: string, opts?: TouchpointActorOpts) {
  const { supabase, agentId, brokerageId } = await resolveTouchpointActor(opts)

  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, email, phone")
    .eq("id", contactId)
    .single()

  if (!contact) throw new Error("Contact not found")

  const { data: agent } = await supabase.from("agents").select("users(first_name, last_name)").eq("id", agentId).single()

  const agentFullName = [(agent?.users as any)?.first_name, (agent?.users as any)?.last_name].filter(Boolean).join(" ")

  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
  const referralCopy = await generateClientMessage({
    brokerageId, audience: "buyer", recipientFirstName: contact.first_name,
    purpose: "Gentle referral ask to a happy past client — appreciative and warm, invite them to refer friends or family thinking of buying or selling, with zero pressure.",
    fallback: {
      subject: "A quick favor",
      body: `Hi ${contact.first_name}! I've been thinking about you - hope everything's going great with your home! Quick question: I'm trying to help more families find their perfect home. If you know anyone thinking about buying or selling, I'd love to give them the same experience you had. No pressure at all - just wanted to put it on your radar. ${agentFullName || "Your Agent"}`,
    },
  })
  const message = referralCopy.body

  // INFORMED-AUDIT FIX: previously stamped "sent" with no send behind it.
  // Dispatch through THE gate first; record "sent" only on a real dispatch.
  if (!contact.phone) {
    return { success: false, error: "Contact has no phone number for a referral text" }
  }
  const { dispatchSms } = await import("@/lib/providers/dispatch")
  const result = await dispatchSms({
    brokerageId: brokerageId!,
    to: contact.phone,
    message,
    systemSource: "lifetime_touchpoints",
    contactId,
    metadata: { touchpoint: "referral_request" },
  })
  if (!result.success) {
    return { success: false, error: result.error ?? "Send blocked by compliance gate" }
  }

  const { error } = await supabase.from("lifetime_customer_touchpoints").insert({
    brokerage_id: brokerageId,
    contact_id: contactId,
    agent_id: agentId,
    touchpoint_type: "referral_request",
    channel: "sms",
    scheduled_date: new Date().toISOString().split("T")[0],
    sent_date: new Date().toISOString().split("T")[0],
    engagement_data: { message },
    status: "sent",
  })

  if (error) throw error

  revalidatePath("/lifetime-customers")
  return { success: true }
}

// ── DELETED: getLifetimeCustomerContacts ────────────────────────────────────
//
// DUPLICATE. The survivor is app/actions/lifetime-customers.ts:143
// `getLifetimeCustomers` — the same query (this agent's contacts ∩ closed
// transactions), and it is the LIVE one: app/lifetime-customers/page.tsx has
// always read the whole Lifetime Customers screen from it. This copy had no
// caller anywhere in the tree.
//
// The survivor does strictly more (search filter, client_engagement_scores
// join, property_address + actual_close_date on the transaction rows). The two
// things THIS copy had and the survivor lacked were carried over first, before
// it was removed:
//   · the missing-identity guard. getLifetimeCustomers used agentId/brokerageId
//     from getAgentContext() without checking either, so a caller with no agents
//     row issued `.eq("agent_id", null)` and got an empty list that read as
//     "you have no lifetime customers" rather than "we could not identify you".
//   · the most-recent-closing-first sort. The survivor returned contacts in
//     whatever order PostgREST handed them back.
// Both now live on app/actions/lifetime-customers.ts:getLifetimeCustomers.
//
// Nothing else moved: the return key differs (`contacts` here, `clients` there)
// and the survivor's key is the one every consumer already reads.

/**
 * Scheduled + sent touchpoints for one calendar month, for the signed-in agent.
 *
 * `month` is 0-indexed (January = 0) to match `Date`, which is what the
 * range below is built from.
 *
 * Hardened while being wired to its first caller (the Lifetime Customers
 * milestones tab):
 *   · IDENTITY GUARD. This used agentId/brokerageId straight out of
 *     getAgentContext() without checking either. A caller with no agents row
 *     produced `.eq("agent_id", null)`, i.e. `agent_id=eq.null` on the wire —
 *     which matches nothing — so an unidentifiable caller was shown an empty
 *     calendar that reads as "nothing scheduled this month".
 *   · IT THREW. A `"use server"` export that throws surfaces to the browser as
 *     an opaque server-action error, so a refused read took the whole tab down
 *     instead of saying what happened. It reports the refusal now.
 * `lifetime_customer_touchpoints.scheduled_date` is a DATE column, so both
 * bounds are date-only strings, and endDate is day 0 of the following month =
 * the last day of `month`.
 */
export async function getTouchpointCalendar(
  month: number,
  year: number,
): Promise<{
  success: boolean
  error?: string
  touchpoints: Array<Record<string, unknown>>
}> {
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId || !brokerageId) {
    return { success: false, error: "Agent context not available", touchpoints: [] }
  }
  const supabase = await createClient()

  const startDate = new Date(year, month, 1)
  const endDate = new Date(year, month + 1, 0)

  const { data, error } = await supabase
    .from("lifetime_customer_touchpoints")
    .select("*, contacts(first_name, last_name)")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .gte("scheduled_date", startDate.toISOString().split("T")[0])
    .lte("scheduled_date", endDate.toISOString().split("T")[0])
    .order("scheduled_date")

  if (error) {
    console.error("[lifetime-touchpoints] calendar read failed:", error.message)
    return { success: false, error: error.message, touchpoints: [] }
  }
  return { success: true, touchpoints: (data ?? []) as Array<Record<string, unknown>> }
}

// Calculate engagement score
export async function calculateEngagementScore(contactId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const agentId = await resolveAgentId(supabase, user.id)
  if (!agentId) throw new Error("Agent profile not found")
  // client_engagement_scores.brokerage_id is NOT NULL — resolve from the agent.
  const { data: agentRow } = await supabase
    .from("agents").select("brokerage_id").eq("id", agentId).maybeSingle()
  const brokerageId = agentRow?.brokerage_id ?? null

  const { data: touchpoints } = await supabase
    .from("lifetime_customer_touchpoints")
    .select("*")
    .eq("contact_id", contactId)
    .eq("status", "sent")

  // referrals given BY this contact: canonical column is referred_by (text).
  // tenant anchor (scope burn-down): pinned to the resolved agent's brokerage.
  const { data: referrals } = await supabase
    .from("referrals")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("referred_by", contactId)

  const totalTouchpoints = touchpoints?.length || 0
  const respondedTouchpoints = touchpoints?.filter((t) => t.engagement_data?.replied).length || 0
  const responseRate = totalTouchpoints > 0 ? (respondedTouchpoints / totalTouchpoints) * 100 : 0
  const referralsGiven = referrals?.length || 0

  // Calculate engagement score (0-100)
  const engagementScore = Math.min(100, Math.round(responseRate * 0.6 + referralsGiven * 10 + totalTouchpoints * 2))

  // Calculate referral potential score
  const referralPotentialScore = Math.min(
    100,
    Math.round(responseRate * 0.4 + engagementScore * 0.4 + referralsGiven * 5),
  )

  // client_engagement_scores real columns: score/touchpoints_count/referrals_given/
  // last_interaction/calculated_at (no engagement_score/referral_potential_score/
  // total_touchpoints/touchpoints_responded/response_rate/last_calculated_at). UNIQUE(contact_id).
  // referralPotentialScore/respondedTouchpoints/responseRate remain computed for the return value.
  const { error } = await supabase.from("client_engagement_scores").upsert({
    brokerage_id: brokerageId,
    contact_id: contactId,
    agent_id: agentId,
    score: engagementScore,
    touchpoints_count: totalTouchpoints,
    referrals_given: referralsGiven,
    last_interaction: new Date().toISOString(),
    calculated_at: new Date().toISOString(),
  }, { onConflict: "contact_id" })

  if (error) throw error

  return { engagementScore, referralPotentialScore }
}
