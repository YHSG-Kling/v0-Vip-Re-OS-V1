# System 5.2: Listing Lifecycle Core - Governance Hardening

**Status:** ✅ COMPLETE  
**Type:** Additive Governance Patch  
**Impact:** Non-Breaking, Backward Compatible

---

## Overview

This document describes the governance hardening patches applied to System 5.2 (Listing Lifecycle Core). These patches add critical governance features without modifying existing behavior or breaking existing integrations.

---

## What Was Added

### 1. Event Storage & Querying (`event-storage.ts`)

**Purpose:** Enforce standardized event storage contract for all lifecycle and integration events.

**Key Functions:**
- `storeLifecycleEvent()` - Store events with namespaced types
- `queryEventsByEntityAndType()` - Query by entity and type prefix
- `queryEventsByIntegrationSource()` - Query by integration source
- `checkEventExists()` - Check for event existence (for deduplication)
- `getLatestEvent()` - Get most recent event of a type
- `countEventsByType()` - Count events by type prefix

**Storage Contract:**
```typescript
{
  entity_type: "listing" | "transaction" | "contact"
  entity_id: string
  event_type: string  // Namespaced, e.g. 'listing.lifecycle.transition'
  metadata: {
    integration_source?: string
    external_event_id?: string
    ...
  }
}
```

**Queryable By:**
- entity_id
- type prefix (e.g., `listing.lifecycle.*`)
- integration_source

---

### 2. Integration Event Deduplication (`integration-deduplication.ts`)

**Purpose:** Make all integration events idempotent.

**Key Functions:**
- `storeIntegrationEventIdempotent()` - Store with automatic deduplication
- `storeIntegrationEventWithMetadataHash()` - Deduplicate by metadata hash
- `batchStoreIntegrationEvents()` - Batch storage with deduplication
- `filterDuplicateEvents()` - Pre-filter duplicates before storing

**Deduplication Strategy:**
- By `entity_id` + `type` + `integration_source` + `external_event_id`
- Fallback to metadata hash if no external_event_id
- Gracefully ignores duplicates (returns `{ success: true, isDuplicate: true }`)

**Standardized Event Types:**
- `integration.media.assets.uploaded`
- `integration.media.assets.approved`
- `integration.documents.completed`
- `integration.signatures.received`
- `integration.mls.synced`
- `integration.showing.scheduled`
- `integration.offer.received`
- `integration.transaction.created`
- ... and more (see file for full list)

---

### 3. Enhanced Readiness Evaluation (`readiness-evaluation-enhanced.ts`)

**Purpose:** Derive readiness from integration events (not database state).

**Key Functions:**
- `evaluateMediaReadinessFromEvents()` - Media readiness from events
- `evaluateDocumentReadinessFromEvents()` - Document readiness from events
- `evaluateSignatureReadinessFromEvents()` - Signature readiness from events
- `evaluateMLSReadinessFromEvents()` - MLS readiness from events
- `evaluateRepairReadinessFromEvents()` - Repair readiness from events
- `evaluateCompositeReadiness()` - Single check evaluation
- `evaluateAllReadinessComposite()` - All checks evaluation

**Readiness Sources:**
- `media_ready` ← `integration.media.assets.approved` event exists
- `documents_complete` ← `integration.documents.completed` event exists
- `signatures_received` ← `integration.signatures.received` event exists
- `mls_data_complete` ← `integration.mls.synced` or `integration.mls.activated` event exists
- `repairs_completed` ← All `integration.repair.scheduled` have corresponding `integration.repair.completed`
- `showings_enabled` ← `integration.showing.*` events exist
- `offer_exists` ← `integration.offer.received` event exists

**Key Principle:** NO PERSISTED FLAGS. All readiness is runtime-derived from events.

---

### 4. Rollback Cascade Signaling (`rollback-cascade.ts`)

**Purpose:** Signal downstream systems when rollbacks occur.

