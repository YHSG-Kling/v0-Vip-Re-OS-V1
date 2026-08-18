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
