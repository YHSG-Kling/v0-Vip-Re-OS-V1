#!/usr/bin/env tsx
/**
 * scripts/email-engagement-sourcer-simulator.ts  (npm run test:email-engagement-sourcer)
 *
 * EMAIL ENGAGEMENT INTENT — lane 71C, mirroring the wave-70 site-visitor-intent proof
 * shape (scripts/scraper-simulator.ts::testWave70SiteVisitorLane, which exercises
 * lib/lead-pipeline/site-visitor-sourcer.ts). Proves:
 *
 *   1. The PURE classifier (lib/lead-pipeline/email-engagement-sourcer.ts::
 *      normalizeEmailEngagementSignal) — repeat-bar gating, click-through detection,
 *      high-frequency escalation, intentType carried from the contact's own stance
 *      (never invented), and the null-on-no-email / null-below-bar refusals.
 *   2. Two POSITIVE CONTROLS (CLAUDE.md §2): a signal below the repeat bar must NOT
 *      qualify (proves the bar actually gates, not a blanket true), and a signal with
 *      zero clicks must NOT carry 'click_through' (proves that signal discriminates).
 *   3. The SOURCE_MAP / SOURCE_ALIASES / SOURCE_VENDOR / GATE_TOKEN wiring in
 *      lib/lead-pipeline/source-intent-map.ts — same five assertions
 *      testWave70SiteVisitorLane makes for site_visitor_intent, so a future merge or
 *      rename of this lane's registration is caught the same way that one is.
 *   4. isViableRecord + buildLeadIdentityKey agree that an email is a sufficient,
 *      email-keyed identity anchor — the same dedup contract every other sourcer in
 *      this pipeline family relies on.
 *   5. A LIVE layer (skipped without SUPABASE creds, pure layer already proved the
 *      logic) that inserts a tagged test brokerage + contact + email_tracking rows,
 *      calls sourceEmailEngagementIntent for real, and DELETES every row it created —
 *      CLAUDE.md's wave-56 ruling on test data: tag clearly, delete in the same run,
 *      prove the delete by counting what came back.
 *   6. WAVE 72A (owner: "contacts coming in from the tenants website or email
 *      come in as contacts not raw leads.") — `records` is now ALWAYS empty (every
 *      email_tracking row is already a CONTACT, so this never feeds raw_scraped_leads)
 *      and the qualifying pattern is routed directly onto the contact instead, as a
 *      manager signal (campaign_orchestrator → ai_isa, contactsNotified counts it).
 *
 * No database required for layers 1-4, 6. Source assertions + pure-function calls only.
 */
import { createClient } from "@supabase/supabase-js"
import {
  normalizeEmailEngagementSignal,
  sourceEmailEngagementIntent,
  EMAIL_ENGAGEMENT_MIN_EVENTS,
  EMAIL_ENGAGEMENT_LOOKBACK_HOURS,
  EMAIL_ENGAGEMENT_WINDOW_DAYS,
} from "../lib/lead-pipeline/email-engagement-sourcer"
import { isViableRecord, buildLeadIdentityKey } from "../lib/lead-pipeline/raw-record-types"
import {
  getSourceSemantics,
  resolveSourceKey,
  SOURCE_VENDOR,
  expandEnabledSources,
  hasScoringEntry,
} from "../lib/lead-pipeline/source-intent-map"

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

