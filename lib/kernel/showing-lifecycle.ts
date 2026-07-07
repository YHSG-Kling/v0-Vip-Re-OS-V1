// lib/kernel/showing-lifecycle.ts
// ─────────────────────────────────────────────────────────────────────────────
// SHOWING LIFECYCLE AUTOPILOT — the two manual gaps the tour audit ranked #1
// and #3, closed with ONE sweep:
//   (a) FEEDBACK AUTO-REQUEST — the token route + public form + request table
//       all existed; SENDING was manual-only. Every completed showing now gets
//       ONE feedback request (deterministic form — no LLM in the cron path),
//       delivered where the buyer already reads: the portal thread, with the
//       public tokenized form link. Deduped per showing by the request row.
//   (b) BUYER T-24h REMINDER — agents had T-30 whisper briefings; the BUYER had
//       nothing. Confirmed showings 20–28h out get ONE portal reminder (+
//       best-effort TCPA-gated SMS from the tenant's own number — a scheduled
//       showing reminder is transactional: DNC/quiet-hours still enforced).
//       Deduped per showing via client_portal_messages.metadata.
//   (c) VIRTUAL TOUR woven in (audit #4): when the listing carries a
//       virtual_tour_url/matterport_url, the reminder invites a pre-visit walk-
//       through — the static link finally works for the buyer journey.
// ShowingTime (#2) decision, recorded: the schema stays (sync-in vocabulary,
// scheduling_method 'showingtime'), the phantom webhook expectation is retired —
// wiring requires a ShowingTime partnership; nothing pretends otherwise.

import { randomUUID } from "node:crypto"

export interface ShowingLifecycleResult {
  feedbackRequested: number
  remindersSent: number
  smsSent: number
  skipped: number
  errors: number
}

/** PURE: the reminder copy — plain, warm, virtual-tour aware. */
export function composeShowingReminder(
  address: string, whenIso: string, virtualTourUrl?: string | null,
): string {
  const when = new Date(whenIso)
  const day = when.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
  const time = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  const tour = virtualTourUrl ? ` Want a head start? Walk it virtually first: ${virtualTourUrl}` : ""
  return `Reminder: your showing at ${address} is ${day} at ${time}.${tour} Reply here if anything changes.`
}

/** PURE: the feedback ask that rides the portal thread with the tokenized link. */
export function composeFeedbackAsk(address: string, formUrl: string): string {
  return `How was ${address}? Two taps of honest feedback helps your agent zero in on the right home: ${formUrl}`
}

/** The sweep — rides the cron dispatcher hourly. */
export async function runShowingLifecycle(svc: any, now: Date = new Date()): Promise<ShowingLifecycleResult> {
  const r: ShowingLifecycleResult = { feedbackRequested: 0, remindersSent: 0, smsSent: 0, skipped: 0, errors: 0 }
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")

  // ── (a) Feedback auto-request: completed in the last 48h, none sent yet ────
  const { data: completed } = await svc.from("showings")
    .select("id, brokerage_id, contact_id, agent_id, listing_id, completed_at, listings(address), contacts(email, first_name)")
    .not("completed_at", "is", null)
    .gte("completed_at", new Date(now.getTime() - 48 * 3_600_000).toISOString())
    .limit(200)
  for (const s of (completed ?? []) as any[]) {
    try {
      const { data: existing } = await svc.from("showing_feedback_requests")
        .select("id").eq("showing_id", s.id).limit(1).maybeSingle()
      if (existing) { r.skipped += 1; continue }
      const token = randomUUID()
      const address = s.listings?.address ?? "the home you toured"
      const { error } = await svc.from("showing_feedback_requests").insert({
        showing_id: s.id, brokerage_id: s.brokerage_id,
        feedback_token: token, sent_at: now.toISOString(),
        sent_to_email: s.contacts?.email ?? null,
        ai_analysis: { source: "showing-lifecycle-cron", form: "standard" },
      })
      if (error) { r.errors += 1; continue }
      // agent_id: NOT NULL FK to agents.id (the showing's agent); direction
      // CHECK is agent_to_client — validated live.
      if (s.contact_id && s.agent_id && appUrl) {
        await svc.from("client_portal_messages").insert({
          contact_id: s.contact_id, brokerage_id: s.brokerage_id, agent_id: s.agent_id,
          direction: "agent_to_client", channel: "portal",
          body: composeFeedbackAsk(address, `${appUrl}/showings/feedback/${token}`),
          metadata: { kind: "showing_feedback_ask", showing_id: s.id },
        }).then(undefined, () => {})
      }
      r.feedbackRequested += 1
    } catch { r.errors += 1 }
  }

  // ── (b) Buyer T-24h reminder: confirmed, 20–28h out, not yet reminded ─────
  const from = new Date(now.getTime() + 20 * 3_600_000).toISOString()
  const to = new Date(now.getTime() + 28 * 3_600_000).toISOString()
  const { data: upcoming } = await svc.from("showings")
    .select("id, brokerage_id, contact_id, agent_id, scheduled_at, is_confirmed, listings(address, virtual_tour_url, matterport_url), contacts(phone, first_name)")
    .gte("scheduled_at", from).lte("scheduled_at", to)
    .eq("is_confirmed", true).in("status", ["scheduled", "confirmed"]).limit(200)
  for (const s of (upcoming ?? []) as any[]) {
    try {
      if (!s.contact_id || !s.agent_id) { r.skipped += 1; continue }
      const { data: already } = await svc.from("client_portal_messages")
        .select("id").eq("contact_id", s.contact_id)
        .contains("metadata", { kind: "showing_reminder", showing_id: s.id }).limit(1).maybeSingle()
      if (already) { r.skipped += 1; continue }
      const address = s.listings?.address ?? "your showing"
      const tourUrl = s.listings?.virtual_tour_url ?? s.listings?.matterport_url ?? null
      const body = composeShowingReminder(address, s.scheduled_at, tourUrl)
      const { error } = await svc.from("client_portal_messages").insert({
        contact_id: s.contact_id, brokerage_id: s.brokerage_id, agent_id: s.agent_id,
        direction: "agent_to_client", channel: "portal", body,
        metadata: { kind: "showing_reminder", showing_id: s.id },
      })
      if (error) { r.errors += 1; continue }
      r.remindersSent += 1

      // SMS best-effort — TRANSACTIONAL (a reminder for a showing the buyer
      // booked): EWC skipped per TCPA, but DNC/quiet-hours/opt-out still
      // enforced inside sendSMS. From the tenant's own number.
      if (s.contacts?.phone) {
        try {
          const { sendSMS } = await import("@/lib/providers/messaging")
          const sent = await sendSMS({
            to: s.contacts.phone, message: body,
            contactId: s.contact_id, brokerageId: s.brokerage_id, transactional: true,
          })
          if (sent.success) r.smsSent += 1
        } catch { /* the portal reminder already landed */ }
      }
    } catch { r.errors += 1 }
  }

  return r
}
