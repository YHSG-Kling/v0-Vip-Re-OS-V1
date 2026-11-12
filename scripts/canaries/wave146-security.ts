/**
 * scripts/canaries/wave146-security.ts — SECURITY canary (wave 146, lane 146J; ruling 20 priority 1 "the Supabase access-control
 * exposure"; lane 146A; CLAUDE.md §4):
 *   · the five private document buckets (brokerage-forms + the four siblings client-documents / offer-documents /
 *     transaction-documents / agent-documents) are PER-PARTY OWNERSHIP in their policy SQL, never "any signed-in user", and the SQL
 *     that installs the owner policies DROPS every live bucket-only policy (permissive policies OR together — one left behind keeps
 *     the bucket open);
 *   · offers' SELECT side admits no NULL-tenant arm and no "same brokerage = sees every offer" for a portal contact or vendor seat;
 *   · the readiness check is HONEST: it reads the LIVE policy state when the process can, and it never reports "applied" from a
 *     specimen of the open live shape or from a read nobody could complete (fail closed);
 *   · applying the storage.objects SQL is an OWNER action (owner SQL editor) — a pending-owner step, never a pass;
 *   · transfers: every FK child carries a class AND its domain evidence; an opt-out is safety-critical (preserve);
 *   · every new wave-146 table is tenant-scoped + RLS-enabled in its own migration and owned by a registered manager.
 *
 * Through the survivors at bf67aa63: m855 (brokerage-forms owner policies, owner-held), docs/operations/OWNER-SQL.md §F,
 * lib/kernel/brokerage-transfer.ts FK_CHILD_TRANSFER_CLASSIFICATION, lib/kernel/manager-registry.ts TABLE_MANAGER, scripts/migration-status.ts
 * claimOf (the ONE header recogniser). Lane 146A's published names bind at the `WAVE146 BIND` lines.
 *
 * MEASURED 2026-10-29T17:05Z (Supabase MCP, read-only — fixtures/wave146-storage-policies-measured.json): all five buckets carry
 * ONLY the bucket-only "auth read / upload / update / delete <bucket>" policies (19 rows); 0 objects in them; offers_tenant_select is
 * `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()` (0 offers rows live). No migration in the tree defines it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, listFiles, readRepo, strippedRepo } from "./_registry"
import { bucketPolicies } from "./wave145-security"
import { memSupabase } from "../in-memory-supabase"
import { quiet, sqlCode } from "./wave145-harness"
import { canary146, migrationHeaderOk146, wave146Migrations, errText, jsonOf, type Ruling146Owner, type Wave146Lane } from "./wave146-harness"

// ── WAVE146 BIND (lane 146A notes, "## Canary requirements", published 18:36Z) ──────────────────────────────────────────────────
// migrations found by NAME: m*-document-bucket-path-rules-and-offer-party-reads.sql (public schema: the path rule
// document_bucket_path_access, offer_staff_visible / offer_contact_party_visible, ALTER POLICY offers_tenant_select, the readiness read
// storage_bucket_policy_readiness()) and m*-document-bucket-storage-policies-owner.sql (owner-held storage.objects policies, §G);
// lib/kernel/brokerage-transfer.ts runBrokerageTransferMigration (opt-outs travel as COPIES). Asserted as the RULING — e.g. lane
// 146A's "exactly these CREATE POLICY names" is its internal shape; the canary asserts "every remaining policy decides WHO and every
// measured open policy is dropped", and that the readiness read's expected names AGREE with the owner file (derived, never pinned).
const migs146ByName = (re: RegExp) => wave146Migrations().find((m) => re.test(m.file)) ?? null

export const PRIVATE_BUCKETS = ["brokerage-forms", "client-documents", "offer-documents", "transaction-documents", "agent-documents"] as const
const CMDS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const

interface MeasuredRow { policyname: string; cmd: string; qual: string; with_check: string; roles?: string }
interface Measured { measuredAt: string; storageObjects: MeasuredRow[]; offers: MeasuredRow[] }
export const MEASURED: Measured = JSON.parse(readFileSync(join(ROOT, "scripts/canaries/fixtures/wave146-storage-policies-measured.json"), "utf8"))

/**
 * PURE — a policy predicate is OWNERSHIP-scoped when, after removing the bucket test itself, something still decides WHO: a
 * function call (a path / seat / party predicate), auth.uid(), or a membership read. A predicate that is the bucket test alone
 * (optionally with TO authenticated) admits every signed-in user — the shape ruling 20 names as the exposure.
 */