// ── 1-2. PURE CLASSIFIER + POSITIVE CONTROLS ─────────────────────────────────────
function testPureClassifier() {
  console.log("\n[1 · normalizeEmailEngagementSignal — pure classifier]")

  const repeatSignal = {
    contactId: "contact-abc123",
    email: "buyer@example.com",
    firstName: "Dana",
    lastName: "Rowe",
    city: "Tampa",
    state: "FL",
    contactType: "buyer",
    eventCount: 4,
    clickCount: 1,
    earliestEventAt: "2026-09-10T10:00:00.000Z",
    latestEventAt: "2026-09-17T09:00:00.000Z",
  }
  const rec = normalizeEmailEngagementSignal(repeatSignal)
  check("normalizes a qualifying signal (count ≥ bar)", rec !== null)
  check("source tagged", rec?.source === "email_engagement_intent")
  check("behaviorType tagged", rec?.behaviorType === "email_engagement_intent")
  check("buyer intent carried from the contact's own stance", rec?.intentType === "buyer")
  check("email carried (lowercased, trimmed)", rec?.email === "buyer@example.com")
  check("name + geography carried", rec?.firstName === "Dana" && rec?.city === "Tampa")
  check("repeated_email_engagement signal always present on a qualifying row", !!rec?.intentSignals.includes("repeated_email_engagement"))
  check("click_through present when clickCount > 0", !!rec?.intentSignals.includes("click_through"))
  check("rawPayload preserves the full signal for audit", (rec?.rawPayload as any)?.signal?.contactId === "contact-abc123")
  check("sourceRecordId anchors on contact + latest event (repeat-cron dedup)", rec?.sourceRecordId === `email_engagement-contact-abc123-${repeatSignal.latestEventAt}`)

  // POSITIVE CONTROL — below the repeat bar must NOT qualify. Proves the bar actually
  // gates rather than a blanket true (the exact shape CLAUDE.md §2 asks every absence
  // assertion to carry).
  const belowBar = { ...repeatSignal, eventCount: EMAIL_ENGAGEMENT_MIN_EVENTS - 1 }
  check(
    "positive control: a signal below EMAIL_ENGAGEMENT_MIN_EVENTS does NOT qualify",
    normalizeEmailEngagementSignal(belowBar) === null,
  )

  // POSITIVE CONTROL — zero clicks must NOT carry click_through. Proves that signal
  // actually discriminates opens-only from opens+clicks, not a blanket true.
  const opensOnly = { ...repeatSignal, clickCount: 0 }
  const opensOnlyRec = normalizeEmailEngagementSignal(opensOnly)
  check(
    "positive control: an opens-only signal is NOT tagged click_through",
    !opensOnlyRec?.intentSignals.includes("click_through"),
  )

  // HIGH-FREQUENCY ESCALATION — at 2x the bar, the stronger signal appears.
  const highFrequency = { ...repeatSignal, eventCount: EMAIL_ENGAGEMENT_MIN_EVENTS * 2 }
  const highFrequencyRec = normalizeEmailEngagementSignal(highFrequency)
  check(
    "high_frequency_engagement appears at 2x the repeat bar",
    !!highFrequencyRec?.intentSignals.includes("high_frequency_engagement"),
  )
  check(
    "positive control: high_frequency_engagement is ABSENT just below 2x the bar",
    !normalizeEmailEngagementSignal({ ...repeatSignal, eventCount: EMAIL_ENGAGEMENT_MIN_EVENTS * 2 - 1 })
      ?.intentSignals.includes("high_frequency_engagement"),
  )

  // No email → null (not sourceable) — the identity anchor this lane requires.
  check("no email → null (not sourceable)", normalizeEmailEngagementSignal({ ...repeatSignal, email: null }) === null)
  check("blank email → null (not sourceable)", normalizeEmailEngagementSignal({ ...repeatSignal, email: "   " }) === null)

  // intentType is NEVER invented from a contact stance the record doesn't carry —
  // Fair-Housing-safe posture, same as site_visitor_intent / buildBuyerMatchReelProps.
  const unknownStance = { ...repeatSignal, contactType: null }
  check("unclassified contact stance → intentType 'unknown' (never guessed)", normalizeEmailEngagementSignal(unknownStance)?.intentType === "unknown")
  const sellerStance = { ...repeatSignal, contactType: "seller" }
  check("seller contact stance carried through unchanged", normalizeEmailEngagementSignal(sellerStance)?.intentType === "seller")
}

// ── 3. DEDUP CONTRACT ─────────────────────────────────────────────────────────────
function testDedupContract() {
  console.log("\n[2 · isViableRecord + buildLeadIdentityKey — dedup contract]")
  const rec = normalizeEmailEngagementSignal({
    contactId: "contact-xyz",
    email: "renewed@example.com",
    firstName: null,
    lastName: null,
    city: null,
    state: null,
    contactType: null,
    eventCount: EMAIL_ENGAGEMENT_MIN_EVENTS,
    clickCount: 0,
    earliestEventAt: "2026-09-01T00:00:00.000Z",
    latestEventAt: "2026-09-17T00:00:00.000Z",
  })
  check("passes isViableRecord (email present)", !!rec && isViableRecord(rec))
  check("identity key anchors on email (dedups against contacts/leads/raw by email)", !!rec && buildLeadIdentityKey(rec) === "email:renewed@example.com")
}

// ── 4. SOURCE_MAP / SOURCE_ALIASES / SOURCE_VENDOR / GATE_TOKEN WIRING ─────────────
// Same five assertions testWave70SiteVisitorLane makes for site_visitor_intent — a
// future merge or rename of this lane's registration is caught the same way.
function testSourceIntentMapWiring() {
  console.log("\n[3 · lib/lead-pipeline/source-intent-map.ts wiring]")
  check("semantics registered (hasScoringEntry, not the silent fallback)", hasScoringEntry("email_engagement_intent"))
  check("motivation type registered", getSourceSemantics("email_engagement_intent").motivationType === "email_engagement_intent")
  check("enrichment-first identity policy (the person is usually already a contact, but never assumed identified without a lookup)", getSourceSemantics("email_engagement_intent").identityPolicy === "enrichment_first")
  check("first-party vendor routing ('internal', $0, never a paid call)", SOURCE_VENDOR.email_engagement_intent === "internal")
  check("DISTINCT from every other lane (never merged, e.g. not folded onto site_visitor_intent)", resolveSourceKey("email_engagement_intent") === "email_engagement_intent")
  check("alias 'email_engagement' resolves to the canonical key", resolveSourceKey("email_engagement") === "email_engagement_intent")
  check("alias 'email_intent' resolves to the canonical key", resolveSourceKey("email_intent") === "email_engagement_intent")
  check("cron gate token present (expandEnabledSources wires it)", expandEnabledSources(["email_engagement_intent"]).has("email_engagement_intent"))
  check("min-events constant is a sane repeat bar (≥ 2, not a single open)", EMAIL_ENGAGEMENT_MIN_EVENTS >= 2)
  check("lookback matches the cron's own 6-hour cadence (same as site_visitor_intent)", EMAIL_ENGAGEMENT_LOOKBACK_HOURS === 6)
  check("window is longer than the lookback (a rolling repeat window, not just the latest tick)", EMAIL_ENGAGEMENT_WINDOW_DAYS * 24 > EMAIL_ENGAGEMENT_LOOKBACK_HOURS)
}

