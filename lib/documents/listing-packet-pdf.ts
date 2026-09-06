/**
 * lib/documents/listing-packet-pdf.ts
 *
 * THE PRINTABLE LISTING PACKET — turns the six PacketDocument content objects
 * that generateListingPacket stores in listing_packet_jobs.config.content into
 * a ClientPdfSpec the client-PDF engine renders as one print-ready binder
 * (owner ruling: "the listing packets need to take the content and make it
 * printable material for the listing").
 *
 * PURE, like the engine it feeds (lib/documents/client-pdf.ts): no DB, no
 * network, and it NEVER throws — packet content is model-authored JSON of
 * varying shape, so every branch degrades to an honest rendering of whatever
 * is actually there. Structural model: lib/documents/listing-brochure.ts.
 *
 * Section mapping (each document = one binder tab, pageBreak: true):
 *   listing_flyer     → pinned fields (headline/subheadline/description/
 *                       neighborhoodInfo/callToAction as paragraphs,
 *                       highlights as bullets) + the packet QR as a photo
 *   seller_disclosure → present/missing disclosure table + recommendations
 *                       bullets + compliance score line
 *   utilities_form / gis_report / tax_record / appraiser_report
 *                     → objectToSections() generic walker (heading per key;
 *                       strings → paragraphs, arrays → bullets, flat objects
 *                       → 2-col table). The builders' prompts are now pinned
 *                       to explicit JSON schemas (app/actions/ai-listing-packet.ts)
 *                       so NEW generations are well-shaped; the walker renders
 *                       EXISTING rows honestly whatever their shape.
 * Each content object's carried disclaimer (gis/tax/appraiser) is appended to
 * the spec-level disclaimer block, never dropped.
 */
import type {
  ClientPdfBrand,
  ClientPdfPhoto,
  ClientPdfSection,
  ClientPdfSpec,
} from "./client-pdf"

/** The shape generateListingPacket stores in config.content (app/actions/ai-listing-packet.ts). */
export interface PacketDocumentLike {
  type: string
  name: string
  url?: string
  content?: string | Record<string, unknown> | null
  status: "pending" | "generated" | "error"
  generatedAt?: string
}

export interface PacketListingFacts {
  address?: string | null
  city?: string | null
  state?: string | null
  list_price?: number | null
}

export interface PacketQr {
  scanUrl?: string | null
  /** data:image/png;base64,… as minted by mintMarketingQr. */
  qrCodeDataUrl?: string | null
}

const PACKET_DISCLAIMER =
  "This listing packet was assembled for property display and marketing. Information is deemed " +
  "reliable but not guaranteed; buyers and sellers should independently verify all facts, figures, " +
  "and measurements."

/** Keys the walker never renders as body content. `disclaimer` is lifted to the
 *  spec-level disclaimer block; `qr` is a base64 data URL, not prose. */
const WALKER_SKIP_KEYS = new Set(["disclaimer", "qr"])

