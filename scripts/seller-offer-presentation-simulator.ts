// scripts/seller-offer-presentation-simulator.ts
// ─────────────────────────────────────────────────────────────────────────────
// npm run test:seller-offer-presentation
//
// OWNER RULING (wave 12, R4): "any offer that comes in for insdie listings, once
// agent approves, is pushed to the sellers's portal to see the offer with the
// interactive net sheet. and if muliple offers, then a complete comparison."
//
// It is a GATE, and there was none. The seller portal filtered offers by
// `status` alone, and an offer arriving by email is inserted `status:'submitted'`
// — so the buyer's name, price and terms were on the seller's screen the instant
// the webhook returned, before any agent had opened it. `offers.status` carries
// NO CHECK CONSTRAINT (verified against the live schema), so it could never have
// been a trustworthy gate for anything.
//
// The load-bearing assertion in this file is the first one: an offer with
// `presented_to_seller_at IS NULL` is not visible to a seller, and the gate is
// not satisfiable by `status`.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let pass = 0
const failures: string[] = []
function check(label: string, ok: boolean, why?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { failures.push(label); console.log(`  ✗ ${label}${why ? `\n      ${why}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const READER   = src("app/actions/portal-seller.ts")
const ACTION   = src("app/actions/offers/present-to-seller.ts")
const PORTAL   = src("app/portal/[contactId]/offers/page.tsx")
const MANAGER  = src("app/dashboard/listings/[id]/offers/offers-manager-client.tsx")

console.log("══════════════════════════════════════════════════")
console.log(" THE OFFER REACHES THE SELLER ONLY WHEN THE AGENT SAYS SO")
console.log("══════════════════════════════════════════════════")

// ── 1 · THE GATE ───────────────────────────────────────────────────────────
console.log("\n[an unapproved offer is not the seller's to see]")
{
  const offerCols = new Set(SCHEMA_SNAPSHOT.offers ?? [])
  check("the approval stamp is a real column, not a convention",
    offerCols.has("presented_to_seller_at")
    && offerCols.has("presented_to_seller_by_agent_id")
    && offerCols.has("seller_presentation_note"))

  // The gate is a NOT-NULL filter on the stamp. Asserted as the CONSTRUCT — a
  // filter on that column keyed to the seller branch — rather than a spelling,
  // because the surrounding query is expected to keep changing.
  const gated = /\.not\("presented_to_seller_at",\s*"is",\s*null\)/.test(READER)
  check("the seller's offer reader filters on the stamp", gated)
  check("…and it is applied on the SELLER branch, not to every caller",
    /if \(access\.isContactSelf\)[\s\S]{0,200}?\.not\("presented_to_seller_at",\s*"is",\s*null\)/.test(READER),
    "the agent looking at their own client's portal must still see everything; only the seller is gated")
  check("the gate is NOT satisfiable by status — status is never read as approval",
    !/presented[\s\S]{0,80}status\s*===\s*"(submitted|accepted|pending|under_review)"/.test(READER)
    && !/status[\s\S]{0,40}=>\s*presented/.test(READER),
    "offers.status has no CHECK constraint; deriving a release gate from it would be a gate in name only")

  // Every OTHER seller-facing reader in the same module has to carry it too, or
  // the gate leaks through whichever one the page happens to call.
  const stampFilters = (READER.match(/\.not\("presented_to_seller_at",\s*"is",\s*null\)/g) ?? []).length
  check(`every seller-facing offer read carries the stamp filter (${stampFilters} sites)`,
    stampFilters >= 3,
    "one ungated reader is the whole leak — the seller only needs one route to the data")
}

// ── 2 · WHO APPROVED IT, IN THE RIGHT ID SPACE ─────────────────────────────
console.log("\n[the approval is an act by a named agent, and it is reversible]")
{
  check("approving is an explicit action, not a side effect of some other write",
    /export async function presentOfferToSeller\(/.test(ACTION))
  check("…and it can be undone, because an agent can approve the wrong offer",
    /export async function unpresentOfferFromSeller\(/.test(ACTION),
    "a one-way release of a buyer's terms to the seller is not a gate, it is a trapdoor")
  check("the approver is RESOLVED from a users id into an agents id",
    /import \{ resolveAgentId \}/.test(ACTION) && /await resolveAgentId\(/.test(ACTION),
    "presented_to_seller_by_agent_id is an agents.id; the session gives a users.id; the spaces are disjoint")
  check("…and no `??` smuggles the session id into the agents column",
    !/presented_to_seller_by_agent_id:\s*[A-Za-z.]*\s*\?\?\s*(auth\.)?userId/.test(ACTION))
  check("the caller is authenticated and the listing's tenant is verified",
    /auth\.getUser\(\)/.test(ACTION) && /brokerage_id !== brokerageId/.test(ACTION),
    "approving publishes another party's price and terms — it cannot be weaker than accepting an offer")
  check("the write re-asserts the tenant rather than trusting the lookup",
    /\.eq\("brokerage_id",\s*auth\.brokerageId\)/.test(ACTION))

  // R4d — the banner the portal reads was written by exactly one surface (our
  // own wizard), so an emailed offer could never raise it.
  check("approval writes the portal notification the seller's banner reads",
    /activity_type:\s*PORTAL_OFFER_NOTIFICATION/.test(ACTION))
  check("…with the NOT-NULL tenant and the entity it is about",
    /brokerage_id:\s*listing\.brokerage_id/.test(ACTION) && /entity_id:\s*offerId/.test(ACTION),
    "activities.brokerage_id is NOT NULL with no default; entity_id is nullable, so omitting it succeeds invisibly")
  check("the agent has a surface to do it from",
    /presentOfferToSeller|unpresentOfferFromSeller/.test(MANAGER),
    "an approval nobody can perform is the same as no approval")
}

// ── 3 · THE INTERACTIVE NET SHEET IS WIRED, AND NOTHING WAS DELETED ────────
//
// `interactive-net-sheet.tsx` says in its own header that it is reusable by the
// seller portal in read-only mode, and takes a `readOnly` prop for it. Its only
// importer was the AGENT's page. It is not a duplicate of NetSheetCalculator —
// the interactive sheet ranks MULTIPLE offers by net proceeds, the calculator is
// a single-offer what-if the seller edits — so both survive and only the missing
// wire was added.
console.log("\n[the interactive net sheet the owner asked for by name]")
{
  check("the seller portal now renders the interactive sheet",
    /import \{ InteractiveNetSheet \}/.test(PORTAL) && /<InteractiveNetSheet/.test(PORTAL))
  check("…in read-only mode, because the seller is reading, not re-pricing the deal",
    /readOnly/.test(PORTAL))
  check("NetSheetCalculator SURVIVES alongside it — they are different tools",
    /NetSheetCalculator/.test(PORTAL),
    "the calculator is the seller's single-offer what-if; deleting it would remove a capability, not a copy")
  check("the sheet is fed the offers, so ranking has something to rank",
    /<SellerInteractiveNetSheet/.test(PORTAL))
}

// ── 4 · THE COMPARISON IS THE ONE ALREADY COMPUTED ─────────────────────────
console.log("\n[the complete comparison is read, not rebuilt]")
{
  // The read lives in the ACTION, not the page — that is where every other
  // seller read lives and where the release gate can be applied to it.
  check("the persisted comparison is read back",
    /\.from\("offer_comparison"\)/.test(READER) && /export async function getSellerOfferComparison\(/.test(READER),
    "analyzeAndCompareOffers already persists a matrix, per-offer net and a recommendation for this listing")
  check("…and the seller's page consumes it",
    /getSellerOfferComparison/.test(PORTAL))
  check("…instead of re-burning inference on every page load",
    !/await analyzeMultipleOffers\(listing\.id,\s*""\)/.test(PORTAL),
    "that call ran on EVERY render of the seller's multi-offer view")
  check("a comparison covering an offer the seller may NOT see is withheld, not leaked",
    /coversUnreleased/.test(READER) && /"withheld"/.test(READER),
    "the persisted comparison is computed over ALL active offers, including ones the agent has not approved")
  check("…and a comparison that predates a newly released offer is labelled stale, not passed off as current",
    /"stale"/.test(READER) && /missingOfferCount/.test(READER))
  check("a REFUSED comparison read is said out loud, never rendered as 'no comparison yet'",
    /persistedComparison\?\.error/.test(PORTAL),
    "supabase-js resolves a refused query — empty and denied are the same value unless the error is carried")
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ SELLER_OFFER_PRESENTATION_FAIL — an offer the agent has not approved must not be on the seller's screen")
  process.exit(1)
}
console.log(" ✅ SELLER_OFFER_PRESENTATION_PASS — the agent releases the offer, and the seller gets the real net sheet and the real comparison")
