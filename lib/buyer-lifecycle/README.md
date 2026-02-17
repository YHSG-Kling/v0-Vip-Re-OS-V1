## System 5.1C: Buyer Lifecycle Governance Core

**Authoritative buyer lifecycle governor from contact creation through lifetime customer.**

### Purpose

Provides governance-only lifecycle management for buyers with:

- 13 canonical buyer states
- Financial verification requirements
- Deterministic gating for downstream systems
- Auditable lifecycle transitions
- Multi-listing buyer support
- Clean separation from listing lifecycle

### Design Principles

1. **Governance Only** - Validates, gates, and logs. Does NOT execute work.
2. **Persona-Agnostic** - No journey/persona logic (handled by UI layer)
3. **Event-Driven** - Financial verification and state are determined by events
4. **Multi-Listing** - Buyer lifecycle is independent of specific listings
5. **Frozen at Contract** - Lifecycle freezes when UNDER_CONTRACT (transaction system takes over)

### Canonical Buyer States (13)

```
BUYER_CONTACT_CREATED          → Initial contact record
BUYER_FINANCIALLY_VERIFIED     → Financial capacity verified (REQUIRED GATE)
BUYER_SEARCH_CONFIGURED        → Search preferences set
BUYER_SEARCHING                → Actively searching
BUYER_TOUR_ELIGIBLE            → Can schedule tours
BUYER_TOURING                  → Actively viewing properties
BUYER_OFFER_ELIGIBLE           → Ready to submit offers
BUYER_OFFER_SUBMITTED          → One or more offers submitted
BUYER_UNDER_CONTRACT           → Accepted offer (FROZEN STATE)
BUYER_ON_HOLD                  → Paused search
BUYER_DISENGAGED               → No longer active
BUYER_CLOSED                   → Transaction closed
BUYER_LIFETIME                 → Lifetime customer program
```

### Financial Verification (REQUIRED)

**Critical Gate:** `BUYER_FINANCIALLY_VERIFIED` is REQUIRED before:
- Property search
- Tour eligibility
- Offer eligibility

**Verification Signals (event-driven):**
```typescript
// Activities table events that count as verification:
- buyer.financial.verification
- buyer.pre_approval.uploaded
- buyer.proof_of_funds.uploaded
- buyer.lender.introduced
- agent.confirms.buyer.financial
```

**No State Storage:** Verification status is derived from events, NOT stored in schema.

### System Gating

Lifecycle state controls which downstream systems can operate:

```typescript
BUYER_FINANCIALLY_VERIFIED → property_search, tour_eligibility, offer_eligibility
BUYER_SEARCHING → property_search
BUYER_TOUR_ELIGIBLE → tour_scheduling
BUYER_TOURING → showing_management
BUYER_OFFER_ELIGIBLE → offer_creation
BUYER_OFFER_SUBMITTED → offer_tracking
BUYER_UNDER_CONTRACT → transaction_management (FROZEN)
BUYER_LIFETIME → retention_system
```

**Gating Helpers:**
```typescript
// Check if buyer can perform action
const searchAllowed = await canBuyerSearchProperties(contactId)
const tourAllowed = await canBuyerScheduleTours(contactId)
const offerAllowed = await canBuyerSubmitOffers(contactId)

// All return GatingResult with allowed/blocked status
```

### Usage Examples

#### 1. Advance Buyer to Financially Verified

```typescript
import {
  validateBuyerStateTransition,
  executeBuyerStateTransition,
  recordBuyerFinancialVerification,
} from "@/app/actions/buyer-lifecycle-core"

// Step 1: Record financial verification event
await recordBuyerFinancialVerification({
  contactId: "buyer-uuid",
  verificationType: "pre_approval",
  userId: "agent-uuid",
  expiresAt: new Date("2025-06-01"), // Optional expiration
  metadata: {
    lender: "ABC Mortgage",
    amount: 500000,
  },
})

// Step 2: Validate transition
const validation = await validateBuyerStateTransition({
  contactId: "buyer-uuid",
  currentState: "BUYER_CONTACT_CREATED",
  targetState: "BUYER_FINANCIALLY_VERIFIED",
  userRole: "agent",
  userId: "agent-uuid",
})

if (!validation.allowed) {
  console.error("Cannot advance:", validation.reason)
  return
}

// Step 3: Execute transition (emits event)
await executeBuyerStateTransition({
  contactId: "buyer-uuid",
  fromState: "BUYER_CONTACT_CREATED",
  toState: "BUYER_FINANCIALLY_VERIFIED",
  triggeredBy: "agent",
  authorityRole: "agent",
  userId: "agent-uuid",
  sourceSystem: "buyer_portal",
})
```

#### 2. Check if Buyer Can Search Properties

```typescript
import { canBuyerSearchProperties } from "@/app/actions/buyer-lifecycle-core"

const result = await canBuyerSearchProperties(contactId)

if (result.allowed) {
  // Enable property search UI
  console.log("Buyer can search properties")
} else {
  // Show blocker message
  console.log("Blocked:", result.reason)
  console.log("Required state:", result.requiredState)
  console.log("Blockers:", result.blockers)
}
```

#### 3. Get Lifecycle History

