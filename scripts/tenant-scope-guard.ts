// scripts/tenant-scope-guard.ts   (npm run test:tenant-scope — in the guard chain)
// ─────────────────────────────────────────────────────────────────────────────
// APP-LAYER TENANT-SCOPE LINT — the primary multi-tenant boundary is ~1,300
// service-client call sites each remembering to scope tenant tables; RLS is
// the verified BACKSTOP (test:tenant-isolation), not the primary. This guard
// makes the missing-filter class of leak impossible BY CI, not by diligence:
// every `.from("<tenant table>")` query chain must show SCOPING EVIDENCE —
// a brokerage_id filter, a primary-key/unique-id lookup, or a parent-id the
// caller already validated. Heuristic by design, so it carries a BASELINE
// (tenant-scope-baseline.json): existing debt is frozen and the surface can
// only SHRINK — any NEW unscoped query fails the build with its location.

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { stripComments } from "./strip-comments"
import { join, relative } from "node:path"

// High-risk tenant tables — rows here belong to ONE brokerage.
const TENANT_TABLES = [
  "contacts", "leads", "listings", "transactions", "showings", "offers",
  "messages", "conversations", "voice_calls", "client_portal_messages",
  "documents", "open_house_events", "open_house_attendees", "agent_client_messages",
  "campaigns", "tasks", "referrals", "vendors", "agents",
] as const

// Evidence that a chain is scoped: a tenant filter, a PK/unique-sid lookup,
// or a validated parent id. Any ONE within the chain window passes.
const SCOPE_EVIDENCE = [
  "brokerage_id", "brokerageId",
  // THE REPAIR MUST READ AS REPAIRED. lib/kernel/tenant-scope.ts applies the
  // tenant predicate through a HELPER, so a converted chain contains neither the
  // string "brokerage_id" nor a literal `.eq(`. Without this entry the guard
  // reports a NEW unscoped query for a site that was just made STRICTER —
  // `applyTenantScope` refuses a null where `if (brokerageId) …eq(…)` silently
  // dropped the filter. Measured: converting app/actions/listing-landing.ts:
  // getSimilarListings (owner ruling 3, 2026-08-24) did exactly that.
  //
  // Accepting it is not a widening. `applyTenantScope` takes a TenantScope, and
  // the only two ways to obtain one are tenantScope(id, where) — which THROWS on a
  // blank — and platformScope(reason) / resolveTenantScope(), which require proven
  // platform authority and a written reason. Control 6 below pins that a bare
  // `.select()` with no scope at all is still reported, so this cannot become a
  // free pass by being written near an unrelated query.
  "applyTenantScope",
  '.eq("id"', ".eq('id'", '.in("id"', ".in('id'",
  "vendor_call_id", "call_sid",
  '.eq("user_id"', ".eq('user_id'",
  // Unique-key lookups (globally unique — the row IS the scope):
  '.eq("slug"', '.eq("public_id"', '.eq("token"', '.eq("public_slug"', "stripe_",
  // An MLS number is a public, globally-unique handle for ONE listing — the
  // same class as a slug. It cannot enumerate a brokerage's book, and the
  // surface that needs it (the shared /properties/<mls> link) is deliberately
  // unauthenticated. EXACT-match only: `.eq("mls_number"`. A range, ilike or
  // `.in()` over MLS numbers is NOT this and still has to scope.
  '.eq("mls_number"',
  // Provider-generated envelope refs (unique by construction — the e-sign
  // webhook/reconciler probes match on them with no session to scope by):
  "provider_envelope_id", "signature_request_id",
  "contact_id", "conversation_id", "event_id", "listing_id", "transaction_id", "agent_id",
]

const WINDOW = 500 // chars of chain examined after .from("table")
const root = process.cwd()
const baselinePath = join(root, "scripts", "tenant-scope-baseline.json")

// TOMBSTONE (orphan doctrine §1.1) — the private `walk()` generator that stood
// here was one of 82 copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// It enumerated DIRECTORIES, and a root-level FILE is not a directory, so
// `proxy.ts` was outside the corpus of the TENANCY guard — while being the one
// runtime file that resolves a tenant from an untrusted request HOST and then
// queries tenant_custom_domains, brokerages and users with a SERVICE client, RLS
// bypassed, on every request. That is the exact shape §4 of CLAUDE.md names, in
// the exact file this guard could not open. `rootRuntimeFiles()` supplies it.
//
// The name filter is NOT part of the survivor and is kept here: this guard quotes
// the forbidden shapes in its own positive controls, so a simulator or guard file
// in the corpus would report its own fixtures as violations.
const scanNameOk = (p: string) => !/\.test\.|simulator|guard/.test(p.split("/").pop() ?? "")
function* walkScoped(dir: string): Generator<string> {
  for (const p of walkTs(dir)) if (scanNameOk(p)) yield p
}
/** The directory reach PLUS the root-level runtime files, both from the survivor. */
function* scanCorpus(dirs: string[]): Generator<string> {
  for (const d of dirs) yield* walkScoped(join(root, d))
  for (const p of rootRuntimeFiles(root)) if (scanNameOk(p)) yield p
}

/**
 * The one place the verdict is made — so the POSITIVE CONTROLS below judge the
 * SAME code that judges the repo. `raw` is a whole file's text, exactly as read
 * from disk; the return is one entry per table that has at least one unscoped
 * `.from()` chain in it.
 *
 * ── COMMENTS ARE REMOVED, NOT BLANKED, AND THAT DISTINCTION IS THE WHOLE BUG ──
 *
 * Round 1 — this scan read the file RAW, so PROSE could satisfy the scope check.
 * Counted, not asserted: `lib/communications/vendor-communications.tsx` carries
 * NINE `brokerage_id` mentions inside comments and `app/actions/buyer-offers.ts`
 * FOUR. A guard that a MENTION can talk out of reporting is worse than no guard,
 * because it reports zero and reads as a clean bill of health (CLAUDE.md §2).
 *
 * Round 2 — the obvious fix, `blankComments`, moved the same defect one step to
 * the left and pointed it at LIVE CODE. blankComments deliberately preserves
 * character offsets, so an eight-line comment between `.from("transactions")`
 * and `.eq("id", …)` does not go away: it becomes ~470 characters of SPACES, and
 * those spaces are spent out of this scan's 500-character chain budget. All
 * three "new" findings that appeared the day this guard switched to blanking
 * were of exactly that shape — a real predicate pushed just past the window by
 * whitespace, at a measured offset from its own `.from(`:
 *
 *   app/actions/buyer-offers.ts       getBuyerOffers      .eq("brokerage_id", access.brokerageId)  ~530
 *   lib/communications/…-communications.tsx  sendVendorBookingConfirmation  .eq("id", params.transactionId)  ~520
 *   lib/application/listings.ts       getListingsService  .eq("brokerage_id", params.brokerageId)  ~560
 *
 * The first two were correct as written and needed nothing. The third was only
 * HALF right and the window hid which half: the predicate was there but written
 * `if (params?.brokerageId) query = query.eq(…)`, so the tenant filter was
 * OPTIONAL — a shape this guard cannot tell from a real one either way, since
 * both look identical as text. It is now unconditional and the parameter is
 * required, which is the only form the text-level check is actually entitled to
 * believe.
 *
 * `stripComments` DELETES the comment (keeping newlines, so line numbers still
 * match the file on disk) and this scan reports no offsets or positions, so it
 * is the correct one of the two exports here: prose still cannot satisfy the
 * check — the text is gone entirely — and the 500 characters are 500 characters
 * of CODE. Both directions of the §2 defect are closed at once, and both are
 * pinned by the controls at the bottom of this block.
 *
 * KNOWN BLIND SPOT, stated beside the number (CLAUDE.md §2): this is a TEXTUAL
 * check over a 500-character window of a `.from()` chain. It cannot see a filter
 * applied through a helper, a predicate more than 500 characters downstream, or
 * the difference between a predicate that always runs and one behind an `if`.
 * Files named `*simulator*`, `*guard*` and `*.test.*` are excluded by scanNameOk(),
 * and the corpus is `app/` + `lib/` PLUS the root-level runtime files (proxy.ts,
 * types.ts) — which a directory walk could not reach and which no guard in this
 * repository had ever opened.
 */
