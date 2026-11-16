/**
 * scripts/open-loop-ledger-dispositions-153k.ts — wave 153, lane 153K (owner ruling 16: "fix any notes from all the waves that may
 * still be open or still apply … built but not finished needs finishing").
 *
 * The launch-critical rows of the 142–147 ledger still carried as missing-code / missing-wiring were re-read against the batch-1
 * integration HEAD 34124d98 (+ this lane's patch). A row whose code has since closed it — or that this lane closed — is re-dispositioned
 * here with evidence the generator re-derives on every run (`path#anchor` in STRIPPED source), so a closure that stops being true turns
 * test:open-loop-ledger red. Rows still open stay as the earlier waves dispositioned them; lane 153K's notes list each with the
 * wave-153 lane whose files hold it. Spread LAST into MANUAL_DISPOSITIONS (scripts/open-loop-ledger-dispositions.ts), so a later
 * re-evaluation wins over an earlier one.
 */
import type { Disposition } from "./open-loop-ledger"

const K = "wave 153 lane 153K re-evaluation at 34124d98"
const cl = (e: string[], note: string, lc?: boolean): Disposition => ({ s: "closed", e, by: `${K} — ${note}`, ...(lc === undefined ? {} : { lc }) })

const AI_NARRATES = "ruling 9 holds in code: applyAiRefinements adds the model's REASON as the line's note and never applies its figures (they are counted in figuresIgnored); the regional model's low / high stay untouched"

export const WAVE153K_DISPOSITIONS: Record<string, Disposition> = {
  "144X-NC-06": cl(["lib/offers/regional-closing-costs.ts#if (adj.low !== undefined || adj.high !== undefined) figuresIgnored.push(adj.label)"], AI_NARRATES, true),
  "144D-OL-03": cl(["lib/offers/regional-closing-costs.ts#if (adj.low !== undefined || adj.high !== undefined) figuresIgnored.push(adj.label)"], AI_NARRATES, true),
  "147B-SO-02": cl(
    ["lib/intent/public-record-facts.ts#export async function readPublicRecordFacts(", "lib/intent/public-record-facts.ts#if (v.status === \"verified\" || v.status === \"stale\") return true", "lib/external/socrata-market-registry.ts#an ARCHIVAL index of historical Superior Court probate files"],
    "convergence row 89: the VERIFIED deed (NYC ACRIS master + legals) and street-use (Cambridge) datasets are read by the daily public-record sweep behind the C19 ceiling and filed only at owned addresses; probate has no current open dataset in any registered market (the one candidate is MARKED unavailable with its reason) — a person's lookup by design",
  ),
}
