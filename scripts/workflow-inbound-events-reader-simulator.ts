#!/usr/bin/env tsx
/**
 * scripts/workflow-inbound-events-reader-simulator.ts (npm run test:workflow-inbound-events-reader) — pure, no DB.
 *
 * Proves mapWorkflowWebhookEventRow (lib/workflow/inbound-event-view.ts), the
 * row→view mapper behind the workflow_webhook_events reader
 * (app/actions/tenant-webhooks.ts::listInboundWorkflowEvents) — the
 * orphan-doctrine §1.2 build for a table whose 5 non-key columns
 * (app/api/workflow/trigger/route.ts's audit insert) had no reader anywhere.
 *
 * Positive control (§2): a mapper that dropped a field, coerced null wrong,
 * or defaulted payload to something other than {} would fail one of these
 * checks — this is not a scanner that can report "0 defects" on a hollow map.
 */
import { mapWorkflowWebhookEventRow } from "../lib/workflow/inbound-event-view"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.log(`  ✗ ${n}`) }
}

console.log("\n[workflow_webhook_events reader · pure]")

{
  const row = {
    id: "evt-1",
    source: "ghl",
    event_type: "tag_added",
    contact_id: "c-1",
    payload: { tag: "hot-lead" },
    received_at: "2026-09-01T00:00:00.000Z",
  }
  const view = mapWorkflowWebhookEventRow(row)
  check("id passes through", view.id === "evt-1")
  check("source passes through", view.source === "ghl")
  check("event_type maps to eventType (camelCase, no data loss)", view.eventType === "tag_added")
  check("contact_id maps to contactId", view.contactId === "c-1")
  check("payload passes through verbatim (not stringified, not dropped)", view.payload.tag === "hot-lead")
  check("received_at maps to receivedAt", view.receivedAt === "2026-09-01T00:00:00.000Z")
}

{
  // A row with no contact (anonymous trigger — e.g. a QR scan with no known
  // contact yet) and no payload (metadata was undefined on the insert).
  const row = {
    id: "evt-2",
    source: "qr",
    event_type: "qr_scan",
    contact_id: null,
    payload: null,
    received_at: "2026-09-02T00:00:00.000Z",
  }
  const view = mapWorkflowWebhookEventRow(row)
  check("null contact_id maps to null contactId (not the string 'null')", view.contactId === null)
  check("null payload defaults to {} (never crashes JSON.stringify downstream)", Object.keys(view.payload).length === 0)
}

console.log("\n──────────────────────────────────────────────────")
if (fail > 0) {
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  process.exit(1)
}
console.log(` RESULT: ${pass} passed, 0 failed`)
console.log(" ✅ WORKFLOW_INBOUND_EVENTS_READER_PASS — row→view mapper behind the new inbound-events surface holds")
