/**
 * Pure row→view mapper for the workflow_webhook_events reader
 * (app/actions/tenant-webhooks.ts::listInboundWorkflowEvents). Kept out of
 * that "use server" file so it can be unit-tested without a database
 * connection (scripts/workflow-inbound-events-reader-simulator.ts).
 */
export interface WorkflowWebhookEventDbRow {
  id: unknown
  source: unknown
  event_type: unknown
  contact_id: unknown
  payload: unknown
  received_at: unknown
}

export interface InboundWorkflowEventViewShape {
  id: string
  source: string
  eventType: string
  contactId: string | null
  payload: Record<string, unknown>
  receivedAt: string
}

export function mapWorkflowWebhookEventRow(r: WorkflowWebhookEventDbRow): InboundWorkflowEventViewShape {
  return {
    id: String(r.id),
    source: String(r.source),
    eventType: String(r.event_type),
    contactId: (r.contact_id as string | null) ?? null,
    payload: (r.payload as Record<string, unknown>) ?? {},
    receivedAt: String(r.received_at),
  }
}
