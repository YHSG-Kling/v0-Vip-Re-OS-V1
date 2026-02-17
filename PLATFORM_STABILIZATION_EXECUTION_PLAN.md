# Platform Stabilization Execution Plan
**Version:** Production Correction Pass  
**Status:** IN PROGRESS  
**Target:** Remove ALL hardcoded business logic

## Files Requiring Refactoring

### 🔴 CRITICAL - Commission Rate Hardcodes (0.03, 0.06)
1. ✅ `/lib/brokerage/get-default-commission-structure.ts` - Helper created
2. ⏳ `/app/actions/offer-management.ts` - Lines 80, 160
3. ⏳ `/app/actions/transactions.ts`
4. ⏳ `/app/actions/analytics.ts`
5. ⏳ `/app/actions/calculators.ts`
6. ⏳ `/app/actions/cma-presentation/net-sheet-calculator.ts`
7. ⏳ `/lib/services/transaction-management.service.ts`
8. ⏳ `/lib/data/brokerKPIs.ts`
9. ⏳ `/app/actions/ai-predictions.ts`
10. ⏳ `/app/actions/ai-cma.ts`

### 🟡 State Fallback Removal (|| "TX")
1. ✅ `/lib/brokerage/get-required-state.ts` - Helper created
2. ⏳ `/app/actions/ai-predictions.ts`

### 🟢 SLA Deadline Hardcodes (48, 72, 168 hours)
1. ⏳ `/app/actions/offer-management.ts` - Line 29 (48 hours)
2. ⏳ Search for all deadline literals

### 🔵 Direct global_settings.additional_settings Reads
- ⏳ Search entire codebase
- ⏳ Replace with getBrokerageSettings()

### 🟣 activities → lifecycle_events Migration
- ⏳ Search for system lifecycle writes
- ⏳ Migrate to lifecycle_events table

## Helper Functions Created
✅ `/lib/brokerage/get-default-commission-structure.ts`  
✅ `/lib/brokerage/get-required-state.ts`  
✅ `/lib/brokerage/get-required-providers.ts`

## Refactoring Strategy

### For Commission Rates:
```typescript
// BEFORE
const commission = salePrice * 0.06

// AFTER
const structure = await getDefaultCommissionStructure(brokerageId)
const commission = salePrice * structure.default_buyer_agent_rate
```

### For State:
```typescript
// BEFORE
const state = lead.state || "TX"

// AFTER
const state = await getRequiredPrimaryState(brokerageId)
```

### For SLAs:
```typescript
// BEFORE
expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000)

// AFTER
const { pipeline_settings } = await getBrokerageSettings(brokerageId)
expires_at: new Date(Date.now() + pipeline_settings.offer_expiration_hours * 60 * 60 * 1000)
```

### For Events:
```typescript
// BEFORE
await supabase.from("activities").insert({
  activity_type: "buyer.offer.accepted",
  ...
})

// AFTER
await supabase.from("lifecycle_events").insert({
  event_type: "buyer.offer.accepted",
  entity_type: "offer",
  entity_id: offerId,
  ...
})
```

## Validation Checklist
- [ ] No hardcoded 0.03 or 0.06 commission rates
- [ ] No || "TX" or state fallbacks
- [ ] No hardcoded 48/72/168 hour deadlines
- [ ] No direct global_settings reads
- [ ] System events go to lifecycle_events
- [ ] All resolvers require brokerageId parameter
- [ ] No provider assumptions (Dotloop, QuickBooks)
- [ ] No closing entity assumptions (title company)

## Next Steps
1. Refactor offer-management.ts (commission + SLA)
2. Refactor all calculator files (commission + property tax)
3. Refactor analytics files (commission)
4. Search and fix any remaining hardcodes
5. Create migration documentation
