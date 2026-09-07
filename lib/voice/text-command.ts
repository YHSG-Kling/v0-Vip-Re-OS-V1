// lib/voice/text-command.ts
// ─────────────────────────────────────────────────────────────────────────────
// TEXT AN ACTION — a staff phone texts the brokerage's own number and the whole
// AI team is on standby.
//
// Owner, 2026-09-06: "halo has a very easy way to text some sort of action with
// 30+ agents on standby … each capability should be used autonomously as much
// as you can in this agentic saas os."
//
// WHAT EXISTED (§1 — this is a THIRD FRONT-END, not a second brain):
//   · app/api/internal/voice-command/route.ts — the ONE classifier + dispatcher
//     that turns a sentence into a team action (30 intents: standup, area query,
//     cut a promo, launch a campaign, closings at risk, book a studio session,
//     …). Two front-ends already call it: the Command Center text bar and the
//     spoken admin. It authenticates by SESSION COOKIE, which a Twilio webhook
//     does not carry.
//   · app/api/providers/inbound/route.ts — the ONE inbound SMS ingress. Every
//     texter was treated as a CONTACT or LEAD: a staff member texting their own
//     number was captured as a new contact assigned to themselves.
//   · lib/providers/dispatch dispatchSms — the ONE governed outbound SMS egress.
//
// This module is the wire: recognise a STAFF sender by phone inside the tenant
// the called number belongs to, hand the text to the same voice-command brain
// through a same-origin self-call authenticated by the cron secret (the route
// accepts `x-acting-user-id` ONLY under that secret, and resolves everything
// else — profile, agent, authority — exactly as it does for a session), and
// text the spoken answer back. No classifier, no intent list, no dispatch logic
// lives here.
//
// FAIL CLOSED (§4): a refused users read is "not a staff phone" (the text then
// takes the contact path, which is what it took before); a missing CRON_SECRET
// or site URL is reported and the command is NOT run; the reply goes only to
// the phone that sent the command.
import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

export interface StaffTextCommandInput {
  brokerageId: string
  fromPhone:   string
  toPhone:     string | null
  text:        string
  messageSid:  string | null
}

export interface StaffTextCommandResult {
  /** True when the sender was staff and the command was run (or refused with a reply). */
  handled:  boolean
  intent?:  string | null
  reason?:  string | null
}

/** users.user_type values that may command the team by text. Contacts, vendors and
 *  lenders text the same number as CUSTOMERS and stay on the contact path. */
const STAFF_USER_TYPES = new Set([
  "agent", "isa", "tc", "team_lead", "broker", "broker_admin", "broker_owner", "admin", "compliance_officer",
])

function last10(phone: string): string {
  const d = phone.replace(/\D/g, "")
  return d.length > 10 ? d.slice(-10) : d
}

/**
 * Resolve which STAFF user in this brokerage owns the sending phone. Reads
 * users.phone (the seat's own number) — agents.phone_mobile is the same person's
 * profile and is consulted second. Returns null for a non-staff or unknown phone
 * and on a refused read (logged), so the caller falls through to the contact path.
 */
async function resolveStaffByPhone(
  svc: SupabaseClient,
  brokerageId: string,
  fromPhone: string,
): Promise<{ userId: string; userType: string; firstName: string | null } | null> {
  const digits = last10(fromPhone)
  if (digits.length < 7) return null

  const { data: users, error } = await svc
    .from("users")
    .select("id, user_type, first_name, phone")
    .eq("brokerage_id", brokerageId)
    .not("phone", "is", null)
  if (error) {
    console.error(`[text-command] users read refused (${error.message}); the text takes the contact path`)
    return null
  }
  const hit = ((users ?? []) as Array<{ id: string; user_type: string | null; first_name: string | null; phone: string | null }>)
    .find((u) => u.phone && last10(u.phone) === digits && STAFF_USER_TYPES.has(u.user_type ?? ""))
  if (hit) return { userId: hit.id, userType: hit.user_type ?? "", firstName: hit.first_name }

  // Second door: the agent profile's mobile. agents.user_id → users.id (§3: the two ids are disjoint).
  const { data: agents, error: agentErr } = await svc
    .from("agents")
    .select("user_id, phone_mobile, users!inner(user_type, first_name)")
    .eq("brokerage_id", brokerageId)
    .not("phone_mobile", "is", null)
  if (agentErr) {
    console.error(`[text-command] agents read refused (${agentErr.message}); the text takes the contact path`)
    return null
  }
  type UserBits = { user_type: string | null; first_name: string | null }
  type AgentRow = { user_id: string | null; phone_mobile: string | null; users: UserBits | UserBits[] | null }
  // supabase-js types an embedded parent as an array even for a to-one embed; read either shape.
  const rows = (agents ?? []) as unknown as AgentRow[]
  const userBits = (r: AgentRow): UserBits | null => (Array.isArray(r.users) ? r.users[0] ?? null : r.users)
  const a = rows.find((r) => r.user_id && r.phone_mobile && last10(r.phone_mobile) === digits && STAFF_USER_TYPES.has(userBits(r)?.user_type ?? ""))
  if (a && a.user_id) return { userId: a.user_id, userType: userBits(a)?.user_type ?? "", firstName: userBits(a)?.first_name ?? null }
  return null
}

