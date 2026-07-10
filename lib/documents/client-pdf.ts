/**
 * lib/documents/client-pdf.ts
 *
 * THE CLIENT-DOCUMENT PDF ENGINE — real, branded, multi-page PDFs for the
 * pieces agents hand to clients: CMA reports, seller net sheets, buyer/seller
 * guide booklets, listing-presentation leave-behinds. Replaces the
 * app/actions/pdf-generation.tsx mock whose "PDF" was the raw HTML bytes
 * uploaded with a .pdf extension (an invalid file for every recipient).
 *
 * Pure pdf-lib composition — serverless-safe, no chromium, no template
 * service (the board-packet discipline, generalized): a declarative spec
 * (cover + sections of paragraphs/bullets/tables/price cards) flows through
 * a paginating cursor, so producers describe CONTENT and the engine owns
 * layout, wrapping, page breaks, branding, and the compliance footer
 * (brokerage attribution + license + EHO + document disclaimer).
 *
 * No DB and no network in here — callers assemble data, then host the bytes
 * via hostRenderedMedia (Supabase storage first — we host the delivery URL).
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from "pdf-lib"

// US Letter
const PAGE_W = 612
const PAGE_H = 792
const MARGIN_X = 54
const MARGIN_TOP = 60
const MARGIN_BOTTOM = 72
const BODY_W = PAGE_W - MARGIN_X * 2

const INK = rgb(0.06, 0.09, 0.16)
const MUTE = rgb(0.42, 0.45, 0.5)
const FAINT = rgb(0.88, 0.9, 0.93)

export interface ClientPdfBrand {
  /** Brokerage/team primary color as #rrggbb — drives the cover band + accents. */
  primaryColor?: string | null
  brokerageName: string
  agentName?: string | null
  agentPhone?: string | null
  agentEmail?: string | null
  /** "Lic #01234567 (FL)" — state ad rules want it on client-facing pieces. */
  licenseLine?: string | null
  showEhoMark?: boolean
}

export interface ClientPdfTable {
  /** Optional two-or-three column header row. */
  header?: string[]
  rows: string[][]
  /** Bold the last row (totals). */
  emphasizeLastRow?: boolean
}

export interface ClientPdfPriceCard {
  label: string
  price: string
  note?: string
}

export interface ClientPdfPhoto {
  /** Raw image bytes — the caller downloads; the engine stays network-free. */
  bytes: Uint8Array
  kind: "jpg" | "png"
  caption?: string
}

export interface ClientPdfSection {
  heading?: string
  paragraphs?: string[]
  bullets?: string[]
  table?: ClientPdfTable
  priceCards?: ClientPdfPriceCard[]
  /** Embedded photos, laid out 2-up (a lone photo runs full width). */
  photos?: ClientPdfPhoto[]
  /** Start this section on a fresh page (booklet chapters / photo spreads). */
  pageBreak?: boolean
}

export interface ClientPdfSpec {
  title: string
  subtitle?: string
  /** "Prepared for Jane Seller · July 9, 2026" */
  preparedLine?: string
  brand: ClientPdfBrand
  sections: ClientPdfSection[]
  /** Small-print block on the last page (USPAP / estimate disclaimers). */
  disclaimer?: string
}

