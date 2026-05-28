# System 5.3: CMA & Listing Presentation Engine

## Purpose

Generate seller-ready CMA, net sheet, listing presentation, and presentation video artifacts **without advancing journey state**, without managing drip delivery, and without modifying lifecycle logic.

System 5.3 produces decision-quality artifacts that System 5.2 (Seller Listing Lifecycle) consumes.

---

## Hard Constraints (Non-Negotiable)

### ❌ DOES NOT

- Advance seller journey
- Manage drip delivery
- Decide MLS readiness
- Store journey or lifecycle state
- Create or modify database schema
- Bypass CMA quality requirements

### ✅ DOES

- Emit completion signals ONLY via `activities` table
- Seller-personalize outputs using `contact` + `listings` data
- Follow state appraisal guidelines with mandatory disclaimer
- Emit quality metadata with every CMA

---

## Tables Used

**Read/Write:**
- `activities` - All lifecycle event emissions

**Read-Only:**
- `listings` - Property data
- `contacts` - Seller personalization data

---

## Execution Scope (STRICT)

### 1️⃣ CMA Generation

**What it does:**
- Fetches comparable sales from MLS/IDX (simulated in current implementation)
- Enforces minimum quality standards:
  - ≥ 5 comparables
  - ≤ 90 days old
  - Geographic & property-type relevance
- Includes **MANDATORY appraisal disclaimer**
- Generates seller-personalized commentary

**Events emitted:**
- `seller.cma.started`
- `seller.cma.completed` (with quality metadata)
- `seller.cma.failed` (if quality checks fail)

**Mandatory Disclaimer:**
```
This Comparative Market Analysis (CMA) is provided for informational purposes only 
and is not an appraisal. An appraisal can only be performed by a licensed appraiser.
```

**Quality Score (0-100):**
- Based on comparable count, recency, and geographic radius
- Metadata emitted with every CMA

---

### 2️⃣ Net Sheet Calculation

**What it does:**
- Calculates seller proceeds for multiple scenarios:
  - Primary scenario (at list price)
  - Alternate scenario (custom price)
  - Conservative scenario (-5%)
  - Optimistic scenario (+5%)
- Includes all costs:
  - Commissions (listing + buyer)
  - Closing costs
  - Mortgage payoff
  - Property taxes, HOA fees
  - Repair credits, seller concessions
- Tracks validity/expiration (90 days)

**Events emitted:**
- `seller.net_sheet.started`
- `seller.net_sheet.completed` (with expiration metadata)

**Validity:**
- Net sheets expire after **90 days**
- Warning emitted when < 7 days remaining
- System 5.2 can gate on expired net sheets

---

### 3️⃣ Listing Presentation Assembly

**What it does:**
- Combines:
  - CMA summary
  - Net sheet scenarios
  - Brokerage marketing plan
  - Seller-personalized insights
- Contact-aware presentation (name, address, goals, equity context)

**Events emitted:**
- `seller.presentation.created`

**Personalization:**
- Uses contact first/last name
- References specific property address
- Includes custom message if provided
- Highlights property features

---

### 4️⃣ Presentation Video Coordination

**What it does:**
- Generates avatar/voice video inputs
- Uses seller-personalized script derived from presentation
- Calls existing video system (HeyGen integration)

**Events emitted:**
- `seller.presentation.video_generated`

**Integration:**
- Uses the canonical `app/actions/video/create-video-project.ts` (provider resolved by `resolveVideoProvider` — D-ID default)
- Creates a "listing_tour" video project in `draft` for the agent to confirm avatar/voice and submit
- 2-minute duration, horizontal format

---

### 5️⃣ Decision Readiness Signal

**When all artifacts are complete:**
- Emits: `seller.decision.ready`
- This signal is consumed by System 5.2
- System 5.3 **does not** advance the journey

---

## Usage Examples

### Example 1: Generate Complete Presentation

```typescript
import { generateCompletePresentation } from "@/app/actions/cma-presentation"

const result = await generateCompletePresentation({
  listingId: "uuid-123",
  contactId: "uuid-456",
  agentId: "uuid-789",
  brokerageId: "uuid-brokerage",
  
  // CMA parameters
  salePrice: 450000,
  radiusMiles: 2.0,
  maxAgeDays: 90,
  minComparables: 5,
  
  // Net sheet parameters
  mortgageBalance: 300000,
  commissionRate: 0.03,
  
  // Presentation options
  includeVideo: true,
  customMessage: "Thank you for considering our services!",
  highlightFeatures: [
    "Updated kitchen with granite countertops",
    "Spacious backyard with pool",
    "Close to top-rated schools"
  ]
})

if (result.success && result.readyForDecision) {
  console.log("All artifacts generated - seller can make decision")
}
```

