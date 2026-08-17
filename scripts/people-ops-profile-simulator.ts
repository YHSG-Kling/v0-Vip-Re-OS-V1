// scripts/people-ops-profile-simulator.ts   (npm run test:people-ops-profile)
// ─────────────────────────────────────────────────────────────────────────────
// PEOPLE-OPS CONSOLIDATION — proves the brokerage-admin user-edit surface now
// manages the WHOLE person in one place: contact phone (was missing), the agent's
// real-estate profile (license #/state/expiry, office assignment, commission
// split), and a read-only "what this role can do" view — instead of scattering
// them across separate license-tracking / locations pages. Writes go through
// admin-gated, brokerage-scoped server actions against the LIVE columns only.

import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── phone (contact) is now editable on the user ──")
{
  const a = src("app/actions/admin/update-user.ts")
  check("updateUser accepts phone and patches users.phone",
    a.includes("phone?: string") && a.includes("patch.phone"))
  const form = src("app/dashboard/admin/users/[userId]/user-edit-form.tsx")
  check("the edit form renders a phone field bound to form.phone",
    form.includes('id="phone"') && form.includes('set("phone"'))
  check("the form passes phone into updateUser",
    form.includes("phone: form.phone"))
}

console.log("\n── the agent real-estate profile is managed inline (LIVE columns only) ──")
{
  const a = src("app/actions/admin/agent-profile.ts")
  check("is a server module with load + update actions",
    a.includes('"use server"') &&
    a.includes("export async function getAgentProfileForUserAction") &&
    a.includes("export async function updateAgentProfileAction"))
  // Pinned to WHERE the gate comes from, not to the identifier it is spelled
  // with. The previous form named a local const that the admin-vocabulary
  // consolidation deleted and m472 renamed again, so it reported a CORRECT
  // tightening as a regression. There is exactly one module allowed to answer
  // "is this caller an admin"; a gate imported from it is the shared answer.
  // agent_commission_profiles is a FINANCE table (m472), so this one must be on
  // the NARROW tier — the owner holds team_lead out of brokerage-wide money, and
  // this action writes through the SERVICE client where RLS cannot re-decide.
  check("admin-gated via requireAdmin, from the ONE roster module, on the FINANCE tier",
    a.includes("requireAdmin") && /from\s+["\x27]@\/lib\/auth\/resolve-user-role["\x27]/.test(a) && a.includes("isBrokerageFinanceAdmin"))
  check("target agent is pinned to the caller's own brokerage",
    a.includes('.eq("brokerage_id", auth.brokerageId)') && a.includes("belongs to a different brokerage"))
  check("writes ONLY live columns (license_number/state/expiry, commission_split, location_id)",
    a.includes("license_number") && a.includes("license_state") && a.includes("license_expiry") &&
    a.includes("commission_split") && a.includes("location_id"))
  check("does NOT write drift columns (mls_id / commission_tier not present live)",
    !a.includes("patch.mls_id") && !a.includes("patch.commission_tier") &&
    !/mls_id\s*=/.test(a) && !/commission_tier\s*=/.test(a))
  check("office assignment validates the office belongs to the brokerage",
    a.includes('.from("locations")') && a.includes("Office not found for this brokerage"))
  check("commission split is validated to 0–100",
    a.includes("between 0 and 100"))
  // SHAPE-TOLERANT, because the CLAIM is not a shape. This probe used to require
  // three exact literals: `.from("agent_commission_profiles").upsert(` on ONE
  // line, and the payload key written inline as `split_percent: patch.commission_split`.
  // Both broke on a refactor that KEPT the behaviour and strengthened it — the
  // chain gained a `.select("id")` row-count proof (a zero-row RLS refusal arrives
  // as error:null) and the payload moved into a variable so a negotiated team term
  // could be written in the same upsert without either field blanking the other.
  //
  // A guard that fails on a legitimate refactor while the behaviour is intact is
  // not protecting anything; it is taxing improvement. Asserted here as: the split
  // REACHES agent_commission_profiles.split_percent, upserted on the unique
  // agent_id. Removing the sync still turns this red — see the negative control.
  const aFlat = a.replace(/\s+/g, " ")
  const rule1Sync = (source: string) => {
    const flat = source.replace(/\s+/g, " ")
    return /from\("agent_commission_profiles"\)\s*\.upsert\(/.test(flat)
      && /onConflict: "agent_id"/.test(flat)
      // `split_percent: patch.commission_split` OR `profilePatch.split_percent = patch.commission_split`
      && /split_percent\s*[:=]\s*patch\.commission_split/.test(flat)
  }
  check("RULE-1 SYNC: the broker's split is mirrored onto the engine-authoritative agent_commission_profiles",
    rule1Sync(a))
  check("NEGATIVE CONTROL removing the profile sync turns RULE-1 red — went RED as required",
    !rule1Sync(a.replace(/split_percent/g, "split_percent_REMOVED")))
  check("the sync sets is_active so the engine's active-profile read finds it",
    /agent_commission_profiles[\s\S]*?is_active: true/.test(a) || /is_active: true[\s\S]*?agent_commission_profiles/.test(aFlat))
  // The write must be PROVEN, not assumed: supabase-js resolves a refused write
  // with error:null and zero rows, so a broker would be told a split was saved
  // that the engine will never see.
  check("…and the profile write proves it landed (row count, not a resolved promise)",
    /\.select\("id"\)/.test(aFlat) && /profileRows/.test(aFlat))

  const form = src("app/dashboard/admin/users/[userId]/user-edit-form.tsx")
  check("the form shows the Agent Profile card only when an agent row exists",
    form.includes("{agentProfile && (") && form.includes("Agent Profile"))
  check("the form saves the agent profile via updateAgentProfileAction",
    form.includes("updateAgentProfileAction"))
  check("office dropdown is populated from the brokerage offices",
    form.includes("offices.map"))
}

console.log("\n── read-only role capabilities are surfaced from the canonical matrix ──")
{
  const form = src("app/dashboard/admin/users/[userId]/user-edit-form.tsx")
  check("imports the permission matrix (SSOT; live DB has no role_capabilities table)",
    form.includes("ROLE_PERMISSIONS") && form.includes("PERMISSION_DEFINITIONS") && form.includes("ROLE_HIERARCHY"))
  check("resolves the selected role to canonical before lookup",
    form.includes("toCanonicalRole(form.user_type)"))
  check("renders the 'What this role can do' card",
    form.includes("What this role can do"))
}

console.log("\n── the page loads the profile through the gated action ──")
{
  const page = src("app/dashboard/admin/users/[userId]/page.tsx")
  check("loads the agent profile + offices via getAgentProfileForUserAction",
    page.includes("getAgentProfileForUserAction"))
  check("passes agentProfile + offices to the form",
    page.includes("agentProfile={agentProfile}") && page.includes("offices={offices}"))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ PEOPLE_OPS_PROFILE_FAIL"); process.exit(1) }
console.log(" ✅ PEOPLE_OPS_PROFILE_PASS — one person, one surface: contact + license + office + commission + role view")
