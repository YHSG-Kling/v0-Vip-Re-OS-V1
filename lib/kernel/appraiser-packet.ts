/**
 * lib/kernel/appraiser-packet.ts
 *
 * THE APPRAISER PACKET — a PREVENTION coaching moment fired BEFORE the
 * appraisal (it pairs with the round-28 appraisal-gap detector, which fires
 * AFTER a low value lands in app/actions/transaction-milestones.ts).
 *
 * Owner's spec: when an appraisal is ORDERED on a LISTING we represent (the
 * seller side), coach the agent to BE PRESENT when the appraiser is at the
 * property and to bring a PACKET the appraiser needs — the appraisal
 * state-guideline-course checklist:
 *   - Full contract + all counters + addendums
 *   - 3-4 comps within 1mi sold within 6 months (expand radius/window if thin) —
 *     INCLUDING 1 pending + 1 active
 *   - GIS property report
 *   - Seller upgrades with DATE + COST of each
 *   - Tax report
 *   - Appraiser / appraisal-order details
 *   - Survey
 *   - Floorplan (if available)
 *
 * This module does two things:
 *   1. composeAppraiserPacket() — gathers the REAL sources (contract docs,
 *      comps, seller upgrades, appraisal-order details, survey, floorplan) and
 *      honestly flags "agent to obtain" for anything the OS genuinely doesn't
 *      hold (GIS + tax reports have no provider rail here). Renders a cover
 *      checklist + the assembled sections through the shared client-PDF engine
 *      (lib/documents/client-pdf — reused, not forked), hosts it in storage
 *      (hostRenderedMedia idiom), and records it in generated_documents.
 *   2. runAppraiserPacketCoaching() — the coaching moment: seller-side gated,
 *      idempotent per (transaction, appraisal order), composes the packet and
 *      creates ONE agent-facing task with an AI-authored brand-voice note (with
 *      a deterministic, data-derived fallback — never a hardcoded string).
 *
 * NO new tables (the packet rides generated_documents). Best-effort throughout —
 * the caller (the APPRAISAL_ORDERED hook) treats this as non-blocking garnish.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import {
  renderClientPdf,
  type ClientPdfSection,
  type ClientPdfSpec,
} from "@/lib/documents/client-pdf"
import { resolvePdfBrand } from "@/lib/documents/client-document-producer"
import { hostRenderedMedia } from "@/lib/remotion/media-host"
import {
  findCompsViaPerplexity,
  type PerplexityCompFinderResult,
  type ScoredComp,
} from "@/lib/cma/perplexity-comp-finder"

type Svc = ReturnType<typeof createServiceClient>

/** Source used to obtain the packet PDF — the coaching task links to it. */
const PACKET_DOCUMENT_TYPE = "appraiser_packet"
/** tasks.source — the idempotency key per (transaction, appraisal order). */
const COACHING_TASK_SOURCE = "appraiser_packet_coaching"

const money = (n: number | null | undefined) =>
  n == null || !Number.isFinite(Number(n)) ? "—" : `$${Math.round(Number(n)).toLocaleString("en-US")}`

const dateLabel = (d: Date = new Date()) =>
  d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

export interface PacketSectionStatus {
  key: string
  label: string
  /** true = we assembled it from a real record; false = agent must obtain it. */
  present: boolean
  detail: string
}

export interface ComposedPacket {
  ok: boolean
  documentId: string | null
  pdfUrl: string | null
  /** Per-section provenance (real vs agent-to-obtain) — surfaced in the task. */
  checklist: PacketSectionStatus[]
  compsTier: string | null
  error: string | null
}

