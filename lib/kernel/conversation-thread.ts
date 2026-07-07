// lib/kernel/conversation-thread.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE conversation resolver. messages.conversation_id is NOT NULL (live
// schema), and four writers each handled that differently: workflows.ts had a
// correct inline find-or-create, while sendInboxReply (lib/kernel/
// communications.ts), forceComplianceOverrideAndSend (app/actions/inbox.ts),
// and the new inbound-SMS recorder inserted WITHOUT it — every one of those
// inserts violated the constraint and the reply silently never sent (the
// live-proof seed caught it). Keep-one: every messages writer resolves the
// thread here first.

/** Find or create the contact's conversation thread; returns its id.
 *  Works with both service and user-scoped clients. conversations.agent_id is
 *  NOT NULL (live schema), so a missing agent resolves through the cascade:
 *  caller-supplied → the contact's assigned agent → any brokerage agent. */
export async function ensureConversationForContact(client: any, input: {
  contactId: string
  brokerageId: string
  agentId?: string | null
}): Promise<string | null> {
  const { data: existing } = await client
    .from("conversations")
    .select("id")
    .eq("contact_id", input.contactId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing?.id) return existing.id as string

  let agentId = input.agentId ?? null
  if (!agentId) {
    const { data: contact } = await client.from("contacts")
      .select("agent_id").eq("id", input.contactId).maybeSingle()
    agentId = (contact as any)?.agent_id ?? null
  }
  if (!agentId) {
    const { data: anyAgent } = await client.from("agents")
      .select("id").eq("brokerage_id", input.brokerageId).limit(1).maybeSingle()
    agentId = (anyAgent as any)?.id ?? null
  }
  if (!agentId) {
    console.error("[conversation-thread] no agent resolvable for the thread — brokerage has no agents")
    return null
  }

  const { data: created, error } = await client
    .from("conversations")
    .insert({ contact_id: input.contactId, brokerage_id: input.brokerageId, agent_id: agentId })
    .select("id")
    .single()
  if (error) {
    console.error("[conversation-thread] create failed:", error.message)
    return null
  }
  return (created as any)?.id ?? null
}

/** Best-effort thread stats bump after a message lands (inbox badges). */
export async function touchConversation(client: any, conversationId: string, opts: { inbound: boolean }): Promise<void> {
  try {
    const { data: conv } = await client.from("conversations")
      .select("message_count, unread_count").eq("id", conversationId).maybeSingle()
    await client.from("conversations").update({
      last_message_at: new Date().toISOString(),
      message_count: ((conv as any)?.message_count ?? 0) + 1,
      ...(opts.inbound ? { unread_count: ((conv as any)?.unread_count ?? 0) + 1 } : {}),
      updated_at: new Date().toISOString(),
    }).eq("id", conversationId)
  } catch { /* stats are cosmetic; the message row is the record */ }
}
