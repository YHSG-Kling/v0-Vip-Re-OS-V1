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
