/**
 * scripts/canaries/wave145-security.ts — SECURITY canary (wave 145, lane 145J; owner rulings 23 + 24, CLAUDE.md §4):
 *   the brokerage-forms bucket is per-folder ownership (tenant · team membership · admin oversight · the agent's own folder ·
 *   the deal's filled copies), revoked when membership ends, and RELEASE-BLOCKING until the live storage.objects policies are
 *   applied and verified (ruling 23); every server door that mints a signed URL or downloads with the SERVICE client checks the
 *   path's ownership first and fails closed; the FK children of a moved parent are CLASSIFIED (ownership follows parent · shared
 *   relationship remains · historical reference immutable · explicit transfer required · not transferable · derived/read-only) as
 *   DATA the transfer rail reads, and the rail never moves the two classes it may not move (ruling 24 — "do NOT move all 286");
 *   every new wave-145 table is tenant-scoped, RLS-enabled and owned by a registered manager.
 *
 * Through the survivors at b364eb4b: supabase/migrations/m853 (brokerage_forms_path_readable / _writable + the four storage
 * policies), docs/operations/OWNER-SQL.md §F (the owner-executable block + verification query), lib/kernel/brokerage-transfer.ts
 * (TRANSFER_DATA_FAMILIES — the rail's move list), scripts/schema-fk-map.ts (generated), lib/kernel/manager-registry.ts
 * (TABLE_MANAGER). Lane 145A's module names bind at the `WAVE145 BIND` lines once its notes publish them.
 *
 * MEASURED AT b364eb4b: m853's storage block could NOT be applied through the MCP (42501) — OWNER-SQL §F; the service-client
 * signed-URL / download doors carry no path-ownership check in code (the bucket policy is not consulted by a service client);
 * the transfer rail carries a MOVE list (TRANSFER_DATA_FAMILIES) and no classification of the FK children it leaves behind.
 */
import { LIVE } from "./_harness"
import { listFiles, readRepo, strippedRepo } from "./_registry"
import { memSupabase } from "../in-memory-supabase"
import { bindContract, canary145, migrationHeaderOk, quiet, sqlCode, wave145Migrations, type Ruling145Owner, type Wave145Lane } from "./wave145-harness"

// ── WAVE145 BIND (lane 145A notes, "## Canary requirements", published 15:43Z) ──────────────────────────────────────────────────
// lib/forms/tenant-form-packets.ts FORM_LIBRARY_SEAT_USER_TYPES · resolvePacketActor · issueTenantPacketUrl; lib/forms/form-path-scope.ts
// resolveFormSeatActor · checkFormPathsInScope; lib/kernel/brokerage-transfer.ts CHILD_TRANSFER_CLASSES · childTransferClass ·
// FK_CHILD_TRANSFER_CLASSIFICATION · TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN · TRANSFER_SAFETY_CRITICAL_CHILDREN ·
// transferClassificationProblems; migrations m854-brokerage-forms-seat-scoped-path-rules / m855-brokerage-forms-storage-policies-owner.
// Asserted as the RULING: e.g. lane 145A's "TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN.length === 0" is a WAYPOINT (true only until the
// owner authorizes) — the canary asserts the rule "every authorized following child is follows-parent" and makes the authorization a
// pending-owner step instead (CLAUDE.md §2).

