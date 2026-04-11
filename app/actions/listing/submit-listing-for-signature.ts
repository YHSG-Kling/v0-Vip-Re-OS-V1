"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { getTransactionProviderByName } from "@/lib/integrations/providers/provider-resolver"

interface SubmitListingForSignatureParams {
  listingId: string
  userId: string
  signers: Array<{
    name: string
    email: string
    role: "seller" | "co_seller" | "agent"
  }>
}

export async function submitListingForSignature(params: SubmitListingForSignatureParams) {
  const { listingId, userId, signers } = params

  if (!isValidUUID(listingId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // Get listing with brokerage_id for provider resolution
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, brokerage_id, esign_provider, esign_status, address, status")
    .eq("id", listingId)
    .single()

  if (listingError || !listing) {
    return { success: false, error: "Listing not found" }
  }

  // Emit signature request event
  const { error: eventError } = await supabase.from("activities").insert({
    activity_type: "listing.signature.requested",
    user_id: userId,
    metadata: {
      listing_id: listingId,
      signers,
      timestamp: new Date().toISOString(),
    },
  })

  if (eventError) {
    return { success: false, error: "Failed to log signature request event" }
  }

  // Resolve brokerage e-sign provider from platform_credentials (same as offer flow)
  const { data: credential } = await supabase
    .from("platform_credentials")
    .select("platform, account_id, access_token")
    .eq("brokerage_id", listing.brokerage_id)
    .in("platform", ["dotloop", "docusign", "skyslope", "authentisign"])
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (credential) {
    try {
      const provider = getTransactionProviderByName(credential.platform)
      if (listing.esign_provider) {
        await provider.sendForSignature({
          externalTransactionId: listing.esign_provider,
          documentId: listingId,
          signers: signers.map((s) => ({ email: s.email, name: s.name, role: s.role })),
        })
      }

      await supabase.from("activities").insert({
        activity_type: "listing.provider.signature.requested",
        user_id: userId,
        metadata: {
          listing_id: listingId,
          provider: credential.platform,
        },
      })
    } catch {
      // Provider call failed — in-app signature request still proceeds
    }
  }

  // Update listing esign status
  await supabase
    .from("listings")
    .update({
      esign_status:   "sent",
      esign_sent_at:  new Date().toISOString(),
      esign_provider: credential?.platform ?? listing.esign_provider ?? null,
    })
    .eq("id", listingId)

  return {
    success: true,
    message: "Listing submitted for signature",
    provider: credential?.platform ?? null,
  }
}
