# System 7.1B - Buyer Offer Compliance Rules

## Constitutional Rules (CANNOT be bypassed)

### 1. Financial Verification Gate
**Rule:** Buyer MUST have valid financial verification before ANY offer acceptance.

**Events Required:**
- `buyer.financial_verification.pre_approval` OR
- `buyer.financial_verification.proof_of_funds`

**Enforcement Point:**
- `handle-offer-response.ts` - Before emitting `buyer.offer.accepted_final`
- `convert-to-transaction.ts` - Before emitting `buyer.under_contract`

**Check Logic:**
```typescript
const hasFinancialVerification = await checkFinancialVerification(supabase, contactId)
if (!hasFinancialVerification) {
  return { success: false, error: "Financial verification required" }
}
```

### 2. Compliance Check Gate
**Rule:** Offer MUST pass compliance check before submission to seller.

**Events Required:**
- `buyer.offer.compliance.passed`

**Enforcement Point:**
- `submit-for-signature.ts` - Before emitting `buyer.offer.submitted_for_signature`

**Check Logic:**
```typescript
await runComplianceGate(supabase, offerId)
// This emits buyer.offer.compliance.passed or buyer.offer.compliance.failed
```

### 3. Multi-Offer Limit
**Rule:** Buyer can have max 3 PENDING offers at any time.

**Enforcement Point:**
- `create-offer.ts` - Before creating new draft

**Check Logic:**
```typescript
const pendingCount = await countPendingOffers(supabase, contactId)
if (pendingCount >= 3) {
  return { success: false, error: "Maximum 3 pending offers allowed" }
}
```

### 4. Duplicate Offer Prevention
**Rule:** Buyer cannot have multiple PENDING offers on same listing.

**Enforcement Point:**
- `create-offer.ts` - Before creating new draft

**Check Logic:**
```typescript
// `detectConflictingOffers` (lib/buyer-offer/lifecycle-event-map.ts) was deleted
// in wave 7. Its survivor is app/actions/buyer-offer/handle-multi-offer.ts:
// checkDuplicateOffer, which absorbed both of its capabilities and adds the
// tenant scope + session gate the deleted version had no notion of.
// `excludeOfferId` (3rd arg, optional) leaves the offer being amended out of
// the scan — an offer never conflicts with itself.
const dup = await checkDuplicateOffer(contactId, listingId)
if (dup.has_duplicate) {
  return { success: false, error: "Pending offer already exists for this listing" }
}
// dup.conflicting_offer_ids lists EVERY live offer, not just the first.
```

### 5. Under Contract Freeze
**Rule:** Once `buyer.under_contract` is emitted, offer lifecycle is FROZEN.

**Enforcement Point:**
- ALL modification actions must check for under_contract event

**Check Logic:**
```typescript
const underContract = await supabase
  .from("activities")
  .select("id")
  .eq("metadata->>offer_id", offerId)
  .eq("activity_type", "buyer.under_contract")
  .single()

if (underContract) {
  return { success: false, error: "Offer is under contract" }
}
```

## Advisory Rules (Can be overridden with justification)

### 6. Offer Expiration Warning
**Rule:** Offers should expire after 72 hours without response.

**Implementation:** Background job checks for stale PENDING offers and emits `buyer.offer.expired`

### 7. Provider Sync Required
**Rule:** Offer status should sync from provider webhooks.

**Implementation:** Webhook handler emits `buyer.offer.provider_status_synced` events

## Event Sequencing Rules

### Valid State Transitions:
```
DRAFT → PENDING → ACCEPTED → UNDER_CONTRACT (terminal)
                → REJECTED (terminal)
                → COUNTERED → PENDING (loop allowed)
                → EXPIRED (terminal)
                → WITHDRAWN (terminal)
```

### Prohibited Transitions:
- UNDER_CONTRACT → Any other state (frozen)
- WITHDRAWN → PENDING (cannot resurrect)
- EXPIRED → PENDING (must create new offer)

## Rollback Safety

### Allowed Rollbacks:
- DRAFT → (no rollback needed, just delete)
- PENDING → WITHDRAWN (via `rollback-offer.ts`)
- COUNTERED → REJECTED (via `respond-to-counter.ts`)

### Prohibited Rollbacks:
- UNDER_CONTRACT → Any state (frozen forever)
- ACCEPTED → PENDING (must withdraw entire offer)

## Provider Integration Rules

### 1. Credentials
- MUST use `platform_credentials` table
- NEVER use environment variables
- Each brokerage can have different provider

### 2. Fallback Behavior
- If provider API fails, log error but DO NOT block offer creation
- Emit `buyer.offer.provider_sync_failed` event
- Allow manual document upload as fallback

### 3. Webhook Processing
- All provider webhooks emit normalized events
- Format: `buyer.offer.provider_status_synced`
- Include metadata: `{ provider, external_id, new_status }`

## Audit Requirements

### Every Action Must Emit:
1. Primary lifecycle event
2. Compliance check event (if applicable)
3. Provider sync event (if applicable)

### Activity Metadata Requirements:
```typescript
{
  offer_id: string,
  contact_id: string,
  listing_id: string,
  provider?: string,
  external_id?: string,
  timestamp: string,
  user_id: string,
  reason?: string // for rollbacks
}
```

## Authority Matrix

| Action | Agent | Team Leader | Broker | Admin |
|--------|-------|-------------|--------|-------|
| Create Draft | ✓ | ✓ | ✓ | ✓ |
| Submit for Signature | ✓ | ✓ | ✓ | ✓ |
| Accept Counter | ✓ | ✓ | ✓ | ✓ |
| Withdraw Offer | ✓ | ✓ | ✓ | ✓ |
| Void Offer | ✗ | ✓ | ✓ | ✓ |
| Override Compliance | ✗ | ✗ | ✓ | ✓ |
| Bypass Financial Gate | ✗ | ✗ | ✗ | ✓ |

## Testing Checklist

- [ ] Cannot create offer without financial verification
- [ ] Cannot submit offer without compliance passing
- [ ] Cannot have more than 3 pending offers
- [ ] Cannot have duplicate pending offers on same listing
- [ ] Cannot modify offer after under_contract
- [ ] Status syncs from provider webhooks
- [ ] Rollback emits proper events
- [ ] All events logged to activities table
- [ ] No direct status column updates (sync only)
