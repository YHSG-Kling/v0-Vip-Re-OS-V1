/**
 * scripts/credential-source-guard.ts
 *
 * test:credential-sources — A SECURITY MONITOR MUST NOT BE ABLE TO GO BLIND QUIETLY.
 *
 * THE DEFECT THIS EXISTS FOR. lib/security/credential-rotation declares the four
 * OAuth credential tables it watches, each with the name of that table's
 * provider column. lib/security/oauth-refresh swept the same four. Both named
 * calendar_provider_accounts' provider column `provider`. The column is
 * `provider_type`, and that table has no refresh_token and no access_token at
 * all — so both scans issued a query naming columns that do not exist and
 * Postgres answered 42703.
 *
 * Nothing noticed, and the reason is the shape this whole sweep keeps finding:
 * supabase-js RESOLVES a failed query rather than throwing. Both call sites
 * destructured `{ data }`, dropped the error, got null, iterated zero rows, and
 * reported success. The try/catch around the rotation scan could not fire
 * because there was never an exception. The calendar source therefore
 * contributed ZERO risks on every run since it was added: a silently-expired
 * Google or Outlook token was never flagged, never refreshed, and never logged.
 *
 * WHY THE EXISTING GUARDS MISSED IT. test:schema-drift scans .select("…")
 * TEXT against the live-schema snapshot. These selects are built at runtime from
 * a per-table map — `.select(\`id, …, ${providerCol}\`)` — so there is no literal
 * column name in the source to scan. A text detector cannot resolve a variable.
 * The invariant has to be asserted against the DECLARATION instead, which is
 * what this file does.
 *
 * THE INVARIANT. Every column a credential source declares must exist on that
 * table in the live-schema snapshot, and a table may only be swept for token
 * REFRESH if it actually stores a token to exchange. Plus the failure mode that
 * let this hide: both sweeps must read the query's `error`, because a scan that
 * cannot tell "no risks found" from "the query failed" reports healthy either
 * way — and a green monitor is trusted.
 */
import { readFileSync } from "node:fs"

const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }
/** Strip comments so the guard measures CODE, never its own prose. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

/** Columns of a table, straight from the live-schema snapshot. */
const snapshot = read("scripts/schema-snapshot.ts")
function columnsOf(table: string): string[] {
  const m = snapshot.match(new RegExp(`\\n\\s*${table}: \\[([^\\]]*)\\]`))
  if (!m) return []
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

const rotation = code(read("lib/security/credential-rotation.ts"))
const refresh = code(read("lib/security/oauth-refresh.ts"))

console.log("\n═══ 1. Every declared credential source is real ═══")
{
  // Parse the declaration rather than trusting a hardcoded copy of it — the
  // point is to check what the CODE says, not what this guard remembers.
  const block = rotation.match(/CREDENTIAL_SOURCES[^=]*=\s*\[([\s\S]*?)\n\]/)?.[1] ?? ""
  const entries = [...block.matchAll(
    /\{\s*table:\s*"([^"]+)",\s*providerCol:\s*"([^"]+)",\s*hasRefreshToken:\s*(true|false)\s*\}/g,
  )].map((m) => ({ table: m[1], providerCol: m[2], hasRefreshToken: m[3] === "true" }))

  ok("the source list parses and declares hasRefreshToken per table",
    entries.length >= 4, `parsed ${entries.length} entries — the shape changed?`)

  for (const e of entries) {
    const cols = columnsOf(e.table)
    ok(`${e.table} exists in the schema snapshot`, cols.length > 0)
    ok(`${e.table}.${e.providerCol} is a real column`,
      cols.includes(e.providerCol),
      `snapshot has: ${cols.join(", ")}`)
    ok(`${e.table} declares token_expires_at, which is what the scan filters on`,
      cols.includes("token_expires_at"))
    ok(`${e.table} hasRefreshToken=${e.hasRefreshToken} matches the schema`,
      cols.includes("refresh_token") === e.hasRefreshToken,
      e.hasRefreshToken
        ? "declared as having a refresh_token, but the snapshot has none"
        : "declared as having none, but the snapshot has refresh_token")
  }

  // The specific regression, named. calendar_provider_accounts is the table
  // that was mis-declared, and both facts about it are load-bearing.
  const cal = columnsOf("calendar_provider_accounts")
  ok("calendar_provider_accounts still has NO refresh_token — so it can be\n    WATCHED for staleness but never auto-refreshed",
    cal.length > 0 && !cal.includes("refresh_token"))
  ok("...and its provider column is provider_type, not provider",
    cal.includes("provider_type") && !cal.includes("provider"))
}

console.log("\n═══ 2. Only tables that hold a token are swept for refresh ═══")
{
  const sweep = refresh.match(/for \(const table of \[([^\]]*)\]/)?.[1] ?? ""
  ok("the refresh sweep does NOT include calendar_provider_accounts —\n    there is no token there to exchange",
    !/calendar_provider_accounts/.test(sweep), sweep.trim())
  ok("...and it still sweeps the three tables that DO store tokens",
    /platform_credentials/.test(sweep) &&
    /agent_api_credentials/.test(sweep) &&
    /social_media_accounts/.test(sweep))
  ok("the refresh sweep no longer maps a calendar provider column",
    !/calendar_provider_accounts.*\?\s*"provider"/.test(refresh))
}

console.log("\n═══ 3. A failed scan is LOUD — the bug that hid the bug ═══")
{
  // supabase-js resolves a rejected query, so `const { data } = await …` turns a
  // broken scan into an empty one. Both sweeps must destructure and read error.
  ok("the rotation scan destructures `error` from its query",
    /const \{ data, error \} = await svc/.test(rotation),
    "lib/security/credential-rotation.ts")
  ok("...and bails on it rather than iterating a null result",
    /if \(error\)[\s\S]{0,200}continue/.test(rotation))
  ok("the refresh sweep destructures `error` from its query",
    /const \{ data, error \} = await svc/.test(refresh),
    "lib/security/oauth-refresh.ts")
  ok("...and bails on it too",
    /if \(error\)[\s\S]{0,200}continue/.test(refresh))
  ok("both log the table that could not be scanned, so a silent hole becomes\n    a visible one",
    /scan of \$\{table\} FAILED/.test(rotation) && /scan of \$\{table\} FAILED/.test(refresh))
}

console.log("\n═══ 4. The detector fires on a reintroduction ═══")
{
  // A guard only ever run against the tree it was written from always passes.
  const reintroduced = `{ table: "calendar_provider_accounts", providerCol: "provider", hasRefreshToken: true }`
  const m = reintroduced.match(/providerCol:\s*"([^"]+)"/)
  const cal = columnsOf("calendar_provider_accounts")
  ok("a re-declared `provider` column would be caught",
    m !== null && !cal.includes(m[1]))
  ok("a re-declared hasRefreshToken:true would be caught",
    !cal.includes("refresh_token"))

  const swallowed = `const { data } = await svc.from(table).select(cols)`
  ok("a scan that drops `error` again would be caught",
    !/const \{ data, error \}/.test(swallowed))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`CREDENTIAL SOURCES — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nA monitor that cannot tell 'no risks found' from 'the query failed'")
  console.log("reports healthy either way. Every declared source must be real.")
  process.exit(1)
}
console.log("Every credential source is real, and a failed scan is loud.")
