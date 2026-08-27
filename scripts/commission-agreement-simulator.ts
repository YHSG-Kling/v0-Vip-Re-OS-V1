// scripts/commission-agreement-simulator.ts   (npm run test:commission-agreement)
// ─────────────────────────────────────────────────────────────────────────────
// COMMISSION AGREEMENT ON THE AGENT PROFILE — proves the owner's flow: the
// brokerage uploads its commission-agreement FORM (brokerage_forms, category
// commission_agreement), it's selected on the agent profile, fields are filled,
// and it's SENT to e-sign via the CONFIGURED provider (honest in-app fallback,
// never a fake send) → the signed record lands on contract_signatures (agent-
// keyed) and surfaces on the profile. Reuses the real rails; no parallel path.

import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the actions: upload → list → send → status ──")
{
  const a = src("app/actions/admin/commission-agreement.ts")
  check("all four actions exist",
    a.includes("export async function uploadCommissionAgreementFormAction") &&
    a.includes("export async function listCommissionAgreementFormsAction") &&
    a.includes("export async function sendCommissionAgreementAction") &&
    a.includes("export async function getCommissionAgreementStatusAction"))
  check("admin-gated + agent pinned to the caller's brokerage",
    a.includes("requireAdmin") && a.includes("Agent belongs to a different brokerage"))
  check("the uploaded form lives in brokerage_forms with category commission_agreement",
    a.includes('.from("brokerage_forms")') && a.includes('COMMISSION_CATEGORY = "commission_agreement"'))
  check("the upload stores the PDF in a Supabase bucket (not blob)",
    a.includes("uploadBufferToBucket") && a.includes('"commission-agreements"') && !a.includes("@vercel/blob"))
  // m481 widened the family: the insert is typed (contract_type: contractType),
  // whose normalizeContractType default is COMMISSION_CATEGORY — same record for
  // the commission lane, plus independent_contractor / team_agreement beside it.
  check("the signed record is the agent-keyed contract_signatures ledger",
    a.includes('.from("contract_signatures")') && a.includes("contract_type: contractType") &&
    a.includes("const t = input ?? COMMISSION_CATEGORY") && a.includes("agent_id: agentId"))
  check("captures which form + the filled values (form_id / field_values)",
    a.includes("form_id: input.formId") && a.includes("field_values: input.fieldValues"))
  check("provider_name is never null (NOT-NULL column) — 'none' records the honest no-provider state",
    a.includes('providerName ?? "none"'))
  check("esign_status uses only allowed values (pending when no provider, sent when dispatched)",
    a.includes('canEsign ? "sent" : "pending"'))
  check("resolves the CONFIGURED provider and stamps the envelope id on dispatch (finalize-packet closes it)",
    a.includes("resolveTransactionFormsProvider") && a.includes("provider_envelope_id"))
  check("HONEST fallback: no provider → no fake send (canEsign guards the dispatch)",
    a.includes("const canEsign =") && a.includes("providerConfigured"))
}

console.log("\n── the agent-profile card is wired ──")
{
  const card = src("app/dashboard/admin/users/[userId]/commission-agreement-card.tsx")
  check("card loads forms + status and sends",
    card.includes("listCommissionAgreementFormsAction") &&
    card.includes("getCommissionAgreementStatusAction") &&
    card.includes("sendCommissionAgreementAction"))
  check("renders the selected form's fields to fill",
    card.includes("selectedForm.fields.map"))
  check("shows the signed document link + status",
    card.includes("View document") && card.includes("STATUS_LABEL"))
  const form = src("app/dashboard/admin/users/[userId]/user-edit-form.tsx")
  check("the card is mounted on the agent profile (agents only)",
    form.includes("CommissionAgreementCard") && form.includes("agentProfile && <CommissionAgreementCard"))
}

console.log("\n── schema migration recorded ──")
{
  const sql = src("scripts/l60-s01-commission-agreement-columns.sql")
  check("adds form_id + field_values + extends contract_type to include commission_agreement",
    sql.includes("form_id uuid") && sql.includes("field_values jsonb") && sql.includes("'commission_agreement'"))
}