**Key Functions:**
- `emitRollbackCascade()` - Emit rollback signal with affected domains
- `determineAffectedDomains()` - Calculate which domains are impacted
- `emitExceptionCascade()` - Emit exception signal (critical failures)
- `getRollbackHistory()` - Query rollback history
- `isListingInRollback()` - Check if listing is in rollback state
- `getRecentRollbackDomains()` - Get affected domains for recent rollback

**Affected Domains:**
- `marketing` - Marketing campaigns
- `showings` - Showing management
- `offers` - Offer management
- `transactions` - Transaction coordination
- `media` - Media assets
- `documents` - Document workflows
- `repairs` - Repair scheduling
- `mls` - MLS syndication

**Rollback Rules:**
- Rolling back past `COMING_SOON_ACTIVE` → affects `marketing`
- Rolling back past `MEDIA_APPROVED` → affects `media`
- Rolling back past `MLS_ACTIVE` → affects `mls`
- Rolling back past `SHOWINGS_ACTIVE` → affects `showings`
- Rolling back past `OFFERS_RECEIVED` → affects `offers`
- Rolling back past `UNDER_CONTRACT` → affects `transactions`

**Downstream System Requirements:**
- MUST listen for `listing.lifecycle.rollback` events
- MUST pause or revert workflows when rollback detected
- Check `isListingInRollback()` before executing workflows

---

### 5. Exception Recovery Limits (`exception-recovery-limits.ts`)

**Purpose:** Enforce time-bound rules and escalations.

**Key Functions:**
- `checkStageDurationLimit()` - Check if stage duration exceeded
- `emitStageDurationEscalation()` - Emit escalation event
- `checkAllListingDurationLimits()` - Batch check for violations
- `checkSpecialStageRules()` - Check special rules (e.g., EXPIRED cannot resume)
- `getEscalationHistory()` - Query escalation history

**Stage Duration Limits:**
- `LEAD` - 7 days max
- `LEAD_ASSIGNED` - 3 days max
- `AGENT_CONSULTATION` - 14 days max
- `APPOINTMENT_SET` - 7 days max
- `SELLER_DECISION` - 30 days max (auto-transition to LEAD)
- `REPAIRS_IN_PROGRESS` - 30 days max
- `MEDIA_CAPTURE` - 7 days max
- `MLS_READY` - 3 days max
- `SHOWINGS_ACTIVE` - 90 days max
- `NEGOTIATION` - 14 days max
- `INSPECTION` - 10 days max
- `APPRAISAL` - 14 days max
- `FINANCING` - 30 days max
- `CLOSING_PREP` - 7 days max

**Special Rules:**
- `EXPIRED_NO_RESUME` - Expired listings cannot resume without new agreement (broker approval required)

**Escalation Events:**
- Type: `listing.lifecycle.escalation.duration_exceeded`
- Includes: current_stage, days_in_stage, max_duration_days, escalation_roles
- Requires: Manual review by escalation_roles

**Implementation:**
- Run `checkAllListingDurationLimits()` daily via cron job
- Auto-emit escalation events when limits exceeded
- Block certain transitions based on special rules

---

### 6. Multi-Listing Seller Prioritization (`multi-listing-priority.ts`)

**Purpose:** Resolve which listing is primary when a contact has multiple listings.

**Key Functions:**
- `resolvePrimaryListing()` - Get primary listing for a contact
- `isListingPrimary()` - Check if listing is primary
- `getListingPriority()` - Get priority for a specific listing
- `canListingDriveJourneys()` - Check if listing can drive journeys
- `canListingTriggerMarketing()` - Check if listing can trigger marketing
- `canListingControlCommunications()` - Check if listing can control communications
- `getContactsWithMultipleListings()` - Get all contacts with multiple listings
- `getPriorityOverrideRecommendations()` - Get priority override recommendations

