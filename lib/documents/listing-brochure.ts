/**
 * lib/documents/listing-brochure.ts
 *
 * THE MULTI-PAGE LISTING BROCHURE — the premium leave-behind for showings
 * and listing appointments (postcard < flyer < BROCHURE). A designed,
 * photo-forward PDF: brand cover, AI-composed opening narrative (grounded
 * ONLY in the listing's own remarks/facts, compliance-gated, deterministic
 * fact copy as the fallback — copy is never hardcoded), photo spreads laid
 * out by the engine, the facts table, highlights, and the agent page.
 *
 * Autonomous: marketing-window listings with enough photos get a brochure
 * once (idempotent via generated_documents), the finished PDF hosts on
 * Supabase storage, and the AGENT is notified with the print-ready link.
 * Rides the daily video-plays cron (asset_manager).
 */
import sharp from "sharp"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import type { ClientPdfBrand, ClientPdfPhoto, ClientPdfSection, ClientPdfSpec } from "./client-pdf"

async function fetchPhotoAsJpeg(url: string): Promise<ClientPdfPhoto | null> {
  const dl = await callConnector<Buffer>({
    connector: "asset-download", baseUrl: "", path: "", url,
    method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 25_000,
  })
  if (!dl.ok || !dl.data) return null
  try {
    const bytes = await sharp(dl.data, { failOn: "none" }).rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true }).toBuffer()
    return { bytes, kind: "jpg" }
  } catch { return null }
}

export interface BrochureListing {
  id: string
  brokerage_id: string
  address: string
  cityState: string
  price: string
  beds: string
  baths: string
  sqft: string
  propertyType: string
  remarks: string
  highlights: string[]
  photoUrls: string[]
}

/** Build the brochure spec — narrative injected by the caller (AI-first). */
export function listingBrochureSpec(
  l: BrochureListing,
  narrative: string,
  photos: ClientPdfPhoto[],
  brand: ClientPdfBrand,
  dateLabel: string,
): ClientPdfSpec {
  const sections: ClientPdfSection[] = []
  if (photos[0]) sections.push({ photos: [photos[0]] }) // hero spread under the cover band
  sections.push({
    heading: "The home",
    paragraphs: narrative.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 4),
    table: {
      rows: [
        ["Offered at", l.price],
        ["Bedrooms", l.beds], ["Bathrooms", l.baths],
        ["Living area", l.sqft ? `${l.sqft} sqft` : "—"],
        ["Property type", l.propertyType || "—"],
      ],
    },
  })
  if (l.highlights.length) sections.push({ heading: "What sets it apart", bullets: l.highlights.slice(0, 6) })
  const gallery = photos.slice(1, 9)
  if (gallery.length) sections.push({ heading: "Inside & out", photos: gallery, pageBreak: true })
  sections.push({
    heading: "See it in person",
    paragraphs: [
      `Private tours are arranged directly with ${brand.agentName ?? "the listing agent"} at ${brand.brokerageName}. ` +
      `Every detail in this brochure comes from the listing record; measurements and figures should be independently verified.`,
    ],
  })
  return {
    title: l.address,
    subtitle: `${l.cityState} · ${l.price}`,
    preparedLine: dateLabel,
    brand,
    sections,
    disclaimer:
      "Information deemed reliable but not guaranteed. Buyers should verify all facts, figures, and measurements. " +
      "If your home is currently listed with another broker, this is not a solicitation.",
  }
}

