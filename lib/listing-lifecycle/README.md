# System 5.2: Listing Lifecycle Core

**Purpose:** Authoritative lifecycle governance and orchestration layer for real estate listings.

**What it does:** Defines listing state progression, validates transitions, enforces authority rules, gates downstream systems.

**What it does NOT do:** Execute work, create UI, manage downstream systems directly.

---

## System Architecture

### Core Principles

1. **Governance Only** - This system validates, enforces, gates, and logs. It does NOT execute work.
2. **No Schema Changes** - Uses existing tables only (listings, activities, documents, etc.)
3. **Authority-Based** - Role-aware enforcement (agent, team_leader, broker, admin)
4. **Audit Trail** - Every transition logged to activities table
5. **System Gating** - Controls when downstream systems can operate

### Files

- `lifecycle-definitions.ts` - 31 canonical stages with rules
- `transition-validator.ts` - Validates stage transitions
- `readiness-checker.ts` - Evaluates readiness requirements
- `lifecycle-logger.ts` - Logs events to activities table
- `../../app/actions/listing-lifecycle-core.ts` - Server actions (public API)

---

## Canonical Lifecycle Stages (31 Total)

### Pre-Listing (Stages 1-10)
1. **LEAD** - Initial lead captured
2. **LEAD_ASSIGNED** - Lead assigned to agent
3. **AGENT_CONSULTATION** - Agent consulting with seller
4. **APPOINTMENT_SET** - Listing presentation scheduled
5. **CMA_GENERATION** - CMA being prepared
6. **LISTING_PRESENTATION_CREATED** - Presentation ready
7. **PRESENTATION_VIDEO_GENERATED** - Video created
8. **PRESENTATION_DRIP_PREP** - Follow-up sequence ready
9. **SELLER_DECISION** - Awaiting seller decision
10. **LISTING_AGREEMENT_INITIATED** - Agreement process started

### Agreement & Prep (Stages 11-19)
11. **LISTING_AGREEMENT_SIGNED** - Agreement executed
12. **MLS_DATE_CONFIRMED** - Go-live date set
13. **COMING_SOON_PREP** - Preparing coming soon marketing
14. **REPAIRS_IN_PROGRESS** - Pre-listing repairs
15. **COMING_SOON_ACTIVE** - Coming soon active (**Gates: marketing_execution**)
16. **MEDIA_CAPTURE** - Photos/video capture
17. **MEDIA_APPROVED** - Media approved
18. **MLS_READY** - Ready for MLS (**Gates: flyers_packets, listing_marketing**)
19. **OPEN_HOUSE_MARKETING** - Open house prep (**Gates: open_house_system**)

### Active Marketing (Stages 20-24)
20. **MLS_ACTIVE** - Live on MLS
21. **OPEN_HOUSE_EVENT** - Open house scheduled/completed
22. **SHOWINGS_ACTIVE** - Showings enabled (**Gates: seller_showings**)
23. **OFFERS_RECEIVED** - Offers received (**Gates: offers_system**)
24. **NEGOTIATION** - Negotiating terms

### Under Contract (Stages 25-29)
25. **UNDER_CONTRACT** - Contract executed (**Gates: transactions_system**)
26. **INSPECTION** - Inspection period
27. **APPRAISAL** - Appraisal in progress
28. **FINANCING** - Financing approval
29. **CLOSING_PREP** - Preparing for closing (**Gates: closing_prep_system**)

### Post-Close (Stages 30-31)
30. **CLOSED** - Transaction closed
31. **LIFETIME_CUSTOMER** - Enrolled in retention (**Gates: retention_system**)

---

## Usage Examples

### 1. Validate a Transition

```typescript
import { validateListingTransition } from '@/app/actions/listing-lifecycle-core'

const result = await validateListingTransition({
  listingId: 'uuid-here',
  targetStage: 'MLS_ACTIVE'
})

if (result.success && result.validation?.allowed) {
  console.log('Transition allowed')
} else {
  console.log('Blocked:', result.validation?.reason)
  console.log('Failed checks:', result.validation?.readinessChecks?.failed)
}
```

### 2. Execute a Transition

