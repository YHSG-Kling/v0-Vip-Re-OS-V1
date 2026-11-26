/**
 * lib/esign/google-esign-completion.ts — GOOGLE eSIGNATURE COMPLETION DETECTION
 * (wave 89, lane 89E — lane 88C's open item 2: "Google eSignature has no API and no webhook…
 * Automating the return needs either Gmail completion-mail detection
 * (esignature-noreply@google.com, gmail.readonly is already granted) or Google shipping an API").
 *
 * WHAT GOOGLE DOES (support.google.com/docs/answer/12315692; Workspace eSignature terms):
 * when every signer has signed, the REQUESTER and all signers get an email from
 * `esignature-noreply@google.com` that the request is complete, with a link to the final
 * PDF (audit-trail page appended); the requester's copy lands in the folder the original
 * lived in (their Drive), and Google "will attempt to email a copy of the executed
 * document". There is no API, no webhook, no Drive change hook the platform holds.
 *
 * THE COMPLETION LOOP, ON THE SURVIVOR. The agent's Google mailbox is ALREADY watched:
 * app/api/webhooks/inbound-mail (Gmail Pub/Sub → fetchGmailMessagesSinceHistory) reads every
 * new message in the connected mailbox — the same door the offer / deal-doc lookout rides.
 * So the completion mail is detected THERE (pure classifier below), the agent is told to
 * file the executed PDF on the deal through the existing signed-copy upload door (the
 * "mark signed" flow lane 88C built; the classifier + compliance gate run there), and — when
 * Google attached the executed PDF — the existing deal-doc lookout files the "file it to
 * the deal" card by address match, as it does for any inbound signed contract.
 *
 * NEVER A LEAD. Google's sender is an automated mailbox: it must never reach the
 * unknown-sender identification (which would spend enrichment on a noreply address). The
 * route stops after this detection.
 *
 * Wave 89 ruling note: the platform default e-sign is DocuSign now (89A owns the flow);
 * Google stays a selectable portal-send provider, and THIS closes its return leg.
 */
import "server-only"

export const GOOGLE_ESIGN_SENDER = "esignature-noreply@google.com"

export type GoogleEsignMailKind = "completed" | "requested" | "declined" | "other"

export interface GoogleEsignMail { kind: GoogleEsignMailKind; documentName: string | null }

/** PURE — Google's own sender decides; the subject decides the kind. Not Google → null. */
export function detectGoogleEsignMail(input: { fromEmail: string | null | undefined; subject: string | null | undefined }): GoogleEsignMail | null {
  const from = (input.fromEmail ?? "").trim().toLowerCase()
  if (from !== GOOGLE_ESIGN_SENDER) return null
  const subject = (input.subject ?? "").trim()
  const s = subject.toLowerCase()
  const kind: GoogleEsignMailKind =
    /\b(complete|completed|signed by all|fully signed|has been signed)\b/.test(s) ? "completed"
    : /\b(declined|rejected|cancel+ed)\b/.test(s) ? "declined"
    : /\b(request|requested|sign)\b/.test(s) ? "requested"
    : "other"
  // Google's subjects name the document in quotes or after "for" — best-effort, never required.
  const quoted = /["“]([^"”]{2,120})["”]/.exec(subject)?.[1]
  const after = /\bfor\s+(.{2,120})$/i.exec(subject)?.[1]
  const documentName = (quoted ?? after ?? "").trim() || null
  return { kind, documentName }
}

export interface GoogleEsignNoticeResult { ok: boolean; notified: boolean; error?: string }

/**
 * The completion notice — the bell to the MAILBOX OWNER (the requester: the agent whose
 * Google account sent the request). Service client; tenant = the resolved credential's
 * brokerage; the refusal is read and returned (CLAUDE.md §3).
 */
export async function noticeGoogleEsignCompletion(
  svc: any,
  input: { brokerageId: string; mailboxUserId: string | null; mail: GoogleEsignMail; pdfAttached: boolean },
): Promise<GoogleEsignNoticeResult> {
  if (!input.brokerageId) return { ok: false, notified: false, error: "no tenant for the Google eSignature notice" }
  if (!input.mailboxUserId) return { ok: false, notified: false, error: "the mailbox that received Google's completion mail resolves to no user — nobody to tell" }
  if (input.mail.kind !== "completed") return { ok: true, notified: false }
  const doc = input.mail.documentName ? `“${input.mail.documentName}”` : "your packet"
  const { error } = await svc.from("notifications").insert({
    brokerage_id: input.brokerageId,
    user_id: input.mailboxUserId,
    type: "google_esign_completed",
    title: `Google eSignature complete — file the signed copy of ${doc}`,
    body: input.pdfAttached
      ? `Every party has signed ${doc}. Google attached the executed PDF to its email and placed it in your Drive — file it on the deal with “Upload signed copy” so the compliance gate runs and the listing/offer moves on.`
      : `Every party has signed ${doc}. The executed PDF (with Google's audit-trail page) is in your Drive — file it on the deal with “Upload signed copy” so the compliance gate runs and the listing/offer moves on.`,
    priority: "high",
    channel: "in_app",
    is_read: false,
  })
  if (error) return { ok: false, notified: false, error: `Google eSignature completion bell refused for user ${input.mailboxUserId}: ${error.message}` }
  return { ok: true, notified: true }
}
