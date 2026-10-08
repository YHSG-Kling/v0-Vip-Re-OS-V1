"use server"

/**
 * Generated-document library server action — the produced-PDF rail.
 *
 * DELIBERATELY A SIBLING OF, NOT A MODIFICATION TO, the Document Center
 * (app/actions/document-center.ts). The two tables are different provenances:
 * `client_documents` is what was UPLOADED or RECEIVED (portal uploads, scans,
 * e-sign returns); `generated_documents` is what the platform PRODUCED
 * (lib/documents/client-document-producer.ts — CMAs, net sheets, guides,
 * presentations, brochures, packets, recruiting pitches). Merging the rails
 * would let a produced marketing PDF masquerade as a received deal document.
 *
 * Loader mirrors getDocumentCenterData (document-center.ts:76-115): the act-as
 * seam (resolveActingContext → ctx.db), refuse when !ok || !brokerageId, every
 * read brokerage-scoped, and a NON-elevated seat pinned to its own agents row
 * — generated_documents.agent_id is AGENTS-class, so the comparison is
 * ctx.agentId, never ctx.userId (disjoint id spaces, 23503).
 */

import { resolveActingContext } from "@/lib/platform/acting-context"

export interface GeneratedDocumentRow {
  id: string
  documentType: string
  /** metadata.title when the producer stamped one, else the file name. */
  title: string
  fileName: string | null
  fileSizeBytes: number | null
  createdAt: string
  contactId: string | null
  contactName: string | null
  listingId: string | null
  listingAddress: string | null
  /**
   * A SIGNED, EXPIRING storage URL, opened with a plain anchor.
   *
   * It used to be a permanent public one: the producers hosted every PDF into
   * `video-assets` (a PUBLIC_MEDIA bucket) by omitting hostRenderedMedia's
   * bucket argument, so blob_url was a bearer capability with no session, no RLS
   * and no expiry — for CMAs carrying a named client's valuation, net sheets
   * carrying a seller's proceeds, and recruiting pitches carrying brokerage
   * terms. Both producers now name GENERATED_DOCUMENT_BUCKET (document-class),
   * so the one issuer (lib/storage/document-buckets.ts#issueBucketObjectUrl)
   * SIGNS the URL instead of publishing it.
   *
   * NOTHING CHANGES FOR THIS READER: a signed URL is still a URL an anchor can
   * open, and it is minted at DOC_URL_TTL_SECONDS precisely because rows persist
   * it (lib/storage/signed-doc-url.ts documents that bridge). The correct
   * end-state is sign-on-read, and the object key is already on the row —
   * generated_documents.blob_id — so that refactor has what it needs; it is not
   * done here because it would change this action's contract, not just its
   * bucket. The governed-URL custody wrapper (issueGovernedDocumentUrl /
   * document-custody) still serves `client_documents` rows, not this table.
   */
  blobUrl: string | null
}

export async function getGeneratedDocumentLibrary(): Promise<{
  success: boolean
  documents: GeneratedDocumentRow[]
  error?: string
}> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.brokerageId) {
    return { success: false, documents: [], error: "Unauthorized" }
  }

  // ACT-AS SEAM: read THROUGH ctx.db — cookie/RLS client for a tenant seat,
  // service client under an active impersonation grant.
  const supabase = ctx.db

  const role = ctx.userType
  // The Document Center's own scope ladder (document-center.ts:87).
  const elevated = ["admin", "broker", "broker_owner", "broker_admin", "tc", "transaction_coordinator", "compliance_officer"].includes(role ?? "")

  let q = supabase
    .from("generated_documents")
    .select("id, document_type, file_name, file_size, created_at, contact_id, listing_id, blob_url, metadata")
    .eq("brokerage_id", ctx.brokerageId)
    .order("created_at", { ascending: false })
    .limit(500)

  if (!elevated) {
    // Agents-class predicate: generated_documents.agent_id FKs agents(id).
    // A non-elevated seat with no agents row owns no rail — an honest empty
    // list, never the whole brokerage's (§4, fail closed).
    if (!ctx.agentId) return { success: true, documents: [] }
    q = q.eq("agent_id", ctx.agentId)
  }

  const { data: docs, error } = await q
  // §3 — a refused read is a refusal, never an empty library.
  if (error) {
    return { success: false, documents: [], error: error.message }
  }

  // Batched, tenant-anchored context resolution (listing-packet rows carry
  // only listing_id — the address is their "For" label).
  const contactIds = Array.from(new Set((docs ?? []).map((d: any) => d.contact_id).filter(Boolean) as string[]))
  const listingIds = Array.from(new Set((docs ?? []).map((d: any) => d.listing_id).filter(Boolean) as string[]))

  const [{ data: contacts }, { data: listings }] = await Promise.all([
    contactIds.length > 0
      ? supabase.from("contacts").select("id, first_name, last_name").eq("brokerage_id", ctx.brokerageId).in("id", contactIds)
      : Promise.resolve({ data: [] as any[] }),
    listingIds.length > 0
      ? supabase.from("listings").select("id, address").eq("brokerage_id", ctx.brokerageId).in("id", listingIds)
      : Promise.resolve({ data: [] as any[] }),
  ])

  const contactMap = new Map((contacts ?? []).map((c: any) => [c.id, `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Unnamed"]))
  const listingMap = new Map((listings ?? []).map((l: any) => [l.id, l.address ?? null]))

  const documents: GeneratedDocumentRow[] = (docs ?? []).map((d: any) => ({
    id: d.id,
    documentType: d.document_type ?? "other",
    title: (d.metadata as any)?.title ?? d.file_name ?? "Untitled",
    fileName: d.file_name ?? null,
    fileSizeBytes: typeof d.file_size === "number" ? d.file_size : null,
    createdAt: d.created_at,
    contactId: d.contact_id ?? null,
    contactName: d.contact_id ? contactMap.get(d.contact_id) ?? null : null,
    listingId: d.listing_id ?? null,
    listingAddress: d.listing_id ? listingMap.get(d.listing_id) ?? null : null,
    blobUrl: d.blob_url ?? null,
  }))

  return { success: true, documents }
}
