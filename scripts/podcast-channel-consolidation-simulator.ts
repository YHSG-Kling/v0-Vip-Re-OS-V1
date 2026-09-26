#!/usr/bin/env tsx
/**
 * scripts/podcast-channel-consolidation-simulator.ts  (npm run test:podcast-channel-consolidation)
 * ─────────────────────────────────────────────────────────────────────────────
 * CHANNEL SETUP LIVES IN SETTINGS, THE STUDIO SYNDICATES (owner: "podcast is a
 * full ai podcast studio that is syndicated to the channels that are setup on
 * the main settings" + "setup channels … these settings are on the main
 * integration"). The Podcast Studio's Setup → Distribution Channels tab had a
 * FULL editor (toggle/configure/seed) over podcast_distribution_channels — a
 * true duplicate of the /dashboard/settings/podcast-channels editor (same table,
 * same createDistributionChannel/updateDistributionChannel actions, same fields).
 * Resolution: the studio tab is now READ-ONLY syndication status that links to
 * Settings; Settings is the SOLE editor. Also: the Omnipresence repurpose source
 * list now includes PUBLISHED episodes (not just completed), so an episode sent
 * via "Send to Omnipresence" actually shows up.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the Podcast Studio channel tab is READ-ONLY and routes editing to Settings ──")
{
  const tab = src("app/dashboard/marketing/podcast/components/distribution-channels-tab.tsx")
  check("it no longer imports the channel-mutating actions",
    !tab.includes("updateDistributionChannel") && !tab.includes("createDistributionChannel"))
  check("it has no edit dialog / configure / seed affordance",
    !tab.includes("Dialog") && !/Configure<\/Button>/.test(tab) && !tab.includes("handleSeedChannels"))
  check("it links to the Settings channels editor as the single home",
    tab.includes("/dashboard/settings/podcast-channels") && tab.includes("Manage Channels"))
  check("it still shows syndication status (enabled/disabled per channel)",
    tab.includes("Syndicating") && tab.includes("is_enabled"))
}

console.log("\n── the Settings page is the SOLE channel editor (the kept superset) ──")
{
  const client = src("app/dashboard/settings/podcast-channels/podcast-channels-client.tsx")
  check("Settings still imports the channel-mutating actions (it edits)",
    client.includes("updateDistributionChannel") && client.includes("createDistributionChannel"))
  check("Settings keeps the brokerage/personal hierarchy awareness", client.includes("agent_user_id"))
}

console.log("\n── the repurpose source list includes PUBLISHED podcast episodes ──")
{
  const page = src("app/dashboard/campaigns/repurpose/page.tsx")
  check("podcast_episodes are pulled by status IN (completed, published)",
    /podcast_episodes[\s\S]*?\.in\("status",\s*\[\s*"completed",\s*"published"\s*\]\)/.test(page))
}

console.log("\n── the 'Send to Omnipresence' deep-link is honored (no more dead-end) ──")
{
  const page = src("app/dashboard/campaigns/repurpose/page.tsx")
  check("the page parses ?source / ?episodeId and passes them to the client",
    page.includes("SOURCE_TOKEN_TO_TYPE") && page.includes("initialSourceType") && page.includes("initialSourceId"))

  const client = src("app/dashboard/campaigns/repurpose/repurpose-dashboard-client.tsx")
  check("the client preselects on the deep-link (Execute tab + matching pipeline/source)",
    client.includes("initialSourceType") &&
    /setActiveTab\("execute"\)/.test(client) &&
    client.includes("setSelectedPipeline") && client.includes("setSelectedSource"))
  check("with no pipeline yet it pre-seeds pipeline creation with the source type",
    /setNewPipeline\(\(prev\)\s*=>\s*\(\{\s*\.\.\.prev,\s*sourceType: type/.test(client))
}

console.log("\n── a FAILED weekly auto-run releases its week's slot (m588) ──")
{
  // THE DEFECT THIS PINS. The auto-producer's insert into podcast_auto_runs is
  // its idempotency ledger, read back as a 23505. Until m588 the unique behind
  // it was PLAIN on (brokerage_id, iso_week), so one status='failed' row
  // blocked that brokerage's episode for the rest of the ISO week and every
  // retry was told "already_run" — a failure masquerading as idempotency.
  // The retry semantics live in the INDEX, so the assertion reads the LATEST
  // definition of uq_podcast_auto_runs_brokerage_week across the migration
  // ledger (not a pinned filename — §2, a later migration must be able to
  // supersede m588 by redefining it, and this check will judge the newest).
  const dir = join(process.cwd(), "supabase/migrations")
  const defs: Array<{ file: string; def: string }> = []
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".sql")) continue
    const body = readFileSync(join(dir, f), "utf8")
    // strip SQL comments so a header QUOTING the old plain shape (m588's does)
    // cannot be mistaken for a definition — a tombstone is not a call site (§2)
    const code = body.replace(/--[^\n]*/g, "")
    const m = code.match(/CREATE\s+UNIQUE\s+INDEX\s+uq_podcast_auto_runs_brokerage_week[\s\S]*?;/gi)
    if (m) defs.push({ file: f, def: m[m.length - 1] })
  }
  const latest = defs[defs.length - 1]
  check("some migration defines uq_podcast_auto_runs_brokerage_week at all", !!latest)
  check("…and the LATEST definition is PARTIAL: WHERE status <> 'failed'",
    !!latest && /WHERE\s*\(?\s*status\s*<>\s*'failed'/i.test(latest.def))

  // POSITIVE CONTROL (§2): the same finder over m127's plain shape must detect
  // the defect — a checker that cannot see the plain unique proves nothing.
  const plainSpecimen = "CREATE UNIQUE INDEX uq_podcast_auto_runs_brokerage_week ON public.podcast_auto_runs (brokerage_id, iso_week);"
  check("CONTROL the finder goes red on the pre-m588 PLAIN unique",
    !/WHERE\s*\(?\s*status\s*<>\s*'failed'/i.test(plainSpecimen))

  // The producer's half of the contract: it reads the refusal by SQLSTATE and
  // leaves the failed row as history for the settings card, whose "latest run"
  // read must order by created_at so the retry's row wins the top slot.
  const producer = src("lib/podcast/auto-producer.ts")
  check("the producer still reads the ledger's refusal by SQLSTATE 23505",
    producer.includes('"23505"') && producer.includes("already_run"))
  const card = src("app/dashboard/settings/podcast-channels/page.tsx")
  check("the run-ledger card orders by created_at DESC, so a retry's row outranks the failure it replaces",
    /podcast_auto_runs[\s\S]*?\.order\("created_at",\s*\{\s*ascending:\s*false\s*\}\)/.test(card))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ PODCAST_CHANNEL_CONSOLIDATION_FAIL"); process.exit(1) }
console.log(" ✅ PODCAST_CHANNEL_CONSOLIDATION_PASS — one channel editor (Settings); the studio syndicates read-only; published episodes are repurposable")