```typescript
import { getBuyerLifecycleHistory } from "@/app/actions/buyer-lifecycle-core"

const history = await getBuyerLifecycleHistory({
  contactId: "buyer-uuid",
  limit: 50,
})

for (const entry of history) {
  console.log(`${entry.fromState} → ${entry.toState}`)
  console.log(`At: ${entry.occurredAt}`)
  console.log(`By: ${entry.triggeredBy} (${entry.authorityRole})`)
}
```

#### 4. Rollback to ON_HOLD

```typescript
import {
  validateBuyerRollback,
  executeBuyerStateTransition,
} from "@/app/actions/buyer-lifecycle-core"

// Validate rollback
const validation = await validateBuyerRollback({
  contactId: "buyer-uuid",
  targetState: "BUYER_ON_HOLD",
  userRole: "agent",
})

if (validation.allowed) {
  // Execute rollback
  await executeBuyerStateTransition({
    contactId: "buyer-uuid",
    fromState: "BUYER_SEARCHING",
    toState: "BUYER_ON_HOLD",
    triggeredBy: "agent",
    authorityRole: "agent",
    userId: "agent-uuid",
    sourceSystem: "buyer_portal",
    metadata: {
      reason: "Buyer needs more time to prepare",
    },
  })
}
```

#### 5. Get Brokerage Statistics

```typescript
import { getBuyerLifecycleStatistics } from "@/app/actions/buyer-lifecycle-core"

const stats = await getBuyerLifecycleStatistics({
  brokerageId: "brokerage-uuid",
  startDate: new Date("2025-01-01"),
  endDate: new Date("2025-12-31"),
})

console.log("Total buyers:", stats.totalBuyers)
console.log("By state:", stats.byState)
```

### Integration with Other Systems

**Property Search (5.1A / 5.1B):**
```typescript
// Before allowing search, check gating
const canSearch = await canBuyerSearchProperties(contactId)
if (!canSearch.allowed) {
  return { error: canSearch.reason }
}

// Proceed with search...
```

**Showing System:**
```typescript
// Before scheduling tour
const canTour = await canBuyerScheduleTours(contactId)
if (!canTour.allowed) {
  return { error: canTour.reason }
}

// Schedule showing...
```

**Offer System:**
```typescript
// Before creating offer
const canOffer = await canBuyerSubmitOffers(contactId)
if (!canOffer.allowed) {
  return { error: canOffer.reason }
}

// Create offer...
```

**Transaction Lifecycle (6.x):**
```typescript
// When buyer goes UNDER_CONTRACT, lifecycle freezes
// Transaction system takes over
// Buyer lifecycle becomes read-only until CLOSED
```

### Multi-Listing Support

Buyer lifecycle is **listing-agnostic**:

- One buyer can search, tour, and offer on multiple listings
- Lifecycle state is at buyer level, not per-listing
- Systems query buyer state but MUST NOT mutate it
- Use offer/showing tables to track per-listing activity

### Frozen State (UNDER_CONTRACT)

When buyer reaches `BUYER_UNDER_CONTRACT`:

- Lifecycle becomes **read-only**
- No further transitions allowed (except to CLOSED)
- Transaction system takes authoritative control
- Unfreeze only when transaction closes → BUYER_CLOSED

### Schema Compliance

**Read-Only Tables:**
- contacts
- activities (for reading history)
- conversations (for context)
- showings (for context)
- offers (for context)

**Write-Only Table:**
- activities (for event emission)

**Zero Schema Changes:**
- No new tables
- No new columns
- No database modifications

### Files

```
lib/buyer-lifecycle/
  lifecycle-definitions.ts       → 13 canonical states
  transition-validator.ts        → State transition validation
  financial-verification.ts      → Event-driven verification check
  gating-helpers.ts              → Read-only action gating
  lifecycle-logger.ts            → Event emission & history

app/actions/buyer-lifecycle-core.ts → Public API (17 server actions)
```

### API Reference

**State Management:**
- `validateBuyerStateTransition()` - Validate if transition is allowed
- `executeBuyerStateTransition()` - Emit lifecycle transition event
- `getCurrentBuyerState()` - Get current state from history
- `getNextAllowedBuyerStates()` - Get valid next states
- `getBuyerLifecycleHistory()` - Get full lifecycle history

**Gating Helpers:**
- `canBuyerSearchProperties()` - Check search eligibility
- `canBuyerScheduleTours()` - Check tour eligibility
- `canBuyerSubmitOffers()` - Check offer eligibility
- `getBuyerEnabledGates()` - Get all enabled gates
- `isBuyerGateEnabled()` - Check specific gate

**Financial Verification:**
- `checkBuyerFinancialVerification()` - Check verification from events
- `getBuyerFinancialStatus()` - Get status summary
- `recordBuyerFinancialVerification()` - Emit verification event

**Statistics:**
- `getBuyerLifecycleStatistics()` - Brokerage-level metrics
- `getBuyersInSpecificState()` - List buyers by state

### Production Readiness

- ✅ Zero schema modifications
- ✅ Event-driven architecture
- ✅ Complete validation logic
- ✅ Comprehensive gating helpers
- ✅ Full audit trail
- ✅ Multi-listing support
- ✅ Frozen state protection
- ✅ Role-based authority
- ✅ Admin override support

### Maintenance Notes

- Lifecycle is **frozen** at UNDER_CONTRACT - no changes until CLOSED
- Financial verification is **event-driven** - no state storage
- Buyer lifecycle is **independent** of listing lifecycle
- All state transitions **must** emit events to activities table
- This system is **governance only** - does not execute work
