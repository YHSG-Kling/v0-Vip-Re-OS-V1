/**
 * scripts/saas-operations-guard.ts — test:saas-operations (wave 108B: PLATFORM SELF-OPERATION).
 *
 * Proves, on the REAL modules (lib/platform/saas-operations.ts + lib/kernel/missions.ts) through the
 * in-memory supabase-js stand-in (scripts/in-memory-supabase.ts):
 *   A  usage anomaly: −70% flags, −69% does not, no baseline is never an anomaly
 *   B  every signal names ≥1 evidence reader; a blind reader makes its signals "unknown"
 *   C  deterministic diagnosis: order, each branch, blind check = undetermined (partial)
 *   D  end-to-end: anomaly −70% → diagnosis → a PROPOSED platform support mission (owner
 *      platform_sentinel, Draft ceiling, diagnosis evidence) — and nothing contacts the tenant
 *   E  idempotent: a second sweep opens no second mission and attaches the week's diagnosis once
 *   F  refused reader → published blind spot; refused tenant read → fail closed
 *   G  platform-only: tenant readers / doors never see or move it; staff approve; recovery completes
 *   H  wiring + gates (stripped source) with positive controls
 */
import { readFileSync, readdirSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  detectUsageAnomaly, computeTenantSignals, diagnoseAnomaly, runSaasOperations, supportMissionSubjectId,
  SIGNAL_READERS, READERS, SAAS_OPS_OWNER, type TenantFacts, type ReaderKey, type SaasSignalKey,
} from "../lib/platform/saas-operations"
import {
  PLATFORM_SUPPORT_SUBJECT_TYPE, PLATFORM_SUPPORT_AUTHORITY_CEILING, activeMissionsFor, transitionMission, createMission,
  sweepMissionDeadlines, recruitingNeedSubjectId, stableMissionSubjectId, type MissionDeps,
} from "../lib/kernel/missions"
import { MAINTENANCE_DOMAINS, PLATFORM_MANAGERS } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) } }
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

const NOW = new Date("2026-10-07T12:00:00Z")
const DAY = 86_400_000
const T1 = "11111111-1111-4111-8111-111111111111"
const T2 = "22222222-2222-4222-8222-222222222222"
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString()
/** n events evenly inside (fromDaysAgo, toDaysAgo]. */
const spread = (n: number, fromDaysAgo: number, toDaysAgo: number) => Array.from({ length: n }, (_, i) => ago(toDaysAgo + ((fromDaysAgo - toDaysAgo) * (i + 0.5)) / n))

function seams() {
  const ledger: any[] = [], emits: any[] = [], signals: any[] = []
  const deps: MissionDeps = {
    now: () => NOW,
    afford: async () => ({ allowed: false, reason: "past_due_not_served:app.access" }),
    authority: async () => 6 as any,
    ledger: async (ctx) => { ledger.push(ctx); return `ledger-${ledger.length}` },
    emit: async (i) => { emits.push(i) },
    signal: async (s) => { signals.push(s) },
  }
  return { deps, ledger, emits, signals }
}
const spendOk = async () => ({ ok: true as const, usedTokens: 1000, includedTokens: 100_000, overageTokens: 0 })

function seed(over: Partial<Record<string, any[]>> = {}) {
  const usage = [
    // T1: 280 events in the 28-day baseline (70/wk) then 15 in the last 7 days (−78.6%), 12 failed → provider issue
    ...spread(280, 35, 7).map((at) => ({ brokerage_id: T1, created_at: at, success: true, feature: "ai_isa" })),
    ...spread(15, 7, 0).map((at, i) => ({ brokerage_id: T1, created_at: at, success: i >= 12, feature: "ai_isa" })),
    // T2: steady 70/wk
    ...spread(280, 35, 7).map((at) => ({ brokerage_id: T2, created_at: at, success: true, feature: "listing_copy" })),
    ...spread(70, 7, 0).map((at) => ({ brokerage_id: T2, created_at: at, success: true, feature: "video" })),
  ]
  return {
    brokerages: [
      { id: T1, name: "Tenant One Realty", created_at: ago(200), onboarding_status: "completed", plan_tier: "brokerage", trial_ends_at: null, deleted_at: null },
      { id: T2, name: "Tenant Two Homes", created_at: ago(200), onboarding_status: "completed", plan_tier: "team", trial_ends_at: null, deleted_at: null },
    ],
    subscriptions: [{ brokerage_id: T1, status: "active", trial_end: ago(150) }, { brokerage_id: T2, status: "active", trial_end: null }],
    ai_tool_usage: usage, platform_dunning_events: [], support_tickets: [],
    agents: [{ brokerage_id: T1, is_active: true, updated_at: ago(90) }, { brokerage_id: T2, is_active: true, updated_at: ago(90) }],
    missions: [], mission_events: [],
    ...over,
  }
}

