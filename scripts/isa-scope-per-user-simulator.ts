#!/usr/bin/env tsx
/**
 * scripts/isa-scope-per-user-simulator.ts   (npm run test:isa-scope-per-user)
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO OWNER RULINGS (2026-08-24), verbatim:
 *
 *   A. "ai isa system works for 1 tenant at a time and works for the platform as well"
 *   B. "ai customizations are also per user"
 *
 * Ruling A has three parts and this guard holds all three apart, because
 * collapsing any two of them is how the previous wave got it half-right:
 *
 *   · the ISA IS a platform actor          (isPlatformActorRole)
 *   · the ISA is NOT a superadmin          (isPlatformSuperadminIdentity — unchanged)
 *   · the ISA acts for ONE tenant, or the platform, and REFUSES anything else
 *     (resolveIsaActingScope — the load-bearing half)
 *
 * Ruling B is the grain: `ai_isa_settings` was brokerage-only and UNIQUE on
 * brokerage_id, so a per-user AI customization was not merely unbuilt, it was
 * structurally forbidden. m552 gave it `brand_voice_profile`'s grain plus an
 * explicit owner_type; lib/ai-isa/resolve-isa-settings.ts cascades over it.
 *
 * ── TWO-SIDED POSITIVE CONTROLS (CLAUDE.md §2) ──────────────────────────────
 * Every refusal asserted here is paired with the ACCEPT it must not swallow, and
 * every acceptance is paired with the REFUSAL it must not become. A guard that
 * only proves "X is refused" passes just as happily against a resolver that
 * refuses everything, which would be a worse bug than the one it is watching for.
 *
 * ── WHAT IS DELIBERATELY NOT ASSERTED ───────────────────────────────────────
 * Nothing here talks to the database. The cascade's ROW READS are asserted on
 * stripped source (the owner-column predicate, the stop-on-unreadable), not by
 * executing them, because a simulator that needs credentials is a simulator CI
 * cannot run. The live half was proven once, with before/after probes, in the
 * m552 application record.
 *
 * BLIND SPOT, stated beside the number: this guard reads FOUR wiring files by
 * name (the cron, the two background callers, the action file). A fifth caller
 * that resolved ISA settings its own way would not be seen. `test:writerless-*`
 * and `test:no-orphan-actions` cover the general population.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
// lib/ai-isa/resolve-isa-settings.ts imports `server-only`, which throws outside a
// Server Component. Neutralize it in the require cache BEFORE importing anything
// that transitively pulls it (the established idiom — see
// scripts/accounting-scopes-simulator.ts).
import { createRequire } from "node:module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as never
} catch { /* server-only not resolvable — nothing to shim */ }
import { stripComments, blankStrings } from "./strip-comments"
import {
  isPlatformActorRole,
  isPlatformStaffRole,
  isNonHumanPlatformRole,
  isPlatformSuperadminIdentity,
  isAiIsaSystemIdentity,
  platformActorKind,
  resolvePlatformRoleIdentity,
  PLATFORM_ACTOR_ROLES,
} from "../lib/platform/platform-staff-roster"
import {
  resolveIsaActingScope,
  isaTenantWorkQueue,
  ISA_SERVICE_IDENTITY,
} from "../lib/ai-isa/isa-acting-scope"
import { isTenantScopeRefusal, scopeBrokerageId } from "../lib/kernel/tenant-scope"
import { scopeCascade, OWNER_CASCADE_ORDER, INTERNAL_CASCADE_ORDER } from "../lib/connections/scope"
import { ISA_CAPABILITY_CATALOG } from "../lib/ai-isa/settings-types"
// Dynamic: static ESM imports hoist ABOVE the server-only shim, so the tainted
// module must load after the require-cache neutralization has run.
const { isaSettingsCascade } = await import("../lib/ai-isa/resolve-isa-settings")