console.log("\n── the LISTING agreement intake captures the state-form TOTAL rate ──")
// Owner ruling (2026-08-27): "listing agreement total commission rate is part of
// the agreement which is a state form and/or seller agreement." The one insert
// of listing_agreements must therefore write total_commission_rate, captured on
// the same intake surface as the split pair, in the vocabulary the seven
// readers already speak (percent values; total-only agreements legal; when both
// sides are present, total == their sum).
{
  const rule = src("lib/commission/agreement-total-rate.ts")
  const engine = src("app/actions/seller-listing/execution-engine.ts")
  const events = src("lib/listing-lifecycle/recordable-events.ts")
  const dispatch = src("app/actions/seller-listing/record-lifecycle-event.ts")

  check("the intake field exists on markAgreementSigned's recordable-event card",
    /key:\s*"totalRate"/.test(events) && /key:\s*"listingRate"/.test(events))
  check("the dispatcher passes totalRate through to the recorder",
    /totalRate:\s*num\("totalRate"\)/.test(dispatch))
  check("the ONE insert of listing_agreements writes total_commission_rate from the shared rule",
    /total_commission_rate:\s*totalRateResolution\.total/.test(engine) &&
    /resolveTotalCommissionRate\(/.test(engine))
  check("a refused resolution refuses the WRITE (validated before insert, not after)",
    /if \(!totalRateResolution\.ok\)/.test(engine) &&
    engine.indexOf("resolveTotalCommissionRate(") < engine.indexOf('.from("listing_agreements")'))

  // The rule itself, PURE — same module the writer imports, so this cannot drift.
  // (Dynamic import keeps this file's sync sections intact.)
  void (async () => {
    const { resolveTotalCommissionRate } = await import("../lib/commission/agreement-total-rate")
    const both = resolveTotalCommissionRate({ listingRate: 3, buyerRate: 2.5 })
    check("both sides, blank total → DERIVED total 5.5 (percent vocabulary)",
      both.ok && both.total === 5.5 && both.derived === true)
    const totalOnly = resolveTotalCommissionRate({ totalRate: 5 })
    check("total-only agreement is legal (splits stay null; the readers' totalOnly shape)",
      totalOnly.ok && totalOnly.total === 5 && totalOnly.derived === false)
    const agree = resolveTotalCommissionRate({ listingRate: 3, buyerRate: 3, totalRate: 6 })
    check("all three lines agreeing pass through as ENTERED, not derived",
      agree.ok && agree.total === 6 && agree.derived === false)
    const blank = resolveTotalCommissionRate({})
    check("nothing recorded → NULL, never 0", blank.ok && blank.total === null)

    // MUTATION CONTROLS (§2): the refusals must actually bite.
    const mismatch = resolveTotalCommissionRate({ listingRate: 3, buyerRate: 3, totalRate: 5 })
    check("CONTROL — a total that disagrees with the sides is REFUSED (readers would silently prefer the total)",
      !mismatch.ok)
    const negative = resolveTotalCommissionRate({ totalRate: -1 })
    check("CONTROL — a negative rate is refused", !negative.ok)
    const decimalScale = resolveTotalCommissionRate({ totalRate: 101 })
    check("CONTROL — a rate above 100 is refused (percent scale, 3 means 3%)", !decimalScale.ok)
    const shortTotal = resolveTotalCommissionRate({ listingRate: 3, totalRate: 2 })
    check("CONTROL — a total below the one recorded side is refused", !shortTotal.ok)

    // The RESULT block moved inside this async tail so the pure-rule checks are
    // counted before the verdict prints (they were previously the last section).
    console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
    if (failed > 0) { console.log(" ❌ COMMISSION_AGREEMENT_FAIL"); process.exit(1) }
    console.log(" ✅ COMMISSION_AGREEMENT_PASS — upload form → fill → e-sign → saved on the agent profile; listing-agreement intake captures the state-form total rate")
  })()
}
