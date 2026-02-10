# System 5.2: Listing Lifecycle Core - Implementation Summary

## Overview

**System 5.2** is the **authoritative lifecycle governance and orchestration layer** for real estate listings. It defines listing state progression, validates transitions, enforces role-based authority, and gates downstream systems—all without duplicating logic or creating new schema.

---

## Implementation Status: ✅ COMPLETE

### Files Created (6 files, 2,531 total lines)

1. **`lib/listing-lifecycle/lifecycle-definitions.ts`** (436 lines)
   - 31 canonical listing stages
   - Stage metadata (allowed previous stages, readiness checks, required roles)
   - System gate definitions
   - Helper functions for stage queries

2. **`lib/listing-lifecycle/transition-validator.ts`** (292 lines)
   - Validates stage transitions
   - Role authority checks
   - Previous stage validation
   - Admin override logic
   - Bulk validation support

3. **`lib/listing-lifecycle/readiness-checker.ts`** (526 lines)
   - 12 readiness check implementations
   - Queries existing tables (documents, activities, offers, transactions)
   - Pass/fail evaluation with details
   - NO new schema dependencies

4. **`lib/listing-lifecycle/lifecycle-logger.ts`** (381 lines)
   - Logs transitions to activities table
   - Logs failed attempts
   - Logs system gate enablement
   - Query lifecycle history
   - Statistics and timing metrics

5. **`app/actions/listing-lifecycle-core.ts`** (481 lines)
   - 11 server actions (public API)
   - Validation actions
   - Execution actions
   - Query actions
   - Statistics actions

6. **`lib/listing-lifecycle/README.md`** (415 lines)
   - Complete system documentation
   - Usage examples
   - Integration patterns
   - Troubleshooting guide

---

## Core Capabilities

### 1. Stage Validation ✅

**Validates transitions based on:**
- Allowed previous stages (no skipping)
- Required readiness checks
- Role-based authority
- Admin override capability

**Example:**
```typescript
const result = await validateListingTransition({
  listingId: 'uuid',
  targetStage: 'MLS_ACTIVE'
})

if (result.validation?.allowed) {
  // Proceed
} else {
  // Blocked: result.validation?.reason
}
```

### 2. Transition Execution ✅

**Executes validated transitions:**
- Logs to activities table
- Enables system gates
- Records override reason (if applicable)
- Maintains audit trail

**Example:**
```typescript
const result = await executeListingTransition({
  listingId: 'uuid',
  targetStage: 'MEDIA_APPROVED',
  notes: 'All photos approved'
})
```

### 3. Readiness Checks ✅

**12 built-in checks:**
- documents_verified
- dotloop_signatures
- media_approved
- repairs_completed
- mls_data_complete
- showings_enabled
- offer_exists
- contract_signed
- inspection_completed
- appraisal_completed
- financing_approved
- closing_docs_ready

**Example:**
```typescript
// Automatically evaluated during validation
const result = await validateListingTransition({
  listingId: 'uuid',
  targetStage: 'LISTING_AGREEMENT_SIGNED'
})

console.log('Failed checks:', result.validation?.readinessChecks?.failed)
// Output: ['dotloop_signatures', 'documents_verified']
```

### 4. System Gating ✅

**9 system gates:**
- marketing_execution (@ COMING_SOON_ACTIVE)
- flyers_packets (@ MLS_READY)
- listing_marketing (@ MLS_READY)
- open_house_system (@ OPEN_HOUSE_MARKETING)
- seller_showings (@ SHOWINGS_ACTIVE)
- offers_system (@ OFFERS_RECEIVED)
- transactions_system (@ UNDER_CONTRACT)
- closing_prep_system (@ CLOSING_PREP)
- retention_system (@ LIFETIME_CUSTOMER)

**Example:**
```typescript
const gate = await checkSystemGate({
  listingId: 'uuid',
  gateName: 'marketing_execution'
})

if (!gate.enabled) {
  throw new Error(`Marketing blocked at stage ${gate.currentStage}`)
}
```

### 5. Role Authority ✅

**Authority hierarchy:**
- **agent:** Operational stages
- **team_leader:** Marketing approval stages
- **broker:** All stages + override + skip
- **admin:** All stages + override + skip

**Example:**
```typescript
// Agent role
const result = await validateListingTransition({
  listingId: 'uuid',
  targetStage: 'APPOINTMENT_SET'
})
// Allowed ✅

// Admin override
const result = await executeListingTransition({
  listingId: 'uuid',
  targetStage: 'MLS_ACTIVE',
  overrideReason: 'Expedited per broker'
})
// Skips intermediate stages ✅
```

