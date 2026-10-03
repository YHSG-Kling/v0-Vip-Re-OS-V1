"use server"

/**
 * Fill a STORAGE form PDF (offer packet OR listing agreement) in-app — the FormWizard's Fill step.
 *
 * Flow: download the selected form PDF from the brokerage-forms bucket → resolve the known property
 * facts (grounded, no AI fabrication) → fill the property-identification AcroForm fields → (lane 88C)
 * fill the PARTY name fields from the parties the agent confirmed in the wizard → apply the values the
 * agent TYPED in the wizard's field panel (they always win) → save the filled PDF → return a signed
 * preview URL + every text field with its current value, so the wizard renders the fields as inputs
 * and re-calls this action as the agent edits ("fill out the form fields in real time"). The e-sign
 * dispatch sends exactly these filled bytes. Offer TERMS are never prefilled — the agent types them.
 *
 * TENANT (lane 88C): this action runs on the SERVICE client and used to download ANY caller-named
 * path — another brokerage's library, or a `filled/…` copy carrying a buyer's name, price and terms —
 * and hand it back as a signed preview. Every path is now checked against the SESSION's own scope
 * (lib/forms/form-path-scope.ts) before a byte is read.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { prefillPropertyIntoPdf } from "@/lib/forms/prefill-property-into-pdf"
import { fillPdfForm, readPdfTextFields, type PdfFieldValue } from "@/lib/forms/pdf-form-fill"
import { buildPartyPrefill, type DealParties } from "@/lib/forms/party-prefill"
import { checkFormPathsInScope } from "@/lib/forms/form-path-scope"
// ONE bucket name (§6): survivor lib/esign/dispatch-packet.ts::FORMS_BUCKET (lane 89E).
import { FORMS_BUCKET } from "@/lib/esign/dispatch-packet"
import { resolveKnownPropertyFacts } from "@/lib/intelligence/offer-property-prefill-runner"

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
  /** The deal's parties as confirmed in the wizard — fills ONLY name fields that name a party. */
  parties?: DealParties | null
  /** Values the agent typed in the wizard's field panel, by AcroForm field name. They win. */
  fieldValues?: Record<string, string> | null
}

export interface PrefillStorageFormResult {
  success: boolean
  filledPath?: string
  previewUrl?: string
  filledFields?: string[]
  unresolvedFields?: string[]
  /** Every TEXT field on the form with its current value — the wizard's editable panel. */
  fields?: PdfFieldValue[]
  error?: string
}

export async function prefillStorageFormAction(input: PrefillStorageFormInput): Promise<PrefillStorageFormResult> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { success: false, error: "unauthorized" }
  if (!input.formPath || !input.formPath.toLowerCase().endsWith(".pdf")) {
    return { success: false, error: "a PDF form path is required" }
  }
  const { data: me, error: meErr } = await authClient.from("users").select("brokerage_id, team_id").eq("id", user.id).maybeSingle()
  if (meErr) return { success: false, error: `could not read your account: ${meErr.message}` }
  if (!me?.brokerage_id) return { success: false, error: "unauthorized" }

  const svc = createServiceClient()
  const scope = await checkFormPathsInScope(svc, [input.formPath], {
    brokerageId: me.brokerage_id as string, teamId: (me.team_id as string | null) ?? null, userId: user.id,
  })
  if (!scope.ok) return { success: false, error: scope.error ?? "that form is not in your library" }

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

    // 3. Fill the property-identification fields into the PDF.
    const result = await prefillPropertyIntoPdf(srcBytes, facts)
    let bytes: Uint8Array = result.bytes
    const filledNames = new Set(result.filled)
    const unresolved = new Set(result.unresolvedProperty)

    // 4. Party names, then the agent's own typed values (the agent wins over any prefill).
    const party = input.parties ? buildPartyPrefill(result.available, input.parties) : { filled: [], unresolved: [] }
    const typed = Object.entries(input.fieldValues ?? {})
      .filter(([name]) => typeof name === "string" && name.length > 0)
      .map(([name, value]) => ({ name, value: String(value ?? "") }))
    const typedNames = new Set(typed.map((t) => t.name))
    const layered = [...party.filled.filter((p) => !typedNames.has(p.name)), ...typed]
    if (layered.length > 0) {
      const second = await fillPdfForm(bytes, layered)
      bytes = second.bytes
      for (const n of second.filled) { filledNames.add(n); unresolved.delete(n) }
    }
    for (const u of party.unresolved) if (!filledNames.has(u)) unresolved.add(u)

    // 5. Save the filled PDF (not flattened — the agent keeps editing; the e-sign step places marks).
    const stamp = `${Date.now().toString(36)}`
    const base = input.formPath.replace(/^.*\//, "").replace(/\.pdf$/i, "")
    const filledPath = `filled/${input.offerId ?? user.id}/${base}-${stamp}.pdf`
    const { error: upErr } = await svc.storage.from(FILLED_BUCKET).upload(filledPath, Buffer.from(bytes), {
      contentType: "application/pdf", upsert: true,
    })
    if (upErr) return { success: false, error: `could not save the filled form: ${upErr.message}` }

    // 6. A signed preview URL the wizard embeds.
    const { data: signed, error: signErr } = await svc.storage.from(FILLED_BUCKET).createSignedUrl(filledPath, 60 * 30)
    if (signErr || !signed?.signedUrl) {
      return { success: false, filledPath, error: `the form was filled but no preview link could be issued: ${signErr?.message ?? "no url"}` }
    }

    return {
      success: true,
      filledPath,
      previewUrl: signed.signedUrl,
      filledFields: [...filledNames],
      unresolvedFields: [...unresolved],
      fields: await readPdfTextFields(bytes),
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "prefill failed" }
  }
}
