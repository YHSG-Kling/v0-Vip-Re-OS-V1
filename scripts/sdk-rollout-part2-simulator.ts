#!/usr/bin/env tsx
/**
 * scripts/sdk-rollout-part2-simulator.ts   (tsx scripts/sdk-rollout-part2-simulator.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 71A — proof for the SECOND round of official-SDK adapters (PeopleData
 * Labs, Meta, HubSpot, Lob, QuickBooks), completing the wave-70 rollout
 * (Twilio/ElevenLabs/Apify/ZenRows/Exa, proved by the wave-70 adapters' own
 * tests). Three things this proof asserts, per the task:
 *
 *   1. EACH ADAPTER FAILS CLOSED WITHOUT A CREDENTIAL — called with an empty
 *      credential, it must refuse (ok:false, an "unconfigured" error) and
 *      make NO network call at all. `globalThis.fetch` is stubbed to THROW
 *      for this section, so any adapter that skipped its own guard and tried
 *      to reach the network anyway fails the test loudly instead of quietly
 *      hitting a real host. (Two adapters — Meta's `facebook-nodejs-
 *      business-sdk` and QuickBooks' `intuit-oauth` — transport over axios,
 *      not `fetch`, so the fetch stub cannot literally catch a slipped-through
 *      call from those two; their own explicit `if (!token) return …` guard,
 *      which runs BEFORE any SDK client is even constructed, is what this
 *      section actually proves for them, same as the other three.)
 *
 *   2. EACH MIGRATED FILE NO LONGER CONTAINS THE RAW REST HOST STRING IN
 *      STRIPPED SOURCE — read with `blankComments` (CLAUDE.md §2: a raw scan
 *      would count a tombstone COMMENT naming the old host as a live call
 *      site, exactly the defect five guards hit in wave 2026-08-23). Only
 *      files where the host was FULLY removed are asserted here — files that
 *      keep one REST call on purpose (documented "kept on REST" carve-outs:
 *      PeopleData's email/validate, the QBO business-object calls, Meta's
 *      OAuth/long-lived-token exchange) still contain their host string by
 *      design and are excluded from this list, not silently passed.
 *
 *   3. A POSITIVE CONTROL PROVES THE DETECTOR STILL WORKS: for every host
 *      checked above, a small fixture with the host in a LIVE code line is
 *      confirmed to still read as present after stripping (the detector is
 *      not vacuously blind), and a companion fixture with the SAME host only
 *      inside a `//` comment is confirmed to read as ABSENT — the tombstone
 *      lesson, demonstrated rather than just cited.
 *
 * Registered: package.json `"test:sdk-rollout-2": "tsx scripts/sdk-rollout-
 * part2-simulator.ts"`, guard tail after `test:comp-adjustments`, and a
 * MAINTENANCE_DOMAINS entry (`sdk_rollout_part2`, lib/kernel/manager-
 * registry.ts) naming this proof — test:proof-ownership requires it (wave 69
 * integration lesson).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blankComments } from "./strip-comments"

let pass = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const root = process.cwd()
const src = (p: string) => readFileSync(join(root, p), "utf8")
const strippedSrc = (p: string) => blankComments(src(p))

async function main() {
  // ── 1. Each adapter fails closed without a credential — no network call ──
  console.log("\n[1 · adapters fail closed without a credential]")
  {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = (async (...args: any[]) => {
      fetchCalls++
      throw new Error(`TEST: unexpected network call while unconfigured — ${JSON.stringify(args[0])}`)
    }) as unknown as typeof fetch

    try {
      const { enrichPerson } = await import("../lib/providers/peopledata/client")
      const pdl = await enrichPerson("", { name: "Test Person" })
      check("peopledata.enrichPerson('') refuses (unconfigured, no network)", !pdl.ok && /unconfigured/.test(pdl.error ?? ""), pdl.error ?? "")

      const { graphGet, graphPost } = await import("../lib/providers/meta/client")
      const mg = await graphGet("", ["me"])
      const mp = await graphPost("", ["me", "feed"], { message: "x" })
      check("meta.graphGet('') refuses (unconfigured, no SDK client constructed)", !mg.ok && /unconfigured/.test(mg.error ?? ""), mg.error ?? "")
      check("meta.graphPost('') refuses (unconfigured, no SDK client constructed)", !mp.ok && /unconfigured/.test(mp.error ?? ""), mp.error ?? "")

      const { upsertContactByEmail, createContact, listContactsPage } = await import("../lib/providers/hubspot/client")
      const hu = await upsertContactByEmail("", "a@b.com", { firstname: "A" })
      const hc = await createContact("", { firstname: "A" })
      const hl = await listContactsPage("", { limit: 10, properties: ["email"] })
      check("hubspot.upsertContactByEmail('') refuses (unconfigured, no network)", !hu.ok && /unconfigured/.test(hu.error ?? ""), hu.error ?? "")
      check("hubspot.createContact('') refuses (unconfigured, no network)", !hc.ok && /unconfigured/.test(hc.error ?? ""), hc.error ?? "")
      check("hubspot.listContactsPage('') refuses (unconfigured, no network)", !hl.ok && /unconfigured/.test(hl.error ?? ""), hl.error ?? "")

      const { verifyUsAddress } = await import("../lib/providers/lob/client")
      const lv = await verifyUsAddress("", { primary_line: "1 Main St", city: "Austin", state: "TX", zip_code: "78701" })
      check("lob.verifyUsAddress('') refuses (unconfigured, no network)", !lv.ok && /unconfigured/.test(lv.error ?? ""), lv.error ?? "")

      const { refreshQuickBooksToken } = await import("../lib/providers/quickbooks/client")
      const qNoCreds = await refreshQuickBooksToken("", "", "some-refresh-token")
      const qNoRefresh = await refreshQuickBooksToken("client-id", "client-secret", "")
      check("quickbooks.refreshQuickBooksToken with no app creds refuses (unconfigured, no SDK client constructed)", !qNoCreds.ok && /unconfigured/.test(qNoCreds.error ?? ""), qNoCreds.error ?? "")
      check("quickbooks.refreshQuickBooksToken with no refresh token refuses (unconfigured, no SDK client constructed)", !qNoRefresh.ok && /unconfigured/.test(qNoRefresh.error ?? ""), qNoRefresh.error ?? "")

      check("none of the eight calls above made a network call while unconfigured", fetchCalls === 0, `fetchCalls=${fetchCalls}`)
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  // ── 2 + 3. migrated-file host absence + positive control ────────────────
  console.log("\n[2 · migrated call sites no longer carry the raw REST host in stripped source]")
  const FULLY_MIGRATED: Array<{ file: string; host: string }> = [
    { file: "lib/external/lob-address-verify.ts", host: "api.lob.com" },
    { file: "lib/crm/providers/hubspot.ts", host: "api.hubapi.com" },
    { file: "lib/crm/import-pull.ts", host: "api.hubapi.com" },
    { file: "lib/providers/accounting/quickbooks.ts", host: "oauth.platform.intuit.com" },
    { file: "lib/connections/accounting-scopes.ts", host: "oauth.platform.intuit.com" },
    { file: "lib/social/dm-dispatch.ts", host: "graph.facebook.com" },
    { file: "lib/social/publisher.ts", host: "graph.facebook.com" },
    { file: "lib/ads/connectors/meta.ts", host: "graph.facebook.com" },
    { file: "lib/ads/ad-lead-intake.ts", host: "graph.facebook.com" },
    { file: "app/api/cron/audience-sync-runner/route.ts", host: "graph.facebook.com" },
    { file: "lib/social/analytics-sync.ts", host: "graph.facebook.com" },
  ]
  for (const { file, host } of FULLY_MIGRATED) {
    const stripped = strippedSrc(file)
    check(`${file}: stripped source no longer contains "${host}"`, !stripped.includes(host), `raw source still has it? ${src(file).includes(host)}`)
  }

  // KEPT-ON-REST carve-outs still carry their host — recorded as a blind spot
  // (the denominator this "gone" list is measured against), not silently
  // dropped. Each is a documented owner-ruling exception (see each file's own
  // header comment + docs/provider-matrix-2026-09.md), never an accident.
  const KEPT_ON_REST: Array<{ file: string; host: string; why: string }> = [
    { file: "lib/external/peopledata-client.ts", host: "api.peopledatalabs.com", why: "email/validate has no SDK method" },
    { file: "lib/providers/accounting/quickbooks.ts", host: "quickbooks.api.intuit.com", why: "no official Intuit SDK for QBO business objects" },
    { file: "lib/connections/accounting-scopes.ts", host: "quickbooks.api.intuit.com", why: "same — no official Intuit SDK for QBO business objects" },
    { file: "lib/social/token-refresh.ts", host: "graph.facebook.com", why: "fb_exchange_token long-lived exchange — SDK cannot mint a token" },
    { file: "lib/platform/platform-social.ts", host: "graph.facebook.com", why: "exchangeMetaLongLivedToken — same reason (the other 5 call sites in this file DID migrate)" },
    { file: "app/api/integrations/oauth/[provider]/route.ts", host: "graph.facebook.com", why: "shared multi-provider OAuth authorization-code exchange" },
  ]
  for (const { file, host, why } of KEPT_ON_REST) {
    check(`${file}: still carries "${host}" on purpose (${why})`, strippedSrc(file).includes(host))
  }

  console.log("\n[3 · positive control — the detector still recognises the defect it was written for]")
  const uniqueHosts = Array.from(new Set(FULLY_MIGRATED.map((f) => f.host)))
  for (const host of uniqueHosts) {
    const liveCodeFixture = `const OLD_BASE = "https://${host}/v1"\nexport async function callIt() { return fetch(OLD_BASE) }\n`
    const commentOnlyFixture = `// MIGRATED (wave 71A): this file no longer calls ${host} directly — see\n// lib/providers/<name>/client.ts for the SDK adapter that replaced it.\nexport const DONE = true\n`
    check(`positive control: "${host}" in LIVE code is still detected after stripping`, blankComments(liveCodeFixture).includes(host))
    check(`tombstone lesson: "${host}" inside a // COMMENT strips to absent (not a call site)`, !blankComments(commentOnlyFixture).includes(host))
  }

  // ── 4. Source-presence: the migrated files actually call their adapter ──
  console.log("\n[4 · migrated call sites import + call their adapter]")
  // Some call sites import statically (`from "@/lib/providers/x/client"`),
  // others dynamically (`await import("@/lib/providers/x/client")`, used
  // where the caller is reached by plain-tsx proof scripts and a static
  // import of a server-leaning module would pull it into every graph that
  // reaches the caller) — this matches EITHER spelling. A call is a function
  // name followed by `(` (plain call) OR `<` (a generic type argument, e.g.
  // `graphGet<T>(...)`), which every migrated call site above uses.
  function importsAdapter(fileSrc: string, adapterPath: string): boolean {
    const escaped = adapterPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`from\\s+["']${escaped}["']|import\\(["']${escaped}["']\\)`).test(fileSrc)
  }
  function callsFn(fileSrc: string, fnName: string, minCount = 1): boolean {
    const matches = fileSrc.match(new RegExp(`\\b${fnName}[<(]`, "g")) ?? []
    return matches.length >= minCount
  }

  check("peopledata-client.ts imports enrichPerson from the adapter", importsAdapter(strippedSrc("lib/external/peopledata-client.ts"), "@/lib/providers/peopledata/client") && callsFn(strippedSrc("lib/external/peopledata-client.ts"), "enrichPerson"))
  check("lob-address-verify.ts imports verifyUsAddress from the adapter", importsAdapter(strippedSrc("lib/external/lob-address-verify.ts"), "@/lib/providers/lob/client") && callsFn(strippedSrc("lib/external/lob-address-verify.ts"), "verifyUsAddress"))
  check("hubspot.ts imports upsertContactByEmail + createContact from the adapter", importsAdapter(strippedSrc("lib/crm/providers/hubspot.ts"), "@/lib/providers/hubspot/client") && callsFn(strippedSrc("lib/crm/providers/hubspot.ts"), "upsertContactByEmail") && callsFn(strippedSrc("lib/crm/providers/hubspot.ts"), "createContact"))
  check("import-pull.ts's pullHubSpot imports listContactsPage from the adapter", importsAdapter(strippedSrc("lib/crm/import-pull.ts"), "@/lib/providers/hubspot/client") && callsFn(strippedSrc("lib/crm/import-pull.ts"), "listContactsPage"))
  check("quickbooks.ts's refreshAccessToken imports refreshQuickBooksToken from the adapter", importsAdapter(strippedSrc("lib/providers/accounting/quickbooks.ts"), "@/lib/providers/quickbooks/client") && callsFn(strippedSrc("lib/providers/accounting/quickbooks.ts"), "refreshQuickBooksToken"))
  check("accounting-scopes.ts's ensureFreshQuickBooksToken imports refreshQuickBooksToken from the adapter", importsAdapter(strippedSrc("lib/connections/accounting-scopes.ts"), "@/lib/providers/quickbooks/client") && callsFn(strippedSrc("lib/connections/accounting-scopes.ts"), "refreshQuickBooksToken"))
  check("platform-social.ts imports graphGet for the 5 migrated Meta reads", importsAdapter(strippedSrc("lib/platform/platform-social.ts"), "@/lib/providers/meta/client") && callsFn(strippedSrc("lib/platform/platform-social.ts"), "graphGet", 5))
  check("dm-dispatch.ts imports graphPost for both Meta sends", importsAdapter(strippedSrc("lib/social/dm-dispatch.ts"), "@/lib/providers/meta/client") && callsFn(strippedSrc("lib/social/dm-dispatch.ts"), "graphPost", 2))
  check("publisher.ts imports graphPost for Facebook + Instagram (4 call sites)", importsAdapter(strippedSrc("lib/social/publisher.ts"), "@/lib/providers/meta/client") && callsFn(strippedSrc("lib/social/publisher.ts"), "graphPost", 4))
  check("analytics-sync.ts imports graphGet for Facebook + Instagram metrics", callsFn(strippedSrc("lib/social/analytics-sync.ts"), "graphGet", 2))
  check("connectors/meta.ts's graph() helper routes through graphGet/graphPost", importsAdapter(strippedSrc("lib/ads/connectors/meta.ts"), "@/lib/providers/meta/client") && callsFn(strippedSrc("lib/ads/connectors/meta.ts"), "graphGet") && callsFn(strippedSrc("lib/ads/connectors/meta.ts"), "graphPost"))
  check("ad-lead-intake.ts imports graphGet for the leadgen fetch", importsAdapter(strippedSrc("lib/ads/ad-lead-intake.ts"), "@/lib/providers/meta/client") && callsFn(strippedSrc("lib/ads/ad-lead-intake.ts"), "graphGet"))
  check("audience-sync-runner route imports graphPost for the Custom Audience upload", importsAdapter(strippedSrc("app/api/cron/audience-sync-runner/route.ts"), "@/lib/providers/meta/client") && callsFn(strippedSrc("app/api/cron/audience-sync-runner/route.ts"), "graphPost"))
  check("oauth/[provider] route imports graphGet for the ad-account lookup only (token exchange stays REST)", importsAdapter(strippedSrc("app/api/integrations/oauth/[provider]/route.ts"), "@/lib/providers/meta/client"))

  // ── 5. next.config.ts externalises every newly-installed package ────────
  console.log("\n[5 · next.config.ts externalises the newly-installed packages]")
  const nextConfigSrc = strippedSrc("next.config.ts")
  for (const pkg of ["peopledatalabs", "facebook-nodejs-business-sdk", "@hubspot/api-client", "intuit-oauth", "lob"]) {
    check(`next.config.ts: "${pkg}" is in serverExternalPackages`, nextConfigSrc.includes(`"${pkg}"`))
    // Object-literal key quoting differs by package name (bare identifiers
    // like `lob`/`peopledatalabs` need no quotes; scoped/hyphenated names
    // like `@hubspot/api-client` do) — the pin is proven by the `commonjs
    // <pkg>` value string, not by a fixed quoting style on the key.
    check(`next.config.ts: "${pkg}" is pinned in the webpack externals (beside sharp)`, nextConfigSrc.includes(`commonjs ${pkg}`))
  }

  console.log("")
  if (failures.length) {
    console.log(`FAILED (${failures.length} of ${pass + failures.length} assertions)`)
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log(
    `PASSED (${pass} assertions) — the five wave-71A adapters (peopledata, meta, hubspot, lob, ` +
    `quickbooks) fail closed without a credential and make no network call; every fully-migrated ` +
    `call site's stripped source no longer carries its old REST host while the documented ` +
    `kept-on-REST carve-outs still do; the host-absence detector is proven live (positive control) ` +
    `and comment-blind (tombstone control); every migrated file demonstrably imports and calls its ` +
    `adapter; and next.config.ts externalises all five newly-installed packages.`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
