#!/usr/bin/env tsx
/**
 * scripts/check-live-schema-drift.ts  (nightly, creds-gated)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LAST DRIFT CLASS: the schema-drift guard proves code matches the
 * COMMITTED snapshot — but DDL applied to the LIVE database between deploys
 * (a new CHECK, a dropped column, a migration run from the dashboard) is
 * invisible until code trips over it at runtime. This check regenerates the
 * snapshot FROM LIVE nightly (via the service-role-only live_schema_json()
 * RPC, migration l72_s14) and fails when the committed snapshot no longer
 * matches reality — so live drift is caught within a day, not by a customer.
 *
 * Creds-gated: without SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY it skips
 * with exit 0 (safe for per-push CI and forks). Run: npx tsx scripts/check-live-schema-drift.ts
 */
import { execFileSync, execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

async function main() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("○ live-schema drift check skipped (no Supabase credentials in this environment)")
    return
  }

  // Fetch the live schema through the service-role-only RPC.
  const res = await fetch(`${url}/rest/v1/rpc/live_schema_json`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
  })
  if (!res.ok) {
    console.error(`✗ live_schema_json RPC failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const schema = await res.json()
  if (!schema || typeof schema !== "object") {
    console.error("✗ live_schema_json returned no schema object")
    process.exit(1)
  }

  const snapshotPath = join(process.cwd(), "scripts/schema-snapshot.ts")
  const before = readFileSync(snapshotPath, "utf8")

  // Regenerate the snapshot from the live schema using the SAME generator the
  // repo already uses (it reads the schema JSON from stdin).
  const input = JSON.stringify(schema)
  execFileSync("npx", ["tsx", "scripts/generate-schema-snapshot.ts"], {
    input,
    stdio: ["pipe", "inherit", "inherit"],
  })

  const after = readFileSync(snapshotPath, "utf8")
  if (before === after) {
    console.log("✅ LIVE_SCHEMA_DRIFT_PASS — committed snapshot matches the live database")
    return
  }

  // Show the drift, then restore the committed snapshot (this check REPORTS;
  // a human (or the next session) reviews the diff and commits the regen
  // deliberately together with any code fixes it requires).
  console.error("✗ LIVE SCHEMA DRIFT — the live database no longer matches the committed snapshot:")
  try {
    execSync("git --no-pager diff --stat scripts/schema-snapshot.ts", { stdio: "inherit" })
    execSync("git --no-pager diff scripts/schema-snapshot.ts | head -120", { stdio: "inherit" })
  } catch { /* diff display is best-effort */ }
  writeFileSync(snapshotPath, before)
  console.error("  (committed snapshot restored — regenerate + review deliberately)")
  process.exit(1)
}

main().catch((e) => { console.error("✗ drift check crashed:", e?.message ?? e); process.exit(1) })
