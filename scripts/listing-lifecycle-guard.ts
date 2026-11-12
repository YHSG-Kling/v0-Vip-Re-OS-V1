#!/usr/bin/env tsx
/**
 * scripts/listing-lifecycle-guard.ts   (npm run test:listing-lifecycle) — in-memory, no DB, no network.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 147, LANE 147F — owner rulings 8 + 10 (2026-10-31), contract C12:
 *   "coming soon start date is the day the listing agreement was executed and once the listing is live on mls, the listing
 *    becomes active not coming soon" · "no archived listing should still be seen publicly" · "archived listings should still show"
 *
 *   C12  agreement_executed(at) → coming_soon(start = executed_at, planned_mls_live_at) → active(on the MLS-verified EVENT,
 *        never on a date) → pending / sold / withdrawn / expired → archived (internal only).
 *
 *   A  ONE VOCABULARY (derived from scripts/check-vocabularies.ts, never typed): the public set and its complement PARTITION
 *      the live listings_status_check; the gated statuses are DERIVED from the stage map; `archived` is not a status
 *      (it is listings.deleted_at); isListingPubliclyVisible is false for an archived row of EVERY status.
 *   B  THE COMING SOON WINDOW: start = the agreement's EXECUTION day (the last party's signature — not fully_executed_at,
 *      which lands after compliance; never created_at), read by the ONE agreement reader; planned date preserved; the
 *      window ends only on the FEED-VERIFIED live day.
 *   C  THE JOURNEY on the real modules: executed → coming_soon → the planned day passes (NOTHING flips; a finding) → the
 *      feed confirms → the activation gate → MLS_ACTIVE / active (ledgered once; a re-check does not re-activate) → a
 *      refused gate changes nothing and the concierge is told WHY, once → archived: never public, still readable by id.
 *   D  THE MANUAL DOOR cannot write a gated status (app/actions/listings-kernel.ts updateListingStatus) and runs under the
 *      ledger; the board's picker disables them.
 *   E  EVERY PUBLIC READER (derived from the proxy classifier, app/constants/auth.ts classifyProxyPath — plus the server
 *      actions those pages import) filters `deleted_at IS NULL` and stays inside the public status set.
 *   F  INTERNAL READERS keep history: the authorized lifecycle page reads archived rows by id and labels them ARCHIVED.
 *   G  THE CONCIERGE HEARS IT: listing_lifecycle_finding is registered (kind = the live classifier's).
 *   H  THE MLS COMING SOON LIMIT counts from the execution day at the COMING_SOON_ACTIVE door (readiness checker).
 *
 * POSITIVE CONTROLS on every finder. Scans read STRIPPED source (scripts/strip-comments.ts) — a tombstone is not a reader.
 * BLIND SPOTS (printed at the end): no RLS / CHECK / trigger is executed; the public-reader census follows a public page's
 * imports ONE level into app/actions; a reader that builds its query in a helper outside the page is judged in that helper
 * only when the page imports it from app/actions.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=6000 npx tsx --conditions=react-server scripts/listing-lifecycle-guard.ts
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { stubModule } from "./canaries/_harness"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const raw = (rel: string): string => { try { return readFileSync(join(ROOT, rel), "utf8") } catch { return "" } }
const code = (rel: string): string => stripComments(raw(rel))

// lifecycle events are recorded, not written to a real table (the verified writer's evidence row)
const G = globalThis as unknown as { __147FL: { events: unknown[] } }
G.__147FL = { events: [] }
stubModule("@/lib/events/lifecycle-event-core", "export const recordLifecycleEvent = async (svc, brokerageId, input) => { globalThis.__147FL.events.push({ brokerageId, input }); return { ok: true, event: { id: 'evt-' + globalThis.__147FL.events.length }, deduped: false } }")

const B = "b1470000-0000-4000-8000-0000000000aa"
const L = "11470000-0000-4000-8000-0000000000aa"
const LA = "1a470000-0000-4000-8000-0000000000aa"

async function main(): Promise<void> {
  const lss = await import("../lib/listings/listing-status-sync")
  const cdom = await import("../lib/listings/compute-dom")
  const live = CHECK_VOCABULARIES.listings?.status ?? []

  // ── A ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── A  one vocabulary: public ∪ not-public = the live CHECK; gated derived; archived is deleted_at ──")
  const pub = [...lss.PUBLICLY_VISIBLE_LISTING_STATUSES] as string[]
  const notPub = [...lss.NOT_PUBLICLY_VISIBLE_LISTING_STATUSES] as string[]
  const partitions = (a: string[], b: string[], all: readonly string[]) =>
    a.every((s) => all.includes(s)) && b.every((s) => all.includes(s)) && !a.some((s) => b.includes(s)) && all.every((s) => a.includes(s) || b.includes(s))
  check(`the public set and its complement PARTITION the live listings_status_check (${live.length} values, derived)`, live.length > 0 && partitions(pub, notPub, live), JSON.stringify({ pub, notPub, live }))
  check("POSITIVE CONTROL: a partition missing one live status is caught", !partitions(pub, notPub.slice(1), live))
  check("`archived` is NOT a listing status (the archive is listings.deleted_at — lib/kernel/listing-archive.ts)", !live.includes("archived"))
  check("an ARCHIVED row is never publicly visible, whatever its status; the same row unarchived in a public status is",
    live.every((s) => !lss.isListingPubliclyVisible({ status: s, deleted_at: "2026-10-01T00:00:00Z" })) && pub.every((s) => lss.isListingPubliclyVisible({ status: s, deleted_at: null })) && notPub.every((s) => !lss.isListingPubliclyVisible({ status: s, deleted_at: null })))
  const gatedDerived = [lss.STATUS_AT_LISTING_AGREEMENT_SIGNED, lss.STATUS_AFTER_LISTING_AGREEMENT_GATE, lss.statusForStage("MLS_ACTIVE")]
  check("the GATED statuses are derived from the stage map (agreement signed · compliance passed · MLS_ACTIVE) and are live CHECK values",
    JSON.stringify([...lss.GATED_LISTING_STATUSES].sort()) === JSON.stringify([...gatedDerived].sort()) && lss.GATED_LISTING_STATUSES.every((s) => live.includes(s)))
  check("…and no gated status is settable by hand; every other live status is",
    live.every((s) => lss.isManuallySettableListingStatus(s) === !(lss.GATED_LISTING_STATUSES as readonly string[]).includes(s)) && !lss.isManuallySettableListingStatus("archived"))
  check("`active` is still the ONE MLS-live status (exactly one stage yields it — the two-senses rule holds)",
    lss.mappedStages().filter((m) => m.status === "active").map((m) => m.stage).join() === "MLS_ACTIVE")

  // ── B ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── B  the Coming Soon window: start = the execution day; planned preserved; end only on verified ──")
  const NOW = new Date("2026-10-31T15:00:00Z")
  const w0 = cdom.resolveComingSoonWindow({ agreementExecutedAt: "2026-10-02T03:30:00Z", listing: { go_live_date: "2026-10-20", mls_live_timezone: "America/Los_Angeles" } }, NOW)
  check("start = the agreement's execution day IN THE LISTING'S ZONE (03:30Z on Oct 2 is Oct 1 in Los Angeles)", w0.start === "2026-10-01" && w0.startBasis === "agreement_executed", JSON.stringify(w0))
  check("the planned day passing does NOT end Coming Soon (no verified live day → still open; the plan is preserved)", w0.open === true && w0.plannedLive === "2026-10-20" && w0.verifiedLive === null && w0.days === 30)
  const w1 = cdom.resolveComingSoonWindow({ agreementExecutedAt: "2026-10-02T03:30:00Z", listing: { go_live_date: "2026-10-20", mls_live_date_actual: "2026-10-22", go_live_confirmed_at: "2026-10-22T18:00:00Z", go_live_confirmed_source: "rentcast", mls_live_timezone: "America/Los_Angeles" } }, NOW)
  check("the FEED-VERIFIED live day ends it (Oct 1 → Oct 22 = 21 days)", w1.open === false && w1.verifiedLive === "2026-10-22" && w1.days === 21, JSON.stringify(w1))
  const w2 = cdom.resolveComingSoonWindow({ agreementExecutedAt: null, listing: {} }, NOW)
  check("no executed agreement → NO start (unknown), never a guessed date", w2.start === null && w2.startBasis === "unknown" && w2.days === null)
  const w3 = cdom.resolveComingSoonWindow({ agreementExecutedAt: "2026-10-02T03:30:00Z", listing: { mls_live_date_actual: "2026-10-22", go_live_confirmed_at: null, go_live_confirmed_source: "rentcast" } }, NOW)
  check("POSITIVE CONTROL: an actual date WITHOUT its feed evidence does not end the window", w3.open === true)
  {
    const lat = await import("../lib/listings/listing-agreement-terms")
    const read = async (row: Record<string, unknown>) => lat.governingListingAgreementTerms(memSupabase({ listing_agreements: [{ id: LA, listing_id: L, brokerage_id: B, created_at: "2026-09-20T00:00:00Z", ...row }] }) as any, { brokerageId: B, listingId: L })
    const both = await read({ esign_status: "fully_executed", seller_signed_at: "2026-10-01T17:00:00Z", agent_signed_at: "2026-10-02T16:00:00Z", fully_executed_at: "2026-10-05T12:00:00Z" })
    check("the ONE agreement reader dates execution at the LAST party's signature (Oct 2), not fully_executed_at (Oct 5 — after compliance)", both.ok && both.agreementExecutedAt === "2026-10-02T16:00:00Z", JSON.stringify(both.ok ? both.agreementExecutedAt : both))
    const onlyStamp = await read({ esign_status: "fully_executed", seller_signed_at: null, agent_signed_at: null, fully_executed_at: "2026-10-05T12:00:00Z" })
    check("…falls back to fully_executed_at when no signature timestamp is on the row", onlyStamp.ok && onlyStamp.agreementExecutedAt === "2026-10-05T12:00:00Z")
    const draft = await read({ esign_status: "sent", seller_signed_at: null, agent_signed_at: null, fully_executed_at: null })
    check("POSITIVE CONTROL: an agreement not yet all-signed has NO execution date (created_at is never used)", draft.ok && draft.agreementExecutedAt === null && draft.agreementId === null)
  }

  // ── C ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── C  the journey: executed → coming soon → (date passes: nothing flips) → feed verifies → Active → archived ──")
  {
    const mlv = await import("../lib/listings/mls-live-verification")
    const seedRows = (over: Record<string, unknown> = {}) => ({
      brokerages: [{ id: B, name: "Lane F Realty", timezone: "America/New_York" }],
      listings: [{ id: L, brokerage_id: B, agent_id: null, address: "12 Coming Soon Ct", city: "Tampa", state: "FL", zip: "33602", status: "coming_soon", lifecycle_stage: "COMING_SOON_ACTIVE", mls_number: "TB-147", go_live_date: "2026-10-20", go_live_confirmed_at: null, mls_live_date_actual: null, mls_live_timezone: "America/New_York", deleted_at: null, metadata: {}, listing_date: null, updated_at: "2026-10-02T00:00:00Z", ...over }],
      listing_agreements: [{ id: LA, listing_id: L, brokerage_id: B, esign_status: "fully_executed", seller_signed_at: "2026-10-01T17:00:00Z", agent_signed_at: "2026-10-02T16:00:00Z", fully_executed_at: "2026-10-05T12:00:00Z", created_at: "2026-09-20T00:00:00Z", seller_requested_mls_live_date: "2026-10-20" }],
      contract_term_versions: [], manager_signals: [], agent_action_ledger: [], notifications: [],
    })
    const svc = memSupabase(seedRows(), { unique: { agent_action_ledger: [["idempotency_key"]] } })
    const tx: string[] = []
    let gateAllowed = true
    const deps = {
      gate: async () => (gateAllowed ? { allowed: true, reason: "ok" } : { allowed: false, reason: "Listing activation refused (MLS feed verification): the seller's initials are missing on the listing agreement" }),
      transition: async (p: { listingId: string; fromState: string }, s: any) => {
        tx.push(p.fromState)
        const { error } = await s.from("listings").update({ status: lss.statusForStage("MLS_ACTIVE"), lifecycle_stage: "MLS_ACTIVE" }).eq("id", p.listingId).eq("brokerage_id", B).select("id")
        return { success: !error, error: error?.message }
      },
      now: NOW,
    }
    const notOnFeed = async () => ({ observations: [], consulted: ["rentcast" as const] })
    const onFeed = async (l: { address: string | null }) => ({ observations: [{ source: "rentcast" as const, mlsNumber: "TB-147", mlsName: "Stellar", address: String(l.address), status: "Active", listedDate: "2026-10-22" }], consulted: ["rentcast" as const] })
    const row = async () => ((await (svc as any).from("listings").select("*").eq("id", L).maybeSingle()).data) as Record<string, any>
    const signals = async (code?: string) => ((await (svc as any).from("manager_signals").select("*").eq("signal_type", "listing_lifecycle_finding")).data as any[]).filter((s) => !code || s.payload?.code === code)

    const r0 = await mlv.verifyAndRecordMlsLive(svc as any, { brokerageId: B, actorUserId: null }, L, { feeds: notOnFeed, now: NOW, lifecycle: deps })
    const after0 = await row()
    check("the planned day (Oct 20) has PASSED and the feed does not show it: the status stays coming_soon — a date never flips it", r0.ok && after0.status === "coming_soon" && tx.length === 0)
    check("…and the listing concierge is told once (planned_live_date_passed_unverified) — a Coming Soon listing is never belled 'not on the MLS yet'",
      (await signals("planned_live_date_passed_unverified")).length === 1 && ((await (svc as any).from("notifications").select("*")).data as any[]).length === 0)
    await mlv.verifyAndRecordMlsLive(svc as any, { brokerageId: B, actorUserId: null }, L, { feeds: notOnFeed, now: NOW, lifecycle: deps })
    check("a second check does NOT re-publish the same open finding", (await signals("planned_live_date_passed_unverified")).length === 1)

    const r1 = await mlv.verifyAndRecordMlsLive(svc as any, { brokerageId: B, actorUserId: null }, L, { feeds: onFeed, now: NOW, lifecycle: deps })
    const after1 = await row()
    check("THE EVENT: the feed confirms → the verified live day is recorded (Oct 22, the feed's list date)", r1.ok && r1.verification.verdict === "confirmed" && after1.mls_live_date_actual === "2026-10-22" && !!after1.go_live_confirmed_at)
    check("…→ through the activation gate → MLS_ACTIVE / status `active` — Active, not Coming Soon", r1.ok && r1.lifecycle?.ok === true && (r1.lifecycle as any).activated === true && after1.status === "active" && after1.lifecycle_stage === "MLS_ACTIVE" && tx.length === 1, JSON.stringify(r1.ok ? r1.lifecycle : r1))
    const ledger = ((await (svc as any).from("agent_action_ledger").select("*")).data as any[]).filter((x) => x.action === "listing.mls_activation.record")
    check("…ledgered: one listing.mls_activation.record row, system actor, executed", ledger.length === 1 && ledger[0].status === "executed" && ledger[0].actor_type === "system")
    check("…and the verified day differs from the agreed day (Oct 22 vs Oct 20) → told once", (await signals("verified_live_differs_from_agreed_date")).length === 1)
    const r2 = await mlv.verifyAndRecordMlsLive(svc as any, { brokerageId: B, actorUserId: null }, L, { feeds: onFeed, now: NOW, lifecycle: deps })
    check("re-checking does NOT activate twice (already active — no transition, no second ledger row)", r2.ok && r2.lifecycle?.ok === true && !(r2.lifecycle as any).activated && tx.length === 1 && ((await (svc as any).from("agent_action_ledger").select("*")).data as any[]).filter((x) => x.action === "listing.mls_activation.record").length === 1)

    // the refused gate
    const svc2 = memSupabase(seedRows({ go_live_date: "2026-11-30" }), { unique: { agent_action_ledger: [["idempotency_key"]] } })
    gateAllowed = false
    tx.length = 0
    const rr = await mlv.verifyAndRecordMlsLive(svc2 as any, { brokerageId: B, actorUserId: null }, L, { feeds: onFeed, now: NOW, lifecycle: deps })
    const row2 = ((await (svc2 as any).from("listings").select("*").eq("id", L).maybeSingle()).data) as Record<string, any>
    const refusedSignals = ((await (svc2 as any).from("manager_signals").select("*")).data as any[]).filter((s) => s.payload?.code === "live_on_mls_not_active")
    check("a REFUSED activation gate changes nothing: still coming_soon, no transition, no activation ledger row", rr.ok && row2.status === "coming_soon" && tx.length === 0 && ((await (svc2 as any).from("agent_action_ledger").select("*")).data as any[]).length === 0)
    check("…and the concierge is told the listing is live on the MLS but not Active, WITH the gate's reason (from data_steward)", refusedSignals.length === 1 && /initials are missing/.test(String(refusedSignals[0].message)) && refusedSignals[0].from_manager === "data_steward" && refusedSignals[0].to_manager === "listing_concierge", JSON.stringify(refusedSignals))
    gateAllowed = true

    // archived — internal yes, public no
    const svc3 = memSupabase(seedRows({ status: "sold", lifecycle_stage: "CLOSED" }))
    const { archiveListing } = await import("../lib/kernel/listing-archive")
    const arch = await archiveListing(svc3 as any, L, B)
    const archived = ((await (svc3 as any).from("listings").select("*").eq("id", L).maybeSingle()).data) as Record<string, any>
    check("archive (the survivor, lib/kernel/listing-archive.ts) keeps the row and its status (sold), stamps deleted_at", (arch as any).ok === true && !!archived.deleted_at && archived.status === "sold", JSON.stringify(arch).slice(0, 200))
    check("…an archived listing is NOT publicly visible", !lss.isListingPubliclyVisible(archived as any))
    const publicRead = await (svc3 as any).from("listings").select("id").eq("id", L).in("status", lss.publiclyVisibleListingStatuses()).is("deleted_at", null).maybeSingle()
    const internalRead = await (svc3 as any).from("listings").select("id, deleted_at").eq("id", L).eq("brokerage_id", B).maybeSingle()
    check("…the public read shape returns nothing; the internal by-id read still returns the record (history)", !publicRead.data && !!internalRead.data?.deleted_at)
    const archivedCheck = await mlv.verifyAndRecordMlsLive(svc3 as any, { brokerageId: B, actorUserId: null }, L, { feeds: onFeed, now: NOW, lifecycle: deps })
    check("…and an archived listing raises no lifecycle finding (a record, not a working listing)", archivedCheck.ok && archivedCheck.lifecycle?.ok === true && (archivedCheck.lifecycle as any).findings.length === 0, JSON.stringify(archivedCheck.ok ? archivedCheck.lifecycle : archivedCheck))
  }
  {
    const f = lss.listingLifecycleFindings
    const win = (o: Partial<ReturnType<typeof cdom.resolveComingSoonWindow>>) => ({ start: "2026-10-01", startBasis: "agreement_executed" as const, plannedLive: null, verifiedLive: null, open: true, days: 30, timezone: null, ...o })
    check("findings: Coming Soon with no execution date → coming_soon_without_executed_agreement; an UNREADABLE agreement accuses nothing",
      f({ status: "coming_soon", window: win({ start: null, startBasis: "unknown", days: null }), agreementKnown: true, agreedMlsLiveDate: null, today: "2026-10-31" }).some((x) => x.code === "coming_soon_without_executed_agreement")
      && f({ status: "coming_soon", window: win({ start: null, startBasis: "unknown", days: null }), agreementKnown: false, agreedMlsLiveDate: null, today: "2026-10-31" }).length === 0)
    check("findings: past the MLS's attested limit counted from the execution day → coming_soon_beyond_mls_limit (30 > 21); within it → none",
      f({ status: "coming_soon", window: win({}), agreementKnown: true, agreedMlsLiveDate: null, mlsMaxComingSoonDays: 21, today: "2026-10-31" }).some((x) => x.code === "coming_soon_beyond_mls_limit")
      && !f({ status: "coming_soon", window: win({ days: 10 }), agreementKnown: true, agreedMlsLiveDate: null, mlsMaxComingSoonDays: 21, today: "2026-10-31" }).some((x) => x.code === "coming_soon_beyond_mls_limit"))
  }

  // ── D ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── D  the manual door cannot write a gated status; it runs under the ledger; the picker disables them ──")
  {
    const act = code("app/actions/listings-kernel.ts")
    const body = act.slice(act.indexOf("export async function updateListingStatus("), act.indexOf("export async function sendListingAgreementForSignatureAction("))
    const refuseAt = body.search(/if \(!isManuallySettableListingStatus\(status\)\)/)
    const writeAt = body.search(/\.update\(\{\s*status,/)
    const refusesFirst = (b: string) => { const r = b.search(/if \(!isManuallySettableListingStatus\(status\)\)/), w = b.search(/\.update\(\{\s*status,/); return r >= 0 && w > r }
    check("updateListingStatus refuses a gated status BEFORE it writes", refuseAt >= 0 && writeAt > refuseAt && refusesFirst(body))
    check("POSITIVE CONTROL: a door that writes first is caught", !refusesFirst(`export async function updateListingStatus() { await s.from("listings").update({ status, x }) }`))
    check("…and the write runs inside withActionLedger as listing.status.set (keyed on the row version it read)", /withActionLedger<[^>]+>\(\s*\{[\s\S]{0,400}action:\s*"listing\.status\.set"/.test(body) && /idempotencyKey:\s*`listing_status:\$\{listingId\}:\$\{String\(listingRow\.updated_at/.test(body))
    const picker = code("app/components/dashboard/listings/listing-status-select.tsx")
    check("the board's picker disables the gated statuses (derived from the same predicate) and shows the server's reason", /gated:\s*!isManuallySettableListingStatus\(value\)/.test(picker) && /disabled=\{opt\.gated/.test(picker) && /toast\.error\(result\.error/.test(picker))
  }

  // ── E ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── E  every PUBLIC reader excludes archived and stays inside the public status set ──")
  {
    const { classifyProxyPath } = await import("../app/constants/auth")
    const walk = (d: string, out: string[] = []): string[] => { for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) { const r = join(d, e.name); if (e.isDirectory()) walk(r, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(r) } return out }
    const routeFiles = walk("app").filter((f) => !f.startsWith("app/actions/") && (/\/(page|route)\.tsx?$/.test(f) || /^app\/(sitemap|robots)\.ts$/.test(f)))
    const urlOf = (f: string) => ("/" + f.replace(/^app\//, "").replace(/\/?(page|route)\.tsx?$/, "").replace(/\.ts$/, "").replace(/\([^)]*\)\/?/g, "")).replace(/\[\.\.\.[^\]]+\]/g, "x").replace(/\[[^\]]+\]/g, "00000000-0000-4000-8000-000000000000").replace(/\/$/, "") || "/"
    // PUBLIC SURFACE = what an anonymous visitor reaches: the proxy's PUBLIC class, plus every OPEN page (a page that
    // authorises itself is a storefront — /site, /team, /p). An OPEN /api route is a cron / webhook / internal door, not a page.
    const publicFiles = routeFiles.filter((f) => { const u = urlOf(f), c = classifyProxyPath(u); return c === "public" || (c === "open" && !u.startsWith("/api/")) })
    // …plus the server actions those pages import (one level), function by function.
    const actionFns = new Map<string, Set<string>>()
    for (const f of publicFiles) {
      for (const m of code(f).matchAll(/import\s*\{([^}]+)\}\s*from\s*["']@\/app\/actions\/([^"']+)["']/g)) {
        const file = `app/actions/${m[2]}.ts`
        if (!raw(file)) continue
        const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)
        if (!actionFns.has(file)) actionFns.set(file, new Set())
        for (const n of names) actionFns.get(file)!.add(n)
      }
    }
    const PUB = new Set<string>(lss.PUBLICLY_VISIBLE_LISTING_STATUSES)
    const SHARED = /publiclyVisibleListingStatuses\(\)|PUBLIC_LISTING_STATUSES|PUBLICLY_MARKETED_STATUSES|PUBLICLY_VISIBLE_LISTING_STATUSES/
    /** Every `.from("listings")` READ statement in `text`: [conforms, statement]. */
    const readsIn = (text: string): Array<{ ok: boolean; stmt: string; why: string }> => {
      const c = blankComments(text), m = blankStrings(c)
      const out: Array<{ ok: boolean; stmt: string; why: string }> = []
      for (const hit of c.matchAll(/\.from\(\s*["'`]listings["'`]\s*\)/g)) {
        const at = hit.index ?? 0
        if (!/\.from\(/.test(m.slice(at, at + 7))) continue
        const next = m.indexOf(".from(", at + 6)
        const stmt = c.slice(at, Math.min(next === -1 ? c.length : next, at + 700))
        if (/\.(insert|upsert|update|delete)\s*\(/.test(m.slice(at, at + stmt.length))) continue
        const archived = /\.is\(\s*["']deleted_at["']\s*,\s*null\s*\)/.test(stmt)
        const eqs = [...stmt.matchAll(/\.eq\(\s*["']status["']\s*,\s*["']([a-z_]+)["']\s*\)/g)].map((x) => x[1])
        const inLit = [...stmt.matchAll(/\.in\(\s*["']status["']\s*,\s*\[([^\]]*)\]/g)].flatMap((x) => [...x[1].matchAll(/["']([a-z_]+)["']/g)].map((y) => y[1]))
        const shared = /\.in\(\s*["']status["']\s*,/.test(stmt) && SHARED.test(stmt)
        const statusOk = [...eqs, ...inLit].every((s) => PUB.has(s))
        const why = !archived ? "no deleted_at IS NULL filter" : !statusOk ? `status outside the public set (${[...eqs, ...inLit].filter((s) => !PUB.has(s)).join(", ")})` : ""
        out.push({ ok: archived && statusOk, stmt: stmt.replace(/\s+/g, " ").slice(0, 160), why: why || (shared ? "shared predicate" : eqs.length || inLit.length ? "narrowed" : "by id / unfiltered status") })
      }
      return out
    }
    check("POSITIVE CONTROL (reader finder): no archive filter → caught; a non-public status → caught; the shared predicate + archive → ok; a tombstone is not a reader",
      (() => {
        const r = readsIn(`// svc.from("listings").select("id").eq("status", "draft")\nawait svc.from("listings").select("id").eq("status", "active")\nawait svc.from("listings").select("id").in("status", ["active", "withdrawn"]).is("deleted_at", null)\nawait svc.from("listings").select("id").in("status", publiclyVisibleListingStatuses()).is("deleted_at", null)\nconst S = \`svc.from("listings").select("x")\``)
        return r.length === 3 && !r[0].ok && /deleted_at/.test(r[0].why) && !r[1].ok && /withdrawn/.test(r[1].why) && r[2].ok
      })())
    // ALLOW — public-surface reads that print nothing about the listing or are not anonymous, each with WHY.
    const ALLOW: Record<string, string> = {
      "app/api/showings/feedback/[token]/route.ts": "token-gated feedback for a showing that happened — the buyer agent's link, not anonymous browsing; it must keep working after the listing closes",
      "app/actions/listing-landing.ts::logLandingSession": "attribution read: stamps brokerage_id on the visit row; prints nothing about the listing",
      "app/actions/listing-landing.ts::getNeighborhoodData": "address-only read behind the landing page, which itself resolves through getListingBySlug (active, not archived)",
      "app/actions/listing-landing.ts::getLandingSourceBreakdown": "agent analytics (tenant-checked), not an anonymous surface",
      "app/actions/listing-landing.ts::trackCtaClick": "attribution write path; prints nothing",
    }
    const bad: string[] = []
    let readers = 0
    const judged: string[] = []
    for (const f of publicFiles) {
      const rs = readsIn(raw(f))
      if (!rs.length) continue
      judged.push(f)
      for (const r of rs) { readers++; if (!r.ok && !ALLOW[f]) bad.push(`${f}: ${r.why} — ${r.stmt}`) }
    }
    for (const [file, names] of actionFns) {
      const src = raw(file)
      for (const n of names) {
        const at = src.search(new RegExp(`export\\s+async\\s+function\\s+${n}\\s*\\(`))
        if (at < 0) continue
        const nextAt = src.slice(at + 10).search(/\nexport\s+(async\s+)?function\s/)
        const body = src.slice(at, nextAt < 0 ? undefined : at + 10 + nextAt)
        const rs = readsIn(body)
        if (!rs.length) continue
        judged.push(`${file}::${n}`)
        for (const r of rs) { readers++; if (!r.ok && !ALLOW[`${file}::${n}`]) bad.push(`${file}::${n}: ${r.why} — ${r.stmt}`) }
      }
    }
    console.log(`  · ${publicFiles.length} public route/page file(s) (proxy PUBLIC + OPEN pages) + ${[...actionFns.values()].reduce((n, s) => n + s.size, 0)} imported server-action name(s); ${judged.length} of them read listings (${readers} read statements); ${Object.keys(ALLOW).length} allow-listed with a reason`)
    for (const j of judged) console.log(`      judged: ${j}${ALLOW[j] ? ` (ALLOW: ${ALLOW[j]})` : ""}`)
    check(`every public listing read excludes ARCHIVED and stays inside the public status set (${bad.length ? bad.join(" | ") : "0 offenders"})`, bad.length === 0)
    check("the public listing page derives its set from the shared predicate (no local literal list) and pairs it with the archive filter on BOTH reads",
      /const PUBLIC_LISTING_STATUSES = publiclyVisibleListingStatuses\(\)/.test(code("app/listings/[listingId]/page.tsx")) && (code("app/listings/[listingId]/page.tsx").match(/\.in\("status",\s*PUBLIC_LISTING_STATUSES\)\s*\.is\("deleted_at",\s*null\)/g) ?? []).length === 2)
    check("the idx-search public property page reads the SAME set (the §6 merge — no second spelling)", /const PUBLICLY_MARKETED_STATUSES = PUBLICLY_VISIBLE_LISTING_STATUSES/.test(code("app/actions/idx-search.ts")))
    check("POSITIVE CONTROL: a literal public list in a page would be a second spelling the finder sees", /const PUBLIC_LISTING_STATUSES = \[/.test(`const PUBLIC_LISTING_STATUSES = ["active", "pending"]`) && !/const PUBLIC_LISTING_STATUSES = \[/.test(code("app/listings/[listingId]/page.tsx")))
  }

  // ── F ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── F  internal readers keep history; the authorized page says ARCHIVED ──")
  {
    const page = code("app/dashboard/listings/[id]/lifecycle/page.tsx")
    const q = page.slice(page.indexOf('.from("listings")'), page.indexOf('.from("listings")') + 900)
    check("the authorized lifecycle page reads deleted_at by id and does NOT hide archived rows (the retention surface)", /deleted_at"\)/.test(q) && !/\.is\("deleted_at",\s*null\)/.test(q.slice(0, q.indexOf("if ((userRow.user_type"))))
    check("…and labels an archived record ARCHIVED", /ARCHIVED/.test(page) && /deleted_at && \(/.test(page))
    check("…and shows the Coming Soon window from the execution day (the panel reads resolveComingSoonWindow)", /resolveComingSoonWindow\(\{\s*agreementExecutedAt:/.test(page) && /comingSoonWindow=\{/.test(page) && /the day the agreement was executed/.test(code("app/dashboard/listings/[id]/lifecycle/listing-agreement-terms-panel.tsx")))
  }

  // ── G ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── G  the concierge hears it ──")
  {
    const { SIGNAL_REGISTRY } = await import("../lib/kernel/signal-registry")
    const { classifyCoordination } = await import("../lib/kernel/coordination-kind")
    const mlv = await import("../lib/listings/mls-live-verification")
    const spec = SIGNAL_REGISTRY[mlv.LISTING_LIFECYCLE_FINDING_SIGNAL]
    check("listing_lifecycle_finding is registered for listing_concierge, feed-only, and its kind is the live classifier's", !!spec && spec.consumers.includes("listing_concierge") && spec.disposition === "feed_only" && spec.kind === classifyCoordination(mlv.LISTING_LIFECYCLE_FINDING_SIGNAL))
  }

  // ── H ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── H  the MLS Coming Soon limit counts from the EXECUTION day at the COMING_SOON_ACTIVE door ──")
  {
    const rc = await import("../lib/listing-lifecycle/readiness-checker")
    const evalChecks = (rc as any).evaluateReadinessChecks as (s: any, id: string, checks: string[], deps?: any) => Promise<{ results: any[] }>
    const policy = { coming_soon_policy: { mls: { example_coast_mls: { mls_slug: "example_coast_mls", mls_name: "Example Coast MLS", state_codes: ["FL"], permitted: true, max_days: 21, showings_permitted: true, mls_submission_within_business_days: null, source: { url: "https://rules.example-coast-mls.test/cs", rule_ref: "Sec. 1.3 (fixture)", title: null, verified_on: "2026-10-27" }, attestation: { user_id: "u", user_type: "compliance_officer", at: "2026-10-27T00:00:00Z" }, updated_at: "2026-10-27T00:00:00Z" } } } }
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
    const mem = (agreement: Record<string, unknown> | null) => memSupabase({
      listings: [{ id: L, brokerage_id: B, state: "FL", lifecycle_stage: "COMING_SOON_PREP", stage_entered_at: null, mls_live_timezone: null }],
      showings: [],
      brokerage_settings: [{ id: "s", brokerage_id: B, settings: policy }],
      listing_agreements: agreement ? [{ id: LA, listing_id: L, brokerage_id: B, created_at: daysAgo(40), ...agreement }] : [],
      contract_term_versions: [],
    }) as any
    if (typeof evalChecks !== "function") check("evaluateReadinessChecks is exported by the readiness checker", false)
    else {
      const run = async (agreement: Record<string, unknown> | null) => { const db = mem(agreement); return (await evalChecks(db, L, ["coming_soon_policy"], { comingSoonPolicyClient: db })).results[0] }
      const old = await run({ esign_status: "fully_executed", seller_signed_at: daysAgo(30), agent_signed_at: daysAgo(30), fully_executed_at: daysAgo(29) })
      const fresh = await run({ esign_status: "fully_executed", seller_signed_at: daysAgo(5), agent_signed_at: daysAgo(5), fully_executed_at: daysAgo(4) })
      const none = await run(null)
      check("executed 30 days ago against a 21-day MLS limit → REFUSED at the door, counted from the EXECUTION day", old?.passed === false && old?.details?.daysInComingSoonBasis === "agreement_executed" && Number(old?.details?.daysInComingSoon) >= 29, JSON.stringify(old?.details))
      check("POSITIVE CONTROL: executed 5 days ago → passes", fresh?.passed === true && fresh?.details?.daysInComingSoonBasis === "agreement_executed", JSON.stringify(fresh))
      check("no executed agreement on file → the stage-entry count, and the basis SAYS so", none?.details?.daysInComingSoonBasis === "stage_entered", JSON.stringify(none?.details))
    }
  }

  console.log("\n[blind spots]")
  console.log("  · in-memory only: no RLS, CHECK, trigger or FK runs; the activation gate and the kernel transition are injected in C (their own proofs: test:listing-activation-gate, test:listing-status-two-senses)")
  console.log("  · the public-reader census follows a public page's imports ONE level into app/actions; a reader that builds its query in lib/ is judged by its own proof (lib/buyer-search, lib/property-alerts, lib/voice/reception-inventory filter deleted_at — read, not enforced here)")
  console.log("  · a query assembled across variables (let q = …; q = q.eq(…)) is judged on the statement text only")
  console.log("  · Coming Soon is IN the public set; whether a given MLS permits public Coming Soon marketing is lib/compliance/coming-soon-policy.ts's decision (an attested rule per MLS), not this predicate's")
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  for (const f of failures) console.log(`   ✗ ${f}`)
  process.exit(failed > 0 ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
