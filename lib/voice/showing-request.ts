// lib/voice/showing-request.ts
//
// VOICE SHOWING REQUEST (round 36) — the spoken form of the canonical
// BBA-gated showing request. "Schedule a showing for Maria at 44 Birch on
// Saturday at 2" lands in app/actions/showings.requestShowing — the SAME
// insert + notification chain the buyer portal and agent dashboard use — via
// the action's sessionless-caller overload. Never a forked insert.
//
// Guards, in order (equivalent-or-stricter than the click path):
//   1. contact must exist in the session's brokerage (tenant anchor);
//   2. ownership — only the contact's assigned agent, or the override roles
//      (broker/broker_admin/admin/superadmin/team_lead), may schedule for
//      them (the SAME rule the tool-call route's requireContactOwnership
//      applies to every NAR-regulated artifact);
//   3. the NAR-2024 BBA gate runs INSIDE requestShowing (requireActiveBBA,
//      fails closed) — the voice lane cannot bypass it, and a block is
//      spoken back honestly.
//
// Dates/times resolve through the PURE spoken-value helpers — conservative:
// an unresolvable date or time asks the speaker instead of guessing.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveSpokenDate, resolveSpokenTime } from "./spoken-values"

type Svc = ReturnType<typeof createServiceClient>

const OWNERSHIP_OVERRIDE_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

export interface VoiceShowingRequestInput {
  brokerageId: string
  /** users.id of the speaking staff user. */
  actorUserId: string
  contactId?: string | null
  personQuery?: string | null
  propertyAddress?: string | null
  listingId?: string | null
  dateText?: string | null
  timeText?: string | null
  notes?: string | null
  /** Injectable "today" for deterministic tests. */
  todayISO?: string | null
}

export interface VoiceShowingRequestResult {
  ok: boolean
  spoken: string
  data?: Record<string, unknown>
}

