/**
 * lib/esign/dispatch-packet.ts — the FormWizard's ONE e-sign dispatch core (lane 88C).
 *
 * WHAT WAS BROKEN (walked end to end, 2026-09-28):
 *   · submitForSignature (the wizard's offer send) read "the newest active
 *     platform_credentials row for the brokerage" instead of the user → team → brokerage
 *     cascade every other e-sign door uses (resolveESignProviderForActor), so an agent's
 *     own DocuSign lost to a brokerage-wide Dotloop row.
 *   · it created the envelope and called sendForSignature WITHOUT ATTACHING A DOCUMENT —
 *     the forms the agent had just filled never reached the provider (DocuSign refuses to
 *     send an empty envelope; Dotloop sent a loop with nothing in it).
 *   · it never read sendForSignature's { success } — a provider refusal returned as
 *     "Offer submitted for signature".
 *   · Google eSignature — the owner's DEFAULT — had no path at all.
 *
 * This core is the canonical createTransaction → attachForms → send order the workflow
 * adapter already uses (lib/workflow/adapters/send-for-esign.ts), plus the two in-window
 * modes: DocuSign's embedded SENDER VIEW (iframe) and the Google Drive hand-off (popup).
 * It is session-free on purpose — callers gate first (session tenant, readiness, NAR
 * disclosure) and pass the verified tenant in; it never reads a tenant from a body.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveESignChoice } from "@/lib/integrations/resolve-esign-provider"
import { supportsEmbeddedSend, providerPortalMode } from "@/lib/integrations/providers/catalog"
import type { SignatureTag } from "@/lib/integrations/providers/transaction-provider.interface"

export const FORMS_BUCKET = "brokerage-forms"

/** A packet document: a `brokerage-forms` object path (the FormWizard) OR an already-issued
 *  document URL the record carries (transaction_documents.storage_url — the transaction
 *  page's per-document send). Exactly one is set. */
export interface DispatchDoc { name: string; storagePath?: string; url?: string }

/** PURE: the name a document ends in (path or URL), for the PDF check. */
function docLocator(d: DispatchDoc): string {
  return (d.storagePath ?? (d.url ? d.url.split("?")[0] : "")).toLowerCase()
}

export interface DispatchPacketInput {
  brokerageId: string
  userId: string
  teamId: string | null
  transactionType: "purchase" | "listing"
  propertyAddress: string
  contactId?: string | null
  listingId?: string | null
  /** Re-use a provider envelope/loop already stamped on the record (re-send). */
  existingEnvelopeId?: string | null
  signers: Array<{ name: string; email: string; role: string }>
  /** The packet — brokerage-forms paths or record URLs, ALREADY tenant-checked by the caller. */
  documents: DispatchDoc[]
  tags?: SignatureTag[]
  /** Ask for the in-window send (DocuSign sender view) when the provider supports it. */
  embeddedSend?: boolean
  /** Where DocuSign returns the frame after Send (an app URL). */
  returnUrl?: string
  message?: string
  /** Our record id the provider may echo (formsimplicity forwards it) — the offer id, the listing id. */
  recordId?: string
}

export type DispatchHandoff = {
  /** "iframe" = render inside the wizard; "popup" = open beside the platform (vendor forbids framing). */
  mode: "iframe" | "popup"
  urls: Array<{ label: string; url: string }>
  instructions: string
}

export interface DispatchPacketResult {
  ok: boolean
  kind?: "google" | "api"
  providerName?: string
  /** Provider envelope / loop id — or, for Google, the Drive file id of the first document. */
  envelopeId?: string | null
  /** "sent" = the provider emailed the signers; "awaiting_agent_send" = the agent presses
   *  Send in the handoff window (DocuSign sender view, Google Drive eSignature). */
  status?: "sent" | "awaiting_agent_send"
  handoff?: DispatchHandoff
  attachedCount?: number
  error?: string
  needsReconnect?: boolean
}

/** PURE: the status a dispatch lands in, so callers stamp esign_status honestly.
 */
function dispatchStatusFor(kind: "google" | "api", embedded: boolean): "sent" | "awaiting_agent_send" {
  return kind === "google" || embedded ? "awaiting_agent_send" : "sent"
}