**Priority Tiers:**
- **Tier 4 (Active):** MLS_ACTIVE, SHOWINGS_ACTIVE, OFFERS_RECEIVED, NEGOTIATION, UNDER_CONTRACT, INSPECTION, APPRAISAL, FINANCING, CLOSING_PREP
- **Tier 3 (Coming Soon):** COMING_SOON_PREP, REPAIRS_IN_PROGRESS, COMING_SOON_ACTIVE, MEDIA_CAPTURE, MEDIA_APPROVED, MLS_READY, OPEN_HOUSE_MARKETING, OPEN_HOUSE_EVENT
- **Tier 2 (Pre-Listing):** LISTING_AGREEMENT_SIGNED, MLS_DATE_CONFIRMED
- **Tier 1 (Lead):** LEAD, LEAD_ASSIGNED, AGENT_CONSULTATION, etc.
- **Tier 0 (Closed):** CLOSED, LIFETIME_CUSTOMER

**Priority Order:**
1. Highest tier wins
2. Within same tier, most advanced stage wins
3. Result: primary, secondary, tertiary

**Primary Listing Rules:**
- Only primary listing can drive journeys
- Only primary listing can trigger marketing campaigns
- Only primary listing controls seller communications
- Secondary/tertiary listings are context only

**Implementation:**
- Check `canListingDriveJourneys()` before starting journey
- Check `canListingTriggerMarketing()` before sending campaigns
- Check `canListingControlCommunications()` before sending emails/SMS

---

## Integration Points

### Existing System 5.2 Files (Not Modified)
- `lifecycle-definitions.ts` - Stage definitions (unchanged)
- `transition-validator.ts` - Transition validation (unchanged)
- `readiness-checker.ts` - Original readiness checks (still used as fallback)
- `lifecycle-logger.ts` - Basic logging (extended by new modules)
- `listing-lifecycle-core.ts` - Server actions (can call new functions)

### New Files Added (Governance Patches)
- `event-storage.ts` - Event storage helpers
- `integration-deduplication.ts` - Integration event deduplication
- `readiness-evaluation-enhanced.ts` - Enhanced readiness evaluation
- `rollback-cascade.ts` - Rollback cascade signaling
- `exception-recovery-limits.ts` - Exception recovery limits
- `multi-listing-priority.ts` - Multi-listing priority resolver

---

## Usage Examples

### Example 1: Store Integration Event with Deduplication

```typescript
import { storeIntegrationEventIdempotent } from "@/lib/listing-lifecycle/integration-deduplication"
import { INTEGRATION_EVENT_TYPES } from "@/lib/listing-lifecycle/integration-deduplication"

// Store media approval event (idempotent)
const result = await storeIntegrationEventIdempotent(supabase, {
  entityType: "listing",
  entityId: listingId,
  eventType: INTEGRATION_EVENT_TYPES.MEDIA_ASSETS_APPROVED,
  eventData: {
    title: "Media Assets Approved",
    description: "10 photos approved by agent and seller",
    agentId: agentId,
    brokerageId: brokerageId,
    integrationSource: "photo_vendor",
    externalEventId: "photo_vendor_event_12345",
    metadata: {
      photo_count: 10,
      approved_by: "agent",
    },
  },
})

if (result.isDuplicate) {
  console.log("Event already stored, skipping")
} else {
  console.log("Event stored successfully:", result.eventId)
}
```

### Example 2: Evaluate Readiness from Events

```typescript
import { evaluateCompositeReadiness } from "@/lib/listing-lifecycle/readiness-evaluation-enhanced"

// Check if media is ready (from integration events)
const mediaCheck = await evaluateCompositeReadiness(supabase, listingId, "media_approved")

if (mediaCheck.passed) {
  console.log("Media is ready!")
} else {
  console.log("Media not ready:", mediaCheck.reason)
}
```

### Example 3: Emit Rollback Cascade

```typescript
import { emitRollbackCascade, determineAffectedDomains } from "@/lib/listing-lifecycle/rollback-cascade"

// Determine affected domains
const affectedDomains = determineAffectedDomains(currentStage, targetStage)

// Emit rollback signal
await emitRollbackCascade(supabase, {
  listingId,
  agentId,
  brokerageId,
  userId,
  userRole,
  fromStage: currentStage,
  toStage: targetStage,
  reason: "Seller requested to pause listing",
  affectedDomains,
})

// Downstream systems will receive this signal and pause workflows
```

