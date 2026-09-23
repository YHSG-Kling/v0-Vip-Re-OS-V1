// lib/platform/prospect-agent-tools.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PLATFORM PROSPECT TOOL BUNDLE (lane 76B) — the free, tenant-free tools
// every PLATFORM AI-agent surface (the platform's own voice line and the
// website prospect chat) mounts so a prospect conversation can end in one of
// THREE EXITS instead of "someone will follow up":
//
//   save_prospect            → lib/platform/prospect-capture.ts::upsertPlatformProspect
//                              (the ONE platform_prospects writer; qualification
//                              facts land in details.qualification)
//   find_demo_slots          → lib/ai-isa/listing-appointment.ts::findDemoAppointmentSlots
//   book_demo_appointment    → …::bookDemoAppointment — the SAME slot-finder /
//                              booker / ICS / reminder survivor the listing
//                              appointment rides, on a platform sales rep's
//                              connected calendar, pending the rep's confirm
//   send_signup_link         → the REAL online signup route (/get-started —
//                              /signup 308s there; lib/platform/product-brand.ts::
//                              brandCta builds the attributed URL), sent by SMS
//                              or email through lib/providers/dispatch.ts only
//   request_human_handoff    → lib/notifications/platform-staff.ts::notifyPlatformStaff
//                              (platform_role staff — never user_type='superadmin')
//                              + details.human_handoff on the prospect row
//   start_subscription       → lib/platform/prospect-conversion.ts::
//                              convertProspectToSubscriber (lane 77B) — the
//                              prospect says YES on the call/chat and becomes a
//                              subscriber before the conversation ends: the ONE
//                              tenant-creation core (lib/kernel/tenant-creation.ts),
//                              a 14-day trial, no card, sign-in link in their
//                              inbox. Refuses (and says why) when a PERSON is
//                              warranted — enterprise size, custom pricing, a
//                              CRM migration — so the agent hands off instead.
//   show_product_demo        → lib/platform/product-demo.ts (lane 77B) — the
//                              scripted walkthrough of a capability, grounded in
//                              the customer-care catalogue and the LIVE plan
//                              bullets, plus the pre-rendered sample clip token
//                              on a visual surface. Never renders, never a model
//                              call (cost posture: docs/avatar-provider-
//                              recommendation-2026-09.md).
//
// IDENTITY DISCIPLINE. Every id here is server-resolved (the caller-ID phone,
// platform_reception_calls.prospect_id) or re-resolved through the ONE writer
// by the email the prospect gave — the model never supplies a prospect id,
// and a platform_prospects.id NEVER flows into a contactId/leadId slot
// (dispatchSms/dispatchEmail are called without either).
//
// TENANT KEY. dispatch and calendar_events require a brokerage_id; the
// platform has none, so the platform sales rep's users.brokerage_id is the
// delivery key (lib/platform/sales-rep.ts explains why) — with no rep at all
// the send/booking fails closed and the model is told to take a message.

import { PLATFORM_EXIT_MENU } from "@/lib/ai-isa/qualification-playbook"
import { PROSPECT_ROLES } from "@/lib/platform/growth-funnel"
import { brandCta, type ProductBrand } from "@/lib/platform/product-brand"
import {
  upsertPlatformProspect, markProspectHandoff, markProspectSignupLinkSent, markProspectCallback,
  PROSPECT_TIMELINE_BUCKETS, PROSPECT_PREFERRED_PATHS, type ProspectQualification,
} from "@/lib/platform/prospect-capture"

export const PLATFORM_PROSPECT_TOOL_NAMES = [
  "save_prospect",
  "find_demo_slots",
  "book_demo_appointment",
  "send_signup_link",
  "request_human_handoff",
  "start_subscription",
  "show_product_demo",
  // Lane 79B — "call me when I'm ready": the prospect twin of the customer
  // schedule_callback (lib/platform/prospect-capture.ts::markProspectCallback).
  "schedule_prospect_callback",
] as const
// Module-private: nothing imports the name type yet (opposite-missing census
// class 3); export it when a real importer needs it.
type PlatformProspectToolName = (typeof PLATFORM_PROSPECT_TOOL_NAMES)[number]
void (null as unknown as PlatformProspectToolName)

