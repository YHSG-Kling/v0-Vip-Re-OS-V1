/**
 * scripts/shared/role-words.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SCANNER VOCABULARY — one definition, for the proofs that scan for rosters.
 *
 * This is NOT a gate and grants nothing. It is the set of words a source scanner
 * treats as ROLE NAMES, so that `["id","name"]` is not mistaken for a roster and
 * `"generated" | "expired"` is not mistaken for a role union.
 *
 * ── WHY IT LIVES HERE RATHER THAN IN EACH PROOF ─────────────────────────────
 *
 * It was written out twice — once in finance-authority-simulator and again in
 * seller-decision-authority-simulator — and finance-authority's own scan CAUGHT
 * the second copy: it forbids any module that asks the shared finance predicate
 * from also keeping a role array, and both of those modules do ask it. The proof
 * policing "more than one vocab over the same function is dangerous" had grown a
 * second vocab of its own, and then flagged it. That is the guard working, so it
 * gets the same treatment it demands of the tree: ONE definition, imported.
 *
 * (finance-authority exempts its own file from the walk, which is why only the
 * newer copy tripped. The exemption is not a licence for a second copy — it
 * exists so the canonical roster inside the module under scan is not reported
 * against itself.)
 *
 * ── WHY IT IS WIDER THAN ANY LIVE ROSTER, DELIBERATELY ──────────────────────
 *
 * It carries values that are NOT storable — `broker_admin`, `super_admin`,
 * `marketing` as a user_type — precisely because a scanner must RECOGNISE the
 * spellings it is hunting for. A vocabulary narrowed to what the CHECK admits
 * would go blind to exactly the stale literals these proofs exist to find.
 *
 * This file is a module, not a proof: simulator-sweep selects its targets from
 * package.json `test:*` entries, so nothing here is ever executed as a check.
 */
export const ROLE_WORDS: ReadonlySet<string> = new Set([
  // Tenant seats — the fourteen users_user_type_check admits …
  "agent", "broker", "broker_owner", "admin", "tc", "vendor", "lender",
  "isa", "team_lead", "compliance_officer", "contact", "system", "support",
  "superadmin",
  // … plus title_agent, which the canonical UserRole carries.
  "title_agent",
  // NOT STORABLE, and here on purpose: these are the stale spellings a scan must
  // still be able to see. `broker_admin` is an input-only alias for broker,
  // `super_admin` was never a legal user_type at all, and `marketing` is a
  // platform_role that several literals wrongly matched against user_type.
  "broker_admin", "super_admin", "marketing",
])

/**
 * THE NON-STAFF PORTAL SEATS — the people the standing ruling holds out of every
 * financial surface: "Contacts, lenders and vendors see no financials — only
 * their own" (CLAUDE.md §5).
 *
 * ALSO NOT A GATE. Nothing imports this into `app/` or `lib/`; it is the subject
 * list a PROOF iterates when it asserts that a money predicate refuses them, and
 * it lives here for the reason the header above gives: finance-authority's scan
 * forbids any module that asks the shared finance predicate from ALSO keeping a
 * role array, and tenant-principal-books-simulator asks it. That scan caught this
 * list as a second local roster the first time it was written inline — the guard
 * working — so it gets the treatment it demands: ONE definition, imported.
 *
 * MEASURED live on hrvaqgvukzxfskkcrwbt: 4 `contact`, 2 `lender` and 2 `vendor`
 * accounts hold tenanted `users` rows, so this is a real population, not a
 * hypothetical one — which is why a widening of any money gate has to be shown
 * not to reach them.
 */
export const NON_STAFF_PORTAL_ROLES: readonly string[] = ["contact", "lender", "vendor"]
