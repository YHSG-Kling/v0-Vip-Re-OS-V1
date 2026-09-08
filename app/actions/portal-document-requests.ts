"use server"

/**
 * app/actions/portal-document-requests.ts — ACTIVE SIGNATURE PACKET loader
 * (owner rule: "the Sign Document button should not appear unless there is a
 * signature packet ready for them already… when they click on it, it should
 * take them to the active e-signature invite"). The packet of record is
 * signature_requests — written when the agent initiates the send through the
 * e-sign provider rail. Party-anchored: the packet must be FOR this contact
 * (or the contact must be a party on its transaction). Active = not
 * completed, not expired, status pending/sent. signing_url routes straight
 * to the envelope when the provider returned one (l54-s01); email-only
 * providers leave it null and the card says where the invite went instead.
 * No packet → null → the button does not render. Nothing here fabricates a
 * signing state.
 */

import { createServiceClient } from "@/lib/supabase/service"

/** all_parties is written as data.signers (Array<{email,name,role}>) — strip
 *  the email before it ever reaches a client render. */
function parseSigners(allParties: unknown): Array<{ name: string; role: string }> {
  if (!Array.isArray(allParties)) return []
  return allParties
    .filter((p): p is { name?: string; role?: string } => !!p && typeof p === "object")
    .map((p) => ({ name: p.name?.trim() || "Signer", role: p.role?.trim() || "party" }))
}

export interface ActiveSignaturePacket {
  requestId: string
  signingUrl: string | null
  sentAt: string | null
  expiresAt: string | null
  /** Every party on this packet (signature_requests.all_parties) — never the
   *  raw email, only name + role, so a multi-party signer can see who else
   *  is on the same document. */
  signers: Array<{ name: string; role: string }>
  /** The SEQUENCE parties must sign in (signature_requests.signing_order) —
   *  distinct from `signers` above (the roster): this is order, that is
   *  membership. Empty when the packet carries no explicit sequence. */
  signingOrder: Array<{ name: string; role: string }>
}

export async function loadActiveSignaturePacket(input: {
  contactId: string
  documentId: string
}): Promise<ActiveSignaturePacket | null> {
  const svc = createServiceClient()

  const { data: rows } = await svc.from("signature_requests")
    .select("id, document_id, contact_id, transaction_id, request_status, completed_at, expires_at, sent_at, signing_url, all_parties, signing_order")
    .or(`document_id.eq.${input.documentId},and(document_id.is.null,contact_id.eq.${input.contactId})`)
    .in("request_status", ["pending", "sent"])
    .is("completed_at", null)
    .order("created_at", { ascending: false })
    .limit(10)

  const now = Date.now()
  const live = ((rows ?? []) as any[]).filter(
    (r) => !r.expires_at || new Date(r.expires_at).getTime() > now,
  )
  // Exact document match first; else the adapter-recorded packet (document_id
  // null — AI-drafted `documents` rows can't carry the client_documents FK),
  // accepted ONLY when it is unambiguous (exactly one live packet).
  const exact = live.filter((r) => r.document_id === input.documentId)
  const anchored = live.filter((r) => r.document_id === null)
  const candidates = exact.length > 0 ? exact : (anchored.length === 1 ? anchored : [])
  if (candidates.length === 0) return null

  // Party check — the packet names this contact, or the contact is a party
  // on the packet's transaction.
  for (const r of candidates) {
    if (r.contact_id === input.contactId) {
      return { requestId: r.id, signingUrl: r.signing_url ?? null, sentAt: r.sent_at ?? null, expiresAt: r.expires_at ?? null, signers: parseSigners(r.all_parties), signingOrder: parseSigners(r.signing_order) }
    }
    if (r.transaction_id) {
      const { data: tx } = await svc.from("transactions")
        .select("contact_id, buyer_contact_id").eq("id", r.transaction_id).maybeSingle()
      if (tx && ((tx as any).contact_id === input.contactId || (tx as any).buyer_contact_id === input.contactId)) {
        return { requestId: r.id, signingUrl: r.signing_url ?? null, sentAt: r.sent_at ?? null, expiresAt: r.expires_at ?? null, signers: parseSigners(r.all_parties), signingOrder: parseSigners(r.signing_order) }
      }
    }
  }
  return null
}