async function signedUrlsFor(svc: SupabaseClient, docs: DispatchDoc[]): Promise<{ ok: boolean; forms: Array<{ formName: string; formUrl: string }>; error?: string }> {
  const forms: Array<{ formName: string; formUrl: string }> = []
  for (const d of docs) {
    if (d.url) { forms.push({ formName: d.name, formUrl: d.url }); continue }
    if (!d.storagePath) return { ok: false, forms, error: `"${d.name}" has no file to send` }
    const { data, error } = await svc.storage.from(FORMS_BUCKET).createSignedUrl(d.storagePath, 60 * 60)
    if (error || !data?.signedUrl) return { ok: false, forms, error: `could not issue a link for "${d.name}": ${error?.message ?? "no url"}` }
    forms.push({ formName: d.name, formUrl: data.signedUrl })
  }
  return { ok: true, forms }
}

async function bytesFor(svc: SupabaseClient, docs: DispatchDoc[]): Promise<{ ok: boolean; files: Array<{ name: string; bytes: Uint8Array }>; error?: string }> {
  const files: Array<{ name: string; bytes: Uint8Array }> = []
  for (const d of docs) {
    if (!docLocator(d).endsWith(".pdf")) {
      return { ok: false, files, error: `"${d.name}" is not a PDF — Google eSignature signs PDFs (or Google Docs). Upload it as a PDF.` }
    }
    if (d.url) {
      const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
      const got = await callConnector<Buffer>({
        connector: "asset-download", url: d.url, method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 60_000,
      })
      if (!got.ok || !got.data) return { ok: false, files, error: `could not load "${d.name}": ${got.error ?? `HTTP ${got.status}`}` }
      files.push({ name: d.name, bytes: new Uint8Array(got.data) })
      continue
    }
    if (!d.storagePath) return { ok: false, files, error: `"${d.name}" has no file to send` }
    const { data, error } = await svc.storage.from(FORMS_BUCKET).download(d.storagePath)
    if (error || !data) return { ok: false, files, error: `could not load "${d.name}": ${error?.message ?? "not found"}` }
    files.push({ name: d.name, bytes: new Uint8Array(await data.arrayBuffer()) })
  }
  return { ok: true, files }
}