function facts(over: Partial<TenantFacts> = {}): TenantFacts {
  return {
    brokerageId: T1, name: "x", createdAt: ago(200), onboardingStatus: "completed", planTier: "brokerage", subscriptionStatus: "active", trialEnd: null,
    usageAt: [...spread(280, 35, 7), ...spread(15, 7, 0)], aiCalls7d: 15, aiFailures7d: 0, features30d: ["a", "b"], dunningMaxStep: null,
    openTickets: 0, slaBreaches: 0, aiSpend: { usedTokens: 1, includedTokens: 100, overageTokens: 0 }, activeSeats: 3, seatsRemoved: 0,
    engagementTier: "engaged", connectionsExpired: 0, ...over,
  }
}

async function main() {
  console.log("\nA · usage anomaly (7d vs trailing 28d baseline)")
  const a70 = detectUsageAnomaly([...spread(280, 35, 7), ...spread(21, 7, 0)], NOW)   // 21 vs 70 = −70%
  const a69 = detectUsageAnomaly([...spread(280, 35, 7), ...spread(22, 7, 0)], NOW)   // −68.6%
  const aNone = detectUsageAnomaly([...spread(40, 35, 7), ...spread(0, 7, 0)], NOW)   // 10/wk baseline
  check("A1 a 7-day volume of exactly −70% against the weekly baseline IS an anomaly", a70.anomalous && a70.change !== null && Math.abs(a70.change + 0.7) < 1e-9, a70.reason)
  check("A2 −69% is NOT (the threshold is the rule, not a neighbourhood)", !a69.anomalous, a69.reason)
  check("A3 a tenant below the minimum baseline has nothing to fall from — never an anomaly, and says why", !aNone.anomalous && aNone.change === null && /no baseline/.test(aNone.reason), aNone.reason)

  console.log("\nB · every signal names its evidence reader; blind readers read unknown")
  const keys = Object.keys(SIGNAL_READERS) as SaasSignalKey[]
  check("B1 the nine owner signals + seats are all present, each with ≥1 reader that READERS names", ["onboarding", "trial_conversion", "usage", "churn_risk", "billing", "ai_spend", "provider_performance", "support", "feature_adoption", "seats"].every((k) => (SIGNAL_READERS as any)[k]?.length > 0) && keys.every((k) => SIGNAL_READERS[k].every((r) => typeof READERS[r] === "string" && READERS[r].length > 10)))
  const sAll = computeTenantSignals(facts(), new Set(), NOW)
  check("B2 every computed signal carries its readers (the evidence trail on the board tooltip)", keys.every((k) => sAll[k].readers.length > 0 && sAll[k].status !== "unknown"), JSON.stringify(Object.fromEntries(keys.map((k) => [k, sAll[k].status]))))
  const sBlind = computeTenantSignals(facts(), new Set<ReaderKey>(["dunning"]), NOW)
  check("B3 a refused dunning reader makes billing UNKNOWN (never ok) and names the reader", sBlind.billing.status === "unknown" && /dunning/.test(sBlind.billing.value))
  check("B4 positive control: the same facts with the reader present read billing ok", sAll.billing.status === "ok")

  console.log("\nC · deterministic diagnosis")
  const dx = (f: Partial<TenantFacts>, blind: ReaderKey[] = []) => diagnoseAnomaly(computeTenantSignals(facts(f), new Set(blind), NOW))
  check("C1 billing failure outranks everything (dunning step 2 + provider failures)", dx({ dunningMaxStep: 2, aiFailures7d: 14 }).cause === "billing_failure")
  check("C2 provider issue: ≥25% AI failures over ≥10 calls", dx({ aiFailures7d: 5 }).cause === "provider_issue")
  check("C3 provider issue: an expired connection (sentinel facts)", dx({ connectionsExpired: 1 }).cause === "provider_issue")
  check("C4 onboarding stall: not completed, tenant older than the stall window", dx({ onboardingStatus: "in_progress" }).cause === "onboarding_stall")
  check("C5 seat change: seats deactivated in the window", dx({ seatsRemoved: 2 }).cause === "seat_change")
  const un = dx({})
  check("C6 nothing explains it → unexplained, FULL confidence (every check read and ruled out)", un.cause === "unexplained" && un.confidence === "full" && un.ruledOut.length === 4)
  const partial = dx({ aiFailures7d: 5 }, ["dunning"])
  check("C7 a blind higher-priority check → the next positive cause with PARTIAL confidence and the blind cause UNDETERMINED (not ruled out)", partial.cause === "provider_issue" && partial.confidence === "partial" && partial.undetermined.includes("billing_failure") && !partial.ruledOut.includes("billing_failure"), JSON.stringify(partial))
  check("C8 the diagnosis evidence names the reader it came from", /ai_tool_usage/.test(dx({ aiFailures7d: 5 }).evidence.join(" ")))

  console.log("\nD · anomaly −70% → diagnosis → PROPOSED platform support mission (never contacts the tenant)")
  const c = memSupabase(seed(), { stampCreatedAt: true })
  const s = seams()
  const r1 = await runSaasOperations(c as any, NOW, { write: true, sentinel: { engagement: [], connections: [] }, deps: { aiSpend: spendOk, missions: s.deps } })
  const t1 = r1.tenants.find((t) => t.brokerageId === T1)!
  const t2 = r1.tenants.find((t) => t.brokerageId === T2)!
  const m1 = (c.tables.missions ?? [])[0]
  check("D1 T1 (−78.6%) is the one anomaly; T2 (steady) is not", r1.counts.anomalies === 1 && t1.usage.anomalous && !t2.usage.anomalous, `${t1.usage.reason} | ${t2.usage.reason}`)
  check("D2 diagnosed deterministically: provider issue (12 of 15 AI calls failed), full confidence", t1.diagnosis?.cause === "provider_issue" && t1.diagnosis?.confidence === "full", JSON.stringify(t1.diagnosis))
  check("D3 ONE support mission: PROPOSED, owner platform_sentinel (a PLATFORM_MANAGERS key), subject platform_support, brokerage_id = the subject tenant, Draft ceiling",
    c.tables.missions.length === 1 && m1.state === "PROPOSED" && m1.owner_manager === SAAS_OPS_OWNER && SAAS_OPS_OWNER in PLATFORM_MANAGERS && m1.subject_type === PLATFORM_SUPPORT_SUBJECT_TYPE && m1.subject_id === supportMissionSubjectId(T1) && m1.brokerage_id === T1 && m1.authority_ceiling === PLATFORM_SUPPORT_AUTHORITY_CEILING && PLATFORM_SUPPORT_AUTHORITY_CEILING === 2, JSON.stringify(m1))
  const dxEv = (m1?.evidence ?? []).find((e: any) => e.kind === "platform_diagnosis")
  check("D4 the mission carries the diagnosis as evidence (cause, readers, usage numbers) + a created mission_events row", dxEv?.cause === "provider_issue" && dxEv?.usage?.recent_7d === 15 && typeof dxEv?.readers?.usage === "object" && c.tables.mission_events.some((e: any) => e.event_kind === "created" && e.mission_id === m1.id))
  check("D5 LAW 5: the creation is ledgered (actor = the platform manager, scope platform)", s.ledger.some((l) => l.action === "mission.objective.create" && l.actor.id === SAAS_OPS_OWNER && l.actor.scope === "platform"))
  check("D6 the tenant's lapsed entitlement is RECORDED, not a refusal (billing-failure support must be possible)", c.tables.mission_events.some((e: any) => e.event_kind === "created" && /platform_scope \(tenant entitlement: refused/.test(String(e.evidence?.entitlement))))
  const contactTables = ["notifications", "agent_client_messages", "communications", "manager_signals", "outbound_messages", "email_sends"]
  check("D7 NOTHING contacts the tenant: no notification / message / signal rows, no kernel event on the tenant's bus", contactTables.every((t) => (c.tables[t] ?? []).length === 0) && s.emits.length === 0 && s.signals.length === 0, contactTables.map((t) => `${t}:${(c.tables[t] ?? []).length}`).join(" "))

  console.log("\nE · idempotent")
  const evBefore = m1.evidence.length
  const r2 = await runSaasOperations(c as any, NOW, { write: true, sentinel: { engagement: [], connections: [] }, deps: { aiSpend: spendOk, missions: s.deps } })
  check("E1 a second sweep opens no second mission (existing, same subject)", c.tables.missions.length === 1 && r2.counts.missionsCreated === 0 && r2.counts.missionsExisting === 1)
  check("E2 the same week's diagnosis is attached once (attachEvidence dedupes on kind+ref)", c.tables.missions[0].evidence.length === evBefore)
  check("E3 the subject id is the ONE derivation missions.ts owns (recruiting need shares it, byte-identical)", supportMissionSubjectId(T1) === stableMissionSubjectId(`platform_support|${T1}|usage_anomaly`) && recruitingNeedSubjectId(T1, " North ", "Luxury") === stableMissionSubjectId(`${T1}|north|luxury`) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(supportMissionSubjectId(T1)))

  console.log("\nF · refused reader → blind spot; refused tenants → fail closed")
  const cf = memSupabase(seed(), { stampCreatedAt: true, refuse: { platform_dunning_events: "permission denied for table platform_dunning_events" } })
  const rf = await runSaasOperations(cf as any, NOW, { write: true, deps: { aiSpend: spendOk, missions: seams().deps } })
  const tf = rf.tenants.find((t) => t.brokerageId === T1)!
  check("F1 the refused dunning reader is a PUBLISHED blind spot naming the signals it blinds", rf.blindSpots.some((b) => /^dunning .*refused: permission denied.*blinds .*billing/.test(b)), rf.blindSpots.join(" | "))
  check("F2 billing reads unknown and the diagnosis marks billing UNDETERMINED with partial confidence", tf.signals.billing.status === "unknown" && tf.diagnosis?.undetermined.includes("billing_failure") === true && tf.diagnosis?.confidence === "partial")
  check("F3 sentinel facts not supplied (board path) → a named blind spot, churn never claims 'ok' without sign-ins", rf.blindSpots.some((b) => /sentinel_facts/.test(b)) && rf.tenants.every((t) => t.signals.churn_risk.status !== "ok"))
  const cz = memSupabase(seed(), { refuse: { brokerages: "permission denied for table brokerages" } })
  const rz = await runSaasOperations(cz as any, NOW, { write: true, deps: { aiSpend: spendOk, missions: seams().deps } })
  check("F4 a refused tenant read evaluates NOBODY and says so (fail closed — no tenant reads healthy)", rz.tenants.length === 0 && rz.blindSpots.some((b) => /NO tenant could be evaluated/.test(b)))
  const ra = await runSaasOperations(memSupabase(seed(), { stampCreatedAt: true }) as any, NOW, { write: false, deps: { aiSpend: async () => ({ ok: false as const, error: "plan_limits read refused" }) } })
  check("F5 a refused AI-spend read → ai_spend unknown per tenant + a blind spot with the count", ra.tenants.every((t) => t.signals.ai_spend.status === "unknown") && ra.blindSpots.some((b) => /ai_spend refused for 2 of 2/.test(b)))
  check("F6 the read-only board path writes NOTHING", ra.tenants.find((t) => t.brokerageId === T1)?.mission?.action === "not_written")

  console.log("\nG · platform-only")
  const tenantView = await activeMissionsFor(T1, {}, c as any)
  const platformView = await activeMissionsFor(T1, { scope: "platform" }, c as any)
  check("G1 the tenant's own mission reader (twin seam / command center / recruiting) never sees the support mission; the platform scope sees it", tenantView.active.length === 0 && platformView.active.length === 1)
  const tenantMove = await transitionMission({ brokerageId: T1, missionId: m1.id, to: "CANCELLED", reason: "tenant admin tries", actor: { type: "user", id: "tenant-admin" } }, c as any, s.deps)
  check("G2 a tenant door cannot move it — reads as not_found (no id oracle)", !tenantMove.ok && tenantMove.reason === "not_found")
  const forged1 = await createMission({ brokerageId: T1, objective: "x", ownerManager: SAAS_OPS_OWNER, subject: { type: PLATFORM_SUPPORT_SUBJECT_TYPE, id: supportMissionSubjectId(T2) }, actor: { type: "user", id: "tenant-admin" } }, c as any, s.deps)
  const forged2 = await createMission({ brokerageId: T1, objective: "x", ownerManager: "data_steward", subject: { type: PLATFORM_SUPPORT_SUBJECT_TYPE, id: supportMissionSubjectId(T2) }, actor: { type: "manager", id: "data_steward", scope: "platform" } }, c as any, s.deps)
  const forged3 = await createMission({ brokerageId: T1, objective: "x", ownerManager: SAAS_OPS_OWNER, actor: { type: "manager", id: SAAS_OPS_OWNER, scope: "platform" } }, c as any, s.deps)
  check("G3 platform scope is all-or-nothing: a tenant actor, a tenant owner, or a platform owner on a tenant objective are each refused",
    !forged1.ok && forged1.reason === "platform_scope_requires_platform_actor" && !forged2.ok && /platform_scope_requires_platform_owner/.test(forged2.reason) && !forged3.ok && /unknown_owner_manager/.test(forged3.reason))
  ;(c.tables.missions[0] as any).deadline = ago(3)
  const swept = await sweepMissionDeadlines(T1, c as any, { now: NOW }, s.deps)
  check("G4 the tenant reaper skips it even past a deadline (no escalation onto the tenant bus)", swept.escalated === 0 && c.tables.missions[0].state === "PROPOSED" && s.signals.length === 0)
  const approve = await transitionMission({ brokerageId: T1, missionId: m1.id, to: "ACTIVE", reason: "staff took it", actor: { type: "user", id: "staff-1", scope: "platform" } }, c as any, s.deps)
  check("G5 platform staff (scope platform) approve it: PROPOSED → ACTIVE, ledgered", approve.ok && c.tables.missions[0].state === "ACTIVE" && s.ledger.some((l) => l.action === "mission.state.transition" && l.to === "ACTIVE"))
  // recovery: T1's last 7 days back to 60 healthy events
  c.tables.ai_tool_usage.push(...spread(60, 7, 0).map((at) => ({ brokerage_id: T1, created_at: at, success: true, feature: "ai_isa" })))
  const r3 = await runSaasOperations(c as any, NOW, { write: true, sentinel: { engagement: [], connections: [] }, deps: { aiSpend: spendOk, missions: s.deps } })
  const t1r = r3.tenants.find((t) => t.brokerageId === T1)!
  check("G6 usage recovered → progress usage_recovered=1 → the ACTIVE mission COMPLETES deterministically (criteria, never asserted)", t1r.mission?.action === "recovered_progress" && c.tables.missions[0].state === "COMPLETED", JSON.stringify(t1r.mission))

  console.log("\nH · wiring + gates (stripped source, positive-controlled)")
  const cron = src("app/api/cron/platform-sentinel/route.ts")
  check("H1 the platform cron runs the step with write:true on the sentinel's own engagement + connection facts", /runSaasOperations\(\s*svc\s*,\s*now\s*,\s*\{\s*write:\s*true\s*,\s*sentinel:\s*\{\s*engagement:\s*facts\.engagement\s*,\s*connections:\s*facts\.connections/.test(cron))
  check("H2 that cron is on the dispatcher", /\/api\/cron\/platform-sentinel"/.test(src("lib/kernel/cron-dispatch.ts")))
  const page = src("app/dashboard/superadmin/sentinel/page.tsx")
  check("H3 the board is surfaced on the gated platform page (requirePlatformCapability('sentinel'))", /requirePlatformCapability\("sentinel"\)/.test(page) && /<SaasOperationsBoard\s*\/>/.test(page))
  const board = src("app/dashboard/superadmin/sentinel/saas-operations-board.tsx")
  check("H4 the board reads with write:false (it never opens a mission)", /runSaasOperations\(svc,\s*new Date\(\),\s*\{\s*write:\s*false\s*\}\)/.test(board) && !/write:\s*true/.test(board))
  const door = src("app/actions/superadmin/saas-operations.ts")
  const gated = (s2: string) => /requirePlatformCapability\("sentinel",\s*\{\s*requireWrite:\s*true\s*\}\)/.test(s2)
  const bodyTenant = (s2: string) => /input:\s*\{[^}]*brokerageId/.test(s2) || /input\.brokerageId/.test(s2)
  check("H5 the staff door is write-gated and takes NO brokerageId from the caller (tenant = the mission's own row)", gated(door) && !bodyTenant(door) && /scope:\s*"platform"/.test(door))
  check("H6 positive control: a specimen door with a body brokerageId and no gate is caught by both scans", bodyTenant(`export async function x(input: { missionId: string; brokerageId: string }) {}`) && !gated(`export async function x() { await requirePlatformCapability("sentinel") }`))
  const lib = src("lib/platform/saas-operations.ts")
  const contacts = /sendEmail|sendSms|sendSMS|from\("notifications"\)|agent_client_messages|publishManagerSignal|lib\/providers\/messaging/
  check("H7 the platform module has no path that contacts a tenant (no messaging / notifications / bus import)", !contacts.test(lib))
  check("H8 positive control: the contact scan catches a specimen sender", contacts.test(`import { sendEmail } from "@/lib/providers/messaging"`) && contacts.test(`svc.from("notifications").insert({})`))
  const controller = src("lib/kernel/mission-controller.ts")
  check("H9 the tenant mission controller filters platform-scope missions out of its sweep", /filter\(\(m\)\s*=>\s*!isPlatformScopeMission\(m\)\)/.test(controller))
  const migs = readdirSync("supabase/migrations").filter((f) => /\.sql$/.test(f)).sort()
  const definer = migs.filter((f) => /CREATE POLICY missions_select/.test(readFileSync(`supabase/migrations/${f}`, "utf8"))).pop()!
  const defSql = stripComments(readFileSync(`supabase/migrations/${definer}`, "utf8").replace(/--[^\n]*/g, ""))
  check("H10 the LATEST migration defining missions_select hides platform_support from tenants (and mission_events likewise)", /subject_type IS DISTINCT FROM 'platform_support'/.test(defSql) && /m\.subject_type = 'platform_support'/.test(defSql), definer)
  const head = readFileSync(`supabase/migrations/${definer}`, "utf8").split("\n")[0]
  check("H11 that migration's stamp is the lane stamp or an applied stamp", /WRITTEN, NOT APPLIED|APPLIED LIVE \d{4}-\d{2}-\d{2}/.test(head), head)
  const dom = MAINTENANCE_DOMAINS.platform_saas_operations
  check("H12 MAINTENANCE_DOMAINS entry owns this proof with co-owners named in its prose", !!dom && dom.proof === "test:saas-operations" && (dom.coOwners ?? []).length > 0 && (dom.coOwners ?? []).every((k) => dom.what.includes(k)))
  const pkg = JSON.parse(readFileSync("package.json", "utf8"))
  check("H13 test:saas-operations is registered and in the guard chain (membership, not position)", typeof pkg.scripts?.["test:saas-operations"] === "string" && new RegExp("npm run test:saas-operations(\\s|&|$)").test(pkg.scripts?.guard ?? ""))

  console.log(`\nRESULT saas-operations: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(`FAILED: ${fails.join(" | ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
