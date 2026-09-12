// lib/dashboard/data-survivors.ts
//
// WHERE THE DASHBOARD-DATA LANE WENT.
//
// `hooks/use-dashboard-data.ts` (19 hooks) and `app/api/dashboard/data/route.ts`
// (18 branches) were judged a DUPLICATE in wave 13, that lane losing: every
// branch was a strict subset of a live server action the app already renders
// from, and the one capability the lane appeared to add — SWR + `mutate` — was
// already available over those richer readers (hooks/use-contact-dashboard.ts
// does exactly that, with no HTTP hop and no second auth round trip).
//
// It was NOT deleted then, for the right reason: the method is MERGE FIRST, and
// three scoping properties the losing lane carried were not yet on its
// survivors. Deleting then would have thrown away scoping nothing else had —
// precisely the failure that rule exists to prevent.
//
// Wave 16 landed the merges and deleted both files. This module is what remains:
// the LEDGER, kept as data rather than prose because a verdict that only lives
// in a comment is documentation masquerading as a decision, and this tree has
// been burned by that before.
//
// NOT a "use server" module, deliberately — such a file may export only async
// functions, and this is a const.
//
// Enforced by scripts/dashboard-data-layer-simulator.ts: every entry must name a
// file that exists and a function that file actually declares, the two deleted
// files must stay deleted, and no survivor may take its tenant from its caller.

/** The data types the retired lane could fetch. Kept so the ledger is total. */
export type DashboardDataType =
  | "transactions"
  | "contacts"
  | "listings"
  | "appointments"
  | "showings"
  | "tours"
  | "offers"
  | "referrals"
  | "reviews"
  | "expenses"
  | "commissions"
  | "open_houses"
  | "tasks"
  | "notifications"
  | "documents"
  | "agents"
  | "vendors"
  | "communications"

/**
 * The survivor for every data type, as `path:functionName`.
 *
 * Each was read against the retired route branch on the four properties that
 * branch actually carried — session-derived tenant filter; identity resolved
 * with the BROKERAGE-SCOPED resolver rather than the unscoped one; a refused
 * read reported as a failure rather than as `[]`; an unprivileged caller refused
 * rather than handed an empty list — and anything the branch held that its
 * survivor lacked was merged onto the survivor BEFORE the delete.
 */
export const DASHBOARD_DATA_SURVIVOR: Record<DashboardDataType, string> = {
  transactions:   "app/actions/transactions.ts:getTransactions",
  contacts:       "app/actions/contacts.ts:getContacts",
  listings:       "app/actions/listings.ts:getListings",
  appointments:   "app/actions/ai-calendar-management.ts:getAppointments",
  showings:       "app/actions/showings.ts:getShowings",
  tours:          "app/actions/ai-showing-management.ts:getTours",
  offers:         "app/offers/page.tsx:OffersPage",
  referrals:      "app/actions/referrals/referral-actions.ts:listPartnersWithReferrals",
  reviews:        "app/actions/multi-persona.ts:getAgentReviews",
  expenses:       "app/actions/agents.ts:getAgentExpenses",
  commissions:    "app/actions/agents.ts:getAgentCommissions",
  open_houses:    "app/actions/open-house.ts:getOpenHouses",
  tasks:          "app/actions/tasks.ts:getTasks",
  notifications:  "lib/kernel/notification-center.ts:listNotifications",
  documents:      "app/actions/documents.ts:getDocuments",
  agents:         "app/actions/agents.ts:getAgents",
  vendors:        "app/actions/vendor-marketplace.ts:searchVendors",
  communications: "app/actions/communications.ts:getRecentCommunications",
}

/** The two files the lane consisted of. They must not come back. */
export const RETIRED_DASHBOARD_DATA_FILES: readonly string[] = [
  "hooks/use-dashboard-data.ts",
  "app/api/dashboard/data/route.ts",
]

/**
 * What each survivor ABSORBED from its branch, or why it needed nothing.
 *
 * Recorded because the merge is the part that justified the delete, and a merge
 * nobody can find later reads as a deletion that took something with it.
 *
 * Three of these were found only by doing the comparison — they were NOT on the
 * MERGE DEBT list wave 13 wrote, which is the argument for reading all eighteen
 * rather than trusting an enumeration someone made in passing.
 */
export const DASHBOARD_DATA_MERGE_RECORD: Record<DashboardDataType, string> = {
  transactions:
    "MERGED: tenant + agent scope were optional caller-supplied arguments applied by DEFAULT TO NOTHING — getTransactions() read every deal on the platform. Now session-derived; a caller-supplied agent id may only narrow, only for a broker/admin, only inside their own tenant. Also returned a bare [] for a rejected argument, indistinguishable from an empty pipeline; every exit is the discriminated shape now.",
  contacts:
    "MERGED: returned { success: true, contacts: [] } for a session with no tenant — 'you have no contacts' for a caller who may not be told anything. Now refuses.",
  listings:
    "MERGED: delegated straight through with the caller's arguments and the service applies no tenant filter at all, so getListings() returned every listing on the platform and getListings({agentId}) returned any agent's book. Tenant is session-derived and not overridable. ADJACENT WRITER FIX: createListing never supplied brokerage_id, so every row created through it carried a NULL tenant.",
  appointments: "MERGED: session-derived tenant filter and refused reads surfaced.",
  showings:     "MERGED: session-derived tenant filter and refused reads surfaced.",
  tours:        "Already merged in wave 14 (MERGE DEBT item 3): brokerage filter + session gate.",
  offers:
    "MERGED, and the weakest of the eighteen — a PAGE, not a callable reader. Every filter sat behind an `if`, so a session with user_type 'agent', no resolvable agents row and no brokerage_id fell through all of them and issued a BARE SELECT over every offer in the platform. The tenant anchor is unconditional now, the agent resolve is brokerage-scoped, and all three reads report refusals.",
  referrals:
    "MERGED: both reads ran on the SERVICE client (no RLS to fall back on) and neither destructured error, so a refusal rendered as 'you have no referral partners'. An unresolved agentId filtered agent_id=eq.null rather than refusing.",
  reviews:      "NOTHING OWED: session gate, tenant filter and error handling were already present.",
  expenses:     "Already merged in wave 14 (MERGE DEBT item 2): requireAgentLedgerAccess + tenant filter.",
  commissions:  "Already merged in wave 14 (MERGE DEBT item 2): requireAgentLedgerAccess + tenant filter.",
  open_houses:  "NOTHING OWED: fails closed on an unresolved identity, and pins on an agents-class id owned by exactly one brokerage.",
  tasks:        "MERGED: session-derived tenant filter and refused reads surfaced.",
  notifications:
    "NOTHING OWED: keys on the AUTH USER id (users.id), the same key the branch used, over an RLS-scoped client, and throws on a refused read.",
  documents:    "NOTHING OWED: session gate plus tenant verification of any caller-supplied contact/transaction, failing closed.",
  agents:       "Already merged in wave 14 (MERGE DEBT item 1): session-derived tenant + broker/admin role gate + discriminated result.",
  vendors:
    "MERGED: the identity read dropped its error, so a refusal silently demoted the caller to the global-vendors-only branch and the brokerage's own bench vanished; the ratings read's refusal rendered every vendor unrated.",
  communications:
    "NOTHING OWED, and STRONGER than the branch: the branch deliberately omitted the tenant filter because messages.brokerage_id is nullable and one live writer did not stamp it. That writer (app/actions/ai-auto-response.ts) now stamps it, so the survivor's filter is the correct one.",
}
