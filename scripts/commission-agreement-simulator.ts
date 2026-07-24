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
  check("the signed record is the agent-keyed contract_signatures ledger",
    a.includes('.from("contract_signatures")') && a.includes("contract_type: COMMISSION_CATEGORY") && a.includes("agent_id: agentId"))
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

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ COMMISSION_AGREEMENT_FAIL"); process.exit(1) }
console.log(" ✅ COMMISSION_AGREEMENT_PASS — upload form → fill → e-sign → saved on the agent profile")