export async function dispatchEsignPacket(svc: SupabaseClient, input: DispatchPacketInput): Promise<DispatchPacketResult> {
  if (input.signers.length === 0) return { ok: false, error: "At least one signer with an email is required." }

  const choice = await resolveESignChoice({ brokerageId: input.brokerageId, userId: input.userId, teamId: input.teamId })
  if (!choice.ok) return { ok: false, error: choice.error }

  // ── GOOGLE eSIGNATURE (the DEFAULT — 88B's portal-send provider, google_esign) ──────
  // Google has no send API and does not frame. Lane 88C carries the missing half onto
  // 88B's "send from your own Drive" rail: when the agent's Google connection holds the
  // drive.file grant, the FILLED packet is placed in their Drive and opened beside the
  // platform (popup) — no re-upload. Without the grant (or with no Google connection)
  // it is 88B's manual rail: the Drive window + the filled PDFs to download, and the
  // one-time reconnect that turns the automatic placement on.
  if (choice.kind === "google") {
    const who = input.signers.map((s) => `${s.name || s.role} <${s.email}>`).join(", ")
    const label = `${input.transactionType === "listing" ? "Listing agreement" : "Offer"} packet — ${input.propertyAddress}`
    let reconnectNote = choice.connected
      ? "Reconnect Google once in Settings → Integrations to have the filled forms placed in your Drive automatically."
      : "Connect Google in Settings → Integrations to have the filled forms placed in your Drive automatically."
    if (choice.connected && choice.driveGranted !== false) {
      const loaded = await bytesFor(svc, input.documents)
      if (!loaded.ok) return { ok: false, kind: "google", providerName: choice.providerName, error: loaded.error }
      const { handOffToGoogleEsign } = await import("@/lib/esign/google-esign-handoff")
      const placed = await handOffToGoogleEsign({ agentUserId: input.userId, documents: loaded.files, description: label })
      if (placed.ok) {
        return {
          ok: true,
          kind: "google",
          providerName: choice.providerName,
          envelopeId: placed.files[0]?.id ?? null,
          status: dispatchStatusFor("google", false),
          attachedCount: placed.files.length,
          handoff: {
            mode: "popup",
            urls: placed.files.map((f) => ({ label: f.name, url: f.openUrl })),
            instructions: `In the Google Drive window: Menu (⋮) → eSignature → place the signature/initial/date fields → Request signature, and add: ${who}. Google emails the signers; when it's complete, file the signed PDF from your Drive on this deal (Upload signed copy).`,
          },
        }
      }
      // A non-grant failure is a real refusal; a missing grant falls to the manual rail.
      if (!placed.needsReconnect) return { ok: false, kind: "google", providerName: choice.providerName, error: placed.error }
      reconnectNote = placed.error ?? reconnectNote
    }
    // 88B's manual rail — the agent uploads the filled PDFs to their Drive and sends there.
    const links = await signedUrlsFor(svc, input.documents)
    if (!links.ok) return { ok: false, kind: "google", providerName: choice.providerName, error: links.error }
    const drive = providerPortalMode(choice.providerName)
    return {
      ok: true,
      kind: "google",
      providerName: choice.providerName,
      envelopeId: null,
      status: dispatchStatusFor("google", false),
      attachedCount: 0,
      needsReconnect: true,
      handoff: {
        mode: "popup",
        urls: [
          ...(drive ? [{ label: `${drive.label} (your Drive)`, url: drive.url }] : []),
          ...links.forms.map((f) => ({ label: `${f.formName} (filled PDF)`, url: f.formUrl })),
        ],
        instructions: `${choice.manualSteps} Add: ${who}. ${reconnectNote}`,
      },
    }
  }

  // ── API PROVIDER (DocuSign / Dotloop / SkySlope / Authentisign) ─────────────────
  const { resolved } = choice
  const provider = resolved.provider
  let envelopeId = input.existingEnvelopeId ?? null
  if (!envelopeId) {
    const created = await provider.createTransaction({
      propertyAddress: input.propertyAddress || "Real estate transaction",
      transactionType: input.transactionType,
      contactId: input.contactId ?? undefined,
      listingId: input.listingId ?? undefined,
    })
    if (!created.success || !created.externalTransactionId) {
      return { ok: false, kind: "api", providerName: resolved.providerName, error: created.error ?? `${resolved.providerName} could not create the envelope` }
    }
    envelopeId = created.externalTransactionId
  }

  let attachedCount = 0
  if (input.documents.length > 0) {
    const signed = await signedUrlsFor(svc, input.documents)
    if (!signed.ok) return { ok: false, kind: "api", providerName: resolved.providerName, envelopeId, error: signed.error }
    const attached = await provider.attachForms({ externalTransactionId: envelopeId, forms: signed.forms })
    if (!attached.success) {
      return { ok: false, kind: "api", providerName: resolved.providerName, envelopeId, error: attached.error ?? `${resolved.providerName} refused the documents` }
    }
    attachedCount = attached.attachedCount ?? 0
    if (attachedCount < input.documents.length) {
      return {
        ok: false, kind: "api", providerName: resolved.providerName, envelopeId, attachedCount,
        error: `${resolved.providerName} accepted ${attachedCount} of ${input.documents.length} document(s) — nothing was sent. Retry, or add the missing form in ${resolved.providerName}.`,
      }
    }
  }

  const sendReq = {
    externalTransactionId: envelopeId,
    documentId: input.recordId ?? envelopeId,
    signers: input.signers,
    ...(input.message ? { message: input.message } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
  }

  if (input.embeddedSend && supportsEmbeddedSend(resolved.providerName) && typeof (provider as any).prepareEmbeddedSend === "function" && input.returnUrl) {
    const view = await (provider as any).prepareEmbeddedSend(sendReq, input.returnUrl) as { success: boolean; senderViewUrl?: string; error?: string }
    if (!view.success || !view.senderViewUrl) {
      return { ok: false, kind: "api", providerName: resolved.providerName, envelopeId, attachedCount, error: view.error ?? "the provider did not return a sending window" }
    }
    return {
      ok: true, kind: "api", providerName: resolved.providerName, envelopeId, attachedCount,
      status: dispatchStatusFor("api", true),
      handoff: {
        mode: "iframe",
        urls: [{ label: `${resolved.providerName} — review & send`, url: view.senderViewUrl }],
        instructions: "Review the signature areas and recipients, then press Send in the window below. Signed copies return to this deal automatically.",
      },
    }
  }

  const sent = await provider.sendForSignature(sendReq)
  if (!sent.success) {
    return { ok: false, kind: "api", providerName: resolved.providerName, envelopeId, attachedCount, error: sent.error ?? `${resolved.providerName} refused the signature request` }
  }
  return { ok: true, kind: "api", providerName: resolved.providerName, envelopeId, attachedCount, status: dispatchStatusFor("api", false) }
}
