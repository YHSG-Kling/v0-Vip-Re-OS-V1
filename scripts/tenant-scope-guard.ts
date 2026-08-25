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
  "app/actions/privacy/data-subject-requests.ts":
    "DSAR intake resolves WHICH tenant the subject belongs to; fulfillment is separately role-gated",
  "app/actions/superadmin/platform-staff.ts":
    "platform staff administration is global BY DEFINITION and is superadmin-gated",
  "app/api/recruiting/provision-agent/route.ts":
    "looks up by recruit.email where the recruit row is already brokerage-scoped; auth emails are global",
  "lib/kernel/users.ts":
    "resolveEmailHolder MUST search globally — users.email is unique platform-wide and a stale holder would break the invite. The BINDING is what needed guarding, and inviteTenantMember now refuses to re-home a user who already belongs to another brokerage unless the caller is a superadmin.",
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