let passed = 0, failed = 0
const failures: string[] = []
function check(id: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${id}`) }
  else { failed++; failures.push(id); console.log(`  ✗ ${id}${detail ? ` — ${detail}` : ""}`) }
}

/** Run a thunk and report whether it REFUSED with a TenantScopeRefusal. */
function refusal(fn: () => unknown): { refused: boolean; message: string } {
  try { fn(); return { refused: false, message: "returned a value" } }
  catch (e) { return { refused: isTenantScopeRefusal(e), message: (e as Error)?.message ?? String(e) } }
}

const root = join(import.meta.dirname, "..")
/** Source with comments AND string literals blanked — a tombstone naming a
 *  survivor, or a fixture id inside a template literal, is not a call site. */
const code = (rel: string) => blankStrings(stripComments(readFileSync(join(root, rel), "utf8")))
/** Source with comments blanked only — for assertions that must see a literal. */
const codeKeepStrings = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))

const B1: string = "11111111-1111-4111-8111-111111111111"
const B2: string = "22222222-2222-4222-8222-222222222222"
const A1: string = "aaaaaaaa-1111-4111-8111-111111111111"
const A2: string = "aaaaaaaa-2222-4222-8222-222222222222"
const T1: string = "77777777-7777-4777-8777-777777777777"

console.log("══════════════════════════════════════════════════════════════")
console.log(" AI ISA — one tenant at a time, and AI customizations per user")
console.log("══════════════════════════════════════════════════════════════")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── RULING A(i): the ISA IS a platform actor, and is NOT total control ──")

check("ACTOR-ISA-YES: ai_isa_system is a platform ACTOR",
  isPlatformActorRole("ai_isa_system") === true)
check("ACTOR-ISA-NOT-STAFF: …and is still NOT a member of staff",
  isPlatformStaffRole("ai_isa_system") === false && isNonHumanPlatformRole("ai_isa_system") === true)
check("ACTOR-STAFF-YES (positive control): every human staff role is also an actor",
  ["superadmin", "admin", "marketing", "support"].every((r) => isPlatformActorRole(r)))
check("ACTOR-TENANT-NO (negative control): a tenant role is NOT a platform actor",
  ["broker", "broker_admin", "broker_owner", "team_lead", "agent", null, undefined, ""]
    .every((r) => isPlatformActorRole(r as string) === false))
check("ACTOR-ROSTER-CLOSED: PLATFORM_ACTOR_ROLES is exactly staff ∪ non-human",
  PLATFORM_ACTOR_ROLES.length === 5 && PLATFORM_ACTOR_ROLES.includes("ai_isa_system"))

check("KIND-SERVICE: the ISA identity is a platform 'service' actor",
  platformActorKind("system", "ai_isa_system") === "service")
check("KIND-STAFF (positive control): a superadmin is 'staff', not 'service'",
  platformActorKind("admin", "superadmin") === "staff")
check("KIND-NONE (negative control): a tenant user is neither",
  platformActorKind("agent", null) === null)

// THE REFUSAL THE PREVIOUS WAVE SHIPPED MUST SURVIVE THIS CORRECTION.
check("TOTAL-CONTROL-REFUSED: ai_isa_system is NOT a superadmin identity",
  isPlatformSuperadminIdentity("system", "ai_isa_system") === false)
check("TOTAL-CONTROL-REFUSED-BY-NAME: even a row that also claimed user_type=superadmin",
  isPlatformSuperadminIdentity("superadmin", "ai_isa_system") === false)
check("TOTAL-CONTROL-GRANTED (positive control): the real superadmin still passes",
  isPlatformSuperadminIdentity("admin", "superadmin") === true)
check("STAFF-ROLE-NULL-FOR-SERVICE: resolvePlatformRoleIdentity still answers null for the ISA",
  resolvePlatformRoleIdentity("system", "ai_isa_system") === null)

check("ISA-IDENTITY-BOTH-COLUMNS: the ISA identity requires user_type='system' AND platform_role='ai_isa_system'",
  isAiIsaSystemIdentity("system", "ai_isa_system") === true &&
  isAiIsaSystemIdentity("agent", "ai_isa_system") === false &&
  isAiIsaSystemIdentity("system", null) === false)
check("ISA-IDENTITY-CONSTANT: ISA_SERVICE_IDENTITY satisfies its own predicate",
  isAiIsaSystemIdentity(ISA_SERVICE_IDENTITY.userType, ISA_SERVICE_IDENTITY.platformRole) === true)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── RULING A(ii): ONE TENANT AT A TIME — the load-bearing half ──")

const oneTenant = resolveIsaActingScope({ ...ISA_SERVICE_IDENTITY, brokerageIds: [B1], where: "sim" })
check("ONE-TENANT-ACCEPTED (positive control): a single tenant resolves to that tenant",
  oneTenant.kind === "tenant" && scopeBrokerageId(oneTenant) === B1)

const twoTenants = refusal(() =>
  resolveIsaActingScope({ ...ISA_SERVICE_IDENTITY, brokerageIds: [B1, B2], where: "sim" }))
check("TWO-TENANTS-REFUSED: two tenants in one ISA scope is refused, not filtered",
  twoTenants.refused && /ONE TENANT AT A TIME/.test(twoTenants.message), twoTenants.message)

check("DUPLICATE-IS-ONE-TENANT: the same tenant twice is still one tenant",
  scopeBrokerageId(resolveIsaActingScope({ ...ISA_SERVICE_IDENTITY, brokerageIds: [B1, B1, " " + B1 + " "], where: "sim" })) === B1)

const platformRun = resolveIsaActingScope({
  ...ISA_SERVICE_IDENTITY, brokerageIds: [], platformReason: "nightly stale sweep", where: "sim",
})
check("PLATFORM-ACCEPTED (positive control): the ISA may act for the PLATFORM with a stated reason",
  platformRun.kind === "platform" && /nightly stale sweep/.test((platformRun as { reason: string }).reason))

const unset = refusal(() => resolveIsaActingScope({ ...ISA_SERVICE_IDENTITY, brokerageIds: [], where: "sim" }))
check("UNSET-REFUSED: no tenant and no platform reason REFUSES (a missing tenant is not the platform)",
  unset.refused && /explicit and singular/.test(unset.message), unset.message)

const blankOnly = refusal(() =>
  resolveIsaActingScope({ ...ISA_SERVICE_IDENTITY, brokerageIds: [null, undefined, "", "   "], where: "sim" }))
check("BLANK-IDS-REFUSED: a list of blanks is the unset case, not an unfiltered platform read",
  blankOnly.refused, blankOnly.message)

const both = refusal(() => resolveIsaActingScope({
  ...ISA_SERVICE_IDENTITY, brokerageIds: [B1], platformReason: "sweep", where: "sim",
}))
check("PLATFORM-AND-TENANT-REFUSED: acting for the platform AND a tenant at once is ambiguous",
  both.refused && /separate units of work/.test(both.message), both.message)

const notIsa = refusal(() =>
  resolveIsaActingScope({ userType: "admin", platformRole: "superadmin", brokerageIds: [B1], where: "sim" }))
check("NON-ISA-REFUSED: even a SUPERADMIN may not mint an ISA acting scope",
  notIsa.refused && /only the AI ISA service actor/.test(notIsa.message), notIsa.message)

const malformed = refusal(() =>
  resolveIsaActingScope({ userType: "agent", platformRole: "ai_isa_system", brokerageIds: [B1], where: "sim" }))
check("MALFORMED-ISA-REFUSED: half an ISA identity fails closed",
  malformed.refused, malformed.message)

console.log("\n── the platform-wide ISA run is a SEQUENCE of single-tenant scopes ──")
const queue = isaTenantWorkQueue({ ...ISA_SERVICE_IDENTITY, brokerageIds: [B1, B2, B1, "", null], where: "sim" })
check("QUEUE-SPLITS: 5 raw ids (2 distinct) become 2 single-tenant scopes",
  queue.length === 2 && queue.every((s) => s.kind === "tenant"))
check("QUEUE-EACH-IS-ONE-TENANT: every element carries exactly one brokerage id",
  queue.map(scopeBrokerageId).join(",") === `${B1},${B2}`)
check("QUEUE-EMPTY-IS-EMPTY (negative control): no tenants yields an EMPTY queue, never a platform scope",
  isaTenantWorkQueue({ ...ISA_SERVICE_IDENTITY, brokerageIds: [], where: "sim" }).length === 0)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── RULING B: AI customizations resolve PER USER, agent → team → brokerage → platform ──")

const full = isaSettingsCascade({ agentId: A1, teamId: T1, brokerageId: B1 })
check("CASCADE-ORDER: agent → team → brokerage → platform, most specific first",
  full.map((o) => o.ownerType).join(" → ") === "agent → team → brokerage → platform")
check("CASCADE-AGENT-FIRST: the agent's OWN row is consulted before the brokerage's",
  full[0].ownerType === "agent" && full[0].ownerId === A1)

const other = isaSettingsCascade({ agentId: A2, teamId: T1, brokerageId: B1 })
check("PER-USER-DISTINCT: two agents in the same brokerage get DIFFERENT agent-tier owners",
  full[0].ownerId === A1 && other[0].ownerId === A2 && full[0].ownerId !== other[0].ownerId)

const noAgent = isaSettingsCascade({ brokerageId: B1 })
check("NO-AGENT-NO-AGENT-TIER (negative control): a scope with no agent emits no agent tier",
  noAgent.map((o) => o.ownerType).join(",") === "brokerage,platform")
check("BLANK-AGENT-IS-NO-AGENT: a blank agent id is not an unfiltered agent read",
  isaSettingsCascade({ agentId: "   ", brokerageId: B1 }).some((o) => o.ownerType === "agent") === false)
check("PLATFORM-TIER-ALWAYS-LAST: the platform tier is present and carries no id",
  full[full.length - 1].ownerType === "platform" && full[full.length - 1].ownerId === null)

console.log("\n── ONE cascade order, shared with the credential store (§6) ──")
check("ONE-ORDER: scopeCascade for an internal actor follows OWNER_CASCADE_ORDER",
  scopeCascade({ agentUserId: "u", teamId: "t", brokerageId: "b" }).map((o) => o.ownerType).join(",") ===
  "agent,team,brokerage,platform")
check("ONE-ORDER-LEAF (positive control): a vendor is still that actor → platform",
  scopeCascade({ vendorId: "v", brokerageId: "b" }).map((o) => o.ownerType).join(",") === "vendor,platform")
check("ONE-ORDER-SHARED: the ISA settings cascade is a subsequence of the SAME order",
  full.map((o) => o.ownerType).join(",") === INTERNAL_CASCADE_ORDER.join(","))
check("ONE-ORDER-CANON: OWNER_CASCADE_ORDER is most-specific-first and ends at platform",
  OWNER_CASCADE_ORDER[OWNER_CASCADE_ORDER.length - 1] === "platform")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── the reads themselves: keyed by the owner, and honest about refusals ──")
// Comments STRIPPED (a tombstone is not a call site) but string literals KEPT:
// every assertion below turns on a literal the code must contain — the owner
// column, the "unreadable" discriminant, the `.select("id")` on the write.
const resolver = codeKeepStrings("lib/ai-isa/resolve-isa-settings.ts")

// SCOPED TO readOwnerSettings ON PURPOSE. This assertion was written bare —
// /q = q.eq(col, owner.ownerId)/ anywhere in the file — and MUTATION TESTING
// caught it passing while the READ's predicate was deleted: the identical line in
// `writeIsaSettings` satisfied the regex on its own. One assertion covering two
// spellings of one idea is the blindness CLAUDE.md §2 names, and it would have
// reported a clean bill of health over a resolver that served every user the same
// row. The read function is now delimited explicitly.
const readFn = /async function readOwnerSettings[\s\S]*?\n\}/.exec(resolver)?.[0] ?? ""
check("READ-FN-FOUND (positive control): readOwnerSettings is locatable, so the checks below scan real code",
  readFn.length > 200 && /from\("ai_isa_settings"\)/.test(readFn))
check("READ-KEYED-BY-OWNER: the ROW READ itself applies the owner column predicate",
  /q\s*=\s*q\.eq\(\s*col\s*,\s*owner\.ownerId\s*\)/.test(readFn))
check("READ-REFUSES-UNFILTERED: a non-platform tier with no id REFUSES rather than reading unfiltered",
  /if\s*\(\s*!owner\.ownerId\s*\)\s*\{[\s\S]{0,200}?status:\s*"unreadable"/.test(resolver))
check("READ-ERROR-FIRST: the error is destructured and inspected before the data",
  /const\s*\{\s*data\s*,\s*error\s*\}\s*=\s*await\s+q/.test(resolver) &&
  /if\s*\(\s*error\s*\)\s*return\s*\{\s*status:\s*"unreadable"/.test(resolver))
check("CASCADE-STOPS-ON-UNREADABLE: an unreadable tier stops the walk instead of descending",
  /read\.status\s*===\s*"unreadable"[\s\S]{0,300}?return\s*\{\s*status:\s*"unreadable"/.test(resolver))
check("WRITE-COUNTS-ROWS: the update selects and COUNTS what came back (a no-match UPDATE also resolves)",
  /\.select\(\s*"id"\s*\)/.test(resolver) && /data\.length\s*===\s*0/.test(resolver))
check("CAPABILITY-FAILS-CLOSED: an unreadable tier answers false, not true",
  /isIsaCapabilityEnabledForScope[\s\S]{0,900}?result\.status\s*===\s*"unreadable"[\s\S]{0,400}?return\s+false/.test(resolver))
check("NO-SECOND-WALKER: the resolver imports the shared cascade order rather than retyping it",
  /INTERNAL_CASCADE_ORDER/.test(resolver) && /@\/lib\/connections\/scope/.test(resolver))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── the wiring: the rulings reach code that actually decides something ──")

const cron = code("app/api/cron/stale-contact-monitor/route.ts")
check("WIRED-CRON-QUEUE: the platform-wide ISA sweep goes through isaTenantWorkQueue",
  /isaTenantWorkQueue\s*\(/.test(cron))
check("WIRED-CRON-SINGULAR: the loop body takes its brokerage from the SCOPE, not a raw id",
  /for\s*\(\s*const\s+isaScope\s+of\s+isaWork\s*\)/.test(cron) &&
  /scopeBrokerageId\s*\(\s*isaScope\s*\)/.test(cron))
check("WIRED-CRON-NO-RAW-LOOP (negative control): the old raw `for (const brokerage of brokerages)` is gone",
  !/for\s*\(\s*const\s+brokerage\s+of\s+brokerages/.test(cron))

const autoSend = code("lib/predictive-listing/auto-send.ts")
check("WIRED-PLS-PER-AGENT: PLS auto-send resolves the capability for THIS AGENT",
  /isIsaCapabilityEnabledForScope\s*\(\s*isaScope\s*,/.test(autoSend) &&
  /const\s+isaScope\s*=\s*\{\s*agentId\s*,\s*brokerageId\s*\}/.test(autoSend))
check("WIRED-PLS-NOT-THE-ACTION (negative control): it no longer routes through the session-bound server action",
  !/actions\/ai-isa-settings/.test(codeKeepStrings("lib/predictive-listing/auto-send.ts")))

const resonance = code("lib/sphere-resonance/run-resonance-scan.ts")
check("WIRED-RESONANCE-PER-AGENT: the resonance scan resolves auto-touch per contact's own agent",
  /autoTouchAllowed\s*\(\s*c\.agent_id\s*\)/.test(resonance))
check("WIRED-RESONANCE-MEMOIZED: resolved once per distinct agent, not once per contact",
  /autoTouchByAgent/.test(resonance))

const action = code("app/actions/ai-isa-settings.ts")
const settingsUi = code("app/dashboard/ai-isa/settings/page.tsx")
check("WIRED-ACTION-ON-SURVIVOR: the settings action delegates to the resolver",
  /resolveIsaSettings\s*\(/.test(action) && /writeIsaSettings\s*\(/.test(action))
check("WIRED-ACTION-NO-BLOB (negative control): the retired global_settings blob store is gone",
  !/additional_settings/.test(action))
check("WIRED-ACTION-PER-USER-ENTRY: a session-derived per-actor read exists and takes NO tenant argument",
  /export\s+async\s+function\s+getAIISASettingsResolution\s*\(\s*\)/.test(action))
check("WIRED-UI-PER-USER: the ISA settings screen offers the per-user tier and names which tier answered",
  /getAIISASettingsResolution\s*\(\s*\)/.test(settingsUi) &&
  /saveAIISASettingsForOwner\s*\(\s*saveScope\s*,/.test(settingsUi) &&
  /setResolvedFrom/.test(settingsUi))
check("WIRED-UI-UNREADABLE-IS-NOT-EMPTY (negative control): an unreadable tier is surfaced, not rendered as defaults",
  /status\s*===\s*"unreadable"|status\s*===\s*'unreadable'/.test(codeKeepStrings("app/dashboard/ai-isa/settings/page.tsx")))
check("WIRED-ACTION-OWNER-FROM-SESSION: the per-owner write takes ids from the session, never from the caller",
  /saveAIISASettingsForOwner\s*\(\s*\n?\s*ownerType:\s*IsaSettingsOwnerType/.test(action) &&
  /ownerId:\s*ctx\.agentId/.test(action))
check("WIRED-ACTION-NO-DEAD-SUPERADMIN (negative control): the dead user_type==='superadmin' arm is not re-typed",
  !/ctx\.role\s*!==\s*.superadmin./.test(action) && /requireSuperadmin\s*\(/.test(action))

const tools = codeKeepStrings("lib/ai-isa/tools.ts")
check("WIRED-TOOLS-GATED: the capability catalog finally governs ISA tool dispatch, per user",
  /isIsaCapabilityEnabledForScope\(\s*\{\s*agentId:\s*ctx\.agentId\s*,\s*brokerageId:\s*ctx\.brokerageId\s*\}/.test(tools) &&
  /GATED_TOOLS/.test(tools))
// The GATED map is EXTRACTED and inspected on its own, so "escalate is not
// gated" is a statement about the map rather than about the whole file — a bare
// negative over the file would be satisfied by the tool's own definition being
// renamed, and would keep passing if escalate_to_agent were added to the map.
const gatedBlock = /const GATED_TOOLS[^{]*\{([\s\S]*?)\}/.exec(tools)?.[1] ?? ""
check("GATED-MAP-FOUND (positive control): the gated map is locatable and non-empty",
  /qualify_lead/.test(gatedBlock) && /book_appointment/.test(gatedBlock))
check("WIRED-TOOLS-ESCALATION-NOT-SWITCHABLE: getting a HUMAN involved is never a toggle",
  !/escalate_to_agent/.test(gatedBlock))
check("WIRED-TOOLS-DNC-NOT-SWITCHABLE: the TCPA opt-out tool is not gateable (compliance is not a preference)",
  !/mark_do_not_contact/.test(gatedBlock))
check("WIRED-TOOLS-GATED-ARE-DEFAULT-ON: both gated tools map to catalog capabilities that default to ENABLED",
  ISA_CAPABILITY_CATALOG.filter((c) => /qualify_lead|book_appointment/.test(c.key)).every((c) => c.defaultEnabled))
check("WIRED-TOOLS-ABSENT-NOT-FAILING (positive control): a disabled tool is OMITTED from the map, not left to fail inside execute",
  /if\s*\(allowed\)\s*out\[name\]\s*=\s*def/.test(tools))

const roster = code("lib/platform/platform-staff-roster.ts")
check("SURVIVOR-EXTENDED-NOT-FORKED: the actor predicate lives in the roster survivor",
  /export\s+function\s+isPlatformActorRole/.test(roster) &&
  /export\s+function\s+isAiIsaSystemIdentity/.test(roster))

const scope = code("lib/ai-isa/isa-acting-scope.ts")
check("SCOPE-REUSES-TENANTSCOPE: the ISA scope speaks the repo's TenantScope vocabulary",
  /tenantScope\s*\(/.test(scope) && /platformScope\s*\(/.test(scope) && /TenantScopeRefusal/.test(scope))
check("SCOPE-TAKES-A-LIST: the input is plural so the plural defect is expressible and catchable",
  /brokerageIds:\s*readonly/.test(scope))

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(` FAILED: ${failures.join(", ")}`)
  console.log(" ❌ ISA_SCOPE_PER_USER_FAIL")
  process.exit(1)
}
console.log(" ✅ ISA_SCOPE_PER_USER_PASS — one tenant at a time; customizations per user")
