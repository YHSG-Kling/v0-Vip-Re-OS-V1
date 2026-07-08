// lib/kernel/overnight-digest.ts
// ─────────────────────────────────────────────────────────────────────────────
// "YOUR AI ANSWERED WHILE YOU SLEPT" — the morning proof-of-work. Overnight,
// the reception AI answers calls, books showings, RSVPs open houses, captures
// seller hand-raises, and proposes hot callbacks; the texting rail collects
// inbound messages. All of it already lands in ledgers — this narrates it as
// the FIRST notification of the agent's day, when they care most. Honest by
// construction: every number traces to rows in the window; a silent night
// sends NOTHING (the digest never pads); deduped per agent per day.

export interface OvernightActivity {
  callsAnswered: number
  bookings: number
  rsvps: number
  sellerLeads: number
  hotCallbacks: number
  textsReceived: number
}

/** PURE: the digest line — "" on a silent night. */
export function composeOvernightDigest(a: OvernightActivity): string {
  const total = a.callsAnswered + a.bookings + a.rsvps + a.sellerLeads + a.hotCallbacks + a.textsReceived
  if (total === 0) return ""
  const parts: string[] = []
  if (a.callsAnswered > 0) parts.push(`answered ${a.callsAnswered} call${a.callsAnswered === 1 ? "" : "s"}`)
  if (a.textsReceived > 0) parts.push(`took ${a.textsReceived} text${a.textsReceived === 1 ? "" : "s"} into your inbox`)
  if (a.bookings > 0) parts.push(`booked ${a.bookings} appointment${a.bookings === 1 ? "" : "s"}`)
  if (a.rsvps > 0) parts.push(`RSVP'd ${a.rsvps} guest${a.rsvps === 1 ? "" : "s"} to open houses`)
  const lines = [`While you were off the clock, your AI ${parts.length > 0 ? parts.join(", ") : "kept watch"}.`]
  if (a.sellerLeads > 0) lines.push(`${a.sellerLeads} caller${a.sellerLeads === 1 ? "" : "s"} asked what their home is worth — CMA proposal${a.sellerLeads === 1 ? " is" : "s are"} waiting for your approval.`)
  if (a.hotCallbacks > 0) lines.push(`${a.hotCallbacks} hot call${a.hotCallbacks === 1 ? "" : "s"} scored urgent — same-day callback${a.hotCallbacks === 1 ? "" : "s"} queued at the top of your plan.`)
  return lines.join(" ")
}

export interface OvernightDigestResult { agents: number; digested: number; silent: number; errors: number }

/** Morning runner: per active agent, fold the last 12h of AI work → ONE
 *  notification (deduped per ISO day; silent nights send nothing). */
export async function runOvernightDigest(svc: any, now: Date = new Date()): Promise<OvernightDigestResult> {
  const r: OvernightDigestResult = { agents: 0, digested: 0, silent: 0, errors: 0 }
  const since = new Date(now.getTime() - 12 * 3_600_000).toISOString()
  const day = now.toISOString().slice(0, 10)

  const { data: agents } = await svc.from("agents")
    .select("id, user_id, brokerage_id, is_active").eq("is_active", true).limit(5000)

  for (const a of (agents ?? []) as any[]) {
    r.agents += 1
    try {
      if (!a.user_id || !a.brokerage_id) { r.silent += 1; continue }

      const [calls, bookings, rsvps, sellerLeads, hotCallbacks, texts, already] = await Promise.all([
        svc.from("voice_calls").select("id", { count: "exact", head: true })
          .eq("brokerage_id", a.brokerage_id).eq("agent_id", a.id).eq("direction", "inbound").gte("started_at", since),
        svc.from("showings").select("id", { count: "exact", head: true })
          .eq("brokerage_id", a.brokerage_id).eq("agent_id", a.id).gte("created_at", since)
          .ilike("notes", "%AI receptionist%"),
        svc.from("open_house_rsvp_tracking").select("id", { count: "exact", head: true })
          .eq("brokerage_id", a.brokerage_id).eq("source", "ai_reception").gte("created_at", since),
        svc.from("agent_client_messages").select("id", { count: "exact", head: true })
          .eq("brokerage_id", a.brokerage_id).ilike("rationale", "[SELLER_LEAD]%").gte("created_at", since),
        svc.from("agent_client_messages").select("id", { count: "exact", head: true })
          .eq("brokerage_id", a.brokerage_id).ilike("rationale", "[HOT_CALL]%").gte("created_at", since),
        svc.from("messages").select("id", { count: "exact", head: true })
          .eq("brokerage_id", a.brokerage_id).eq("agent_id", a.id).eq("direction", "inbound")
          .eq("type", "sms").gte("created_at", since),
        svc.from("notifications").select("id")
          .eq("user_id", a.user_id).eq("type", "overnight_ai_digest")
          .ilike("body", `%[${day}]%`).limit(1).maybeSingle(),
      ])
      if ((already as any)?.data) { r.silent += 1; continue }

      const digest = composeOvernightDigest({
        callsAnswered: (calls as any)?.count ?? 0,
        bookings: (bookings as any)?.count ?? 0,
        rsvps: (rsvps as any)?.count ?? 0,
        sellerLeads: (sellerLeads as any)?.count ?? 0,
        hotCallbacks: (hotCallbacks as any)?.count ?? 0,
        textsReceived: (texts as any)?.count ?? 0,
      })
      if (!digest) { r.silent += 1; continue }

      await svc.from("notifications").insert({
        user_id: a.user_id, brokerage_id: a.brokerage_id, type: "overnight_ai_digest",
        title: "Your AI answered while you slept",
        body: `${digest} [${day}]`.slice(0, 480),
        priority: "medium", channel: "in_app", is_read: false,
      })
      r.digested += 1
    } catch { r.errors += 1 }
  }
  return r
}
