/**
 * System 5.3: CMA & Listing Presentation Governance Engine
 * 
 * GOVERNANCE ONLY system for seller decision readiness prior to listing activation.
 * 
 * ## Core Responsibilities
 * 
 * - Govern CMA readiness and quality
 * - Govern net sheet readiness and validity
 * - Govern presentation and video readiness
 * - Govern seller decision signals
 * - Emit auditable events and SLA metadata
 * 
 * ## Architecture
 * 
 * ```
 * decision-state-definitions.ts    → 8 canonical decision states
 * cma-quality-evaluator.ts         → CMA quality checks
 * net-sheet-validator.ts           → Net sheet validity checks
 * presentation-readiness.ts        → Presentation readiness checks
 * decision-readiness-engine.ts     → Orchestrates all checks
 * decision-logger.ts               → Event emission to activities
 * ```
 * 
 * ## Decision States (Non-Linear)
 * 
 * 1. **SELLER_CMA_REQUIRED** - Seller requires CMA before decision
 * 2. **SELLER_CMA_READY** - CMA completed and approved
 * 3. **SELLER_NET_SHEET_READY** - Net sheet generated and valid
 * 4. **SELLER_PRESENTATION_ASSEMBLED** - Presentation materials ready
 * 5. **SELLER_PRESENTATION_VIDEO_READY** - Custom video ready
 * 6. **SELLER_DECISION_READY** - All materials ready, awaiting decision
 * 7. **SELLER_DECISION_DEFERRED** - Seller deferred decision
 * 8. **SELLER_DECISION_DECLINED** - Seller declined to list
 * 
 * States may progress in parallel (e.g., CMA and presentation can be ready independently).
 * 
 * ## CMA Governance
 * 
 * CMA readiness requires:
 * - Minimum comparable count (default: 3)
 * - Recency threshold (default: 6 months)
 * - Radius coverage (default: 2 miles)
 * - Agent OR broker approval
 * 
 * Example:
 * ```typescript
 * import { evaluateCMAQuality } from '@/lib/seller-decision-governance/cma-quality-evaluator'
 * 
 * const result = await evaluateCMAQuality({
 *   listingId: "uuid",
 *   comparableCount: 5,
 *   oldestComparableMonths: 4,
 *   maxRadiusMiles: 1.5,
 *   agentApproved: true,
 * })
 * 
 * console.log(result.isReady) // true/false
 * console.log(result.qualityScore) // 0-100
 * ```
 * 
 * ## Net Sheet Governance
 * 
 * Net sheets have a defined validity window (default: 30 days).
 * 
 * Expired net sheets:
 * - Block SELLER_DECISION_READY
 * - Emit seller.net_sheet.expired event
 * - Require regeneration or override
 * 
 * Example:
 * ```typescript
 * import { validateNetSheetValidity } from '@/lib/seller-decision-governance/net-sheet-validator'
 * 
 * const result = validateNetSheetValidity({
 *   listingId: "uuid",
 *   generatedAt: new Date('2024-01-01'),
 * })
 * 
 * console.log(result.isValid) // true/false
 * console.log(result.daysRemaining) // e.g., 15
 * ```
 * 
 * ## Presentation Governance
 * 
 * Presentation readiness is independent of CMA.
 * 
 * Presentation drip sequences:
 * - May start at SELLER_PRESENTATION_ASSEMBLED
 * - Must pause on DECISION_READY or DECLINED
 * - May continue through DEFERRED
 * 
 * Example:
 * ```typescript
 * import { evaluatePresentationReadiness } from '@/lib/seller-decision-governance/presentation-readiness'
 * 
 * const result = evaluatePresentationReadiness({
 *   listingId: "uuid",
 *   presentationAssembled: true,
 *   presentationVideoReady: true,
 *   currentDecisionState: "SELLER_PRESENTATION_ASSEMBLED",
 * })
 * 
 * console.log(result.dripSequenceAllowed) // true/false
 * ```
 * 
 * ## Decision Readiness
 * 
 * SELLER_DECISION_READY requires:
 * - CMA_READY
 * - NET_SHEET_READY (not expired)
 * - PRESENTATION_ASSEMBLED
 * 
 * Example:
 * ```typescript
 * import { evaluateDecisionReadiness } from '@/lib/seller-decision-governance/decision-readiness-engine'
 * 
 * const result = await evaluateDecisionReadiness({
 *   listingId: "uuid",
 *   targetState: "SELLER_DECISION_READY",
 * })
 * 
 * console.log(result.isReady) // true/false
 * console.log(result.blockers) // ["CMA not ready", ...]
 * ```
 * 
 * ## Multi-Listing Support
 * 
 * Each listing maintains independent decision readiness.
 * Contact-level journeys use highest-priority listing only.
 * 
 * ## Decision Reversal
 * 
 * Seller may reverse decision prior to MLS ACTIVE.
 * 
 * Reversal emits:
 * - seller.decision.reversed event
 * - Rollback cascade signals
 * 
 * After MLS ACTIVE, defer to listing lifecycle governance.
 * 
 * Example:
 * ```typescript
 * import { validateDecisionReversal } from '@/lib/seller-decision-governance/decision-readiness-engine'
 * 
 * const result = validateDecisionReversal(
 *   "SELLER_DECISION_READY",
 *   "LISTING_PRESENTATION_CREATED"
 * )
 * 
 * console.log(result.allowed) // true/false
 * ```
 * 
 * ## Agent Override Authority
 * 
 * Overrides must be explicit and auditable.
 * 
 * Agent overrides:
 * - Limited scope
 * - Require reason
 * - Expire unless reaffirmed
 * 
 * Broker or team leader overrides:
 * - Full authority
 * 
 * Example:
 * ```typescript
 * const result = await evaluateCMAQuality({
 *   listingId: "uuid",
 *   comparableCount: 2, // Below threshold
 *   overrideByRole: "broker",
 *   overrideReason: "Rural market - limited comparables available",
 * })
 * 
 * console.log(result.wasOverridden) // true
 * ```
 * 
 * ## Event Emission (Mandatory)
 * 
 * All state changes emit events to activities table:
 * 
 * - seller.decision.transition
 * - seller.cma.quality_verified
 * - seller.net_sheet.generated
 * - seller.net_sheet.expired
 * - seller.presentation.assembled
 * - seller.presentation_video.ready
 * - seller.decision.reversed
 * 
 * Example:
 * ```typescript
 * import { logDecisionTransition } from '@/lib/seller-decision-governance/decision-logger'
 * 
 * await logDecisionTransition({
 *   listing_id: "uuid",
 *   from_state: "SELLER_CMA_READY",
 *   to_state: "SELLER_DECISION_READY",
 *   authority_role: "agent",
 * })
 * ```
 * 
 * ## SLA Metadata
 * 
 * SLA expectations are metadata only - NOT enforced by this system.
 * 
 * Example SLA expectations:
 * - CMA_REQUIRED → CMA_READY: 48 hours
 * - CMA_READY → DECISION_READY: 72 hours
 * - DECISION_READY → Decision Made: 7 days
 * 
 * ## Server Actions (Public API)
 * 
 * Located in: `/app/actions/seller-decision-governance.ts`
 * 
 * Available actions:
 * 1. `evaluateSellerDecisionReadiness()` - Evaluate target state readiness
 * 2. `checkSellerDecisionReady()` - Quick DECISION_READY check
 * 3. `evaluateListingCMAQuality()` - Evaluate CMA quality
 * 4. `checkCMAReady()` - Quick CMA ready check
 * 5. `validateListingNetSheetValidity()` - Validate net sheet
 * 6. `checkNetSheetValid()` - Quick net sheet check
 * 7. `evaluateListingPresentationReadiness()` - Evaluate presentation
 * 8. `checkPresentationReady()` - Quick presentation check
 * 9. `validateSellerDecisionReversal()` - Validate reversal
 * 10. `logSellerDecisionTransition()` - Log state transition
 * 11. `logCMAQuality()` - Log CMA quality verification
 * 12. `logNetSheetActivity()` - Log net sheet event
 * 13. `logPresentationActivity()` - Log presentation event
 * 14. `logSellerDecisionReversal()` - Log reversal
 * 15. `getSellerDecisionHistory()` - Query history
 * 16. `getSellerDecisionStates()` - Get all state definitions
 * 17. `getMilestoneDecisionStates()` - Get milestone states
 * 18. `getDecisionStateDefinition()` - Get single state definition
 * 
 * ## Integration Points
 * 
 * This system integrates with:
 * - **System 5.2** (Listing Lifecycle) - Validates against listing stage
 * - **System 4.1** (Content Generation) - Provides readiness gates
 * - **System 4.3** (Approval Workflow) - Validates authority
 * - **Phase 3 Orchestration** - Emits signals for workflows
 * 
 * ## Explicit Exclusions
 * 
 * This system DOES NOT:
 * - Calculate CMAs
 * - Submit to MLS
 * - Create media
 * - Sign documents
 * - Execute marketing
 * - Render journey UI
 * 
 * ## Schema Compliance (STRICT)
 * 
 * - **Read:** listings, activities
 * - **Write:** activities table ONLY
 * - **Forbidden:** All schema modifications, new tables, new columns
 * 
 * ## Production Readiness
 * 
 * ✅ Zero schema changes
 * ✅ Event-driven architecture
 * ✅ Governance only (no execution)
 * ✅ Fully auditable
 * ✅ Multi-listing support
 * ✅ Override authority tracking
 * ✅ SLA metadata emission
 * ✅ Comprehensive error handling
 * ✅ Input validation
 * ✅ Type safety
 * 
 * ## Next Steps
 * 
 * 1. Connect to System 5.2 for listing stage validation
 * 2. Connect to Phase 3 orchestration for workflow triggering
 * 3. Add brokerage-level policy customization
 * 4. Implement SLA breach alerting (external system)
 * 5. Add dashboard widgets for decision tracking
 */