### 6. Audit Trail ✅

**All lifecycle events logged to activities:**
- Stage transitions (successful)
- Failed transition attempts
- System gate enablement
- Override actions

**Example:**
```typescript
const history = await getListingLifecycleHistory('uuid')

for (const event of history) {
  console.log(`${event.timestamp}: ${event.fromStage} → ${event.toStage}`)
  if (event.isOverride) console.log('[ADMIN OVERRIDE]')
}
```

### 7. Statistics & Reporting ✅

**Brokerage-level metrics:**
- Total transitions
- Override count
- Failed transitions
- Stage distribution
- Average time per stage

**Example:**
```typescript
const stats = await getBrokerageLifecycleStats({
  dateFrom: '2024-01-01',
  dateTo: '2024-12-31'
})

console.log('Total:', stats.statistics.totalTransitions)
console.log('Overrides:', stats.statistics.overrideCount)
```

---

## 31 Canonical Stages

### Pre-Listing (10 stages)
1. LEAD
2. LEAD_ASSIGNED
3. AGENT_CONSULTATION
4. APPOINTMENT_SET (milestone)
5. CMA_GENERATION
6. LISTING_PRESENTATION_CREATED
7. PRESENTATION_VIDEO_GENERATED
8. PRESENTATION_DRIP_PREP
9. SELLER_DECISION (milestone)
10. LISTING_AGREEMENT_INITIATED

### Agreement & Prep (9 stages)
11. LISTING_AGREEMENT_SIGNED (milestone) - Requires: dotloop_signatures, documents_verified
12. MLS_DATE_CONFIRMED
13. COMING_SOON_PREP
14. REPAIRS_IN_PROGRESS
15. COMING_SOON_ACTIVE (milestone) - Gates: marketing_execution
16. MEDIA_CAPTURE
17. MEDIA_APPROVED - Requires: media_approved
18. MLS_READY (milestone) - Requires: mls_data_complete, media_approved - Gates: flyers_packets, listing_marketing
19. OPEN_HOUSE_MARKETING - Gates: open_house_system

### Active Marketing (5 stages)
20. MLS_ACTIVE (milestone) - Requires: mls_data_complete
21. OPEN_HOUSE_EVENT
22. SHOWINGS_ACTIVE - Requires: showings_enabled - Gates: seller_showings
23. OFFERS_RECEIVED (milestone) - Requires: offer_exists - Gates: offers_system
24. NEGOTIATION

### Under Contract (5 stages)
25. UNDER_CONTRACT (milestone) - Requires: contract_signed - Gates: transactions_system
26. INSPECTION
27. APPRAISAL - Requires: inspection_completed
28. FINANCING - Requires: appraisal_completed
29. CLOSING_PREP - Requires: financing_approved - Gates: closing_prep_system

### Post-Close (2 stages)
30. CLOSED (milestone) - Requires: closing_docs_ready
31. LIFETIME_CUSTOMER (milestone) - Gates: retention_system

---

## Schema Compliance (STRICT)

### Read-Only Tables
- listings (address, price, bedrooms, bathrooms, sqft, showing_instructions, status)
- documents (document_type, status, is_required)
- activities (all lifecycle events logged here)
- listing_photos (status)
- offers (status)
- transactions (id, status, stage)
- closing_disclosure (id)

### Write-Only Table
- activities (ALL lifecycle events)

### Forbidden
- No new tables
- No new columns
- No modifications to existing schema

---

## Integration Patterns

### Pattern 1: Block Downstream Action

```typescript
// In marketing system
import { checkSystemGate } from '@/app/actions/listing-lifecycle-core'

async function executeMarketingCampaign(listingId: string) {
  const gate = await checkSystemGate({
    listingId,
    gateName: 'marketing_execution'
  })
  
  if (!gate.enabled) {
    return {
      success: false,
      error: `Marketing not allowed. Listing must reach COMING_SOON_ACTIVE.`,
      currentStage: gate.currentStage
    }
  }
  
  // Execute marketing
}
```

### Pattern 2: React to Stage Change

```typescript
// In workflow orchestrator
import { getListingCurrentStage } from '@/app/actions/listing-lifecycle-core'

async function checkStageAndTrigger(listingId: string) {
  const { currentStage } = await getListingCurrentStage(listingId)
  
  if (currentStage === 'LISTING_AGREEMENT_SIGNED') {
    // Trigger: Order photos, create MLS draft
  } else if (currentStage === 'MLS_ACTIVE') {
    // Trigger: Post to social, email agent network
  }
}
```

