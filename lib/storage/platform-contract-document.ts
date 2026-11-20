/**
 * lib/storage/platform-contract-document.ts
 *
 * The sign-on-read link for a PLATFORM contract document (the storage-path arm
 * of platform_contract_templates, m481). Lives outside the tenant sign lane on
 * purpose: app/actions/admin/subscription-agreement.ts must hold NO service
 * client so m481's RLS stays a second, database-enforced gate on the agreement
 * INSERT (scripts/contract-lanes-simulator.ts). The object belongs to the
 * PLATFORM (lib/storage/signed-upload-url.ts PLATFORM_CONTRACT_TENANT_SENTINEL),
 * so no tenant's storage grant is the right lens for it; the caller's tenant
 * gate has already run before it asks here. Fails closed to null.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { UPLOAD_PURPOSES } from "./signed-upload-url"

const CONTRACT_DOCUMENT_BUCKET = UPLOAD_PURPOSES.platform_contract_document.bucket
/** Short-lived on purpose: the card re-mints on every read. */
const CONTRACT_DOCUMENT_VIEW_TTL_SECONDS = 300

export async function mintContractDocumentUrl(bodyStoragePath: string | null): Promise<string | null> {
  if (!bodyStoragePath) return null
  const svc = createServiceClient()
  const { data, error } = await svc.storage
    .from(CONTRACT_DOCUMENT_BUCKET)
    .createSignedUrl(bodyStoragePath, CONTRACT_DOCUMENT_VIEW_TTL_SECONDS)
  if (error) {
    console.error(`[platform-contract-document] could not mint a read url for ${CONTRACT_DOCUMENT_BUCKET}/${bodyStoragePath}: ${error.message}`)
    return null
  }
  return data?.signedUrl ?? null
}