/**
 * Run one texted command. Returns handled:false when the sender is not staff so
 * the ingress continues down its contact path unchanged.
 */
export async function runStaffTextCommand(
  svc: SupabaseClient,
  input: StaffTextCommandInput,
): Promise<StaffTextCommandResult> {
  const text = input.text.trim()
  if (!text) return { handled: false, reason: "empty text" }

  const staff = await resolveStaffByPhone(svc, input.brokerageId, input.fromPhone)
  if (!staff) return { handled: false, reason: "sender is not a staff phone in this brokerage" }

  // ONCE PER TEXT. Twilio retries a webhook it did not get a 2xx for, and the
  // contact path dedupes by MessageSid inside recordInboundMessage; this path
  // never records a messages row, so it dedupes on the ledger the brain writes:
  // the same staff user, the same transcript, inside the last two minutes is a
  // retry, not a second command. A refused read is NOT treated as "not a
  // duplicate" silently — it is logged and the command still runs once.
  {
    const { data: recent, error: recentErr } = await svc
      .from("voice_commands")
      .select("id")
      .eq("brokerage_id", input.brokerageId)
      .eq("user_id", staff.userId)
      .eq("raw_transcript", text)
      .gte("created_at", new Date(Date.now() - 2 * 60 * 1000).toISOString())
      .limit(1)
    if (recentErr) console.error(`[text-command] duplicate check refused (${recentErr.message}); running the command once`)
    else if (recent && recent.length > 0) return { handled: true, intent: null, reason: "duplicate delivery of a command already run" }
  }

  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error("[text-command] CRON_SECRET not configured — the team command cannot be run")
    return { handled: true, intent: null, reason: "internal secret not configured" }
  }
  const { siteUrl } = await import("@/lib/platform/site-url")
  const base = siteUrl()
  if (!base) {
    console.error("[text-command] no site URL (NEXT_PUBLIC_APP_URL / VERCEL_URL) — the team command cannot be run")
    return { handled: true, intent: null, reason: "site url not configured" }
  }

  // THE ONE BRAIN, same-origin. The route resolves profile + agent + authority for
  // the acting user itself; this caller only vouches for WHO texted.
  let spoken = "I couldn't run that just now. Try again in a moment."
  let intent: string | null = null
  try {
    const res = await fetch(`${base}/api/internal/voice-command`, {
      method:  "POST",
      headers: {
        "content-type":     "application/json",
        "authorization":    `Bearer ${secret}`,
        "x-acting-user-id": staff.userId,
      },
      body: JSON.stringify({ transcript: text, surface: "sms" }),
    })
    const payload = (await res.json().catch(() => null)) as { spokenResponse?: string; intent?: string; spoken?: string; error?: string } | null
    if (res.ok && payload?.spokenResponse) {
      spoken = payload.spokenResponse
      intent = payload.intent ?? null
    } else {
      console.error(`[text-command] voice-command refused (${res.status}): ${payload?.error ?? payload?.spoken ?? "no body"}`)
      if (payload?.spoken) spoken = payload.spoken
    }
  } catch (err) {
    console.error("[text-command] voice-command self-call failed:", (err as Error).message)
  }

  // Text the answer back to the phone that asked — through the GOVERNED egress
  // (lib/providers/dispatch.ts), never the raw sender: the autonomy gate, the
  // vendor-budget ceiling, the fair-housing scan and the TCPA gate all sit
  // there. A staff member commanding their own team is a recipient-initiated,
  // transactional reply, which is the carve-out the dispatcher already
  // recognises; DNC and quiet hours stay enforced and a refusal is READ.
  try {
    const { dispatchSms } = await import("@/lib/providers/dispatch")
    const r = await dispatchSms({
      brokerageId:   input.brokerageId,
      userId:        staff.userId,
      systemSource:  "text_command",
      to:            input.fromPhone,
      message:       spoken.slice(0, 1500),
      transactional: true,
      metadata:      { intent, message_sid: input.messageSid },
    })
    if (!r.success) console.error(`[text-command] reply to ${last10(input.fromPhone)} not sent (${r.providerKey}): ${r.error ?? "no reason"}`)
  } catch (err) {
    console.error("[text-command] reply send failed:", (err as Error).message)
  }

  return { handled: true, intent, reason: null }
}