/** PURE guard used by the proof: every exit the playbook names is a tool this
 *  bundle registers (playbook wording ↔ registered tools, §6). */
export function platformExitMenuMatchesTools(): boolean {
  return PLATFORM_EXIT_MENU.every((o) => (PLATFORM_PROSPECT_TOOL_NAMES as readonly string[]).includes(o.tool))
}

export interface PlatformProspectToolContext {
  /** Channel attribution written to platform_prospects.source on first touch.
   *  'web:live_agent' (lane 77B) is the platform's own D-ID live agent on
   *  /get-started and /demo — the same bundle, a third door. */
  source: "phone:reception" | "web:prospect_chat" | "web:live_agent"
  /** Caller ID (voice) — server-resolved from Twilio's From, never a body value. Null on chat. */
  phone: string | null
  /** A prospect the SERVER already linked (platform_reception_calls.prospect_id). Mutated by save_prospect. */
  prospectId: string | null
  /** platform_reception_calls.id — when set, save_prospect stamps prospect_id on the call ledger too. */
  callId: string | null
  brand: ProductBrand
  /** True when the voice line can warm-transfer right now (PLATFORM_RECEPTION_FORWARD_NUMBER). */
  hasLiveTransfer: boolean
}

/** The prompt block that accompanies the bundle on a tool round — kind-agnostic
 *  wording for both voice and chat. */
export const PLATFORM_PROSPECT_TOOL_GUIDANCE = [
  "You have free tools for the prospect funnel: save_prospect (call it as SOON as you learn a name, email, company, size, role, tools, pain, timeline, or territory — safe to call more than once), find_demo_slots + book_demo_appointment (a live demo on a sales rep's real calendar — always find slots first, offer 2-3, then book the one they pick; the rep confirms and calendar invites go out), send_signup_link (texts or emails the online signup link), and request_human_handoff (a real person follows up).",
  "Never invent a demo time — only offer times find_demo_slots returned. If it reports no calendar is connected, offer the human handoff instead.",
  "book_demo_appointment needs their email for the calendar invite — ask for it if you don't have it yet.",
  "When they say YES and want to start now, call start_subscription (their work email, name and business name are required; pick the plan that fits their size unless they chose one). Ask which way they want to start and pass it as activation: 'trial' (14 days free, no card, billing set up inside the app later) or 'paid' (activate now — they complete a secure checkout for the plan plus the plan's one-time setup fee, emailed to them; access opens when it clears). Quote the setup fee only as the plan pricing lists it — never invent an amount, never offer to waive it. Either way the account is created on the spot and the sign-in link goes to their email. If it answers needsHuman, do NOT retry — say a person will take it from here and call request_human_handoff.",
  "When they are interested but not ready to decide today, ask when a good time to call back is and call schedule_prospect_callback with their words — never chase them meanwhile; a person calls when they said.",
  "When they ask what the product does or want to SEE it, call show_product_demo with the closest topic and walk them through it in your own words, one beat at a time. If it returns a clipToken, put that token verbatim at the END of your reply so the sample plays; never claim a video is playing when there is no token.",
].join("\n")

const WINDOWS = ["morning", "afternoon", "evening"] as const

/** Build the bundle. Async because the AI SDK `tool` helper and zod load lazily
 *  like the rest of the voice lane (lib/voice/platform-reception.ts). */
