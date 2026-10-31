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
import { fillPdfForm, readPdfTextFields, listPdfFields, type PdfFieldValue } from "@/lib/forms/pdf-form-fill"
import { buildPartyPrefill, type DealParties } from "@/lib/forms/party-prefill"
import { checkFormPathsInScope } from "@/lib/forms/form-path-scope"
// ONE bucket name (§6): survivor lib/forms/tenant-form-packets.ts FORM_PACKET_BUCKET (wave 145, lane 145A item 6 —
// lib/esign/dispatch-packet.ts FORMS_BUCKET now re-exports it). The seat door: resolvePacketActor (lane 145A item 2).
import { FORM_PACKET_BUCKET as FORMS_BUCKET, resolvePacketActor } from "@/lib/forms/tenant-form-packets"
import { resolveKnownPropertyFacts } from "@/lib/intelligence/offer-property-prefill-runner"
import { legalDescriptionRequirement, typedLegalDescription, resolveLegalDescriptionForForm } from "@/lib/forms/legal-description"

// TOMBSTONE (§6, wave 145 lane 145Z): `const FILLED_BUCKET = "brokerage-forms"` re-spelled the bucket. Filled copies live
// alongside, under a filled/ prefix, in the ONE bucket — survivor lib/forms/tenant-form-packets.ts FORM_PACKET_BUCKET.
const FILLED_BUCKET = FORMS_BUCKET

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
  /** THE FORM IS INCOMPLETE (wave 141): a legal-description field this form carries has no value from
   *  any legitimate source — a human was asked (the open task), and the send refuses until it exists. */
  incomplete?: { field: "legal_description"; fields: string[]; reason: string; asked: boolean; taskId: string | null } | null
  /** Who supplied the legal description that was filled (agent | rentcast), when one was. */
  legalDescriptionSource?: string | null
  error?: string
}

export async function prefillStorageFormAction(input: PrefillStorageFormInput): Promise<PrefillStorageFormResult> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { success: false, error: "unauthorized" }
  if (!input.formPath || !input.formPath.toLowerCase().endsWith(".pdf")) {
    return { success: false, error: "a PDF form path is required" }
  }
  // THE SEAT DOOR (wave 145, lane 145A Outside-lane 2): the actor is an ACTIVE STAFF SEAT resolved from the SESSION user —
  // a contact / vendor seat, a suspended or removed account, a deactivated agent is refused here (fail closed), never
  // admitted by a raw users read.
  const svc = createServiceClient()
  const seat = await resolvePacketActor(svc as never, user.id)
  if (!seat.ok) return { success: false, error: seat.error }
  const actor = { brokerageId: seat.actor.brokerageId, teamId: seat.actor.teamId, userId: user.id }
  const scope = await checkFormPathsInScope(svc, [input.formPath], actor)
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

    // 2b. LEGAL DESCRIPTION (wave 141, lane 141C) — only when THIS form carries the field: the agent's
    //     typed value wins and is saved on the record; else the record; else RentCast's property record
    //     (the approved capability, metered inside rentcast.ts); else the form is INCOMPLETE and the
    //     agent is asked through the task rail. Never invented.
    let incomplete: PrefillStorageFormResult["incomplete"] = null
    let legalDescriptionSource: string | null = null
    const requirement = legalDescriptionRequirement(await listPdfFields(srcBytes), facts)
    const typedLegal = typedLegalDescription(input.fieldValues)
    if (requirement.required && (!requirement.satisfied || typedLegal)) {
      const legal = await resolveLegalDescriptionForForm(svc, {
        brokerageId: actor.brokerageId, userId: user.id,
        listingId: input.listingId ?? null, transactionId: input.transactionId ?? null,
        address: facts.address, city: facts.propertyCity, state: facts.propertyState, zip: facts.propertyZip,
        typedValue: typedLegal,
      })
      if (legal.value) { facts.legalDescription = legal.value; legalDescriptionSource = legal.source }
      else incomplete = { field: "legal_description", fields: requirement.fields, reason: legal.reason ?? "the legal description is not known", asked: legal.asked, taskId: legal.taskId }
    } else if (requirement.required) {
      legalDescriptionSource = "record"
    }

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
    // THE WRITE DESTINATION IS SCOPE-CHECKED TOO (wave 145, lane 145A Outside-lane 4): a foreign offerId would otherwise
    // plant a file in another tenant's filled/{offerId}/ folder.
    const dest = await checkFormPathsInScope(svc, [filledPath], actor)
    if (!dest.ok) return { success: false, error: "that offer is not in your brokerage" }
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
      incomplete,
      legalDescriptionSource,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "prefill failed" }
  }
}
