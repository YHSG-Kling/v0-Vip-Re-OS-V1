// lib/transactions/milestone-identity.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE canonical milestone-identity resolver.
//
// A milestone row carries a free-text `milestone_name` ("Home Inspection",
// "Closing Day", "Final Walk-Through") that varies across thousands of subscription
// tiers, and a `milestone_type` that the kernel intends to hold a STABLE canonical
// identity but which, on un-backfilled live data, is null or a coarse category.
//
// Every contact-facing education/label/explanation/responsible-party map is keyed by
// a canonical snake_case identity (earnest_money_due, inspection_deadline,
// closing_date, …). Looking those maps up by the free-text name silently misses on
// live data — so the per-milestone education, the milestone-gated module unlock, and
// the journey timeline copy all quietly no-op. This resolver is the single bridge:
// it maps ANY milestone row to its canonical identity, so the sophisticated
// age-channel delivery + persona supplement machinery actually engages.
//
// Resolution order (first hit wins):
//   1. milestone_type, when it already holds a canonical identity (post-backfill).
//   2. milestone_name, when it is already a canonical snake_case identity.
//   3. an explicit alias for a known seed/legacy human name.
//   4. ordered keyword rules over the normalized name (scales to tier variants).
//   5. null — no canonical anchor (e.g. "Title Search Complete"); callers degrade
//      gracefully (show the raw name, no lesson) rather than mis-anchoring.
//
// Pure module — no DB, no server-only. Safe to import from client components,
// the kernel, the education layer, and simulators alike.

/** The canonical milestone identities education/labels/explanations key on. */
export const CANONICAL_MILESTONE_IDS = [
  // buyer + shared transaction identities
  "offer_submitted",
  "offer_accepted",
  "earnest_money_due",
  "inspection_scheduled",
  "inspection_deadline",
  "inspection_completed",
  "appraisal_ordered",
  "appraisal_deadline",
  "appraisal_completed",
  "financing_deadline",
  "loan_approved",
  "clear_to_close_received",
  "final_walkthrough_scheduled",
  "closing_scheduled",
  "closing_date",
  "closed",
  // seller-side identities
  "listing_live",
  "first_showing",
  "offer_received",
  "under_contract",
  "inspection_period",
  "appraisal",
  "closing_prep",
] as const

export type CanonicalMilestoneId = (typeof CANONICAL_MILESTONE_IDS)[number]

const CANONICAL_SET = new Set<string>(CANONICAL_MILESTONE_IDS)

/** Lowercase, collapse non-alphanumerics to single spaces, trim. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * Explicit aliases for the human names produced by the live seed
 * (lib/application/transactions.ts generateMilestones) and the legacy variants
 * already present in transaction_milestones. Keys are NORMALIZED names.
 */
const NAME_ALIASES: Record<string, CanonicalMilestoneId> = {
  // ── buyer seed names ──
  "offer submitted": "offer_submitted",
  "offer accepted": "offer_accepted",
  "earnest money deposited": "earnest_money_due",
  "earnest money received": "earnest_money_due",
  "home inspection scheduled": "inspection_scheduled",
  "home inspection complete": "inspection_completed",
  "home inspection completed": "inspection_completed",
  "home inspection": "inspection_deadline",
  "buyer inspection complete": "inspection_completed",
  "repair negotiations complete": "inspection_deadline",
  "repair request addressed": "inspection_deadline",
  "appraisal ordered": "appraisal_ordered",
  "appraisal complete": "appraisal_completed",
  "appraisal completed": "appraisal_completed",
  "loan approved": "loan_approved",
  "loan approval": "loan_approved",
  "buyer financing approved": "loan_approved",
  "title search complete": "closing_prep",
  "title clear": "closing_prep",
  "final walkthrough": "final_walkthrough_scheduled",
  "final walk through": "final_walkthrough_scheduled",
  "clear to close": "clear_to_close_received",
  "closing scheduled": "closing_scheduled",
  "closing documents signed": "closing_date",
  "closing day": "closing_date",
  "funds transferred": "closing_date",
  "funds received": "closing_date",
  "keys received": "closed",
  "keys delivered": "closed",
  // ── seller seed names ──
  "listing agreement signed": "listing_live",
  "property listed": "listing_live",
  "offer received": "offer_received",
}

/**
 * Ordered keyword rules — the resilient fallback for tier-specific names that
 * neither match a canonical id nor a known alias. First matching predicate wins,
 * so MORE-specific rules precede broader ones.
 */
const KEYWORD_RULES: Array<{ test: (n: string) => boolean; id: CanonicalMilestoneId }> = [
  { test: (n) => n.includes("key"), id: "closed" },
  { test: (n) => n.includes("clear to close") || n.includes("cleared to close"), id: "clear_to_close_received" },
  { test: (n) => n.includes("final walk") || n.includes("walkthrough") || n.includes("walk through"), id: "final_walkthrough_scheduled" },
  { test: (n) => n.includes("closing") && n.includes("schedul"), id: "closing_scheduled" },
  { test: (n) => n.includes("closing") || n.includes("settlement") || n.includes("fund"), id: "closing_date" },
  { test: (n) => n.includes("appraisal") && (n.includes("complete") || n.includes("done")), id: "appraisal_completed" },
  { test: (n) => n.includes("appraisal") && n.includes("order"), id: "appraisal_ordered" },
  { test: (n) => n.includes("appraisal"), id: "appraisal_deadline" },
  { test: (n) => n.includes("inspection") && (n.includes("complete") || n.includes("done")), id: "inspection_completed" },
  { test: (n) => n.includes("inspection") && n.includes("schedul"), id: "inspection_scheduled" },
  { test: (n) => n.includes("inspection") || n.includes("repair"), id: "inspection_deadline" },
  { test: (n) => n.includes("earnest"), id: "earnest_money_due" },
  { test: (n) => (n.includes("loan") || n.includes("mortgage") || n.includes("financ")) && n.includes("approv"), id: "loan_approved" },
  { test: (n) => n.includes("financ") || n.includes("underwrit"), id: "financing_deadline" },
  { test: (n) => n.includes("offer") && n.includes("accept"), id: "offer_accepted" },
  { test: (n) => n.includes("offer") && n.includes("receiv"), id: "offer_received" },
  { test: (n) => n.includes("offer"), id: "offer_submitted" },
  { test: (n) => n.includes("under contract"), id: "under_contract" },
  { test: (n) => n.includes("showing"), id: "first_showing" },
  { test: (n) => n.includes("list"), id: "listing_live" },
]

export interface MilestoneIdentityInput {
  milestone_type?: string | null
  milestone_name?: string | null
}

/**
 * resolveMilestoneIdentity — maps any milestone row to its canonical identity, or
 * null when no canonical anchor applies. PURE; safe everywhere.
 */
export function resolveMilestoneIdentity(row: MilestoneIdentityInput): CanonicalMilestoneId | null {
  // 1. canonical milestone_type (post-backfill, the intended steady state)
  const type = row.milestone_type
  if (type && CANONICAL_SET.has(type)) return type as CanonicalMilestoneId

  const name = row.milestone_name
  if (!name) return null

  // 2. milestone_name already a canonical snake_case identity
  const snake = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
  if (CANONICAL_SET.has(snake)) return snake as CanonicalMilestoneId

  const norm = normalize(name)

  // 3. explicit alias for a known seed / legacy human name
  if (NAME_ALIASES[norm]) return NAME_ALIASES[norm]

  // 4. ordered keyword rules (tier-variant resilient)
  for (const rule of KEYWORD_RULES) {
    if (rule.test(norm)) return rule.id
  }

  // 5. no canonical anchor
  return null
}
