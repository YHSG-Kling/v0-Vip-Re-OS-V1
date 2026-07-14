"use server"

/**
 * app/actions/portal-document-requests.ts — production audit fix: the portal
 * document viewer's "Sign Document" button was INERT on documents that
 * REQUIRE a signature. E-sign rides the provider rail (envelope emails), so
 * the honest portal action is the SIGNAL: "I'm ready to sign — send me the
 * link", landing as the agent's task + the engagement ledger. Party-anchored
 * (the document must belong to the requesting contact or their transaction).
 */

import { createServiceClient } from "@/lib/supabase/service"

export async function requestSignatureSend(input: {
  contactId: string
  documentId: string
}): Promise<{ success: boolean; error?: string; message?: string }> {
  const svc = createServiceClient()

  const { data: doc } = await svc.from("documents")
    .select("id, contact_id, transaction_id, brokerage_id, document_type")
    .eq("id", input.documentId).maybeSingle()
  if (!doc) return { success: false, error: "Document not found" }

  // Party check — direct owner, or a party on the document's transaction.
  let party = (doc as any).contact_id === input.contactId
  let agentId: string | null = null
  if ((doc as any).transaction_id) {
    const { data: tx } = await svc.from("transactions")
      .select("agent_id, contact_id, buyer_contact_id")
      .eq("id", (doc as any).transaction_id).maybeSingle()
    if (tx) {
      agentId = (tx as any).agent_id ?? null
      party = party || (tx as any).contact_id === input.contactId || (tx as any).buyer_contact_id === input.contactId
    }
  }
  if (!party) return { success: false, error: "This document is not yours to sign" }

  if (!agentId) {
    const { data: contact } = await svc.from("contacts")
      .select("agent_id").eq("id", input.contactId).maybeSingle()
    agentId = (contact as any)?.agent_id ?? null
  }
  if (!agentId) return { success: false, error: "No agent is attached yet — message your agent directly and they'll send the signing link." }

  const docLabel = String((doc as any).document_type ?? "document").replace(/_/g, " ")

  await svc.from("client_portal_activity").insert({
    contact_id: input.contactId,
    activity_type: "signature_link_requested",
    metadata: { document_id: input.documentId },
  }).then(() => {}, () => {})

  const { error } = await svc.from("tasks").insert({
    brokerage_id: (doc as any).brokerage_id,
    transaction_id: (doc as any).transaction_id ?? null,
    contact_id: input.contactId,
    assigned_to_agent_id: agentId,
    title: `Client is ready to sign — send the ${docLabel} signature request`,
    description: `The client hit "Sign" on the ${docLabel} in their portal. Send the e-sign envelope so they can sign while they're engaged.`,
    due_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    assignee_type: "agent",
    source: "signature_link_request",
    status: "pending",
  })
  if (error) return { success: false, error: "That didn't go through — message your agent directly to be safe." }

  return { success: true, message: "Your agent is sending the signing link — watch your email." }
}