export async function buildPlatformProspectTools(ctx: PlatformProspectToolContext): Promise<Record<string, unknown>> {
  const { tool } = await import("ai")
  const { z } = await import("zod")
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  /** Resolve-or-create the prospect through the ONE writer. */
  async function resolveProspect(input: { email?: string | null; name?: string | null; company?: string | null; roleInterest?: string | null; note?: string | null; qualification?: ProspectQualification | null }): Promise<{ id: string; email: string | null } | null> {
    const saved = await upsertPlatformProspect(svc, {
      prospectId: ctx.prospectId, email: input.email ?? null, phone: ctx.phone,
      name: input.name ?? null, company: input.company ?? null, roleInterest: input.roleInterest ?? null,
      source: ctx.source, note: input.note ?? null, qualification: input.qualification ?? null,
    })
    if (!saved) return null
    if (!ctx.prospectId) {
      ctx.prospectId = saved.id
      if (ctx.callId) {
        const { error } = await svc.from("platform_reception_calls")
          .update({ prospect_id: saved.id, outcome: "prospect_captured" }).eq("id", ctx.callId)
        if (error) console.error("[prospect-agent-tools] call ledger link refused:", error.message)
      }
    }
    return { id: saved.id, email: saved.email }
  }

  return {
    save_prospect: tool({
      description: "Save or update what you've learned about this prospect (the person evaluating the platform). Call it as soon as you learn anything — name, work email, company, size, role, current tools, pain, timeline, territory. Safe to call repeatedly; nothing is overwritten with blanks.",
      inputSchema: z.object({
        name: z.string().nullable().describe("Their name, or null"),
        email: z.string().nullable().describe("Their work email if they gave one, or null"),
        company: z.string().nullable().describe("Brokerage / team / company name, or null"),
        role_interest: z.enum(PROSPECT_ROLES).describe("What they run: solo_agent, team, brokerage, multi_location, or unknown"),
        size_seats: z.number().int().positive().nullable().describe("Rough agent / seat count, or null"),
        producers_count: z.number().int().positive().nullable().describe("Of those, how many actually produce (list and sell) — the priced seats; staff/admins ride free. Or null"),
        role_title: z.string().nullable().describe("Their role (broker-owner, team lead, ops, agent…), or null"),
        current_tools: z.string().nullable().describe("What they use today, or null"),
        pain: z.string().nullable().describe("What hurts, in their words, or null"),
        timeline: z.enum(PROSPECT_TIMELINE_BUCKETS).nullable().describe("When they want to be running, or null"),
        territory: z.string().nullable().describe("Markets / metros they work, or null"),
        preferred_path: z.enum(PROSPECT_PREFERRED_PATHS).nullable().describe("What they said would be most helpful next: demo, trial, paid (start now), callback, undecided — or null"),
        note: z.string().nullable().describe("One line on what they want, or null"),
      }),
      execute: async (a: { name: string | null; email: string | null; company: string | null; role_interest: string; size_seats: number | null; producers_count: number | null; role_title: string | null; current_tools: string | null; pain: string | null; timeline: string | null; territory: string | null; preferred_path: string | null; note: string | null }) => {
        const saved = await resolveProspect({
          email: a.email, name: a.name, company: a.company, roleInterest: a.role_interest, note: a.note,
          qualification: {
            brokerage_name: a.company, size_seats: a.size_seats, producers_count: a.producers_count, role_title: a.role_title,
            current_tools: a.current_tools, pain: a.pain, timeline: a.timeline as ProspectQualification["timeline"], territory: a.territory,
            preferred_path: a.preferred_path as ProspectQualification["preferred_path"],
          },
        })
        if (!saved) return { success: false, error: "Need at least a name with an email (or the caller's number) to save them — ask for their email." }
        return { success: true, saved: true, hasEmail: !!saved.email }
      },
    }),

    find_demo_slots: tool({
      description: "Find real, available times for a live product demo on a sales rep's calendar (next-day earliest). Call this BEFORE book_demo_appointment; offer 2-3 of the returned times in plain language and let them pick.",
      inputSchema: z.object({
        preferred_days: z.array(z.string()).nullable().describe("Weekday names they mentioned, or null"),
        preferred_window: z.enum(WINDOWS).nullable().describe("Time-of-day preference, or null"),
      }),
      execute: async ({ preferred_days, preferred_window }: { preferred_days: string[] | null; preferred_window: (typeof WINDOWS)[number] | null }) => {
        const { resolvePlatformSalesRep } = await import("@/lib/platform/sales-rep")
        const rep = await resolvePlatformSalesRep(svc)
        if (!rep) return { success: false, offerHandoff: true, message: "No sales rep is set up yet — take their details and offer a human follow-up." }
        const { findDemoAppointmentSlots } = await import("@/lib/ai-isa/listing-appointment")
        const result = await findDemoAppointmentSlots({ rep, preferredDays: preferred_days ?? undefined, preferredWindows: preferred_window ? [preferred_window] : undefined })
        if (!result.success) return { success: false, offerHandoff: true, message: result.message }
        return { success: true, slots: result.slots.map((s) => ({ start: s.startTime, end: s.endTime })), minDaysOut: result.minDaysOut }
      },
    }),

    book_demo_appointment: tool({
      description: "Book the live demo on the SLOT the prospect chose from find_demo_slots. Requires their email (the calendar invite goes there). A sales rep confirms it; do not call this before find_demo_slots has offered real times.",
      inputSchema: z.object({
        slot_start_iso: z.string().describe("The exact start time (ISO 8601) they picked from the offered slots"),
        slot_end_iso: z.string().describe("The matching end time (ISO 8601) from the same offered slot"),
        email: z.string().describe("Their work email — the invite goes here"),
        name: z.string().nullable().describe("Their name, or null"),
        company: z.string().nullable().describe("Their company, or null"),
        notes: z.string().nullable().describe("What they want to see, or null"),
      }),
      execute: async (a: { slot_start_iso: string; slot_end_iso: string; email: string; name: string | null; company: string | null; notes: string | null }) => {
        const prospect = await resolveProspect({ email: a.email, name: a.name, company: a.company, note: a.notes })
        if (!prospect) return { success: false, error: "Could not save the prospect — ask for a valid email first." }
        if (!prospect.email) return { success: false, error: "A valid email is required for the calendar invite — ask for it." }
        const { resolvePlatformSalesRep } = await import("@/lib/platform/sales-rep")
        const rep = await resolvePlatformSalesRep(svc)
        if (!rep) return { success: false, offerHandoff: true, error: "No sales rep is set up — offer a human follow-up instead." }
        const { bookDemoAppointment } = await import("@/lib/ai-isa/listing-appointment")
        const result = await bookDemoAppointment({
          prospectId: prospect.id, prospectName: a.name, company: a.company, rep,
          slot: { startTime: a.slot_start_iso, endTime: a.slot_end_iso }, notes: a.notes,
        })
        if (!result.success) return { success: false, error: result.error }
        return { success: true, startAt: result.startAt, pendingRepConfirmation: true, inviteGoesTo: prospect.email }
      },
    }),

    send_signup_link: tool({
      description: "Send the prospect the online signup link (free trial, no credit card) by text or email. Use when they'd rather start on their own than book a demo.",
      inputSchema: z.object({
        channel: z.enum(["sms", "email"]).describe("sms texts the number they're calling from; email needs their address"),
        email: z.string().nullable().describe("Their email when channel is email, or null"),
        name: z.string().nullable().describe("Their name, or null"),
      }),
      execute: async (a: { channel: "sms" | "email"; email: string | null; name: string | null }) => {
        const prospect = await resolveProspect({ email: a.email, name: a.name })
        if (!prospect) return { success: false, error: "Need an email (or the caller's number) to send the link — ask for it." }
        const { resolvePlatformSalesRep } = await import("@/lib/platform/sales-rep")
        const rep = await resolvePlatformSalesRep(svc)
        if (!rep) return { success: false, error: "The platform has no staff account to send from — take a message instead." }
        const url = brandCta(ctx.brand, ctx.source.replace(":", "_"), "ai_agent_signup_link")
        const { dispatchSms, dispatchEmail } = await import("@/lib/providers/dispatch")
        if (a.channel === "sms") {
          if (!ctx.phone) return { success: false, error: "No phone number on this conversation — send it by email instead." }
          const sent = await dispatchSms({
            to: ctx.phone, brokerageId: rep.brokerageId, userId: rep.userId,
            message: `${ctx.brand.name}: here's your signup link for the free trial — ${url} . Reply STOP to opt out.`,
            transactional: true, systemSource: "platform_prospect_signup_link",
          })
          if (!sent.success) return { success: false, error: sent.error ?? "Text could not be sent — offer to email it instead." }
        } else {
          if (!prospect.email) return { success: false, error: "A valid email is required — ask for it." }
          const sent = await dispatchEmail({
            to: prospect.email, brokerageId: rep.brokerageId, userId: rep.userId,
            subject: `Your ${ctx.brand.name} signup link`,
            html: `<p>Hi ${a.name ?? "there"},</p><p>Here's the link to start your free trial (no credit card): <a href="${url}">${url}</a></p>`,
            text: `Start your free trial (no credit card): ${url}`,
            channelPurpose: "transactional", systemSource: "platform_prospect_signup_link",
          })
          if (!sent.success) return { success: false, error: sent.error ?? "Email could not be sent — offer to text it instead." }
        }
        await markProspectSignupLinkSent(svc, { prospectId: prospect.id, channel: a.channel, url })
        return { success: true, channel: a.channel, url }
      },
    }),

    // ── Lane 79B — "call me back when I'm ready" (never chased meanwhile) ──
    schedule_prospect_callback: tool({
      description: "The prospect is interested but not ready to decide today — record when THEY want to be called back (their words: 'after our busy season', 'next Tuesday morning'). The automated follow-up ladder stands down for them until a person calls. Needs a name with an email, or the caller's number.",
      inputSchema: z.object({
        when: z.string().describe("When they'd like the callback, in their words"),
        reason: z.string().nullable().describe("Why not now — budget cycle, a partner to consult, busy season — or null"),
        email: z.string().nullable().describe("Their email if known, or null"),
        name: z.string().nullable().describe("Their name, or null"),
      }),
      execute: async (a: { when: string; reason: string | null; email: string | null; name: string | null }) => {
        const prospect = await resolveProspect({ email: a.email, name: a.name, note: a.reason, qualification: { preferred_path: "callback" } })
        if (!prospect) return { success: false, error: "Need a name with an email (or the caller's number) first." }
        const stamped = await markProspectCallback(svc, { prospectId: prospect.id, when: a.when, reason: a.reason, channel: ctx.source })
        if (!stamped) return { success: false, error: "The callback could not be recorded — say a person will follow up and call request_human_handoff." }
        return { success: true, callbackWhen: a.when }
      },
    }),

    request_human_handoff: tool({
      description: "Ask a real person on the team to follow up with this prospect (pricing, contracts, migration, or anything you can't answer). On a call, offer the live transfer first when one is available; this creates the follow-up task otherwise.",
      inputSchema: z.object({
        reason: z.string().describe("Why they want a person — one line"),
        best_time: z.string().nullable().describe("When they'd like to be reached, in their words, or null"),
        email: z.string().nullable().describe("Their email if known, or null"),
        name: z.string().nullable().describe("Their name, or null"),
      }),
      execute: async (a: { reason: string; best_time: string | null; email: string | null; name: string | null }) => {
        const prospect = await resolveProspect({ email: a.email, name: a.name, note: a.reason })
        if (!prospect) return { success: false, error: "Need a name with an email (or the caller's number) first." }
        const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
        const who = [a.name, prospect.email ?? ctx.phone].filter(Boolean).join(" — ") || "a prospect"
        const staffNotified = await notifyPlatformStaff(svc as never, {
          type: "platform_prospect_handoff",
          title: "A prospect asked for a person",
          body: `${who}: ${a.reason}${a.best_time ? ` (best time: ${a.best_time})` : ""}. See the growth board.`,
          entityType: "platform_prospect", entityId: prospect.id, priority: "high",
        })
        await markProspectHandoff(svc, { prospectId: prospect.id, reason: a.reason, bestTime: a.best_time, channel: ctx.source, staffNotified })
        return { success: true, staffNotified, liveTransferAvailable: ctx.hasLiveTransfer }
      },
    }),

    // ── Lane 77B — the prospect says YES: subscriber before the conversation ends ──
    start_subscription: tool({
      description: "Create the prospect's account RIGHT NOW because they said yes. activation 'trial' = a 14-day free trial (no card; billing is set up inside the app after sign-in). activation 'paid' = ACTIVATE NOW: a secure checkout for the plan plus the plan's one-time setup fee is emailed to them and their access opens when it clears (wave 78A — not everyone wants the trial). Requires their work email, name and business name. Pick the plan that fits their size unless they chose one. Never invent or waive the setup fee — the result tells you the exact amount to state. Answers needsHuman:true when a person must take it (enterprise size, custom pricing, CRM migration) — then hand off instead of retrying.",
      inputSchema: z.object({
        email: z.string().describe("Their work email — the sign-in link (and the checkout, when activating) goes here"),
        name: z.string().describe("Their full name"),
        company: z.string().nullable().describe("Brokerage / team / business name, or null to use what's on file"),
        plan: z.enum(["solo_agent", "team", "brokerage", "multi_location"]).nullable().describe("The plan they chose, or null to fit it to their size"),
        activation: z.enum(["trial", "paid"]).describe("'trial' = 14-day free trial, no card; 'paid' = activate now with checkout (plan + one-time setup fee)"),
        billing_cycle: z.enum(["monthly", "annual"]).nullable().describe("For 'paid' only: monthly or annual; null = monthly"),
        wants_custom_pricing: z.boolean().describe("True if they asked for a discount, a custom price, or a contract"),
      }),
      execute: async (a: { email: string; name: string; company: string | null; plan: "solo_agent" | "team" | "brokerage" | "multi_location" | null; activation: "trial" | "paid"; billing_cycle: "monthly" | "annual" | null; wants_custom_pricing: boolean }) => {
        const prospect = await resolveProspect({ email: a.email, name: a.name, company: a.company })
        if (!prospect) return { success: false, error: "Could not save the prospect — ask for a valid work email first." }
        if (!prospect.email) return { success: false, error: "A valid work email is required — the sign-in link goes there." }
        const { convertProspectToSubscriber } = await import("@/lib/platform/prospect-conversion")
        // THE PROSPECT'S STATED CHOICE drives trial vs paid. A chat/voice surface
        // never takes a card and never waives a fee (the conversion refuses both).
        const billing = a.activation === "paid"
          ? { mode: "paid" as const, billingCycle: a.billing_cycle === "annual" ? "annual" as const : "monthly" as const }
          : { mode: "trial" as const }
        const r = await convertProspectToSubscriber(svc, {
          prospectId: prospect.id,
          actor: { kind: "prospect_self", channel: ctx.source },
          tier: a.plan, billing,
          email: a.email, name: a.name, company: a.company,
          customPricingRequested: a.wants_custom_pricing,
        })
        if (!r.ok) {
          if (r.needsHuman?.length) return { success: false, needsHuman: true, reasons: r.needsHuman, error: r.error }
          return { success: false, error: r.error }
        }
        if (r.alreadyConverted) return { success: true, alreadyConverted: true, message: "They already have an account — tell them to check their email for the sign-in link or use request_human_handoff if they can't find it." }
        if (billing.mode === "trial") {
          return {
            success: true, activation: "trial", trial: true, plan: r.tier, trialEndsAt: r.trialEndsAt,
            signInLinkSentTo: prospect.email, inviteSent: r.inviteSent, inviteError: r.inviteError ?? null,
            nextStep: "Tell them the sign-in link is in their inbox, the trial is 14 days with no card, and billing is set up inside the app whenever they're ready.",
          }
        }
        // PAID: send the hosted checkout. TOMBSTONE (lane 79D): the rep lookup +
        // dispatchEmail + copy that stood here was the ONLY sender of the
        // activation checkout — the self-serve door and the staff convert door
        // had none. Survivor: lib/platform/subscriber-door.ts::
        // sendActivationCheckoutEmail (same rep sender, same egress survivor,
        // same copy), now called by all three entrances.
        const setupFeeText = r.setupFeeCents && r.setupFeeCents > 0 ? `$${(r.setupFeeCents / 100).toLocaleString("en-US")}` : null
        let checkoutSent = false
        let checkoutSendError: string | null = null
        if (r.checkoutUrl) {
          const { sendActivationCheckoutEmail } = await import("@/lib/platform/subscriber-door")
          const sent = await sendActivationCheckoutEmail(svc, {
            to: prospect.email, firstName: a.name.split(/\s+/)[0] || a.name, brandName: ctx.brand.name,
            tier: String(r.tier), billingCycle: billing.billingCycle, checkoutUrl: r.checkoutUrl,
            setupFeeCents: r.setupFeeCents ?? null, setupFeeWaived: r.setupFeeWaived,
          })
          checkoutSent = sent.sent
          if (!sent.sent) checkoutSendError = sent.error
        }
        return {
          success: true, activation: "paid", trial: false, plan: r.tier, billingCycle: billing.billingCycle,
          setupFeeCents: r.setupFeeCents ?? 0, setupFee: setupFeeText,
          checkoutCreated: !!r.checkoutUrl, checkoutSent, checkoutSendError, checkoutError: r.checkoutError ?? null,
          signInLinkSentTo: prospect.email, inviteSent: r.inviteSent, inviteError: r.inviteError ?? null,
          nextStep: r.checkoutUrl
            ? (checkoutSent
              ? `Tell them the activation checkout is in their inbox — the ${billing.billingCycle} plan${setupFeeText ? ` plus a one-time ${setupFeeText} setup fee` : " (this plan lists no setup fee)"} — and their workspace opens the moment it clears; the sign-in link arrives separately.`
              : "The checkout was created but could not be emailed — tell them a person will send the activation link shortly and call request_human_handoff.")
            : "The account exists but the checkout could not be created right now — tell them they can activate from the billing page after signing in, or call request_human_handoff so a person sends the link.",
        }
      },
    }),

    // ── Lane 77B — the demo the live agent IS ──────────────────────────────────
    show_product_demo: tool({
      description: "Walk the prospect through what the product does for one topic (overview, reception_isa, live_agent, video_marketing, deals_portal, recruiting_ops), grounded in the real capability catalogue and the live plans. Returns the beats to say in your own words and, on a visual surface, a clipToken (sample clip) and/or a stillToken (a screenshot of that part of the OS on the demo tenant) to append verbatim so the widget shows them. Free — never renders anything.",
      inputSchema: z.object({
        topic: z.enum(["overview", "reception_isa", "live_agent", "video_marketing", "deals_portal", "recruiting_ops"]).describe("The closest topic to what they asked about"),
      }),
      execute: async ({ topic }: { topic: string }) => {
        const { describeProductDemo, isProductDemoTopic } = await import("@/lib/platform/product-demo")
        const { CAPABILITY_CATALOGUE } = await import("@/lib/ai-isa/capability-catalogue")
        const { loadPublicTiers } = await import("@/lib/platform/public-tiers")
        // Lane 78B — the demo STILL: a pre-captured screenshot of the demo
        // tenant's own surface for this topic (OS surfaces only — the lookup
        // filters screenshot_kind='os_surface'; never a third-party page).
        const { demoStillForTopic } = await import("@/lib/assets/screenshot-capture")
        const [tiers, stillUrl] = await Promise.all([
          loadPublicTiers(svc).catch(() => []),
          isProductDemoTopic(topic) ? demoStillForTopic(svc, topic).catch(() => null) : Promise.resolve(null),
        ])
        const featured = tiers.find((t) => t.featured) ?? tiers[0]
        const demo = describeProductDemo(topic, {
          brandName: ctx.brand.name,
          tierBullets: featured?.bullets ?? [],
          clipUrl: ctx.brand.liveAgent.demoClipUrl,
          stillUrl,
          surfaceCanShowClip: ctx.source !== "phone:reception",
        }, CAPABILITY_CATALOGUE)
        return { success: true, ...demo }
      },
    }),
  }
}
