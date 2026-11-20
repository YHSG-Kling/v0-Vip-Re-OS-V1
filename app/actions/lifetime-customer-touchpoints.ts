"use server"

import { createClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity"
import { resolveAgentId, requireAgentId } from "@/lib/kernel/agent-identity"
import { recordLifetimeTouchpointSent } from "@/lib/sphere/lifetime-touchpoint-ledger"

// System callers (e.g. the daily lifetime-touchpoints cron) have no user session,
// so they pass the owning agentId + a service-role client; UI callers pass neither
// and the acting agent is resolved from the session.
type TouchpointActorOpts = { agentId?: string; client?: SupabaseClient }
/** WAVE 154 (lane 154H, H9): `video: false` = the arbiter chose the written greeting ALONE — the avatar video is a separate,
 *  arbitrated option (lib/sphere/lifetime-touch-arbitration.ts), never fired beside every email. Omitted (a person's click in the
 *  UI) keeps the click's existing behavior. */
type AnniversaryOpts = TouchpointActorOpts & { video?: boolean }

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

/**
 * ACTION LEDGER context for a lifetime touch (wave 98, lane 98B). A SYSTEM caller (the daily
 * lifetime-touchpoints cron passes a service client) sends for reason LIFETIME_TOUCH with a
 * deterministic cycle — one anniversary per anniversary year, one birthday per calendar year, one
 * referral ask per day — so a re-run cron replays instead of texting twice. A UI caller (no
 * client) is a human decision: HUMAN_REQUESTED, no cycle. Not exported — a "use server" export is
 * a public endpoint (CLAUDE.md §4).
 */
function touchLedger(opts: TouchpointActorOpts | undefined, cycle: string): { reasonCode: "LIFETIME_TOUCH" | "HUMAN_REQUESTED"; cycle?: string } {
  return opts?.client ? { reasonCode: "LIFETIME_TOUCH", cycle } : { reasonCode: "HUMAN_REQUESTED" }
}

// (REMOVED) scheduleLifetimeCustomerTouchpoints — the dead fixed-calendar scheduler. It had no callers
// and created the orphaned 'scheduled' rows nothing delivered. Lifetime nurture is now the situational
// model (newsletter baseline + the situational reel rail + equity/anniversary/life-event triggers).

// Send anniversary message
export async function sendAnniversaryMessage(contactId: string, yearsAgo: number, opts?: AnniversaryOpts) {
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
    ledger: touchLedger(opts, `home_anniversary:year_${yearsAgo}`),
  })
  if (!result.success) {
    return { success: false, error: result.error ?? "Send blocked by compliance gate" }
  }

  // THE ONE sent-touch ledger + the ONE LIFETIME_CUSTOMER_TOUCHPOINT_SENT emit (wave 104, lane 104E).
  const recorded = await recordLifetimeTouchpointSent(supabase, {
    brokerageId: brokerageId!, contactId, agentId, touchpointType: "home_anniversary", channel: "email",
    engagementData: { message }, source: opts?.client ? "cron" : "ui",
  })
  if (!recorded.ok) throw new Error(recorded.error)

  // Fire the personalized anniversary D-ID + cloned-voice video alongside the
  // email. Gated on contacts.video_opt_out + agent voice profile, idempotent
  // per calendar year via agent_intro_videos (m121). Never throws — a video
  // failure must not block the email touchpoint that just succeeded.
  // WAVE 154 (154H): only when the caller did not say otherwise — the daily cron passes the arbiter's choice (video: false when
  // the written greeting was chosen alone), so one milestone is never answered with every artifact at once.
  if (agentId && opts?.video !== false) {
    try {
      const { dispatchAnniversaryVideo } = await import("@/lib/video/intro-video-reactor")
      // CONTACT-FACING LANGUAGE (owner ruling, wave 51/52 — task item 3): the
      // ONE resolver (§6) — never throws, but a defensive catch still leaves
      // `language` undefined so the reactor degrades to DEFAULT_LANGUAGE.
      let language: string | undefined
      try {
        const { resolveContactLanguageFromDb } = await import("@/lib/video/multilingual-reel")
        language = await resolveContactLanguageFromDb(supabase, contactId)
      } catch { /* falls through to the reactor's own DEFAULT_LANGUAGE */ }
      void dispatchAnniversaryVideo({
        brokerageId,
        contactId,
        agentId,   // agents.id from resolveAgentId — the reactor resolves to users.id internally
        yearsAgo,
        delivery: "portal",
        language,
      })
    } catch (err) {
      console.error("[anniversary] video dispatch failed:", err)
    }
  }

  revalidatePath("/lifetime-customers")
  // The provider's reference is ACCEPTED evidence only (the provider took the message) — never "delivered".
  return { success: true, messageId: result.messageId ?? null }
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
    ledger: touchLedger(opts, `birthday:${new Date().toISOString().slice(0, 4)}`),
  })
  if (!result.success) {
    return { success: false, error: result.error ?? "Send blocked by compliance gate" }
  }

  // THE ONE sent-touch ledger + the ONE LIFETIME_CUSTOMER_TOUCHPOINT_SENT emit (wave 104, lane 104E).
  const recorded = await recordLifetimeTouchpointSent(supabase, {
    brokerageId: brokerageId!, contactId, agentId, touchpointType: "birthday", channel: "sms",
    engagementData: { message }, source: opts?.client ? "cron" : "ui",
  })
  if (!recorded.ok) throw new Error(recorded.error)

  revalidatePath("/lifetime-customers")
  return { success: true }
}

