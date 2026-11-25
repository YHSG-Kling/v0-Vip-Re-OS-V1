#!/usr/bin/env tsx
/**
 * scripts/wave156-r-guard.ts — wave 156, lane 156R (requested key: test:wave156-r-seams). THE SEAMS BATCH 1 LEFT BETWEEN LANES.
 *
 * Four connections, each DRIVEN through the real exported product code on the in-memory client (scripts/in-memory-supabase.ts) with
 * counted seams (the listing loop, the offer submit, the ledger wrapper, the notifier) — never a string scan alone:
 *   §A  FORM LICENSE AND VERSION INTO THE COMPLIANCE DECISION. Lane 156B's decision (lib/kernel/compliance/representation-gate.ts)
 *       now reads lane 156C's directory (formLicenseStanding — lib/forms/form-license-standing.ts, re-exported by form-directory-intake.ts) once per executed document, through
 *       the loaders: a RETIRED form holds and names its replacement; an EXPIRED license holds and names the date; a form the
 *       directory does not know does NOT hold but the reviewer sees "not in your directory" (and can still approve); a directory
 *       that cannot be read HOLDS with a retry; the standing is in the evidence hash, so an approval given before a form was
 *       retired (or left the directory) does not survive it. Positive control: a licensed current form adds no reason.
 *   §B  THE REVIEW IS REACHABLE FROM THE DEAL. app/actions/governing-terms.ts loadDealPacketReviewStatusAction (deal desk first)
 *       answers under review / approved / held (with the count) with the review screen's link — for a desk seat; a vendor and a
 *       Contact get nothing. The deal page mounts it on an EXISTING line (line-neutral) and it carries no decision control.
 *   §C  TWO CONFIRMS CANNOT RACE. lib/documents/governing-terms-proposal.ts applyGoverningTermsDecisions is a compare-and-set on the
 *       proposal store: two confirms that READ THE SAME VALUE before either writes (a rendezvous barrier on the read) each land,
 *       every accepted field is applied exactly once, no decision is lost; a store that keeps changing is refused plainly after
 *       one retry and the deal is unchanged.
 *   §D  A SOLO PRINCIPAL REACHES THEIR OWN QUEUE. A seat typed `agent` on a stored plan_tier = 'solo_agent' account (TIER PARITY)
 *       is admitted to the packet-review section (packetReviewSectionAdmissionAction) — not to the rest of the compliance dashboard
 *       — decides their own packet, and the decision counts that approval at read time. A plain agent in a brokerage is not
 *       admitted; a coordinator on a solo account gains nothing; an unreadable plan refuses.
 *
 * RED AT BASE: WAVE156R_ROOT=<the starting tree> loads that tree's modules (the seam has no opinion there, the store is a blind
 * read-modify-write, the status door and the admission door do not exist).
 *
 * BLIND SPOTS (CLAUDE.md §2): the jsonb compare-and-set is modelled by the in-memory client's `filter(col, "eq", json)` arm (jsonb
 * equality, key order ignored) — PostgREST's jsonb `=` against JSON text is assumed, not exercised live; the interleaving is forced
 * by a read barrier, so it proves the two-readers-one-value case, not every scheduler order; the deal page and the queue page are not
 * rendered in a browser (their mounts are checked in comment-stripped source); brokerage_form_library rows are fixtures — m1005 must be
 * applied for the live directory read to name its columns.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const WT = process.cwd()
const ROOT = process.env.WAVE156R_ROOT || WT
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 500)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (f: string): string => { const p = join(ROOT, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }
const code = (f: string): string => stripComments(raw(f))

// ═══ seams (installed BEFORE any product module loads) ═══════════════════════════════════════════════════════════════════
const G = globalThis as any
G.__R = { mem: null as MemClient | null, seat: null as any, calls: { submit: [] as any[], notify: 0, loop: 0 } }
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
const REPLACE: Record<string, string> = {
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__R.mem }",
  "lib/supabase/server.ts": "export async function createClient(){ const m = globalThis.__R.mem; const s = globalThis.__R.seat; return new Proxy({}, { get: (_t, k) => k === 'auth' ? { getUser: async () => ({ data: { user: s ? { id: s.userId } : null }, error: null }) } : m[k] }) }",
  "lib/notifications/notify-helpers.ts": "export async function notifyComplianceFlag(){ globalThis.__R.calls.notify++; return { notified_count: 1, recipient_user_ids: [] } }; export async function notifyTransactionParties(){ return { sent: true, already_notified: false, errors: [] } }",
  "lib/kernel/action-ledger.ts": "export async function withActionLedger(_c, run){ return run() }; export async function ledgerSessionAction(_c, run){ return run() }; export async function ledgerToolCall(_c, run){ return run() }",
  "lib/agreements/session-actor.ts": "export async function resolveSessionActor(){ const s = globalThis.__R.seat; return s ? { ok: true, actor: s } : { ok: false, error: 'no session' } }",
  "lib/identity/get-agent-context.ts": "export async function getAgentContext(){ const s = globalThis.__R.seat; return s ? { isAuthenticated: true, userId: s.userId, userType: s.userType, brokerageId: s.brokerageId, agentId: s.agentId ?? null } : { isAuthenticated: false } }",
  "lib/teams/team-scope.ts": "export async function leadsAgentsTeam(){ return { ok: true, ledTeamId: null, leads: false } }",
  "app/actions/buyer-offer/submit-to-compliance.ts": "export async function submitOfferToCompliance(p){ globalThis.__R.calls.submit.push(p); return { success: true, transaction_id: 'tx-from-submit' } }",
  "lib/listings/listing-compliance-loop.ts": "export async function runListingComplianceLoop(){ globalThis.__R.calls.loop++; return { outcome: 'advanced', stage: null, reason: null, blockers: [] } }",
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }",
}
const dataUrl = (c: string) => `data:text/javascript,${encodeURIComponent(c)}`
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://in-memory.invalid"
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "in-memory-not-a-key"
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`]) { const p = join(ROOT, c); if (existsSync(p) && !statSync(p).isDirectory()) return p }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    const aliased = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
    const r = aliased ? { url: pathToFileURL(aliased).href, shortCircuit: true } : next(spec, ctx)
    if (String(ctx?.parentURL ?? "").startsWith("data:")) return r
    const path = String(r.url ?? "").split("?")[0]
    const rep = Object.keys(REPLACE).find((k) => path === realUrl(k))
    return rep ? { url: dataUrl(REPLACE[rep]), shortCircuit: true } : r
  },
})
const load = async (p: string): Promise<any> => { try { return await import(pathToFileURL(join(ROOT, p)).href) } catch (e) { return { __loadError: (e as Error)?.message?.slice(0, 200) ?? "load failed" } } }
const quiet = async (f: () => Promise<any>): Promise<any> => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await f() } finally { console.error = e; console.warn = w } }

// ═══ fixtures ════════════════════════════════════════════════════════════════════════════════════════════════════════════
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const B = u(1), B2 = u(2), AG = u(30), AU = u(31), CO = u(32), VU = u(33), CU = u(34), TCU = u(35), O = u(40), CB = u(41), CDOC = u(42), TX = u(50), TX2 = u(51)
const LIB_OLD = u(60), LIB_NEW = u(61), LIB_CUR = u(62)
const T0 = "2026-11-20T12:00:00.000Z"
const PASS_GATE = { allowed: true, refusals: [] as any[] }
const PACKET = { sequence: [O], headOfferId: O, addendumDocumentIds: [] as string[], transactionIds: [] as string[] }
const fullSc = (parties: string[]) => ({ signatures: parties.map((p) => ({ signer_role: p, signer_name: `${p} person`, signed: true })), initials: parties.map((p) => ({ signer_role: p, all_required_initials_present: true })) })
const contractDoc = (over: Partial<Row> = {}): Row => ({
  id: CDOC, brokerage_id: B, contact_id: CB, classification: "signed_contract", classification_confidence: "high", scanned_at: T0, scan_error: null, created_at: T0,
  state_code: "TX", state_form_id: "TREC 20-17", storage_url: null,
  metadata: { linked_offer_id: O }, signature_completeness: fullSc(["buyer", "seller"]),
  extracted_fields: { price: 500000, earnest_money_amount: 10000, closing_date: "2026-12-30", property_address: "40 Elm St, Austin, TX 78702" }, ...over,
})
const offerRow = (over: Partial<Row> = {}): Row => ({ id: O, brokerage_id: B, agent_id: AG, contact_id: CB, listing_id: null, parent_offer_id: null, status: "accepted", offer_type: "purchase", offer_price: 500000, earnest_money: 10000, closing_date: "2026-12-30", property_address: "40 Elm Street, Austin, TX 78702", buyer_signed_at: T0, seller_signed_at: T0, seller_response_type: "accepted", fully_signed_contract_received_at: T0, compliance_passed_at: null, transaction_id: null, metadata: {}, created_at: T0, ...over })
const libRow = (over: Partial<Row>): Row => ({ id: LIB_CUR, brokerage_id: B, state: "TX", name: "One to Four Family Residential Contract", form_code: "TREC 20-17", version: 1, is_active: true, license_expires_at: null, replaced_by_id: null, provider_name: null, provider_form_id: null, provider_form_version: null, ...over })
function world(o: { offer?: Partial<Row>; doc?: Row; library?: Row[]; plan?: string | null; refuse?: Record<string, string>; transactions?: Row[] } = {}): MemClient {
  return memSupabase({
    offers: [offerRow(o.offer)], documents: [o.doc ?? contractDoc()], brokerage_form_library: o.library ?? [],
    agents: [{ id: AG, user_id: AU, brokerage_id: B }],
    users: [
      { id: AU, brokerage_id: B, team_id: null, user_type: "agent" }, { id: CO, brokerage_id: B, team_id: null, user_type: "compliance_officer" },
      { id: VU, brokerage_id: B, team_id: null, user_type: "vendor" }, { id: CU, brokerage_id: B, team_id: null, user_type: "contact" }, { id: TCU, brokerage_id: B, team_id: null, user_type: "tc" },
    ],
    user_role_assignments: [], teams: [], brokerages: o.plan === null ? [] : [{ id: B, plan_tier: o.plan ?? "brokerage" }],
    transactions: o.transactions ?? [], transaction_milestones: [], compliance_events: [], contacts: [{ id: CB, brokerage_id: B, first_name: "Bea", last_name: "Buyer", tc_user_id: null }],
    activities: [], contract_term_versions: [], listings: [],
  }, { uuidIds: true, stampCreatedAt: true, refuse: o.refuse })
}
const seatOf = (userId: string, userType: string, agentId: string | null = null, brokerageId = B) => ({ userId, agentId, brokerageId, userType, isTenantPrincipal: false })
const reasonsOf = (d: any) => (d?.blockingReasons ?? []) as Array<{ code: string; severity: string; message: string; documentId: string | null }>

// ═══ §A form license and version into the decision ═══════════════════════════════════════════════════════════════════════
async function sectionA(rg: any, act: any) {
  section("§A the form's license and version are part of the compliance decision (156B ← 156C)")
  if (rg.__loadError || act.__loadError) { check("the decision module and the reviewer door load", false, rg.__loadError ?? act.__loadError); return }
  const decide = async (m: MemClient) => { G.__R.mem = m; return quiet(() => rg.loadAndDecideOfferRepresentation(m, { brokerageId: B, offerId: O, packet: PACKET, gate: PASS_GATE })) }

  const lic = await decide(world({ library: [libRow({})] }))
  const licForm = reasonsOf(lic.decision).filter((r) => /^form_/.test(r.code))
  check("POSITIVE CONTROL: a form licensed and current in the directory adds no reason (needs_review, awaiting the reviewer only)", lic.ok && lic.decision.verdict === "needs_review" && licForm.length === 0, lic.ok ? reasonsOf(lic.decision) : lic)
  check("…and the standing rides the evidence (licensed_current, the library row named)", lic.ok && lic.decision.evidence.documents?.[0]?.formStanding?.standing === "licensed_current" && lic.decision.evidence.documents?.[0]?.formStanding?.packetId === LIB_CUR, lic.ok ? lic.decision.evidence.documents : null)

  // RETIRED — a working copy staged from library form v1, which a v2 revision has replaced.
  const retiredWorld = () => world({
    doc: contractDoc({ metadata: { linked_offer_id: O, source_library_form_id: LIB_OLD, source_library_version: 1 } }),
    library: [libRow({ id: LIB_OLD, version: 1, is_active: false, replaced_by_id: LIB_NEW }), libRow({ id: LIB_NEW, version: 2 })],
  })
  const ret = await decide(retiredWorld())
  const rr = reasonsOf(ret.ok ? ret.decision : null).find((r) => r.code === "form_license")
  check("a RETIRED form HOLDS the packet and names its replacement (red at base: no finding)", ret.ok && ret.decision.verdict === "hold" && !!rr && rr.severity === "hold" && rr.message.includes(LIB_NEW) && rr.documentId === CDOC, ret.ok ? reasonsOf(ret.decision) : ret)
  check("…with a repair that terminates (re-execute on the current revision)", !!rr && /current revision/.test(String((rr as any).repair ?? "")))

  // LICENSE EXPIRED.
  const exp = await decide(world({ library: [libRow({ license_expires_at: "2026-01-31" })] }))
  const er = reasonsOf(exp.ok ? exp.decision : null).find((r) => r.code === "form_license")
  check("an EXPIRED license HOLDS the packet and names the expiry date", exp.ok && exp.decision.verdict === "hold" && !!er && er.message.includes("2026-01-31"), exp.ok ? reasonsOf(exp.decision) : exp)

  // UNKNOWN — an empty directory must still close; the reviewer sees it.
  const unkWorld = () => world({ library: [] })
  const unk = await decide(unkWorld())
  const ur = reasonsOf(unk.ok ? unk.decision : null).find((r) => r.code === "form_not_in_directory")
  check("a form NOT in the directory does NOT hold (verdict needs_review, no hold reason)", unk.ok && unk.decision.verdict === "needs_review" && !reasonsOf(unk.decision).some((r) => r.severity !== "review"), unk.ok ? reasonsOf(unk.decision) : unk)
  check("…but it is a REVIEW line saying the form is not in your directory (red at base: nothing said)", !!ur && ur.severity === "review" && /not in your directory/.test(ur.message), unk.ok ? reasonsOf(unk.decision) : null)
  G.__R.mem = unkWorld(); G.__R.seat = seatOf(CO, "compliance_officer"); G.__R.calls.submit = []
  const view = await quiet(() => act.getRepresentationReviewAction({ record: "purchase_offer", subjectId: O }))
  check("THE REVIEWER SEES IT: the review screen's read carries the line and the document's standing 'unknown'", view.success && reasonsOf(view.decision).some((r) => r.code === "form_not_in_directory") && view.decision.evidence.documents?.[0]?.formStanding?.standing === "unknown", view)
  const appr = await quiet(() => act.recordRepresentationReview({ record: "purchase_offer", subjectId: O, decision: "approve", evidenceHash: view.success ? view.decision.evidenceHash : "" }))
  check("…and may still APPROVE it (a tenant with an empty directory can close): the approval continues the offer once", appr.success && G.__R.calls.submit.length === 1, appr)

  // DIRECTORY READ ERROR — a hold with a retry, never a pass.
  const errW = () => world({ library: [libRow({})], refuse: { brokerage_form_library: "permission denied for table brokerage_form_library" } })
  const err = await decide(errW())
  const xr = reasonsOf(err.ok ? err.decision : null).find((r) => r.code === "form_directory_unread")
  check("a directory READ ERROR HOLDS the packet with a retry (never a silent pass)", err.ok && err.decision.verdict === "hold" && !!xr && /retry/i.test(xr.message) && /permission denied/.test(xr.message), err.ok ? reasonsOf(err.decision) : err)
  G.__R.mem = errW(); G.__R.calls.submit = []
  const v2 = await quiet(() => act.getRepresentationReviewAction({ record: "purchase_offer", subjectId: O }))
  const appr2 = await quiet(() => act.recordRepresentationReview({ record: "purchase_offer", subjectId: O, decision: "approve", evidenceHash: v2.success ? v2.decision.evidenceHash : "0".repeat(64) }))
  check("…and the reviewer cannot approve over it (nothing continues)", !appr2.success && G.__R.calls.submit.length === 0, appr2)

  // RETIRING AFTER APPROVAL invalidates the approval.
  const m = world({ library: [libRow({})] }); G.__R.mem = m; G.__R.calls.submit = []
  const v3 = await quiet(() => act.getRepresentationReviewAction({ record: "purchase_offer", subjectId: O }))
  const ok3 = await quiet(() => act.recordRepresentationReview({ record: "purchase_offer", subjectId: O, decision: "approve", evidenceHash: v3.success ? v3.decision.evidenceHash : "" }))
  const before = await decide(m)
  check("POSITIVE CONTROL: a reviewer's approval of the licensed packet → ALLOW", ok3.success && before.ok && before.decision.verdict === "allow", before.ok ? before.decision.verdict : before)
  Object.assign(m.tables.brokerage_form_library[0], { is_active: false })
  const after = await decide(m)
  check("RETIRING the form AFTER the approval invalidates it: hold, no approval carried, a different evidence hash", after.ok && after.decision.verdict === "hold" && after.decision.approval === null && after.decision.evidenceHash !== before.decision?.evidenceHash && reasonsOf(after.decision).some((r) => r.code === "form_license"), after.ok ? { v: after.decision.verdict, r: reasonsOf(after.decision) } : after)
  m.tables.brokerage_form_library = []
  const gone = await decide(m)
  check("…and a form that LEAVES the directory after approval is not covered either (the standing is in the hash): needs_review, not allow", gone.ok && gone.decision.verdict === "needs_review" && gone.decision.approval === null, gone.ok ? gone.decision.verdict : gone)

  // The listing side reads the same standing (one decision, two records).
  const lsrc = code("lib/kernel/compliance/representation-gate.ts")
  const iL = lsrc.indexOf("export async function loadAndDecideListingRepresentation"), iO = lsrc.indexOf("export async function loadAndDecideOfferRepresentation")
  const body = (from: number) => lsrc.slice(from, lsrc.indexOf("\nexport ", from + 10))
  check("BOTH loaders attach the standing once per executed document (listing and offer)", iL > 0 && iO > 0 && /attachFormStandings\(/.test(body(iL)) && /attachFormStandings\(/.test(body(iO)), { iL, iO })
  const intake = await load("lib/forms/form-directory-intake.ts")
  const readers = (lsrc.match(/from\(\s*["']brokerage_form_library["']/g) ?? []).length
  check("…and the standing is read through lane 156C's ONE reader (formLicenseStanding — the forms intake's export IS the decision's function), never a second directory reader",
    /formLicenseStanding\(db,/.test(lsrc) && readers === 1 && typeof rg.formLicenseStanding === "function" && intake.formLicenseStanding === rg.formLicenseStanding, { readers, same: intake.formLicenseStanding === rg.formLicenseStanding })
  G.__R.seat = null
}

// ═══ §B the review reachable from the deal ═══════════════════════════════════════════════════════════════════════════════
async function sectionB(gt: any, act: any) {
  section("§B the deal shows its offer packet's review status (desk seats only), linked to the review screen")
  if (gt.__loadError || typeof gt.loadDealPacketReviewStatusAction !== "function") { check("app/actions/governing-terms.ts exports loadDealPacketReviewStatusAction", false, gt.__loadError ?? "missing"); return }
  const txRow = (over: Partial<Row> = {}): Row => ({ id: TX, brokerage_id: B, agent_id: AG, buyer_agent_id: null, seller_agent_id: null, offer_id: O, ...over })
  const status = async (seat: any) => { G.__R.seat = seat; return quiet(() => gt.loadDealPacketReviewStatusAction(TX)) }
  const m = world({ library: [libRow({})], transactions: [txRow()] }); G.__R.mem = m
  const s1 = await status(seatOf(AU, "agent", AG))
  check("the deal's agent sees UNDER REVIEW with the review screen's link", s1.success && s1.status?.state === "under_review" && s1.status?.href === `/dashboard/compliance/queue/review/purchase_offer/${O}`, s1)
  G.__R.seat = seatOf(CO, "compliance_officer"); G.__R.calls.submit = []
  const v = await quiet(() => act.getRepresentationReviewAction({ record: "purchase_offer", subjectId: O }))
  const ap = await quiet(() => act.recordRepresentationReview({ record: "purchase_offer", subjectId: O, decision: "approve", evidenceHash: v.success ? v.decision.evidenceHash : "" }))
  // The deal now exists for that offer (the approval's continuation created it): the status still reads the packet as reviewed.
  m.tables.offers[0].transaction_id = TX
  const s2 = await status(seatOf(CO, "compliance_officer"))
  check("after the reviewer approves (and the deal exists), the status reads APPROVED", ap.success && s2.success && s2.status?.state === "approved", { ap, s2 })
  const s2a = await status(seatOf(TCU, "tc"))
  check("…for the coordinator too (a desk seat)", s2a.success && s2a.status?.state === "approved", s2a)
  m.tables.offers[0].offer_price = 525000
  const s3 = await status(seatOf(AU, "agent", AG))
  check("a record the executed contract contradicts reads HELD with the count of reasons", s3.success && s3.status?.state === "held" && s3.status?.holdCount === 1, s3)
  const sv = await status(seatOf(VU, "vendor"))
  check("a VENDOR seat gets nothing (refused by the deal desk; the line renders nothing)", !sv.success && !("status" in sv), sv)
  const sc = await status(seatOf(CU, "contact"))
  check("a CONTACT seat gets nothing", !sc.success && !("status" in sc), sc)
  const sx = await status(seatOf(CO, "compliance_officer", null, B2))
  check("another tenant's reviewer gets nothing", !sx.success, sx)
  G.__R.mem = world({ transactions: [txRow({ id: TX2, offer_id: null })] }); G.__R.seat = seatOf(AU, "agent", AG)
  const sn = await quiet(() => gt.loadDealPacketReviewStatusAction(TX2))
  check("a deal with no offer has no packet line (status null)", sn.success && sn.status === null, sn)
  const page = code("app/dashboard/transactions/[id]/transaction-detail-client.tsx")
  const card = code("app/components/transactions/governing-terms-proposals-card.tsx")
  check("the deal page mounts the status line (with the deal's id) in the documents tab", /<DealPacketReviewStatusLine\s+transactionId=\{transaction\.id\}\s*\/>/.test(page))
  check("the line reads the status door, links to the review, and carries NO decision control (Approve stays on the review screen)",
    /export function DealPacketReviewStatusLine/.test(card) && /loadDealPacketReviewStatusAction\(/.test(card) && /href=\{s\.href\}/.test(card) && !/recordRepresentationReview|attestRepresentationTerms/.test(card))
  const pageRaw = raw("app/dashboard/transactions/[id]/transaction-detail-client.tsx")
  check("the mount is line-neutral (the status line shares the documents-tab line, not a new one)", /<TabsContent value="documents"[^\n]*<DealPacketReviewStatusLine[^\n]*<GoverningTermsProposalsCard/.test(pageRaw))
  G.__R.seat = null
}

// ═══ §C two confirms cannot race ═════════════════════════════════════════════════════════════════════════════════════════
/** A client whose proposal-store reads RENDEZVOUS in pairs: a read waits (up to 40 ms) for a second one, so two confirms read the same value. */
function barrierClient(m: MemClient): MemClient {
  let waiting: (() => void) | null = null
  const rendezvous = () => new Promise<void>((res) => {
    if (waiting) { const w = waiting; waiting = null; w(); res(); return }
    const t = setTimeout(() => { if (waiting === done) waiting = null; res() }, 40)
    const done = () => { clearTimeout(t); res() }
    waiting = done
  })
  return new Proxy(m, { get(t, k) {
    if (k !== "from") return (t as any)[k]
    return (table: string) => {
      const q = (t as any).from(table)
      if (table !== "transactions") return q
      let isRead = false
      const wrap = (b: any): any => new Proxy(b, { get(bt, bk) {
        if (bk === "select") return (c?: string) => { if (c && /governing_terms_proposals/.test(c)) isRead = true; return wrap(bt.select(c)) }
        if (bk === "maybeSingle") return async () => { const r = await bt.maybeSingle(); if (isRead) await rendezvous(); return r }
        const v = bt[bk]
        return typeof v === "function" ? (...a: any[]) => { const r = v.apply(bt, a); return r === bt ? wrap(bt) : r } : v
      } })
      return wrap(q)
    }
  } }) as MemClient
}
/** A client whose proposal-store reads each CHANGE the stored value right after reading it (a writer that always loses). */
function churnClient(m: MemClient): MemClient {
  return new Proxy(m, { get(t, k) {
    if (k !== "from") return (t as any)[k]
    return (table: string) => {
      const q = (t as any).from(table)
      if (table !== "transactions") return q
      const wrap = (b: any): any => new Proxy(b, { get(bt, bk) {
        if (bk === "maybeSingle") return async () => { const r = await bt.maybeSingle(); const row = t.tables.transactions[0]; row.governing_terms_proposals = row.governing_terms_proposals.map((p: any) => ({ ...p, proposed_at: `${Date.now()}-${Math.random()}` })); return r }
        const v = bt[bk]
        return typeof v === "function" ? (...a: any[]) => { const r = v.apply(bt, a); return r === bt ? wrap(bt) : r } : v
      } })
      return wrap(q)
    }
  } }) as MemClient
}
async function sectionC(store: any, gt: any) {
  section("§C two confirms cannot race — compare-and-set on the proposal store, each accepted field applied exactly once")
  if (store.__loadError) { check("the proposal store loads", false, store.__loadError); return }
  const PID = u(70)
  const seed = (fields: Record<string, unknown> = { purchase_price: 401000, close_date: "2027-01-30", inspection_deadline: "2026-12-05" }) => {
    const m = world({ transactions: [{ id: TX, brokerage_id: B, agent_id: AG, offer_id: O, purchase_price: 400000, close_date: "2027-01-15", property_address: "40 Elm Street",
      governing_terms_proposals: [{ id: PID, source: { kind: "client_document", document_id: CDOC, document_name: "Purchase agreement.pdf" }, proposed_by: AU, proposed_at: T0, fields, decisions: {} }] }] })
    return m
  }
  const decisionsOf = (m: MemClient) => (m.tables.transactions[0].governing_terms_proposals?.[0]?.decisions ?? {}) as Record<string, any>
  const priceWrites = (m: MemClient) => m.writes.filter((w) => w.table === "transactions" && w.op === "update" && "purchase_price" in w.payload && w.matched > 0).length
  const apply = (db: MemClient, accept: string[], dismiss: string[], by: string) => quiet(() => store.applyGoverningTermsDecisions(db, { transactionId: TX, brokerageId: B, proposalId: PID, accept, dismiss, by }))

  // (1) DIFFERENT fields, read at the same moment.
  let m = seed(); let db = barrierClient(m)
  const [a, b] = await Promise.all([apply(db, ["purchase_price"], [], AU), apply(db, ["close_date"], [], CO)])
  const d1 = decisionsOf(m)
  check("two interleaved confirms of DIFFERENT fields: both land, and NEITHER decision is lost (red at base: the later write erases the earlier)",
    a.ok && b.ok && d1.purchase_price?.decision === "accepted" && d1.close_date?.decision === "accepted" && m.tables.transactions[0].purchase_price === 401000 && m.tables.transactions[0].close_date === "2027-01-30", { a, b, d1 })
  check("…the closing-day milestone is set once, by the writer that claimed it", m.tables.transaction_milestones.filter((x: Row) => x.milestone_name === "closing_day").length === 1 && m.writes.filter((w) => w.table === "transaction_milestones").length === 1, m.writes.filter((w) => w.table === "transaction_milestones"))

  // (2) the SAME field, read at the same moment.
  m = seed(); db = barrierClient(m)
  const [c, d] = await Promise.all([apply(db, ["purchase_price"], [], AU), apply(db, ["purchase_price"], [], CO)])
  const appliedBy = [c, d].filter((r: any) => r.ok && r.applied.includes("purchase_price")).length
  const skippedBy = [c, d].filter((r: any) => r.ok && r.skipped.includes("purchase_price")).length
  check("two interleaved confirms of the SAME field: it is applied EXACTLY ONCE (one counted deal write), the other confirm skips it",
    appliedBy === 1 && skippedBy === 1 && priceWrites(m) === 1, { c, d, priceWrites: priceWrites(m) })
  check("…and the one recorded decision is the winner's (one author, not overwritten)", [AU, CO].includes(decisionsOf(m).purchase_price?.by) && decisionsOf(m).purchase_price?.decision === "accepted")

  // (3) accept vs dismiss of different fields.
  m = seed(); db = barrierClient(m)
  const [e, f] = await Promise.all([apply(db, ["purchase_price"], [], AU), apply(db, [], ["inspection_deadline"], CO)])
  check("an accept and a dismiss interleaved: both decisions are recorded; the dismissed term writes nothing",
    e.ok && f.ok && decisionsOf(m).purchase_price?.decision === "accepted" && decisionsOf(m).inspection_deadline?.decision === "dismissed" && m.tables.transaction_milestones.length === 0, { e, f, d: decisionsOf(m) })

  // (4) a store that changes under every write: one retry, then a plain refusal, deal unchanged.
  m = seed()
  const churn = churnClient(m)
  const g = await apply(churn, ["purchase_price"], [], AU)
  check("a store that changes under every attempt: ONE retry, then a plain refusal — and the deal is unchanged",
    !g.ok && /same moment/.test(g.error ?? "") && m.tables.transactions[0].purchase_price === 400000 && Object.keys(decisionsOf(m)).length === 0, g)

  // (5) THE DOOR: two confirmGoverningTermsAction calls in flight together (desk first, both seats on the deal).
  if (!gt.__loadError) {
    m = seed(); G.__R.mem = barrierClient(m)
    G.__R.seat = seatOf(AU, "agent", AG)
    const p1 = quiet(() => gt.confirmGoverningTermsAction({ transactionId: TX, proposalId: PID, accept: ["purchase_price"] }))
    G.__R.seat = seatOf(CO, "compliance_officer")
    const p2 = quiet(() => gt.confirmGoverningTermsAction({ transactionId: TX, proposalId: PID, accept: ["purchase_price", "close_date"] }))
    const [r1, r2] = await Promise.all([p1, p2])
    check("THE DOOR: two confirms in flight together — each accepted field is applied once and both decisions stand",
      r1.success && r2.success && priceWrites(m) === 1 && decisionsOf(m).purchase_price?.decision === "accepted" && decisionsOf(m).close_date?.decision === "accepted", { r1, r2, w: priceWrites(m) })
    G.__R.seat = null
  }
  const src = code("lib/documents/governing-terms-proposal.ts")
  const outsideCas = src.replace(/async function casWriteProposals[\s\S]*?\n}\n/, "")
  check("source: every write of the proposal store goes through the compare-and-set (no other .update( in the store module)", /async function casWriteProposals/.test(src) && /\.filter\("governing_terms_proposals",\s*"eq",\s*JSON\.stringify\(readValue\)\)/.test(src) && !/\.update\(/.test(outsideCas))
}

