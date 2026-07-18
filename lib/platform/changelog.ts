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
