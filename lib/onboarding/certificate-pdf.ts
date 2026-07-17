// lib/onboarding/certificate-pdf.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING CERTIFICATE → PDF. Same rail as board packets: pure pdf-lib
// composition (serverless-safe, no chromium, no template service), uploaded by
// the certification engine to the `documents` storage bucket. One clean
// printable landscape page: border, title, agent, certification, honest footer.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

const INK = rgb(0.06, 0.09, 0.16)
const MUTE = rgb(0.42, 0.45, 0.5)
const ACCENT = rgb(0.96, 0.62, 0.04)

const PAGE_W = 792 // US Letter landscape
const PAGE_H = 612

export interface CertificatePdfData {
  agentName: string
  certName: string
  brokerageName: string
  issuedAt: Date
}

export async function renderCertificatePdf(d: CertificatePdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([PAGE_W, PAGE_H])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const centered = (text: string, y: number, size: number, f = font, color = INK) => {
    const width = f.widthOfTextAtSize(text, size)
    page.drawText(text, { x: (PAGE_W - width) / 2, y, size, font: f, color })
  }

  // Double border frame
  page.drawRectangle({ x: 30, y: 30, width: PAGE_W - 60, height: PAGE_H - 60, borderColor: INK, borderWidth: 1.5 })
  page.drawRectangle({ x: 38, y: 38, width: PAGE_W - 76, height: PAGE_H - 76, borderColor: MUTE, borderWidth: 0.5 })

  centered("CERTIFICATE OF COMPLETION", 486, 26, bold)
  centered(d.brokerageName, 452, 13, font, MUTE)

  centered("This certifies that", 392, 12, font, MUTE)
  centered(d.agentName, 344, 30, bold)

  // Accent rule under the agent name
  page.drawRectangle({ x: (PAGE_W - 300) / 2, y: 326, width: 300, height: 3, color: ACCENT })

  centered("has successfully completed all requirements for", 288, 12, font, MUTE)
  centered(d.certName, 250, 20, bold)

  centered(
    `Issued ${d.issuedAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`,
    198,
    11,
    font,
    MUTE,
  )

  page.drawText(
    "Verified from the training ledger — required steps, videos, and course completions on record at time of issue.",
    { x: 54, y: 56, size: 8.5, font, color: MUTE },
  )
  return doc.save()
}
