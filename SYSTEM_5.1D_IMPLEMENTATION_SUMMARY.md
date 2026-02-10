# System 5.1D: Buyer Lifecycle Governance Hardening

**Status:** ✅ Complete  
**Type:** Governance Patch (extends System 5.1C)  
**Schema Changes:** ZERO  
**Location:** `/lib/buyer-lifecycle/extensions`

---

## Overview

System 5.1D is an **ADDITIVE governance patch** that extends System 5.1C (Buyer Lifecycle Core) with production-hardening features for financial verification rigor, time-based decay, multi-offer reality, and operational SLAs.

### Key Principle

This patch is **purely governance** - it defines event schemas, validates rules, emits signals, and logs metadata. It does NOT:
- Execute workflows
- Send notifications
- Trigger automations
- Modify UI
- Change database schema

---

## Extensions Delivered

### 1. Financial Verification Event Schema
**File:** `financial-verification-schema.ts` (293 lines)

**Purpose:** Standardize canonical financial verification events

**Features:**
- Standardized `buyer.financial.verification` event structure
- Status tracking: `verified | rejected | expired`
- Verification types: `preapproval | proof_of_funds | lender_intro | agent_confirmation`
- Expiration date enforcement
- Max budget tracking
- Enhanced status checking with expiration validation

**Key Functions:**
- `emitFinancialVerificationEvent()` - Emit standardized verification event
- `getEnhancedVerificationStatus()` - Check verification with expiration
- `batchGetVerificationStatus()` - Bulk verification checking

---

### 2. Expiration Handling
**File:** `expiration-handler.ts` (311 lines)

**Purpose:** Handle time-bound verification expiration and auto-gating

**Features:**
- Expiration checking with transition requirements
- Auto-transition signals to `BUYER_ON_HOLD`
- SLA escalation on expiration
- System gate evaluation with expiration validation
- Proactive renewal reminders

**Key Functions:**
- `checkVerificationExpiration()` - Check if expired and needs transition
- `emitExpirationTransitionSignal()` - Signal orchestration to transition
- `evaluateSystemGateWithExpiration()` - Gate checking with expiration
- `getBuyersWithExpiringVerifications()` - Find buyers needing renewal

**Expiration Rules:**
- Expired verification → Auto-signal transition to `BUYER_ON_HOLD`
- 14-day warning threshold for renewal
- SLA escalation metadata emitted

---

### 3. Multi-Offer Guards
**File:** `multi-offer-guards.ts` (328 lines)

**Purpose:** Handle multiple offer submissions without lifecycle corruption

**Features:**
- Multiple `BUYER_OFFER_SUBMITTED` events allowed
- Only `accepted` offers trigger `BUYER_UNDER_CONTRACT`
- Terminal offer states (rejected/withdrawn/expired) don't regress buyer state
- Max 3 active offers per buyer (business rule)

**Key Functions:**
- `validateOfferSubmission()` - Can buyer submit another offer?
- `evaluateContractTransition()` - Should buyer go UNDER_CONTRACT?
- `emitOfferTerminalEvent()` - Log non-accepted offer outcomes
- `getBuyerOfferStatistics()` - Track offer history

**Multi-Offer Rules:**
- Buyers can have multiple active offers across listings
- Rejected/expired offers emit terminal events but preserve buyer state
- Only accepted offers advance to `BUYER_UNDER_CONTRACT`

---

### 4. ON_HOLD Recovery Paths
**File:** `recovery-paths.ts` (Part 1) (371 lines)

**Purpose:** Explicit recovery paths from ON_HOLD state

**Recovery Paths:**
1. **ON_HOLD → FINANCIALLY_VERIFIED**
   - Trigger: `new_approval`
   - Requires: New financial verification event

2. **ON_HOLD → SEARCH_CONFIGURED**
   - Trigger: `criteria_update`
   - Requires: Valid financial verification

3. **ON_HOLD → DISENGAGED**
   - Trigger: `timeout`
   - No verification required

**Key Functions:**
- `validateOnHoldRecovery()` - Validate recovery path
- `emitRecoveryEvent()` - Log recovery transition
- `getBuyersEligibleForRecovery()` - Find stale ON_HOLD buyers

---

### 5. DISENGAGED Re-engagement
**File:** `recovery-paths.ts` (Part 2) (371 lines)

**Purpose:** Controlled re-engagement from DISENGAGED state