// ── DELETED (wave 143, lane 143E): sendReferralRequest ──────────────────────────────────────
//
// DUPLICATE of the referral-ask the follow-up arbiter now owns, and a hard-coded timetable besides. Its ONE caller was
// the daily lifetime cron's "referral request opportunities (3 days and 30 days after close)" block, which texted every closed
// client at exactly day 3 and day 30 whatever their intent, history or fatigue — and this function shipped a CANNED fallback body
// ("Hi X! I've been thinking about you…") when the gateway was down. That block is retired (tombstone in
// app/api/cron/lifetime-customer-touchpoints/route.ts) and with it this function had no caller anywhere in the tree.
//
// SURVIVOR: lib/sphere/followup-moments.ts conductDueFollowUpMoments — the `referral_request` moment of the tenant's versioned
// followup_policy (lib/ai-isa/followup-policy.ts postClose; opens at policy.afterClosingDays) is reviewed by the arbiter, which
// decides WHETHER, WHEN and HOW to ask (a brand-voiced message, a video, a task for the agent, or wait). What THIS function had
// that the survivor needed was carried over first: the SMS-through-THE-gate send (dispatchSms with consent / DNC / quiet hours),
// the ledger at-most-once cycle (now `followup_moment:<touchpoint id>`), the "sent only on a real dispatch" rule (the row is
// settled `sent` only after the gate accepted), and the LIFETIME_CUSTOMER_TOUCHPOINT_SENT emit. What it had that the survivor
// deliberately does NOT carry: the canned fallback — generation failure means "retry tomorrow", never an unreviewed script.

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
//
// WAVE 155 (lane 155R29, orphan doctrine §1 case 3): KEPT AND MADE SAFE. This is the ONLY writer of client_engagement_scores, which
// two live screens read (app/actions/lifetime-customers.ts:233 → the past-clients panel; app/referrals/page.tsx:214 sphere maths),
// and nothing calls it — so the score those screens show is never computed. No survivor exists, so the door stays (owner question in
// the lane notes: wire it, or retire it with the readers). What was unsafe, and is now refused: the tenant came from the AGENT row,
// not the session; the contact was never checked against any tenant (the table is UNIQUE(contact_id), so an upsert could rewrite
// another tenant's client score); the touchpoints read had no tenant predicate; both reads swallowed refusals (a refused read scored
// the client 0); and the upsert was neither counted nor recorded. Now: session tenant, contact proven in it, tenant-pinned reads that
// throw on refusal, a counted upsert, and ONE receipt (lifetime.engagement_score.calculate, no key — a re-score runs again).
export async function calculateEngagementScore(contactId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // ONE VOCABULARY (§6) — the second verbatim copy of requireAgentId
  // (lib/kernel/agent-identity.ts:113). Merged onto the survivor; the message it
  // throws also tells the caller what to do about it ("Please complete
  // onboarding") instead of only naming the absence.
  const agentId = await requireAgentId(supabase, user.id)
  // client_engagement_scores.brokerage_id is NOT NULL — the SESSION's tenant (CLAUDE.md §4), never the agent row's or an argument's.
  const session = await getAgentContext()
  if (!session.isAuthenticated || !session.brokerageId) throw new Error("Your account is not linked to a brokerage")
  const brokerageId = session.brokerageId

  const { data: contact, error: contactError } = await supabase
    .from("contacts").select("id").eq("id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
  if (contactError) throw new Error(`Could not verify the contact: ${contactError.message}`)
  if (!contact) throw new Error("Contact not found in your brokerage")

  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return ledgerSessionAction({ brokerageId, action: "lifetime.engagement_score.calculate", actor: { type: "user", userId: user.id, agentId }, subject: { type: "contact", id: contactId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, async (): Promise<{ engagementScore: number; referralPotentialScore: number }> => {
  const { data: touchpoints, error: touchpointsError } = await supabase
    .from("lifetime_customer_touchpoints")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .eq("status", "sent")
  if (touchpointsError) throw new Error(`Could not read the touchpoints: ${touchpointsError.message}`)

  // referrals given BY this contact: canonical column is referred_by (text).
  // tenant anchor (scope burn-down): pinned to the session's brokerage.
  const { data: referrals, error: referralsError } = await supabase
    .from("referrals")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("referred_by", contactId)
  if (referralsError) throw new Error(`Could not read the referrals: ${referralsError.message}`)

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
  const { data: written, error } = await supabase.from("client_engagement_scores").upsert({
    brokerage_id: brokerageId,
    contact_id: contactId,
    agent_id: agentId,
    score: engagementScore,
    touchpoints_count: totalTouchpoints,
    referrals_given: referralsGiven,
    last_interaction: new Date().toISOString(),
    calculated_at: new Date().toISOString(),
  }, { onConflict: "contact_id" }).select("contact_id")

  if (error) throw error
  // A write that landed nothing is not a score (§3).
  if (!written || written.length === 0) throw new Error("The engagement score was not recorded")

  return { engagementScore, referralPotentialScore }
  })
}