export async function runListingBrochures(svc: any): Promise<{ brochures: number; brochureErrors: number }> {
  const out = { brochures: 0, brochureErrors: 0 }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: listings } = await svc.from("listings")
    .select("id, brokerage_id, agent_id, address, city, state, list_price, bedrooms, bathrooms, sqft, property_type, public_remarks, photos, primary_photo_url, lifecycle_stage")
    .in("lifecycle_stage", ["COMING_SOON_ACTIVE", "MLS_ACTIVE", "OPEN_HOUSE_MARKETING", "OPEN_HOUSE_EVENT"])
    .is("deleted_at", null).gte("created_at", since).limit(100)

  for (const l of ((listings ?? []) as any[])) {
    const photoUrls = [
      ...(l.primary_photo_url ? [l.primary_photo_url] : []),
      ...(Array.isArray(l.photos) ? l.photos.map((p: any) => (typeof p === "string" ? p : p?.url)).filter((u: any) => typeof u === "string") : []),
    ].filter((u, i, a) => a.indexOf(u) === i)
    if (photoUrls.length < 6) continue // a brochure without a photo story is a flyer
    try {
      const { data: existing } = await svc.from("generated_documents").select("id")
        .eq("listing_id", l.id).eq("document_type", "listing_brochure").limit(1).maybeSingle()
      if (existing) continue

      const { data: agent } = await svc.from("agents").select("user_id").eq("id", l.agent_id).maybeSingle()
      const agentUserId = (agent as any)?.user_id
      if (!agentUserId) continue

      const { resolvePdfBrand, produceClientDocument } = await import("./client-document-producer")
      const brand = await resolvePdfBrand(svc, { brokerageId: l.brokerage_id, agentUserId })

      const listing: BrochureListing = {
        id: l.id, brokerage_id: l.brokerage_id,
        address: l.address ?? "", cityState: [l.city, l.state].filter(Boolean).join(", "),
        price: l.list_price ? `$${Number(l.list_price).toLocaleString("en-US")}` : "",
        beds: String(l.bedrooms ?? ""), baths: String(l.bathrooms ?? ""),
        sqft: l.sqft ? Number(l.sqft).toLocaleString("en-US") : "",
        propertyType: l.property_type ?? "",
        remarks: String(l.public_remarks ?? ""),
        highlights: String(l.public_remarks ?? "").split(/[.\n]/).map((s: string) => s.trim()).filter((s: string) => s.length > 12 && s.length < 70).slice(0, 6),
        photoUrls,
      }

      // Narrative: AI-first (facts-only, gated by the copy rail's FH rules),
      // the listing's own remarks as the deterministic fallback.
      let narrative = listing.remarks || `${listing.address} — ${listing.beds} bedrooms, ${listing.baths} baths, ${listing.sqft} square feet in ${listing.cityState}.`
      try {
        const { generatePersonaCopy, realCopyGenerator } = await import("@/lib/kernel/ai-copy")
        const draft = await generatePersonaCopy(
          {
            goal: "a two-paragraph listing brochure opening narrative (editorial, magazine tone)",
            facts: [listing.address, listing.cityState, listing.price, `${listing.beds} bed / ${listing.baths} bath / ${listing.sqft} sqft`, ...listing.highlights],
            channel: "landing_page", persona: { audience: "home shoppers" }, words: 120,
          },
          { body: narrative }, { generator: realCopyGenerator },
        )
        narrative = draft.body || narrative
      } catch { /* remarks stand */ }

      const photos = (await Promise.all(photoUrls.slice(0, 9).map(fetchPhotoAsJpeg))).filter(Boolean) as ClientPdfPhoto[]
      if (photos.length < 4) continue // fetch failures — retry next run

      const dateLabel = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long" })
      const spec = listingBrochureSpec(listing, narrative, photos, brand, dateLabel)
      const produced = await produceClientDocument(svc, {
        brokerageId: l.brokerage_id, agentUserId, listingId: l.id,
        documentType: "listing_brochure", spec,
        metadata: { source: "auto_listing_brochure", photo_count: photos.length },
      })
      if (!produced.ok || !produced.pdfUrl) { out.brochureErrors += 1; continue }

      await svc.from("notifications").insert({
        user_id: agentUserId, brokerage_id: l.brokerage_id, type: "listing_brochure_ready",
        title: `Brochure ready — ${listing.address}`,
        body: `The multi-page listing brochure (photo spreads, narrative, facts) is print-ready: ${produced.pdfUrl} [brochure:${l.id}]`,
        priority: "medium", channel: "in_app", is_read: false,
      }).then(undefined, () => {})
      out.brochures += 1
    } catch { out.brochureErrors += 1 }
  }
  return out
}
