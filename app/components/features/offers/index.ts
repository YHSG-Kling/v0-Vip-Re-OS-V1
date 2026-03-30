/**
 * app/components/features/offers/index.ts
 *
 * Barrel export for all offer OS feature components.
 *
 * Ownership rules:
 *   - Data loading: lib/kernel/offers.ts kernel commands
 *   - Mutations:    app/actions/listings-kernel.ts / app/actions/buyer-offers.ts
 *   - Comparison:   offer_comparison table (listing_id, offer_ids, comparison_matrix)
 *   - Counter hist: offers table (parent_offer_id, offer_type='counter', current_round)
 *   - No "use server" in any of these files — they are client components
 */

export { OfferWorkspace }       from "./offer-workspace"
export { CounterOfferHistory }  from "./counteroffer-history"
export { NetSheetView }         from "./net-sheet-view"
export { OfferDocumentPanel }   from "./offer-document-panel"
export { OfferComparisonView }  from "./offer-comparison-view"
