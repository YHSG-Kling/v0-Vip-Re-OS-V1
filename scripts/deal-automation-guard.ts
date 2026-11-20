#!/usr/bin/env tsx
/**
 * scripts/deal-automation-guard.ts   (npm run test:deal-automation)            WAVE 153, LANE 153Q — SIMULATED (in-memory client)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * Owner (B13, verbatim): "lenders and title are classified under vendors. check to be sure that moving concierge and all automation
 * etc is working under transactions/deals."
 *
 * The deal-automation census (lane notes) runs every EXISTING transaction proof; this guard DRIVES the hops lane 153Q found broken
 * and fixed, each with its positive path and ONE adverse case that the pre-fix code fails:
 *
 *   A  CALENDAR DEADLINE WATCHER (lib/kernel/calendar-deadline-watcher.ts — inspection / appraisal / financing / walkthrough /
 *      closing / CD reminders). emitKernelEvent RESOLVES a refusal as { error } and never throws, so the watcher's try/catch never
 *      fired and a REFUSED emit still marked the deadline notified — the reminder was lost for good. Its only proof
 *      (test:deadline-watcher) needs live credentials and printed "verified" on 0 checks.
 *   B  MOVING CONCIERGE (lib/transactions/buyer-move.ts ensureBuyerMoveCase, stood up at CLOSING_PREP by stage-progression). The
 *      seller-side skip compared deal_type to "listing", a value the CHECK refuses (buyer | dual | seller), so a seller-only deal's
 *      OUTSIDE buyer got our move-in concierge. A refused read also read as "no case".
 *   C  LENDER / TITLE ARE VENDOR CATEGORIES (CLAUDE.md §4). No deal-automation branch on a user_type / role spelling 'lender' /
 *      'title_agent'; the AI-note lender write requires the lender VENDOR assigned to the deal; canViewFinancials refuses 'vendor'.
 *   D  CONTACT-ONLY WELCOME VIDEO (146C-SO-04). A render of a project addressed to one contact is never captured into the shared
 *      marketing_assets library, and the still door hosts it through renderHostBucketFor like the moving door and the card.
 *   E  REFUSAL COPY THROUGH THE PRESENTER (153D-8). The issuer-correction and closing-review refusals are presentTenantMessage
 *      sentences, and no raw database / ledger text is spliced into a sentence a person reads (it rides `detail`, logged).
 *
 * BLIND SPOTS (published beside the number): SIMULATED — no live database, no live fan-out (processKernelEvent's own service client
 * is absent here, so fan-out reports fanOutOk:false; the audit row and the mark are what is asserted). Route handlers (ai-note,
 * badge-counts, render-composition) are checked on STRIPPED source, not executed. RLS is not modelled.
 */
import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { blankStrings, stripComments } from "./strip-comments"

const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) } }
const section = (t: string) => console.log(`\n[${t}]`)
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
const code = (p: string) => blankStrings(stripComments(read(p)))
const codeWithStrings = (p: string) => stripComments(read(p))

