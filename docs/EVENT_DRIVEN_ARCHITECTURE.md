# Event-Driven Architecture

## Overview

All important state changes in the system flow through a central `events` table and are processed by the orchestrator. This ensures:

- **Auditability**: Every important action is logged
- **Idempotency**: Duplicate events are prevented via `dedupe_key`
- **Decoupling**: UI/API doesn't need to know about downstream workflows
- **Scalability**: Events can be processed asynchronously

## Event Flow

\`\`\`
UI Action / Webhook
  ↓
logEventAndTrigger()
  ↓
Insert into events table
  ↓
orchestrateEvent()
  ↓
Route to handler based on event_type
  ↓
Generate suggestions, send notifications, trigger workflows
  ↓
Log processing results
\`\`\`

## Usage Examples

### From UI Components

\`\`\`typescript
import { logLeadCreated } from '@/lib/events/event-helpers'

// When user creates a new lead
async function handleCreateLead(contactData) {
  const contact = await createContact(contactData)
  
  // Log event - orchestrator will handle follow-up
  await logLeadCreated({
    brokerage_id: user.brokerage_id,
    user_id: user.id,
    contact_id: contact.id,
    source: 'zillow_premier',
    timeline: 'immediate'
  })
}
\`\`\`

### From API Routes

\`\`\`typescript
import { logEventAndTrigger } from '@/lib/events/event-helpers'

export async function POST(request: Request) {
  const data = await request.json()
  
  // Log custom event
  await logEventAndTrigger({
    brokerage_id: data.brokerage_id,
    user_id: data.user_id,
    event_type: 'custom.action',
    payload: { custom: 'data' },
    source: 'ui',
    dedupe_key: `custom_${data.id}`
  })
  
  return Response.json({ success: true })
}
\`\`\`

### From Webhooks

\`\`\`typescript
import { handleWebhookEvent } from '@/lib/events/event-helpers'

export async function POST(request: Request) {
  const webhookPayload = await request.json()
  
  // Convert webhook to event
  await handleWebhookEvent(webhookPayload)
  
  return Response.json({ received: true })
}
\`\`\`

## Event Types

See `app/actions/orchestrator.ts` for all supported event types:

- `lead.created` - New lead entered system
- `lead.tagged_hot` - Lead marked as hot
- `listing.appointment_set` - Listing appointment scheduled
- `listing.signed` - Listing agreement signed
- `listing.live` - Listing went live on MLS
- `transaction.milestone_overdue` - Transaction milestone is overdue
- `credit.status_updated` - Contact credit status changed
- `video.generated` - AI video generation completed

## Adding New Event Types

1. Add constant to `EVENT_TYPES` in `orchestrator.ts`
2. Add handler function `handleYourEvent()`
3. Add case in orchestrator switch statement
4. Create convenience function in `event-helpers.ts`

## Idempotency

Use `dedupe_key` to prevent duplicate processing:

\`\`\`typescript
await logEventAndTrigger({
  // ... other fields
  dedupe_key: `listing_signed_${listing_id}`
})
\`\`\`

Events with the same `dedupe_key` within 24 hours are rejected.

## Monitoring

Query the `events` and `event_processing_log` tables to monitor:

- Event volume by type
- Processing failures
- Handler performance
