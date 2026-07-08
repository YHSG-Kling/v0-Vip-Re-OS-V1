// lib/kernel/board-packet-pdf.ts
// ─────────────────────────────────────────────────────────────────────────────
// BOARD PACKET → PDF (owner rule: brokers get a PDF, not markdown). Pure
// pdf-lib composition — serverless-safe, no chromium, no template service.
// One clean printable page: header, three sections, honest footer.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import type { BoardPacketData } from "./board-packet"

const INK = rgb(0.06, 0.09, 0.16)
const MUTE = rgb(0.42, 0.45, 0.5)
const ACCENT = rgb(0.96, 0.62, 0.04)

const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`

export async function renderBoardPacketPdf(d: BoardPacketData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792]) // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  let y = 740

  const line = (text: string, opts: { size?: number; b?: boolean; color?: any; gap?: number } = {}) => {
    page.drawText(text, { x: 54, y, size: opts.size ?? 11, font: opts.b ? bold : font, color: opts.color ?? INK })
    y -= opts.gap ?? (opts.size ?? 11) + 8
  }
  const section = (title: string) => {
    y -= 8
    page.drawRectangle({ x: 54, y: y + 2, width: 3, height: 14, color: ACCENT })
    page.drawText(title.toUpperCase(), { x: 64, y: y + 4, size: 11, font: bold, color: INK })
    y -= 26
  }

  line(d.brokerageName, { size: 20, b: true, gap: 30 })
  line(`Board Packet — ${d.monthLabel}`, { size: 12, color: MUTE, gap: 26 })

  section("Production")
  line(`Closed: ${d.closedCount} transaction${d.closedCount === 1 ? "" : "s"} · ${money(d.closedVolumeCents)} volume`)
  line(`Active listings: ${d.activeListings}`)
  line(`Showings: ${d.showings} · Open houses held: ${d.openHouses}`)

  section("Pipeline")
  line(`New contacts this month: ${d.newContacts}`)

  section("The AI team's month (measured, not claimed)")
  line(`Inbound calls answered by the AI: ${d.aiCallsAnswered}`)
  line(`Outbound follow-up connects: ${d.aiOutboundConnects}`)
  line(`Appointments booked live on calls: ${d.aiBookings}`)
  line(`AI reply drafts your agents sent: ${d.draftsUsed}`)
  line(`Opt-outs honored immediately: ${d.optOutsHonored} — compliance is a feature`)

  page.drawText(
    `Composed automatically from the operating ledgers — every number traces to records in the ${d.monthLabel} window.`,
    { x: 54, y: 60, size: 8.5, font, color: MUTE },
  )
  return doc.save()
}
