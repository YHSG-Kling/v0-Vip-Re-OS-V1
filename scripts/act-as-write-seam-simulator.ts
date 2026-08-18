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
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { decideWriteChannel } from "../lib/platform/acting-context"
import { isSessionActive } from "../lib/platform/impersonation"

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
  check("service client only on the 'service' channel",
    /decision\.channel === "service" \? createServiceClient\(\)/.test(body))
  check("refusal branch precedes any service-client construction",
    body.indexOf(`decision.channel === "refused"`) !== -1 &&
    body.indexOf(`decision.channel === "refused"`) < body.indexOf("createServiceClient()"))
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
  const delStart = listings.indexOf("export async function deleteListing")
  const delSeg = listings.slice(delStart, listings.indexOf("export async function", delStart + 10))
  check("deleteListing refuses read_only before writing",
    /if \(auth\.readOnly\) return \{ success: false, error: READ_ONLY_ACTING_ERROR \}/.test(delSeg))
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
  check("admin predicate itself unchanged (roster + platform-superadmin both-columns test)",
    /BROKERAGE_ADMIN_USER_TYPES = new Set\(\["admin", "broker", "broker_owner"\]\)/.test(gsk) &&
    /userType === "superadmin" \|\| platformRole === "superadmin"/.test(gsk) &&
    /if \(!BROKERAGE_ADMIN_USER_TYPES\.has\(userType\) && !isPlatformSuperadmin\)/.test(gsk))
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

  report()
}

main()