export interface AppraiserPacketCoachingResult {
  fired: boolean
  /** Honest verdict — why it fired or was gated. */
  reason: string
  documentId?: string | null
  pdfUrl?: string | null
  taskId?: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction / listing loaders
// ─────────────────────────────────────────────────────────────────────────────

interface TxRow {
  id: string
  brokerage_id: string
  deal_type: string | null
  property_address: string | null
  property_city: string | null
  property_state: string | null
  property_zip: string | null
  purchase_price: number | null
  deal_name: string | null
  listing_id: string | null
  seller_contact_id: string | null
  buyer_contact_id: string | null
  contact_id: string | null
  agent_id: string | null
}

async function loadTransaction(svc: Svc, transactionId: string, brokerageId: string): Promise<TxRow | null> {
  const { data } = await svc
    .from("transactions")
    .select(
      "id, brokerage_id, deal_type, property_address, property_city, property_state, property_zip, " +
        "purchase_price, deal_name, listing_id, seller_contact_id, buyer_contact_id, contact_id, agent_id",
    )
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  return (data as TxRow | null) ?? null
}

/**
 * WE-represent-the-seller gate. deal_type is the canonical {buyer|seller|dual}
 * column (lib/application/transactions.ts). We represent the seller on "seller"
 * (listing side) and "dual" (in-house both sides) deals; a plain "buyer" deal is
 * an outside purchase — the buyer agent's job, not ours. Honest and explicit.
 */
export function representsSeller(dealType: string | null | undefined): boolean {
  const t = (dealType ?? "").toLowerCase()
  return t === "seller" || t === "dual"
}

// ─────────────────────────────────────────────────────────────────────────────
// Document gathering (contract / counters / addendums / survey / floorplan)
// ─────────────────────────────────────────────────────────────────────────────

interface NormalizedDoc {
  label: string
  type: string
  url: string | null
  status: string | null
}

function normDoc(raw: any): NormalizedDoc {
  // transaction_documents has schema drift across migrations: the live kernel
  // path (attachTransactionDocument) writes doc_type/doc_label/storage_url; older
  // rows use document_type/document_name/document_url. Read whichever exists.
  const type = String(raw.doc_type ?? raw.document_type ?? "document").toLowerCase()
  const label = String(raw.doc_label ?? raw.document_name ?? raw.file_name ?? type.replace(/_/g, " "))
  const url = raw.storage_url ?? raw.document_url ?? raw.blob_url ?? null
  const status = raw.status ?? null
  return { label, type, url, status }
}

interface GatheredDocs {
  contracts: NormalizedDoc[]
  counters: NormalizedDoc[]
  addendums: NormalizedDoc[]
  survey: NormalizedDoc[]
  floorplan: NormalizedDoc[]
}

function classify(docs: NormalizedDoc[]): GatheredDocs {
  const g: GatheredDocs = { contracts: [], counters: [], addendums: [], survey: [], floorplan: [] }
  for (const d of docs) {
    const t = d.type
    if (t.includes("counter")) g.counters.push(d)
    else if (t.includes("addend")) g.addendums.push(d)
    else if (t.includes("survey")) g.survey.push(d)
    else if (t.includes("floor")) g.floorplan.push(d)
    else if (t.includes("contract") || t.includes("purchase_agreement") || t.includes("purchase") || t.includes("agreement"))
      g.contracts.push(d)
  }
  return g
}

async function gatherTransactionDocuments(svc: Svc, transactionId: string): Promise<GatheredDocs> {
  const rows: NormalizedDoc[] = []
  // 1. Uploaded transaction documents (survey/floorplan uploads + signed contracts).
  try {
    const { data } = await svc.from("transaction_documents").select("*").eq("transaction_id", transactionId)
    for (const r of (data ?? []) as any[]) rows.push(normDoc(r))
  } catch {
    /* best-effort */
  }
  // 2. Generated documents (OS-produced offers/counters/addendums live here too).
  try {
    const { data } = await svc
      .from("generated_documents")
      .select("document_type, file_name, blob_url, metadata")
      .eq("transaction_id", transactionId)
      .neq("document_type", PACKET_DOCUMENT_TYPE) // never fold the packet into itself
    for (const r of (data ?? []) as any[]) rows.push(normDoc(r))
  } catch {
    /* best-effort */
  }
  return classify(rows)
}

// ─────────────────────────────────────────────────────────────────────────────
// Seller upgrades (date + cost)
// ─────────────────────────────────────────────────────────────────────────────

interface UpgradeRow {
  description: string
  cost: number | null
  dateLabel: string | null
}

async function gatherSellerUpgrades(svc: Svc, listingId: string | null): Promise<UpgradeRow[]> {
  if (!listingId) return []
  try {
    const { data } = await svc
      .from("property_upgrades")
      .select("upgrade_description, estimated_cost, status, created_at")
      .eq("listing_id", listingId)
      .in("status", ["completed", "approved"])
    return ((data ?? []) as any[]).map((u) => ({
      description: String(u.upgrade_description ?? "Upgrade"),
      cost: u.estimated_cost ?? null,
      // property_upgrades carries no completion-date column — created_at is the
      // only timestamp, so we surface it as a "recorded" date and ask the agent
      // to confirm the actual completion date with the seller (honest).
      dateLabel: u.created_at ? String(u.created_at).slice(0, 10) : null,
    }))
  } catch {
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Appraisal / appraiser order details
// ─────────────────────────────────────────────────────────────────────────────

interface AppraisalOrderInfo {
  lenderName: string | null
  loanOfficer: string | null
  orderedDate: string | null
}

async function gatherAppraisalOrder(svc: Svc, transactionId: string): Promise<AppraisalOrderInfo> {
  try {
    const { data } = await svc
      .from("transaction_lenders")
      .select("lender_name, loan_officer_name, appraisal_ordered_date")
      .eq("transaction_id", transactionId)
      .maybeSingle()
    return {
      lenderName: (data as any)?.lender_name ?? null,
      loanOfficer: (data as any)?.loan_officer_name ?? null,
      orderedDate: (data as any)?.appraisal_ordered_date ?? null,
    }
  } catch {
    return { lenderName: null, loanOfficer: null, orderedDate: null }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Comps — reuse the internal comp engine with the spec's fallback ladder
// ─────────────────────────────────────────────────────────────────────────────

interface CompsBundle {
  result: PerplexityCompFinderResult | null
  tierLabel: string | null
}

/**
 * Spec fallback ladder: 3-4 closed comps within 1mi sold in 6mo (+1 pending
 * +1 active). If thin, EXPAND — first the window to a year, then the radius.
 * Reuses lib/cma/perplexity-comp-finder (the internal comp engine; no scraper).
 * Best-effort — returns the best tier reached, or null if the engine is down.
 */
async function gatherComps(subject: {
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  beds: number | null
  baths: number | null
  sqft: number | null
  yearBuilt: number | null
  propertyType: string | null
}): Promise<CompsBundle> {
  if (!subject.address) return { result: null, tierLabel: null }

  const tiers = [
    { radius: 1, months: 6, label: "within 1 mile, sold in the last 6 months" },
    { radius: 1, months: 12, label: "within 1 mile, sold in the last 12 months (window expanded)" },
    { radius: 2, months: 12, label: "within 2 miles, sold in the last 12 months (radius + window expanded)" },
  ]

  let best: PerplexityCompFinderResult | null = null
  let bestLabel: string | null = null

  for (const tier of tiers) {
    try {
      const r = await findCompsViaPerplexity({
        subjectAddress: subject.address,
        subjectCity: subject.city,
        subjectState: subject.state,
        subjectZip: subject.zip,
        subjectBeds: subject.beds,
        subjectBaths: subject.baths,
        subjectSqft: subject.sqft,
        subjectYearBuilt: subject.yearBuilt,
        subjectPropertyType: subject.propertyType,
        searchRadiusMiles: tier.radius,
        monthsBack: tier.months,
      })
      // Prefer the first tier that yields the target 3 closed comps.
      if (r.closedComps.length >= 3) return { result: r, tierLabel: tier.label }
      // Otherwise keep the richest partial result as we expand.
      if (!best || r.closedComps.length > best.closedComps.length) {
        best = r
        bestLabel = tier.label
      }
    } catch {
      /* try the next, wider tier */
    }
  }
  return { result: best, tierLabel: bestLabel }
}

function compRow(c: ScoredComp): string[] {
  const bedBath = [
    c.bedrooms != null ? `${c.bedrooms}bd` : null,
    c.fullBaths != null ? `${c.fullBaths}ba` : null,
  ]
    .filter(Boolean)
    .join("/")
  return [
    c.address,
    c.status,
    money(c.salePrice),
    c.saleDate ?? "—",
    bedBath || "—",
    c.sqftLiving != null ? `${c.sqftLiving}` : "—",
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// composeAppraiserPacket — assemble + render + host + record
// ─────────────────────────────────────────────────────────────────────────────

export async function composeAppraiserPacket(args: {
  transactionId: string
  brokerageId: string
  /** auth.users.id of the actor (used for provenance only). */
  actorUserId?: string | null
  /** Optional pre-loaded transaction row to avoid a re-read. */
  tx?: TxRow | null
  svc?: Svc
}): Promise<ComposedPacket> {
  const svc = args.svc ?? createServiceClient()
  const empty = (error: string): ComposedPacket => ({
    ok: false,
    documentId: null,
    pdfUrl: null,
    checklist: [],
    compsTier: null,
    error,
  })

  try {
    const tx = args.tx ?? (await loadTransaction(svc, args.transactionId, args.brokerageId))
    if (!tx) return empty("Transaction not found")

    // Subject facts — prefer the linked listing (most authoritative), else the tx.
    let subject = {
      address: tx.property_address,
      city: tx.property_city,
      state: tx.property_state,
      zip: tx.property_zip,
      beds: null as number | null,
      baths: null as number | null,
      sqft: null as number | null,
      yearBuilt: null as number | null,
      propertyType: null as string | null,
    }
    if (tx.listing_id) {
      try {
        const { data: l } = await svc.from("listings").select("*").eq("id", tx.listing_id).maybeSingle()
        if (l) {
          const ll = l as any
          subject = {
            address: subject.address ?? ll.address ?? null,
            city: subject.city ?? ll.city ?? null,
            state: subject.state ?? ll.state ?? null,
            zip: subject.zip ?? ll.zip ?? null,
            beds: ll.bedrooms ?? null,
            baths: ll.bathrooms ?? null,
            sqft: ll.square_feet ?? ll.sqft ?? ll.living_area ?? null,
            yearBuilt: ll.year_built ?? null,
            propertyType: ll.property_type ?? null,
          }
        }
      } catch {
        /* best-effort */
      }
    }

    // Gather every real source in parallel.
    const [docs, upgrades, order, comps] = await Promise.all([
      gatherTransactionDocuments(svc, tx.id),
      gatherSellerUpgrades(svc, tx.listing_id),
      gatherAppraisalOrder(svc, tx.id),
      gatherComps(subject),
    ])

    const propertyLabel = tx.property_address ?? tx.deal_name ?? "the property"

    // ── Build the checklist provenance (drives both the PDF cover + the task) ──
    const closedCount = comps.result?.closedComps.length ?? 0
    const hasPending = !!comps.result?.pendingComp
    const hasActive = !!comps.result?.activeComp
    const contractDocs = [...docs.contracts, ...docs.counters, ...docs.addendums]

    const checklist: PacketSectionStatus[] = [
      {
        key: "contract",
        label: "Full contract + all counters + addendums",
        present: contractDocs.length > 0,
        detail:
          contractDocs.length > 0
            ? `${docs.contracts.length} contract, ${docs.counters.length} counter(s), ${docs.addendums.length} addendum(s) on file`
            : "Not on file in the deal — attach the executed contract, counters, and addendums",
      },
      {
        key: "comps",
        label: "3-4 comps within 1mi/6mo, incl. 1 pending + 1 active",
        present: closedCount >= 1,
        detail:
          closedCount >= 1
            ? `${closedCount} closed${hasPending ? " + 1 pending" : ""}${hasActive ? " + 1 active" : ""} (${comps.tierLabel})`
            : "Comp engine returned nothing — pull comps before the appointment",
      },
      {
        key: "gis",
        label: "GIS property report",
        present: false,
        detail: "No GIS provider connected — agent to obtain from the county/parcel GIS portal",
      },
      {
        key: "upgrades",
        label: "Seller upgrades (date + cost of each)",
        present: upgrades.length > 0,
        detail:
          upgrades.length > 0
            ? `${upgrades.length} upgrade(s) on file — confirm each completion date + actual cost with the seller`
            : "None recorded — collect the seller's upgrade list with dates + costs",
      },
      {
        key: "tax",
        label: "Tax report",
        present: false,
        detail: "No tax-data provider connected — agent to obtain the county tax report",
      },
      {
        key: "appraisal_order",
        label: "Appraiser / appraisal-order details",
        present: !!(order.lenderName || order.orderedDate),
        detail:
          order.lenderName || order.orderedDate
            ? [order.lenderName, order.loanOfficer, order.orderedDate ? `ordered ${order.orderedDate}` : null]
                .filter(Boolean)
                .join(" · ")
            : "Confirm the appraisal-order details with the lender",
      },
      {
        key: "survey",
        label: "Copy of the survey",
        present: docs.survey.length > 0,
        detail: docs.survey.length > 0 ? "On file in the deal" : "Not on file — obtain the survey if one exists",
      },
      {
        key: "floorplan",
        label: "Copy of the floorplan (if available)",
        present: docs.floorplan.length > 0,
        detail: docs.floorplan.length > 0 ? "On file in the deal" : "Optional — include if a floorplan exists",
      },
    ]

    // ── PDF sections ──
    const sections: ClientPdfSection[] = []

    // Cover coaching + the state-guideline checklist.
    sections.push({
      heading: "Be present + bring this packet",
      paragraphs: [
        `An appraisal has been ordered on ${propertyLabel}. Plan to be present when the appraiser is at ` +
          `the home, and bring (or leave at the property) this packet so the appraiser has the full picture ` +
          `of the contract, the comparable sales, and the home's upgrades. You can hand it to the appraiser at ` +
          `the appointment or leave it at the home for them.`,
      ],
      bullets: checklist.map((c) => `${c.present ? "[x]" : "[ ]"} ${c.label} — ${c.detail}`),
    })

    // Contract + counters + addendums (an INDEX to the real documents in the deal file).
    if (contractDocs.length > 0) {
      sections.push({
        heading: "Contract, counters & addendums",
        paragraphs: ["The executed documents below are in the deal file — print or pull them into the packet."],
        table: {
          header: ["Document", "Type", "Status"],
          rows: contractDocs.map((d) => [d.label, d.type.replace(/_/g, " "), d.status ?? "on file"]),
        },
      })
    } else {
      sections.push({
        heading: "Contract, counters & addendums",
        paragraphs: [
          "No executed contract documents are on file in this deal yet. Attach the full purchase contract, all " +
            "counters, and every addendum before the appraisal appointment.",
        ],
      })
    }

    // Comps.
    if (comps.result && (closedCount > 0 || hasPending || hasActive)) {
      const rows: string[][] = []
      for (const c of comps.result.closedComps) rows.push(compRow(c))
      if (comps.result.pendingComp) rows.push(compRow(comps.result.pendingComp))
      if (comps.result.activeComp) rows.push(compRow(comps.result.activeComp))
      sections.push({
        heading: "Comparable sales",
        paragraphs: [
          `Comps selected ${comps.tierLabel}. Includes ${closedCount} closed sale(s)` +
            `${hasPending ? ", 1 pending" : ""}${hasActive ? ", 1 active" : ""} for the appraiser's reference.`,
        ],
        table: {
          header: ["Address", "Status", "Price", "Date", "Bd/Ba", "SqFt"],
          rows,
        },
      })
    } else {
      sections.push({
        heading: "Comparable sales",
        paragraphs: [
          "Comps were not available automatically. Pull 3-4 comparable sales within one mile that closed in the " +
            "last six months (expand the radius or to within a year if needed), and include one pending and one " +
            "active listing, before the appointment.",
        ],
      })
    }

    // Seller upgrades.
    if (upgrades.length > 0) {
      sections.push({
        heading: "Seller upgrades",
        paragraphs: [
          "Upgrades recorded for this home. Confirm the completion date and actual cost of each with the seller — " +
            "the appraiser values documented, dated improvements.",
        ],
        table: {
          header: ["Upgrade", "Date (confirm)", "Cost"],
          rows: upgrades.map((u) => [u.description, u.dateLabel ?? "confirm w/ seller", money(u.cost)]),
        },
      })
    } else {
      sections.push({
        heading: "Seller upgrades",
        paragraphs: [
          "No upgrades are on file. Ask the seller for a written list of improvements with the DATE completed and " +
            "the COST of each — this is one of the most valuable pieces for the appraiser.",
        ],
      })
    }

    // Appraisal order details.
    sections.push({
      heading: "Appraisal order details",
      bullets: [
        `Lender: ${order.lenderName ?? "confirm with the loan officer"}`,
        `Loan officer: ${order.loanOfficer ?? "confirm"}`,
        `Appraisal ordered: ${order.orderedDate ?? "confirm the order date + appraiser contact with the lender"}`,
        `Contract price: ${money(tx.purchase_price)}`,
      ],
    })

    // GIS + tax — honest agent-to-obtain (no provider rail exists here).
    sections.push({
      heading: "GIS property report & tax report",
      bullets: [
        "GIS property report — the OS has no GIS provider connected. Obtain the parcel/GIS report from the county " +
          "GIS portal and add it to the packet.",
        "Tax report — no tax-data provider is connected. Pull the county tax report (assessed value + annual taxes) " +
          "and add it to the packet.",
      ],
    })

    // Survey + floorplan.
    sections.push({
      heading: "Survey & floorplan",
      bullets: [
        docs.survey.length > 0
          ? `Survey: on file in the deal (${docs.survey.map((d) => d.label).join(", ")}).`
          : "Survey: not on file — include a copy if one exists for the property.",
        docs.floorplan.length > 0
          ? `Floorplan: on file in the deal (${docs.floorplan.map((d) => d.label).join(", ")}).`
          : "Floorplan: optional — include if available.",
      ],
    })

    // Brand block — resolve the agent's users.id from their agents.id for the
    // brand/license lookup (resolvePdfBrand keys off users.id).
    let agentUserId: string | null = null
    if (tx.agent_id) {
      try {
        const { data: ag } = await svc.from("agents").select("user_id").eq("id", tx.agent_id).maybeSingle()
        agentUserId = (ag as any)?.user_id ?? null
      } catch {
        /* defaults keep the render valid */
      }
    }
    const brand = await resolvePdfBrand(svc, { brokerageId: tx.brokerage_id, agentUserId })

    const spec: ClientPdfSpec = {
      title: "Appraiser Packet",
      subtitle: propertyLabel,
      preparedLine: `Prepared for the appraisal · ${dateLabel()}`,
      brand,
      sections,
      disclaimer:
        "This packet is a courtesy compilation of transaction facts, comparable sales, and property " +
        "improvements provided to assist the appraiser. Comparable sales are drawn from available public " +
        "data and are for reference only; they are not an appraisal or a determination of value under USPAP. " +
        "The appraiser independently determines the opinion of value. Verify all figures against source records.",
    }

    // Render → host → record in generated_documents (no new table).
    const bytes = await renderClientPdf(spec)
    const buf = Buffer.from(bytes)
    const fileName = `appraiser-packet-${tx.id}-${Date.now()}.pdf`
    const pdfUrl = await hostRenderedMedia(svc, `client-docs/${tx.brokerage_id}/${fileName}`, buf, "application/pdf")

    let documentId: string | null = null
    try {
      const { data: doc } = await svc
        .from("generated_documents")
        .insert({
          brokerage_id: tx.brokerage_id,
          agent_id: tx.agent_id ?? null,
          contact_id: tx.seller_contact_id ?? tx.contact_id ?? null,
          listing_id: tx.listing_id ?? null,
          transaction_id: tx.id,
          document_type: PACKET_DOCUMENT_TYPE,
          blob_url: pdfUrl,
          blob_id: `client-docs/${tx.brokerage_id}/${fileName}`,
          file_name: fileName,
          file_size: buf.length,
          metadata: {
            title: spec.title,
            comps_tier: comps.tierLabel,
            checklist: checklist.map((c) => ({ key: c.key, present: c.present })),
          },
        })
        .select("id")
        .single()
      documentId = (doc as { id: string } | null)?.id ?? null
    } catch {
      /* the hosted PDF URL is still returned even if the ledger insert fails */
    }

    return { ok: true, documentId, pdfUrl, checklist, compsTier: comps.tierLabel, error: null }
  } catch (e) {
    return empty(e instanceof Error ? e.message : String(e))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coaching copy — AI-authored brand voice, deterministic data-derived fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The agent-facing coaching note. AI-authored in brand voice; on ANY failure it
 * falls back to a deterministic note ASSEMBLED FROM the packet's real checklist
 * state (never a hardcoded marketing string). Returns plain text.
 */
async function authorCoachingNote(input: {
  propertyLabel: string
  checklist: PacketSectionStatus[]
  pdfUrl: string | null
}): Promise<string> {
  const present = input.checklist.filter((c) => c.present)
  const toObtain = input.checklist.filter((c) => !c.present)

  // Deterministic, data-derived fallback (used verbatim if the model fails).
  const fallback = buildDeterministicNote(input.propertyLabel, present, toObtain)

  try {
    const { generateText } = await import("ai")
    const { resolveModel } = await import("@/lib/ai/resolve-model")
    const { text } = await generateText({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      system:
        "You are a real estate coaching assistant writing a short, warm, confident note to a LISTING agent. " +
        "The moment: an appraisal was just ordered on their listing. Coach them, per appraisal course guidance, to " +
        "(1) BE PRESENT when the appraiser is at the property, and (2) bring a prepared packet (or leave it at the " +
        "home / hand it to the appraiser). Be specific and encouraging, 3-5 sentences, no headings, no lists, no " +
        "emojis. Plain text only.",
      prompt:
        `Property: ${input.propertyLabel}\n` +
        `Packet items ready: ${present.map((c) => c.label).join("; ") || "none yet"}\n` +
        `Items the agent still needs to obtain: ${toObtain.map((c) => c.label).join("; ") || "none"}\n` +
        `The full packet PDF is attached to this task.\n` +
        `Write the coaching note.`,
    })
    const clean = text.trim()
    return clean.length > 0 ? clean : fallback
  } catch {
    return fallback
  }
}

function buildDeterministicNote(
  propertyLabel: string,
  present: PacketSectionStatus[],
  toObtain: PacketSectionStatus[],
): string {
  const readyLine =
    present.length > 0
      ? `The packet already has: ${present.map((c) => c.label).join("; ")}.`
      : `Start the packet from the checklist below.`
  const obtainLine =
    toObtain.length > 0
      ? ` Before the appointment, still get: ${toObtain.map((c) => c.label).join("; ")}.`
      : ` Everything on the checklist is assembled.`
  return (
    `An appraisal was just ordered on ${propertyLabel}. Plan to be present when the appraiser is at the home — ` +
    `it's your best chance to make sure they see the full picture. Bring the prepared packet and either hand it ` +
    `to the appraiser at the appointment or leave it at the property for them. ${readyLine}${obtainLine}`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// runAppraiserPacketCoaching — the seller-gated, idempotent coaching moment
// ─────────────────────────────────────────────────────────────────────────────

export async function runAppraiserPacketCoaching(args: {
  transactionId: string
  brokerageId: string
  actorUserId?: string | null
  svc?: Svc
}): Promise<AppraiserPacketCoachingResult> {
  const svc = args.svc ?? createServiceClient()

  const tx = await loadTransaction(svc, args.transactionId, args.brokerageId)
  if (!tx) return { fired: false, reason: "skipped: transaction not found in brokerage" }

  // ── Seller-side gate — an appraisal on a buyer's outside purchase is the
  //    buyer agent's job; we only prep the packet where WE list the home. ──
  if (!representsSeller(tx.deal_type)) {
    return { fired: false, reason: `skipped: not a seller-side deal (deal_type=${tx.deal_type ?? "unknown"})` }
  }

  // ── Idempotency per (transaction, appraisal order): one coaching task per deal.
  try {
    const { data: existing } = await svc
      .from("tasks")
      .select("id")
      .eq("brokerage_id", args.brokerageId)
      .eq("transaction_id", tx.id)
      .eq("source", COACHING_TASK_SOURCE)
      .limit(1)
      .maybeSingle()
    if (existing) {
      return { fired: false, reason: "skipped: coaching task already exists for this appraisal order", taskId: (existing as any).id }
    }
  } catch {
    /* if the dedupe read fails, fall through — a duplicate task is a soft failure */
  }

  // ── Compose the packet PDF (best-effort; the coaching task fires regardless). ──
  const packet = await composeAppraiserPacket({
    transactionId: tx.id,
    brokerageId: args.brokerageId,
    actorUserId: args.actorUserId,
    tx,
    svc,
  })

  const propertyLabel = tx.property_address ?? tx.deal_name ?? "your listing"
  const note = await authorCoachingNote({
    propertyLabel,
    checklist: packet.checklist,
    pdfUrl: packet.pdfUrl,
  })

  const description =
    note +
    (packet.pdfUrl ? `\n\nPacket PDF: ${packet.pdfUrl}` : "\n\n(Packet PDF could not be generated — build it from the checklist above.)")

  // ── The agent-facing task. transactions.agent_id IS the agents.id (same id
  //    space as tasks.assigned_to_agent_id — see lib/kernel/flow-integrity.ts). ──
  let taskId: string | null = null
  try {
    const { data: task, error } = await svc
      .from("tasks")
      .insert({
        brokerage_id: args.brokerageId,
        transaction_id: tx.id,
        contact_id: tx.seller_contact_id ?? tx.contact_id ?? null,
        assigned_to_agent_id: tx.agent_id ?? null,
        title: "Prep for the appraisal — be present + bring the packet",
        description,
        due_date: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        assignee_type: "agent",
        source: COACHING_TASK_SOURCE,
        status: "pending",
        created_at: new Date().toISOString(),
      })
      .select("id")
      .single()
    if (error) return { fired: false, reason: `failed: task insert (${error.message})`, documentId: packet.documentId, pdfUrl: packet.pdfUrl }
    taskId = (task as { id: string } | null)?.id ?? null
  } catch (e) {
    return { fired: false, reason: `failed: ${e instanceof Error ? e.message : String(e)}`, documentId: packet.documentId, pdfUrl: packet.pdfUrl }
  }

  return {
    fired: true,
    reason: packet.ok ? "seller-side appraiser packet prepared + agent coached" : "agent coached (packet PDF partial — see checklist)",
    documentId: packet.documentId,
    pdfUrl: packet.pdfUrl,
    taskId,
  }
}
