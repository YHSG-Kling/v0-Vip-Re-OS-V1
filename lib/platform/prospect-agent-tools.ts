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
  upsertPlatformProspect, markProspectHandoff, markProspectSignupLinkSent,
  PROSPECT_TIMELINE_BUCKETS, type ProspectQualification,
} from "@/lib/platform/prospect-capture"

export const PLATFORM_PROSPECT_TOOL_NAMES = [
  "save_prospect",
  "find_demo_slots",
  "book_demo_appointment",
  "send_signup_link",
  "request_human_handoff",
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
  /** Channel attribution written to platform_prospects.source on first touch. */
  source: "phone:reception" | "web:prospect_chat"
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
        role_title: z.string().nullable().describe("Their role (broker-owner, team lead, ops, agent…), or null"),
        current_tools: z.string().nullable().describe("What they use today, or null"),
        pain: z.string().nullable().describe("What hurts, in their words, or null"),
        timeline: z.enum(PROSPECT_TIMELINE_BUCKETS).nullable().describe("When they want to be running, or null"),
        territory: z.string().nullable().describe("Markets / metros they work, or null"),
        note: z.string().nullable().describe("One line on what they want, or null"),
      }),
      execute: async (a: { name: string | null; email: string | null; company: string | null; role_interest: string; size_seats: number | null; role_title: string | null; current_tools: string | null; pain: string | null; timeline: string | null; territory: string | null; note: string | null }) => {
        const saved = await resolveProspect({
          email: a.email, name: a.name, company: a.company, roleInterest: a.role_interest, note: a.note,
          qualification: {
            brokerage_name: a.company, size_seats: a.size_seats, role_title: a.role_title,
            current_tools: a.current_tools, pain: a.pain, timeline: a.timeline as ProspectQualification["timeline"], territory: a.territory,
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
  }
}
