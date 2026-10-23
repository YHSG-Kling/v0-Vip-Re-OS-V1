#!/usr/bin/env tsx
/**
 * scripts/support-isolation-guard.ts   (npm run test:support-isolation)
 * ─────────────────────────────────────────────────────────────────────────────
 * A TENANT SEAT READS ONLY ITS OWN BROKERAGE'S SUPPORT QUEUE.
 *
 * Owner, 2026-10-18, verbatim: "tenant should not read ticket queue across
 * brokerages, only their tenancy." A tenant seat — INCLUDING a users.user_type of
 * 'support' — reads/writes only its own brokerage's tickets, messages, counts and
 * notifications. A global queue is PLATFORM STAFF ONLY, decided from platform_role
 * through the roster predicates; a user TYPE never grants cross-tenant access.
 *
 * THE DEFECT THIS WAS WRITTEN FOR (fec8b6a95): app/actions/support.ts:108
 * `if (ctx.userType === "support") return true` inside callerReadsAllBrokerages —
 * every service-client read and write behind the office queue
 * (listBrokerageTickets, updateTicketStatus, resolveAdminTicketScope → the thread
 * and the reply) went unpinned for any row typed 'support', platform_role or not.
 * 'support' is a storable TENANT seat type. No proof covered the path.
 *
 * LAYERS
 *   IN MEMORY  the pure scope decision (lib/support/ticket-scope.ts) and the
 *              query predicate it applies, run against an in-memory client holding
 *              two brokerages' tickets: a tenant 'support' seat sees ONE tenant, a
 *              platform verdict sees both, a scoped UPDATE of the other tenant's
 *              ticket matches ZERO rows (counted — CLAUDE.md §3).
 *   SOURCE     stripped source (scripts/strip-comments.ts): no `userType ===
 *              "support"` admission anywhere in the support surfaces, no re-typed
 *              roster literal, the ONE platform gate, the predicate wired into every
 *              door. Every absence has a POSITIVE CONTROL (CLAUDE.md §2).
 *   RLS        the database half, as FILE evidence: m468's
 *              public.can_access_support_ticket body (the policy predicate of both
 *              support tables) admits across tenants through is_platform_staff()
 *              only and never reads user_type; m780's is_platform_staff reads
 *              platform_role only. Read through scripts/strip-sql-comments.ts.
 *   LIVE       (creds-gated, self-skips) the two counts m782 and the ruling rest on.
 *
 * BLIND SPOTS, published beside the result:
 *   1. The RLS layer reads migration FILES, not pg_get_functiondef. The live
 *      function was read by the 2026-10-18 policy census (no support_tickets policy
 *      carries a user_type arm) and by test:cross-tenant-read's catalogue census.
 *      The service client bypasses RLS entirely, which is why the APP predicate is
 *      the one this proof runs.
 *   2. requirePlatformCapability("support") — the platform half — is a session
 *      gate and is not executed here; its default map (platformStaffCan over
 *      resolvePlatformRoleIdentity) is asserted directly and the overrides table
 *      is the gate's own. The source layer pins that support.ts derives
 *      `platformSupport` from that gate and nothing else.
 *   3. scripts/ is not scanned (this file quotes the forbidden spelling as its own
 *      control).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { memSupabase } from "./in-memory-supabase"
import { blankComments, stripComments } from "./strip-comments"
import { stripSqlComments } from "./strip-sql-comments"
import { SUPPORT_DESK_USER_TYPES, resolveTicketQueueScope, scopeTicketQuery, ticketWithinScope } from "../lib/support/ticket-scope"
import { TENANT_ADMIN_USER_TYPES } from "../lib/auth/resolve-user-role"
import { platformStaffCan, resolvePlatformRoleIdentity } from "../lib/platform/platform-staff-roster"

const ROOT = process.cwd()
let pass = 0, fail = 0
const fails: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const raw = (rel: string) => readFileSync(join(ROOT, rel), "utf8")
const stripped = (rel: string) => stripComments(raw(rel))

console.log("══════════════════════════════════════════════════")
console.log(" Support isolation — a tenant seat reads only its own tenancy")
console.log("══════════════════════════════════════════════════")

// ─── 1. THE PURE DECISION ────────────────────────────────────────────────────
console.log("\n[1 · the scope decision — pure]")
{
  const B1 = "11111111-1111-4111-8111-111111111111"
  const tenantSupport = resolveTicketQueueScope({ platformSupport: false, userType: "support", brokerageId: B1 })
  check("THE RULING: a seat typed 'support' with no platform verdict is pinned to ITS OWN tenant", tenantSupport.kind === "tenant" && tenantSupport.brokerageId === B1)
  check("…and with no session tenant it is REFUSED, never widened", resolveTicketQueueScope({ platformSupport: false, userType: "support", brokerageId: null }).kind === "refused")
  check("a platform verdict reads across tenants (the gate decided, from platform_role)", resolveTicketQueueScope({ platformSupport: true, userType: "support", brokerageId: null }).kind === "platform" && resolveTicketQueueScope({ platformSupport: true, userType: "admin", brokerageId: B1 }).kind === "platform")
  check("the legacy user_type 'superadmin' marker is REFUSED — a user_type is never a platform fallback (owner ruling 2026-10-14)", resolveTicketQueueScope({ platformSupport: false, userType: "superadmin", brokerageId: B1 }).kind === "refused")
  check("every operational admin roster seat is pinned to its own tenant", [...TENANT_ADMIN_USER_TYPES].every((t) => { const s = resolveTicketQueueScope({ platformSupport: false, userType: t, brokerageId: B1 }); return s.kind === "tenant" && s.brokerageId === B1 }))
  check("a producer, a contact, a vendor, the ISA, a TC and a missing type are refused", ["agent", "contact", "vendor", "isa", "tc", "system", null, undefined, ""].every((t) => resolveTicketQueueScope({ platformSupport: false, userType: t, brokerageId: B1 }).kind === "refused"))
  check("SUPPORT_DESK_USER_TYPES is the roster spread + 'support' — derived, never restated", SUPPORT_DESK_USER_TYPES.size === TENANT_ADMIN_USER_TYPES.size + 1 && [...TENANT_ADMIN_USER_TYPES].every((t) => SUPPORT_DESK_USER_TYPES.has(t)) && SUPPORT_DESK_USER_TYPES.has("support"))
  check("…and never names a platform marker or a non-staff seat", !["superadmin", "agent", "vendor", "contact", "isa", "system"].some((t) => SUPPORT_DESK_USER_TYPES.has(t)))

  console.log("\n[1b · the platform half — the gate's default map, both identity columns]")
  const platformSupport = (userType: string | null, platformRole: string | null) => platformStaffCan(resolvePlatformRoleIdentity(userType, platformRole), "support")
  check("the live staff shapes are platform support: (admin, superadmin), (admin, admin), (support, support)", platformSupport("admin", "superadmin") && platformSupport("admin", "admin") && platformSupport("support", "support"))
  check("THE RULING, platform side: user_type 'support' with NO platform_role is NOT platform support", platformSupport("support", null) === false)
  check("marketing staff carry no support capability; the legacy marker and the ISA service account are refused", platformSupport("system", "marketing") === false && platformSupport("superadmin", null) === false && platformSupport("system", "ai_isa_system") === false)
}

// ─── 2. THE PREDICATE, IN MEMORY ─────────────────────────────────────────────
console.log("\n[2 · the predicate the actions apply — in memory, two brokerages]")
{
  const B1 = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222"
  const seed = {
    support_tickets: [
      { id: "t-b1-office", brokerage_id: B1, lane: "user_to_brokerage", status: "open", subject: "B1 office" },
      { id: "t-b1-platform", brokerage_id: B1, lane: "tenant_to_platform", status: "open", subject: "B1 → platform" },
      { id: "t-b2-office", brokerage_id: B2, lane: "user_to_brokerage", status: "open", subject: "B2 office" },
      { id: "t-b2-platform", brokerage_id: B2, lane: "tenant_to_platform", status: "open", subject: "B2 → platform" },
      { id: "t-orphan", brokerage_id: null, lane: "user_to_brokerage", status: "open", subject: "no tenant" },
    ],
    support_ticket_messages: [
      { id: "m1", ticket_id: "t-b1-office", author_kind: "tenant", body: "B1 thread" },
      { id: "m2", ticket_id: "t-b2-office", author_kind: "tenant", body: "B2 thread" },
    ],
  }
  const svc = memSupabase(seed)
  const tenantB1 = resolveTicketQueueScope({ platformSupport: false, userType: "support", brokerageId: B1 })
  const platform = resolveTicketQueueScope({ platformSupport: true, userType: "support", brokerageId: null })
  if (tenantB1.kind === "refused" || platform.kind === "refused") { check("fixture scopes admitted", false); process.exit(1) }

  const listFor = async (scope: typeof tenantB1 | typeof platform, lane: string) => {
    const { data, error } = await scopeTicketQuery(svc.from("support_tickets").select("id, brokerage_id, lane").eq("lane", lane), scope as any).order("id", { ascending: true }).limit(300)
    return { rows: (data ?? []) as Array<{ id: string; brokerage_id: string | null }>, error }
  }
  const own = await listFor(tenantB1, "user_to_brokerage")
  check("a tenant 'support' seat lists ONLY its own brokerage's office tickets (1 of 3 in the lane)", own.error === null && own.rows.length === 1 && own.rows[0].id === "t-b1-office")
  const ownPlatformLane = await listFor(tenantB1, "tenant_to_platform")
  check("…and only its own brokerage's platform-lane tickets", ownPlatformLane.error === null && ownPlatformLane.rows.length === 1 && ownPlatformLane.rows[0].brokerage_id === B1)
  const all = await listFor(platform, "user_to_brokerage")
  check("POSITIVE CONTROL: the platform verdict lists every brokerage's office tickets (3, including the untenanted row)", all.error === null && all.rows.length === 3 && new Set(all.rows.map((r) => r.brokerage_id)).size === 3)

  // A scoped WRITE on the other tenant's ticket: error:null, ZERO rows — the shape that must be COUNTED.
  const { data: crossWrite, error: crossErr } = await scopeTicketQuery(svc.from("support_tickets").update({ status: "resolved" }).eq("id", "t-b2-office"), tenantB1).select("id")
  check("a scoped status flip on ANOTHER tenant's ticket matches ZERO rows with error:null (counted refusal, §3)", crossErr === null && (crossWrite ?? []).length === 0 && svc.tables.support_tickets.find((t) => t.id === "t-b2-office")!.status === "open")
  const { data: ownWrite } = await scopeTicketQuery(svc.from("support_tickets").update({ status: "in_progress" }).eq("id", "t-b1-office"), tenantB1).select("id")
  check("…while the same flip on its OWN ticket matches one row", (ownWrite ?? []).length === 1 && svc.tables.support_tickets.find((t) => t.id === "t-b1-office")!.status === "in_progress")
  const { data: platformWrite } = await scopeTicketQuery(svc.from("support_tickets").update({ status: "in_progress" }).eq("id", "t-b2-office"), platform).select("id")
  check("POSITIVE CONTROL: the platform verdict flips the other tenant's ticket (1 row)", (platformWrite ?? []).length === 1)

  // The thread gate (support_ticket_messages inherits the parent — m468's rule).
  const b2 = svc.tables.support_tickets.find((t) => t.id === "t-b2-office")!
  const b1 = svc.tables.support_tickets.find((t) => t.id === "t-b1-office")!
  const orphan = svc.tables.support_tickets.find((t) => t.id === "t-orphan")!
  check("the thread gate refuses another tenant's ticket and an untenanted one under a tenant scope", ticketWithinScope(b2, tenantB1) === false && ticketWithinScope(orphan, tenantB1) === false)
  check("…admits the tenant's own ticket, and the platform verdict admits all three", ticketWithinScope(b1, tenantB1) === true && [b1, b2, orphan].every((t) => ticketWithinScope(t, platform)))
}

// ─── 3. SOURCE — the rule in the files, with controls ─────────────────────────
console.log("\n[3 · source — no user_type admission, one gate, the predicate on every door]")

/** A cross-tenant admission keyed on the user TYPE 'support'. Strings are NOT blanked — the literal is the signal. */
const SUPPORT_TYPE_ADMISSION = /\b(?:userType|user_type)\b\s*(?:===|==)\s*["']support["']/g
function supportTypeArmsIn(source: string): number[] {
  const code = blankComments(source)
  const out: number[] = []
  let m: RegExpExecArray | null
  SUPPORT_TYPE_ADMISSION.lastIndex = 0
  while ((m = SUPPORT_TYPE_ADMISSION.exec(code))) out.push(code.slice(0, m.index).split("\n").length)
  return out
}
/** A RE-TYPED roster: a Set literal that spells out roster members beside "support". The spread survivor has no member literal. */
const ROSTER_MEMBER_LITERAL = new RegExp(`["'](?:${[...TENANT_ADMIN_USER_TYPES].join("|")})["']`)
function retypedRostersIn(source: string): number {
  const code = blankComments(source)
  let n = 0
  for (const m of code.matchAll(/new Set\(\s*\[([^\]]*)\]\s*\)/g)) {
    if (/["']support["']/.test(m[1]) && ROSTER_MEMBER_LITERAL.test(m[1])) n++
  }
  return n
}
{
  // POSITIVE CONTROLS FIRST — a finder that cannot see the defect reports a clean zero.
  check("CONTROL: the finder flags the pre-fix line verbatim", supportTypeArmsIn('  if (ctx.userType === "support") return true').length === 1)
  check("CONTROL: …and the snake-case / loose-equality spellings", supportTypeArmsIn("if (row.user_type == 'support') allow()").length === 1 && supportTypeArmsIn('const ok = u.user_type === "support"').length === 1)
  check("CONTROL: platform_role === \"support\" (the roster column) and a resolved gate role are NOT flagged", supportTypeArmsIn('if (u.platform_role === "support") ok()').length === 0 && supportTypeArmsIn('if (gate.role === "support") ok()').length === 0)
  check("CONTROL: the shape written only in a comment is NOT flagged", supportTypeArmsIn('// WAS: if (ctx.userType === "support") return true\nconst scope = resolveQueueScope(ctx)').length === 0)
  check("CONTROL: the old six-string roster literal IS a re-typed roster; the spread survivor is NOT", retypedRostersIn('const ADMIN_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin", "team_lead", "support"])') === 1 && retypedRostersIn('export const SUPPORT_DESK_USER_TYPES = new Set([...TENANT_ADMIN_USER_TYPES, "support"])') === 0)

  const SURFACES = [
    "app/actions/support.ts",
    "app/dashboard/admin/support-tickets/page.tsx",
    "app/dashboard/admin/support-tickets/support-queue-client.tsx",
    "app/dashboard/help/page.tsx",
    "app/dashboard/help/help-client.tsx",
    "app/dashboard/help/ticket-thread.tsx",
    "app/actions/superadmin/support-console.ts",
    "app/dashboard/superadmin/support/page.tsx",
    "app/dashboard/superadmin/support/[id]/page.tsx",
    "lib/support/ticket-scope.ts",
    "lib/support/ticket-constants.ts",
    "lib/support/support-thread.ts",
    "lib/support/support-sla.ts",
    "lib/platform/tenant-export.ts",
    "app/api/cron/support-sla/route.ts",
    "app/api/cron/platform-sentinel/route.ts",
  ].filter((p) => existsSync(join(ROOT, p)))
  const arms = SURFACES.flatMap((p) => supportTypeArmsIn(raw(p)).map((ln) => `${p}:${ln}`))
  check(`no support surface admits by user TYPE 'support' (${SURFACES.length} files, found ${arms.length})`, arms.length === 0, arms.join(", "))
  const retyped = SURFACES.filter((p) => retypedRostersIn(raw(p)) > 0)
  check(`no support surface re-types the office roster beside "support" (found ${retyped.length})`, retyped.length === 0, retyped.join(", "))

  const sup = stripped("app/actions/support.ts")
  check("support.ts derives the cross-tenant verdict from the ONE platform gate — requirePlatformCapability(\"support\")", /const gate = await requirePlatformCapability\(\s*"support"\s*\)/.test(sup) && /platformSupport:\s*[^,\n}]*\bgate\b/.test(sup))
  check("…and from no second platform resolver (the console's gate is the only spelling)", !/isPlatformSuperadminIdentity\(|isPlatformStaffIdentity\(|platformActorKind\(/.test(sup))
  check("the scope decision is the pure survivor (resolveTicketQueueScope)", /resolveTicketQueueScope\(\s*\{/.test(sup) && /from "@\/lib\/support\/ticket-scope"/.test(sup))
  const listBody = sup.slice(sup.indexOf("export async function listBrokerageTickets"), sup.indexOf("export async function updateTicketStatus"))
  const updateBody = sup.slice(sup.indexOf("export async function updateTicketStatus"), sup.indexOf("async function resolveAdminTicketScope"))
  const scopeBody = sup.slice(sup.indexOf("async function resolveAdminTicketScope"), sup.indexOf("export async function getBrokerageTicketThread"))
  check("the list and the status flip both pin their query through scopeTicketQuery(…)", /scopeTicketQuery\(/.test(listBody) && /scopeTicketQuery\(/.test(updateBody))
  check("both refuse BEFORE the service client is created (gate first, §4)", listBody.indexOf("resolveQueueScope(") < listBody.indexOf("createServiceClient()") && updateBody.indexOf("resolveQueueScope(") < updateBody.indexOf("createServiceClient()"))
  check("the thread / reply door tests ticketWithinScope BEFORE returning the service client", /ticketWithinScope\(/.test(scopeBody) && scopeBody.indexOf("ticketWithinScope(") < scopeBody.indexOf("return { ok: true, svc"))
  check("getBrokerageTicketThread and replyToBrokerageTicket enter through that door", /export async function getBrokerageTicketThread[\s\S]*?resolveAdminTicketScope\(/.test(sup) && /export async function replyToBrokerageTicket[\s\S]*?resolveAdminTicketScope\(/.test(sup))
  check("listMyTickets stays keyed on the SUBMITTER (a user reads their own tickets only)", /listMyTickets[\s\S]*?\.eq\("submitted_by_user_id", ctx\.userId\)/.test(sup))

  const page = stripped("app/dashboard/admin/support-tickets/page.tsx")
  check("the office queue page imports the ONE desk roster (no literal)", /import \{ SUPPORT_DESK_USER_TYPES \} from "@\/lib\/support\/ticket-scope"/.test(page) && /SUPPORT_DESK_USER_TYPES\.has\(ctx\.userType\)/.test(page))
  const scopeSrc = stripped("lib/support/ticket-scope.ts")
  check("the desk roster is SPREAD from TENANT_ADMIN_USER_TYPES plus 'support' (never restated)", /new Set\(\[\s*\.\.\.TENANT_ADMIN_USER_TYPES\s*,\s*"support"\s*\]\)/.test(scopeSrc))
  check("the pure decision reads no client and no session", !/createClient|createServiceClient|getAgentContext|next\/headers/.test(scopeSrc))
  const con = stripped("app/actions/superadmin/support-console.ts")
  check("the platform console gates through the same capability (one vocabulary for 'platform support')", /requirePlatformCapability\(\s*"support"\s*\)/.test(con))
}

// ─── 4. RLS — the database half, as file evidence ────────────────────────────
console.log("\n[4 · RLS — can_access_support_ticket admits across tenants by platform_role only (file evidence)]")
/** The dead shape: a user TYPE read as authority inside a predicate. */
const TYPE_AUTHORITY = /\b(?:user_type|current_user_type\(\))/
{
  const m468 = stripSqlComments(raw("supabase/migrations/m468-two-support-lanes-the-schema-could-not-tell-apart.sql"))
  const start = m468.indexOf("create or replace function public.can_access_support_ticket(")
  const body = start >= 0 ? m468.slice(start, m468.indexOf("$$;", start)) : ""
  check("CONTROL: the finder flags a user_type arm inside a predicate body", TYPE_AUTHORITY.test("or current_user_type() = 'support'") && TYPE_AUTHORITY.test("users.user_type = 'superadmin'"))
  check("CONTROL: …and does not flag platform_role / the staff helper", !TYPE_AUTHORITY.test("public.is_platform_staff() or platform_role = 'support'"))
  check("m468's predicate body was found", body.length > 200)
  check("the ONLY cross-tenant arm is public.is_platform_staff(); every other arm sits under p_brokerage_id = current_user_brokerage_id()", /public\.is_platform_staff\(\)/.test(body) && /p_brokerage_id = public\.current_user_brokerage_id\(\)/.test(body) && /is_brokerage_admin\(\)/.test(body) && /is_support_ticket_submitter\(/.test(body))
  check("no user TYPE is read as authority anywhere in that body", !TYPE_AUTHORITY.test(body))
  check("both support tables' policies compose that one predicate (SELECT / INSERT / UPDATE on tickets; parent-inherited on messages)", (m468.match(/can_access_support_ticket\(lane, brokerage_id/g) ?? []).length >= 3 && (m468.match(/can_access_support_ticket\(t\.lane, t\.brokerage_id/g) ?? []).length >= 2)
  const m780 = stripSqlComments(raw("supabase/migrations/m780-platform-staff-live-in-platform-role-only.sql"))
  const staffFn = m780.slice(m780.indexOf("FUNCTION public.is_platform_staff()"), m780.lastIndexOf("$function$"))
  check("m780's is_platform_staff() reads platform_role only (no user_type arm) — the staff escape cannot be entered by a TYPE", /platform_role in \('superadmin', 'admin', 'marketing', 'support'\)/.test(staffFn) && !/user_type/.test(staffFn))
}

// ─── 5. REGISTRATION ─────────────────────────────────────────────────────────
console.log("\n[5 · registration]")
{
  const pkg = JSON.parse(raw("package.json"))
  check("package.json registers test:support-isolation", typeof pkg.scripts["test:support-isolation"] === "string" && /support-isolation-guard/.test(pkg.scripts["test:support-isolation"]))
  check("guard chain membership (regex, never a position)", new RegExp("npm run test:support-isolation(\\s|&|$)").test(pkg.scripts.guard ?? ""))
  const reg = stripped("lib/kernel/manager-registry.ts")
  check("MAINTENANCE_DOMAINS.support_isolation: data_steward accountable, proof named, compliance_officer co-owns", /support_isolation:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:support-isolation",\s*coOwners:\s*\["compliance_officer"\]/.test(reg))
}

// ─── 6. LIVE (creds-gated) ───────────────────────────────────────────────────
async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.log("\n[6 · live] SKIPPED — no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (blind spot: the two counts below were measured by the 2026-10-18 census, not here)"); return }
  console.log("\n[6 · live — the two counts the ruling and m782 rest on]")
  const svc = createClient(url, key, { auth: { persistSession: false } })
  const legacy = await svc.from("users").select("id", { count: "exact", head: true }).eq("user_type", "superadmin")
  check(`live: 0 users rows carry user_type='superadmin' (got ${legacy.count ?? "?"})`, legacy.error === null && legacy.count === 0)
  const tenantSupport = await svc.from("users").select("id", { count: "exact", head: true }).eq("user_type", "support").is("platform_role", null)
  check(`live: 0 users rows are a tenant-typed 'support' seat (user_type='support', platform_role NULL) (got ${tenantSupport.count ?? "?"})`, tenantSupport.error === null && tenantSupport.count === 0)
}
await liveLayer()

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ SUPPORT_ISOLATION_FAIL — a tenant seat can read another brokerage's support queue"); process.exit(1) }
console.log(" ✅ SUPPORT_ISOLATION_PASS — a tenant seat, 'support' included, reads only its own tenancy; cross-tenant is platform_role through the one capability gate")
