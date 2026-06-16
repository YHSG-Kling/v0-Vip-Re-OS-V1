"use server"

/**
 * Fill a STORAGE offer-packet PDF with the KNOWN property identification, in-app.
 *
 * Flow: download the selected form PDF from the brokerage-forms bucket → resolve the known property
 * facts (grounded, no AI fabrication) → fill ONLY the property-identification AcroForm fields
 * (offer terms stay blank for the agent) → save the filled PDF to a per-offer path → return a signed
 * preview URL + which fields were filled / left blank. Provider-agnostic; the e-sign provider sends
 * the filled bytes later. The agent completes the remaining fields in the preview.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { prefillPropertyIntoPdf } from "@/lib/forms/prefill-property-into-pdf"
import { resolveKnownPropertyFacts } from "@/lib/intelligence/offer-property-prefill-runner"

const FORMS_BUCKET = "brokerage-forms"
const FILLED_BUCKET = "brokerage-forms" // filled copies live alongside, under a filled/ prefix

export interface PrefillStorageFormInput {
  /** the storage path of the source form PDF in the brokerage-forms bucket. */
  formPath: string
  offerId?: string | null
  listingId?: string | null
  transactionId?: string | null
  propertyAddress?: string | null
  /** property city/state the agent already entered in the wizard (carried into the form too). */
  propertyCity?: string | null
  propertyState?: string | null
}

export interface PrefillStorageFormResult {
  success: boolean
  filledPath?: string
  previewUrl?: string
  filledFields?: string[]
  unresolvedFields?: string[]
  error?: string
}

export async function prefillStorageFormAction(input: PrefillStorageFormInput): Promise<PrefillStorageFormResult> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { success: false, error: "unauthorized" }
  if (!input.formPath || !input.formPath.toLowerCase().endsWith(".pdf")) {
    return { success: false, error: "a PDF form path is required" }
  }

  const svc = createServiceClient()
  try {
    // 1. Download the source form PDF.
    const { data: file, error: dlErr } = await svc.storage.from(FORMS_BUCKET).download(input.formPath)
    if (dlErr || !file) return { success: false, error: `could not load the form: ${dlErr?.message ?? "not found"}` }
    const srcBytes = new Uint8Array(await file.arrayBuffer())

    // 2. Resolve known property facts (grounded; unknown → blank). The wizard's already-entered
    //    city/state fill any gaps the record didn't carry — still grounded (the agent typed them).
    const facts = await resolveKnownPropertyFacts({
      listingId: input.listingId ?? null, transactionId: input.transactionId ?? null,
      offerId: input.offerId ?? null, propertyAddress: input.propertyAddress ?? null,
    }, svc)
    if (!facts.propertyCity && input.propertyCity?.trim()) facts.propertyCity = input.propertyCity.trim()
    if (!facts.propertyState && input.propertyState?.trim()) facts.propertyState = input.propertyState.trim()

    // 3. Fill ONLY the property-identification fields into the PDF.
    const result = await prefillPropertyIntoPdf(srcBytes, facts)

    // 4. Save the filled PDF to a per-offer path (not flattened — the agent still edits the rest).
    const stamp = `${Date.now().toString(36)}`
    const base = input.formPath.replace(/^.*\//, "").replace(/\.pdf$/i, "")
    const filledPath = `filled/${input.offerId ?? user.id}/${base}-${stamp}.pdf`
    const { error: upErr } = await svc.storage.from(FILLED_BUCKET).upload(filledPath, Buffer.from(result.bytes), {
      contentType: "application/pdf", upsert: true,
    })
    if (upErr) return { success: false, error: `could not save the filled form: ${upErr.message}` }

    // 5. A signed preview URL the wizard embeds.
    const { data: signed } = await svc.storage.from(FILLED_BUCKET).createSignedUrl(filledPath, 60 * 30)

    return {
      success: true,
      filledPath,
      previewUrl: signed?.signedUrl,
      filledFields: result.filled,
      unresolvedFields: result.unresolvedProperty,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "prefill failed" }
  }
}
