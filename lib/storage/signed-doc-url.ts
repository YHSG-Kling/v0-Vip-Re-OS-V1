import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Long-lived signed URL for a PRIVATE document bucket.
 *
 * The sensitive document buckets — offer-documents, transaction-documents,
 * client-documents (W-9 / KYC / deal files) — are deliberately NOT public
 * (see migration m278), so `getPublicUrl` returns a URL that 403s. A signed URL
 * keeps the document non-public (the token is the grant) while staying fetchable
 * by the AI offer extractor and by links persisted on the row.
 *
 * TTL is intentionally long (10 years): several call sites PERSIST the URL to a
 * column (offers.offer_document_url, transaction_documents.url, …), so a short
 * expiry would silently break the stored link. The correct end-state is
 * sign-on-read (store the path, mint a short-lived URL per view); this long-TTL
 * signer is the secure bridge until that refactor lands.
 *
 * Returns "" on failure so callers can guard exactly as they did for publicUrl.
 */
export const DOC_URL_TTL_SECONDS = 60 * 60 * 24 * 365 * 10

export async function signedDocUrl(
  client: SupabaseClient,
  bucket: "offer-documents" | "transaction-documents" | "client-documents" | (string & {}),
  path: string,
  ttlSeconds: number = DOC_URL_TTL_SECONDS,
): Promise<string> {
  // supabase-js RESOLVES a refusal (CLAUDE.md §3) — read the error rather than
  // reaching past it, so a swallowed refusal cannot become a silent "".
  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, ttlSeconds)
  if (error) {
    console.error(`[storage] createSignedUrl refused for ${bucket}/${path}: ${error.message}`)
    return ""
  }
  return data?.signedUrl ?? ""
}