function unscopedTablesIn(raw: string): Map<string, number> {
  const found = new Map<string, number>()
  const src = stripComments(raw)
  for (const table of TENANT_TABLES) {
    const needle = `.from("${table}")`
    let idx = src.indexOf(needle)
    while (idx !== -1) {
      // storage.from("documents") is a BUCKET, not the documents table —
      // storage paths are tenant-prefixed by convention, not by .eq().
      //
      // THIS TEST USED TO MEASURE 12 CHARACTERS: `src.slice(idx - 12, idx)`.
      // That is a distance heuristic over RAW TEXT, and raw text carries
      // formatting. It matched the one-line `supabase.storage.from("documents")`
      // — which is exactly the shape the control below was written in, so the
      // control passed — and MISSED the wrapped form that real call sites use:
      //
      //     await supabase.storage
      //       .from("documents")
      //
      // where a newline plus indentation pushes "storage" past the twelfth
      // character. Two correct storage uploads were reported as cross-tenant
      // table reads, which is the §2 failure in its most expensive direction:
      // not a guard that misses a defect, but a guard that accuses live code and
      // sends someone to "fix" a bucket upload by adding a brokerage_id filter
      // to it.
      //
      // Measure the RECEIVER instead of the distance. Everything between the
      // previous statement boundary and this `.from(` is the expression the call
      // hangs off; if `.storage` appears anywhere in that chain, this is a bucket
      // no matter how it is wrapped, aligned, or commented. Formatting cannot
      // move a token across a statement boundary, so this cannot be reopened by
      // a prettier config.
      const chainStart = Math.max(
        src.lastIndexOf(";", idx),
        src.lastIndexOf("{", idx),
        src.lastIndexOf("}", idx),
        src.lastIndexOf("(", idx),
        src.lastIndexOf(",", idx),
        src.lastIndexOf("=", idx),
      )
      const receiver = src.slice(chainStart + 1, idx)
      if (/\.\s*storage\b/.test(receiver) || /\bstorage\s*$/.test(receiver.trimEnd())) {
        idx = src.indexOf(needle, idx + 1)
        continue
      }
      const window = src.slice(idx, idx + WINDOW)
      // Head-only counts (count/head:true aggregate) still leak counts — no exemption.
      const scoped = SCOPE_EVIDENCE.some((e) => window.includes(e))
      if (!scoped) found.set(table, (found.get(table) ?? 0) + 1)
      idx = src.indexOf(needle, idx + 1)
    }
  }
  return found
}

// ── POSITIVE CONTROLS ────────────────────────────────────────────────────────
// A broken finder and a clean tree both report zero, so "0 found" is only a
// measurement once the finder has been shown to still recognise the defect it
// was written for (CLAUDE.md §2). These run against unscopedTablesIn — the SAME
// function that judges the repo — before any verdict is printed, and they exit
// non-zero rather than degrading to a pass, because a guard that cannot prove
// itself must refuse, not wave the build through (CLAUDE.md §4, fail closed).
{
  const controls: Array<{ name: string; src: string; expect: number; why: string }> = [
    {
      name: "a genuinely unscoped read is REPORTED",
      expect: 1,
      why: "the finder no longer recognises the defect it exists to catch — everything below this line is a false all-clear",
      src: `const { data } = await supabase.from("leads").select("*").order("created_at")`,
    },
    {
      name: "a brokerage_id that appears ONLY IN A COMMENT does NOT satisfy the check",
      expect: 1,
      why:
        "prose is being read as scoping evidence again — this is the ORIGINAL defect, and it is silent: " +
        "the guard keeps printing PASS while nine commented brokerage_id mentions vouch for an unfiltered query",
      src: [
        "const { data } = await supabase",
        '  .from("transactions")',
        "  // The tenant stamp comes from brokerage_id on the row below, which is",
        "  // why this read does not need its own brokerage_id predicate.",
        '  .select("id, amount")',
      ].join("\n"),
    },
    {
      name: "a REAL predicate behind a long comment block is still SEEN (no whitespace-budget blind spot)",
      expect: 0,
      why:
        "comment removal is leaving whitespace in the chain window again (blankComments instead of stripComments), " +
        "so correctly scoped queries are being accused — the direction that gets a guard's real findings ignored",
      src: [
        "const { data } = await supabase",
        '  .from("offers")',
        // Deliberately longer than WINDOW: if this text is BLANKED rather than
        // deleted, the .eq() below lands outside the 500-char budget and this
        // control flips to a false accusation.
        `  /* ${"documentation. ".repeat(60)} */`,
        '  .select("id, offer_price")',
        '  .eq("brokerage_id", access.brokerageId)',
      ].join("\n"),
    },
    {
      name: "an ordinary scoped read is NOT reported",
      expect: 0,
      why: "the finder has started accusing live, correctly scoped code",
      src: `const { data } = await supabase.from("leads").select("*").eq("brokerage_id", ctx.brokerageId)`,
    },
    {
      name: "a storage BUCKET named like a tenant table is NOT reported",
      expect: 0,
      why: "the storage-bucket exemption broke; every signed-URL call site would now read as a tenant leak",
      src: `const { data } = await supabase.storage.from("documents").createSignedUrl(path, 60)`,
    },
    {
      // THE SHAPE THAT ACTUALLY BROKE. The control above is written on ONE LINE,
      // and the old 12-character look-back passed it for that reason alone — so
      // the control reported a healthy exemption while the exemption was blind
      // to every wrapped call site in the repo. A control that only exercises
      // the convenient formatting is not a control; it is the same assumption
      // twice. Both real sites (app/api/webhooks/inbound-mail/route.ts and
      // lib/kernel/reporting.ts) wrap exactly like this.
      name: "…and it is STILL not reported when the chain wraps across lines",
      expect: 0,
      why: "the exemption is measuring distance in raw text again — a newline and an indent will re-break it",
      src: [
        `const { data: up, error: upErr } = await supabase.storage`,
        `  .from("documents")`,
        `  .upload(path, buf, { contentType: att.mime, upsert: false })`,
      ].join("\n"),
    },
    {
      // The inverse, so the fix cannot be "exempt everything named documents".
      // A genuine unscoped read of the documents TABLE must still be reported,
      // wrapped or not — otherwise this repair would have traded a false alarm
      // for a real blind spot, which is the worse trade.
      name: "a wrapped read of the tenant TABLE is still REPORTED",
      expect: 1,
      why: "the storage exemption has widened into a table exemption — real cross-tenant reads now pass",
      src: [
        `const { data } = await supabase`,
        `  .from("documents")`,
        `  .select("id, storage_url")`,
      ].join("\n"),
    },
    {
      // THE FIXED FORM MUST READ AS FIXED. A chain scoped through
      // lib/kernel/tenant-scope.ts carries no literal "brokerage_id" at all, and
      // before `applyTenantScope` joined SCOPE_EVIDENCE this guard reported a NEW
      // unscoped query for a site that had just been made stricter — which is the
      // shape that teaches people to ignore a guard's real findings.
      name: "a chain scoped through applyTenantScope is NOT reported",
      expect: 0,
      why: "converting a site to the explicit TenantScope discriminator would ACCUSE it, so nobody could tell a repair from a regression",
      src: [
        `const query = supabase.from("listings").select("id, address").eq("status", "active")`,
        `const { data } = await applyTenantScope(query, scope)`,
      ].join("\n"),
    },
    {
      // …and the inverse, so the new entry cannot become a free pass: naming the
      // helper somewhere in the file must not excuse an unrelated unscoped read.
      // The window is per-chain, and this control is what pins that.
      name: "…and an unscoped read is STILL reported when applyTenantScope is far away",
      expect: 1,
      why: "the new evidence entry has widened from a per-chain test into a per-file amnesty",
      src: [
        `const scoped = await applyTenantScope(other, scope)`,
        `/* ${"prose. ".repeat(120)} */`,
        `const { data } = await supabase.from("leads").select("id")`,
      ].join("\n"),
    },
  ]
  let controlFailed = false
  for (const c of controls) {
    const got = [...unscopedTablesIn(c.src).values()].reduce((a, b) => a + b, 0)
    if (got === c.expect) console.log(`  ✓ control · ${c.name}`)
    else {
      controlFailed = true
      console.log(`  ✗ CONTROL FAILED · ${c.name} — expected ${c.expect}, got ${got}`)
      console.log(`      ${c.why}`)
    }
  }
  if (controlFailed) {
    console.log(" ❌ TENANT_SCOPE_CONTROL_FAIL — the finder cannot prove it still works, so its zero means nothing")
    process.exit(1)
  }
}