**Re-engagement Rules:**
- **Buyer-initiated:** Buyer contacts agent → auto-reengagement allowed
- **Agent-authorized:** Agent/TL/Broker/Admin can reactivate with reason

**Key Functions:**
- `validateDisengagedReengagement()` - Check if reengagement allowed
- `emitReengagementEvent()` - Log `buyer.lifecycle.reengaged` event

**Requirements:**
- Must include authority role and source
- Requires triggering event (never silent)

---

### 6. SLA Metadata Definitions
**File:** `sla-metadata.ts` (346 lines)

**Purpose:** Emit SLA expectation metadata for orchestration

**SLA Expectations:**
- **Financial Verification:** 48 hours from contact creation
- **Search Configuration:** 48 hours from verification
- **Tour Scheduling:** 72 hours from tour eligibility
- **Offer Submission:** 7 days from offer eligibility
- **Inactivity Thresholds:** 14 days (searching), 10 days (touring)

**Key Functions:**
- `emitSLAExpectationMetadata()` - Emit expectations on state transition
- `checkSLABreach()` - Determine if SLA breached
- `emitSLABreachSignal()` - Log breach event
- `emitSLAWarningSignal()` - Warn before breach

**Note:** SLAs are emitted as metadata only. Phase 3 workflow systems enforce them.

---

### 7. Contact Lifecycle Sync
**File:** `contact-lifecycle-sync.ts` (341 lines)

**Purpose:** Keep buyer lifecycle aligned with contact lifecycle

**Sync Trigger States:**
- `BUYER_FINANCIALLY_VERIFIED` → Contact stage: `qualified`
- `BUYER_UNDER_CONTRACT` → Contact stage: `under_contract`
- `BUYER_LIFETIME` → Contact stage: `lifetime_customer`

**Key Functions:**
- `emitContactLifecycleSync()` - Emit `contact.lifecycle.sync` event
- `emitBuyerEngagementSignal()` - Signal engagement milestone
- `emitBuyerUnderContractSignal()` - Signal contract milestone
- `emitBuyerLifetimeSignal()` - Signal lifetime customer milestone
- `checkContactSyncStatus()` - Detect sync drift

**Purpose:** Ensures CRM views, journeys, and analytics stay aligned.

---

## File Structure

```
/lib/buyer-lifecycle/extensions/
├── financial-verification-schema.ts  (293 lines)
├── expiration-handler.ts             (311 lines)
├── multi-offer-guards.ts             (328 lines)
├── recovery-paths.ts                 (371 lines)
├── sla-metadata.ts                   (346 lines)
└── contact-lifecycle-sync.ts         (341 lines)

Total: 1,990 lines
```

---

## Schema Compliance

### Tables Read
- `contacts` - Buyer records
- `activities` - All lifecycle events

### Tables Written
- `activities` - ALL new events logged here

### Tables Forbidden
- ALL OTHER TABLES (strict compliance)

---

## Event Types Added

All events stored in `activities` table:

1. `buyer.financial.verification` - Canonical verification event
2. `buyer.lifecycle.expiration_transition_signal` - Expiration auto-transition
3. `buyer.lifecycle.sla_escalation` - SLA escalation
4. `buyer.lifecycle.renewal_reminder` - Verification renewal needed
5. `buyer.offer.lifecycle` - Offer status tracking
6. `buyer.offer.terminal` - Terminal offer events
7. `buyer.lifecycle.recovery` - ON_HOLD recovery
8. `buyer.lifecycle.reengaged` - DISENGAGED reengagement
9. `buyer.lifecycle.sla_expectations` - SLA metadata
10. `buyer.lifecycle.sla_breach` - SLA breach
11. `buyer.lifecycle.sla_warning` - SLA warning
12. `contact.lifecycle.sync` - Contact sync signal
13. `buyer.engagement.signal` - Engagement milestone
14. `buyer.under_contract.signal` - Contract milestone
15. `buyer.lifetime.signal` - Lifetime milestone

---

## Production Readiness

### ✅ Complete
- [x] All 7 extensions implemented
- [x] Zero schema changes
- [x] Event-driven architecture
- [x] Batch operations supported
- [x] Error handling implemented
- [x] Query helpers provided
- [x] Documentation complete

### ✅ Non-Breaking
- [x] Does NOT modify System 5.1C files
- [x] Additive extensions only
- [x] Backward compatible
- [x] Can be adopted incrementally

### ✅ Governance Only
- [x] No execution logic
- [x] No UI components
- [x] No workflow orchestration
- [x] Signals only

---

## Integration Guide