export function predicateScoped(body: string, bucket: string): boolean {
  // Only the predicate expressions decide anything: the balanced text after USING / WITH CHECK (never the FOR / TO clauses).
  const exprs: string[] = []
  for (const m of body.matchAll(/\b(USING|WITH\s+CHECK)\s*\(/gi)) {
    let depth = 1, i = (m.index ?? 0) + m[0].length
    const start = i
    for (; i < body.length && depth > 0; i++) { if (body[i] === "(") depth++; else if (body[i] === ")") depth-- }
    exprs.push(body.slice(start, i - 1))
  }
  const rest = exprs.join(" ")
    .replace(new RegExp(`bucket_id\\s*=\\s*'${bucket}'(::text)?`, "g"), " ")
    // SQL keywords that may be followed by "(" without being a call
    .replace(/\b(AND|OR|NOT|IN)\b/gi, " ")
  return exprs.length > 0 && /[A-Za-z_][\w.]*\s*\(/.test(rest)
}

/** Every policy-writing SQL source, oldest first: migrations by number, then OWNER-SQL.md's ```sql blocks (the owner's newest text). */
// MEASUREMENT FIX (lane 146J, at bind with lane 146A's patch): OWNER-SQL.md's ```sql blocks carry the ROLLBACK as well as the forward
// SQL, so reading it as "the newest source" made the rollback's re-created bucket-only policies the final state. The forward state is
// the migrations (the owner-held ones — m855, m875 — ARE the forward text OWNER-SQL.md executes); the doc is read for the verification
// query only.
function policySources(): Array<{ src: string; sql: string }> {
  const migs = listFiles("supabase/migrations", (f) => /\/m\d{3}-[^/]+\.sql$/.test(f)).sort()
  return migs.map((f) => ({ src: f, sql: sqlCode(readRepo(f) ?? "") }))
}

/** PURE — the final policy text per (bucket, cmd) across ordered sources (last CREATE wins), plus which live open names were dropped. */
export function finalBucketState(sources: Array<{ src: string; sql: string }>, bucket: string, openNames: readonly string[]): { byCmd: Record<string, { name: string; body: string; src: string } | null>; dropped: Set<string>; policies: Array<{ name: string; cmd: string; body: string; src: string }> } {
  // Every policy by NAME (a bucket may carry several per command); the evidence view is the last one per command.
  const live = new Map<string, { name: string; cmd: string; body: string; src: string }>()
  const dropped = new Set<string>()
  for (const s of sources) {
    // The idiom is DROP … IF EXISTS then CREATE in the same file: drops first, then the creates of that source.
    const dropsHere = new Set([...s.sql.matchAll(/DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"([^"]+)"\s+ON\s+storage\.objects/gi)].map((m) => m[1]))
    for (const n of dropsHere) live.delete(n)
    for (const n of openNames) if (dropsHere.has(n)) dropped.add(n)
    for (const p of bucketPolicies(s.sql, bucket)) live.set(p.name, { ...p, src: s.src })
  }
  const byCmd: Record<string, { name: string; body: string; src: string } | null> = { SELECT: null, INSERT: null, UPDATE: null, DELETE: null }
  for (const p of live.values()) for (const k of p.cmd === "ALL" ? CMDS : [p.cmd as (typeof CMDS)[number]]) byCmd[k] = p
  return { byCmd, dropped, policies: [...live.values()] }
}

/** PURE — an offers SELECT-side predicate is party-scoped: no NULL-tenant arm, and tenant equality never stands alone. */
export function offersSelectScoped(qual: string): boolean {
  const q = qual.replace(/\s+/g, " ")
  if (/brokerage_id\s+IS\s+NULL/i.test(q)) return false
  const calls = [...q.matchAll(/([A-Za-z_][\w.]*)\s*\(/g)].map((m) => m[1].toLowerCase()).filter((n) => !["current_user_brokerage_id", "coalesce", "select"].includes(n))
  return calls.length > 0 || /auth\.uid\(\)|user_type/i.test(q)
}

export async function run() {
  const c = canary146("Security: the five private buckets are per-party ownership (open policies dropped) · offers SELECT party-scoped · readiness check honest about the LIVE state · owner applies storage.objects · transfers classified with evidence · new tables tenant-scoped, RLS, owned")
  const sources = policySources()

  // ── 1 · THE PRIVATE BUCKETS ARE PER-PARTY OWNERSHIP, AND THE OPEN POLICIES GO (ruling 20 priority 1; lane 146A item 2) ──
  // POSITIVE CONTROL: the measured live shape (bucket-only) is caught; a path-predicate shape is not; a DROP is recognised.
  const openBody = MEASURED.storageObjects.find((r) => r.policyname === "auth read client-documents")?.qual ?? ""
  const control = !predicateScoped(`FOR SELECT TO authenticated USING ${openBody}`, "client-documents")
    && predicateScoped(`FOR SELECT TO authenticated USING (bucket_id = 'client-documents' AND public.client_documents_path_readable(name))`, "client-documents")
    && finalBucketState([{ src: "specimen", sql: `DROP POLICY IF EXISTS "auth read client-documents" ON storage.objects;` }], "client-documents", ["auth read client-documents"]).dropped.size === 1
  for (const bucket of PRIVATE_BUCKETS) {
    const openNames = MEASURED.storageObjects.filter((r) => (r.qual + r.with_check).includes(`'${bucket}'`)).map((r) => r.policyname)
    const st = finalBucketState(sources, bucket, openNames)
    // RE-ASSERTED at bind (lane 146A, 18:36Z): storage.objects is DEFAULT-DENY under RLS, so a command with NO policy is refused to
    // every browser session — a bucket the service client alone serves (offer-documents) correctly carries none. The RULE is: every
    // policy that remains decides WHO, and every measured bucket-only policy is DROPPED — never "all four commands present".
    const open = st.policies.filter((p) => !predicateScoped(p.body, bucket)).map((p) => `${p.cmd} "${p.name}"`)
    const notDropped = openNames.filter((n) => !st.dropped.has(n))
    const remaining = CMDS.filter((k) => st.byCmd[k])
    const owner: Ruling146Owner = "146A"
    c.rule(owner, `THE '${bucket}' BUCKET IS PER-PARTY OWNERSHIP, NEVER 'ANY SIGNED-IN USER' (ruling 20 priority 1 — the Supabase access-control exposure; lane 146A item ${bucket === "brokerage-forms" ? "1 (m855, preserve)" : "2"}): in the policy SQL of the tree (migrations, then OWNER-SQL.md) every live bucket-only policy measured on it is DROPPED and every policy that remains decides WHO (a path / seat / party predicate — never the bucket id alone); a command left with no policy is refused by default (permissive policies OR together, absence denies; positive control: the measured open shape is caught, a path-predicate shape is not, a DROP is recognised)`,
      control && open.length === 0 && notDropped.length === 0,
      `${remaining.length ? remaining.map((k) => `${k} "${st.byCmd[k]!.name}" (${st.byCmd[k]!.src.split("/").pop()})`).join(" · ") : "no browser policy (service-only)"}${open.length ? `; BUCKET-ONLY: ${open.join(",")}` : ""}; live open policies not dropped: ${notDropped.join(", ") || "none"}; control ${control}`)
  }

  // ── 2 · OFFERS: no NULL-tenant arm; a portal contact / vendor is admitted as a PARTY, never by tenant equality alone ──
  // The final SELECT-side state = the measured live policies, then every migration's CREATE / ALTER / DROP POLICY … ON offers, in order.
  const offerPol = new Map<string, { cmd: string; qual: string; src: string }>(MEASURED.offers.filter((r) => /SELECT|ALL/.test(r.cmd)).map((r) => [r.policyname, { cmd: r.cmd, qual: r.qual, src: `live ${MEASURED.measuredAt}` }]))
  for (const s of sources.filter((x) => x.src.endsWith(".sql"))) {
    for (const m of s.sql.matchAll(/DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"?([\w-]+)"?\s+ON\s+(?:public\.)?offers\b/gi)) offerPol.delete(m[1])
    for (const m of s.sql.matchAll(/CREATE\s+POLICY\s+"?([\w-]+)"?\s+ON\s+(?:public\.)?offers\s+(?:AS\s+\w+\s+)?FOR\s+(SELECT|ALL)\b([\s\S]*?);/gi)) offerPol.set(m[1], { cmd: m[2].toUpperCase(), qual: /USING\s*\(([\s\S]*)\)/i.exec(m[3])?.[1] ?? m[3], src: s.src })
    for (const m of s.sql.matchAll(/ALTER\s+POLICY\s+"?([\w-]+)"?\s+ON\s+(?:public\.)?offers\b([\s\S]*?);/gi)) { const u = /USING\s*\(([\s\S]*)\)/i.exec(m[2])?.[1]; if (u && offerPol.has(m[1])) offerPol.set(m[1], { ...offerPol.get(m[1])!, qual: u, src: s.src }) }
  }
  const offersCtl = !offersSelectScoped(MEASURED.offers[0].qual) && offersSelectScoped("brokerage_id = current_user_brokerage_id() AND public.offer_party_readable(id)") && !offersSelectScoped("brokerage_id = current_user_brokerage_id()")
  // RE-ASSERTED at bind: EVERY SELECT-side policy that remains is judged (a policy rewritten to party predicates no longer names the
  // tenant function, so selecting "the tenant policies" by that name would have left the rewritten one unjudged).
  const tenantSelect = [...offerPol.entries()]
  const offersBad = tenantSelect.filter(([, p]) => !offersSelectScoped(p.qual))
  c.rule("146A", "OFFERS ARE READ BY THEIR PARTIES, NOT BY 'ANYONE IN THE TENANT' (ruling 20 priority 1; lane 146A item 2 'the offers_tenant_select policy'): after every migration in the tree, no SELECT-side policy on public.offers keeps a `brokerage_id IS NULL` arm, and none admits on tenant equality alone — a portal contact or vendor seat that carries the brokerage id reaches an offer only as a party to it (positive control: the measured live qual is caught; a party-predicate qual passes; bare tenant equality is caught)",
    offersCtl && tenantSelect.length > 0 && offersBad.length === 0,
    `${tenantSelect.map(([n, p]) => `${n} [${p.src.split("/").pop()}]: ${offersSelectScoped(p.qual) ? "party-scoped" : `OPEN (${p.qual.replace(/\s+/g, " ").slice(0, 90)})`}`).join(" · ") || "no tenant SELECT policy"}; control ${offersCtl}`)

  // ── 2b · …and the offer predicates and the document path rule admit PARTIES, not the tenant at large (lane 146A requirements 3–4) ──
  const rules = migs146ByName(/\/m\d+-document-bucket-path-rules-and-offer-party-reads\.sql$/)
  const rulesCode = rules ? sqlCode(rules.sql) : ""
  const fnBodyOf = (fn: string) => { const at = rulesCode.search(new RegExp(`FUNCTION\\s+public\\.${fn}\\s*\\(`, "i")); return at < 0 ? "" : rulesCode.slice(at, rulesCode.indexOf("$$;", rulesCode.indexOf("$$", at) + 2) + 3) }
  const staffBody = fnBodyOf("offer_staff_visible"), partyBody = fnBodyOf("offer_contact_party_visible"), pathBody = fnBodyOf("document_bucket_path_access")
  const staffNoAgentWide = !!staffBody && !/current_user_agent_id\s*\(/.test(staffBody)
  const noOfferArm = !!pathBody && !/WHEN\s+'offer-documents'/i.test(pathBody)
  // The transaction-documents bucket's own CASE (up to the next bucket arm) — a 'transactions' arm of ANOTHER bucket is not it.
  const txAt = pathBody.search(/WHEN\s+'transaction-documents'/i)
  const txRest = txAt < 0 ? "" : pathBody.slice(txAt + 10)
  const txBlock = txAt < 0 ? "" : txRest.slice(0, (() => { const n = txRest.search(/WHEN\s+'(client|offer|agent)-documents'/i); return n < 0 ? txRest.length : n })())
  const txArms = [...txBlock.matchAll(/WHEN\s+'(transactions|vendor-jobs)'[\s\S]*?(?=WHEN\s+'(?:transactions|vendor-jobs)'|ELSE\s+false|$)/gi)].map((m) => m[0])
  const heldGuard = txArms.length > 0 && txArms.every((a) => /NOT\s+public\.document_transaction_file_held\s*\(/i.test(a))
  const pathControl = /NOT\s+public\.document_transaction_file_held\s*\(/i.test("WHEN 'transactions' THEN x AND NOT public.document_transaction_file_held(name)") && /current_user_agent_id\s*\(/.test("SELECT current_user_agent_id()")
  c.rule("146A", "THE OFFER AND DOCUMENT RULES ADMIT PARTIES, NOT THE TENANT AT LARGE (ruling 20 priority 1; lane 146A item 2: 'audit the real access requirements per party (tenant staff, team, agent, portal contact who is a party, vendor on the deal)'): the staff visibility of an offer never reads 'any agent of the brokerage' (no current_user_agent_id in offer_staff_visible), a portal contact reaches an offer only through offer_contact_party_visible, the document path rule serves no browser read of offer-documents (service-only), and every transaction-documents arm refuses a held file (NOT document_transaction_file_held) — positive control on both finders",
    !!rules && staffNoAgentWide && !!partyBody && noOfferArm && heldGuard && pathControl, rules ? `${rules.file.split("/").pop()}: offer_staff_visible agent-wide ${!staffNoAgentWide}; offer_contact_party_visible ${partyBody ? "defined" : "∅"}; offer-documents browser arm ${!noOfferArm}; transaction arms ${txArms.length}, all refuse a held file ${heldGuard}; control ${pathControl}` : "no m*-document-bucket-path-rules-and-offer-party-reads.sql yet — awaiting lane 146A")

  // ── 3 · THE READINESS CHECK IS HONEST (lane 146A item 1: 'a readiness check that reads the live state honestly — never "applied"
  //        until the database says so'). It reads the LIVE state when this process holds service credentials; otherwise its honesty is
  //        asserted on specimens: the MEASURED open rows → not applied; an unreadable state → not applied (fail closed); owner rows → applied.
  // WAVE146 BIND (lane 146A notes, 18:36Z): the readiness read is the SQL function public.storage_bucket_policy_readiness() in the
  // m*-document-bucket-path-rules-and-offer-party-reads migration (m874) — it reads pg_catalog.pg_policies + storage.buckets, never a
  // migration stamp; its expected policy names per bucket are the owner file's CREATE POLICY names (m875, and m855 for brokerage-forms).
  const liveCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL)
  let liveVerdict: string | null = null
  const rulesMig = migs146ByName(/\/m\d+-document-bucket-path-rules-and-offer-party-reads\.sql$/)
  const ownerMig = migs146ByName(/\/m\d+-document-bucket-storage-policies-owner\.sql$/)
  await c.check("146A", "THE STORAGE-POLICY READINESS READ NEVER SAYS 'APPLIED' UNTIL THE DATABASE DOES (lane 146A item 1: 'a readiness check that reads the live state honestly (never \"applied\" until the database says so)'; CLAUDE.md §4 fail closed): the readiness function reads the LIVE catalog (pg_catalog.pg_policies and storage.buckets) and names no migration or 'APPLIED' stamp — so a file cannot make it say yes; the policy names it expects per bucket are exactly the owner file's CREATE POLICY names (and m855's for brokerage-forms), so a renamed or missing owner policy reads not-scoped; when this process holds service credentials it also calls it LIVE and prints the verdicts", async () => {
    if (!rulesMig) return { ok: false, evidence: "no m*-document-bucket-path-rules-and-offer-party-reads.sql yet — awaiting lane 146A" }
    const code = sqlCode(rulesMig.sql)
    const at = code.search(/FUNCTION\s+public\.storage_bucket_policy_readiness\s*\(/i)
    if (at < 0) return { ok: false, evidence: `${rulesMig.file.split("/").pop()} defines no public.storage_bucket_policy_readiness()` }
    const body = code.slice(at, code.indexOf("$$;", code.indexOf("$$", at) + 2) + 3)
    const readsCatalog = /pg_catalog\.pg_policies|\bpg_policies\b/i.test(body) && /storage\.buckets/i.test(body)
    const trustsStamp = /\bm\d{3}\b|APPLIED|migration/i.test(body)
    const ownerNames = new Set([...(ownerMig ? sqlCode(ownerMig.sql) : "").matchAll(/CREATE\s+POLICY\s+"([^"]+)"/gi)].map((m) => m[1]))
    const m855 = readRepo("supabase/migrations/m855-brokerage-forms-storage-policies-owner.sql") ?? ""
    for (const m of sqlCode(m855).matchAll(/CREATE\s+POLICY\s+"([^"]+)"/gi)) ownerNames.add(m[1])
    const expected = new Set([...body.matchAll(/'([a-z-]+ owner [a-z]+)'/g)].map((m) => m[1]))
    const missingInRead = [...ownerNames].filter((n) => !expected.has(n)), extraInRead = [...expected].filter((n) => !ownerNames.has(n))
    if (liveCreds) {
      try {
        const { createClient } = await import("@supabase/supabase-js")
        const live = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } })
        const { data, error } = await live.rpc("storage_bucket_policy_readiness")
        liveVerdict = error ? `refused (${error.message})` : jsonOf(data).slice(0, 200)
      } catch (e) { liveVerdict = `unreadable (${errText(e)})` }
    }
    return { ok: readsCatalog && !trustsStamp && ownerNames.size > 0 && missingInRead.length === 0 && extraInRead.length === 0, evidence: `${rulesMig.file.split("/").pop()}: reads pg_policies + storage.buckets ${readsCatalog}; names a migration / APPLIED stamp ${trustsStamp}; owner policy names ${ownerNames.size} (not expected by the read: ${missingInRead.join(", ") || "none"}; expected but never created: ${extraInRead.join(", ") || "none"}); live: ${liveVerdict ?? "this process holds no service credentials — the read is judged on its SQL text (last MCP measurement: every bucket open)"}` }
  })

  // ── 4 · APPLYING THE storage.objects SQL IS THE OWNER'S (the MCP role is refused 42501) — pending-owner, never a pass ──
  const { claimOf } = await import("../migration-status")
  const storageMigs = listFiles("supabase/migrations", (f) => /\/m\d{3}-[^/]+\.sql$/.test(f)).sort()
    .map((f) => ({ f, raw: readRepo(f) ?? "" })).filter((m) => /storage\.objects/i.test(sqlCode(m.raw)) && PRIVATE_BUCKETS.some((b) => sqlCode(m.raw).includes(`'${b}'`)) && /CREATE\s+POLICY/i.test(sqlCode(m.raw)))
    .filter((m) => Number(/\/m(\d{3})-/.exec(m.f)?.[1]) >= 855)
  const stamped = storageMigs.length > 0 && storageMigs.every((m) => claimOf(m.raw) === "applied")
  const allBucketsCovered = PRIVATE_BUCKETS.every((b) => storageMigs.some((m) => sqlCode(m.raw).includes(b)))
  c.pendingOwner("146A", "THE PRIVATE DOCUMENT BUCKETS' storage.objects POLICIES ARE APPLIED AND VERIFIED (ruling 20 priority 1 — release-blocking; lane 146A requirement 5): every owner-held storage-policy migration (m855 for brokerage-forms; lane 146A's m*-document-bucket-storage-policies-owner for the four siblings) reads 'applied' through claimOf and together they cover all five buckets — and, in LIVE mode, the readiness read agrees; the last LIVE measurement is printed beside it (a measurement, never a pass)",
    stamped && allBucketsCovered,
    // RE-ASSERTED wording (wave 146, 146Z): m874's state is READ from its own line 1 (it went live 2026-10-29) instead of
    // being told to the integrator as a step still to do; the pending verdict itself is unchanged.
    `${(() => { const m874 = listFiles("supabase/migrations", (f) => /\/m874-[^/]+\.sql$/.test(f))[0]; const st = m874 ? claimOf(readRepo(m874) ?? "") : "absent"; return st === "applied" ? "m874 (public schema: the path rule, the offer party reads, the readiness read) is APPLIED (its line 1 says so)" : `Integrator applies m874 (public schema: the path rule, the offer party reads, the readiness read) — it reads '${st}'` })()}; the owner runs docs/operations/OWNER-SQL.md §F (m855, brokerage-forms) and §G (m875, the four sibling buckets) as the storage owner with their verification queries (expect NO 'auth read / upload / update / delete <bucket>' row left), then stamps each migration's line 1 '-- ── APPLIED LIVE …' — RELEASE STAYS BLOCKED until then`,
    `${storageMigs.map((m) => `${m.f.split("/").pop()}: ${claimOf(m.raw)}`).join(", ") || "no owner storage-policy migration"}; buckets covered ${PRIVATE_BUCKETS.filter((b) => storageMigs.some((m) => sqlCode(m.raw).includes(b))).join(",")}; last live measurement ${MEASURED.measuredAt}: ${MEASURED.storageObjects.length} bucket-only policies on ${new Set(MEASURED.storageObjects.map((r) => /'([a-z-]+)'/.exec(r.qual + r.with_check)?.[1])).size} buckets${liveVerdict ? `; live now: ${liveVerdict}` : ""}`)

  // ── 5 · TRANSFERS: every FK child carries a class AND its domain evidence; an opt-out is safety-critical (lane 146A item 3; preserve) ──
  const transfer = await quiet(async () => import("../../lib/kernel/brokerage-transfer")) as unknown as Record<string, unknown>
  const table = (transfer.FK_CHILD_TRANSFER_CLASSIFICATION ?? {}) as Record<string, { cls?: string; rule?: string; evidence?: string }>
  const classes = new Set((transfer.CHILD_TRANSFER_CLASSES ?? []) as readonly string[])
  const noEvidence = Object.entries(table).filter(([, v]) => !classes.has(String(v.cls)) || String(v.rule ?? v.evidence ?? "").trim().length < 12).map(([t]) => t)
  const safety = (transfer.TRANSFER_SAFETY_CRITICAL_CHILDREN ?? []) as readonly string[]
  const fin = table.agent_commissions?.cls ?? null
  c.rule("146A", "EVERY CLASSIFIED FK CHILD CARRIES ITS DOMAIN EVIDENCE, AND OPT-OUTS NEVER SILENTLY STAY BEHIND (lane 146A item 3: 'finish the transfer rulings with domain evidence … opt-outs and consent restrictions preserved; no silent ownership change'): every FK_CHILD_TRANSFER_CLASSIFICATION entry names one of the rail's classes and a written rule; the contact suppression list is safety-critical; another party's financial record is never transferable",
    Object.keys(table).length > 0 && noEvidence.length === 0 && safety.includes("contact_suppression_list") && /not_transfer|non_transfer/.test(fin ?? ""),
    `${Object.keys(table).length} classified children; without class+evidence: ${noEvidence.slice(0, 8).join(", ") || "none"}; safety-critical ${safety.join(",") || "none"}; agent_commissions → ${fin ?? "∅"}; classes ${[...classes].join(",")}`)

  // ── 5b · OPT-OUTS TRAVEL AS COPIES (lane 146A requirements 7–9; 'opt-outs and consent restrictions preserved'): driven through the
  //        REAL rail (runBrokerageTransferMigration) in memory on a consented adoption, every external door a recorder ──
  await c.check("146A", "AN OPT-OUT TRAVELS WITH THE PERSON AS A COPY, AND A COPY THAT CANNOT BE WRITTEN STOPS THE MOVE (lane 146A item 3: 'opt-outs and consent restrictions preserved; no silent ownership change'): a consented adoption COPIES the source's SMS suppression row into the target (same channel, phone, contact, reason, source and time; a new id), leaves the source row in place, counts it as a restriction copied and as safety-critical, and invents no consent event in the target; if every suppression insert is refused the rail stalls at its data step and the source is NOT archived (positive control); once the owner authorizes the suppression list to FOLLOW, the original moves and no copy is counted", async () => {
    if (typeof transfer.runBrokerageTransferMigration !== "function") return { ok: false, evidence: "runBrokerageTransferMigration is not exported" }
    const families = ((transfer.TRANSFER_DATA_FAMILIES ?? []) as Array<{ table: string }>).map((f) => f.table)
    const NOW = new Date("2026-10-29T15:00:00Z")
    const T = "cccccccc-0146-4000-8000-000000000001", S = "cccccccc-0146-4000-8000-000000000002", A = "cccccccc-0146-4000-8000-0000000000a1", O = "cccccccc-0146-4000-8000-0000000000b1", REQ = "cccccccc-0146-4000-8000-0000000000ff"
    const SUP = { id: "sup-s", brokerage_id: S, channel: "sms", phone: "+15555550177", contact_id: "contacts-s", suppression_reason: "STOP", source: "inbound_stop", created_at: "2026-09-01T00:00:00Z" }
    const runRail = async (opts: { refuseSuppression?: boolean; authorized?: readonly string[] }) => {
      const seed: Record<string, Array<Record<string, unknown>>> = {
        brokerages: [{ id: T, name: "Harbor Realty", plan_tier: "brokerage", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: null }, { id: S, name: "Dana Solo", plan_tier: "solo_agent", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: null }],
        users: [{ id: A, email: "max@harbor.example.test", brokerage_id: T, user_type: "broker_owner", platform_role: null, first_name: "Max", last_name: "Ng", team_id: null }, { id: O, email: "dana@solo.example.test", brokerage_id: S, user_type: "admin", platform_role: null, first_name: "Dana", last_name: "Lee", team_id: null }],
        agents: [{ id: "ag-o", user_id: O, brokerage_id: S, team_id: null }], teams: [], user_role_assignments: [],
        brokerage_transfer_requests: [{ id: REQ, brokerage_id: T, source_brokerage_id: S, target_brokerage_id: T, subject_user_id: O, initiated_by_user_id: A, target_role: "agent", status: "consented", reason: null,
          consent: { user_id: O, at: NOW.toISOString(), decision: "consent", statement: "I consent to joining Harbor Realty", channel: "settings_ui", request_snapshot: { source_brokerage_id: S, target_brokerage_id: T, target_role: "agent", source_name: "Dana Solo", target_name: "Harbor Realty" } },
          verification: null, migration: null, billing_handoff: null, readiness: null, effective_at: null, completed_at: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString() }],
        agent_action_ledger: [], notifications: [], lifecycle_events: [], brokerage_form_library: [], contact_consent_events: [],
        contact_suppression_list: [{ ...SUP }],
      }
      for (const fam of families) seed[fam] = [...(seed[fam] ?? []), { id: `${fam}-s`, brokerage_id: S }]
      const base = memSupabase(seed as never, { uuidIds: true })
      // POSITIVE CONTROL: refuse only WRITES to the suppression list (reads still answer — the rail must see the row to copy it).
      const refuser = memSupabase({}, { refuse: { contact_suppression_list: "insert refused (canary positive control)" } })
      const svc = opts.refuseSuppression
        ? (Object.assign(Object.create(base) as object, {
          tables: base.tables,
          from: (t: string) => {
            const q = base.from(t) as unknown as Record<string | symbol, unknown>
            if (t !== "contact_suppression_list") return q
            return new Proxy(q, { get: (target, prop) => (prop === "insert" || prop === "upsert") ? (...a: unknown[]) => (refuser.from(t) as unknown as { insert: (...x: unknown[]) => unknown }).insert(...a) : target[prop] })
          },
        }) as unknown as typeof base)
        : base
      const deps = {
        now: () => NOW,
        assignUserToBrokerage: async (p: { userId: string; brokerageId: string }) => { await svc.from("users").update({ brokerage_id: p.brokerageId }).eq("id", p.userId); await svc.from("agents").update({ brokerage_id: p.brokerageId }).eq("user_id", p.userId); return { success: true } },
        assignRole: async (p: { userId: string; newRole: string }) => { await svc.from("users").update({ user_type: p.newRole }).eq("id", p.userId); return { success: true } },
        domainRecords: async () => ({ success: true, agentId: "ag", coordinatorId: null, domainRecordsCreated: [] }),
        seatGate: async () => ({ allowed: true, reason: "within_limit", message: null }), tierAllowsRole: () => true, mayUseAndAfford: async () => ({ allowed: true, reason: "ok" }),
        billingHandoff: async () => ({ ok: true, mode: "fixture", effectiveAt: NOW.toISOString() }), readiness: async () => ({ ready: true, blockers: [], checkedAt: NOW.toISOString() }),
        reportOutcome: async () => ({}), emit: async () => ({}), notifyAdmins: async () => 1, notifyStaff: async () => 1,
        ...(opts.authorized ? { authorizedFollowingChildren: opts.authorized } : {}),
      }
      const r = (await quiet(async () => (transfer.runBrokerageTransferMigration as (...a: unknown[]) => Promise<unknown>)(svc, { requestId: REQ, actor: { userId: A, brokerageId: T, kind: "target_admin" } }, deps))) as { ok: boolean; stalledAt?: string | null; error?: string }
      const tables = (svc as unknown as { tables: Record<string, Array<Record<string, unknown>>> }).tables
      const req = (tables.brokerage_transfer_requests ?? []).find((x) => x.id === REQ) as Record<string, any> | undefined
      return { r, tables, closure: (req?.migration?.closure ?? {}) as Record<string, Record<string, number>> }
    }
    const copy = await runRail({})
    const sups = copy.tables.contact_suppression_list ?? []
    const src = sups.find((x) => x.id === "sup-s"), tgt = sups.find((x) => x.brokerage_id === T)
    const same = !!tgt && (["channel", "phone", "contact_id", "suppression_reason", "source", "created_at"] as const).every((k) => tgt[k] === SUP[k]) && tgt.id !== SUP.id
    const counted = copy.closure.restrictions_copied?.contact_suppression_list === 1 && copy.closure.safety_critical?.contact_suppression_list === 1
    const noConsent = !(copy.tables.contact_consent_events ?? []).some((x) => x.brokerage_id === T)
    const refused = await runRail({ refuseSuppression: true })
    const srcArchived = !!(refused.tables.brokerages ?? []).find((x) => x.id === S)?.archived_at
    const follow = await runRail({ authorized: ["contact_suppression_list"] })
    const moved = (follow.tables.contact_suppression_list ?? []).find((x) => x.id === "sup-s")?.brokerage_id === T
    const noCopyCounted = !follow.closure.restrictions_copied || !("contact_suppression_list" in follow.closure.restrictions_copied)
    const ok = copy.r.ok && same && src?.brokerage_id === S && counted && noConsent && !refused.r.ok && refused.r.stalledAt === "data" && !srcArchived && moved && noCopyCounted
    return { ok, evidence: `adoption → ${copy.r.ok ? "completed" : copy.r.error}; target copy ${tgt ? (same ? "identical (new id)" : "DIFFERS") : "MISSING"}; source row kept ${src?.brokerage_id === S}; closure ${jsonOf({ copied: copy.closure.restrictions_copied, safety: copy.closure.safety_critical }).slice(0, 120)}; consent invented ${!noConsent}; refused copy → ${refused.r.ok ? "COMPLETED" : `stalled at ${refused.r.stalledAt}`}, source archived ${srcArchived}; authorized to follow → original moved ${moved}, copy counted ${!noCopyCounted}` }
  })

  // ── 6 · NEW WAVE-146 TABLES: tenant-scoped + RLS in the same migration (per lane), and a registered owning manager ──
  const newTables: Array<{ table: string; lane: Wave146Lane; file: string; tenant: boolean; rls: boolean; header: boolean }> = []
  const migs146 = wave146Migrations()
  for (const m of migs146) {
    const code = sqlCode(m.sql)
    for (const t of code.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
      newTables.push({ table: t[1], lane: m.lane, file: m.file, tenant: /\bbrokerage_id\b/.test(t[2]) || /platform/.test(t[1]), rls: new RegExp(`ALTER\\s+TABLE\\s+(?:public\\.)?${t[1]}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, "i").test(code), header: migrationHeaderOk146(m.sql, m.lane) })
    }
  }
  const specimen = [...sqlCode("CREATE TABLE public.canary_specimen (\n  id uuid PRIMARY KEY\n);\n").matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\)\s*;/gi)]
  const parseControl = specimen.length === 1 && !/\bbrokerage_id\b/.test(specimen[0][2])
  const headersBad = migs146.filter((m) => !migrationHeaderOk146(m.sql, m.lane)).map((m) => m.file.split("/").pop())
  c.rule("146I", "EVERY WAVE-146 MIGRATION CARRIES ITS LANE STAMP (or APPLIED LIVE) ON LINE 1, AND EVERY NEW TABLE IS TENANT-SCOPED AND RLS-ENABLED IN THE SAME MIGRATION (preamble; CLAUDE.md §4 — tenant from the SESSION; fail closed; a platform_* table is the platform's own) — positive control: a specimen with no tenant column is caught",
    parseControl && headersBad.length === 0 && newTables.every((t) => t.tenant && t.rls),
    `${migs146.length} wave-146 migration(s) (${migs146.map((m) => `m${m.num}`).join(",") || "none yet"}); stamp wrong: ${headersBad.join(", ") || "none"}; new tables: ${newTables.map((t) => `${t.table} (${t.lane}) tenant ${t.tenant} RLS ${t.rls}`).join(" · ") || "none"}; parse control ${parseControl}`)
  const registry = strippedRepo("lib/kernel/manager-registry.ts") ?? ""
  const tmBlock = /export\s+const\s+TABLE_MANAGER[\s\S]*?\n\}/.exec(registry)?.[0] ?? ""
  const unowned = newTables.filter((t) => !new RegExp(`\\b${t.table}\\s*:`).test(tmBlock))
  c.rule("146I", "EVERY NEW WAVE-146 TABLE HAS A REGISTERED OWNING MANAGER (TABLE_MANAGER — lane 146I owns the registry; the lanes list the entries they need)", tmBlock.length > 0 && unowned.length === 0, `${newTables.length} new table(s); without a TABLE_MANAGER entry: ${unowned.map((t) => `${t.table} (${t.lane})`).join(", ") || "none"}`)

  c.blind("Static + in-memory: the bucket and offers policies are read from SQL TEXT (migrations, then OWNER-SQL.md's sql blocks, comment lines dropped), never from the live pg_policies inside this process (no pg driver, no service credentials here) — the live state is the 2026-10-29 MCP measurement (fixture, printed as a measurement) and the pending-owner step. Permissive-policy OR semantics are modelled only as 'every measured open policy is DROPPED'; a bucket-only policy created under a NEW name in the live database after the measurement is not seen. The predicate test is lexical (something besides the bucket test decides WHO) — whether that predicate admits exactly the right parties is lane 146A's own proof (test:public-bucket-egress / test:transfer-classification).")
  return c.report([], 0)
}