```typescript
import { executeListingTransition } from '@/app/actions/listing-lifecycle-core'

const result = await executeListingTransition({
  listingId: 'uuid-here',
  targetStage: 'MEDIA_APPROVED',
  notes: 'All photos approved by agent and seller'
})

if (result.success) {
  console.log('Enabled gates:', result.transition?.enabledSystemGates)
}
```

### 3. Admin Override (Skip Stages)

```typescript
import { executeListingTransition } from '@/app/actions/listing-lifecycle-core'

const result = await executeListingTransition({
  listingId: 'uuid-here',
  targetStage: 'MLS_ACTIVE',
  overrideReason: 'Expedited listing per broker approval'
})

// Skips intermediate stages with admin/broker role
```

### 4. Check System Gate

```typescript
import { checkSystemGate } from '@/app/actions/listing-lifecycle-core'

const result = await checkSystemGate({
  listingId: 'uuid-here',
  gateName: 'marketing_execution'
})

if (result.enabled) {
  // Marketing system can proceed
} else {
  // Block marketing execution
}
```

### 5. Get Next Allowed Stages

```typescript
import { getListingNextStages } from '@/app/actions/listing-lifecycle-core'

const result = await getListingNextStages('uuid-here')

console.log('Current stage:', result.currentStage)
console.log('Next allowed:', result.nextStages)
console.log('Can skip stages:', result.canSkipStages)
```

### 6. View Lifecycle History

```typescript
import { getListingLifecycleHistory } from '@/app/actions/listing-lifecycle-core'

const result = await getListingLifecycleHistory('uuid-here')

for (const event of result.history) {
  console.log(`${event.timestamp}: ${event.fromStage} → ${event.toStage}`)
  if (event.isOverride) {
    console.log('  [ADMIN OVERRIDE]')
  }
}
```

### 7. Integration: Block Marketing Execution

```typescript
// In your marketing system
import { checkSystemGate } from '@/app/actions/listing-lifecycle-core'

async function executeMarketingCampaign(listingId: string) {
  const gateCheck = await checkSystemGate({
    listingId,
    gateName: 'marketing_execution'
  })
  
  if (!gateCheck.enabled) {
    throw new Error(
      `Marketing not allowed. Listing must reach COMING_SOON_ACTIVE stage. ` +
      `Current stage: ${gateCheck.currentStage}`
    )
  }
  
  // Proceed with marketing
}
```

---

## Readiness Checks

### Available Checks

| Check | Description | Example Requirement |
|-------|-------------|---------------------|
| `documents_verified` | All required docs uploaded | Listing agreement verified |
| `dotloop_signatures` | Dotloop signatures complete | Agreement signed in Dotloop |
| `media_approved` | Photos/videos approved | Minimum 10 approved photos |
| `repairs_completed` | Pre-listing repairs done | All repair activities completed |
| `mls_data_complete` | MLS fields populated | Address, price, beds, baths, sqft |
| `showings_enabled` | Showing instructions set | Showing instructions + active status |
| `offer_exists` | At least one offer received | Offer record exists |
| `contract_signed` | Contract fully executed | Accepted offer + transaction created |
| `inspection_completed` | Inspection done | Inspection activity completed |
| `appraisal_completed` | Appraisal done | Appraisal activity completed |
| `financing_approved` | Financing approved | Financing approval activity completed |
| `closing_docs_ready` | Closing docs prepared | Closing disclosure created |

### Custom Readiness Check

```typescript
// In readiness-checker.ts
async function checkCustomRequirement(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Query existing tables
  // Return pass/fail with reason
}
```

---

## Role Authority

| Role | Can Advance | Can Override | Can Skip Stages |
|------|-------------|--------------|-----------------|
| **agent** | Operational stages | No | No |
| **team_leader** | Marketing approval stages | No | No |
| **broker** | All stages | Yes | Yes |
| **admin** | All stages | Yes | Yes |

---

## System Gates

Gates control when downstream systems can operate:

