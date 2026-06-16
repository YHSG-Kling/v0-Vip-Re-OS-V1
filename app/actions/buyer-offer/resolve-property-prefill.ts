"use server"

/**
 * Resolve the PROPERTY-ONLY prefill for an offer form's fillable fields.
 *
 * The offer form is filled by the agent; the system only pre-fills KNOWN property identification
 * (address, legal description, property city/state/zip, APN, county) from the property/parcel record,
 * and leaves anything unknown BLANK. Offer terms are never auto-filled. Grounded only — no AI
 * fabrication. The FormWizard calls this to seed its field values + show a "prefilled property"
 * disclosure and a "needs agent input" list.
 */

import { createClient } from "@/lib/supabase/server"
import { prefillOfferFormProperty } from "@/lib/intelligence/offer-property-prefill-runner"
import { createServiceClient } from "@/lib/supabase/service"

export interface ResolveOfferPropertyPrefillInput {
  formFields: string[]
  listingId?: string | null
  transactionId?: string | null
  offerId?: string | null
  propertyAddress?: string | null
}

export async function resolveOfferPropertyPrefillAction(input: ResolveOfferPropertyPrefillInput): Promise<{
  success: boolean
  filled?: Array<{ formField: string; value: string; source: string }>
  unresolved?: string[]
  error?: string
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "unauthorized" }

  if (!Array.isArray(input.formFields) || input.formFields.length === 0) {
    return { success: true, filled: [], unresolved: [] }
  }

  try {
    const result = await prefillOfferFormProperty(
      input.formFields,
      {
        listingId: input.listingId ?? null,
        transactionId: input.transactionId ?? null,
        offerId: input.offerId ?? null,
        propertyAddress: input.propertyAddress ?? null,
      },
      createServiceClient(),
    )
    return {
      success: true,
      filled: result.filled.map((f) => ({ formField: f.formField, value: f.value, source: String(f.source) })),
      unresolved: result.unresolved,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "prefill failed" }
  }
}
