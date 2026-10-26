/**
 * scripts/canaries/versium.ts — VERSIUM / ENRICHMENT canary (wave 144, lane 144J; owner ruling 10):
 *   the Estimate API returns a NUMBER (no contacts purchased / imported / enriched) · online_audience_append is NOT targeting
 *   — it appends the matched online identifiers (hashed / alternate ids per the real schema) to the platform record, and those
 *   ids never become email / SMS addresses · the REACH MCP exposes only VERIFIED tools (Online Audience Append and look-alike
 *   list generation are documented as NOT exposed) · PeopleData vs Versium: gap-only, cheaper provider, cost gate, no silent
 *   overwrite · protected / demographic fields may be STORED for authorized research (access-restricted, provenance) and are
 *   never used for targeting, steering or eligibility · research ≠ activation.
 * Through the survivors at 967a4866: lib/external/versium-client.ts (estimateVersiumAudience with an injected call — zero
 * network, VERSIUM_PRODUCT_MATRIX, VERSIUM_REACH_MCP), lib/lead-pipeline/enrichment-column-map.ts
 * (versiumDemographicCategoriesNeeded, mergeHouseholdFinancials), lib/ai-isa/followup-arbiter.ts (ARBITER_MEMORY_KEYS).
 *
 * MEASURED AT 967a4866: online_audience_append is POLICY_GATED with NO client and NO caller, classified "TARGETING plumbing,
 * not research" — ruling 10 says it is an APPEND, not targeting — and no access-restricted research home for protected fields
 * exists — 144E.
 */
import { LIVE, canary, landedModule, uuid } from "./_harness"
import { findLanded, fnBody, listFiles, strippedRepo } from "./_registry"
import { blankStrings } from "../strip-comments"
import { memSupabase } from "../in-memory-supabase"

