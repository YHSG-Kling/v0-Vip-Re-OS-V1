import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface ResolvedEventContacts {
  contactId?:        string
  buyerContactId?:   string
  sellerContactId?:  string
  transactionId?:    string
  listingId?:        string
}

/**
 * Resolve ALL represented contact sides for an event's entity (buyer + seller for two-sided deals),
 * plus the related transaction/listing ids. Single source of truth shared by emitTransactionEvent
 * (the enriching emit helper) and the kernel reactor's fallback for bare processKernelEvent callers —
 * so a templated two-sided event reaches both the buyer AND the seller regardless of which path
 * emitted it. The unrepresented side (e.g. outside listing) simply resolves to undefined.
 */
export async function resolveEventContacts(
  svc:        ReturnType<typeof createServiceClient>,
  entityType: string,
  entityId:   string,
): Promise<ResolvedEventContacts> {
  const out: ResolvedEventContacts = {}
  try {
    if (entityType === "transaction") {
      out.transactionId = entityId
      const { data: tx } = await svc
        .from("transactions")
        .select("buyer_contact_id, seller_contact_id, contact_id, listing_id")
        .eq("id", entityId)
        .maybeSingle()
      out.buyerContactId  = tx?.buyer_contact_id  ?? undefined
      out.sellerContactId = tx?.seller_contact_id ?? undefined
      out.contactId       = tx?.contact_id        ?? undefined
      out.listingId       = tx?.listing_id        ?? undefined
    } else if (entityType === "offer") {
      const { data: o } = await svc
        .from("offers")
        .select("contact_id, listing_id, transaction_id")
        .eq("id", entityId)
        .maybeSingle()
      out.buyerContactId = o?.contact_id ?? undefined
      out.contactId      = o?.contact_id ?? undefined
      out.listingId      = o?.listing_id ?? undefined
      out.transactionId  = o?.transaction_id ?? undefined
      if (out.listingId) {
        const { data: l } = await svc
          .from("listings").select("seller_contact_id").eq("id", out.listingId).maybeSingle()
        out.sellerContactId = l?.seller_contact_id ?? undefined
        // REPRESENTATION GATE (mirrors deal-type-resolver): an offer on OUR listing
        // from an OUTSIDE buyer (another brokerage's client — bare intake contact,
        // no buyer_stage) must not put that buyer on OUR client rails (portal cards,
        // sequence enrollment). Only a buyer in our pipeline is "our buyer" here;
        // off-listing offers are inherently our-buyer and skip this check.
        if (out.sellerContactId && out.buyerContactId) {
          const { data: bc } = await svc
            .from("contacts").select("buyer_stage").eq("id", out.buyerContactId).maybeSingle()
          if (!(bc as { buyer_stage?: string | null } | null)?.buyer_stage) {
            out.buyerContactId = undefined
            out.contactId = out.sellerContactId
          }
        }
      }
    } else if (entityType === "listing" || entityType === "listing_stage_machine") {
      // "listing_stage_machine" (the stage-machine emitter — LISTING_AGREEMENT_SIGNED
      // et al.) addresses the SAME listings row by the SAME id as "listing"; only the
      // entityType string differs, so this is not a second lookup, just the same one
      // reached from a second name. lane CB, 2026-09-08 — resolveEventContacts had no
      // branch for it, so LISTING_AGREEMENT_SIGNED reached no contact and its portal
      // template (below) could never render.
      out.listingId = entityId
      const { data: l } = await svc
        .from("listings").select("seller_contact_id").eq("id", entityId).maybeSingle()
      out.sellerContactId = l?.seller_contact_id ?? undefined
      out.contactId       = l?.seller_contact_id ?? undefined
    } else if (entityType === "transaction_document") {
      // CONTRACT_SENT_FOR_SIGNATURE's entityType (lane CB, 2026-09-08 — resolveEventContacts
      // had no branch for it either). The document names its transaction directly; the same
      // buyer+seller resolution the "transaction" branch above does, reached one hop over.
      const { data: doc } = await svc
        .from("transaction_documents").select("transaction_id").eq("id", entityId).maybeSingle()
      const transactionId = (doc as { transaction_id?: string | null } | null)?.transaction_id
      if (transactionId) {
        out.transactionId = transactionId
        const { data: tx } = await svc
          .from("transactions")
          .select("buyer_contact_id, seller_contact_id, contact_id, listing_id")
          .eq("id", transactionId)
          .maybeSingle()
        out.buyerContactId  = tx?.buyer_contact_id  ?? undefined
        out.sellerContactId = tx?.seller_contact_id ?? undefined
        out.contactId       = tx?.contact_id        ?? undefined
        out.listingId       = tx?.listing_id        ?? undefined
      }
    } else if (entityType === "contact") {
      out.contactId = entityId
    }
  } catch { /* enrichment is best-effort — never block the event */ }
  return out
}
