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
  line(`Marketing-attributed closed volume: ${money(d.attributedGciCents)} across ${d.attributedDeals} deal${d.attributedDeals === 1 ? "" : "s"} (attribution-weighted)`)

  // AI TEAM INTELLIGENCE — the monthly learning-loop proof, fed by the ONE
  // pure composer (lib/kernel/intelligence-report.ts). Only earned sections
  // arrive; an absent/empty month renders nothing. Long headlines wrap; the
  // section stops above the footer rather than overflowing the page.
  if (d.intelligence && d.intelligence.length > 0) {
    const wrap = (text: string, max = 96): string[] => {
      const words = text.split(/\s+/)
      const out: string[] = []
      let cur = ""
      for (const w of words) {
        if ((cur + " " + w).trim().length > max) { if (cur) out.push(cur); cur = w }
        else cur = (cur + " " + w).trim()
      }
      if (cur) out.push(cur)
      return out
    }
    section("AI Team Intelligence (proof the team is learning)")
    for (const s of d.intelligence) {
      if (y < 110) break // honest truncation above the footer, never overflow
      line(s.title, { size: 10, b: true, gap: 15 })
      for (const l of wrap(s.headline)) {
        if (y < 95) break
        line(l, { size: 9.5, color: MUTE, gap: 13 })
      }
      // Promoter quotes: the verbatims ARE the section — render each quoted
      // line (the composer already wrapped them in quote marks), same y-guard.
      if (s.id === "promoter_quotes") {
        for (const q of s.lines) {
          if (y < 95) break
          for (const l of wrap(q.value, 90)) {
            if (y < 95) break
            line(`   ${l}`, { size: 9.5, color: MUTE, gap: 13 })
          }
        }
      }
      y -= 3
    }
  }

  // QUICKBOOKS RECONCILIATION (round 37) — present only when the month earned
  // it (connected + ledger rows); the statement carries the not-a-live-pull
  // honesty. Same y-guard discipline as the intelligence section.
  if (d.qbReconciliation && y > 130) {
    const q = d.qbReconciliation
    section("QuickBooks reconciliation (OS-recorded exports vs OS ledgers)")
    line(
      `Export coverage: ${q.coveragePct === null ? "—" : `${q.coveragePct}%`} — ${q.exportedRows}/${q.totalRows} ledger rows · $${Math.round(q.totalAmountUsd).toLocaleString("en-US")} on the OS side${q.unexportedRows > 0 ? ` · ${q.unexportedRows} unexported` : ""}`,
      { size: 10 },
    )
    const words = q.statement.split(/\s+/)
    let cur = ""
    const wrapped: string[] = []
    for (const w of words) {
      if ((cur + " " + w).trim().length > 96) { if (cur) wrapped.push(cur); cur = w }
      else cur = (cur + " " + w).trim()
    }
    if (cur) wrapped.push(cur)
    for (const l of wrapped) {
      if (y < 95) break
      line(l, { size: 9.5, color: MUTE, gap: 13 })
    }
  }

  page.drawText(
    `Composed automatically from the operating ledgers — every number traces to records in the ${d.monthLabel} window.`,
    { x: 54, y: 60, size: 8.5, font, color: MUTE },
  )
  return doc.save()
}