### Using Financial Verification Schema

```typescript
import { 
  emitFinancialVerificationEvent, 
  getEnhancedVerificationStatus 
} from '@/lib/buyer-lifecycle/extensions/financial-verification-schema'

// Emit verification event
await emitFinancialVerificationEvent({
  contactId: 'abc-123',
  status: 'verified',
  verificationType: 'preapproval',
  verifiedBy: 'lender',
  source: 'portal_upload',
  userId: 'agent-456',
  maxBudget: 850000,
  expiresAt: new Date('2025-06-01'),
})

// Check status
const status = await getEnhancedVerificationStatus('abc-123')
console.log(status.isVerified, status.isExpired)
```

### Using Expiration Handler

```typescript
import { 
  checkVerificationExpiration,
  evaluateSystemGateWithExpiration 
} from '@/lib/buyer-lifecycle/extensions/expiration-handler'

// Check expiration
const check = await checkVerificationExpiration('abc-123')
if (check.requiresTransition) {
  // Emit signal for orchestration to handle
  await emitExpirationTransitionSignal({
    contactId: 'abc-123',
    fromState: 'BUYER_SEARCHING',
    expirationDate: check.expirationDate!,
  })
}

// Gate evaluation
const gate = await evaluateSystemGateWithExpiration('abc-123', 'tour')
if (!gate.allowed) {
  console.log('Tour blocked:', gate.reason)
}
```

### Using Multi-Offer Guards

```typescript
import { 
  validateOfferSubmission,
  evaluateContractTransition 
} from '@/lib/buyer-lifecycle/extensions/multi-offer-guards'

// Before offer submission
const validation = await validateOfferSubmission('abc-123')
if (!validation.allowed) {
  throw new Error(validation.reason)
}

// When offer is accepted
const transition = await evaluateContractTransition('abc-123', 'offer-789', 'accepted')
if (transition.shouldTransition) {
  // Signal buyer should move to UNDER_CONTRACT
}
```

### Using Recovery Paths

```typescript
import { 
  validateOnHoldRecovery,
  validateDisengagedReengagement 
} from '@/lib/buyer-lifecycle/extensions/recovery-paths'

// ON_HOLD recovery
const recovery = await validateOnHoldRecovery(
  'abc-123',
  'BUYER_FINANCIALLY_VERIFIED',
  'new_approval'
)

// DISENGAGED reengagement
const reengagement = await validateDisengagedReengagement({
  contactId: 'abc-123',
  trigger: 'buyer_initiated',
  userId: 'agent-456',
  userRole: 'agent',
  source: 'buyer',
})
```

### Using SLA Metadata

```typescript
import { 
  emitSLAExpectationMetadata,
  checkSLABreach 
} from '@/lib/buyer-lifecycle/extensions/sla-metadata'

// On state transition
await emitSLAExpectationMetadata({
  contactId: 'abc-123',
  state: 'BUYER_FINANCIALLY_VERIFIED',
  userId: 'agent-456',
})

// Check for breach
const breach = await checkSLABreach({
  contactId: 'abc-123',
  state: 'BUYER_FINANCIALLY_VERIFIED',
  slaType: 'search_configuration',
  transitionDate: new Date('2025-01-01'),
})
```

### Using Contact Sync

```typescript
import { 
  emitContactLifecycleSync,
  checkContactSyncStatus 
} from '@/lib/buyer-lifecycle/extensions/contact-lifecycle-sync'

// Emit sync signal
await emitContactLifecycleSync({
  contactId: 'abc-123',
  buyerState: 'BUYER_UNDER_CONTRACT',
  userId: 'agent-456',
})

// Check sync status
const syncStatus = await checkContactSyncStatus('abc-123')
if (syncStatus.syncNeeded) {
  // Emit missing sync
}
```

---

## Next Steps

System 5.1D is **production-ready** and can be integrated with:
- System 5.1A/5.1B (Property Search & Matching)
- System 5.1C (Buyer Lifecycle Core)
- System 5.2 (Listing Lifecycle)
- Phase 3 Workflow Orchestration (executes signals)

**Phase 3 Integration:**
- Workflow systems will listen for signals and execute actions
- SLA enforcement will be handled by orchestration
- Contact sync will update CRM views
- Expiration transitions will be executed

---

## Summary

System 5.1D successfully hardens buyer lifecycle governance with 7 production-ready extensions spanning 1,990 lines of code. All extensions are additive, event-driven, and fully compliant with schema constraints. The system is ready for immediate production use.
