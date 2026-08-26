#!/usr/bin/env tsx
/**
 * scripts/act-as-write-seam-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ACT-AS WRITE SEAM (task #181) — proves the platform-wide seam that lets a
 * platform-staff member with an ACTIVE FULL impersonation grant write into a
 * tenant, while a 'read_only' grant NEVER gains the service client and the real
 * staff actor stays auditable.
 *
 *   1. PURE decision table: decideWriteChannel() — cookie normally, service ONLY
 *      under an active FULL grant, refusal for read_only/unknown-mode/unauth.
 *   2. Import-pinned call-time re-validation: resolveWriteContext() calls
 *      getAgentContext() fresh (no ctx parameter to trust), which consults
 *      resolveActiveImpersonation → isSessionActive (ended_at + expires_at).
 *   3. Wired actions ride the seam (tasks, contacts, listings) with tenant
 *      predicates and zero-row refusals; audit stamping where columns exist
 *      (contact_notes.author_user_id, lifecycle_events.actor_user_id,
 *      tier-assignment actorUserId).
 *   4. Negative controls both ways: read_only never yields service; the pure
 *      expiry check refuses ended/expired sessions; unwired reads unchanged.
 *
 * NOT REGISTERED in package.json (per task rules).
 * Run: npx tsx scripts/act-as-write-seam-simulator.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { decideWriteChannel, decideClaimedTenant } from "../lib/platform/acting-context"
import { isSessionActive } from "../lib/platform/impersonation"
import { blankStrings, stripComments } from "./strip-comments"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Act-as write seam verified — full grants write through service, read_only never does, real actor auditable.")
  console.log(" ACT_AS_WRITE_SEAM_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Act-as write seam simulator (task #181)")
  console.log("══════════════════════════════════════════════════\n")

  // ── 1. PURE decision table ─────────────────────────────────────────────────
  console.log("[decideWriteChannel — pure decision table]")
  check("unauthenticated → refused:unauthenticated",
    JSON.stringify(decideWriteChannel({ isAuthenticated: false })) === JSON.stringify({ channel: "refused", reason: "unauthenticated" }))
  check("normal tenant user → cookie (RLS) client",
    decideWriteChannel({ isAuthenticated: true }).channel === "cookie")
  check("normal user with stray mode field but NOT impersonating → cookie",
    decideWriteChannel({ isAuthenticated: true, isImpersonating: false, impersonationMode: "full" }).channel === "cookie")
  check("ACTIVE FULL impersonation → service client",
    decideWriteChannel({ isAuthenticated: true, isImpersonating: true, impersonationMode: "full" }).channel === "service")
  const ro = decideWriteChannel({ isAuthenticated: true, isImpersonating: true, impersonationMode: "read_only" })
  check("read_only impersonation → REFUSED (never the service client)",
    ro.channel === "refused" && (ro as any).reason === "read_only")
  check("unknown/absent mode while impersonating → REFUSED (fail closed, not service)",
    decideWriteChannel({ isAuthenticated: true, isImpersonating: true, impersonationMode: null }).channel === "refused" &&
    decideWriteChannel({ isAuthenticated: true, isImpersonating: true, impersonationMode: "elevated" as any }).channel === "refused" &&
    decideWriteChannel({ isAuthenticated: true, isImpersonating: true }).channel === "refused")
  check("unauthenticated + impersonation flags forged → still refused:unauthenticated",
    (decideWriteChannel({ isAuthenticated: false, isImpersonating: true, impersonationMode: "full" }) as any).reason === "unauthenticated")

  // ── 2. Grant re-validation at call time (import-pinned) ────────────────────
  console.log("\n[resolveWriteContext — call-time re-validation, import-pinned]")
  const acting = read("lib/platform/acting-context.ts")
  check("helper exists and is exported",
    /export async function resolveWriteContext\(\)/.test(acting))
  check("takes NO caller-supplied context (nothing stale to trust)",
    /resolveWriteContext\(\): Promise<WriteContext>/.test(acting) && !/resolveWriteContext\(\s*ctx/.test(acting))
  check("imports getAgentContext (the impersonation-resolving identity seam)",
    /import \{ getAgentContext \} from "@\/lib\/identity\/get-agent-context"/.test(acting))
  const bodyStart = acting.indexOf("export async function resolveWriteContext")
  const body = acting.slice(bodyStart)
  check("calls getAgentContext() fresh inside the helper body",
    /await getAgentContext\(\)/.test(body))
  check("routes through the pure decision table (one vocabulary)",
    /decideWriteChannel\(ctx\)/.test(body))
  // ── the RULE, not the expression (§2: "do not pin an assertion to a WAYPOINT") ──
  // These two checks used to match the literal
  //     /decision\.channel === "service" \? createServiceClient\(\)/
  // inside resolveWriteContext's own body. That is a waypoint: it could only pass while
  // the ternary lived at that exact spot, and it went red the moment the client
  // construction was lifted into the ONE resolver both entry points share (§6) — a
  // refactor that made the seam MORE correct, not less. The rule is: the service client
  // is constructed on the "service" channel and nowhere else, and the refusal returns
  // before any client is built. Both are asserted wherever the construction actually is.
  const CHANNEL_RESOLVER = "resolveClientAndAgent"
  const resolverStart = acting.indexOf(`async function ${CHANNEL_RESOLVER}`)
  const resolverBody = resolverStart === -1 ? "" : acting.slice(resolverStart, acting.indexOf("\n}\n", resolverStart))
  check("the channel→client mapping exists in exactly one place",
    resolverStart !== -1 &&
    // …and resolveWriteContext does not build a second one behind its back.
    !/createServiceClient\(\)/.test(body.slice(0, body.indexOf("\n}\n"))))
  check("service client only on the 'service' channel",
    /channel === "service" \? createServiceClient\(\)/.test(resolverBody) &&
    // exactly one construction of each — no second, unguarded path
    (resolverBody.match(/createServiceClient\(\)/g) ?? []).length === 1 &&
    (resolverBody.match(/createClient\(\)/g) ?? []).length === 1)
  check("refusal branch precedes any client construction",
    body.indexOf(`decision.channel === "refused"`) !== -1 &&
    body.indexOf(`decision.channel === "refused"`) < body.indexOf(`${CHANNEL_RESOLVER}(ctx, decision.channel)`))
  check("the writer hands the resolver the DECIDED channel, never a hardcoded one",
    new RegExp(`${CHANNEL_RESOLVER}\\(ctx, decision\\.channel\\)`).test(body))
  check("FAIL CLOSED — the resolution is wrapped so a throwing client constructor refuses, not passes",
    /^\s*try \{/m.test(body.slice(0, body.indexOf("getAgentContext"))) &&
    /\} catch \{[\s\S]{0,400}?ok: false/.test(body))
  check("read_only refusal uses the standard error string",
    /READ_ONLY_ACTING_ERROR/.test(body))
  check("actorUserId = impersonatorUserId ?? userId (real actor for audit)",
    /actorUserId: ctx\.impersonatorUserId \?\? ctx\.userId/.test(acting))

  const gac = read("lib/identity/get-agent-context.ts")
  check("getAgentContext consults resolveActiveImpersonation (import-pinned)",
    /import \{ resolveActiveImpersonation \} from "@\/lib\/platform\/impersonation"/.test(gac) &&
    /await resolveActiveImpersonation\(/.test(gac))
  check("impersonation only for platform-staff identities (defence in depth)",
    /isPlatformStaffIdentity\(userType, platformRole\)/.test(gac))

  const imp = read("lib/platform/impersonation.ts")
  check("resolveActiveImpersonation re-checks liveness via isSessionActive",
    /isSessionActive\(s as any, now\)/.test(imp))
  check("session query excludes ended sessions at the database (.is(\"ended_at\", null))",
    /\.is\("ended_at", null\)/.test(imp))

  // Pure negative controls on liveness — an ended or expired grant is dead.
  console.log("\n[isSessionActive — pure liveness negative controls]")
  const now = new Date("2026-08-18T12:00:00Z")
  check("live session (not ended, future expiry) → active",
    isSessionActive({ ended_at: null, expires_at: "2026-08-18T12:30:00Z" }, now) === true)
  check("ended session → NOT active (exit revokes writes immediately)",
    isSessionActive({ ended_at: "2026-08-18T11:59:00Z", expires_at: "2026-08-18T12:30:00Z" }, now) === false)
  check("expired session → NOT active (TTL is not a suggestion)",
    isSessionActive({ ended_at: null, expires_at: "2026-08-18T11:59:59Z" }, now) === false)
  check("garbage expiry → NOT active (fail closed)",
    isSessionActive({ ended_at: null, expires_at: "not-a-date" }, now) === false)

  // ── 3. Wired actions ride the helper ───────────────────────────────────────
  console.log("\n[wired actions — tasks.ts]")
  const tasks = read("app/actions/tasks.ts")
  check("imports the seam", /resolveWriteContext.*@\/lib\/platform\/acting-context/s.test(tasks))
  check("names the seam for future adopters", tasks.includes("ACT-AS WRITE SEAM"))
  for (const fn of ["updateTask", "completeTask", "deleteTask", "createTask"]) {
    const start = tasks.indexOf(`export async function ${fn}`)
    const seg = tasks.slice(start, tasks.indexOf("export async function", start + 10) === -1 ? undefined : tasks.indexOf("export async function", start + 10))
    check(`${fn} gates through resolveWriteContext and destructures refusal`,
      start !== -1 && /await resolveWriteContext\(\)/.test(seg) && /if \(!ctx\.ok\) return \{ success: false, error: ctx\.error \}/.test(seg))
    check(`${fn} writes through the seam's db`, /ctx\.db/.test(seg))
  }
  check("updateTask carries the tenant predicate (gate-then-service)",
    /\.update\(updates\)\s*\.eq\("id", params\.taskId\)\s*\.eq\("brokerage_id", ctx\.brokerageId\)/.test(tasks))
  check("deleteTask observes affected rows — zero rows is a refusal, not success",
    /\.delete\(\)\s*\.eq\("id", taskId\)\s*\.eq\("brokerage_id", ctx\.brokerageId\)\s*\.select\("id"\)/.test(tasks) &&
    /if \(!deleted \|\| deleted\.length === 0\)/.test(tasks))
  check("update/complete treat zero rows as refusal (maybeSingle + null check)",
    (tasks.match(/if \(!data\) return \{ success: false, error: "Task not found in your brokerage" \}/g) ?? []).length >= 2)
  check("createTask resolves assignee/tenant from the seam context, not a bare cookie read",
    /const assignee = params\.assignedTo \?\? ctx\.agentId/.test(tasks) &&
    !/callerAgent/.test(tasks))

  console.log("\n[wired actions — contacts.ts]")
  const contacts = read("app/actions/contacts.ts")
  check("imports the seam", /resolveWriteContext.*acting-context/s.test(contacts))
  check("names the seam", contacts.includes("ACT-AS WRITE SEAM"))
  for (const fn of ["createContact", "updateContact", "archiveContact", "addContactNote"]) {
    const start = contacts.indexOf(`export async function ${fn}`)
    const next = contacts.indexOf("export async function", start + 10)
    const seg = contacts.slice(start, next === -1 ? undefined : next)
    check(`${fn} gates through resolveWriteContext (read_only refused before kernel/service write)`,
      start !== -1 && /await resolveWriteContext\(\)/.test(seg) && /if \(!ctx\.ok\) return \{ success: false, error: ctx\.error \}/.test(seg))
  }
  check("addContactNote stamps author_user_id with the REAL actor",
    /author_user_id: ctx\.actorUserId/.test(contacts))
  check("addContactNote writes through the seam's db",
    /const supabase = ctx\.db/.test(contacts))
  check("update/archive pass actorUserId into the kernel audit lane",
    (contacts.match(/actorUserId: ctx\.actorUserId/g) ?? []).length >= 2)

  const crm = read("lib/kernel/crm.ts")
  check("kernel updateContactRecord accepts actorUserId and stamps lifecycle_events.actor_user_id",
    /actorUserId\?: string \| null/.test(crm) &&
    (crm.match(/actor_user_id: params\.actorUserId \?\? null/g) ?? []).length >= 2)

  console.log("\n[wired actions — listings.ts]")
  const listings = read("app/actions/listings.ts")
  check("gate resolves through the acting context (impersonation-aware tenant, not the raw staff users row)",
    /resolveActingContext\(\)/.test(listings) && !/from\("users"\)\.select\("brokerage_id"\)/.test(listings))
  check("names the seam", listings.includes("ACT-AS WRITE SEAM"))
  check("updateListing refuses read_only before writing",
    /if \(auth\.readOnly\) return \{ success: false, error: READ_ONLY_ACTING_ERROR \}/.test(listings))
  // `deleteListing` is GONE — a listing is RETAINED, never destroyed (owner's
  // ruling). SURVIVOR: archiveListing, app/actions/listings.ts. The seam pin
  // follows the survivor rather than being dropped: the archive is still a
  // WRITE, so a read_only act-as grant must still refuse it. `unarchiveListing`
  // is pinned too — it is the other half of the same write and was the easier
  // one to leave ungated.
  const delStart = listings.indexOf("export async function archiveListing")
  check("archiveListing was located (deleteListing's survivor)", delStart >= 0)
  const delSeg = delStart < 0 ? "" : listings.slice(delStart, listings.indexOf("export async function", delStart + 10))
  check("archiveListing refuses read_only before writing",
    /if \(auth\.readOnly\) return \{ success: false, error: READ_ONLY_ACTING_ERROR \}/.test(delSeg))
  const unStart = listings.indexOf("export async function unarchiveListing")
  const unSeg = unStart < 0 ? "" : listings.slice(unStart, listings.indexOf("export async function", unStart + 10))
  check("unarchiveListing refuses read_only before writing",
    unStart >= 0 && /if \(auth\.readOnly\) return \{ success: false, error: READ_ONLY_ACTING_ERROR \}/.test(unSeg))
  check("updateListing audit lane names the REAL actor (actorUserId, not the impersonated identity)",
    /const actorUserId = auth\.actorUserId/.test(listings))
  check("negative control: getListingById (read) does NOT refuse read_only",
    (() => {
      const s = listings.indexOf("export async function getListingById")
      const seg = listings.slice(s, listings.indexOf("export async function", s + 10))
      return s !== -1 && !/readOnly/.test(seg)
    })())

  // ── W2. RULING WAVE — global-settings kernel gate rides the seam ──────────
  console.log("\n[closure 1 — lib/kernel/global-settings.ts requireBrokerAdmin]")
  const gsk = read("lib/kernel/global-settings.ts")
  check("requireBrokerAdmin accepts an injected ctx-resolved db (act-as tenant resolution)",
    /async function requireBrokerAdmin\(\s*userId: string,\s*db\?: SupabaseLike/.test(gsk) &&
    /const supabase = db \?\? \(await createClient\(\)\)/.test(gsk))
  // ASSERT THE RULE, NOT THE SPELLING (CLAUDE.md §2 — "do not pin an assertion to a
  // WAYPOINT"). This used to pin the literal `userType === "superadmin" ||
  // platformRole === "superadmin"`, so it could only pass while the test was
  // RE-SPELLED here — i.e. it failed the moment the duplicate was merged onto the
  // one survivor, which is the fix, not a regression. The rule is: the gate admits
  // the brokerage-admin roster OR the platform superadmin, and the superadmin half
  // is decided from BOTH identity columns by the single survivor.
  // STRIPPED, NOT RAW. The roster's header quotes the both-columns expression in
  // prose (it is the tombstone §1 requires), so a raw read is satisfied by the
  // COMMENT and stays green while the code decays to one column — proved by
  // mutation, 2026-08-24. CLAUDE.md §2: "a TOMBSTONE IS NOT A CALL SITE".
  const rosterSrc = stripComments(read("lib/platform/platform-staff-roster.ts"))
  check("admin predicate itself unchanged (roster + platform-superadmin both-columns test)",
    /BROKERAGE_ADMIN_USER_TYPES = new Set\(\["admin", "broker", "broker_owner"\]\)/.test(gsk) &&
    /isPlatformSuperadminIdentity\(userType, platformRole\)/.test(gsk) &&
    /from "@\/lib\/platform\/platform-staff-roster"/.test(gsk) &&
    /if \(!BROKERAGE_ADMIN_USER_TYPES\.has\(userType\) && !isPlatformSuperadmin\)/.test(gsk))
  check("…and the survivor it delegates to still reads BOTH identity columns",
    /export function isPlatformSuperadminIdentity\(\s*\n?\s*userType: string \| null \| undefined,\s*\n?\s*platformRole: string \| null \| undefined,?\s*\n?\s*\): boolean/.test(rosterSrc) &&
    /userType === "superadmin" \|\| platformRole === "superadmin"/.test(rosterSrc))
  check("both kernel entry points thread the db into the gate",
    (gsk.match(/requireBrokerAdmin\(params\.userId, params\.db\)/g) ?? []).length === 2)
  const ugs = read("app/actions/settings/update-global-settings.ts")
  check("update-global-settings action gates through the seam (import-pinned) and passes ctx.userId + ctx.db",
    /import \{ resolveWriteContext \} from '@\/lib\/platform\/acting-context'/.test(ugs) &&
    /const ctx = await resolveWriteContext\(\)/.test(ugs) &&
    /if \(!ctx\.ok\) return \{ error: ctx\.error \}/.test(ugs) &&
    /kernelUpdateGlobalSettings\(\{ userId: ctx\.userId, db: ctx\.db/.test(ugs) &&
    !/auth\.getUser\(\)/.test(ugs))
  const ggs = read("app/actions/settings/get-global-settings.ts")
  check("get-global-settings (read) rides resolveActingContext — read_only may still SEE",
    /resolveActingContext/.test(ggs) && /userId: ctx\.userId, db: ctx\.db/.test(ggs) && !/resolveWriteContext/.test(ggs))

  // ── W2. RULING WAVE — brokerage identity (finance-gated) ──────────────────
  console.log("\n[closure 2 — brokerage-identity.ts: full grant walks it, gate on the IMPERSONATED identity]")
  const bi = read("app/actions/settings/brokerage-identity.ts")
  check("writes gate through resolveWriteContext (import-pinned, refusal destructured)",
    /import \{ resolveActingContext, resolveWriteContext \} from '@\/lib\/platform\/acting-context'/.test(bi) &&
    /const seam = await resolveWriteContext\(\)\s*\n\s*if \(!seam\.ok\) return \{ data: null, error: seam\.error \}/.test(bi))
  check("the SAME finance gate, evaluated against the IMPERSONATED identity (acting.userId/userType)",
    /resolveBrokerageFinanceAdmin\(\s*supabase,\s*acting\.userId,\s*\{ user_type: acting\.userType, brokerage_id: brokerageId \},?\s*\)/.test(bi))
  check("canEdit is authority-of-the-seat AND not read_only (never exceeds; read_only never writes)",
    /canEdit: admin\.isFinanceAdmin && !acting\.readOnly/.test(bi))
  check("zero-rows-as-refusal survives on the identity write (.select('id') + length check)",
    /\.select\('id'\)/.test(bi) && /if \(!saved \|\| saved\.length === 0\)/.test(bi))
  check("negative control: tenant still resolves from the session context, never a payload field",
    !/brokerageId = \(?input/.test(bi))

  // ── W2. RULING WAVE — assertCanActOnContact closure ───────────────────────
  console.log("\n[closure 3 — lib/auth/contact-access.ts: staff write only under FULL, read_only never writes]")
  const ca = read("lib/auth/contact-access.ts")
  check("identity resolves through getAgentContext (grant re-validated on the call, import-pinned)",
    /import \{ getAgentContext \} from "@\/lib\/identity\/get-agent-context"/.test(ca) &&
    /const ctx = await getAgentContext\(\)/.test(ca))
  check("intent defaults to WRITE (fail closed); read surfaces opt in",
    /const intent = opts\?\.intent \?\? "write"/.test(ca))
  check("read_only impersonation refused for writes BEFORE the contact lookup, standard error",
    /if \(intent === "write" && ctx\.isImpersonating && ctx\.impersonationMode !== "full"\)/.test(ca) &&
    /READ_ONLY_ACTING_ERROR/.test(ca) &&
    ca.indexOf('ctx.impersonationMode !== "full"') < ca.indexOf('.from("contacts")'))
  check("non-impersonating staff: READ passes, WRITE refused (no raw-staff write lane)",
    /if \(isStaff\) \{\s*\n\s*if \(intent === "read"\) return \{ ok: true/.test(ca) &&
    /acting as the tenant with full access/.test(ca))
  check("the tenant tree is evaluated on the EFFECTIVE identity (ctx.*, i.e. the impersonated seat)",
    /ctx\.userType === "agent"/.test(ca) &&
    /c\.agent_id === agentId/.test(ca) &&
    /BROKERAGE_ROLES\.has\(ctx\.userType\) && ctx\.brokerageId && ctx\.brokerageId === c\.brokerage_id/.test(ca))
  check("negative control: the old unconditional staff pass is gone",
    !/profile\?\.user_type === "superadmin" \|\| isPlatformStaffRole\(profile\?\.platform_role\)\) \{\s*\n\s*return \{ ok: true/.test(ca))
  check("real actor surfaced for audit (actorUserId = impersonator ?? user)",
    /actorUserId = ctx\.impersonatorUserId \?\? ctx\.userId/.test(ca))
  check("read callers pass intent:'read' (contact page + strategy-session getter)",
    /assertCanActOnContact\(contactId, \{ intent: "read" \}\)/.test(read("app/crm/contacts/[contactId]/page.tsx")) &&
    /assertCanActOnContact\(input\.contactId, \{ intent: "read" \}\)/.test(read("app/actions/strategy-session.ts")))
  check("write callers keep the fail-closed default (no intent:'read' in the write lanes)",
    !/intent: "read"/.test(read("app/actions/contacts/update-addressing.ts")) &&
    !/intent: "read"/.test(read("app/actions/contacts/last-promise.ts")) &&
    !/intent: "read"/.test(read("app/actions/contact-quick-actions.ts")))

  // ── W2. ADOPTION TRANCHE ──────────────────────────────────────────────────
  console.log("\n[adoption tranche — settings/* + user-profile + notifications ride the seam]")
  const SEAM_IMPORT = /import \{[^}]*resolveWriteContext[^}]*\} from ["']@\/lib\/platform\/acting-context["']/
  const WRITERS: Array<[string, string]> = [
    ["app/actions/settings/global-settings-actions.ts", "updateWidgetScope"],
    ["app/actions/settings/create-commission-structure.ts", "createCommissionStructure"],
    ["app/actions/settings/delete-commission-structure.ts", "deleteCommissionStructure"],
    ["app/actions/settings/create-email-template.ts", "createEmailTemplate"],
    ["app/actions/settings/update-email-template.ts", "updateEmailTemplate"],
    ["app/actions/settings/integrations.ts", "upsertPlatformCredential"],
    ["app/actions/settings/listing-task-templates.ts", "updateListingTaskTemplate"],
    ["app/actions/settings/manage-notification-rules.ts", "createRule"],
    ["app/actions/settings/update-notification-rules.ts", "updateNotificationRules"],
    ["app/actions/settings/provider-settings-actions.ts", "saveProviderOverride"],
    ["app/actions/settings/reputation-preferences.ts", "saveReputationPreferences"],
    ["app/actions/settings/revenue-share-setting.ts", "setRevenueShareEnabled"],
    ["app/actions/settings/showing-financial-gate-setting.ts", "setShowingFinancialGateRequired"],
    ["app/actions/user-profile.ts", "updateMyAgentIdentity"],
    ["app/actions/notifications.ts", "createNotification"],
  ]
  for (const [file, fn] of WRITERS) {
    const s = read(file)
    check(`${file.split("/").pop()} — writer ${fn} import-pinned to the seam + resolveWriteContext gate`,
      SEAM_IMPORT.test(s) && /await resolveWriteContext\(\)/.test(s) && s.includes(fn))
    check(`${file.split("/").pop()} — no raw auth.getUser() tenant resolution left on the gate path`,
      !/supabase\.auth\.getUser\(\)/.test(s))
  }
  check("gates evaluate the IMPERSONATED identity (ctx.userType / ctx.userId), not the staff row",
    /CREATE_ROLES\.includes\(ctx\.userType/.test(read("app/actions/settings/create-commission-structure.ts")) &&
    /DELETE_ROLES\.includes\(ctx\.userType/.test(read("app/actions/settings/delete-commission-structure.ts")) &&
    /resolveTenantAdmin\(ctx\.db, ctx\.userId/.test(read("app/actions/settings/update-email-template.ts")) &&
    /isBrokerageFinanceAdmin\(\{ user_type: acting\.userType \}\)/.test(read("app/actions/settings/revenue-share-setting.ts")))
  const integ = read("app/actions/settings/integrations.ts")
  check("integrations gate reads the EFFECTIVE user's row through the acting db",
    /const ctx = await getAgentContext\(\)/.test(integ) &&
    /\.eq\("id", ctx\.userId\)/.test(integ) &&
    (integ.match(/await getBrokerageId\(supabase\)/g) ?? []).length >= 5)
  check("integrations toggle counts rows (zero rows toggled = refusal)",
    /if \(!toggled \|\| toggled\.length === 0\)/.test(integ))
  const notif = read("app/actions/notifications.ts")
  check("notifications no longer rides the kernel homonym (mode-blind resolveWriteContext)",
    !/from "@\/lib\/kernel\/identity"/.test(notif) && SEAM_IMPORT.test(notif))
  check("mark-read counts rows; markAll legitimately does not",
    /if \(!marked \|\| marked\.length === 0\)/.test(notif))
  const up = read("app/actions/user-profile.ts")
  check("user-profile users-row writes count rows (zero rows = refusal, not success)",
    (up.match(/\.select\("id"\)/g) ?? []).length >= 3 &&
    /if \(!savedUser \|\| savedUser\.length === 0\)/.test(up))
  const rep = read("app/actions/settings/reputation-preferences.ts")
  check("reputation-preferences pins the tenant on every agents query",
    (rep.match(/\.eq\("brokerage_id", ctx\.brokerageId\)/g) ?? []).length >= 3 &&
    /if \(!saved \|\| saved\.length === 0\)/.test(rep))
  const READERS: string[] = [
    "app/actions/settings/get-global-settings.ts",
    "app/actions/settings/list-commission-structures.ts",
    "app/actions/settings/list-email-templates.ts",
    "app/actions/settings/list-notification-rules.ts",
  ]
  for (const file of READERS) {
    const s = read(file)
    check(`${file.split("/").pop()} — reader rides resolveActingContext (read_only may look)`,
      /resolveActingContext/.test(s))
  }

  // ── 4. Seam discoverability + no read_only service leak in acting-context ──
  console.log("\n[seam shape + barrel]")
  const barrel = read("lib/identity/index.ts")
  check("seam exported from the identity barrel (discoverable one vocabulary)",
    /resolveWriteContext/.test(barrel) && /READ_ONLY_ACTING_ERROR/.test(barrel))
  check("brand.ts (pre-existing adopter) still compiles against the vocabulary it uses",
    (() => {
      const b = read("app/actions/onboarding/brand.ts")
      return /resolveActingContext/.test(b) && /READ_ONLY_ACTING_ERROR/.test(b)
    })())
  check("resolveActingContext (reader seam) still surfaces readOnly for mixed surfaces",
    /readOnly: ctx\.impersonationMode === "read_only"/.test(acting))

  // ── 5. THE CLAIMED-TENANT RULE ────────────────────────────────────────────
  //
  // Owner ruling 2026-08-26: "idor shapes need to include them but that is a
  // researched call for business reason". A caller-supplied brokerageId may EXIST;
  // it may never be an AUTHORITY. decideClaimedTenant is the one decision table,
  // and the three sites that carry such a parameter must gate through it.
  //
  // THE IDS BELOW ARE THE TWO LIVE BROKERAGES (SELECT id FROM brokerages,
  // 2026-08-26) — the guard is written against real tenants, not placeholders, so
  // "refuses a cross-tenant id" means the two that actually exist.
  console.log("\n[decideClaimedTenant — pure decision table, live tenant ids]")
  const OWN     = "b0000000-0000-0000-0000-000000000001" // VIP Premier Realty
  const FOREIGN = "231f4e64-5022-4752-8047-696886551c35" // Your Brokerage

  check("claim matching the acting tenant → ADMITTED, and the SESSION's id is returned",
    JSON.stringify(decideClaimedTenant({ actingBrokerageId: OWN, claimedBrokerageId: OWN }))
      === JSON.stringify({ ok: true, brokerageId: OWN }))
  check("claim naming the OTHER live brokerage → REFUSED (tenant_mismatch)",
    JSON.stringify(decideClaimedTenant({ actingBrokerageId: OWN, claimedBrokerageId: FOREIGN }))
      === JSON.stringify({ ok: false, reason: "tenant_mismatch" }))
  check("and symmetrically, from the other side",
    JSON.stringify(decideClaimedTenant({ actingBrokerageId: FOREIGN, claimedBrokerageId: OWN }))
      === JSON.stringify({ ok: false, reason: "tenant_mismatch" }))
  check("NO claim → the acting tenant answers (an absent claim is not a failure)",
    JSON.stringify(decideClaimedTenant({ actingBrokerageId: OWN }))
      === JSON.stringify({ ok: true, brokerageId: OWN }))
  check("FAIL CLOSED — session with no tenant is refused even when the claim looks fine",
    JSON.stringify(decideClaimedTenant({ actingBrokerageId: null, claimedBrokerageId: OWN }))
      === JSON.stringify({ ok: false, reason: "no_session_tenant" }))
  check("FAIL CLOSED — no tenant and no claim is still a refusal, never an untenanted pass",
    JSON.stringify(decideClaimedTenant({ actingBrokerageId: undefined }))
      === JSON.stringify({ ok: false, reason: "no_session_tenant" }))
  check("ACT-AS: while acting-as, the acting tenant IS the target, so the target's id is admitted",
    // getAgentContext resolves brokerageId to the TARGET under an active grant, so a
    // staff member operating FOREIGN passes a FOREIGN claim — no parameter is trusted,
    // the seam simply resolved a different tenant. This is why gating makes act-as work.
    JSON.stringify(decideClaimedTenant({ actingBrokerageId: FOREIGN, claimedBrokerageId: FOREIGN }))
      === JSON.stringify({ ok: true, brokerageId: FOREIGN }))

  // ── 5b. The three sites gate through it ───────────────────────────────────
  //
  // STRIPPED SOURCE, ALWAYS (§2). Each of these files now carries a long comment
  // explaining the ruling, and those comments NAME resolveWriteContextForTenant and
  // params.brokerageId repeatedly. Reading raw source would let the explanation of
  // the fix stand in for the fix — and would let the accusation regex match the
  // sentence that says the accusation no longer applies.
  console.log("\n[claimed-tenant rule — the sites, on stripped source]")
  const txnDocsRaw = read("app/actions/ai-transaction-documents.ts")
  const txnDocs    = stripComments(txnDocsRaw)
  const EXPORTS = [
    "analyzeTransactionDocument",
    "generateTransactionDocumentReminders",
    "checkTransactionDisclosures",
    "shareDocumentAnalysisWithClient",
  ]
  const gateCount = (txnDocs.match(/resolveWriteContextForTenant\(params\.brokerageId\)/g) ?? []).length
  check(`ai-transaction-documents: all ${EXPORTS.length} exports gate through the seam (found ${gateCount})`,
    gateCount >= EXPORTS.length)
  for (const fn of EXPORTS) {
    check(`  ${fn} is still exported (the gate did not delete the capability)`,
      new RegExp(`export async function ${fn}\\b`).test(txnDocs))
  }
  check("ai-transaction-documents: NO write stamps the caller's claim (brokerage_id: params.brokerageId)",
    !/brokerage_id:\s*params\.brokerageId/.test(txnDocs))
  check("ai-transaction-documents: writes stamp the SESSION's tenant (wc.brokerageId)",
    (txnDocs.match(/brokerage_id:\s*wc\.brokerageId/g) ?? []).length >= 4)
  check("ai-transaction-documents: the extraction-log insert BINDS its error (no bare await)",
    /const \{ error: logErr \} = await supabase\.from\("document_extraction_log"\)/.test(txnDocs))
  check("ai-transaction-documents: no longer builds its own cookie client behind the seam",
    !/createClient\(\)/.test(txnDocs))

  const invoiceActionRaw = read("app/actions/ai-financial-management.ts")
  const invoiceAction = stripComments(invoiceActionRaw)
  check("generateInvoice is GONE from the public server-action surface (§1.3, survivor named)",
    !/export async function generateInvoice\b/.test(invoiceAction))
  check("…and its tombstone names both the survivor and the live caller",
    /TOMBSTONE[\s\S]{0,900}lib\/finance\/invoice-draft\.ts:generateInvoice/.test(invoiceActionRaw) &&
    /TOMBSTONE[\s\S]{0,1200}lib\/workflow\/adapters\/draft-document\.ts/.test(invoiceActionRaw))
  const invoiceLib = stripComments(read("lib/finance/invoice-draft.ts"))
  check("the drafter takes its db client EXPLICITLY (no session assumed) and requires a tenant",
    /export async function generateInvoice\(\s*db: SupabaseClient,/.test(invoiceLib) &&
    /if \(!params\.brokerageId\)/.test(invoiceLib))
  check("the drafter's documents UPDATE is tenant-scoped, error-bound AND row-counted (§3)",
    /\.eq\("brokerage_id", params\.brokerageId\)/.test(invoiceLib) &&
    /const \{ data: updated, error: updErr \}/.test(invoiceLib) &&
    /if \(!updated \|\| updated\.length === 0\)/.test(invoiceLib))
  check("the drafter books its AI spend to a tenant (ai_tool_usage is written only when brokerageId is present)",
    (invoiceLib.match(/brokerageId: params\.brokerageId/g) ?? []).length >= 2)
  const draftAdapter = stripComments(read("lib/workflow/adapters/draft-document.ts"))
  check("the session-less workflow caller passes the executor's service client, not a cookie client",
    /generateInvoice\(supabase, \{/.test(draftAdapter) &&
    // …and it reaches the LIB, not the "use server" action that built its own
    // sessionless cookie client. The name is unchanged (it moved, §1), so the
    // discriminator is the module it comes from, never the identifier.
    /import\("@\/lib\/finance\/invoice-draft"\)/.test(draftAdapter) &&
    !/ai-financial-management/.test(draftAdapter))
  check("…and it reads the drafter's verdict instead of discarding it",
    /if \(!drafted\.success\)/.test(draftAdapter))

  const billingKernel = stripComments(read("lib/kernel/billing.ts"))
  check("loadBillingWorkspace authorizes the named tenant against the ACTOR, not against a user_type literal",
    /isPlatformSuperadminIdentity\(\s*input\.actorContext\.userType/.test(billingKernel) &&
    /decideClaimedTenant\(\{/.test(billingKernel))
  check("…and it does so through the ONE claimed-tenant rule, not a second spelling (§6)",
    /import \{ decideClaimedTenant \} from "@\/lib\/platform\/acting-context"/.test(billingKernel) &&
    /claimedBrokerageId: input\.brokerageId/.test(billingKernel) &&
    /actingBrokerageId: input\.actorContext\.brokerageId/.test(billingKernel))
  check("loadBillingWorkspace FAILS CLOSED when the actor's own tenant is unknown",
    /decision\.reason === "no_session_tenant"/.test(billingKernel))
  check("the dead userId-vs-brokerageId comparison is gone (two disjoint uuid spaces)",
    !/actorContext\.userId !== input\.brokerageId/.test(billingKernel))
  const billingRoute = stripComments(read("app/api/admin/billing/dashboard/route.ts"))
  check("the billing route sends the actor's SESSION brokerage for that comparison",
    /brokerageId: auth\.brokerageId,/.test(billingRoute))

  // ── 5c. POSITIVE CONTROLS (§2) ────────────────────────────────────────────
  //
  // A broken regex and a clean tree both report zero. Every absence assertion above
  // is re-run here against source that has the ORIGINAL defect spliced back in; the
  // finder must go red on it, or it is not a finder.
  console.log("\n[positive controls — the finders still recognise the defects they were written for]")
  const preFixWrite = txnDocsRaw.replace(
    /brokerage_id: wc\.brokerageId,/,
    "brokerage_id: params.brokerageId,",
  )
  check("control · the claim-stamping finder GOES RED on the pre-fix write",
    /brokerage_id:\s*params\.brokerageId/.test(stripComments(preFixWrite)))
  const preFixGate = txnDocsRaw.replace(/resolveWriteContextForTenant\(params\.brokerageId\)/g, "getAgentContext()")
  check("control · the gate finder GOES RED when the exports stop riding the seam",
    (stripComments(preFixGate).match(/resolveWriteContextForTenant\(params\.brokerageId\)/g) ?? []).length === 0)
  const preFixLog = txnDocsRaw.replace(
    /const \{ error: logErr \} = await supabase\.from\("document_extraction_log"\)/,
    'await supabase.from("document_extraction_log")',
  )
  check("control · the bare-await finder GOES RED on the swallowed extraction-log insert",
    !/const \{ error: logErr \} = await supabase\.from\("document_extraction_log"\)/.test(stripComments(preFixLog)))
  check("control · a TOMBSTONE IS NOT A CALL SITE — the ruling comments naming params.brokerageId do NOT satisfy the gate finder",
    // The raw file says "params.brokerageId" many times in prose. Strip it all out and
    // the count must be exactly the four real gates, not the prose.
    (txnDocsRaw.match(/params\.brokerageId/g) ?? []).length >
      (txnDocs.match(/params\.brokerageId/g) ?? []).length)
  check("control · decideClaimedTenant would ADMIT a foreign id if the comparison were dropped",
    // Mirror of the rule with the mismatch arm removed — proves the refusal above is
    // the comparison doing work, not a constant.
    (() => {
      const naive = (acting: string | null, claimed?: string | null) =>
        acting ? { ok: true, brokerageId: claimed ?? acting } : { ok: false }
      return JSON.stringify(naive(OWN, FOREIGN)) !== JSON.stringify(decideClaimedTenant({ actingBrokerageId: OWN, claimedBrokerageId: FOREIGN }))
    })())

  // ── 6. ONE SEAM, ONE DECLARATION (§1.1 / §6) ──────────────────────────────
  //
  // lib/kernel/identity.ts declared a SECOND `resolveWriteContext` with a different
  // shape and no impersonation awareness. Measured before the merge (2026-08-26):
  // 38 files / 85 call sites gated on the kernel copy, 33 files / 75 on this one.
  // The kernel copy returned NO client, so 18 of its gates then built their own
  // RLS-scoped client — writes REFUSED under act-as, and supabase-js resolves a
  // refusal as zero rows with `error: null`, which is byte-identical to success —
  // while 112 built a service client and so wrote through RLS even under a
  // **read_only** grant, the exact inverse of §5's "never exceeds it".
  //
  // The assertion is the RULE (§2): the name is declared ONCE, and nothing imports it
  // from the retired module. Numbers are DERIVED and printed, never pinned.
  console.log("\n[one seam, one declaration — the §1.1 merge]")
  const KERNEL_IMPORT_RE = /^[ \t]*(?:import|export)\b[^\n]*from\s*["']@\/lib\/kernel\/identity["']/m
  const KERNEL_IMPORT_SPECIMEN = '\nimport { resolveWriteContext } from "@/lib/kernel/identity"\n'
  const SEAM_NAMES = ["resolveWriteContext", "resolveWriteContextForTenant", "resolveActingContext", "requireWriteContext"]
  const srcFiles: string[] = []
  ;(function walk(dir: string) {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel)
      else if (/\.tsx?$/.test(e.name)) srcFiles.push(rel.replace(/^\.\//, ""))
    }
  })(".")

  // Comment-stripped AND string-blanked: a tombstone naming the survivor, and a guard
  // regex that quotes the declaration, are BOTH text — neither is a declaration (§2).
  const decls: string[] = []
  const kernelImporters: string[] = []
  const seamImporters = new Set<string>()
  for (const f of srcFiles) {
    const raw = read(f)
    const code = blankStrings(raw)
    if (/^\s*export\s+async\s+function\s+resolveWriteContext\s*\(/m.test(code)) decls.push(f)
    // LINE-ANCHORED on `import`/`export … from "…"`. The unanchored form accused THIS
    // file: the positive control below carries the retired import path as a SPECIMEN
    // inside a string literal, and stripComments deliberately preserves string
    // contents. That is the §2 "a specimen is not a call site" trap, caught live.
    // blankStrings is not the answer either — it would blank the module path out of a
    // REAL import too — so the discriminator is statement position, not quoting.
    if (KERNEL_IMPORT_RE.test(stripComments(raw))) kernelImporters.push(f)
    if (/from\s+"@\/lib\/platform\/acting-context"/.test(stripComments(raw)) &&
        SEAM_NAMES.some((n) => new RegExp(`\\b${n}\\b`).test(code))) seamImporters.add(f)
  }
  console.log(`   scanned ${srcFiles.length} .ts/.tsx files (node_modules and dot-dirs excluded — the blind spot)`)
  console.log(`   resolveWriteContext declarations: ${decls.length} → ${decls.join(", ") || "(none)"}`)
  console.log(`   files importing the seam from lib/platform/acting-context: ${seamImporters.size}`)
  check("resolveWriteContext is declared EXACTLY ONCE in the repo",
    decls.length === 1, `found ${decls.length}: ${decls.join(", ")}`)
  check("…and the one declaration is the platform seam",
    decls[0] === "lib/platform/acting-context.ts", decls[0])
  check("the retired lib/kernel/identity.ts is GONE",
    !existsSync(join(ROOT, "lib/kernel/identity.ts")))
  check("nothing imports from the retired module",
    kernelImporters.length === 0, kernelImporters.join(", "))
  check("the kernel barrel no longer re-exports the homonym (and names its survivor)",
    !/^\s*(resolveWriteContext|requireWriteContext),\s*$/m.test(blankStrings(read("lib/kernel/index.ts"))) &&
    /lib\/platform\/acting-context\.ts:\d+/.test(read("lib/kernel/index.ts")))
  check("requireWriteContext is declared nowhere (its callers converted to the seam)",
    !srcFiles.some((f) => /export\s+async\s+function\s+requireWriteContext\s*\(/.test(blankStrings(read(f)))))

  // §5 — "a grant walks the account and never exceeds it", in BOTH directions.
  check("read_only still READS — resolveActingContext hands back a db and never consults the write decision",
    /export async function resolveActingContext/.test(acting) &&
    !new RegExp(`resolveActingContext[\\s\\S]{0,900}?decideWriteChannel`).test(acting) &&
    /readOnly: ctx\.impersonationMode === "read_only"/.test(acting))
  check("…and the writer entry point refuses that same grant before any client is built",
    (decideWriteChannel({ isAuthenticated: true, isImpersonating: true, impersonationMode: "read_only" }) as any).channel === "refused")
  check("both entry points resolve the SAME identity (one agentId answer, §6)",
    (acting.match(/resolveClientAndAgent\(/g) ?? []).length === 3, // 1 declaration + 2 call sites
    `${(acting.match(/resolveClientAndAgent\(/g) ?? []).length} occurrences`)
  check("agentId is FK-safe — resolved through resolveAgentId, never `?? userId` (agents.id ⊥ users.id, 23503)",
    /agentId = await resolveAgentId\(db, ctx\.userId\)/.test(acting) &&
    !/agentId[^\n]*\?\?\s*ctx\.userId/.test(acting))
  check("the survivor carries the §1.1 tombstone naming what was merged and what was not",
    /TOMBSTONE \(§1\.1\)/.test(read("lib/platform/acting-context.ts")))

  // POSITIVE CONTROLS (§2) — a broken finder and a clean tree both report zero.
  console.log("\n[positive controls — the one-declaration finder]")
  const twinDecl = "export async function resolveWriteContext(): Promise<WriteContextResult> {"
  check("control · the declaration finder GOES RED on a spliced-in second declaration",
    /^\s*export\s+async\s+function\s+resolveWriteContext\s*\(/m.test(blankStrings(twinDecl)))
  check("control · …and does NOT count a TOMBSTONE that merely names it",
    !/^\s*export\s+async\s+function\s+resolveWriteContext\s*\(/m.test(
      blankStrings("// SURVIVOR: export async function resolveWriteContext() lives in acting-context.ts")))
  check("control · …nor a quoted mention inside a string literal",
    !/^\s*export\s+async\s+function\s+resolveWriteContext\s*\(/m.test(
      blankStrings('const s = `export async function resolveWriteContext() {`')))
  check("control · the retired-import finder GOES RED on a restored kernel import",
    KERNEL_IMPORT_RE.test(stripComments(KERNEL_IMPORT_SPECIMEN)))
  check("control · …and does NOT fire on the same text quoted mid-line as a specimen",
    !KERNEL_IMPORT_RE.test(stripComments(`  const spec = ${JSON.stringify(KERNEL_IMPORT_SPECIMEN.trim())}`)))
  check("control · a read_only grant WOULD reach the service client if the mode arm were dropped",
    (() => {
      const naive = (c: { isAuthenticated: boolean; isImpersonating?: boolean }) =>
        !c.isAuthenticated ? "refused" : c.isImpersonating ? "service" : "cookie"
      return naive({ isAuthenticated: true, isImpersonating: true }) === "service" &&
        decideWriteChannel({ isAuthenticated: true, isImpersonating: true, impersonationMode: "read_only" }).channel === "refused"
    })())

  report()
}

main()