const violations = new Map<string, number>() // "file :: table" → count
let scanned = 0
for (const abs of scanCorpus(["app", "lib"])) {
  scanned += 1
  for (const [table, count] of unscopedTablesIn(readFileSync(abs, "utf8"))) {
    const key = `${relative(root, abs).replace(/\\/g, "/")} :: ${table}`
    violations.set(key, (violations.get(key) ?? 0) + count)
  }
}

const baseline: Record<string, number> = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : {}

if (process.env.TENANT_SCOPE_BASELINE === "1") {
  const snap: Record<string, number> = {}
  for (const [k, v] of [...violations.entries()].sort()) snap[k] = v
  writeFileSync(baselinePath, `${JSON.stringify(snap, null, 2)}\n`)
  console.log(`Baseline written: ${violations.size} known-unscoped site(s) frozen (surface can only shrink)`)
  process.exit(0)
}

let newViolations = 0
let shrunk = 0
const failures: string[] = []
for (const [key, count] of violations.entries()) {
  const allowed = baseline[key] ?? 0
  if (count > allowed) {
    newViolations += count - allowed
    failures.push(`${key} — ${count} unscoped quer${count === 1 ? "y" : "ies"} (baseline ${allowed})`)
  }
}
for (const [key, allowed] of Object.entries(baseline)) {
  const current = violations.get(key) ?? 0
  if (current < allowed) shrunk += allowed - current
}

console.log(`\n── TENANT-SCOPE GUARD ──`)
console.log(`  ${scanned} files scanned · ${violations.size} site(s) with unscoped tenant-table queries · baseline debt ${Object.values(baseline).reduce((a, b) => a + b, 0)}`)
if (shrunk > 0) console.log(`  ↓ ${shrunk} baseline site(s) fixed — run TENANT_SCOPE_BASELINE=1 to tighten the baseline`)
if (newViolations > 0) {
  console.log(`  ✗ ${newViolations} NEW unscoped tenant-table quer${newViolations === 1 ? "y" : "ies"} — add a brokerage_id filter (or a validated id lookup):`)
  for (const f of failures) console.log(`     - ${f}`)
  console.log(" ❌ TENANT_SCOPE_FAIL — cross-tenant reads must be impossible BY CI, not by diligence")
  process.exit(1)
}
console.log(" ✅ TENANT_SCOPE_PASS — no new unscoped tenant-table queries (the surface can only shrink)")

// ── CHECK 2: binding a FREE-TEXT-identified user into the caller's tenant ─────
//
// A different shape from the unscoped-table reads above, and one this guard used to
// miss entirely. Three surfaces in this codebase resolved a user from an
// attacker-supplied string — an email typed into a form field — with NO brokerage
// filter, then wrote a row carrying the CALLER's brokerage_id and that foreign
// user_id. The row looks correctly scoped in isolation; the binding is what crosses
// the tenant line. (Academy assign-to-agent, academy assign-to-staff, and the
// feature-governance trial grant were the three; all now scope the lookup.)
//
// Some global lookups are correct and must NOT be forced to scope — you cannot filter
// by tenant before the user has one. Each exemption below names WHY, so a future
// reader can challenge it rather than assume it was rubber-stamped.
const GLOBAL_LOOKUP_EXEMPT: Record<string, string> = {
  "app/actions/auth/signup-brokerage.ts":
    "signup — the tenant does not exist yet",
  "lib/platform/subscriber-door.ts":
    "the subscriber door's sales-assisted intake (lane 79D) — an existing OWNER is looked up by email BEFORE any tenant exists so a second tenant is never minted for a subscriber who already has one; it returns 'sign in', never the row",
  "lib/kernel/tenant-creation.ts":
    "the ONE tenant-creation core (lane 77B) — the duplicate-owner guard looks the email up before the tenant exists; every door (signup, staff, prospect conversion) delegates here",
  "app/actions/privacy/data-subject-requests.ts":
    "DSAR intake resolves WHICH tenant the subject belongs to; fulfillment is separately role-gated",
  "app/actions/superadmin/platform-staff.ts":
    "platform staff administration is global BY DEFINITION and is superadmin-gated",
  "app/api/recruiting/provision-agent/route.ts":
    "looks up by recruit.email where the recruit row is already brokerage-scoped; auth emails are global",
  "lib/kernel/users.ts":
    "resolveEmailHolder MUST search globally — users.email is unique platform-wide and a stale holder would break the invite. The BINDING is what needed guarding, and inviteTenantMember now refuses to re-home a user who already belongs to another brokerage unless the caller is a superadmin.",
  "lib/platform/referral-payouts.ts":
    "resolveReferralRecipient answers a PLATFORM question — WHICH tenant the free-text referrer on a platform_prospect belongs to (users.email is unique platform-wide; there is no caller tenant to scope by). Callers are billing-gated superadmin actions; the resolved brokerage only ever RECEIVES a payout row on its own billing surface, and the recipient-side read/acknowledge path is separately session-scoped (app/actions/admin/referral-earnings.ts).",
}

