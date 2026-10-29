/**
 * scripts/ui-journeys.ts — the ONE product-journey vocabulary of the UI guards.
 * ─────────────────────────────────────────────────────────────────────────────
 * Moved VERBATIM out of scripts/ui-wiring-census-guard.ts (wave 146, lane 146H) so a second guard
 * (scripts/ui-palette-contrast-guard.ts, scripts/ui-capability-surface-audit.ts) can report per journey
 * without importing the census — whose module body RUNS the census — and without re-spelling the list
 * (CLAUDE.md §6: one vocabulary per function). The census imports and re-exports both names, so every
 * reader of `JOURNEYS` / `journeyOf` from the census keeps working unchanged.
 */
/** Wave 142 (lane 142H): EVERY product journey — a dead surface or a mobile hard-zero hit anywhere here is
 *  P0/P1 and fails. Prefixes may overlap (the CDA pages sit under transactions); a file reports under its
 *  LONGEST matching prefix. The wave-141 paths are all inside. */
export const JOURNEYS: Record<string, string[]> = {
  "subscriber onboarding": ["app/signup", "app/get-started", "app/login", "app/onboarding", "app/dashboard/onboarding", "app/dashboard/getting-started", "app/pricing"],
  "users, seats & teams": ["app/dashboard/admin/users", "app/settings/users", "app/dashboard/settings/team", "app/dashboard/settings/teams", "app/vendor-invite", "app/dashboard/team", "app/dashboard/teams"],
  "buyer / seller CRM": ["app/crm", "app/dashboard/buyers", "app/dashboard/sphere", "app/sphere", "app/past-clients", "app/lifetime-customers", "app/dashboard/buyer-broker-agreements", "app/dashboard/showings", "app/showings", "app/dashboard/cma", "app/dashboard/open-house", "app/dashboard/open-houses", "app/open-house", "app/dashboard/tasks", "app/tasks", "app/dashboard/calendar", "app/calendar", "app/components/contact"],
  "lead acquisition": ["app/leads", "app/dashboard/acquisition", "app/dashboard/marketing/lead-magnets", "app/lm", "app/qr", "app/home-value", "app/dashboard/tools/home-value", "app/buyer-intake", "app/widget", "app/embed", "app/dashboard/agent/qr-codes", "app/dashboard/agent/business-cards", "app/dashboard/admin/lead-intake", "app/components/features/lead-magnets"],
  "listings": ["app/dashboard/listings", "app/listings", "app/listing", "app/dashboard/listing-appointments", "app/properties", "app/components/dashboard/listings", "app/components/listings", "app/components/listing-landing"],
  "offers": ["app/offers", "app/dashboard/offers"],
  "transactions & closing": ["app/transactions", "app/dashboard/transactions", "app/transaction", "app/title", "app/components/transactions", "app/components/coordinator", "app/dashboard/coordinator"],
  "legal forms & e-sign": ["app/components/form-wizard", "app/dashboard/forms", "app/forms", "app/dashboard/admin/forms", "app/dashboard/admin/transaction-forms", "app/dashboard/documents", "app/documents", "app/components/forms", "app/components/shared/SendForSignaturesPanel.tsx"],
  "CDA & commissions": ["app/dashboard/transactions/[id]/cda", "app/dashboard/financials", "app/financials", "app/dashboard/income-truth", "app/dashboard/admin/fees"],
  "compliance": ["app/dashboard/compliance", "app/compliance", "app/approvals", "app/components/compliance", "app/dashboard/admin/compliance", "app/dashboard/admin/compliance-ledger"],
  "agents & vendors": ["app/dashboard/agent", "app/dashboard/vendors", "app/vendor", "app/dashboard/partners", "app/referral-partners", "app/recruiting", "app/dashboard/recruiting-roi", "app/dashboard/referrals", "app/referrals", "app/lender", "app/components/lender", "app/components/title", "app/dashboard/admin/agents", "app/dashboard/admin/vendor-approvals"],
  "AI ISA & communications": ["app/dashboard/ai-isa", "app/dashboard/isa", "app/dashboard/ai-tools", "app/dashboard/ai-quality", "app/dashboard/voice", "app/dashboard/voice-intelligence", "app/dashboard/chat", "app/dashboard/inbox", "app/dashboard/communications", "app/components/ai-copilot", "app/components/ai-identity", "app/components/shared/internal-ai-assistant.tsx", "app/components/shared/page-context-assistant.tsx", "app/components/layout/unified-inbox-slideout.tsx", "app/mobile", "app/video-assistant"],
  "marketing, media, books & video": ["app/dashboard/marketing", "app/dashboard/campaigns", "app/dashboard/social", "app/social-planner", "app/dashboard/content", "app/content-studio", "app/dashboard/video", "app/dashboard/videos", "app/newsletters", "app/v", "app/dashboard/admin/content-studio", "app/dashboard/admin/marketing-campaigns", "app/dashboard/admin/marketing-approvals", "app/dashboard/admin/campaign-center", "app/dashboard/admin/asset-manager-actions", "app/dashboard/admin/composition-library", "app/dashboard/admin/direct-mail-performance", "app/components/features/video", "app/components/video"],
  "portals": ["app/portal", "app/components/portal", "app/(external-portal)", "app/p"],
  "websites": ["app/site", "app/team", "app/components/settings/YourWebsiteCard.tsx", "app/dashboard/settings/branding", "app/dashboard/settings/embeds", "app/dashboard/settings/widget", "app/dashboard/marketing/video-pages", "app/dashboard/marketing/seo"],
  "settings": ["app/settings", "app/dashboard/settings", "app/dashboard/profile", "app/components/settings", "app/dashboard/admin/phone-settings", "app/dashboard/admin/locations", "app/dashboard/admin/brand"],
  "billing": ["app/dashboard/admin/billing", "app/settings/billing", "app/dashboard/admin/usage", "app/components/features/admin"],
  "support & help": ["app/dashboard/help", "app/support", "app/dashboard/admin/support-tickets", "app/dashboard/superadmin/support", "app/dashboard/support"],
  "education": ["app/academy", "app/dashboard/education", "app/dashboard/coaching", "app/dashboard/admin/education", "app/dashboard/admin/learning-modules", "app/dashboard/challenges", "app/dashboard/onboarding/training", "app/dashboard/onboarding/mentorship"],
  "managers & operations": ["app/dashboard/operations", "app/dashboard/coordination", "app/dashboard/intelligence", "app/dashboard/briefing", "app/dashboard/system", "app/dashboard/diagnosis", "app/dashboard/jobs", "app/workflows", "app/dashboard/goals", "app/dashboard/admin/command-center", "app/dashboard/admin/approvals", "app/dashboard/admin/automations", "app/dashboard/admin/cron-health", "app/dashboard/admin/data-health", "app/dashboard/admin/manager-trust", "app/dashboard/admin/sla-monitor", "app/dashboard/admin/tenant-safety", "app/dashboard/admin/provider-intelligence", "app/dashboard/admin/system", "app/dashboard/superadmin", "app/dashboard/brokerage", "app/dashboard/patterns"],
  "reports": ["app/dashboard/reports", "app/dashboard/reporting", "app/dashboard/analytics", "app/analytics", "app/dashboard/insights", "app/dashboard/intelligence-report", "app/dashboard/market-insights", "app/dashboard/leaderboard", "app/dashboard/agent/roi", "app/dashboard/admin/agent-scorecard", "app/dashboard/wealth"],
}
/** True when repo-relative path `f` is `p` or lives under it. */
export const underPrefix = (f: string, p: string) => f === p || f.startsWith(p + "/")
/** The journey a file reports under — its LONGEST matching prefix; null outside every journey. */
export function journeyOf(f: string): string | null {
  let best: { name: string; len: number } | null = null
  for (const [name, prefixes] of Object.entries(JOURNEYS)) for (const p of prefixes) if (underPrefix(f, p) && (!best || p.length > best.len)) best = { name, len: p.length }
  return best?.name ?? null
}