### Pattern 3: Enforce Transition in UI

```typescript
// In listing dashboard
import { getListingNextStages } from '@/app/actions/listing-lifecycle-core'

const { currentStage, nextStages, canSkipStages } = 
  await getListingNextStages(listingId)

// Show dropdown with only allowed stages
<select>
  {nextStages.map(stage => (
    <option value={stage}>{stage}</option>
  ))}
</select>

// Show admin override option if broker/admin
{canSkipStages && (
  <button>Admin Override</button>
)}
```

---

## Explicit Exclusions

**This system does NOT:**
- ❌ Execute downstream actions
- ❌ Manage buyer tours
- ❌ Execute marketing campaigns
- ❌ Upload documents
- ❌ Create workflows
- ❌ Render UI components

**This system ONLY:**
- ✅ Validates transitions
- ✅ Enforces authority
- ✅ Gates systems
- ✅ Logs events

---

## Production Readiness Checklist

- [x] **Zero Schema Changes** - Uses existing tables only
- [x] **Role-Based Access Control** - Agent/team_leader/broker/admin enforced
- [x] **Complete Audit Trail** - All events logged to activities
- [x] **Readiness Validation** - 12 built-in checks
- [x] **System Gating** - 9 gates defined
- [x] **Admin Override** - Broker/admin can skip stages
- [x] **Error Handling** - All actions return success/error
- [x] **Input Validation** - UUID validation on all IDs
- [x] **Comprehensive Documentation** - README + examples
- [x] **Statistics & Reporting** - Brokerage-level metrics
- [x] **No Execution Logic** - Governance only
- [x] **No UI Components** - Backend only

---

## API Reference

### Server Actions

#### Validation
- `validateListingTransition(params)` - Validate if transition allowed
- `getListingNextStages(listingId)` - Get next allowed stages

#### Execution
- `executeListingTransition(params)` - Execute validated transition

#### Queries
- `getLifecycleStages()` - Get all 31 stages
- `getListingLifecycleHistory(listingId)` - Get transition history
- `getListingCurrentStage(listingId)` - Get current stage

#### System Gates
- `checkSystemGate(params)` - Check if gate enabled
- `getEnabledGates(listingId)` - Get all enabled gates

#### Statistics
- `getBrokerageLifecycleStats(params)` - Get brokerage stats
- `getBrokerageStageTimings(params)` - Get stage timing metrics

---

## Testing Scenarios

### Scenario 1: Happy Path

```typescript
// Start from LEAD
await executeListingTransition({
  listingId,
  targetStage: 'LEAD'
})

// Advance through stages
await executeListingTransition({
  listingId,
  targetStage: 'LEAD_ASSIGNED'
})

// ... continue through all 31 stages
```

### Scenario 2: Blocked Transition

```typescript
// Try to skip to MLS_ACTIVE from LEAD
const result = await validateListingTransition({
  listingId,
  targetStage: 'MLS_ACTIVE'
})

// result.validation.allowed === false
// result.validation.reason === "Cannot advance from LEAD to MLS_ACTIVE..."
```

### Scenario 3: Admin Override

```typescript
// Admin skips stages
const result = await executeListingTransition({
  listingId,
  targetStage: 'MLS_ACTIVE',
  overrideReason: 'Expedited listing per broker approval'
})

// Success with warning
// Logs override to activities
```

### Scenario 4: System Gate Check

```typescript
// Marketing tries to execute at LEAD stage
const gate = await checkSystemGate({
  listingId,
  gateName: 'marketing_execution'
})

// gate.enabled === false
// gate.currentStage === 'LEAD'

// Marketing blocked until COMING_SOON_ACTIVE
```

---

## Future Enhancements

When schema changes are allowed:

1. **listings.current_stage column** - Store current stage directly (currently derived from activities)
2. **Lifecycle SLA tracking** - Alert if stages take too long
3. **Transaction Lifecycle System** - Separate 6.x system for post-contract
4. **Automated progression** - Auto-advance on conditions
5. **Stage templates** - Custom lifecycle paths per listing type

---

## Status: Production Ready ✅

System 5.2 is fully implemented, documented, and ready for production use. It provides authoritative lifecycle governance without schema changes, execution logic, or UI dependencies.

**Total Implementation:** 2,531 lines across 6 files
**Schema Modifications:** 0
**New Tables:** 0
**Dependencies:** Existing Supabase tables only