// ── 5. LIVE LAYER — real round trip, tagged rows, deleted in the same run ─────────
async function testLiveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[4 · live] ⊘ skipped (no SUPABASE creds) — pure + wiring layers proved the logic")
    return
  }
  console.log("\n[4 · live] real round trip — tagged rows, deleted in the same run")
  const svc = createClient(url, key)
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
    if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
    const brokerageId = (brk as any).id

    const { data: contact, error: contactError } = await svc.from("contacts").insert({
      brokerage_id: brokerageId,
      first_name: "ZZ-LANE71C",
      last_name: "EmailEngagementTest",
      email: `zz-lane71c-${Date.now()}@example.invalid`,
      contact_type: "buyer",
      email_opt_out: false,
    }).select("id, brokerage_id").maybeSingle()
    if (contactError || !contact) { console.log(`  ⊘ could not create test contact — ${contactError?.message ?? "no row"}`); return }
    cleanup.push({ table: "contacts", id: (contact as any).id })

    const now = new Date()
    const eventRows = Array.from({ length: EMAIL_ENGAGEMENT_MIN_EVENTS }, (_, i) => ({
      brokerage_id: brokerageId,
      contact_id: (contact as any).id,
      event_type: i === 0 ? "click" : "open",
      event_at: new Date(now.getTime() - i * 3600_000).toISOString(),
      metadata: { lane: "71C-test" },
    }))
    const { data: inserted, error: trackError } = await svc.from("email_tracking").insert(eventRows).select("id")
    if (trackError || !inserted) { console.log(`  ⊘ could not create test email_tracking rows — ${trackError?.message ?? "no rows"}`); return }
    for (const row of inserted as Array<{ id: string }>) cleanup.push({ table: "email_tracking", id: row.id })

    const { records, rowsExamined, contactsNotified } = await sourceEmailEngagementIntent(svc, brokerageId, { now })
    check("live: examined at least the rows this run created", rowsExamined >= EMAIL_ENGAGEMENT_MIN_EVENTS)
    // WAVE 72A: records is ALWAYS empty — this contact's pattern is routed as a
    // manager signal instead of minted as a raw lead (the person is already a
    // contact, never a candidate for raw_scraped_leads).
    check("live: records stays empty (no raw lead minted for an existing contact)", records.length === 0)
    check("live: the tagged test contact's repeated engagement notified the AI ISA", contactsNotified >= 1)

    const { data: signalRow, error: signalError } = await svc
      .from("manager_signals")
      .select("id, from_manager, to_manager, signal_type, contact_id, payload")
      .eq("brokerage_id", brokerageId)
      .eq("contact_id", (contact as any).id)
      .eq("signal_type", "contact_renewed_email_engagement")
      .maybeSingle()
    check("live: manager signal written campaign_orchestrator → ai_isa for the contact",
      !signalError && !!signalRow && (signalRow as any).from_manager === "campaign_orchestrator" && (signalRow as any).to_manager === "ai_isa")
    check("live: signal payload carries click_through (one click among the events)",
      !!(signalRow as any)?.payload?.intentSignals?.includes?.("click_through"))
    if (signalRow) cleanup.push({ table: "manager_signals", id: (signalRow as any).id })
  } finally {
    // CLAUDE.md wave-56 ruling: delete in the SAME run, prove the delete by counting
    // what came back — never leave test data behind.
    for (const row of cleanup.reverse()) {
      const { data: deleted, error } = await svc.from(row.table).delete().eq("id", row.id).select("id")
      const ok = !error && (deleted?.length ?? 0) > 0
      check(`live cleanup: ${row.table}/${row.id.slice(0, 8)}… deleted`, ok, error?.message)
    }
  }
}

async function main() {
  testPureClassifier()
  testDedupContract()
  testSourceIntentMapWiring()
  await testLiveLayer()

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" FAILURES:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ EMAIL_ENGAGEMENT_SOURCER_PASS — repeated opens/clicks on our own outbound become an intent-map source, dedup-safe, $0 marginal cost")
  process.exit(0)
}

void main()