### Example 2: Generate CMA Only

```typescript
import { generateCMA, CMA_DISCLAIMER } from "@/app/actions/cma-presentation"

const cmaResult = await generateCMA({
  listingId: "uuid-123",
  contactId: "uuid-456",
  agentId: "uuid-789",
  radiusMiles: 2.0,
  maxAgeDays: 90,
  minComparables: 5
})

if (cmaResult.success) {
  console.log(`CMA generated with quality score: ${cmaResult.qualityScore}`)
  console.log(`Found ${cmaResult.comparableCount} comparables`)
}
```

### Example 3: Generate Net Sheet with Multiple Scenarios

```typescript
import { generateNetSheet } from "@/app/actions/cma-presentation"

const netSheetResult = await generateNetSheet({
  listingId: "uuid-123",
  contactId: "uuid-456",
  agentId: "uuid-789",
  salePrice: 450000,
  alternatePrice: 425000,
  mortgageBalance: 300000,
  listingCommissionRate: 0.03,
  buyerCommissionRate: 0.03,
  closingCosts: 9000,
  propertyTaxes: 5000,
  hoaFees: 1200
})

if (netSheetResult.success && netSheetResult.scenarios) {
  for (const scenario of netSheetResult.scenarios) {
    console.log(`${scenario.scenarioName}: Net proceeds = $${scenario.netProceeds.toLocaleString()}`)
  }
}
```

### Example 4: Check Net Sheet Validity

```typescript
import { getNetSheetExpiration } from "@/app/actions/cma-presentation"

const expiration = await getNetSheetExpiration("uuid-123")

if (!expiration.isValid) {
  console.log("Net sheet has expired - needs regeneration")
} else if (expiration.needsRenewal) {
  console.log(`Net sheet expires in ${expiration.daysRemaining} days - consider renewal`)
}
```

---

## Integration with System 5.2

System 5.3 emits signals that System 5.2 consumes:

```typescript
// System 5.3 emits this when all artifacts are ready:
{
  type: "seller.decision.ready",
  listing_id: "uuid-123",
  contact_id: "uuid-456",
  user_id: "uuid-789",
  metadata: {
    presentation_id: "uuid-presentation",
    video_project_id: "uuid-video",
    has_all_artifacts: true
  }
}

// System 5.2 can then check readiness and allow transition to DECISION_MADE
```

---

## Quality Enforcement

### CMA Quality Requirements

**Minimum Standards:**
- ≥ 5 comparables (configurable)
- ≤ 6 months old (180 days)
- ≤ 2 miles radius

**Quality Score Calculation:**
- Starts at 100
- -10 points per missing comparable below minimum
- -5 points per month over 6 months for oldest comparable
- -10 points per mile over 2 miles for farthest comparable

**Minimum Score:** 0 (quality score cannot be negative)

### Net Sheet Validity

- **Validity Period:** 90 days from generation
- **Warning Threshold:** 7 days remaining
- **Renewal:** Must regenerate if expired

---

## Success Criteria

System 5.3 is complete when:

✅ CMA quality enforced and logged  
✅ Net sheet generated with expiration  
✅ Presentation assembled with seller personalization  
✅ Video generated via existing system  
✅ `seller.decision.ready` emitted  
✅ System 5.2 can proceed without modification

---

## File Structure

```
app/actions/cma-presentation/
├── index.ts                    # Main exports and orchestration
├── cma-generator.ts            # CMA generation with quality enforcement
├── net-sheet-calculator.ts     # Net sheet calculation with scenarios
├── presentation-assembler.ts   # Presentation assembly and video coordination
└── README.md                   # This file
```

---

## Schema Compliance

**ZERO schema modifications:**
- All data stored in `activities` table as event metadata
- No new tables created
- No new columns added
- No state stored outside activities

**Event-driven architecture:**
- Every action emits lifecycle events
- Events are consumed by System 5.2
- Events provide complete audit trail

---

## Production Readiness

✅ Input validation on all endpoints  
✅ Error handling with meaningful messages  
✅ Event emission for audit trail  
✅ Seller personalization throughout  
✅ Mandatory disclaimer enforcement  
✅ Quality scoring and metadata  
✅ Net sheet expiration tracking  
✅ Video integration via existing service  
✅ No journey state advancement  
✅ No schema modifications  

---

## Future Enhancements (Post-Schema Changes)

When schema changes are allowed:

1. **MLS/IDX Integration** - Real comparable data instead of simulated
2. **CMA Templates** - Branded CMA templates per brokerage
3. **Interactive Net Sheets** - Dynamic recalculation in UI
4. **Video Customization** - Avatar selection, voice options
5. **Analytics** - Track presentation open rates and decision timing
