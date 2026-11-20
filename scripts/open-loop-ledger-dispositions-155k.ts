/**
 * scripts/open-loop-ledger-dispositions-155k.ts — wave 155, lane 155K (directive K: the named wave-154 partials and the historic
 * launch-critical ledger). NOT every historical suggestion is a task (owner R14): only rows this lane re-verified are touched.
 *
 *   CLOSED by code the generator re-derives (`path#anchor` in STRIPPED source, `key:`):
 *     145G-SO-02 / 145G-OL-09 — "a tenant with no active territory gets no intelligence topics": the local-intel cron now also runs
 *       runFirstPartyTopicSweep for live tenants WITHOUT a territory (first-party topics only; third-party research stays
 *       territory-gated inside startTopicRefurbish). Brand listening is third-party listening and STAYS territory-gated by rule.
 *     146A-OL-02 — the wave-146 security gate reads EXTERNAL until m875 is applied: present (production-readiness-guard
 *       STORAGE_POLICY_MIGRATIONS_146 = m854/m855/m874/m875; the storage gate is EXTERNAL while any is unstamped).
 *   CARRIED, corrected:
 *     143G-OL-05 / 146I-OL-03 — the hand-typed `.in("user_type", ["admin","broker"…])` literals: 31 at d2d6468c (the row says 32);
 *       directive item 8 assigns the fold to lane 155K2 (the ledger's owner vocabulary predates wave 155, so `o` keeps lane149Z
 *       and the reason names the current lane).
 * Spread LAST into MANUAL_DISPOSITIONS (scripts/open-loop-ledger-dispositions.ts), after 154M.
 */
import type { Disposition } from "./open-loop-ledger"

const K = "wave 155 lane 155K at d2d6468c"
const FIRST_PARTY_SWEEP = [
  "key:test:wave154-partials",
  "lib/repurpose/refurbish-run.ts#export async function runFirstPartyTopicSweep(",
  "lib/repurpose/refurbish-run.ts#if (a.territory === \"none\" && topicAcquisitionClass(sourceKind) !== \"first_party\")",
  "app/api/cron/local-intel/route.ts#const firstParty = await runFirstPartyTopicSweep(svc as never)",
]
const LITERALS = "31 hand-typed `.in(\"user_type\", [\"admin\",\"broker\"…])` literals remain at d2d6468c (re-measured with the row's own grep; the row says 32) — directive K item 8 assigns the fold onto TENANT_ADMIN_USER_TYPES to lane 155K2 (positive and negative tests, no widening)"

export const WAVE155K_DISPOSITIONS: Record<string, Disposition> = {
  "145G-SO-02": { s: "closed", e: FIRST_PARTY_SWEEP, by: `${K} — FIXED: tenants without a territory get first-party topic intelligence + the refurbish trigger (first-party topics only)` },
  "145G-OL-09": { s: "closed", e: FIRST_PARTY_SWEEP, by: `${K} — FIXED for the topic pass; brand listening is third-party research and stays territory-gated by the K3 rule (an intentional rejection, not a gap)` },
  "146A-OL-02": { s: "closed", e: ["scripts/production-readiness-guard.ts#const STORAGE_POLICY_MIGRATIONS_146 = [854, 855, 874, 875].map(migrationNamed)", "scripts/production-readiness-guard.ts#const storageApplied146 = STORAGE_POLICY_MIGRATIONS_146.length > 0"], by: `${K} — VERIFIED ALREADY DONE: the wave-146 storage gate is EXTERNAL until every storage.objects migration of m854/m855/m874/m875 is stamped applied`, lc: true },
  "143G-OL-05": { s: "carried", k: "missing-code", o: "lane149Z", r: LITERALS, lc: true },
  "146I-OL-03": { s: "carried", k: "missing-code", o: "lane149Z", r: LITERALS, lc: true },
}