// ── An in-memory supabase (the closing-compliance guard's shape, plus gte / lte / ilike) ──
type Row = Record<string, any>
function makeDb(tables: Record<string, Row[]>, refuse: Record<string, string> = {}) {
  const client: any = {
    tables,
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      const st: { op: "select" | "insert" | "update" | "delete"; patch?: Row; rows?: Row[]; limit?: number; head?: boolean; returning?: boolean } = { op: "select" }
      const exec = (single: boolean) => {
        const refusal = refuse[`${table}:${st.op}`] ?? refuse[table]
        if (refusal) return { data: null, error: { message: refusal }, count: null }
        const all = (tables[table] ??= [])
        const hit = () => all.filter((r) => filters.every((f) => f(r)))
        if (st.op === "select") {
          let rows = hit()
          if (st.limit !== undefined) rows = rows.slice(0, st.limit)
          if (st.head) return { data: null, error: null, count: rows.length }
          return { data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length }
        }
        if (st.op === "insert") {
          const made = (st.rows ?? []).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...r }))
          all.push(...made)
          return { data: st.returning ? (single ? { ...made[0] } : made.map((m) => ({ ...m }))) : null, error: null, count: null }
        }
        if (st.op === "update") { const rows = hit(); for (const r of rows) Object.assign(r, st.patch); return { data: st.returning ? (single ? rows[0] ?? null : rows) : null, error: null, count: null } }
        const rows = hit(); tables[table] = all.filter((r) => !rows.includes(r))
        return { data: st.returning ? rows : null, error: null, count: null }
      }
      const b: any = {
        select(_c?: string, o?: { count?: string; head?: boolean }) { if (st.op !== "select") st.returning = true; if (o?.head) st.head = true; return b },
        insert(rows: Row | Row[]) { st.op = "insert"; st.rows = Array.isArray(rows) ? rows : [rows]; return b },
        update(patch: Row) { st.op = "update"; st.patch = patch; return b },
        delete() { st.op = "delete"; return b },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return b },
        is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b },
        not(c: string, _op: string, v: unknown) { filters.push((r) => (r[c] ?? null) !== v); return b },
        in(c: string, a: unknown[]) { filters.push((r) => a.includes(r[c])); return b },
        gte(c: string, v: string) { filters.push((r) => String(r[c] ?? "") >= v); return b },
        lte(c: string, v: string) { filters.push((r) => String(r[c] ?? "") <= v); return b },
        ilike(c: string, pat: string) { const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i"); filters.push((r) => re.test(String(r[c] ?? ""))); return b },
        order() { return b },
        limit(n: number) { st.limit = n; return b },
        maybeSingle: async () => exec(true),
        single: async () => exec(true),
        then: (res: any, rej: any) => Promise.resolve(exec(false)).then(res, rej),
      }
      return b
    },
  }
  return client
}

