// Pure utility — no "use server" — safe to import in client components and server actions.
// doc_types that require a signature before a transaction can advance.

export const SIGNABLE_DOC_TYPES = new Set([
  "purchase_agreement",
  "contract",
  "addendum",
  "amendment",
  "listing_agreement",
  "buyer_representation_agreement",
  "disclosure",
  "escrow_instructions",
  "counter_offer",
  "acceptance",
])

export function isSignableDocType(docType: string | null | undefined): boolean {
  if (!docType) return false
  return SIGNABLE_DOC_TYPES.has(docType.toLowerCase().replace(/\s+/g, "_"))
}