const FORMS_BUCKET_REF = /\.storage\s*\.from\(\s*(FORM_PACKET_BUCKET|FORMS_BUCKET|FILLED_BUCKET|PLATFORM_PACKET_BUCKET|["']brokerage-forms["'])\s*\)\s*\.\s*(createSignedUrl|createSignedUrls|download)\s*\(/g
const SERVICE_CLIENT_BEFORE = /(\bsvc|\bservice\w*|\badmin\w*|createServiceClient\(\))\s*$/

/** PURE — the service-client doors on the forms bucket in one file's STRIPPED source (line numbers kept by stripComments). */
export function formsBucketServiceDoors(src: string): Array<{ line: number; op: string }> {
  const out: Array<{ line: number; op: string }> = []
  for (const m of src.matchAll(FORMS_BUCKET_REF)) {
    const before = src.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0)
    if (!SERVICE_CLIENT_BEFORE.test(before.replace(/\s+$/, ""))) continue
    out.push({ line: src.slice(0, m.index ?? 0).split("\n").length, op: m[2] })
  }
  return out
}

/** PURE — the storage.objects policies for one bucket in a migration's SQL code (comment lines dropped). */
export function bucketPolicies(sql: string, bucket: string): Array<{ name: string; cmd: string; body: string }> {
  const out: Array<{ name: string; cmd: string; body: string }> = []
  for (const m of sqlCode(sql).matchAll(/CREATE\s+POLICY\s+"([^"]+)"\s+ON\s+storage\.objects\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b([\s\S]*?);/gi)) {
    if (m[3].includes(`'${bucket}'`)) out.push({ name: m[1], cmd: m[2].toUpperCase(), body: m[3] })
  }
  return out
}

/** PURE — a policy is OWNERSHIP-scoped when its predicate reads a path-ownership function, never the bucket alone. */
export function policyIsOwnershipScoped(body: string): boolean {
  return /brokerage_forms_path_(readable|writable)\s*\(|\bforms?_path_\w*\s*\(/.test(body)
}

/** PURE — the arms of a `brokerage_forms_path_*` function: the first path segment each `split_part(p_name,'/',1) = '<x>'` admits. */
export function pathRuleArms(sql: string, fn: "brokerage_forms_path_readable" | "brokerage_forms_path_writable"): string[] | null {
  const code = sqlCode(sql)
  const at = code.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\(`, "i"))
  if (at < 0) return null
  const body = code.slice(at, code.indexOf("$$;", code.indexOf("$$", at) + 2) + 3)
  return [...body.matchAll(/split_part\(\s*p_name\s*,\s*'\/'\s*,\s*1\s*\)\s*=\s*'([a-z_]+)'/g)].map((m) => m[1])
}

export async function run() {
  const c = canary145("Security: per-folder ownership of the brokerage-forms bucket, release-blocking until applied live · service-client doors fail closed · FK children CLASSIFIED and never moved when they may not be · new tables tenant-scoped + RLS + owned")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory / static only")
  const migs = listFiles("supabase/migrations", (f) => /\/m\d{3}-[^/]+\.sql$/.test(f)).sort()

  // ── 1 · THE POLICY SET IS PER-FOLDER OWNERSHIP (ruling 23; m853 is the survivor, a 145A successor supersedes it) ──
  const withPolicies = migs.filter((f) => bucketPolicies(readRepo(f) ?? "", "brokerage-forms").length > 0)
  const latest = withPolicies[withPolicies.length - 1] ?? null
  const pols = latest ? bucketPolicies(readRepo(latest) ?? "", "brokerage-forms") : []
  const cmds = new Set(pols.map((p) => p.cmd))
  const openOnes = pols.filter((p) => !policyIsOwnershipScoped(p.body))
  // POSITIVE CONTROL: the open shape OWNER-SQL §F replaces (bucket-only) is caught; the owner shape is not.
  const openSpecimen = `CREATE POLICY "auth read brokerage-forms" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'brokerage-forms');`
  const ownerSpecimen = `CREATE POLICY "brokerage-forms owner read" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_readable(name));`
  const controlOk = !policyIsOwnershipScoped(bucketPolicies(openSpecimen, "brokerage-forms")[0]?.body ?? "") && policyIsOwnershipScoped(bucketPolicies(ownerSpecimen, "brokerage-forms")[0]?.body ?? "x")
  c.rule("145A", "THE BUCKET IS PER-FOLDER OWNERSHIP, NEVER 'ANY SIGNED-IN USER' (ruling 23; wave 144 P1): the newest migration that writes storage.objects policies for 'brokerage-forms' covers SELECT, INSERT, UPDATE and DELETE, and every one of them is bound to a path-ownership rule — none admits on the bucket id alone (positive control: the open bucket-only shape §F removes IS caught; the owner shape is not)", !!latest && ["SELECT", "INSERT", "UPDATE", "DELETE"].every((k) => cmds.has(k)) && openOnes.length === 0 && controlOk, `latest ${latest ?? "none"}: ${pols.map((p) => `${p.cmd} "${p.name}"`).join(" · ") || "no policies"}${openOnes.length ? `; OPEN: ${openOnes.map((p) => p.name).join(", ")}` : ""}; control ${controlOk}`)

  // ── 2 · THE PATH RULE COVERS THE WHOLE OWNERSHIP SET, READ AT QUERY TIME (so membership end revokes) ──
  const fnMig = [...migs].reverse().find((f) => /FUNCTION\s+public\.brokerage_forms_path_readable/i.test(sqlCode(readRepo(f) ?? ""))) ?? null
  const fnSql = fnMig ? readRepo(fnMig) ?? "" : ""
  const readArms = pathRuleArms(fnSql, "brokerage_forms_path_readable") ?? []
  const writeArms = pathRuleArms(fnSql, "brokerage_forms_path_writable") ?? []
  const readsMembershipLive = /current_user_brokerage_id\(\)/.test(fnSql) && /(resolve_team_id|current_user_led_team_id)\s*\(/.test(fnSql) && /auth\.uid\(\)/.test(fnSql)
  const noStaticGrant = !/storage_grants|forms_path_grants|path_acl/i.test(sqlCode(fnSql))
  c.rule("145A", "THE PATH RULE IS THE WHOLE OWNERSHIP SET AND IS READ AT QUERY TIME (ruling 23: tenant ownership, team membership, admin oversight, path ownership, revocation on membership end): the readable rule admits brokerage/<own tenant>, teams/<own team or brokerage oversight>, agents/<self>, filled/<self or an own-tenant offer>; the writable rule never lets a browser session write filled/ or platform/; both read the CURRENT membership (current_user_brokerage_id / resolve_team_id / auth.uid) — no stored grant to forget, so leaving a team or brokerage revokes at once", ["brokerage", "teams", "agents", "filled"].every((a) => readArms.includes(a)) && !writeArms.includes("filled") && !writeArms.includes("platform") && readsMembershipLive && noStaticGrant, `${fnMig ?? "no path function"}: read arms ${readArms.join(",") || "none"}; write arms ${writeArms.join(",") || "none"}; live membership ${readsMembershipLive}`)

  // ── 2b · ONLY AN ACTIVE STAFF SEAT PASSES THE PATH RULE (lane 145A: m*-brokerage-forms-seat-scoped-path-rules.sql, found by NAME) ──
  const seatMig = migs.find((f) => /\/m\d+-brokerage-forms-seat-scoped-path-rules\.sql$/.test(f)) ?? null
  const seatSql = seatMig ? readRepo(seatMig) ?? "" : ""
  const seatCode = sqlCode(seatSql)
  const fnBody = (fn: string) => { const at = seatCode.search(new RegExp(`FUNCTION\\s+public\\.${fn}\\s*\\(`, "i")); return at < 0 ? "" : seatCode.slice(at, seatCode.indexOf("$$;", seatCode.indexOf("$$", at) + 2) + 3) }
  const seatFn = fnBody("brokerage_forms_seat_active")
  const seatList = /user_type\s+IN\s*\(([^)]*)\)/i.exec(seatFn)?.[1] ?? ""
  const seatExcludes = !!seatList && !/'(contact|vendor|isa|system|support)'/.test(seatList) && /'agent'/.test(seatList)
  const readGated = /brokerage_forms_seat_active\(\)/.test(fnBody("brokerage_forms_path_readable")) && /position\('\.\.'/.test(fnBody("brokerage_forms_path_readable"))
  const writeArmsSeat = pathRuleArms(seatSql, "brokerage_forms_path_writable") ?? []
  const writeOnlyOwn = /brokerage_forms_seat_active\(\)/.test(fnBody("brokerage_forms_path_writable")) && writeArmsSeat.length > 0 && writeArmsSeat.every((a) => a === "agents")
  c.rule("145A", "ONLY AN ACTIVE STAFF SEAT PASSES THE BUCKET'S PATH RULE (ruling 23 + §5 — lane 145A's seat-scoped path rules, found by NAME): the readable rule sits behind a seat predicate that admits the staff roster + agent + tc and never a contact / vendor / isa / system / support seat, refuses '..'; a browser session writes ONLY its own agents/{uid}/ folder (no brokerage / teams / filled / platform arm); line 1 is the lane stamp or APPLIED LIVE", !!seatMig && migrationHeaderOk(seatSql, "145A") && seatExcludes && readGated && writeOnlyOwn, seatMig ? `${seatMig.split("/").pop()}: seat list (${seatList.replace(/\s+/g, "")}) excludes contact/vendor ${seatExcludes}; readable seat-gated + '..' refused ${readGated}; writable arms ${writeArmsSeat.join(",") || "none"}` : "no m*-brokerage-forms-seat-scoped-path-rules.sql yet (lane 145A)")

  // ── 3 · RELEASE-BLOCKING UNTIL APPLIED LIVE AND VERIFIED (ruling 23) — an OWNER action, not a lane's ──
  // Lane 145I's requirement 2: judged by scripts/migration-status.ts claimOf (the ONE header recogniser) on every lane-145A migration
  // (m854–m855) that names storage.objects + brokerage-forms; before 145A writes one, on the survivor m853 (whose header is applied
  // but whose own NOTE says its storage block could NOT be applied through the MCP).
  const { claimOf } = await import("../migration-status")
  const aStorage = wave145Migrations().filter((m) => m.lane === "145A" && /storage\.objects/i.test(sqlCode(m.sql)) && /brokerage-forms/.test(sqlCode(m.sql)))
  const policySql = latest ? readRepo(latest) ?? "" : ""
  const storageApplied = aStorage.length > 0
    ? aStorage.every((m) => claimOf(m.sql) === "applied")
    : claimOf(policySql) === "applied" && !/could NOT be applied/i.test(policySql.split("\n").slice(0, 6).join("\n"))
  const ownerSql = readRepo("docs/operations/OWNER-SQL.md") ?? ""
  const verifyQuery = /FROM\s+pg_policies[\s\S]{0,200}brokerage-forms/i.test(ownerSql)
  c.pendingOwner("145A", "THE LIVE storage.objects POLICIES ARE APPLIED AND VERIFIED (ruling 23 — release-blocking): every lane-145A migration that writes the brokerage-forms storage.objects policies reads 'applied' (scripts/migration-status.ts claimOf) — before one exists, the m853 survivor's storage block carries no 'could NOT be applied' note — and the owner block carries its pg_policies verification query", storageApplied && verifyQuery, "Run the brokerage-forms storage.objects policy block (docs/operations/OWNER-SQL.md §F, or lane 145A's m854/m855 owner SQL) in the Supabase SQL editor as the storage owner, run its pg_policies verification query (expect exactly the owner policies), then stamp the migration's line 1 applied — RELEASE STAYS BLOCKED until then (ruling 23; the MCP role is refused with 42501)", `${aStorage.length ? aStorage.map((m) => `${m.file.split("/").pop()}: ${claimOf(m.sql)}`).join(", ") : `${latest ?? "no policy migration"}: ${claimOf(policySql)} + 'could NOT be applied' note`}; §F verification query ${verifyQuery}`)

  // Lane 145I's requirement 2: the release gate itself reads it — the readiness guard prints a WAVE 145 GATE line whose `security`
  // gate is never CERTIFIED while the storage block is unapplied. The guard is spawned only once lane 145I's gate exists in its source
  // (running it costs ~70 s; at b364eb4b there is nothing to read).
  const prGuard = strippedRepo("scripts/production-readiness-guard.ts") ?? ""
  let gateLine = "", gateEvidence = "lane 145I's WAVE 145 GATE is not in scripts/production-readiness-guard.ts yet"
  if (/WAVE 145 GATE/.test(prGuard)) {
    const { spawnSync } = await import("node:child_process")
    const r = spawnSync("npx", ["tsx", "scripts/production-readiness-guard.ts"], { encoding: "utf8", timeout: 300_000, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=6000" } })
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
    // RE-ASSERTED (wave 145, lane 145Z): the gate table prints each row as `<VERDICT> <gate> owner …` — the verdict FIRST — so
    // the original `^\s*security` filter never saw the wave-145 security row; it read the summary line, which names only the
    // NOT CERTIFIED gates (an EXTERNAL security gate is absent from it). The RULE is read from the G″ (wave 145) section's
    // own security row, never from the wave-141 section's row of the same name.
    const lines145 = out.split("\n")
    const g2 = lines145.findIndex((l) => /\[G″ · wave 145 gates/.test(l))
    const section = g2 >= 0 ? lines145.slice(g2 + 1, g2 + 40).filter((l) => /^\s*(CERTIFIED|EXTERNAL|NOT CERTIFIED)\s+\S/.test(l)) : []
    const securityRow = section.find((l) => /^\s*(CERTIFIED|EXTERNAL|NOT CERTIFIED)\s+security\s/.test(l)) ?? ""
    gateLine = [lines145.find((l) => /WAVE 145 GATE/.test(l)) ?? "", securityRow.replace(/\s+/g, " ").trim()].filter(Boolean).join(" · ").slice(0, 900)
    gateEvidence = gateLine || `guard ran (exit ${r.status}) but printed no WAVE 145 GATE line`
  }
  const gateNamesSecurity = /WAVE 145 GATE/.test(gateLine) && /\b(CERTIFIED|EXTERNAL|NOT CERTIFIED) security\b/.test(gateLine)
  const certifiedRe = /(^|· )CERTIFIED security\b/
  const securityCertified = certifiedRe.test(gateLine)
  // POSITIVE CONTROL for the row parse: a CERTIFIED row is read as certified; NOT CERTIFIED / EXTERNAL rows are not.
  const gateParseControl = certifiedRe.test("WAVE 145 GATE: 9/10 · CERTIFIED security owner data_steward")
    && !certifiedRe.test("WAVE 145 GATE: 8/10 · NOT CERTIFIED security owner data_steward") && !certifiedRe.test("WAVE 145 GATE: 8/10 · EXTERNAL security owner data_steward")
  c.rule("145I", "RULING 23 IS RELEASE-BLOCKING IN THE RELEASE GATE ITSELF (ruling 23; lane 145I requirement 2): `test:production-readiness` prints the WAVE 145 GATE and its security gate reads EXTERNAL / NOT CERTIFIED — never CERTIFIED — while the brokerage-forms storage policies are unapplied", gateParseControl && gateNamesSecurity && (storageApplied || !securityCertified), gateEvidence)

  // ── 3b · THE AUTONOMY BOUNDARY (lane 145I item 3: 'no autonomous production-code mutation without the deployment control') ──
  const ip = await quiet(async () => import("../../lib/kernel/improvement-proposals"))
  const sh = await quiet(async () => import("../../lib/kernel/self-healing"))
  const CODE_ACTION = /code|deploy|migration|schema|sql|release|commit/i
  const codeKinds = (ip.PROPOSAL_SUBJECT_KINDS as readonly string[]).filter((k) => CODE_ACTION.test(k))
  const codePlaybooks = Object.entries(sh.SELF_HEAL_PLAYBOOKS as Record<string, { label: string }>).filter(([k, v]) => CODE_ACTION.test(k) || /\b(deploy|migration|commit|release|code change)\b/i.test(v.label)).map(([k]) => k)
  const deployRefused = !sh.validatePlaybookSelection("provider", { playbook: "deploy_fix" }, new Set(["deploy_fix"])).ok
  const retryOk = sh.validatePlaybookSelection("provider", { playbook: "retry" }, new Set(["retry"])).ok // POSITIVE CONTROL
  c.rule("145I", "MANAGERS NEVER MUTATE PRODUCTION CODE ON THEIR OWN (lane 145I item 3; preamble: 'production code changes, security loosening and consequential money/legal changes need human review'): no improvement-proposal subject kind and no self-healing playbook is a code / deploy / migration / schema / SQL / release action; an invented 'deploy_fix' playbook is REFUSED even with an executor offered (positive control: a declared 'retry' with its executor is accepted)", codeKinds.length === 0 && codePlaybooks.length === 0 && deployRefused && retryOk, `proposal kinds ${(ip.PROPOSAL_SUBJECT_KINDS as readonly string[]).join(",")} (code-like ${codeKinds.join(",") || "none"}); code-like playbooks ${codePlaybooks.join(",") || "none"}; deploy_fix refused ${deployRefused}; retry accepted ${retryOk}`)

  // ── 4 · SERVICE-CLIENT DOORS FAIL CLOSED (lane 145A item 2: "prove in code that every signed URL / download path checks
  //        brokerage_forms_path_readable semantics before minting") — driven through lane 145A's published doors ──
  // The census of service-client doors (stripped source) is EVIDENCE beside the step; lane 145A's own guard
  // (scripts/transfer-classification-guard.ts B3 `DOORS`) declares every door with its gate and is the per-door proof.
  const serverFiles = [...listFiles("lib", (f) => /\.tsx?$/.test(f)), ...listFiles("app", (f) => /\.tsx?$/.test(f))]
  const doors: Array<{ file: string; line: number; op: string }> = []
  for (const f of serverFiles) {
    const s = strippedRepo(f) ?? ""
    if (/^\s*["']use client["']/.test(s)) continue
    for (const d of formsBucketServiceDoors(s)) doors.push({ file: f, ...d })
  }
  // POSITIVE CONTROL for the census: the HEAD door app/api/form-wizard/form-packets/route.ts is found; a browser-client call is not.
  const censusControl = doors.some((d) => d.file === "app/api/form-wizard/form-packets/route.ts") && formsBucketServiceDoors(`const { data } = await supabase.storage.from("brokerage-forms").createSignedUrl(p, 60)`).length === 0
  const packets = await bindContract({ id: "145A forms seat + minting door", lane: "145A", file: "lib/forms/tenant-form-packets.ts", exports: ["FORM_LIBRARY_SEAT_USER_TYPES", "resolvePacketActor", "issueTenantPacketUrl"] })
  // The service-door path check (checkFormPathsInScope) — its seat is resolvePacketActor's (lane 145A's 16:10Z notes dropped resolveFormSeatActor).
  const scope = await bindContract({ id: "145A form-path scope door", lane: "145A", file: "lib/forms/form-path-scope.ts", exports: ["checkFormPathsInScope"] })
  // The seat fixture: one brokerage, the staff seats the ruling admits, the seats it never admits, and the revocation cases.
  const B = "aaaaaaaa-0000-4000-8000-000000000001", B2 = "aaaaaaaa-0000-4000-8000-000000000002", T = "aaaaaaaa-0000-4000-8000-0000000000aa"
  const U = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`
  const users = [
    { id: U(1), brokerage_id: B, user_type: "agent", status: "active", deleted_at: null, platform_role: null },
    { id: U(2), brokerage_id: B, user_type: "contact", status: "active", deleted_at: null, platform_role: null },
    { id: U(3), brokerage_id: B, user_type: "vendor", status: "active", deleted_at: null, platform_role: null },
    { id: U(4), brokerage_id: B, user_type: "agent", status: "suspended", deleted_at: null, platform_role: null },
    { id: U(5), brokerage_id: B, user_type: "agent", status: "active", deleted_at: "2026-10-01T00:00:00Z", platform_role: null },
    { id: U(6), brokerage_id: B, user_type: "agent", status: "active", deleted_at: null, platform_role: null },
    { id: U(7), brokerage_id: B, user_type: "broker_owner", status: "active", deleted_at: null, platform_role: null },
    { id: U(8), brokerage_id: B2, user_type: "agent", status: "active", deleted_at: null, platform_role: null },
  ]
  const signed: Array<{ path: string; ttl: number }> = []
  const seatDb = memSupabase({ users, agents: [{ id: "ag-6", user_id: U(6), brokerage_id: B, is_active: false }], teams: [{ id: T, brokerage_id: B, team_lead_id: null, deleted_at: null }], team_members: [] }, { uuidIds: true })
  ;(seatDb as unknown as Record<string, unknown>).storage = { from: () => ({ createSignedUrl: async (path: string, ttl: number) => { signed.push({ path, ttl }); return { data: { signedUrl: `https://signed.example.test/${path}?e=${ttl}` }, error: null } } }) }
  await c.check("145A", "ONLY AN ACTIVE STAFF SEAT REACHES THE FORMS BUCKET, AND LEAVING REVOKES IT (ruling 23: tenant ownership, revocation on membership end; §5 contacts / vendors see nothing of the brokerage's): FORM_LIBRARY_SEAT_USER_TYPES admits agent, tc and the broker roster and never contact / vendor / isa / system / support; the ONE actor door (resolvePacketActor, and resolveFormSeatActor for every service door) refuses a portal contact, a vendor seat, a suspended account, a removed account and an agent deactivated in that brokerage — and admits an agent with no agents row (the users row decides)", async () => {
    if (!packets.mod || !scope.mod) return { ok: false, evidence: `${packets.evidence}; ${scope.evidence}` }
    const seats = packets.mod.FORM_LIBRARY_SEAT_USER_TYPES as ReadonlySet<string>
    const seatsOk = ["agent", "tc", "broker_owner"].every((t) => seats.has(t)) && !["contact", "vendor", "isa", "system", "support"].some((t) => seats.has(t))
    const v = async (u: string) => (await quiet(async () => packets.mod!.resolvePacketActor(seatDb, u))) as { ok: boolean; error?: string }
    const refused = await Promise.all([U(2), U(3), U(4), U(5), U(6)].map(v))
    const agent = await v(U(1))
    const contactSeat = typeof scope.mod.resolveFormSeatActor === "function" ? (await quiet(async () => scope.mod!.resolveFormSeatActor(seatDb, U(2)))) as { ok: boolean } : { ok: false }
    return { ok: seatsOk && refused.every((r) => !r.ok) && agent.ok && !contactSeat.ok, evidence: `seat roster ok ${seatsOk}; contact/vendor/suspended/removed/deactivated → ${refused.map((r) => (r.ok ? "ADMITTED" : "refused")).join("/")}; agent without agents row → ${agent.ok ? "admitted" : `refused (${agent.error})`}; resolveFormSeatActor(contact) → ${contactSeat.ok ? "ADMITTED" : "refused"}` }
  })
  await c.check("145A", "THE ONE MINTING DOOR FAILS CLOSED AND MINTS SHORT-LIVED LINKS ONLY (ruling 23 + lane 145A item 2 — every signed URL checks the readable semantics before minting): issueTenantPacketUrl signs ONLY the row's own registered master (brokerage/{b}/packets/{row}/… or teams/{t}/packets/{row}/…) for an actor who may see it — another brokerage's row, a path that is not the row's own, and a retired row for 'use' are refused BEFORE any URL exists; a retired row is still reachable to MANAGE by the brokerage's oversight; every link lives ≤ 1 hour; the admin route mints through it and persists no URL (census of service doors beside it)", async () => {
    if (!packets.mod) return { ok: false, evidence: packets.evidence }
    const act = async (u: string) => ((await quiet(async () => packets.mod!.resolvePacketActor(seatDb, u))) as { ok: boolean; actor?: Record<string, unknown> }).actor
    const agent = await act(U(1)), owner = await act(U(7))
    const R1 = "dddddddd-0000-4000-8000-000000000001", R2 = "dddddddd-0000-4000-8000-000000000002"
    const row = (over: Record<string, unknown> = {}) => ({ id: R1, brokerage_id: B, team_id: null, is_active: true, license_expires_at: null, storage_path: `brokerage/${B}/packets/${R1}/purchase.pdf`, ...over })
    const mint = async (a: unknown, r: Record<string, unknown>, p: "use" | "manage") => (await quiet(async () => packets.mod!.issueTenantPacketUrl(seatDb, a, r, p, new Date("2026-10-27T15:00:00Z")))) as { ok: boolean; ttlSeconds?: number; reason?: string }
    const before = signed.length
    const own = await mint(agent, row(), "use")
    const foreign = await mint(agent, row({ brokerage_id: B2, storage_path: `brokerage/${B2}/packets/${R1}/purchase.pdf` }), "use")
    const wrongPath = await mint(agent, row({ storage_path: `brokerage/${B}/packets/${R2}/other.pdf` }), "use")
    const retiredUse = await mint(agent, row({ is_active: false }), "use")
    const retiredManage = await mint(owner, row({ is_active: false }), "manage")
    const mintedPaths = signed.slice(before).map((s) => s.path)
    const ttlOk = signed.slice(before).every((s) => s.ttl <= 3600)
    const route = strippedRepo("app/api/admin/transaction-forms/route.ts") ?? ""
    const routeOk = /\bissueTenantPacketUrl\s*\(/.test(route) && !/update\(\s*\{[^}]*\bpdf_url\b/.test(route)
    const ok = !!agent && !!owner && own.ok && !foreign.ok && !wrongPath.ok && !retiredUse.ok && retiredManage.ok && ttlOk && mintedPaths.every((p) => p === `brokerage/${B}/packets/${R1}/purchase.pdf`) && routeOk && censusControl
    return { ok, evidence: `own → ${own.ok ? `ok ttl ${own.ttlSeconds}` : own.reason}; foreign → ${foreign.ok ? "MINTED" : "refused"}; wrong path → ${wrongPath.ok ? "MINTED" : "refused"}; retired use → ${retiredUse.ok ? "MINTED" : "refused"}; retired manage (oversight) → ${retiredManage.ok ? "ok" : retiredManage.reason}; signed ${mintedPaths.length} (ttl ≤ 3600 ${ttlOk}); admin route through the door, no persisted URL ${routeOk}; service doors in the census ${doors.length}` }
  })

  // ── 5 · RULING 24: THE FK CHILDREN ARE CLASSIFIED AS DATA THE RAIL READS ──
  const transfer = await quiet(async () => import("../../lib/kernel/brokerage-transfer")) as unknown as Record<string, any>
  const families = (transfer.TRANSFER_DATA_FAMILIES as Array<{ table: string }>).map((f) => f.table)
  const moved = new Set(families)
  const fk = (await import("../schema-fk-map")).SCHEMA_FK_MAP
  const snap = (await import("../schema-snapshot")).SCHEMA_SNAPSHOT as Record<string, string[]>
  // The tenant-scoped FK children of the parents the rail moves (generated caches — the live database's FKs and columns): the SAME
  // derivation as scripts/brokerage-identity-guard.ts's FK-closure census (the "286" of ruling 24), so both count one set.
  const children = Object.entries(fk).filter(([t, cols]) => (snap[t] ?? []).includes("brokerage_id") && Object.values(cols).some((parent) => moved.has(parent))).map(([t]) => t)
  const unmoved = children.filter((t) => !moved.has(t))
  const table = (transfer.FK_CHILD_TRANSFER_CLASSIFICATION ?? null) as Record<string, { cls: string }> | null
  const classOf = table ? (t: string): string | null => (moved.has(t) ? "follows_parent" : table[t]?.cls ?? null) : null
  const CLASSES = (transfer.CHILD_TRANSFER_CLASSES ?? []) as readonly string[]
  // THE SIX RULED CONCEPTS (ruling 24), each matched by meaning so a lane's spelling is free: ownership follows parent · shared
  // relationship remains · historical reference immutable · explicit transfer required · not transferable · derived/read-only.
  const CONCEPTS = [/follow/, /shared/, /histor|immutable/, /explicit/, /not_transfer|non_transfer/, /derived|read_?only/]
  const conceptsOk = CLASSES.length === 6 && CONCEPTS.every((re) => CLASSES.filter((k) => re.test(k)).length === 1)
  const unclassified = classOf ? unmoved.filter((t) => !CLASSES.includes(classOf(t) ?? "")) : unmoved
  const familyKeyed = table ? families.filter((t) => t in table) : []
  const finRecord = classOf ? classOf("agent_commissions") : null
  const agreement = classOf ? classOf("listing_agreements") : null
  c.rule("145A", "THE FK CHILDREN OF A MOVED PARENT ARE CLASSIFIED — AS DATA THE RAIL READS (ruling 24: 'Classify each FK child relationship … do NOT move all 286'): the rail's classes are exactly the six ruled ones (follows parent · shared remains · historical immutable · explicit transfer · not transferable · derived read-only); every tenant-scoped FK child of a moved table that the rail does not move has exactly one; a moved family is never itself classified as a child; another party's financial record (agent_commissions) is NOT transferable and an executed agreement (listing_agreements) needs an EXPLICIT transfer", conceptsOk && !!table && unclassified.length === 0 && familyKeyed.length === 0 && /not_transfer|non_transfer/.test(finRecord ?? "") && /explicit/.test(agreement ?? ""), `${children.length} FK children of ${moved.size} moved tables, ${unmoved.length} not moved; classes ${CLASSES.join(",") || "— (lane 145A not landed)"}; unclassified ${unclassified.length}; families keyed as children ${familyKeyed.join(",") || "none"}; agent_commissions → ${finRecord ?? "∅"}; listing_agreements → ${agreement ?? "∅"}`)

  // ── 6 · …AND THE REAL RAIL NEVER MOVES WHAT IT MAY NOT (ruling 24: never another party's contacts, confidential documents, financial
  //        records or unrelated brokerage property because an agent changes brokerage; live transfers only on explicit authorization) —
  //        driven through runBrokerageTransferMigration on lane 145A's own fixture (scripts/transfer-classification-guard.ts A3) ──
  const authorized = (transfer.TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN ?? null) as readonly string[] | null
  await c.check("145A", "THE RAIL NEVER MOVES A PROTECTED CHILD, AND SAYS WHAT STAYED (ruling 24): a consented adoption moves every FAMILY to the target while another party's money (agent_commissions), an executed agreement (listing_agreements), a sent message (communications) and a contact's opt-out (contact_suppression_list) stay in the source, a decoy tenant is untouched, and what stayed for a human is COUNTED (explicit transfers + the safety-critical opt-out); naming a not-transferable child for moving is REFUSED at verification and then NOTHING moves — not even the families (fail closed)", async () => {
    if (!table || !authorized || typeof transfer.runBrokerageTransferMigration !== "function") return { ok: false, evidence: "lane 145A's classification is not on the rail yet (FK_CHILD_TRANSFER_CLASSIFICATION / TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN)" }
    const NOW = new Date("2026-10-27T15:00:00Z")
    const runRail = async (seam: readonly string[] | undefined) => {
      const T = "cccccccc-0000-4000-8000-000000000001", S = "cccccccc-0000-4000-8000-000000000002", D = "cccccccc-0000-4000-8000-000000000003", A = "cccccccc-0000-4000-8000-0000000000a1", O = "cccccccc-0000-4000-8000-0000000000b1", REQ = "cccccccc-0000-4000-8000-0000000000ff"
      const seed: Record<string, Array<Record<string, unknown>>> = {
        brokerages: [
          { id: T, name: "Harbor Realty", plan_tier: "brokerage", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: null },
          { id: S, name: "Dana Solo", plan_tier: "solo_agent", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: null },
          { id: D, name: "Decoy", plan_tier: "solo_agent", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: null },
        ],
        users: [
          { id: A, email: "max@harbor.example.test", brokerage_id: T, user_type: "broker_owner", platform_role: null, first_name: "Max", last_name: "Ng", team_id: null },
          { id: O, email: "dana@solo.example.test", brokerage_id: S, user_type: "admin", platform_role: null, first_name: "Dana", last_name: "Lee", team_id: null },
        ],
        agents: [{ id: "ag-o", user_id: O, brokerage_id: S, team_id: null }], teams: [], user_role_assignments: [],
        brokerage_transfer_requests: [{
          id: REQ, brokerage_id: T, source_brokerage_id: S, target_brokerage_id: T, subject_user_id: O, initiated_by_user_id: A, target_role: "agent", status: "consented", reason: null,
          consent: { user_id: O, at: NOW.toISOString(), decision: "consent", statement: "I consent to joining Harbor Realty", channel: "settings_ui", request_snapshot: { source_brokerage_id: S, target_brokerage_id: T, target_role: "agent", source_name: "Dana Solo", target_name: "Harbor Realty" } },
          verification: null, migration: null, billing_handoff: null, readiness: null, effective_at: null, completed_at: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }],
        agent_action_ledger: [], notifications: [], lifecycle_events: [], brokerage_form_library: [],
      }
      for (const fam of families) seed[fam] = [{ id: `${fam}-s`, brokerage_id: S }, { id: `${fam}-d`, brokerage_id: D }]
      for (const t of ["agent_commissions", "listing_agreements", "contact_suppression_list", "communications"]) seed[t] = [{ id: `${t}-s`, brokerage_id: S, contact_id: "contacts-s", transaction_id: "transactions-s" }, { id: `${t}-d`, brokerage_id: D }]
      const svc = memSupabase(seed as never, { uuidIds: true })
      const deps = {
        now: () => NOW,
        assignUserToBrokerage: async (p: { userId: string; brokerageId: string }) => { await svc.from("users").update({ brokerage_id: p.brokerageId }).eq("id", p.userId); await svc.from("agents").update({ brokerage_id: p.brokerageId }).eq("user_id", p.userId); return { success: true } },
        assignRole: async (p: { userId: string; newRole: string }) => { await svc.from("users").update({ user_type: p.newRole }).eq("id", p.userId); return { success: true } },
        domainRecords: async () => ({ success: true, agentId: "ag", coordinatorId: null, domainRecordsCreated: [] }),
        seatGate: async () => ({ allowed: true, reason: "within_limit", message: null }),
        tierAllowsRole: () => true,
        mayUseAndAfford: async () => ({ allowed: true, reason: "ok" }),
        billingHandoff: async () => ({ ok: true, mode: "fixture", effectiveAt: NOW.toISOString() }),
        readiness: async () => ({ ready: true, blockers: [], checkedAt: NOW.toISOString() }),
        reportOutcome: async () => ({}), emit: async () => ({}), notifyAdmins: async () => 1, notifyStaff: async () => 1,
        ...(seam ? { authorizedFollowingChildren: seam } : {}),
      }
      const r = (await quiet(async () => transfer.runBrokerageTransferMigration(svc, { requestId: REQ, actor: { userId: A, brokerageId: T, kind: "target_admin" } }, deps))) as { ok: boolean; stalledAt?: string | null; error?: string }
      const where = (t: string, id: string) => (svc.tables[t] ?? []).find((x) => x.id === id)?.brokerage_id
      const req = (svc.tables.brokerage_transfer_requests ?? []).find((x) => x.id === REQ) as Record<string, any>
      return { r, where, req, S, T, D }
    }
    const one = await runRail(undefined)
    const stayed = ["agent_commissions", "listing_agreements", "contact_suppression_list", "communications"].every((t) => one.where(t, `${t}-s`) === one.S)
    const familiesMoved = one.where("contacts", "contacts-s") === one.T && one.where("transactions", "transactions-s") === one.T
    const decoy = ["contacts", "agent_commissions", "listing_agreements"].every((t) => one.where(t, `${t}-d`) === one.D)
    const closure = one.req?.migration?.closure as { explicit_transfer?: Record<string, number>; safety_critical?: Record<string, number> } | undefined
    const counted = (closure?.explicit_transfer?.listing_agreements ?? 0) >= 1 && (closure?.safety_critical?.contact_suppression_list ?? 0) >= 1
    const bad = await runRail(["agent_commissions"])
    const vchecks = (bad.req?.verification?.checks ?? []) as Array<{ key: string; ok: boolean }>
    const refused = !bad.r.ok && bad.r.stalledAt === "verification" && vchecks.some((x) => /classif/.test(x.key) && !x.ok) && bad.where("contacts", "contacts-s") === bad.S && bad.where("agent_commissions", "agent_commissions-s") === bad.S
    return { ok: one.r.ok && familiesMoved && stayed && decoy && counted && refused, evidence: `adoption → ${one.r.ok ? "completed" : one.r.error}; families moved ${familiesMoved}; protected children stayed ${stayed}; decoy untouched ${decoy}; closure ${JSON.stringify(closure ?? null).slice(0, 120)}; naming agent_commissions → ${bad.r.ok ? "MOVED" : `stalled at ${bad.r.stalledAt}`}, families stayed ${bad.where("contacts", "contacts-s") === bad.S}` }
  })
  const authorizedBad = classOf && authorized ? authorized.filter((t) => !/follow/.test(classOf(t) ?? "")) : []
  const safety = (transfer.TRANSFER_SAFETY_CRITICAL_CHILDREN ?? []) as readonly string[]
  c.rule("145A", "A FOLLOWING CHILD MOVES ONLY ON AUTHORIZATION, AND AN OPT-OUT IS SAFETY-CRITICAL (ruling 24: 'live transfers only on explicit authorization'): every owner-AUTHORIZED following child is classified follows-parent (the RULE — never a pinned count), and the contact suppression list is named safety-critical so an opt-out is never silently left behind; the explicit-transfer queue routes to a registered manager", !!classOf && !!authorized && authorizedBad.length === 0 && safety.includes("contact_suppression_list") && typeof (transfer.TRANSFER_HUMAN_ROUTES as Record<string, string> | undefined)?.explicit_transfer_pending === "string", classOf ? `authorized ${authorized?.length ?? "∅"} (not follows-parent ${authorizedBad.join(",") || "none"}); safety-critical ${safety.join(",") || "none"}; explicit-transfer route ${(transfer.TRANSFER_HUMAN_ROUTES as Record<string, string> | undefined)?.explicit_transfer_pending ?? "∅"}` : "no classification — awaiting lane 145A")
  // Emitted once the classification has landed (before that, the steps above are red-awaiting-lane-145A — no double count).
  if (authorized) c.pendingOwner("145A", "THE OWNER AUTHORIZES THE SAFETY BATCH TO FOLLOW (ruling 24: 'live transfers only on explicit authorization'; lane 145A owner-approval plan Step 0): the contact suppression list follows a moved contact so an opt-out survives the move", authorized.includes("contact_suppression_list"), "Approve docs/architecture/FK-CHILD-TRANSFER-CLASSIFICATION.md §Owner-approval plan Step 0 (authorize contact_suppression_list to follow its contact), then batches A–D as the plan names them; explicit_transfer stays per-transfer, not_transferable never moves", `authorized following children: ${authorized.join(", ") || "none"}`)

  // ── 7 · NEW WAVE-145 TABLES: tenant-scoped + RLS in the same migration (each lane) and a registered manager (lane 145I) ──
  const newTables: Array<{ table: string; lane: Wave145Lane; file: string; tenant: boolean; rls: boolean }> = []
  for (const m of wave145Migrations()) {
    const code = sqlCode(m.sql)
    for (const t of code.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
      const table = t[1]
      newTables.push({ table, lane: m.lane, file: m.file, tenant: /\bbrokerage_id\b/.test(t[2]), rls: new RegExp(`ALTER\\s+TABLE\\s+(?:public\\.)?${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, "i").test(code) })
    }
  }
  // POSITIVE CONTROL: a specimen table with no tenant column and no RLS is caught by the same parse.
  const specimen = "CREATE TABLE public.canary_specimen (\n  id uuid PRIMARY KEY\n);\n"
  const specimenParsed = [...sqlCode(specimen).matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\)\s*;/gi)]
  const parseControl = specimenParsed.length === 1 && !/\bbrokerage_id\b/.test(specimenParsed[0][2])
  const byLane = new Map<Wave145Lane, typeof newTables>()
  for (const t of newTables) byLane.set(t.lane, [...(byLane.get(t.lane) ?? []), t])
  if (byLane.size === 0) {
    c.rule("145I", "EVERY NEW WAVE-145 TABLE IS TENANT-SCOPED AND RLS-ENABLED IN ITS OWN MIGRATION (CLAUDE.md §4): no wave-145 migration (m854–m870) creates a table yet — the rule holds and the parse is proven live by its positive control", parseControl, `wave-145 migrations: ${wave145Migrations().map((m) => m.file).join(", ") || "none"}; parse control ${parseControl}`)
  }
  for (const [lane, ts] of byLane) {
    const bad = ts.filter((t) => !t.tenant || !t.rls)
    c.rule(lane as Ruling145Owner, `EVERY NEW TABLE LANE ${lane} CREATES IS TENANT-SCOPED AND RLS-ENABLED IN THE SAME MIGRATION (CLAUDE.md §4 — tenant from the SESSION; fail closed)`, parseControl && bad.length === 0, ts.map((t) => `${t.table} (${t.file.split("/").pop()}): brokerage_id ${t.tenant}, RLS ${t.rls}`).join(" · "))
  }
  const registry = strippedRepo("lib/kernel/manager-registry.ts") ?? ""
  const tmBlock = /export\s+const\s+TABLE_MANAGER[\s\S]*?\n\}/.exec(registry)?.[0] ?? ""
  const unowned = newTables.filter((t) => !new RegExp(`\\b${t.table}\\s*:`).test(tmBlock))
  c.rule("145I", "EVERY NEW WAVE-145 TABLE HAS A REGISTERED OWNING MANAGER (TABLE_MANAGER — lane 145I owns the registry; the lanes list the entries they need)", tmBlock.length > 0 && unowned.length === 0, `${newTables.length} new table(s); without a TABLE_MANAGER entry: ${unowned.map((t) => `${t.table} (${t.lane})`).join(", ") || "none"}`)

  c.blind("Static + in-memory only: the storage policies are read from the migration TEXT (comment lines dropped), never from the live pg_policies — the live state is the pending-owner step, verified only by the owner's query. The service-door census keys on the bucket constants and a service-client receiver within 60 characters of `.storage.from(`; a door that reaches the bucket through a helper taking the bucket as a parameter (lib/storage/signed-doc-url.ts) is not attributed to the forms bucket. The FK-child set is the generated cache's (scripts/schema-fk-map.ts), so an FK added by an unapplied migration is not seen until the cache is regenerated.")
  return c.report([], 0)
}
