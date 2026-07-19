// lib/platform/changelog.ts
// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT CHANGELOG — "what your AI team learned to do" — the tenant-facing
// release notes the platform never had. Distinct from the per-tenant
// intelligence report (what YOUR data taught YOUR managers): this is the
// PRODUCT's shipped capabilities, the same for every tenant.
//
// Config-driven and shipped WITH the release (in-repo, no table): a changelog
// entry describes code, so it belongs next to the code and rides the same
// deploy — the honest way to guarantee notes never describe features a tenant
// doesn't have yet. Entries are curated by hand per release wave; newest first.
// Rendered on /dashboard/whats-new.

export interface ChangelogEntry {
  /** ISO date of the release wave (YYYY-MM-DD). */
  date: string
  title: string
  /** Product area chip, e.g. "Billing", "AI Managers". */
  area: string
  /** What shipped — tenant-facing language, one capability per point. */
  points: string[]
}

/** Newest-first product changelog. Append a new entry per release wave. */
export const PRODUCT_CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-07-19",
    title: "Your AI team through the anxious middle of a deal",
    area: "Deals & Sellers",
    points: [
      "Sellers on a live deal now get their own weekly status note — the same grounded facts as the buyer side, reframed for the seller, and never a duplicate of the listing-activity update.",
      "When an appraisal comes in low, buyer and seller each get a calm, specific portal update with the real paths forward — and your agent gets a pre-emptive appraiser packet plus a negotiation copilot.",
      "Inspection completion now posts to both buyer and seller portals the moment it's recorded — no more waiting for the weekly note to hear the deal's most anxious milestone landed.",
      "Sellers can share their home's marketing to their own social channels straight from the portal, and that share activity now feeds a measured ROI story in your intelligence report.",
      "A quick pulse survey occasionally appears on your dashboard — when you tell us it's not going well, a human follows up.",
    ],
  },
  {
    date: "2026-07-19",
    title: "The OS becomes a platform: webhooks, API tokens, your own domain, SSO",
    area: "Integrations & Identity",
    points: [
      "Outbound webhooks: subscribe to lead, contact, listing, offer, and deal events — every delivery is HMAC-signed, retried on failure, and shown in an honest delivery log (Settings → Developers).",
      "Self-serve API tokens scoped to your brokerage, minted with explicit permissions you choose (Brokerage and Multi-Location plans).",
      "Connect your own domain to your client-facing site: you get the exact DNS records to set, and the connection status is tracked honestly until it's live.",
      "Brokerage plan: SAML single sign-on setup from Settings → Users — the connection card walks through your identity provider and shows honest status at every step.",
    ],
  },
  {
    date: "2026-07-18",
    title: "Billing you can run yourself — and a straight answer on platform status",
    area: "Billing & Transparency",
    points: [
      "Manage billing self-serve: update your card, download invoices, and review charges through the secure Stripe billing portal (Billing → Manage billing).",
      "Changing plans no longer requires a support ticket — upgrades are self-serve from Settings → Billing.",
      "If you decide to cancel, you'll see any active retention offer before confirming — no phone-call-to-cancel games.",
      "This page: platform status and product release notes, in one place.",
    ],
  },
  {
    date: "2026-07-01",
    title: "Support with teeth, and a platform that watches itself",
    area: "Support & Reliability",
    points: [
      "Support tickets now carry response-time targets (SLA timers) and a one-tap satisfaction rating once resolved.",
      "Connection health monitoring watches every integration (email, phone, calendar, MLS) and flags a broken connector before it silently drops your follow-up.",
      "Go-live readiness checks verify your account is actually wired — sending domains, phone numbers, calendar — before your AI team starts working leads.",
    ],
  },
  {
    date: "2026-06-15",
    title: "Fairer money mechanics",
    area: "Billing",
    points: [
      "14-day free trials on every plan — no credit card required to start.",
      "Discount codes: a coupon applied to your account shows up on your Stripe invoice, not just a promise in an email.",
      "Past-due handling is now a communicated ladder (reminders before restrictions) instead of a surprise lockout.",
      "Leaving? Your data leaves with you — a full account export is available at offboarding.",
    ],
  },
]

/** Entries sorted newest-first (defensive re-sort; the array is hand-ordered). */
export function changelogEntries(): ChangelogEntry[] {
  return [...PRODUCT_CHANGELOG].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/** ISO date of the most recent entry; null when the changelog is empty. */
export function latestChangelogDate(): string | null {
  const entries = changelogEntries()
  return entries.length > 0 ? entries[0].date : null
}
