# Platform Stabilization Status

## ✅ Phase 1: Core Helper Functions (COMPLETE)

All 3 helper functions created and operational:

1. ✅ **get-default-commission-structure.ts** (143 lines) - Eliminates 0.03/0.06 hardcodes
2. ✅ **get-required-state.ts** (38 lines) - Eliminates TX/California fallbacks  
3. ✅ **get-required-providers.ts** (38 lines) - Eliminates Dotloop/QuickBooks assumptions

## ⚠️ Phase 2: Refactor Hardcoded Files (IN PROGRESS)

### Files Refactored (1/14)

1. ✅ **app/actions/offer-management.ts**
   - Lines 44, 98, 192: Replaced 0.06 with `getDefaultCommissionStructure()`
   - Line 31: Replaced 48-hour hardcode with `getOfferExpirationHours()`
   - Added brokerageId validation in all affected functions

### Files Remaining (13/14)

2. ⏳ **app/actions/calculators.ts** (5 hardcodes)
   - Line 44: `agent_commission: data.homeValue * 0.06`
   - Line 716: `closing_costs: Math.round(maxHomePrice * 0.03)`
   - Line 747: `appreciationRate = 0.03`
   - Line 765: `homePrice * 0.03` (closing costs)
   - Line 782: `homeValueAfterYears * 0.06` (commission)

3. ⏳ **app/actions/cma-presentation/net-sheet-calculator.ts** (2 hardcodes)
   - Line 167: `listingCommissionRate || 0.03`
   - Line 168: `buyerCommissionRate || 0.03`

4. ⏳ **app/actions/transactions.ts** (1 hardcode)
   - Line 2474: `estimatedCommission = totalValue * 0.03`

5. ⏳ **app/actions/analytics.ts** (1 hardcode)
   - Line 272: `monthlyGCI calculation with 0.03`

6. ⏳ **app/actions/ai-predictions.ts** (1 hardcode)
   - Line 1603: `estimated_commission: gain.equityGain * 0.06 * 0.5`

7. ⏳ **app/actions/ai-cma.ts** (1 hardcode)
   - Line 440: `rangeMultiplier = 0.03`

8. ⏳ **lib/services/transaction-management.service.ts** (1 hardcode)
   - Line 304: `commissionRate || 0.03`

9. ⏳ **lib/data/brokerKPIs.ts** (2 hardcodes)
   - Line 76: `listing.commission_rate || 0.03`
   - Line 159: `listing.commission_rate || 0.03`

10-14. Documentation files (do not require refactoring):
   - app/actions/cma-presentation/README.md (examples only)
   - lib/vendor-governance/cost-normalizer.ts (external vendor cost, not brokerage)
   - lib/external/batchdata-client.ts (external API mock)
   - scripts/335-create-agents-table.sql (schema comment)
   - PLATFORM_STABILIZATION_EXECUTION_PLAN.md (documentation)

## Critical Next Steps

1. **Complete remaining 8 code file refactors** (calculators.ts, net-sheet-calculator.ts, transactions.ts, etc.)
2. **Add brokerageId parameter** to all affected functions
3. **Update function signatures** to accept brokerageId where missing
4. **Add error handling** for missing brokerage configuration
5. **Run tests** to verify no regressions

## Refactoring Pattern (Copy-Paste Template)

```typescript
// 1. Add import at top of file
import { getDefaultCommissionStructure } from "@/lib/brokerage/get-default-commission-structure"

// 2. Get brokerageId early in function
const { data: profile } = await supabase
  .from("profiles")
  .select("brokerage_id")
  .eq("id", userId)
  .single()

const brokerageId = profile?.brokerage_id
if (!brokerageId) {
  return { success: false, error: "User brokerage not found" }
}

// 3. Get commission structure
const commissionStructure = await getDefaultCommissionStructure(brokerageId)

// 4. Replace hardcode
// BEFORE: const commission = salePrice * 0.06
// AFTER:  const commission = salePrice * (commissionStructure.totalBuyerSideRate + commissionStructure.totalListingSideRate)
```

## Estimated Time Remaining

- 8 code files × 15 minutes average = **2 hours**
- Testing and verification = **1 hour**
- **Total: ~3 hours to complete Phase 2**

## Success Criteria

- [ ] All 14 code files refactored
- [ ] Zero `0.03` or `0.06` commission hardcodes in production code
- [ ] All functions validate brokerageId before processing
- [ ] Error messages guide users to configure missing settings
- [ ] All tests passing
- [ ] Documentation updated