export async function voiceRequestShowing(
  input: VoiceShowingRequestInput,
  client?: Svc,
): Promise<VoiceShowingRequestResult> {
  const svc = client ?? createServiceClient()
  if (!input.brokerageId || !input.actorUserId) return { ok: false, spoken: "I can't tell who's asking — reopen the assistant and try again." }

  // ── Resolve the buyer contact (explicit id, else unique in-tenancy name match) ──
  let contactId = (input.contactId ?? "").trim() || null
  type ContactRow = { id: string; first_name: string | null; last_name: string | null; agent_id: string | null }
  let contact: ContactRow | null = null
  if (contactId) {
    const { data } = await svc
      .from("contacts")
      .select("id, first_name, last_name, agent_id")
      .eq("id", contactId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()
    contact = (data as ContactRow | null) ?? null
    if (!contact) return { ok: false, spoken: "I couldn't find that contact in your brokerage." }
  } else {
    const name = (input.personQuery ?? "").trim()
    if (name.length < 2) return { ok: false, spoken: "Who's the showing for? Give me the buyer's name." }
    const { data } = await svc
      .from("contacts")
      .select("id, first_name, last_name, agent_id")
      .eq("brokerage_id", input.brokerageId)
      .or(`first_name.ilike.%${name}%,last_name.ilike.%${name}%,last_name.ilike.%${name.split(/\s+/).pop()}%`)
      .limit(5)
    const rows = (data ?? []) as ContactRow[]
    const toks = name.toLowerCase().split(/\s+/)
    const scored = rows.filter((r) => {
      const full = `${r.first_name ?? ""} ${r.last_name ?? ""}`.toLowerCase()
      return toks.every((t) => full.includes(t.replace(/s$/i, "")) || full.includes(t))
    })
    const pick = scored.length > 0 ? scored : rows
    if (pick.length === 0) return { ok: false, spoken: `I don't see a contact matching "${name}" in your brokerage.` }
    if (pick.length > 1) return { ok: false, spoken: `There are ${pick.length} contacts matching "${name}" — give me the full name.` }
    contact = pick[0]
    contactId = contact.id
  }

  // ── Ownership — assigned agent or override roles (mirrors requireContactOwnership) ──
  const { data: actorRow } = await svc
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", input.actorUserId)
    .maybeSingle()
  if (!actorRow) return { ok: false, spoken: "Acting user not found." }
  const userType = String((actorRow as { user_type?: string | null }).user_type ?? "agent")
  if ((actorRow as { brokerage_id?: string | null }).brokerage_id !== input.brokerageId) {
    return { ok: false, spoken: "Your account isn't in this brokerage." }
  }
  if (!contact!.agent_id) {
    return { ok: false, spoken: `${contact!.first_name ?? "This contact"} has no assigned agent yet — assign one in the CRM before scheduling showings.` }
  }
  if (!OWNERSHIP_OVERRIDE_ROLES.has(userType)) {
    const { data: agentRow } = await svc
      .from("agents")
      .select("id")
      .eq("user_id", input.actorUserId)
      .maybeSingle()
    const myAgentId = (agentRow as { id?: string } | null)?.id ?? null
    if (!myAgentId || myAgentId !== contact!.agent_id) {
      return { ok: false, spoken: `${contact!.first_name ?? "This contact"} is assigned to a different agent — only their assigned agent (or a broker) can schedule showings for them.` }
    }
  }

  // ── Property + date/time (conservative — ask, never guess) ──
  const propertyAddress = (input.propertyAddress ?? "").trim()
  if (propertyAddress.length < 3) return { ok: false, spoken: "Which property? Give me the address." }

  const todayISO = (input.todayISO ?? new Date().toISOString().slice(0, 10))
  const date = resolveSpokenDate(input.dateText, todayISO)
  if (!date) return { ok: false, spoken: "Which day? Say a date like Saturday, tomorrow, or July 25th as month slash day." }
  const time = resolveSpokenTime(input.timeText)
  if (!time) return { ok: false, spoken: "What time? Say something like 2 p.m. or 10 30 a.m." }

  // Best-effort in-house match: when the address uniquely matches one of OUR
  // listings, link it so the listing agent + seller get their notifications.
  let listingId = (input.listingId ?? "").trim() || null
  if (!listingId) {
    const { data: listings } = await svc
      .from("listings")
      .select("id, address")
      .eq("brokerage_id", input.brokerageId)
      .ilike("address", `%${propertyAddress}%`)
      .is("deleted_at", null)
      .limit(2)
    const rows = (listings ?? []) as Array<{ id: string; address: string | null }>
    if (rows.length === 1) listingId = rows[0].id
  }

  // ── The CANONICAL action — sessionless-caller overload; the NAR BBA gate
  //    inside fails closed and its refusal is spoken back honestly. ──
  const { requestShowing } = await import("@/app/actions/showings")
  const res = await requestShowing(
    {
      contactId: contactId!,
      listingId: listingId ?? undefined,
      propertyAddress,
      preferredDates: [{ date, time }],
      clientNotes: input.notes?.trim() || undefined,
      source: "agent_input",
    },
    { client: svc, actorUserId: input.actorUserId },
  )

  const buyerName = `${contact!.first_name ?? ""} ${contact!.last_name ?? ""}`.trim() || "the buyer"
  if (!res.success) {
    if ((res as { errorCode?: string }).errorCode === "bba_required") {
      return {
        ok: false,
        spoken: `I can't schedule that yet — ${buyerName} doesn't have a signed Buyer Broker Agreement with their agent, and NAR rules require one before showings. Stage a BBA first and I'll take it from there.`,
        data: { blocked_by: "bba_required", contact_id: contactId },
      }
    }
    return { ok: false, spoken: `The showing request didn't go through: ${res.error ?? "unknown error"}.` }
  }

  // Voice-origin receipt on the manager bus (the webhook logs the tool call row).
  try {
    const { surfaceVoiceActionOnBus } = await import("@/lib/voice/voice-bus")
    await surfaceVoiceActionOnBus({
      brokerageId: input.brokerageId,
      tool: "stage_showing",
      message: `Voice admin requested a showing for ${buyerName} at ${propertyAddress} (${date} ${time}) — canonical requestShowing (BBA gate passed)`,
      entityType: "showing_request",
      entityId: (res.data as { id?: string } | undefined)?.id ?? null,
      contactId,
      payload: { date, time, listing_id: listingId },
    }, svc)
  } catch { /* visibility best-effort */ }

  return {
    ok: true,
    spoken: `Done — showing requested for ${buyerName} at ${propertyAddress} on ${date} at ${time}. It's pending confirmation; the request is on the agent's feed${listingId ? " and the listing side was notified too" : ""}.`,
    data: { showing_request_id: (res.data as { id?: string } | undefined)?.id ?? null, contact_id: contactId, listing_id: listingId, date, time },
  }
}