export function hexToRgb(hex: string | null | undefined, fallback: RGB = rgb(0.19, 0.23, 0.9)): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim())
  if (!m) return fallback
  const n = parseInt(m[1], 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

/** Greedy word-wrap using real font metrics. Exported for the simulator. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ")
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
      line = candidate
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

interface Cursor {
  doc: PDFDocument
  page: PDFPage
  y: number
  font: PDFFont
  bold: PDFFont
  accent: RGB
  brand: ClientPdfBrand
  pageIndex: number
}

function addPage(c: Cursor): void {
  c.page = c.doc.addPage([PAGE_W, PAGE_H])
  c.pageIndex++
  c.y = PAGE_H - MARGIN_TOP
  // Running header on continuation pages: thin accent rule + brokerage name
  c.page.drawRectangle({ x: MARGIN_X, y: PAGE_H - 36, width: BODY_W, height: 2, color: c.accent })
  c.page.drawText(c.brand.brokerageName, { x: MARGIN_X, y: PAGE_H - 30, size: 8, font: c.font, color: MUTE })
}

function ensure(c: Cursor, needed: number): void {
  if (c.y - needed < MARGIN_BOTTOM) addPage(c)
}

function drawParagraph(c: Cursor, text: string, opts: { size?: number; b?: boolean; color?: RGB; indent?: number; gapAfter?: number } = {}): void {
  const size = opts.size ?? 10.5
  const font = opts.b ? c.bold : c.font
  const indent = opts.indent ?? 0
  const lines = wrapText(text, font, size, BODY_W - indent)
  for (const ln of lines) {
    ensure(c, size + 4)
    c.page.drawText(ln, { x: MARGIN_X + indent, y: c.y, size, font, color: opts.color ?? INK })
    c.y -= size + 4
  }
  c.y -= opts.gapAfter ?? 6
}

function drawSectionHeading(c: Cursor, title: string): void {
  ensure(c, 40)
  c.y -= 8
  c.page.drawRectangle({ x: MARGIN_X, y: c.y - 2, width: 3, height: 14, color: c.accent })
  c.page.drawText(title.toUpperCase(), { x: MARGIN_X + 10, y: c.y, size: 11.5, font: c.bold, color: INK })
  c.y -= 26
}

function drawBullets(c: Cursor, bullets: string[]): void {
  for (const b of bullets) {
    ensure(c, 16)
    c.page.drawText("•", { x: MARGIN_X + 4, y: c.y, size: 10.5, font: c.bold, color: c.accent })
    const lines = wrapText(b, c.font, 10.5, BODY_W - 22)
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) ensure(c, 14.5)
      c.page.drawText(lines[i], { x: MARGIN_X + 18, y: c.y, size: 10.5, font: c.font, color: INK })
      c.y -= 14.5
    }
    c.y -= 2
  }
  c.y -= 6
}

function drawTable(c: Cursor, table: ClientPdfTable): void {
  const cols = Math.max(table.header?.length ?? 0, ...table.rows.map((r) => r.length), 2)
  const colW = BODY_W / cols
  const rowH = 20
  const drawRow = (cells: string[], opts: { header?: boolean; bold?: boolean }) => {
    ensure(c, rowH + 4)
    if (opts.header) {
      c.page.drawRectangle({ x: MARGIN_X, y: c.y - 5, width: BODY_W, height: rowH - 2, color: FAINT })
    }
    for (let i = 0; i < cols; i++) {
      const cell = cells[i] ?? ""
      const font = opts.header || opts.bold ? c.bold : c.font
      // Right-align every column after the first (money columns)
      const size = 10
      const x = i === 0
        ? MARGIN_X + 6
        : MARGIN_X + colW * (i + 1) - 6 - font.widthOfTextAtSize(cell, size)
      c.page.drawText(cell, { x, y: c.y, size, font, color: INK })
    }
    c.y -= rowH
    c.page.drawRectangle({ x: MARGIN_X, y: c.y + 6, width: BODY_W, height: 0.6, color: FAINT })
  }
  if (table.header) drawRow(table.header, { header: true })
  table.rows.forEach((r, i) => {
    drawRow(r, { bold: !!table.emphasizeLastRow && i === table.rows.length - 1 })
  })
  c.y -= 10
}

function drawPriceCards(c: Cursor, cards: ClientPdfPriceCard[]): void {
  const gap = 12
  const cardW = (BODY_W - gap * (cards.length - 1)) / cards.length
  const cardH = 74
  ensure(c, cardH + 10)
  const top = c.y
  cards.forEach((card, i) => {
    const x = MARGIN_X + i * (cardW + gap)
    c.page.drawRectangle({ x, y: top - cardH, width: cardW, height: cardH, borderColor: c.accent, borderWidth: 1.2 })
    c.page.drawText(card.label.toUpperCase(), { x: x + 10, y: top - 20, size: 8.5, font: c.bold, color: MUTE })
    c.page.drawText(card.price, { x: x + 10, y: top - 42, size: 17, font: c.bold, color: c.accent })
    if (card.note) {
      const noteLines = wrapText(card.note, c.font, 8, cardW - 20)
      c.page.drawText(noteLines[0] ?? "", { x: x + 10, y: top - 58, size: 8, font: c.font, color: MUTE })
    }
  })
  c.y = top - cardH - 14
}

async function drawPhotos(c: Cursor, photos: ClientPdfPhoto[]): Promise<void> {
  const gap = 12
  for (let i = 0; i < photos.length; ) {
    const pair = photos.slice(i, i + 2)
    const isPair = pair.length === 2
    const cellW = isPair ? (BODY_W - gap) / 2 : BODY_W
    const embedded = await Promise.all(pair.map(async (p) =>
      p.kind === "png" ? c.doc.embedPng(p.bytes) : c.doc.embedJpg(p.bytes),
    ))
    const heights = embedded.map((img) => (img.height / img.width) * cellW)
    const rowH = Math.min(Math.max(...heights), 300)
    ensure(c, rowH + 26)
    const top = c.y
    embedded.forEach((img, j) => {
      // Cover-fit: scale to fill the cell height, clip via width cap
      const scale = rowH / ((img.height / img.width) * cellW)
      const w = Math.min(cellW, cellW * scale)
      const h = (img.height / img.width) * w
      const x = MARGIN_X + j * (cellW + gap) + (cellW - w) / 2
      c.page.drawImage(img, { x, y: top - Math.min(h, rowH), width: w, height: Math.min(h, rowH) })
      const caption = pair[j].caption
      if (caption) {
        c.page.drawText(caption.slice(0, 60), { x: MARGIN_X + j * (cellW + gap), y: top - rowH - 12, size: 8, font: c.font, color: MUTE })
      }
    })
    c.y = top - rowH - (pair.some((p) => p.caption) ? 24 : 12)
    i += 2
  }
  c.y -= 6
}

/** Render the spec to real PDF bytes (starts with %PDF — the sim asserts it). */
export async function renderClientPdf(spec: ClientPdfSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const accent = hexToRgb(spec.brand.primaryColor)

  const c: Cursor = { doc, page: doc.addPage([PAGE_W, PAGE_H]), y: 0, font, bold, accent, brand: spec.brand, pageIndex: 0 }

  // ── COVER BAND ──
  c.page.drawRectangle({ x: 0, y: PAGE_H - 170, width: PAGE_W, height: 170, color: accent })
  const titleLines = wrapText(spec.title, bold, 27, BODY_W)
  let ty = PAGE_H - 78
  for (const ln of titleLines.slice(0, 2)) {
    c.page.drawText(ln, { x: MARGIN_X, y: ty, size: 27, font: bold, color: rgb(1, 1, 1) })
    ty -= 33
  }
  if (spec.subtitle) {
    c.page.drawText(spec.subtitle, { x: MARGIN_X, y: ty, size: 13, font, color: rgb(1, 1, 1) })
    ty -= 20
  }
  if (spec.preparedLine) {
    c.page.drawText(spec.preparedLine, { x: MARGIN_X, y: PAGE_H - 158, size: 9.5, font, color: rgb(1, 1, 1) })
  }
  c.y = PAGE_H - 200

  // ── SECTIONS ──
  for (const section of spec.sections) {
    if (section.pageBreak) addPage(c)
    if (section.heading) drawSectionHeading(c, section.heading)
    if (section.priceCards?.length) drawPriceCards(c, section.priceCards)
    for (const p of section.paragraphs ?? []) drawParagraph(c, p)
    if (section.bullets?.length) drawBullets(c, section.bullets)
    if (section.table) drawTable(c, section.table)
    if (section.photos?.length) await drawPhotos(c, section.photos)
  }

  // ── DISCLAIMER ──
  if (spec.disclaimer) {
    ensure(c, 60)
    c.y -= 6
    drawParagraph(c, spec.disclaimer, { size: 7.5, color: MUTE, gapAfter: 0 })
  }

  // ── COMPLIANCE FOOTER on every page ──
  const brand = spec.brand
  const attribution = [
    brand.agentName,
    brand.brokerageName,
    brand.licenseLine ?? undefined,
    [brand.agentPhone, brand.agentEmail].filter(Boolean).join(" · ") || undefined,
  ].filter(Boolean).join("  ·  ")
  const eho = brand.showEhoMark === false ? "" : "Equal Housing Opportunity"
  const pages = doc.getPages()
  pages.forEach((page, i) => {
    page.drawRectangle({ x: MARGIN_X, y: 46, width: BODY_W, height: 0.8, color: FAINT })
    page.drawText(attribution.slice(0, 130), { x: MARGIN_X, y: 34, size: 7.5, font, color: MUTE })
    const right = `${eho}${eho ? "   ·   " : ""}${i + 1} / ${pages.length}`
    page.drawText(right, { x: PAGE_W - MARGIN_X - font.widthOfTextAtSize(right, 7.5), y: 34, size: 7.5, font, color: MUTE })
  })

  return doc.save()
}

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCERS — the document types the mock claimed to make, made real
// ─────────────────────────────────────────────────────────────────────────────

const money = (n: number | null | undefined) =>
  n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`

export const CMA_DISCLAIMER =
  "This report is a Comparative Market Analysis (CMA) prepared by a real estate licensee for marketing " +
  "and pricing guidance. It is not an appraisal of value as defined under the Uniform Standards of " +
  "Professional Appraisal Practice (USPAP). The analysis is based on available data and professional " +
  "judgment and should not be used for lending or legal purposes. For an official valuation, consult a " +
  "licensed appraiser."

export const NET_SHEET_DISCLAIMER =
  "This net proceeds estimate is for informational purposes only and is not a guarantee of actual " +
  "proceeds. Actual costs vary. Consult your title company and lender for precise closing figures."

export interface CmaPdfData {
  propertyAddress: string
  preparedFor?: string | null
  valueLow: number
  valueMid: number
  valueHigh: number
  confidence?: number | null
  narrative?: string | null
  marketingPlanHighlights?: string[]
  netSheetRows?: Array<{ label: string; listPrice: number; proceeds: number }>
}

export function cmaPdfSpec(data: CmaPdfData, brand: ClientPdfBrand, dateLabel: string): ClientPdfSpec {
  const sections: ClientPdfSection[] = [
    {
      heading: "Strategic value range",
      priceCards: [
        { label: "Conservative", price: money(data.valueLow), note: "Fastest path to contract" },
        { label: "Target", price: money(data.valueMid), note: "Recommended competitive position" },
        { label: "Aspirational", price: money(data.valueHigh), note: "Premium positioning" },
      ],
      paragraphs: data.confidence != null ? [`Model confidence: ${Math.round(data.confidence)}%.`] : [],
    },
  ]
  if (data.narrative) {
    sections.push({ heading: "Market analysis", paragraphs: data.narrative.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 8) })
  }
  if (data.netSheetRows?.length) {
    sections.push({
      heading: "What you'd walk away with",
      table: {
        header: ["Scenario", "List price", "Est. net proceeds"],
        rows: data.netSheetRows.map((r) => [r.label, money(r.listPrice), money(r.proceeds)]),
      },
    })
  }
  if (data.marketingPlanHighlights?.length) {
    sections.push({ heading: "How we'll market it", bullets: data.marketingPlanHighlights.slice(0, 8) })
  }
  return {
    title: "Comparative Market Analysis",
    subtitle: data.propertyAddress,
    preparedLine: [data.preparedFor ? `Prepared for ${data.preparedFor}` : null, dateLabel].filter(Boolean).join(" · "),
    brand,
    sections,
    disclaimer: CMA_DISCLAIMER,
  }
}

export interface NetSheetPdfData {
  propertyAddress: string
  sellerName?: string | null
  scenarios: Array<{
    label: string
    salePrice: number
    commission: number
    closingCosts: number
    mortgagePayoff?: number | null
    other?: number | null
    netProceeds: number
  }>
}

export function netSheetPdfSpec(data: NetSheetPdfData, brand: ClientPdfBrand, dateLabel: string): ClientPdfSpec {
  const sections: ClientPdfSection[] = [
    {
      heading: "Sale scenarios",
      table: {
        header: ["Scenario", "Sale price", "Est. net proceeds"],
        rows: data.scenarios.map((s) => [s.label, money(s.salePrice), money(s.netProceeds)]),
      },
    },
    ...data.scenarios.map((s) => ({
      heading: `Breakdown — ${s.label}`,
      table: {
        rows: [
          ["Sale price", money(s.salePrice)],
          ["Less: commission", `-${money(s.commission)}`],
          ["Less: closing costs", `-${money(s.closingCosts)}`],
          ...(s.mortgagePayoff != null ? [["Less: mortgage payoff", `-${money(s.mortgagePayoff)}`]] : []),
          ...(s.other ? [["Less: other (liens/HOA/prorations)", `-${money(s.other)}`]] : []),
          ["Estimated net proceeds", money(s.netProceeds)],
        ],
        emphasizeLastRow: true,
      } as ClientPdfTable,
    })),
  ]
  return {
    title: "Estimated Net Proceeds",
    subtitle: data.propertyAddress,
    preparedLine: [data.sellerName ? `Prepared for ${data.sellerName}` : null, dateLabel].filter(Boolean).join(" · "),
    brand,
    sections,
    disclaimer: NET_SHEET_DISCLAIMER,
  }
}

export interface GuideBookletData {
  kind: "buyer_guide" | "seller_guide"
  title: string
  intro?: string | null
  /** Chaptered content — each becomes a heading + paragraphs (booklet flow). */
  chapters: Array<{ heading: string; body: string }>
  areaLabel?: string | null
}

export function guideBookletSpec(data: GuideBookletData, brand: ClientPdfBrand, dateLabel: string): ClientPdfSpec {
  const sections: ClientPdfSection[] = []
  if (data.intro) sections.push({ paragraphs: [data.intro] })
  data.chapters.forEach((ch, i) => {
    sections.push({
      heading: ch.heading,
      paragraphs: ch.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
      pageBreak: i > 0 && i % 2 === 0, // breathe every couple of chapters
    })
  })
  sections.push({
    heading: "Your next step",
    paragraphs: [
      `Every market — and every ${data.kind === "buyer_guide" ? "purchase" : "sale"} — is different. ` +
      `When you're ready, ${brand.agentName ?? "your agent"} at ${brand.brokerageName} can walk you through exactly how this applies to you.`,
    ],
  })
  return {
    title: data.title,
    subtitle: data.areaLabel ?? undefined,
    preparedLine: dateLabel,
    brand,
    sections,
    disclaimer:
      "This guide is general information, not legal, tax, or lending advice. Programs, rates, and " +
      "requirements change — verify details with licensed professionals for your situation.",
  }
}