{
  const LOOKUP_RE = /from\((["'])users\1\)([\s\S]{0,300}?)\.eq\((["'])(email|phone|username)\3/g

  /**
   * Same shape as unscopedTablesIn, and for the same reason: the controls below
   * have to exercise the function that judges the repo, not a paraphrase of it.
   * Returns the free-text field of each unscoped `users` lookup found.
   *
   * COMMENTS ARE REMOVED, NOT BLANKED — this scan reports a file and a field and
   * never an offset, and it is windowed twice (`{0,300}?` before the predicate,
   * 300 characters after), so blanked comments would spend both budgets on
   * whitespace: a long note between `.from("users")` and `.eq("email")` would
   * push the pair past the lazy quantifier and the lookup would go UNSEEN, and a
   * note before `.eq("brokerage_id")` would push the predicate out of the trailing
   * window and a correctly scoped lookup would be ACCUSED. Deleting the comment
   * text closes both, and prose still cannot vouch for a query because the prose
   * is gone. Pinned by the controls immediately below.
   */
  function unscopedUserLookupsIn(raw: string): string[] {
    const src = stripComments(raw)
    const out: string[] = []
    LOOKUP_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LOOKUP_RE.exec(src))) {
      const window = m[2] + src.slice(LOOKUP_RE.lastIndex, LOOKUP_RE.lastIndex + 300)
      if (!/\.eq\((["'])brokerage_id\1/.test(window)) out.push(m[4])
    }
    return out
  }

  // ── POSITIVE CONTROLS (see the note on the first set — same rule, same reason) ──
  {
    const controls: Array<{ name: string; src: string; expect: number; why: string }> = [
      {
        name: "an unscoped free-text users lookup is REPORTED",
        expect: 1,
        why: "the finder no longer recognises the binding defect — its zero is meaningless",
        src: `const { data } = await supabase.from("users").select("id").eq("email", form.email).maybeSingle()`,
      },
      {
        name: "a brokerage_id that appears ONLY IN A COMMENT does NOT satisfy the binding check",
        expect: 1,
        why: "prose is vouching for a lookup again — a commented brokerage_id is documentation, not a predicate",
        src: [
          'const { data } = await supabase.from("users").select("id")',
          '  .eq("email", form.email)',
          "  // Scoped by brokerage_id further up, where the caller was resolved.",
          "  .maybeSingle()",
        ].join("\n"),
      },
      {
        name: "a REAL brokerage_id predicate behind a long comment block is still SEEN",
        expect: 0,
        why: "comment removal is leaving whitespace in the window again, so scoped lookups are being accused",
        src: [
          'const { data } = await supabase.from("users").select("id")',
          '  .eq("email", form.email)',
          `  /* ${"documentation. ".repeat(40)} */`,
          '  .eq("brokerage_id", ctx.brokerageId)',
        ].join("\n"),
      },
    ]
    let controlFailed = false
    for (const c of controls) {
      const got = unscopedUserLookupsIn(c.src).length
      if (got === c.expect) console.log(`  ✓ control · ${c.name}`)
      else {
        controlFailed = true
        console.log(`  ✗ CONTROL FAILED · ${c.name} — expected ${c.expect}, got ${got}`)
        console.log(`      ${c.why}`)
      }
    }
    if (controlFailed) {
      console.log(" ❌ TENANT_BINDING_CONTROL_FAIL — the finder cannot prove it still works, so its zero means nothing")
      process.exit(1)
    }
  }

  const offenders: string[] = []
  const scanDirs = ["app", "lib"]
  const allFiles: string[] = [...scanCorpus(scanDirs)]

  for (const file of allFiles) {
    const rel = relative(root, file)
    if (GLOBAL_LOOKUP_EXEMPT[rel]) continue
    for (const field of unscopedUserLookupsIn(readFileSync(file, "utf8"))) {
      offenders.push(`${rel} :: users.${field}`)
    }
  }

  console.log(`\n── TENANT-BINDING GUARD ──`)
  console.log(`  free-text user lookups must be tenant-scoped (${Object.keys(GLOBAL_LOOKUP_EXEMPT).length} documented global exemptions)`)
  if (offenders.length > 0) {
    console.log(`  ✗ ${offenders.length} unscoped free-text user lookup(s) — add .eq("brokerage_id", ...) or document why global is correct:`)
    for (const o of [...new Set(offenders)]) console.log(`     - ${o}`)
    console.log(" ❌ TENANT_BINDING_FAIL — a user resolved from a typed string must belong to the caller's tenant")
    process.exit(1)
  }
  console.log("  ✅ TENANT_BINDING_PASS — no surface binds a foreign user via a typed identifier")
}

// ── CHECK 3: a caller-supplied tenant id forwarded unverified into a SERVICE-
// role query ─────────────────────────────────────────────────────────────────
//
// wave 68C (CLAUDE.md §4 IDOR audit). The defect this closes, quoted from §4:
// "Body-supplied `brokerageId` on a service client is the IDOR shape found
// repeatedly here." A function whose PARAMETER is named brokerageId /
// brokerage_id / tenantId / tenant_id, used verbatim (not reassigned from the
// SESSION first) inside a `.eq("brokerage_id"|"tenant_id", <that param>)` or an
// insert/update payload key `brokerage_id: <that param>` on a SERVICE client,
// lets any authenticated caller read or write another tenant's rows by simply
// naming a different id. Fixed this wave (the pattern every future finding
// should follow — resolve `getAgentContext()`, session wins, the parameter is
// accepted-and-ignored): app/actions/ai-isa-settings.ts::getAIISAStats,
// app/actions/transaction-compliance.ts (five exports), and
// app/actions/campaign-sequences.ts::listCampaignSequences.
//
// SCOPE, PER-FUNCTION: each `export async function NAME(...) { ... }` (brace-
// balanced body) is scanned on its own — a shadow in one export does not
// silence a sibling export in the same file.
//
// KNOWN BLIND SPOTS (CLAUDE.md §2):
//   · CLOSED lane 92A: arrow-function exports (`export const f = async (...) =>
//     { … }`) are walked like declarations (positive control below). An
//     EXPRESSION-bodied arrow (`=> fn(params)`, no block) is still skipped.
//   · CLOSED lane 92A: a NAMED object param (`input: SomeInput`) whose interface
//     or object type alias is declared IN THE SAME FILE is expanded to its keys
//     (transaction-hazard-insurance's `input: RecordHazardPolicyInput` was this
//     shape). A type IMPORTED from another module, `Partial<…>`/`Pick<…>`, or an
//     intersection is still unseen.
//   · CLOSED lane 92A: a MODULE-LEVEL service singleton and a file-local wrapper
//     that returns `createServiceClient()` count as service clients. A client
//     received as a PARAMETER of a "use server" export is not a hole by
//     construction (a Supabase client cannot cross the HTTP boundary); a wrapper
//     imported from another module is still unseen.
//   · CLOSED lane 91D2 (wave 91): a parameter carried inside an inline typed
//     OBJECT parameter (`params: { brokerageId: string }`, read back as
//     `params.brokerageId`) is now walked, as is the same object handed WHOLE (or
//     spread without the tenant key overridden) to a `@/lib/kernel/*` command,
//     and a body-supplied ROLE key (`requestingUserRole` / `userRole`) forwarded
//     the same way. The live walkthrough found this exact shape on four
//     transaction lifecycle actions (closeTransaction's pre-91D signature is
//     replayed as a positive control below). A named-interface object param
//     (`input: SomeInput`) is still invisible.
//   · "shadowed" is textual: a `const brokerageId = ctx.brokerageId`-shaped
//     reassignment ANYWHERE earlier in the same function body silences every
//     later raw use, so a shadow that runs only on one code path (e.g. inside an
//     `if`) can hide a raw use on another path.
//   · the service-client variable must be created INSIDE the same function
//     (`createServiceClient()`/`createAdminClient()`, assigned OR used inline as
//     `createServiceClient().from(…)` — the inline form is walked since lane
//     91D2), or be a module-level singleton / file-local wrapper (lane 92A).
//   · whole-object hand-off is judged only for callees imported from
//     `@/lib/kernel/*` (static or dynamic import); a lib/application or other
//     service-backed callee is unseen.
const SERVICE_ID_EXEMPT: Record<string, string> = {
  "app/actions/home-value.ts::scheduleSellerListingAppointment":
    "PUBLIC lane by design (lane 91D2 review) — an unauthenticated seller on the result page books here; there is no session tenant. The agent AND the contact are both re-read under `.eq(\"brokerage_id\", args.brokerageId)` BEFORE any write and the booking refuses unless both belong to it, so the id is a consistency key, not a grant. Same shape as getListingAppointmentSlots below.",
  "app/actions/lead-promotion/promote-lead.ts::listRawLeadsForReview":
    "platform-only surface (lane 91D2 review): refuses unless the caller is platform staff (users.platform_role / user_type read from the session row) before the optional brokerageId filter is applied — a TARGET tenant for a platform reviewer. Its platform test is a local role list, not one of the named platform gates, which is why it is listed rather than auto-exempted.",
  "app/actions/home-value-lead.ts::captureHomeValueLead":
    "PUBLIC lane by design (lane 92A review, surfaced once the guard could read the NAMED `input: HomeValueLeadInput` param) — an unauthenticated homeowner on /home-value/[agentSlug]; there is no session tenant. Before ANY write the action re-reads `agents` under `.eq(id, input.agentId).eq(brokerage_id, input.brokerageId).eq(user_id, input.agentUserId)` and refuses unless that one row exists, so the ids are a consistency key, not a grant. Same shape as scheduleSellerListingAppointment above.",
  "app/actions/lead-magnet-capture.ts::captureFormSubmissionAction":
    "PUBLIC lane by design (lane 92A review, surfaced once the guard could read the NAMED `input: CaptureFormInput` param) — the /lm/[slug] form an anonymous visitor submits; there is no session tenant. The kernel command it hands off to (lib/kernel/lead-magnets.ts captureFormSubmission) reads `lead_capture_forms` under `.eq(id, formId).eq(brokerage_id, brokerageId)` and refuses before any write unless the form belongs to that brokerage — a consistency key, not a grant.",
  "app/actions/home-value.ts::getListingAppointmentSlots":
    "PUBLIC lane by design — the result page and portal reach this with NO agent session at all; the brokerageId IS the scope (there is no session brokerage to prefer) and the row returned is an agent directory (name/photo/phone), not tenant financial or client data. Comment at the call site names this explicitly.",
  "app/actions/superadmin/tenant-entitlements.ts::getTenantEntitlementsAction":
    "platform-staff act-as/support surface, gated by requireSuperadmin() (platform_role) before the id is used — a target brokerage id is the whole point of a superadmin console.",
  "app/actions/superadmin/brokerage-management.ts::getBrokerageDetailAction":
    "platform-staff act-as/support surface, gated by requireSuperadmin() (platform_role).",
  "app/actions/superadmin/brokerage-management.ts::reactivateBrokerageAction":
    "platform-staff act-as/support surface, gated by requireSuperadmin() (platform_role).",
  "app/actions/superadmin/coupons.ts::redeemCouponForBrokerageAction":
    "platform-staff act-as/support surface, gated by requirePlatformCapability('billing') (platform_role).",
  "app/actions/superadmin/tenant-setup.ts::getTenantSetupReadinessAction":
    "platform-staff act-as/support surface, gated by requirePlatformCapability('tenants') (platform_role).",
  "app/actions/superadmin/tenant-users.ts::listTenantUsersAction":
    "platform-staff act-as/support surface, gated by requirePlatformCapability('tenants') (platform_role).",
  "app/actions/superadmin/portal-clients.ts::backfillPortalClientUsersAction":
    "platform-staff act-as/support surface, gated by requirePlatformCapability('tenants') (platform_role).",
  "app/actions/superadmin/tenant-message.ts::listMessageableAdminsAction":
    "platform-staff act-as/support surface, gated by requirePlatformCapability('support') (platform_role).",
  "app/actions/lead-import/crm-pull-actions.ts::getCrmImportStatusAction":
    "platform-staff white-glove migration surface, gated by gateStaffAction('tenants') (platform_role) — tenant is the operator's TARGET by design, never the operator's own.",
  "app/actions/superadmin/active-listing-sources.ts::getBrokerageActiveListingSourcesAction":
    "platform-staff act-as/support surface, gated by requireSuperadmin() (platform_role) — the target brokerage is a superadmin console's whole point, same shape as getBrokerageDetailAction above.",
}

{
  const PLATFORM_GATED_SEEN: string[] = []
  const TARGET_PARAM_NAMES = ["brokerageId", "brokerage_id", "tenantId", "tenant_id"]
  // A body-supplied ROLE is the same defect one step up: reopenTransactionIfAuthorized
  // (pre-91D) accepted `requestingUserRole` and its only caller sends "broker".
  const ROLE_PARAM_NAMES = ["requestingUserRole", "userRole"]
  // A shadow is ANY local (const/let) redeclaration of the same name inside the
  // function body — this codebase resolves the session tenant through dozens of
  // differently-named helpers (ctx, auth, gate, session, profile, requireCaller,
  // resolveFinancialContext, scopeForBrokerage, …), so matching by HELPER NAME
  // false-accused every one this guard did not happen to know (acceptOffer's own
  // `const brokerageId = auth.brokerageId` from a local `requireCaller()`, for
  // one). Matching by SHADOWED, not by source, trades a theoretical miss (a
  // redeclaration from something that is not actually session-derived) for not
  // re-accusing code that already resolves tenant from the session under a name
  // this guard has never seen — the far more common shape in this repo.

  /**
   * One finding per (file, function, param) where the param reaches a SERVICE
   * client `.eq(...)`/payload key unshadowed. Same rule as CHECK 1/2: this is
   * the function the positive controls exercise, not a paraphrase of it.
   */
  /**
   * Index of the `{` that opens a function BODY, given the index just past the
   * parameter list's `)`. Lane 91D2: the previous `src.indexOf("{", …)` took the
   * first brace after the signature, which for `): Promise<{ success: boolean }> {`
   * is the RETURN TYPE's object literal — every export annotated that way was
   * scanned as a one-line "body" and could never be reported (closeTransaction's
   * pre-91D signature was exactly this). A `{` that follows `:`, `<`, `|`, `&`,
   * `,` or `(` is a type literal; the body's `{` follows a completed type.
   */
  function functionBodyStart(src: string, from: number): number {
    let angle = 0, paren = 0, brace = 0, bracket = 0
    let prev = ")"
    for (let i = from; i < src.length; i++) {
      const c = src[i]
      if (/\s/.test(c)) continue
      if (c === "{" && angle === 0 && paren === 0 && brace === 0 && bracket === 0 && !/[:<|&,(=]/.test(prev)) return i
      if (c === "<") angle++
      else if (c === ">" && src[i - 1] !== "=") angle = Math.max(0, angle - 1)
      else if (c === "(") paren++
      else if (c === ")") paren--
      else if (c === "{") brace++
      else if (c === "}") brace--
      else if (c === "[") bracket++
      else if (c === "]") bracket--
      prev = c
    }
    return -1
  }

  function unverifiedServiceTenantIdsIn(raw: string): Array<{ fn: string; param: string }> {
    const src = stripComments(raw)
    const out: Array<{ fn: string; param: string }> = []
    // PLATFORM AUTHORITY (lane 91D2). A platform-staff console action names a
    // TARGET tenant by design — the eleven SERVICE_ID_EXEMPT entries below were
    // all this one shape, written out by hand. A body whose FIRST gate (before
    // the tenant id's first service-client use) is a platform-authority gate is
    // that shape by construction; file-local aliases (`const gate = () =>
    // gateStaffAction("tenants")`) are followed. Controls pin that a gate AFTER
    // the use, or only in a comment, exempts nothing.
    const aliases = [...src.matchAll(/const\s+(\w+)\s*=\s*\(\s*\)\s*=>\s*(?:requirePlatformCapability|gateStaffAction|requireSuperadmin|requireProviders)\s*\(/g)].map((a) => a[1])
    const platformGateRe = new RegExp(
      `\\b(?:requireSuperadmin|requirePlatformCapability|gateStaffAction|requireProviders|isPlatformSuperadminIdentity|isPlatformStaffIdentity${aliases.map((a) => `|${a}`).join("")})\\s*\\(`,
    )
    const platformGatedBefore = (body: string, idx: number): boolean => {
      const g = platformGateRe.exec(body)
      return !!g && g.index < idx
    }
    // Names this file imports from a kernel command module (static or dynamic).
    const kernelFns = new Set<string>()
    for (const km of src.matchAll(/(?:import|const)\s*\{([^}]*)\}\s*(?:from|=\s*await\s+import\()\s*["']@\/lib\/kernel\/[^"']+["']/g)) {
      for (const part of km[1].split(",")) {
        const nm = part.trim().split(/\s+as\s+|\s*:\s*/).pop()?.trim()
        if (nm && /^\w+$/.test(nm) && nm !== "type") kernelFns.add(nm)
      }
    }
    // ── lane 92A: three published blind spots closed ──────────────────────
    // (1) NAMED object types. `input: RecordHazardPolicyInput` was invisible: only an
    //     inline `{ … }` param was walked. A param typed by an interface / object type
    //     alias DECLARED IN THIS FILE is expanded to its members (nested object
    //     members flattened away, so only the param's own keys count). A type imported
    //     from another module is still unseen (published below).
    const localObjectTypes = new Map<string, string>()
    for (const tm of src.matchAll(/\b(?:interface\s+(\w+)(?:\s+extends\s+[^{]+)?\s*\{|type\s+(\w+)\s*=\s*\{)/g)) {
      const typeName = tm[1] ?? tm[2]
      const open = (tm.index ?? 0) + tm[0].length - 1
      let d = 0
      let j = open
      for (; j < src.length; j++) {
        if (src[j] === "{") d++
        else if (src[j] === "}") { d--; if (d === 0) break }
      }
      let inner = src.slice(open + 1, j)
      while (/\{[^{}]*\}/.test(inner)) inner = inner.replace(/\{[^{}]*\}/g, "")
      localObjectTypes.set(typeName, inner)
    }
    const expandNamedTypes = (list: string): string =>
      list.replace(/(\w+)(\s*\??\s*:\s*)([A-Z]\w*)\b(?!\s*[<.[])/g, (all, n: string, sep: string, t: string) =>
        localObjectTypes.has(t) ? `${n}${sep}{${localObjectTypes.get(t)}}` : all)
    // (3) SERVICE-CLIENT FACTORIES beyond the two constructors: a file-local wrapper
    //     (`function svc() { return createServiceClient() }` / `const svc = () =>
    //     createServiceClient()`) and a MODULE-LEVEL singleton (`const admin =
    //     createServiceClient()` at column 0, visible to every export in the file).
    const svcFactoryNames = ["createServiceClient", "createAdminClient"]
    for (const w of src.matchAll(/function\s+(\w+)\s*\([^)]*\)[^{]*\{\s*return\s+(?:createServiceClient|createAdminClient)\s*\(/g)) svcFactoryNames.push(w[1])
    for (const w of src.matchAll(/const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*(?:createServiceClient|createAdminClient)\s*\(/g)) svcFactoryNames.push(w[1])
    const svcFactory = `(?:${svcFactoryNames.join("|")})`
    const moduleSvcVars = new Set<string>()
    for (const g of src.matchAll(new RegExp(`^(?:const|let)\\s+(\\w+)\\s*=\\s*(?:await\\s+)?${svcFactory}\\s*\\(`, "gm"))) {
      if (!svcFactoryNames.includes(g[1])) moduleSvcVars.add(g[1])
    }

    // (2) ARROW-FUNCTION exports: `export const f = async (…) => { … }` is walked the
    //     same as a declaration. An expression-bodied arrow (no `{` body) is skipped.
    type Exported = { fnName: string; paramList: string; after: number; arrow: boolean }
    const exported: Exported[] = []
    for (const fm of src.matchAll(/export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)/g)) {
      exported.push({ fnName: fm[1], paramList: fm[2], after: (fm.index ?? 0) + fm[0].length, arrow: false })
    }
    for (const am of src.matchAll(/export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*async\s*\(([^)]*)\)/g)) {
      exported.push({ fnName: am[1], paramList: am[2], after: (am.index ?? 0) + am[0].length, arrow: true })
    }
    for (const ex of exported) {
      const fnName = ex.fnName
      const paramList = expandNamedTypes(ex.paramList)
      const targets = TARGET_PARAM_NAMES.filter((n) => new RegExp(`\\b${n}\\b`).test(paramList))
      if (targets.length === 0) continue

      // Brace-balance the body starting at the first `{` after the signature.
      const bodyStart = functionBodyStart(src, ex.after)
      if (bodyStart === -1) continue
      if (ex.arrow && !src.slice(ex.after, bodyStart).trimEnd().endsWith("=>")) continue
      let depth = 0
      let i = bodyStart
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++
        else if (src[i] === "}") {
          depth--
          if (depth === 0) break
        }
      }
      const body = src.slice(bodyStart, i + 1)

      // Service-client variable names created INSIDE this body, plus the module's
      // singletons (lane 92A) unless this body redeclares the name.
      const svcVars = new Set<string>()
      const SVC_RE = new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*(?:await\\s+)?${svcFactory}\\s*\\(`, "g")
      let sm: RegExpExecArray | null
      while ((sm = SVC_RE.exec(body))) svcVars.add(sm[1])
      for (const v of moduleSvcVars) {
        if (!new RegExp(`(?:const|let)\\s+${v}\\s*=`).test(body)) svcVars.add(v)
      }
      // Inline form: `createServiceClient().from(…)` — no variable to name.
      const inlineSvc = new RegExp(`${svcFactory}\\s*\\(\\s*\\)\\s*\\.from\\(`).test(body)

      // ── lane 91D2: OBJECT-carried tenant / role keys ────────────────────
      // `params: { …brokerageId… }` read back as `params.brokerageId`, and the
      // object handed whole to a kernel command. A member is VERIFIED when the
      // body compares it to something (`!==`/`===` — the session-mismatch
      // refusal) or passes it into a require*/assert*/verify* gate, anywhere
      // before its first use.
      {
        const OBJ_RE = /(\w+)\s*\??\s*:\s*\{([^{}]*)\}/g
        let om: RegExpExecArray | null
        while ((om = OBJ_RE.exec(paramList))) {
          const objName = om[1]
          const inner = om[2]
          const keys = [...TARGET_PARAM_NAMES, ...ROLE_PARAM_NAMES].filter((k) => new RegExp(`(?<![\\w])${k}\\s*\\??\\s*:`).test(inner))
          if (keys.length === 0) continue
          for (const key of keys) {
            const member = `${objName}\\.${key}\\b`
            const verifiedRe = new RegExp(
              `${member}\\s*(?:!==|===)|(?:!==|===)\\s*${member}` +
              // passed into a gate that asserts it against the session
              `|\\b(?:require|assert|verify|session|resolve\\w*Tenant|\\w*Tenant)\\w*\\([^)]*${member}` +
              // or the object re-keyed from a gate before use: params = { ...params, brokerageId: tenant.brokerageId }
              `|\\b${objName}\\s*=\\s*\\{\\s*\\.\\.\\.${objName}\\b[^}]*\\b${key}\\s*:`,
            )
            const svcParts = [...svcVars].map((v) => `\\b${v}\\b`)
            if (inlineSvc) svcParts.push(`${svcFactory}\\s*\\(\\s*\\)`)
            const uses: number[] = []
            if (svcParts.length) {
              const svcAlt = svcParts.join("|")
              const eq = new RegExp(`(?:${svcAlt})[\\s\\S]{0,400}?\\.eq\\(\\s*["'\`](?:brokerage_id|tenant_id|owner_id)["'\`]\\s*,\\s*${member}\\s*\\)`).exec(body)
              const pay = new RegExp(`(?:${svcAlt})[\\s\\S]{0,200}?\\b(?:brokerage_id|tenant_id)\\s*:\\s*${member}\\s*[,}]`).exec(body)
              if (eq) uses.push(eq.index); if (pay) uses.push(pay.index)
            }
            // Hand-off to a kernel command: the whole object, a spread that does
            // not re-key the tenant/role afterwards, or the member as an argument.
            for (const k of kernelFns) {
              const whole = new RegExp(`\\b${k}\\(\\s*${objName}\\s*[,)]`).exec(body)
              if (whole) uses.push(whole.index)
              const spread = new RegExp(`\\b${k}\\(\\s*\\{\\s*\\.\\.\\.${objName}\\b([^}]*)\\}`).exec(body)
              if (spread && !new RegExp(`\\b${key}\\s*:`).test(spread[1])) uses.push(spread.index)
              // The USE is the member's own position (this codebase writes no
              // semicolons, so the call's extent is bounded by length, not `;`).
              const arg = new RegExp(`\\b${k}\\([\\s\\S]{0,400}?\\b\\w+\\s*:\\s*${member}`).exec(body)
              if (arg) uses.push(arg.index + arg[0].length)
            }
            if (uses.length === 0) continue
            const first = Math.min(...uses)
            const ver = verifiedRe.exec(body)
            if (ver && ver.index < first) continue
            if (platformGatedBefore(body, first)) { PLATFORM_GATED_SEEN.push(fnName); continue }
            out.push({ fn: fnName, param: `${objName}.${key}` })
          }
        }
      }
      if (svcVars.size === 0 && !inlineSvc) continue

      for (const param of targets) {
        // Shadowed anywhere in the body BEFORE a raw use silences this param —
        // a local (const/let) redeclaration of the same name, destructured or
        // plain, from ANY source (see the note above this block).
        const shadowRe = new RegExp(
          `(?:const|let)\\s*(?:\\{[^}]*\\b${param}\\b[^}]*\\}|${param})\\s*(?::\\s*[^=;\\n]+)?=`,
        )
        const shadowMatch = shadowRe.exec(body)

        // Raw use: <svcVar>....eq("brokerage_id"|"tenant_id", param) within 400
        // chars, or a payload key `brokerage_id: param` / `tenant_id: param`
        // within 200 chars after a <svcVar> call.
        const svcParts = [...svcVars].map((v) => `\\b${v}\\b`)
        if (inlineSvc) svcParts.push(`${svcFactory}\\s*\\(\\s*\\)`)
        const svcAlt = svcParts.join("|")
        const eqRe = new RegExp(
          `(?:${svcAlt})[\\s\\S]{0,400}?\\.eq\\(\\s*["'\`](?:brokerage_id|tenant_id|owner_id)["'\`]\\s*,\\s*${param}\\s*\\)`,
        )
        const payloadRe = new RegExp(
          `(?:${svcAlt})[\\s\\S]{0,200}?\\b(?:brokerage_id|tenant_id)\\s*:\\s*${param}\\s*[,}]`,
        )
        const eqMatch = eqRe.exec(body)
        const payloadMatch = payloadRe.exec(body)
        const useMatch = eqMatch ?? payloadMatch
        if (!useMatch) continue
        if (shadowMatch && shadowMatch.index < useMatch.index) continue // shadowed before the use
        if (platformGatedBefore(body, useMatch.index)) { PLATFORM_GATED_SEEN.push(fnName); continue } // platform staff naming a TARGET tenant

        out.push({ fn: fnName, param })
      }
    }
    return out
  }

  // ── POSITIVE CONTROLS ──────────────────────────────────────────────────────
  {
    const controls: Array<{ name: string; src: string; expect: number; why: string }> = [
      {
        name: "a raw param forwarded into a SERVICE-client .eq(brokerage_id, …) is REPORTED",
        expect: 1,
        why: "the finder no longer recognises the IDOR shape §4 names — its zero means nothing",
        src: [
          "export async function getStats(brokerageId: string) {",
          "  const svc = createServiceClient()",
          '  const { data } = await svc.from("contacts").select("id").eq("brokerage_id", brokerageId)',
          "  return data",
          "}",
        ].join("\n"),
      },
      {
        name: "a raw param forwarded into a SERVICE-client insert payload is REPORTED",
        expect: 1,
        why: "the write half of the same shape is being missed",
        src: [
          "export async function seed(brokerageId: string) {",
          "  const svc = createServiceClient()",
          '  await svc.from("logs").insert({ brokerage_id: brokerageId, kind: "x" })',
          "}",
        ].join("\n"),
      },
      {
        name: "a param SHADOWED by getAgentContext() before use is NOT reported",
        expect: 0,
        why: "the fixed pattern (ctx wins, param accepted-and-ignored) is being accused — this is the false positive this guard must never produce",
        src: [
          "export async function getStats(_brokerageId: string) {",
          "  const ctx = await getAgentContext()",
          "  if (!ctx.isAuthenticated || !ctx.brokerageId) return null",
          "  const brokerageId = ctx.brokerageId",
          "  const svc = createServiceClient()",
          '  const { data } = await svc.from("contacts").select("id").eq("brokerage_id", brokerageId)',
          "  return data",
          "}",
        ].join("\n"),
      },
      {
        name: "REPLAY of pre-91D closeTransaction (object param handed whole to a kernel command) is REPORTED",
        expect: 1,
        why: "the walkthrough's finding is invisible again — a body brokerageId reaches a service-client kernel command through the object hand-off",
        src: [
          'export async function closeTransaction(params: {',
          '  transactionId: string',
          '  brokerageId: string',
          '  agentId: string',
          '  reason?: string',
          '}): Promise<{ success: boolean; error?: string }> {',
          '  if (!isValidUUID(params.transactionId)) return { success: false, error: "Invalid transaction ID" }',
          '  if (!isValidUUID(params.brokerageId)) return { success: false, error: "Invalid brokerage ID" }',
          '  const { closeTransactionCommand } = await import("@/lib/kernel/transactions")',
          '  return closeTransactionCommand(params)',
          '}',
        ].join("\n"),
      },
      {
        name: "REPLAY of pre-91D reopenTransactionIfAuthorized (body ROLE + brokerage handed whole) is REPORTED for both keys",
        expect: 2,
        why: "a self-asserted role or tenant forwarded to a kernel command is being missed",
        src: [
          'export async function reopenTransactionIfAuthorized(params: {',
          '  transactionId: string',
          '  brokerageId: string',
          '  requestingUserId: string',
          '  requestingUserRole: string',
          '  reason: string',
          '}): Promise<{ success: boolean; error?: string }> {',
          '  if (!["broker", "admin"].includes(params.requestingUserRole)) return { success: false }',
          '  const { reopenTransactionCommand } = await import("@/lib/kernel/transactions")',
          '  return reopenTransactionCommand(params)',
          '}',
        ].join("\n"),
      },
      {
        name: "the 91D FIX (session gate, tenant re-keyed from the gate) is NOT reported",
        expect: 0,
        why: "the fixed shape is being accused — the finder would push the next lane to undo a correct fix",
        src: [
          'export async function recalculateCommissionState(params: {',
          '  transactionId: string',
          '  brokerageId: string',
          '  agentId: string',
          '}): Promise<{ success: boolean; error?: string }> {',
          '  const gate = await requireTransactionActor(params.transactionId)',
          '  if (!gate.ok) return { success: false, error: gate.error }',
          '  const { recalculateCommissionStateCommand } = await import("@/lib/kernel/transactions")',
          '  return recalculateCommissionStateCommand({ ...params, brokerageId: gate.brokerageId })',
          '}',
        ].join("\n"),
      },
      {
        name: "an object-carried tenant on an INLINE service client (.eq(owner_id, data.brokerageId)) is REPORTED",
        expect: 1,
        why: "disconnectProvider's shape (pre-91D2) is invisible — inline createServiceClient().from() or the object member",
        src: [
          'export async function disconnect(data: { provider: string; brokerageId: string }) {',
          '  await createServiceClient().from("platform_credentials").update({ is_active: false })',
          '    .eq("owner_type", "brokerage").eq("owner_id", data.brokerageId)',
          '}',
        ].join("\n"),
      },
      {
        name: "an object-carried tenant ASSERTED against the session before use is NOT reported",
        expect: 0,
        why: "the mismatch-refusal pattern (lib/auth/require-caller.ts requireCallerTenant, the survivor transaction-inspections moved onto in lane 92A) is being accused",
        src: [
          'export async function act(params: { transactionId: string; brokerageId?: string }) {',
          '  const auth = await requireCallerTenant(params.brokerageId)',
          '  if (!auth.ok) return null',
          '  const svc = createServiceClient()',
          '  await svc.from("x").update({ a: 1 }).eq("brokerage_id", params.brokerageId)',
          '}',
        ].join("\n"),
      },
      {
        name: "a platform-staff action gated by requirePlatformCapability BEFORE the target tenant is used is NOT reported",
        expect: 0,
        why: "the superadmin console shape (a TARGET tenant is the point) is being accused",
        src: [
          'export async function extendTrial(params: { brokerageId: string; days: number }) {',
          '  const gate = await requirePlatformCapability("billing", { requireWrite: true })',
          '  if (!gate.ok) return { ok: false }',
          '  const svc = createServiceClient()',
          '  await svc.from("subscriptions").update({ status: "trialing" }).eq("brokerage_id", params.brokerageId)',
          '}',
        ].join("\n"),
      },
      {
        name: "a platform gate that runs only AFTER the service-client use exempts nothing",
        expect: 1,
        why: "a late gate is being taken as authority for a write it never guarded",
        src: [
          'export async function late(params: { brokerageId: string }) {',
          '  const svc = createServiceClient()',
          '  await svc.from("subscriptions").update({ status: "paused" }).eq("brokerage_id", params.brokerageId)',
          '  const gate = await requireSuperadmin()',
          '}',
        ].join("\n"),
      },
      {
        name: "the object RE-KEYED from a session gate before use is NOT reported",
        expect: 0,
        why: "launchNeighborNotification's fixed shape (params = { ...params, brokerageId: tenant.brokerageId }) is being accused",
        src: [
          'export async function launch(params: { campaignId: string; brokerageId: string }) {',
          '  const tenant = await sessionTenant(params.brokerageId)',
          '  if (!tenant.ok) return null',
          '  params = { ...params, brokerageId: tenant.brokerageId }',
          '  const supabase = createServiceClient()',
          '  await supabase.from("c").select("*").eq("brokerage_id", params.brokerageId)',
          '}',
        ].join("\n"),
      },
      // ── lane 92A: the three closed blind spots, each with its fixed twin ──
      {
        name: "a NAMED-INTERFACE object param (input: SomeInput, declared in-file) forwarding its brokerageId is REPORTED",
        expect: 1,
        why: "a tenant carried inside a named interface is invisible again — `input: RecordHazardPolicyInput` is that shape",
        src: [
          'interface RecordInput {',
          '  transactionId: string',
          '  brokerageId?: string',
          '  meta?: { brokerageId: string }',
          '}',
          'export async function record(input: RecordInput): Promise<{ success: boolean }> {',
          '  const svc = createServiceClient()',
          '  await svc.from("x").update({ a: 1 }).eq("brokerage_id", input.brokerageId)',
          '  return { success: true }',
          '}',
        ].join("\n"),
      },
      {
        name: "the same NAMED-INTERFACE param asserted through requireCallerTenant before use is NOT reported",
        expect: 0,
        why: "the fixed shape (transaction-hazard-insurance after lane 92A) is being accused",
        src: [
          'type RecordInput = { transactionId: string; brokerageId?: string }',
          'export async function record(input: RecordInput): Promise<{ success: boolean }> {',
          '  const auth = await requireCallerTenant(input.brokerageId)',
          '  if (!auth.ok) return { success: false }',
          '  const svc = createServiceClient()',
          '  await svc.from("x").update({ a: 1 }).eq("brokerage_id", input.brokerageId)',
          '  return { success: true }',
          '}',
        ].join("\n"),
      },
      {
        name: "an ARROW-FUNCTION export forwarding a raw brokerageId into a SERVICE client is REPORTED",
        expect: 1,
        why: "`export const f = async (…) => {}` is unwalked again",
        src: [
          'export const getStats = async (brokerageId: string): Promise<{ n: number }> => {',
          '  const svc = createServiceClient()',
          '  const { count } = await svc.from("contacts").select("id", { count: "exact" }).eq("brokerage_id", brokerageId)',
          '  return { n: count ?? 0 }',
          '}',
        ].join("\n"),
      },
      {
        name: "an ARROW-FUNCTION export that shadows the param from the session first is NOT reported",
        expect: 0,
        why: "the arrow walk accuses the fixed shape",
        src: [
          'export const getStats = async (_brokerageId: string) => {',
          '  const ctx = await getAgentContext()',
          '  const brokerageId = ctx.brokerageId',
          '  const svc = createServiceClient()',
          '  return svc.from("contacts").select("id").eq("brokerage_id", brokerageId)',
          '}',
        ].join("\n"),
      },
      {
        name: "a MODULE-LEVEL service singleton used with a raw brokerageId is REPORTED",
        expect: 1,
        why: "a service client created outside the function is unseen again",
        src: [
          'const admin = createServiceClient()',
          'export async function wipe(brokerageId: string) {',
          '  await admin.from("x").delete().eq("brokerage_id", brokerageId)',
          '}',
        ].join("\n"),
      },
      {
        name: "a FILE-LOCAL WRAPPER returning createServiceClient() used with a raw brokerageId is REPORTED",
        expect: 1,
        why: "a service client reached through a local factory is unseen again",
        src: [
          'function svc() {',
          '  return createServiceClient()',
          '}',
          'export async function wipe(brokerageId: string) {',
          '  const db = svc()',
          '  await db.from("x").delete().eq("brokerage_id", brokerageId)',
          '}',
        ].join("\n"),
      },
      {
        name: "a raw param used only on a SESSION client (RLS-backed) is NOT reported",
        expect: 0,
        why: "CHECK 3 targets the service-client bypass specifically; the session-client + RLS pattern used throughout this repo is a separate, RLS-dependent question this textual guard cannot answer and must not accuse",
        src: [
          "export async function getRows(brokerageId: string) {",
          "  const supabase = await createClient()",
          '  const { data } = await supabase.from("sync_errors").select("*").eq("brokerage_id", brokerageId)',
          "  return data",
          "}",
        ].join("\n"),
      },
    ]
    let controlFailed = false
    for (const c of controls) {
      const got = unverifiedServiceTenantIdsIn(c.src).length
      if (got === c.expect) console.log(`  ✓ control · ${c.name}`)
      else {
        controlFailed = true
        console.log(`  ✗ CONTROL FAILED · ${c.name} — expected ${c.expect}, got ${got}`)
        console.log(`      ${c.why}`)
      }
    }
    if (controlFailed) {
      console.log(" ❌ SERVICE_TENANT_ID_CONTROL_FAIL — the finder cannot prove it still works, so its zero means nothing")
      process.exit(1)
    }
  }

  // Scope: "use server" files under app/actions ONLY — CLAUDE.md §4's "every
  // export is a public HTTP endpoint" is what makes a caller-supplied tenant id
  // dangerous; it names "use server" files specifically. A `lib/` helper taking
  // `brokerageId` and querying a service client is ordinary internal plumbing —
  // it is reached only from an action that already resolved the tenant from the
  // session, same as any other internal function argument, and scanning `lib/`
  // here produced ~60 such false positives before this scope line was added.
  const svcOffenders: string[] = []
  PLATFORM_GATED_SEEN.length = 0 // the controls above exercised the finder; count the corpus only
  let svcScanned = 0
  // Lane 91D2: every "use server" module under app/ (route-local actions.ts files
  // such as app/dashboard/marketing/review/actions.ts are the same public endpoint
  // class as app/actions/*). Only the DIRECTIVE counts — a file whose first
  // statement is "use server" — not the words in a comment.
  for (const abs of scanCorpus(["app"])) {
    const raw = readFileSync(abs, "utf8")
    if (!/^\s*["']use server["']/.test(raw)) continue
    svcScanned += 1
    const rel = relative(root, abs).replace(/\\/g, "/")
    for (const { fn, param } of unverifiedServiceTenantIdsIn(raw)) {
      const key = `${rel}::${fn}`
      if (SERVICE_ID_EXEMPT[key]) continue
      svcOffenders.push(`${key} — param \`${param}\` reaches a SERVICE client unshadowed`)
    }
  }

  console.log(`\n── SERVICE-CLIENT TENANT-ID GUARD ──`)
  console.log(
    `  ${svcScanned} "use server" files scanned under app/ · ${Object.keys(SERVICE_ID_EXEMPT).length} documented platform-staff/public exemptions`,
  )
  // Published beside the number (§2): which functions passed ONLY because a
  // platform-authority gate ran before the target tenant was used.
  const gated = [...new Set(PLATFORM_GATED_SEEN)].sort()
  console.log(`  ${gated.length} platform-gated (target tenant by design, gate before use): ${gated.join(", ") || "none"}`)
  if (svcOffenders.length > 0) {
    console.log(`  ✗ ${svcOffenders.length} caller-supplied tenant id reaches a SERVICE client unshadowed:`)
    for (const o of [...new Set(svcOffenders)]) console.log(`     - ${o}`)
    console.log(
      " ❌ SERVICE_TENANT_ID_FAIL — resolve tenant from getAgentContext() and let the session win (CLAUDE.md §4)",
    )
    process.exit(1)
  }
  console.log(
    " ✅ SERVICE_TENANT_ID_PASS — no function forwards a caller-supplied brokerage/tenant id into a SERVICE client unverified",
  )
}