### Example 4: Check Duration Limits

```typescript
import { checkStageDurationLimit, emitStageDurationEscalation } from "@/lib/listing-lifecycle/exception-recovery-limits"

// Check if listing has exceeded stage duration
const limitCheck = await checkStageDurationLimit(supabase, listingId)

if (limitCheck.exceeded && limitCheck.escalationRequired) {
  // Emit escalation event
  await emitStageDurationEscalation(supabase, {
    listingId,
    agentId,
    brokerageId,
    currentStage: limitCheck.currentStage!,
    daysInStage: limitCheck.daysInStage,
    maxDurationDays: limitCheck.maxDurationDays!,
    escalationRoles: limitCheck.escalationRoles,
  })
  
  console.log(`Escalation required! Listing has been in ${limitCheck.currentStage} for ${limitCheck.daysInStage} days`)
}
```

### Example 5: Resolve Primary Listing

```typescript
import { resolvePrimaryListing, canListingTriggerMarketing } from "@/lib/listing-lifecycle/multi-listing-priority"

// Resolve primary listing for a contact
const { primaryListing, allListings } = await resolvePrimaryListing(supabase, contactId)

console.log("Primary listing:", primaryListing?.listingId, primaryListing?.stage)
console.log("Total listings:", allListings.length)

// Before sending marketing campaign, check if listing is primary
const canSendMarketing = await canListingTriggerMarketing(supabase, listingId)

if (!canSendMarketing) {
  console.log("Listing is not primary. Skipping marketing campaign.")
  return
}
```

---

## Testing & Validation

### Unit Tests
- Event storage and querying
- Deduplication logic
- Readiness evaluation from events
- Rollback domain calculation
- Duration limit calculations
- Priority tier resolution

### Integration Tests
- End-to-end event storage and retrieval
- Idempotent event handling
- Composite readiness evaluation
- Rollback cascade signaling
- Multi-listing priority resolution

### Governance Tests
- Duration limit enforcement
- Special stage rules (e.g., EXPIRED_NO_RESUME)
- Priority override recommendations

---

## Production Deployment

### Prerequisites
- System 5.2 Core must be deployed
- Activities table must exist
- Listings, contacts, transactions tables must exist

### Deployment Steps
1. Deploy new files to `/lib/listing-lifecycle/`
2. No database migrations required (zero schema changes)
3. No existing code changes required (backward compatible)
4. Optional: Set up daily cron job for `checkAllListingDurationLimits()`

### Rollback Plan
- Simply stop using new functions
- No database changes to rollback
- Existing behavior unchanged

---

## Maintenance

### Daily Tasks (Recommended Cron Jobs)
1. Check duration limits: `checkAllListingDurationLimits()`
2. Check for stale rollbacks: `isListingInRollback()` cleanup
3. Review escalation events

### Weekly Tasks
1. Review multi-listing contacts: `getContactsWithMultipleListings()`
2. Review priority override recommendations: `getPriorityOverrideRecommendations()`

### Monthly Tasks
1. Review event storage patterns
2. Review deduplication effectiveness
3. Adjust duration limits if needed (code change)

---

## Future Enhancements

When schema modifications are allowed:
1. Add `listing_priority` column for caching
2. Add `readiness_flags` JSONB column for caching
3. Add `escalation_status` column
4. Create dedicated `lifecycle_events` table

Until then, this governance layer provides:
- ✅ Full event tracking
- ✅ Idempotent integrations
- ✅ Derived readiness evaluation
- ✅ Rollback cascade signaling
- ✅ Exception recovery limits
- ✅ Multi-listing priority resolution
- ✅ Zero schema changes
- ✅ Backward compatible
- ✅ Production ready

---

## Summary

This governance hardening makes System 5.2 production-grade by adding:
- Event storage contract enforcement
- Integration event deduplication
- Enhanced readiness evaluation (from events)
- Rollback cascade signaling
- Exception recovery limits
- Multi-listing seller prioritization

All without modifying existing code or database schema.

**Status:** ✅ COMPLETE AND PRODUCTION READY