const B1 = randomUUID(), B2 = randomUUID()
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Deal automation — the hops lane 153Q fixed (SIMULATED, in-memory)")
  console.log("══════════════════════════════════════════════════")

  // ═══ A. CALENDAR DEADLINE WATCHER ══════════════════════════════════════════════════════════════════════════════════════════
  section("A calendar deadline watcher — a refused emit is retried, never marked")
  const { checkUpcomingDeadlines } = await import("../lib/kernel/calendar-deadline-watcher")
  const seedCal = () => {
    const T = randomUUID()
    const ev = (event_type: string, h: number) => ({ id: randomUUID(), brokerage_id: B1, entity_type: "transaction", entity_id: T, event_type, start_at: hoursFromNow(h), deadline_notified: false })
    return { T, rows: [ev("inspection", 2), ev("closing_disclosure", 3), ev("appraisal", -6), ev("financing_deadline", 24 * 20)] }
  }
  {
    const { rows } = seedCal()
    const db = makeDb({ calendar_events: rows, brokerage_settings: [], lifecycle_events: [] })
    await checkUpcomingDeadlines(db)
    const flag = (t: string) => rows.find((r) => r.event_type === t)!.deadline_notified
    check("positive: an inspection due in 2h is notified AND marked", flag("inspection") === true)
    check("positive: a Closing Disclosure due in 3h is notified AND marked (CD_DUE)", flag("closing_disclosure") === true)
    check("time floor: an appraisal that already passed is NOT notified", flag("appraisal") === false)
    check("horizon: a financing deadline 20 days out is NOT notified yet", flag("financing_deadline") === false)
    const life = db.tables.lifecycle_events as Row[]
    check("the audit row lands on the SAME (injected) client, one per notified deadline", life.length === 2 && life.every((l) => /^deadline:/.test(String(l.dedupe_key))), `rows=${life.length}`)
    const insp = rows.find((r) => r.event_type === "inspection")!
    check("each row is keyed per calendar event (a retry after a failed MARK cannot fire twice)", life.some((l) => l.dedupe_key === `deadline:${insp.id}`))
    // Re-arm the mark (a mark that failed after the emit landed) — the second run must NOT write a second audit row.
    insp.deadline_notified = false
    await checkUpcomingDeadlines(db)
    check("re-run after a lost mark: dedupe returns the existing event (still 2 audit rows) and re-marks", (db.tables.lifecycle_events as Row[]).length === 2 && (insp.deadline_notified as boolean) === true)
  }
  {
    const { rows } = seedCal()
    const db = makeDb({ calendar_events: rows, brokerage_settings: [] }, { "lifecycle_events:insert": "permission denied for table lifecycle_events" })
    await checkUpcomingDeadlines(db)
    check("ADVERSE: the emit is REFUSED — the due-soon inspection stays UNNOTIFIED for the next run (pre-fix: marked, reminder lost)", rows.find((r) => r.event_type === "inspection")!.deadline_notified === false)
    check("ADVERSE: nothing at all is marked when every emit is refused", rows.every((r) => r.deadline_notified === false))
  }

  // ═══ B. MOVING CONCIERGE ═══════════════════════════════════════════════════════════════════════════════════════════════════
  section("B moving concierge — buyer-side deals we represent get a case; a seller-only deal's outside buyer never does")
  const { ensureBuyerMoveCase } = await import("../lib/transactions/buyer-move")
  const txn = (deal_type: string, brokerage_id = B1) => ({ id: randomUUID(), brokerage_id, deal_type, buyer_contact_id: randomUUID(), agent_id: randomUUID(), close_date: "2099-01-05", estimated_close_date: null })
  const buyer = txn("buyer"), dual = txn("dual"), seller = txn("seller"), foreign = txn("buyer", B2)
  const db = makeDb({ transactions: [buyer, dual, seller, foreign], buyer_move_cases: [] })
  const now = new Date("2099-01-01T00:00:00Z")
  const rb = await ensureBuyerMoveCase(db, { transactionId: buyer.id, brokerageId: B1, now })
  check("positive: a 'buyer' deal at CLOSING_PREP gets a dated 10-task move-in case", rb.created && (rb.case?.tasks?.length ?? 0) === 10)
  check("positive: closing 4 days out with essentials open ⇒ the handoff is RECOMMENDED (execution stays flag-gated)", rb.case?.recommended_mode === "handoff")
  const rd = await ensureBuyerMoveCase(db, { transactionId: dual.id, brokerageId: B1, now })
  check("positive: a 'dual' deal (our buyer too) gets a case", rd.created)
  const rs = await ensureBuyerMoveCase(db, { transactionId: seller.id, brokerageId: B1, now })
  check("ADVERSE: a 'seller'-only deal with an OUTSIDE buyer contact gets NO case (pre-fix: created — the skip named 'listing')", !rs.created && !(db.tables.buyer_move_cases as Row[]).some((c) => c.transaction_id === seller.id))
  const rf = await ensureBuyerMoveCase(db, { transactionId: foreign.id, brokerageId: B1, now })
  check("tenant: another brokerage's deal is invisible (no case)", !rf.created && rf.case === null)
  const again = await ensureBuyerMoveCase(db, { transactionId: buyer.id, brokerageId: B1, now })
  check("idempotent: a second ensure keeps the one case", !again.created && (db.tables.buyer_move_cases as Row[]).filter((c) => c.transaction_id === buyer.id).length === 1)
  const refusedDb = makeDb({ transactions: [txn("buyer")], buyer_move_cases: [] }, { "buyer_move_cases:select": "timeout" })
  let threw = false
  try { await ensureBuyerMoveCase(refusedDb, { transactionId: (refusedDb.tables.transactions as Row[])[0].id, brokerageId: B1, now }) } catch { threw = true }
  check("ADVERSE: an unreadable move-case read REFUSES (thrown, caught + logged by both callers) — never inserted over", threw && (refusedDb.tables.buyer_move_cases as Row[]).length === 0)
  const stage = codeWithStrings("lib/transactions/stage-progression.ts")
  check("wiring: stage-progression stands the case up on entering CLOSING_PREP (stripped source)", /CLOSING_PREP[\s\S]*?ensureBuyerMoveCase/.test(stage))
  const actions = code("app/actions/buyer-move.ts")
  check("tenancy: the concierge door takes its tenant from the SESSION (requireCallerTenant), never the body", /requireCallerTenant\(params\.brokerageId\)/.test(actions) && /params\.brokerageId\s*=\s*caller\.brokerageId/.test(actions))

  // ═══ C. LENDER / TITLE ARE VENDOR CATEGORIES ════════════════════════════════════════════════════════════════════════════════
  section("C lender and title act only as vendor categories")
  const ROLE_SPELLING = /(?:user_?[Tt]ype|userType|\brole)\s*(?:===|!==|==|!=)\s*["'](?:lender|title_agent)["']|\.eq\(\s*["']user_type["']\s*,\s*["'](?:lender|title_agent)["']|user_type\s*:\s*["'](?:lender|title_agent)["']/
  const finds = (src: string) => src.split("\n").some((l) => ROLE_SPELLING.test(l))
  check("POSITIVE CONTROL — the finder recognises a role-spelling branch", finds(`if (role === "lender" && transactionId) {`) && finds(`.eq("user_type", "title_agent")`))
  check("POSITIVE CONTROL — the finder ignores the spelling inside a comment once stripped", !finds(stripComments(`// role === "lender" was the old branch\nconst x = 1`)))
  // Deal-automation surfaces that touch a lender / title party. role-guard.ts is listed separately: its 'lender' / 'title_agent'
  // compare is the PERMISSION vocabulary (lib/security/types.ts CanonicalRole), deliberately kept, and now also refuses 'vendor'.
  const DEAL_SURFACES = [
    "app/api/internal/ai-note/route.ts", "app/api/dashboard/badge-counts/route.ts", "lib/transactions/buyer-move.ts",
    "lib/transactions/stage-progression.ts", "app/actions/vendor-document-corrections.ts",
    "lib/documents/vendor-document-correction.ts", "app/actions/compliance/closing-review.ts", "lib/kernel/calendar-deadline-watcher.ts",
  ]
  const offenders = DEAL_SURFACES.filter((f) => finds(codeWithStrings(f)))
  check(`no user_type / role spelling 'lender' or 'title_agent' on ${DEAL_SURFACES.length} deal-automation surfaces (${offenders.length} found)`, offenders.length === 0, offenders.join(", "))
  // lib/transactions/deal-vendor-notify.ts compares `role === "lender"` — the DEAL PARTY SLOT (DealVendorRole, derived from the deal's
  // vendor CATEGORIES by vendorTargets), never a seat. Asserted as exactly that, so a seat read slipped in there would fail here.
  const dvn = codeWithStrings("lib/transactions/deal-vendor-notify.ts")
  check("deal-vendor-notify: its 'lender' compare is the deal party slot (DealVendorRole from vendorTargets(categories)), not a seat", /const roles = vendorTargets\(params\.categories\)/.test(dvn) && /for \(const role of roles\)/.test(dvn) && !/user_?type/i.test(dvn))
  const note = code("app/api/internal/ai-note/route.ts")
  check("ai-note: lender-ness comes from the ONE resolver (lenderVendorForUser — the vendor category)", /lenderVendorForUser\(supabase,\s*user\.id\)/.test(note))
  check("ai-note: the deal lender note requires that lender vendor ASSIGNED to the transaction (lenderVendorTransactionIds)", /lenderVendorTransactionIds\(supabase,[\s\S]{0,80}\)\)\.includes\(transactionId/.test(note) && /lenderVendor && transactionId && lenderOnDeal/.test(note))
  const { canViewFinancials } = await import("../lib/transactions/role-guard")
  check("financials: a 'vendor' seat (every live lender / title user) is refused (pre-fix: allowed)", canViewFinancials({ userId: "u", role: "vendor", brokerageId: B1 }).allowed === false)
  check("financials: the canonical 'lender' / 'title_agent' permission roles stay refused; an agent is allowed", !canViewFinancials({ userId: "u", role: "lender", brokerageId: B1 }).allowed && !canViewFinancials({ userId: "u", role: "title_agent", brokerageId: B1 }).allowed && canViewFinancials({ userId: "u", role: "agent", brokerageId: B1 }).allowed)
  const badge = code("app/api/dashboard/badge-counts/route.ts")
  // Lane 155T3: TITLE IS A VENDOR CATEGORY (CLAUDE.md §4) — the badge counts the SESSION's title vendor's assigned files
  // (resolveTitleVendorActor → vendor_assignments by that vendor, in the session tenant), never the writer-less
  // title_company_users table (0 rows: every title badge read 0).
  const badgeS = codeWithStrings("app/api/dashboard/badge-counts/route.ts")
  const TITLE_BADGE = /userType === "vendor"\s*\?\s*\(async \(\) => \{[\s\S]{0,200}resolveTitleVendorActor\(supabase, null\)[\s\S]{0,400}\.from\("vendor_assignments"\)[\s\S]{0,160}\.eq\("vendor_id", seat\.actor\.vendorId\)\s*\.eq\("brokerage_id", brokerageId\)/
  check("title badge: counted for the vendor seat (title is a vendor category), keyed on the session's title vendor's assignments in the session tenant — no title_company_users read",
    TITLE_BADGE.test(badgeS) && !/\.from\("title_company_users"\)/.test(badgeS) && !/title_agent/.test(badge))
  check("title badge POSITIVE CONTROL: the finder refuses the old dead-rail shape and a version keyed on a vendor id from anywhere but the session's seat",
    !TITLE_BADGE.test(`userType === "vendor" ? supabase.from("title_company_users").select("id", { count: "exact", head: true }).eq("user_id", user.id)`)
      && !TITLE_BADGE.test(badgeS.replace('.eq("vendor_id", seat.actor.vendorId)', '.eq("vendor_id", body.vendorId)')))


  // ═══ D. CONTACT-ONLY WELCOME VIDEO ═════════════════════════════════════════════════════════════════════════════════════════
  section("D a contact-only welcome video is never re-published through the shared library")
  const { captureRenderAsMarketingAsset } = await import("../lib/marketing/capture-render-asset")
  const { renderHostBucketFor, RENDER_MEDIA_BUCKET } = await import("../lib/remotion/media-host")
  const { PERSONAL_VIDEO_BUCKET } = await import("../lib/storage/document-buckets")
  check("host rule: a project addressed to a contact → the PRIVATE bucket; otherwise the public default", renderHostBucketFor({ contact_id: randomUUID() }) === PERSONAL_VIDEO_BUCKET && renderHostBucketFor({ contact_id: null }) === RENDER_MEDIA_BUCKET && String(PERSONAL_VIDEO_BUCKET) !== String(RENDER_MEDIA_BUCKET))
  const projPersonal = { id: randomUUID(), brokerage_id: B1, contact_id: randomUUID() }, projPublic = { id: randomUUID(), brokerage_id: B1, contact_id: null }
  const render = (p: Row) => ({ id: randomUUID(), brokerage_id: B1, composition_id: "WelcomeVideo", agent_user_id: null, output_url: "https://x/y.mp4", thumbnail_url: null, render_status: "succeeded", entity_type: "video_project", entity_id: p.id, scope_type: "agent", used_did_avatar: false, input_props: {} })
  const rPersonal = render(projPersonal), rPublic = render(projPublic)
  const capDb = makeDb({ remotion_composition_renders: [rPersonal, rPublic], ai_video_projects: [projPersonal, projPublic], marketing_assets: [] })
  const cPublic = await captureRenderAsMarketingAsset(rPublic.id, capDb)
  check("positive: a public project's render IS captured into the reusable library", cPublic.ok === true && (capDb.tables.marketing_assets as Row[]).length === 1)
  const cPersonal = await captureRenderAsMarketingAsset(rPersonal.id, capDb)
  check("ADVERSE: a contact-only render is NOT captured (pre-fix: a 'reusable' marketing_assets row any agent's ads could pick)", cPersonal.ok === false && (capDb.tables.marketing_assets as Row[]).length === 1)
  const capRefused = makeDb({ remotion_composition_renders: [render(projPersonal)], marketing_assets: [] }, { ai_video_projects: "timeout" })
  const cRef = await captureRenderAsMarketingAsset((capRefused.tables.remotion_composition_renders as Row[])[0].id, capRefused)
  check("ADVERSE: an unreadable project is NOT captured (fail closed)", cRef.ok === false && (capRefused.tables.marketing_assets as Row[]).length === 0)
  const rc = code("app/api/internal/remotion/render-composition/route.ts")
  const stillBlock = rc.slice(rc.indexOf("if (isStill)"), rc.indexOf("renderMedia({"))
  const HOSTS_IN_STILL_BUCKET = /hostRenderedMedia\([^\n]*?,\s*stillBucket\)/
  check("still door: the still is hosted in renderHostBucketFor(project), read tenant-pinned (stripped source)", /stillBucket = renderHostBucketFor\(/.test(stillBlock) && /\.eq\("brokerage_id", row\.brokerage_id\)/.test(codeWithStrings("app/api/internal/remotion/render-composition/route.ts")) && HOSTS_IN_STILL_BUCKET.test(stillBlock))
  check("POSITIVE CONTROL — the still-door check rejects the pre-fix host call (no bucket argument)", !HOSTS_IN_STILL_BUCKET.test("hostRenderedMedia(svc, `p`, bytes, outputContentType(composition.duration_frames)) }"))

  // ═══ E. REFUSAL COPY THROUGH THE PRESENTER ═════════════════════════════════════════════════════════════════════════════════
  section("E refusals a person reads go through the presenter; raw text never reaches them")
  const { decideIssuerCorrection } = await import("../lib/documents/document-versions")
  const { presentTenantMessage } = await import("../lib/errors")
  // The pure verdict (document-versions.ts) stays import-free — the DOORS present it (test:proxy-graph-budget: a static lib/errors
  // import there lifted the heaviest app entry). What is proven here: every refusal the verdict can return, driven, is a sentence
  // the presenter's gate ACCEPTS unreplaced — so routing it through the door changes nothing a person reads except the gate.
  const base = { actor: { brokerageId: B1, assigned: true, via: "issuer", issuer: { kind: "title", name: "T" } }, original: { brokerageId: B1, transactionId: "t", classification: "title_commitment", superseded: false, recordedIssuer: null }, transaction: { id: "t", brokerageId: B1, closed: false, financed: true } } as any
  const variants: Array<[string, any]> = [
    ["cross_tenant", { ...base, actor: { ...base.actor, brokerageId: B2 } }],
    ["not_assigned", { ...base, actor: { ...base.actor, assigned: false } }],
    ["proof_required", { ...base, actor: { ...base.actor, via: "staff_on_behalf", proof: null } }],
    ["already_superseded", { ...base, original: { ...base.original, superseded: true } }],
    ["another_issuer", { ...base, original: { ...base.original, recordedIssuer: { kind: "vendor", name: "Other Co", category: "inspector" } } }],
  ]
  const verdicts = variants.map(([want, input]) => ({ want, v: decideIssuerCorrection(input) as { ok: boolean; code?: string; message?: string } }))
  const wrongCode = verdicts.filter((x) => x.v.ok || x.v.code !== x.want).map((x) => `${x.want}→${x.v.ok ? "ok" : x.v.code}`)
  check(`the verdict returns each driven refusal code (${verdicts.length} driven)`, wrongCode.length === 0, wrongCode.join(", "))
  const replaced = verdicts.filter((x) => !x.v.ok && presentTenantMessage({ what: x.v.message ?? "", next: "you", audience: "vendor" }).replaced).map((x) => x.want)
  check(`every driven refusal passes the presenter's gate UNREPLACED (${replaced.length} replaced)`, replaced.length === 0, replaced.join(", "))
  check("POSITIVE CONTROL — the presenter's gate DOES replace a raw database sentence", presentTenantMessage({ what: 'new row violates row-level security policy for table "documents" (42501)', next: "you", audience: "vendor" }).replaced === true)
  // No sentence a person reads splices raw error text: a template literal assigned to message / error that interpolates *.error / *.message.
  const SPLICE = /\b(?:message|error)\s*:\s*`[^`]*\$\{[^}]*(?:\.message|\.error|Err\b|error\b)[^}]*\}[^`]*`/
  check("POSITIVE CONTROL — the splice finder recognises the old shape", SPLICE.test("message: `The corrected version was not filed (${written.error}). Nothing changed — try again.` }"))
  const REFUSAL_FILES = ["lib/documents/vendor-document-correction.ts", "lib/documents/document-versions.ts", "app/actions/vendor-document-corrections.ts", "app/actions/compliance/closing-review.ts"]
  const spliced = REFUSAL_FILES.flatMap((f) => codeWithStrings(f).split("\n").map((l, i) => ({ f, i: i + 1, l })).filter((x) => SPLICE.test(x.l) && !/replay:\s*\(claim\)/.test(x.l)).map((x) => `${x.f}:${x.i}`))
  check(`no raw error text spliced into a person-facing refusal in the ${REFUSAL_FILES.length} correction files (${spliced.length} found)`, spliced.length === 0, spliced.join(", "))
  const cc = codeWithStrings("lib/transactions/closing-compliance.ts")
  const ccFn = (name: string) => cc.slice(cc.indexOf(`export async function ${name}`), cc.indexOf("\nexport ", cc.indexOf(`export async function ${name}`) + 10))
  const ccSpliced = ["recordClosingReviewDecision", "amendDealChecklistVersion"].filter((n) => ccFn(n).split("\n").some((l) => /return \{ ok: false, error: `[^`]*\$\{/.test(l)))
  check(`closing review + checklist amend: the person's sentence carries no raw detail (it rides \`detail\`) (${ccSpliced.length} found)`, ccSpliced.length === 0, ccSpliced.join(", "))
  const doorCR = codeWithStrings("app/actions/compliance/closing-review.ts"), doorVC = codeWithStrings("app/actions/vendor-document-corrections.ts")
  check("the closing-review door presents its refusals (presentTenantError for raw detail, presentTenantMessage otherwise)", /presentRefusal\(r\.error, r\.detail\)/.test(doorCR) && (doorCR.match(/presentRefusal\(r\.error, r\.detail\)/g) ?? []).length === 2)
  check("the correction doors present their core refusals with the right audience (vendor portal / staff)", /refusal\(out\.message, audience, out\.detail\)/.test(doorVC) && /plainResult\(out, "vendor"\)/.test(doorVC) && /plainResult\(out, "account"\)/.test(doorVC))
  const guard = read("scripts/tenant-facing-copy-guard.ts")
  check("the four files are on scripts/tenant-facing-copy-guard.ts SURFACES", REFUSAL_FILES.every((f) => guard.includes(`"${f}"`)))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed   (SIMULATED — in-memory client; see BLIND SPOTS in the header)`)
  if (fail > 0) { console.log(" ✗ Failures:"); for (const f of fails) console.log(`   - ${f}`); process.exit(1) }
  console.log(" DEAL_AUTOMATION_PASS")
}
main().catch((e) => { console.error(e); process.exit(1) })
