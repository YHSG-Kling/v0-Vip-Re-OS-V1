export { PartnerCommandStrip } from './partner-command-strip'
export { VendorPerformanceRadar } from './vendor-performance-radar'
export { ReferralTrackingPanel } from './referral-tracking-panel'
export { LenderStatusPanel } from './lender-status-panel'
export { TitlePipelinePanel } from './title-pipeline-panel'
export { VendorSlaPanel } from './vendor-sla-panel'
// TOMBSTONE (orphan doctrine §1.1, lane R3-B 2026-09-03): VendorDirectoryPanel
// (./vendor-directory-panel.tsx, DELETED) was a duplicate, not an orphan — the
// barrel's sole importer, app/dashboard/vendors/page.tsx, rendered the other
// seven panels and never this one. There is NO /dashboard/partners page.
// Survivor: VendorDirectoryClient (app/dashboard/vendors/vendor-directory-client.tsx),
// mounted at app/dashboard/vendors/page.tsx:419 (`<VendorDirectoryClient`, at
// 37f24060; :449 once lane R3-C's ?vendor= work lands) on the default
// "marketplace" tab — a strict superset (every brokerage vendor with book / edit / review /
// assign actions). Retired with it: the panel's getCategoryColor 5-value switch
// (lender / title / inspector / photographer / contractor) against the live
// 38-value vendors.category vocabulary — the §6 defect the survivor already
// fixes with categoryLabel over VENDOR_CATEGORY_LABELS.
//
// CARRIED FORWARD from the deleted file's :136-143 (dangling-link sweep,
// 2026-09-02): its per-vendor rows linked to `/dashboard/vendors/${id}` —
// app/dashboard/vendors has no [vendorId] child (page.tsx + panels only) and
// no page reads a ?vendor= query — so they were repointed to the bare
// /dashboard/vendors. A per-vendor deep link (`?vendor=<id>` opening that
// vendor's row on the marketplace tab: page.tsx takes searchParams { vendor? },
// passes initialVendorId into VendorDirectoryClient at :419) is the missing
// half and remains unbuilt — wave-26 brief item 12b.
export { AiVendorInsightsPanel } from './ai-vendor-insights-panel'