export async function run() {
  const c = canary("Versium: estimate = a count · online audience append mapped onto the record (never a send address) · MCP only verified tools · PeopleData gap-only · sensitive fields research-only")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — no Versium call is ever made by a canary")
  const UNWIRED = false as boolean
  const v = await import("../../lib/external/versium-client")

  // ── 1 · ESTIMATE = A NUMBER (green — preserve) ──
  let calls = 0
  const est = await v.estimateVersiumAudience({ zips: ["32501"], ownRent: ["H"] }, { call: async () => { calls++; return { ok: true, status: 200, data: { versium: { results: { estimated_record_count: 1234, estimated_records_available: 1100, estimated_match_credits: 1100, preview: [{ first: "Pat", last: "Doe", email: "pat@example.test" }] } } } } } })
  // The RULE, not a key-name list (CLAUDE.md §2): no value of the result is a list of rows, and nothing from the vendor's preview
  // (a name, an email) survives anywhere in it. The first version refused any KEY matching /contacts|records$/ — lane 144E's
  // explicit `contactsReturned: 0` (a count saying no person came back) read as a leak; a key name is not a person.
  // A list of NAMES (144E's `refused: []` — the filters it refused) is not a row; a list holding objects is.
  const rowsIn = (o: Record<string, unknown>) => Object.values(o).some((val) => Array.isArray(val) && val.some((x) => !!x && typeof x === "object"))
  const carriesRows = rowsIn(est as unknown as Record<string, unknown>) || !rowsIn({ estimatedRecords: 1, preview: [{ email: "x@example.test" }] }) // POSITIVE CONTROL: a preview list IS rows
  const json = JSON.stringify(est)
  c.rule("144E", "THE ESTIMATE API RETURNS A NUMBER (ruling 10): one free call → estimatedRecords 1,234 / available 1,100 / the list job's would-be credits, cost 0 — the vendor's masked preview rows are DROPPED (no person, no contact point, nothing imported or enriched); the result carries counts only", calls === 1 && est.estimatedRecords === 1234 && est.availableRecords === 1100 && est.cost === 0 && !carriesRows && !json.includes("pat@example.test") && !json.includes("Doe"), json)
  const protectedFilter = await v.estimateVersiumAudience({ zips: ["32501"], d_gender: "F", d_ethnicgroup: "x" } as never, { call: async () => { calls++; return { ok: true, status: 200, data: {} } } })
  c.rule("144E", "RESEARCH ≠ TARGETING (green — preserve): an estimate filter naming a protected class (gender, ethnic group) is REFUSED by name before any call — the count is never built on a protected characteristic", protectedFilter.skipped === "refused_filter" && protectedFilter.refused.length >= 1 && calls === 1, JSON.stringify(protectedFilter.refused))

  // ── 2 · ONLINE AUDIENCE APPEND — an append mapped onto the record, not targeting ──
  const oaa = v.VERSIUM_PRODUCT_MATRIX.find((p) => p.id === "online_audience_append")
  // WAVE144 WIRE (integrator): 144E — the append client + its record mapping (hashed / alternate ids per the real schema).
  const appendFn = findLanded(["lib/external", "lib/enrichment", "lib/lead-pipeline/enrichment-orchestrator.ts", "lib/lead-pipeline/enrichment-column-map.ts"], /export\s+(async\s+)?function\s+\w*[Oo]nlineAudience\w*\s*\(/)
  c.rule("144E", "ONLINE AUDIENCE APPEND IS AN APPEND, NOT TARGETING (ruling 10: 'matches contacts' online profiles (if any) and appends matched online contact identifiers … to the platform record; downstream ad targeting is a separate governed action'): the product row has a caller that maps the REAL response (hashed / alternate ids per platform) onto the contact record with provenance, through the cost gate — at HEAD it is POLICY_GATED with no client and no caller, described as targeting plumbing", !!oaa && !!oaa.caller && /^WIRED/.test(oaa.status) && appendFn !== null, `HEAD: status ${oaa?.status}, caller ${oaa?.caller ? `${oaa.caller.file}#${oaa.caller.symbol}` : "null"}, append function ${appendFn ?? "none"}`)
  // Driven through lane 144E's LANDED rung when its file exists (lib/enrichment/online-audience-store.ts): a governed customer-list
  // audience makes the gap real; the vendor call is injected (zero network) and answers one hashed e-mail + one hashed phone.
  const store = await landedModule("../../lib/enrichment/online-audience-store.ts")
  const firewall = store && typeof (v as Record<string, unknown>).isOnlineAudienceIdentifier === "function" ? await (async () => {
    const B = uuid(), CT = uuid(), HEX = (ch: string) => ch.repeat(64)
    const db = memSupabase({
      contacts: [{ id: CT, brokerage_id: B, first_name: "Pat", last_name: "Doe", email: "pat@example.test", phone: "5551234567", zip_code: "32501", enrichment_profile: null }],
      facebook_custom_audiences: [{ id: uuid(), brokerage_id: B, audience_type: "custom", consent_basis: "first_party_crm", status: "synced", target_platform: "facebook", lookalike_seed_audience_id: null }],
    }) as any
    const doc = { versium: { version: "2.0", match_counts: { online_audience: 1 }, num_matches: 1, num_results: 1, query_id: "q-144j", results: [{ facebook: [{ email: [HEX("a")], phone: [HEX("b")] }] }] } }
    const legDeps = { call: async () => ({ ok: true, status: 200, data: doc }), checkBudget: async () => ({ allowed: true }), providerHealth: async () => ({ state: "healthy", routeAround: false, reason: "canary fixture" }), meter: async () => true }
    const w = console.warn; console.warn = () => {}
    const r = await store.appendOnlineAudienceForContact(db, { contactId: CT, brokerageId: B }, { legDeps, now: new Date("2026-10-25T12:00:00Z") }).finally(() => { console.warn = w })
    const row = db.tables.contacts[0]
    const updates = (db.writes ?? []).filter((x: any) => x.table === "contacts" && x.op === "update")
    const isId = (v as Record<string, any>).isOnlineAudienceIdentifier as (x: unknown) => boolean
    // No module outside lib/enrichment imports the store (a channel / dispatch / outreach module cannot read an ad-tech id).
    const IMPORT_RE = /from\s+["'][^"']*enrichment\/online-audience-store["']|import\(\s*["'][^"']*enrichment\/online-audience-store["']\s*\)/
    const importers = [...listFiles("lib", (f) => /\.tsx?$/.test(f)), ...listFiles("app", (f) => /\.tsx?$/.test(f))].filter((f) => IMPORT_RE.test(strippedRepo(f) ?? ""))
    // The ONE governed downstream act that may read the store: lib/kernel/ads.ts syncAudience, after its consent-basis refusal.
    const adsSyncBody = fnBody(strippedRepo("lib/kernel/ads.ts") ?? "", "syncAudience")
    const consentBeforeRead = (body: string) => { const gate = body.search(/if\s*\(!audience\.consent_basis\)/), read = body.search(IMPORT_RE); return gate >= 0 && read > gate }
    const importCount = (src: string) => (src.match(new RegExp(IMPORT_RE.source, "g")) ?? []).length
    // Every import of the store in ads.ts sits INSIDE syncAudience (a second read elsewhere in the file would not be the governed act).
    const adsOnlyInSync = importCount(adsSyncBody) > 0 && importCount(strippedRepo("lib/kernel/ads.ts") ?? "") === importCount(adsSyncBody)
    const governedOnly = (files: string[]) => files.every((f) => f.startsWith("lib/enrichment/") || (f === "lib/kernel/ads.ts" && adsOnlyInSync && consentBeforeRead(adsSyncBody)))
    return {
      appended: !!r.ok && !!r.wrote && (r.identifierCount ?? 0) > 0,
      addressesUntouched: row.email === "pat@example.test" && row.phone === "5551234567",
      onlyTheProfileBlockWritten: updates.length >= 1 && updates.every((u: any) => Object.keys(u.payload ?? {}).join() === "enrichment_profile"),
      plaintextIsNotAnIdentifier: !isId("pat@example.test") && !isId("+15551234567") && isId(HEX("a")),
      // RE-ASSERTED (lane 144Z): this pinned a WAYPOINT ("nothing outside lib/enrichment imports the store") that was true only until
      // the governed ad read landed (lane 144X item E1: lib/kernel/ads.ts syncAudience appends the platform's hashed match keys).
      // The RULE (ruling 10) is: an appended ad-tech id is never a send address, and downstream TARGETING is its own governed act.
      // So: every importer outside lib/enrichment must be the governed ad-audience sync — and there the consent-basis refusal must
      // run BEFORE the store is read — and no channel / dispatch / outreach module imports it. Positive control: the same predicate
      // refuses a dispatch module importing the store, and refuses the ad sync if the consent refusal were moved after the read.
      noChannelImportsTheStore: governedOnly(importers) && !governedOnly([...importers, "lib/providers/dispatch.ts"]) && !consentBeforeRead(adsSyncBody.replace(/if\s*\(!audience\.consent_basis\)/, "if (false)")) && IMPORT_RE.test(`import { x } from "@/lib/enrichment/online-audience-store"`),
    }
  })() : null
  c.rule("144E", "APPENDED AD-TECH IDS ARE NEVER SEND ADDRESSES (ruling 10): an online identifier appended to a contact is stored apart from the permissioned email / phone columns and no email / SMS recipient resolver reads it; using it for an ad audience is its own consent-gated action", !!firewall && Object.values(firewall).every(Boolean), firewall ? `landed rung: ${JSON.stringify(firewall)}` : appendFn ? `landed at ${appendFn}, but lib/enrichment/online-audience-store.ts is absent` : "HEAD: nothing appends online identifiers, so the separation has no subject yet")

  // ── 3 · the REACH MCP exposes only verified tools (green — preserve) ──
  const mcp = v.VERSIUM_REACH_MCP as unknown as { wired: boolean; status: string; excludedByVendor: readonly string[]; waitingOn?: readonly string[]; tools?: readonly string[]; verifiedTools?: readonly string[] }
  const declared = [...(mcp.tools ?? []), ...(mcp.verifiedTools ?? [])]
  const excludedOk = ["online_audience_append", "lookalike_list_generation"].every((x) => mcp.excludedByVendor.includes(x))
  c.rule("144E", "THE REACH MCP EXPOSES ONLY VERIFIED TOOLS (ruling 10: verify transport, auth and the ACTUAL tool list; Online Audience Append and dedicated look-alike list generation are NOT exposed): either it is not wired and reads WAITING_EXTERNAL with the exact dependency named, or every tool it exposes is on the verified list and none of the vendor-excluded products is offered through it", excludedOk && ((!mcp.wired && mcp.status === "WAITING_EXTERNAL" && (mcp.waitingOn ?? []).length > 0) || (mcp.wired && declared.length > 0 && !declared.some((t) => /online.?audience|look.?alike/i.test(t)))), `wired ${mcp.wired}, status ${mcp.status}, excluded ${mcp.excludedByVendor.join(",")}`)

  // ── 4 · PeopleData vs Versium: gap-only, no silent overwrite (green — preserve) ──
  const map = await import("../../lib/lead-pipeline/enrichment-column-map")
  const fromPdl = { provider: "peopledata", age_range: "35-44", gender: "F", marital_status: "married", household_size: 3, children_count: 1, education: [{ degree: "BA" }], home_owner_status: "owner", home_value: 410_000 }
  const needed = map.versiumDemographicCategoriesNeeded(fromPdl)
  const kept = map.mergeHouseholdFinancials({ household_income: "100000-150000" }, { household_income: "50000-75000" }, "versium", { prefer: "existing" })
  c.rule("144E", "GAP-ONLY ACROSS PROVIDERS (ruling 10: 'canonical record → field completeness → … → required gap → cheaper provider → cost gate → append; no silent overwrite'): a profile PeopleData already filled is NOT re-bought from Versium's demographic category (only the financial gap is), and carrying a value forward never overwrites the one on file", !needed.includes("demographic") && needed.includes("financial") && kept.household_income === "100000-150000", `needed ${needed.join(",")}; kept ${kept.household_income}`)

  // ── 5 · sensitive / protected fields: research-only, access-restricted ──
  const { ARBITER_MEMORY_KEYS } = await import("../../lib/ai-isa/followup-arbiter")
  const PROTECTED = ["gender", "age_range", "marital_status", "religion", "ethnicity", "race", "children_count", "household_size", "national_origin", "disability", "birthday", "age"]
  c.rule("144E", "PROTECTED ATTRIBUTES NEVER REACH A DECISION (green — preserve): the follow-up arbiter's model sees only preference / timing memory keys — no gender, age, marital status, household composition or any protected characteristic", !ARBITER_MEMORY_KEYS.some((k) => PROTECTED.includes(k)), ARBITER_MEMORY_KEYS.join(","))
  // THE DECIDABLE HALF, HARD (lane 144Z): no ads / targeting module READS a protected column. Widened from three named files to every
  // module under lib/ads plus the kernel's ad-audience and look-alike doors, and made precise: a READ is a `.select(` list naming
  // the column or a property access `.gender` on code with strings blanked — a fair-housing REFUSAL message that names the word
  // ("HOUSING ads cannot target by gender") is not a read (CLAUDE.md §2: a guard must not accuse live code). Positive control: the
  // same reader flags a synthetic select and a property access.
  const PROTECTED_COL = "gender|age_range|marital_status|ethnicity|religion|children_count|household_size|birthday|date_of_birth"
  const SELECT_READ = new RegExp(`\\.select\\(\\s*["'\u0060][^"'\u0060]*\\b(${PROTECTED_COL})\\b`)
  const PROP_READ = new RegExp(`\\.(${PROTECTED_COL})\\b`)
  const readsProtected = (stripped: string) => SELECT_READ.test(stripped) || PROP_READ.test(blankStrings(stripped))
  const targetingFiles = [...listFiles("lib/ads", (f) => /\.tsx?$/.test(f)), "lib/kernel/ads.ts", "lib/kernel/lookalike-audience.ts"]
  const adsHits = targetingFiles.filter((f) => readsProtected(strippedRepo(f) ?? ""))
  const readerControl = readsProtected(`await svc.from("contacts").select("id, gender")`) && readsProtected("const g = contact.age_range") && !readsProtected(`violations.push("HOUSING ads cannot target by gender")`)
  c.rule("144E", "NO ADS / TARGETING MODULE READS A PROTECTED COLUMN (ruling 10: protected / demographic fields are never used for ad targeting, steering or eligibility): no module under lib/ads, nor the kernel's ad-audience (lib/kernel/ads.ts) or look-alike (lib/kernel/lookalike-audience.ts) door, selects or reads gender, age range, marital status, ethnicity, religion, household composition or a birth date", readerControl && targetingFiles.length > 2 && adsHits.length === 0, `scanned ${targetingFiles.length} targeting modules; reading a protected column: ${adsHits.join(", ") || "none"}; reader control ${readerControl}`)
  // PENDING OWNER DECISION (lane 144Z): WHERE protected fields live for authorized research (a separate restricted table / schema, a
  // column-level role grant on contacts, or the existing contacts columns behind a research role) is a data-governance decision with
  // retention and access consequences — no lane may take it, and the canary must not fake it. Green only once a research-only home
  // has landed AND its role-restricted read is asserted here.
  // WAVE144 WIRE (integrator): 144E — the access-restricted research home (RLS / role) + provenance / retention for protected fields.
  const research = findLanded(["supabase/migrations", "lib/enrichment", "lib/external", "lib/kernel/lookalike-research.ts"], /\b(sensitive_research\w*|research_only\w*|protected_attribute\w*|demographic_research\w*|research_access\w*|SENSITIVE_RESEARCH\w*)\b/)
  c.pendingOwner("144E", "PROTECTED / DEMOGRAPHIC FIELDS ARE STORED FOR AUTHORIZED RESEARCH ONLY (ruling 10: lawful research; access-restricted; provenance + retention; never ad targeting, steering or eligibility; add a field only where there is a GAP): the research home is access-restricted by role / RLS and separated from operational and ad features", research !== null && UNWIRED,
    "DATA GOVERNANCE: choose the research-only home for protected / demographic fields — a separate access-restricted table (or schema) with provenance + retention, or a role-restricted read of the existing contacts columns (age_range, gender, marital_status, household_income, …) — and which role may read it; then the migration + RLS are written and this step asserts the restricted read",
    `${research ? `landed at ${research} — wire the role-restricted read assertion here` : "HEAD: contacts carries age_range / gender / marital_status / household_income … readable like any contact column; no research-only home or role restriction under supabase/migrations / lib/enrichment"}`)

  c.blind("No Versium endpoint is called (an injected estimate call). The MCP verdict is the declared object (lane 143D re-proved it against the live server on 2026-10-23); this canary does not open a socket. Intent / life-change signal SOURCES (moving, refinance, home-sale interest) are the ai-journeys canary's.")
  return c.report([], 0)
}