// ═══ §D a solo principal reaches their own queue ═════════════════════════════════════════════════════════════════════════
async function sectionD(act: any, rg: any, dash: any) {
  section("§D a solo principal typed `agent` opens the packet-review section; a plain agent in a brokerage does not")
  if (act.__loadError || typeof act.packetReviewSectionAdmissionAction !== "function") { check("app/actions/compliance/representation-review.ts exports packetReviewSectionAdmissionAction", false, act.__loadError ?? "missing"); return }
  const solo = () => world({ library: [libRow({})], plan: "solo_agent" })
  G.__R.mem = solo(); G.__R.seat = seatOf(AU, "agent", AG)
  const adm = await quiet(() => act.packetReviewSectionAdmissionAction())
  check("a SOLO-tier principal typed `agent` (no team row — the tier-parity rule, not the team-lead rule) is ADMITTED to the packet-review section", adm.admitted === true, adm)
  if (!dash.__loadError) {
    const d = await quiet(() => dash.getComplianceDashboard())
    check("…but NOT to the rest of the compliance dashboard (its own role gate still refuses)", d.error === "Not authorized for compliance dashboard", d.error)
  }
  G.__R.calls.submit = []
  const v = await quiet(() => act.getRepresentationReviewAction({ record: "purchase_offer", subjectId: O }))
  check("…opens their own packet and may decide it", v.success && v.mayDecide === true, v)
  const ok = await quiet(() => act.recordRepresentationReview({ record: "purchase_offer", subjectId: O, decision: "approve", evidenceHash: v.success ? v.decision.evidenceHash : "" }))
  const reread = await quiet(() => rg.loadAndDecideOfferRepresentation(G.__R.mem, { brokerageId: B, offerId: O, packet: PACKET, gate: PASS_GATE }))
  check("…their approval continues the offer AND the decision counts it at read time (ALLOW — authority re-checked, same rule)", ok.success && G.__R.calls.submit.length === 1 && reread.ok && reread.decision.verdict === "allow", { ok, v: reread.ok ? reread.decision.verdict : reread })

  G.__R.mem = world({ library: [libRow({})], plan: "brokerage" }); G.__R.seat = seatOf(AU, "agent", AG)
  const no = await quiet(() => act.packetReviewSectionAdmissionAction())
  check("NEGATIVE: a plain agent in a brokerage is NOT admitted", no.admitted === false, no)
  G.__R.calls.submit = []
  const v2 = await quiet(() => act.getRepresentationReviewAction({ record: "purchase_offer", subjectId: O }))
  const try2 = await quiet(() => act.recordRepresentationReview({ record: "purchase_offer", subjectId: O, decision: "approve", evidenceHash: v2.success ? v2.decision.evidenceHash : "0".repeat(64) }))
  check("…and cannot decide their own packet", !try2.success && G.__R.calls.submit.length === 0, try2)
  G.__R.mem = solo(); G.__R.seat = seatOf(TCU, "tc")
  const tc = await quiet(() => act.packetReviewSectionAdmissionAction())
  check("a coordinator seat on a solo account gains nothing from the tier (not the producing seat)", tc.admitted === false, tc)
  G.__R.mem = world({ plan: "solo_agent", refuse: { brokerages: "permission denied for table brokerages" } }); G.__R.seat = seatOf(AU, "agent", AG)
  const ref = await quiet(() => act.packetReviewSectionAdmissionAction())
  check("an unreadable plan REFUSES (fail closed)", ref.admitted === false && !!ref.error, ref)
  const page = code("app/dashboard/compliance/queue/page.tsx")
  const iNA = page.indexOf('"Not authorized for compliance dashboard"'), iAdm = page.indexOf("packetReviewSectionAdmissionAction"), iQ = page.indexOf("<RepresentationReviewQueue", iAdm), iDeny = page.indexOf("You don't have permission")
  check("the queue page renders ONLY the packet-review section for the admitted seat, inside the not-authorized branch", iNA > 0 && iAdm > iNA && iQ > iAdm && iDeny > iQ && !page.slice(iAdm, iDeny).includes("data.items"), { iNA, iAdm, iQ, iDeny })
  G.__R.seat = null
}

// ═══ run ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`wave156-r-guard — root ${ROOT}`)
  const rg = await load("lib/kernel/compliance/representation-gate.ts")
  const act = await load("app/actions/compliance/representation-review.ts")
  const gt = await load("app/actions/governing-terms.ts")
  const store = await load("lib/documents/governing-terms-proposal.ts")
  const dash = await load("app/actions/compliance/dashboard.ts")
  await sectionA(rg, act)
  await sectionB(gt, act)
  await sectionC(store, gt)
  await sectionD(act, rg, dash)
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) { console.log("FAILED:"); for (const f of fails) console.log(`  - ${f}`) }
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