/** "avgMonthlyCost" / "flood_zone_status" → "Avg Monthly Cost" / "Flood Zone Status". */
export function titleCase(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

/** Any leaf value → one printable line (tables don't wrap, so keep cells short). */
function scalarText(value: unknown, maxLen = 90): string {
  let text: string
  if (value == null) text = "—"
  else if (typeof value === "string") text = value
  else if (typeof value === "number" || typeof value === "boolean") text = String(value)
  else if (Array.isArray(value)) text = value.map((v) => scalarText(v, maxLen)).join("; ")
  else if (typeof value === "object") {
    text = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${titleCase(k)}: ${scalarText(v, maxLen)}`)
      .join("; ")
  } else text = String(value)
  text = text.replace(/\s+/g, " ").trim() || "—"
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text
}

/**
 * Generic renderer for the model-authored content objects (utilities form, GIS,
 * tax record, appraiser report): one sub-section per top-level key —
 * heading = titleCase(key); strings → paragraphs, arrays → bullets, flat
 * objects → a 2-column table. Honest about ANY shape a stored row carries.
 */
export function objectToSections(obj: Record<string, unknown>): ClientPdfSection[] {
  const sections: ClientPdfSection[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (value == null || WALKER_SKIP_KEYS.has(key)) continue
    const heading = titleCase(key)
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value).trim()
      if (text) sections.push({ heading, paragraphs: [text] })
    } else if (Array.isArray(value)) {
      const bullets = value.map((v) => scalarText(v, 220)).filter((b) => b !== "—")
      if (bullets.length) sections.push({ heading, bullets })
    } else if (typeof value === "object") {
      // "—" rows stay: an empty field on a form is itself information.
      const rows = Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => [titleCase(k), scalarText(v)])
      if (rows.length) sections.push({ heading, table: { rows } })
    }
  }
  return sections
}

/** Decode the minted QR's data URL into engine photo bytes. Null on any mismatch. */
function qrPhoto(qr: PacketQr | null | undefined): ClientPdfPhoto | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(qr?.qrCodeDataUrl ?? "")
  if (!m) return null
  try {
    const bytes = Uint8Array.from(Buffer.from(m[1], "base64"))
    if (!bytes.length) return null
    return {
      bytes,
      kind: "png",
      caption: qr?.scanUrl ? `Scan to view this listing — ${qr.scanUrl}` : "Scan to view this listing",
    }
  } catch {
    return null
  }
}

function asObject(content: PacketDocumentLike["content"]): Record<string, unknown> | null {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>
  }
  return null
}

function flyerSections(doc: PacketDocumentLike, qr: PacketQr | null | undefined): ClientPdfSection[] {
  const c = asObject(doc.content)
  if (!c) return fallbackSections(doc)
  const paragraphs = [c.headline, c.subheadline, c.description, c.neighborhoodInfo, c.callToAction]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim())
  const highlights = Array.isArray(c.highlights)
    ? c.highlights.map((h) => scalarText(h, 220)).filter((h) => h !== "—")
    : []
  // Packet-level QR first (one code for the whole binder); the flyer's own
  // minted QR as fallback for packets generated before the packet-level mint.
  const photo = qrPhoto(qr) ?? qrPhoto(asObject(c.qr as never) as PacketQr | null)
  const section: ClientPdfSection = {
    heading: doc.name || "Marketing Flyer",
    pageBreak: true,
    ...(paragraphs.length ? { paragraphs } : {}),
    ...(highlights.length ? { bullets: highlights } : {}),
    ...(photo ? { photos: [photo] } : {}),
  }
  return [section]
}

function disclosureSections(doc: PacketDocumentLike): ClientPdfSection[] {
  const c = asObject(doc.content)
  const analysis = asObject(c?.analysis as never)
  if (!c || !analysis) return fallbackSections(doc)
  const present = Array.isArray(analysis.presentDisclosures) ? analysis.presentDisclosures : []
  const missing = Array.isArray(analysis.missingDisclosures) ? analysis.missingDisclosures : []
  const rows: string[][] = [
    ...present.map((d) => [scalarText(d), "On file"]),
    ...missing.map((d) => [scalarText(d), "MISSING"]),
  ]
  const recommendations = Array.isArray(analysis.recommendations)
    ? analysis.recommendations.map((r) => scalarText(r, 220)).filter((r) => r !== "—")
    : []
  const statusLine = [
    typeof analysis.completionStatus === "string" ? `Status: ${titleCase(analysis.completionStatus)}` : null,
    analysis.complianceScore != null ? `Compliance score: ${scalarText(analysis.complianceScore)}/100` : null,
  ].filter(Boolean).join(" · ")
  const sections: ClientPdfSection[] = [
    {
      heading: doc.name || "Seller Disclosure Package",
      pageBreak: true,
      ...(statusLine ? { paragraphs: [statusLine] } : {}),
      ...(rows.length ? { table: { header: ["Disclosure", "Status"], rows } } : {}),
    },
  ]
  if (recommendations.length) sections.push({ heading: "Recommendations", bullets: recommendations })
  return sections
}

/** Honest rendering when a document has no usable content (error / pending / string blob). */
function fallbackSections(doc: PacketDocumentLike): ClientPdfSection[] {
  const paragraphs =
    typeof doc.content === "string" && doc.content.trim()
      ? doc.content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 12)
      : [
          doc.status === "generated"
            ? "This document's content could not be laid out for print — view it in the listing packet panel."
            : `This document was not generated (status: ${doc.status}). Regenerate it from the listing packet panel.`,
        ]
  return [{ heading: doc.name || titleCase(doc.type), pageBreak: true, paragraphs }]
}

function genericDocSections(doc: PacketDocumentLike): ClientPdfSection[] {
  const c = asObject(doc.content)
  if (!c) return fallbackSections(doc)
  const walked = objectToSections(c)
  if (!walked.length) return fallbackSections(doc)
  // First walked sub-section flows under the tab heading; the tab itself owns the page break.
  return [{ heading: doc.name || titleCase(doc.type), pageBreak: true }, ...walked]
}

const money = (n: number | null | undefined) =>
  n == null ? null : `$${Math.round(n).toLocaleString("en-US")}`

/**
 * PURE spec builder: PacketDocument[] (config.content) + listing facts + brand
 * + the packet-level QR → the printable binder spec renderClientPdf consumes.
 */
export function listingPacketSpec(
  documents: PacketDocumentLike[],
  listing: PacketListingFacts,
  brand: ClientPdfBrand,
  qr: PacketQr | null,
  dateLabel: string,
): ClientPdfSpec {
  const sections: ClientPdfSection[] = []
  const disclaimers: string[] = [PACKET_DISCLAIMER]

  for (const doc of documents ?? []) {
    switch (doc?.type) {
      case "listing_flyer":
        sections.push(...flyerSections(doc, qr))
        break
      case "seller_disclosure":
        sections.push(...disclosureSections(doc))
        break
      default:
        sections.push(...genericDocSections(doc))
        break
    }
    // Carry each content object's own disclaimer (gis_report / tax_record /
    // appraiser_report set one) into the spec's small-print block.
    const carried = asObject(doc?.content)?.disclaimer
    if (typeof carried === "string" && carried.trim() && !disclaimers.includes(carried.trim())) {
      disclaimers.push(carried.trim())
    }
  }

  if (!sections.length) {
    sections.push({ paragraphs: ["No documents were generated for this packet."] })
  }

  const cityState = [listing.city, listing.state].filter(Boolean).join(", ")
  const price = money(listing.list_price)
  return {
    title: listing.address || "Listing Packet",
    subtitle: [cityState || null, price].filter(Boolean).join(" · ") || undefined,
    preparedLine: `Listing packet · ${dateLabel}`,
    brand,
    sections,
    disclaimer: disclaimers.join(" "),
  }
}
