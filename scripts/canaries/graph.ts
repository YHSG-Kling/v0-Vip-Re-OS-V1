/**
 * scripts/canaries/graph.ts — GRAPH / OWNERSHIP canary (wave 144, lane 144J; owner ruling 18 + Constitution laws 2 and 5):
 *   tenant isolation on the parent/child chain · every table the wave-144 chains write has a registered owning manager ·
 *   every workflow EXCEPTION has an accountable registered owner · handled signals name real managers · ONE canonical path
 *   (no second commission-state recalculation) · the directed parent/child audit exists, scans stripped source, carries a
 *   positive control · the canaries' own measurement (findLanded) reads code, never a comment.
 * Through the survivors at 967a4866: lib/kernel/manager-registry.ts (MANAGERS, TABLE_MANAGER), lib/kernel/exceptions-first.ts
 * (EXCEPTION_CATEGORIES), lib/kernel/signal-registry.ts (SIGNAL_REGISTRY), lib/offers/governing-terms.ts
 * governingContractTerms (a tenant-pinned chain reader — driven in memory across two tenants).
 *
 * MEASURED AT 967a4866: EXCEPTION_CATEGORIES carry a reader and a door but NO accountable manager; commission-state
 * recalculation has TWO kernel implementations (lib/kernel/transactions.ts recalculateCommissionStateCommand beside
 * lib/kernel/financial.ts recalculateCommissionState — the open wave-142/143 item); scripts/parent-child-graph-guard.ts does
 * not exist yet — 144I.
 */
import { CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { findLanded, fnBody, listFiles, readRepo, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Graph: tenant isolation on the chain · table + exception ownership · one canonical path · the parent/child audit")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")

  // ── 0 · the measurement itself (positive + negative control — CLAUDE.md §2) ──
  // Both specimens live in THIS file, so no other lane's work can move them (the first version pinned the negative specimen to a
  // comment in lib/commission/referral-payout.ts; lane 144D rewrote that comment and the control went red — a waypoint, measured).
  // NEGATIVE SPECIMEN — this token lives only in this comment: w144j_comment_only_specimen
  const SELF = "scripts/canaries/graph.ts"
  const specimen = new RegExp(["w144j", "comment", "only", "specimen"].join("_")) // joined at run time: the code never spells it
  const codeHit = findLanded([SELF], /export\s+async\s+function\s+run\b/)
  const commentOnly = findLanded([SELF], specimen)
  const rawHas = specimen.test(readRepo(SELF) ?? "")
  c.step("MEASUREMENT CONTROL: findLanded answers on a real export (this canary's own `run`) and does NOT answer on a token that lives only in a comment of this file (present in the raw file, stripped away) — a probe that read comments would report a lane landed when only its tombstone did", codeHit === SELF && commentOnly === null && rawHas, `code ${codeHit}; comment-only ${commentOnly}; raw has token ${rawHas}`)

  // ── 1 · TENANT ISOLATION on the parent/child chain ──
  const B1 = uuid(), B2 = uuid(), O = uuid(), C1 = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B1, name: `${CANARY_TAG} Graph A` }, { id: B2, name: `${CANARY_TAG} Graph B` }],
    offers: [
      { id: O, brokerage_id: B1, parent_offer_id: null, current_round: 1, offer_type: "purchase", status: "countered", offer_price: 500_000, buyer_signed_at: nowIso(), notes: CANARY_TAG, created_at: nowIso() },
      { id: C1, brokerage_id: B1, parent_offer_id: O, current_round: 2, offer_type: "counter", status: "accepted", offer_price: 505_000, buyer_signed_at: nowIso(), seller_signed_at: nowIso(), fully_signed_contract_received_at: nowIso(), notes: CANARY_TAG, created_at: nowIso() },
    ],
    contract_term_versions: [],
  })
  setSvc(svc)
  const { governingContractTerms } = await import("../../lib/offers/governing-terms")
  const own = await governingContractTerms(svc as never, B1, { offerId: C1 })
  const foreign = await governingContractTerms(svc as never, B2, { offerId: C1 })
  const leaked = foreign.ok && (foreign.governing.versions.length > 0 || foreign.governing.values.offer_price !== undefined)
  c.rule("144I", "TENANT ISOLATION ON THE CHAIN (green — preserve): the owning tenant reads the offer → counter chain and its governing price ($505,000); ANOTHER tenant asking for the same offer id reads NOTHING of it (no version, no price) — the parent/child walk is pinned to the session tenant at every hop", own.ok && own.governing.values.offer_price === 505_000 && own.governing.versions.length === 2 && !leaked, `own ${own.ok ? own.governing.values.offer_price : own.reason}; foreign ${foreign.ok ? `${foreign.governing.versions.length} versions` : foreign.reason}`)

  // ── 2 · every table the wave-144 chains write has a registered owner (green — preserve) ──
  const reg = await import("../../lib/kernel/manager-registry")
  const managers = new Set(Object.keys(reg.MANAGERS))
  const tables = ["offers", "transactions", "documents", "contract_term_versions", "brokerage_required_documents", "commission_calculations", "commission_distributions", "agent_commissions", "commission_adjustments", "referrals", "referral_partners", "agent_cap_tracking", "leads", "contacts", "portal_contact_invites", "agent_client_messages", "agent_intro_videos", "older_persons_housing_verifications", "content_topic_bank"]
  const unowned = tables.filter((t) => !managers.has(String((reg.TABLE_MANAGER as Record<string, string>)[t] ?? "")))
  c.rule("144I", "MANAGER OWNERSHIP OF EVERY TABLE THE CHAINS WRITE (green — preserve; a new wave-144 table joins this list when its lane lands): offers, transactions, documents, contract-term versions, the checklist, the commission ledger, referrals + partners, cap tracking, leads, contacts, portal invites, the agent → client rail, intro videos, older-persons verifications and the topic bank each map in TABLE_MANAGER to a registered MANAGERS key", unowned.length === 0, `unowned: ${unowned.join(", ") || "none"} (${tables.length} checked)`)

  // ── 3 · every workflow EXCEPTION has an accountable registered owner ──
  const { EXCEPTION_CATEGORIES } = await import("../../lib/kernel/exceptions-first")
  const cats = Object.entries(EXCEPTION_CATEGORIES as unknown as Record<string, Record<string, unknown>>)
  const ownerless = cats.filter(([, spec]) => !["owner", "manager", "ownerManager", "accountable"].some((k) => typeof spec[k] === "string" && managers.has(String(spec[k]))))
  // Owner 144I (ruling 18 is in its brief). A provisional "defect" tag was withdrawn: lane 144I's patch DOES add `owner: ManagerKey`
  // to every ExceptionCategorySpec (lib/kernel/exceptions-first.ts), and this step reads green with that patch alone (measured).
  c.rule("144I", "EVERY WORKFLOW EXCEPTION HAS AN ACCOUNTABLE REGISTERED OWNER (ruling 18: 'every workflow exception has an accountable registered owner'): each Exceptions-First category names the MANAGERS key accountable for it (beside its reader and its door) — at HEAD a category carries a reader and a door only", ownerless.length === 0, `ownerless categories: ${ownerless.map(([k]) => k).join(", ") || "none"} of ${cats.length}`)
  const { SIGNAL_REGISTRY } = await import("../../lib/kernel/signal-registry")
  const badConsumers = Object.entries(SIGNAL_REGISTRY as Record<string, { consumers: string[]; disposition: string }>).filter(([, s]) => s.disposition === "handled" && (s.consumers.length === 0 || s.consumers.some((m) => !managers.has(m))))
  c.rule("144I", "INCIDENT ESCALATION RIDES REGISTERED MANAGERS (green — preserve): every HANDLED signal on the governed bus names at least one consumer and every consumer is a registered manager (evidence shared through the canonical kernel, no side channel)", badConsumers.length === 0, `bad: ${badConsumers.map(([k]) => k).join(", ") || "none"}`)

  // ── 4 · ONE canonical path (Constitution law 2) ──
  const recalc = listFiles("lib", (f) => /\.ts$/.test(f)).filter((f) => /export\s+async\s+function\s+recalculateCommissionState\w*\s*\(/.test(strippedRepo(f) ?? ""))
  // Re-tagged after lane 144I landed: it verified the duplicate and routed it as MONEY to lane 144D (its Outside-lane 1).
  // RE-ASSERTED AS THE RULE (CLAUDE.md §2), not a name count: the first version demanded exactly ONE function named
  // recalculateCommissionState* — but lib/kernel/financial.ts's is the brokerage-wide CAP-STATE refresh (a different function),
  // and a per-deal command that delegates to the engine is a DOOR, not a second calculator. The defect is a per-deal path that
  // PRICES the deal itself (no calculateCommission call) or writes commission_calculations beside the engine's persist stage.
  const ownCalculator = (body: string) => /\btransactionId\b/.test(body) && (!/\bcalculateCommission\s*\(/.test(body) || /\.from\(\s*["']commission_calculations["']\s*\)\s*\.(insert|upsert)\b/.test(body))
  const recalcImpls = recalc.map((f) => {
    const src = strippedRepo(f) ?? ""
    const name = /export\s+async\s+function\s+(recalculateCommissionState\w*)\s*\(/.exec(src)?.[1] ?? ""
    return { f, name, own: ownCalculator(fnBody(src, name)) }
  })
  const pricedOutsideEngine = recalcImpls.filter((r) => r.own)
  // POSITIVE CONTROL: the classifier recognises the defect it was written for (a per-deal recalculation that inserts its own row).
  const controlFlags = ownCalculator("async function recalculateCommissionStateX(p) { const id = p.transactionId; await s.from(\"commission_calculations\").insert({ agent_split: 80 }) }") && !ownCalculator("async function recalculateCommissionStateY(p) { const id = p.transactionId; return calculateCommission({ transactionId: id }) }")
  c.rule("144D", "ONE CANONICAL PATH FOR COMMISSION-STATE RECALCULATION (law 2 'three systems doing one function consolidate toward ONE kernel service'; the open wave-142/143 item): a deal's commission numbers come from ONE calculator — every per-deal recalculation under lib/ prices through the engine (calculateCommission) and none writes commission_calculations beside the engine's persist stage (positive control: the classifier flags a specimen that does)", controlFlags && pricedOutsideEngine.length === 0, `implementations: ${recalcImpls.map((r) => `${r.f}#${r.name}${r.own ? " PRICES OUTSIDE THE ENGINE" : ""}`).join("; ")} · control ${controlFlags}`)

  // ── 5 · the directed parent/child audit exists and measures honestly ──
  const guard = strippedRepo("scripts/parent-child-graph-guard.ts")
  const guardRaw = readRepo("scripts/parent-child-graph-guard.ts") ?? ""
  c.rule("144I", "THE PARENT/CHILD GRAPH AUDIT EXISTS (ruling 18 + lane 144I req 1): scripts/parent-child-graph-guard.ts walks PLATFORM→BROKERAGE→…, PROPERTY→LISTING→OFFER→ACCEPTED COUNTER/CONTRACT→TRANSACTION→COMMISSION, SIGNED AGREEMENT→…→PAYMENT in both directions from the GENERATED caches, reads STRIPPED source (scripts/strip-comments.ts), carries a POSITIVE CONTROL and publishes its blind spots", guard !== null && /strip-comments/.test(guard) && /positive control/i.test(guardRaw) && /blind spot/i.test(guardRaw) && /schema-fk-map/.test(guard), guard ? "present" : "HEAD: scripts/parent-child-graph-guard.ts absent")

  c.blind("The tenant-isolation step drives ONE parent/child reader (the governing-terms chain walk) across two tenants in memory — RLS is not modelled (the harness's published blind spot); the full directed audit is lane 144I's guard. TABLE_MANAGER is read from the registry as it stands; a table a lane adds this wave joins step 2's list at integration.")
  const cl = await cleanupCanary(svc, B1)
  const cl2 = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length + cl2.mismatches.length === 0 && cl.residual + cl2.residual === 0, [...cl.cleanup, ...cl2.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...cl.cleanup, ...cl2.cleanup], cl.residual + cl2.residual)
}
