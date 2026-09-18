#!/usr/bin/env tsx
/**
 * scripts/migration-ledger-guard.ts  (nightly, creds-gated)
 * ─────────────────────────────────────────────────────────────────────────────
 * A MIGRATION FILE IS NOT A MIGRATION.
 *
 * Wave 27 found that m392 through m397 — the ENTIRE waves-20/22 RLS remediation
 * — had never been applied. They existed as files, and nothing in this repo
 * applies migrations: not the four workflows, not a `package.json` script. So
 * "wrote the migration" and "the database changed" were two different facts, and
 * six waves recorded them as one. For that whole time the live database still
 * handed `anon` — the key shipped in the browser bundle — SELECT, INSERT, UPDATE
 * and DELETE on every untenanted row of 324 tables, while the audit docs said
 * the hole was closed.
 *
 * No filesystem check can catch that: `supabase/migrations/*.sql` looks identical
 * whether or not anything ran. The only source of truth is
 * `supabase_migrations.schema_migrations`, which PostgREST does not expose — so
 * this reads it through the service-role-only `applied_migration_versions()` RPC
 * (m410), which mirrors `live_schema_json()`'s grant posture exactly.
 *
 * Creds-gated: without credentials it prints a STATED SKIP and exits 0. Skips are
 * STATED, never faked as passes — a green run without creds means "not
 * exercised", and the log says exactly that.
 *
 * Run: npx tsx scripts/migration-ledger-guard.ts
 */
import { readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * ── THE BASELINE, AND WHY IT IS NOT SLACK ────────────────────────────────────
 *
 * 44 migration files had no ledger row when this guard was written. Two of them
 * were the live defect (m398/m399) and were applied immediately, which is what
 * moved this baseline from 44 to 42 and is the proof the ratchet actually moves.
 *
 * The other 42 are HISTORICAL and their status is genuinely UNKNOWN — not
 * "fine". Sampling settled the largest family and only that one:
 *
 *   · 023–032 were APPLIED. Verified by effect, not by assumption: 029 is the
 *     source of the `brokerage_id IS NULL` construct the whole codebase calls
 *     "the migration-029 escape", and the live database carries 795 policies
 *     using it across 679 `brokerage_id` columns. The ledger simply has no row
 *     for them — its earliest entry is 033 — so they predate it.
 *
 * The remaining m-numbered gaps (m097–m101, m105, m218–m221, m227, m249–m258,
 * m277, m279–m282, m286, m287, m322, m329, m353, m354, m378) were NOT
 * individually verified. Each is either applied-but-unrecorded or genuinely
 * unapplied, and telling those apart means reading each file and checking its
 * effect against the live catalog. That is a real investigation and it is named
 * here as debt rather than guessed at — publishing a number I had not measured
 * is exactly the error wave 27 had to retract.
 *
 * THE RATCHET: anything NOT in this list must be applied. Entries only ever
 * leave this array. If a baseline token turns up applied, the guard says so and
 * fails, so the list cannot quietly keep covering for work that is now done.
 */
const BASELINE_UNVERIFIED = new Set([
  "023", "024", "025", "026", "027", "028", "029", "030", "031", "032",
  "m097", "m098", "m099", "m100", "m101", "m105",
  "m218", "m219", "m220", "m221", "m227",
  "m249", "m250", "m251", "m253", "m254", "m255", "m256", "m257", "m258",
  "m277", "m279", "m280", "m281", "m282", "m286", "m287",
  "m322", "m329", "m353", "m354", "m378",
])

/** `m394-narrow-...sql` → `m394`; `029-add-...sql` → `029`. */
function tokenOf(filename: string): string | null {
  const m = /^(m\d+|\d+)/.exec(filename)
  return m ? m[1] : null
}

async function main() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("○ migration-ledger guard skipped (no Supabase credentials in this environment)")
    return
  }

  const dir = join(process.cwd(), "supabase/migrations")
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"))

  // A file whose name carries no version token cannot be matched to a ledger
  // row at all. That is a naming defect, not a pass — say so rather than
  // silently dropping it from the denominator.
  const untokenised = files.filter((f) => tokenOf(f) === null)

  const fileTokens = new Map<string, string>() // token -> filename
  for (const f of files) {
    const t = tokenOf(f)
    if (t) fileTokens.set(t, f)
  }

  const res = await fetch(`${url}/rest/v1/rpc/applied_migration_versions`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
  })
  if (!res.ok) {
    // Fail CLOSED. An unreachable ledger is not evidence that the ledger agrees.
    console.error(`✗ applied_migration_versions RPC failed: ${res.status} ${await res.text()}`)
    console.error("  The guard cannot prove anything without it, so this is a FAILURE, not a skip.")
    process.exit(1)
  }
  const rows = (await res.json()) as Array<{ version: string; name: string }>
  if (!Array.isArray(rows)) {
    console.error("✗ applied_migration_versions returned a non-array payload")
    process.exit(1)
  }

  const appliedTokens = new Set<string>()
  for (const r of rows) {
    const t = tokenOf(String(r.name ?? ""))
    if (t) appliedTokens.add(t)
  }

  const unapplied: string[] = []
  for (const [token, filename] of fileTokens) {
    if (appliedTokens.has(token)) continue
    if (BASELINE_UNVERIFIED.has(token)) continue
    unapplied.push(filename)
  }

  // The ratchet's other half: a baseline entry that is now applied must LEAVE
  // the array. Otherwise the list slowly becomes a place where real work hides.
  const baselineNowApplied = [...BASELINE_UNVERIFIED].filter((t) => appliedTokens.has(t)).sort()

  console.log(
    `migration-ledger: ${files.length} file(s), ${rows.length} ledger row(s), ` +
      `${BASELINE_UNVERIFIED.size} baselined`,
  )

  let failed = false

  if (untokenised.length > 0) {
    failed = true
    console.error(
      `\n✗ ${untokenised.length} migration file(s) carry no version token, so no ledger row can ever match them:\n` +
        untokenised.map((f) => `    ${f}`).join("\n") +
        `\n  Rename them to the repo convention (mNNN-description.sql).`,
    )
  }

  if (unapplied.length > 0) {
    failed = true
    console.error(
      `\n✗ ${unapplied.length} migration file(s) have NEVER been applied to the database:\n` +
        unapplied.map((f) => `    ${f}`).join("\n") +
        `\n\n  This is the wave-27 defect: m392-m397 sat exactly like this while six waves` +
        `\n  recorded their RLS remediation as complete, and the live database still granted` +
        `\n  \`anon\` read/write/delete on every untenanted row of 324 tables.` +
        `\n\n  Apply each one, then re-run. A migration file is not a migration.`,
    )
  }

  if (baselineNowApplied.length > 0) {
    failed = true
    console.error(
      `\n✗ ${baselineNowApplied.length} BASELINE_UNVERIFIED token(s) are now applied: ${baselineNowApplied.join(", ")}` +
        `\n  Remove them from BASELINE_UNVERIFIED in this file. The baseline only ever shrinks —` +
        `\n  leaving a settled entry in it is how a debt list becomes a hiding place.`,
    )
  }

  if (failed) process.exit(1)

  console.log("✅ MIGRATION_LEDGER_PASS — every migration file outside the named baseline has been applied")
}

main().catch((err) => {
  console.error("✗ migration-ledger guard threw:", err)
  process.exit(1)
})
