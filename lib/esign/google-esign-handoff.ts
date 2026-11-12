/**
 * lib/esign/google-esign-handoff.ts — GOOGLE WORKSPACE eSIGNATURE, the platform's DEFAULT
 * e-sign method (owner, wave 88: "google esign is default not dotloop").
 *
 * WHY A HAND-OFF AND NOT AN ITransactionProvider: Google eSignature has NO API.
 * "As of right now there is no API for eSignature" (Google Workspace Developers forum,
 * 2025-07-22; feature request open on the Issue Tracker). A request is started by a
 * human in Drive: open the PDF → Menu → eSignature → place fields → Request signature
 * (support.google.com/docs/answer/12315692). drive.google.com does not allow framing,
 * so the ONLY honest in-platform flow is:
 *
 *   1. the FormWizard's FILLED PDF is uploaded into the agent's OWN Drive (drive.file
 *      grant — reaches only files this app created) through the agent's connected Google
 *      account (the same token the mailbox + calendar use: getFreshPersonalToken);
 *   2. the wizard opens that Drive file in a POPUP window beside the platform, where the
 *      agent presses Request eSignature and names the signers the wizard already listed;
 *   3. Google emails the signers; the executed PDF (with Google's audit trail page)
 *      lands back in the agent's Drive, and the agent files it on the deal through the
 *      existing signed-copy upload doors (offers/[offerId]/upload-document,
 *      listings/[listingId]/upload-document) — which run the classifier + compliance gate.
 *
 * No Google completion webhook exists; that is why step 3 is a filed copy and not an
 * automatic pull. This module never claims a signature request was SENT — it reports
 * that the packet was PLACED in Drive and hands the agent the window to send it.
 *
 * Egress rides the connector gateway (bodyType "binary" with a hand-built
 * multipart/related body — Drive's uploadType=multipart requires multipart/related,
 * which a FormData body would mislabel as multipart/form-data).
 */

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { getFreshPersonalToken, getPersonalConnectionInfo } from "@/lib/providers/email/personal-email-adapter"
// The pure half (grant rule, Drive multipart body, Drive window URL) lives in a module with
// no server-only marker so the proof can exercise it headlessly.
import { googleDriveGranted, buildDriveMultipartBody, driveFileOpenUrl } from "@/lib/esign/google-drive-upload"

export interface GoogleEsignReadiness {
  connected: boolean
  /** true = Drive granted; false = connected WITHOUT Drive (must reconnect); null = unknown grant. */
  driveGranted: boolean | null
  email: string | null
}

/** Is the agent's Google account connected (and with Drive)? No token is minted. */
export async function googleEsignReadiness(agentUserId: string): Promise<GoogleEsignReadiness> {
  const info = await getPersonalConnectionInfo(agentUserId)
  if (!info || info.provider !== "gmail") return { connected: false, driveGranted: null, email: null }
  return { connected: true, driveGranted: googleDriveGranted(info.scope), email: info.email }
}

export interface GoogleHandoffDoc { name: string; bytes: Uint8Array }

export interface GoogleHandoffResult {
  ok: boolean
  files: Array<{ id: string; name: string; openUrl: string }>
  /** true when Google refused for a missing Drive grant — the agent must reconnect Google once. */
  needsReconnect?: boolean
  error?: string
}

/**
 * Place the filled packet in the agent's own Drive for Google eSignature. Uploads every
 * document (a refusal on any one is reported — never a partial "success"), returns the
 * Drive windows to open. Tenant is implicit: the token is the AGENT's own Google account.
 */
export async function handOffToGoogleEsign(input: {
  agentUserId: string
  documents: GoogleHandoffDoc[]
  description?: string
}): Promise<GoogleHandoffResult> {
  if (input.documents.length === 0) {
    return { ok: false, files: [], error: "No filled document to place in Google Drive — fill or attach a form first." }
  }
  const readiness = await googleEsignReadiness(input.agentUserId)
  if (!readiness.connected) {
    return { ok: false, files: [], error: "Google eSignature needs your Google account connected (Settings → Integrations → Google)." }
  }
  if (readiness.driveGranted === false) {
    return { ok: false, files: [], needsReconnect: true, error: "Your Google connection predates Drive access. Reconnect Google once (Settings → Integrations) so the filled forms can be placed in your Drive for eSignature." }
  }
  const token = await getFreshPersonalToken(input.agentUserId)
  if (!token || token.provider !== "gmail") {
    return { ok: false, files: [], error: "Your Google connection could not be refreshed — reconnect Google in Settings → Integrations." }
  }

  const files: GoogleHandoffResult["files"] = []
  for (const doc of input.documents) {
    const boundary = `vipreos-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    const res = await callConnector<{ id?: string; name?: string }>({
      connector: "google-drive",
      baseUrl: "https://www.googleapis.com",
      path: "/upload/drive/v3/files",
      query: { uploadType: "multipart", fields: "id,name" },
      method: "POST",
      auth: { style: "bearer", token: token.accessToken },
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      bodyType: "binary",
      body: buildDriveMultipartBody(doc.name, doc.bytes, boundary, input.description),
      timeoutMs: 60_000,
    })
    if (!res.ok || !res.data?.id) {
      const insufficient = res.status === 403 || /insufficient|scope/i.test(res.error ?? "")
      return {
        ok: false,
        files,
        needsReconnect: insufficient,
        error: insufficient
          ? "Google refused the Drive upload (missing Drive access). Reconnect Google once in Settings → Integrations."
          : `Google Drive upload failed for "${doc.name}": ${res.error ?? `HTTP ${res.status}`}`,
      }
    }
    files.push({ id: res.data.id, name: res.data.name ?? doc.name, openUrl: driveFileOpenUrl(res.data.id) })
  }
  return { ok: true, files }
}