| Gate | Enabled At Stage | Blocks |
|------|------------------|--------|
| `marketing_execution` | COMING_SOON_ACTIVE | Marketing campaigns |
| `flyers_packets` | MLS_READY | Flyer generation |
| `listing_marketing` | MLS_READY | Listing marketing materials |
| `open_house_system` | OPEN_HOUSE_MARKETING | Open house management |
| `seller_showings` | SHOWINGS_ACTIVE | Showing management |
| `offers_system` | OFFERS_RECEIVED | Offer management |
| `transactions_system` | UNDER_CONTRACT | Transaction creation |
| `closing_prep_system` | CLOSING_PREP | Closing coordination |
| `retention_system` | LIFETIME_CUSTOMER | Retention programs |

### Gate Integration Pattern

```typescript
// In any downstream system
import { checkSystemGate } from '@/app/actions/listing-lifecycle-core'

async function executeDownstreamAction(listingId: string) {
  const gate = await checkSystemGate({
    listingId,
    gateName: 'your_gate_name'
  })
  
  if (!gate.enabled) {
    return {
      success: false,
      error: `Action not allowed at stage ${gate.currentStage}`
    }
  }
  
  // Proceed
}
```

---

## Statistics & Reporting

### Brokerage Lifecycle Stats

```typescript
import { getBrokerageLifecycleStats } from '@/app/actions/listing-lifecycle-core'

const result = await getBrokerageLifecycleStats({
  dateFrom: '2024-01-01',
  dateTo: '2024-12-31'
})

console.log('Total transitions:', result.statistics.totalTransitions)
console.log('Admin overrides:', result.statistics.overrideCount)
console.log('Failed transitions:', result.statistics.failedTransitions)
console.log('Stage distribution:', result.statistics.stageDistribution)
```

### Stage Timing Metrics

```typescript
import { getBrokerageStageTimings } from '@/app/actions/listing-lifecycle-core'

const result = await getBrokerageStageTimings({
  dateFrom: '2024-01-01'
})

for (const [stage, metrics] of Object.entries(result.timings)) {
  console.log(`${stage}: ${metrics.averageDays} days (n=${metrics.count})`)
}
```

---

## Explicit Exclusions

This system does NOT manage:

- **Buyer tours** - Buyer-initiated, portal-driven (separate system)
- **Marketing execution** - Only gates marketing, doesn't execute
- **Document management** - Only validates documents exist
- **Workflow automation** - Only provides lifecycle signals
- **UI components** - Governance logic only

---

## Future Enhancements

When schema changes are allowed:

1. **Lifecycle Visualization UI** - Visual timeline component
2. **SLA Timers** - Track time in each stage
3. **Transaction Lifecycle System** - Separate 6.x system
4. **Automated Stage Progression** - Auto-advance on conditions
5. **Stage Templates** - Custom lifecycle paths per listing type

---

## Troubleshooting

### Transition Blocked

```typescript
const result = await validateListingTransition({
  listingId,
  targetStage
})

// Check what's blocking
console.log('Reason:', result.validation?.reason)
console.log('Failed checks:', result.validation?.readinessChecks?.failed)
console.log('Allowed stages:', result.validation?.nextAllowedStages)
```

### No Current Stage

Listings may not have a lifecycle stage yet. Always check:

```typescript
const { currentStage } = await getListingCurrentStage(listingId)

if (!currentStage) {
  // Initialize with LEAD stage
  await executeListingTransition({
    listingId,
    targetStage: 'LEAD'
  })
}
```

### Override Not Working

Only admin/broker roles can override:

```typescript
// Check user role
const { data: profile } = await supabase
  .from('users')
  .select('role')
  .eq('id', userId)
  .single()

if (profile.role !== 'admin' && profile.role !== 'broker') {
  // Cannot override
}
```

---

## Integration Checklist

When integrating a downstream system:

1. ✅ Identify which system gate(s) you need
2. ✅ Add gate check before execution
3. ✅ Return clear error if gate not enabled
4. ✅ Test with listing at various stages
5. ✅ Document gate requirement in your system

---

## Production Readiness

- [x] Zero schema modifications
- [x] All queries use existing tables
- [x] Role-based access control enforced
- [x] Complete audit trail via activities
- [x] System gates defined
- [x] Admin override capability
- [x] Comprehensive validation
- [x] Error handling
- [x] Full documentation

**Status: Production Ready** ✅
