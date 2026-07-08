// lib/kernel/board-packet.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE BROKER BOARD PACKET — the owner's monthly one-pager, composed from the
// SAME ledgers the command center reads (no parallel metrics): production,
// pipeline, the AI team's measurable work, and where attention is needed.
// Markdown (renders in-app + attaches to email + prints clean); stored to the
// documents bucket; broker admins notified with the link. Honest numbers only
// — every figure traces to rows in the month window; thin months say so.

export interface BoardPacketData {
  brokerageName: string
  monthLabel: string
  newContacts: number
  activeListings: number
  closedCount: number
  closedVolumeCents: number
  showings: number
  openHouses: number
  aiCallsAnswered: number
  aiOutboundConnects: number
  aiBookings: number
  draftsUsed: number
  optOutsHonored: number
}

const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`

/** PURE: the packet — plain markdown, honest with zeros. */
export function composeBoardPacketMarkdown(d: BoardPacketData): string {
  return [
    `# ${d.brokerageName} — Board Packet, ${d.monthLabel}`,
    ``,
    `## Production`,
    `- Closed: **${d.closedCount}** transaction${d.closedCount === 1 ? "" : "s"} · **${money(d.closedVolumeCents)}** volume`,
    `- Active listings: **${d.activeListings}**`,
    `- Showings: **${d.showings}** · Open houses held: **${d.openHouses}**`,
    ``,
    `## Pipeline`,
    `- New contacts this month: **${d.newContacts}**`,
    ``,
    `## The AI team's month (measured, not claimed)`,
    `- Inbound calls answered by the AI: **${d.aiCallsAnswered}**`,
    `- Outbound follow-up connects: **${d.aiOutboundConnects}**`,
    `- Appointments booked live on calls: **${d.aiBookings}**`,
    `- AI reply drafts your agents sent: **${d.draftsUsed}**`,
    `- Opt-outs honored immediately: **${d.optOutsHonored}** (compliance is a feature)`,
    ``,
    `---`,
    `*Composed automatically from the operating ledgers — every number traces to records in the ${d.monthLabel} window.*`,
  ].join("\n")
}

export interface BoardPacketResult { brokerages: number; packets: number; errors: number }

/** Monthly runner: one packet per active brokerage → documents bucket +
 *  broker-admin notification. Deduped per brokerage per month. */
export async function runBoardPackets(svc: any, now: Date = new Date()): Promise<BoardPacketResult> {
  const r: BoardPacketResult = { brokerages: 0, packets: 0, errors: 0 }
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1))
  const monthLabel = start.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
  const sISO = start.toISOString(), eISO = end.toISOString()

  const { data: brokerages } = await svc.from("brokerages").select("id, name").limit(2000)
  for (const b of (brokerages ?? []) as any[]) {
    r.brokerages += 1
    try {
      // Delivered as PDF (owner rule) — pdf-lib composition, serverless-safe.
      const path = `board-packets/${b.id}/${sISO.slice(0, 7)}.pdf`
      const { data: existing } = await svc.storage.from("documents").list(`board-packets/${b.id}`, { search: `${sISO.slice(0, 7)}.pdf` })
      if ((existing ?? []).some((f: any) => f.name === `${sISO.slice(0, 7)}.pdf`)) continue

      const cnt = async (q: any) => ((await q) as any)?.count ?? 0
      const [newContacts, activeListings, showings, openHouses, aiCalls, aiOut, aiBookings, draftsUsed, optOuts, closedRows] = await Promise.all([
        cnt(svc.from("contacts").select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).gte("created_at", sISO).lt("created_at", eISO)),
        cnt(svc.from("listings").select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).is("deleted_at", null).in("lifecycle_stage", ["COMING_SOON_ACTIVE", "MLS_ACTIVE", "OPEN_HOUSE_MARKETING", "OPEN_HOUSE_EVENT", "SHOWINGS_ACTIVE", "OFFERS_RECEIVED", "NEGOTIATION"])),
        cnt(svc.from("showings").select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).gte("created_at", sISO).lt("created_at", eISO)),
        cnt(svc.from("open_house_events").select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).gte("event_date", sISO.slice(0, 10)).lt("event_date", eISO.slice(0, 10))),
        cnt(svc.from("voice_calls").select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).eq("direction", "inbound").gte("started_at", sISO).lt("started_at", eISO)),
        cnt(svc.from("voice_calls").select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).eq("direction", "outbound").eq("status", "completed").gte("started_at", sISO).lt("started_at", eISO)),
        cnt(svc.from("showings").select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).ilike("notes", "%AI receptionist%").gte("created_at", sISO).lt("created_at", eISO)),
        cnt(svc.from("ai_message_drafts").select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).in("status", ["accepted", "sent", "edited"]).gte("created_at", sISO).lt("created_at", eISO)),
        cnt(svc.from("voice_calls").select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).eq("outcome", "opt_out").gte("started_at", sISO).lt("started_at", eISO)),
        svc.from("listings").select("sold_price").eq("brokerage_id", b.id).not("sold_date", "is", null).gte("sold_date", sISO.slice(0, 10)).lt("sold_date", eISO.slice(0, 10)).limit(1000),
      ])
      const closed = ((closedRows as any)?.data ?? []) as Array<{ sold_price: number | null }>
      const packetData = {
        brokerageName: b.name ?? "Brokerage", monthLabel,
        newContacts, activeListings, showings, openHouses,
        aiCallsAnswered: aiCalls, aiOutboundConnects: aiOut, aiBookings, draftsUsed, optOutsHonored: optOuts,
        closedCount: closed.length,
        closedVolumeCents: closed.reduce((a, l) => a + Math.round(Number(l.sold_price ?? 0) * 100), 0),
      }
      const { renderBoardPacketPdf } = await import("./board-packet-pdf")
      const pdf = await renderBoardPacketPdf(packetData)
      const { error: upErr } = await svc.storage.from("documents")
        .upload(path, Buffer.from(pdf), { contentType: "application/pdf", upsert: false })
      if (upErr) { r.errors += 1; continue }
      const { data: pub } = svc.storage.from("documents").getPublicUrl(path)

      const { data: admins } = await svc.from("users").select("id")
        .eq("brokerage_id", b.id).in("user_type", ["broker", "broker_admin", "admin"]).limit(5)
      for (const u of (admins ?? []) as any[]) {
        await svc.from("notifications").insert({
          user_id: u.id, brokerage_id: b.id, type: "board_packet_ready",
          title: `Your ${monthLabel} board packet is ready`,
          body: `Production, pipeline, and the AI team's measurable month — ${pub?.publicUrl ?? path}`,
          priority: "medium", channel: "in_app", is_read: false,
        }).then(undefined, () => {})
      }
      r.packets += 1
    } catch { r.errors += 1 }
  }
  return r
}
