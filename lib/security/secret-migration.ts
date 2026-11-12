// lib/security/secret-migration.ts
// ─────────────────────────────────────────────────────────────────────────────
// LEGACY PLAINTEXT → ENVELOPE RE-SEAL (wave 140H; owner wave 140 "approve all": "~21 plaintext
// provider-credential writers (migrate reader-encrypted → write encrypted → migrate → verify → stop
// plaintext; never destroy before verify)").
//
// Order of the migration, as shipped:
//   1. every READER decrypts (decryptSecret / decryptSecretFields — plaintext passes through), so
//   2. every WRITER may encrypt (encryptSecret — fail closed with no key), and only then
//   3. THIS JOB re-seals the rows written before step 2. Per row it encrypts the stored value,
//      PROVES decrypt(encrypt(x)) === x, and only then replaces the plaintext — a value whose
//      round-trip fails is counted (`verifyFailed`) and left untouched. Nothing is ever destroyed
//      before it has been verified to come back.
//
// Properties:
//   • IDEMPOTENT — candidates are `NOT LIKE 'enc:v1:%'`; a second run finds zero and writes zero.
//   • TENANT-SCOPED on every migrated table — the update pins `id` AND the row's own `brokerage_id`
//     (`IS NULL` for a platform-owned row), and `.not(col, "like", "enc:v1:%")` so a concurrent
//     writer that already sealed the row is never overwritten; `.select("id")` COUNTS the match
//     (CLAUDE.md §3 — an update that matched nothing also resolves).
//   • NO SECRET LEAVES THE PROCESS — the report carries counts per `table.column` only; no value is
//     logged, returned or put in evidence. The plaintext is never sent as a filter either.
//   • FAIL CLOSED — with no SECRETS_ENCRYPTION_KEY it refuses before reading a single row.
//
// Survivors reused, not rebuilt: lib/security/secret-crypto.ts (THE envelope), SECRET_STORE_COLUMNS
// (lib/security/credential-rotation.ts — the ONE list of stores the posture census counts), and the
// posture census itself as the "did it work" reading (legacy plaintext → 0 the next sweep).
// Doors: app/actions/superadmin/secret-migration.ts (platform staff, on demand, ledgered) and the
// daily os-sentinel heartbeat (lib/platform/os-sentinel.ts runOsSentinelSweep — only when the key is
// configured AND the posture census still counts legacy plaintext).

import { encryptSecret, decryptSecret, isEncryptionConfigured } from "@/lib/security/secret-crypto"
import { SECRET_STORE_COLUMNS } from "@/lib/security/credential-rotation"

type Svc = any

interface SecretMigrationColumnReport {
  table: string
  column: string
  /** Legacy plaintext rows found in this pass (before the batch limit). */
  candidates: number
  /** Rows re-sealed: verified round-trip AND the pinned update matched exactly one row. */
  migrated: number
  /** encrypt→decrypt did NOT reproduce the stored value — row left untouched. */
  verifyFailed: number
  /** The pinned update matched 0 rows (sealed concurrently, or tenant/id no longer matched). */
  notMatched: number
  /** The update was refused by the database (error read, row untouched). */
  refused: number
  /** The candidate read itself was refused — never reported as "nothing to migrate". */
  unreadable: boolean
}

export interface SecretMigrationReport {
  ok: boolean
  /** "secrets_key_missing" when refused before any read; "dry_run" when nothing was written by request. */
  refused: "secrets_key_missing" | null
  dryRun: boolean
  columns: SecretMigrationColumnReport[]
  totals: { candidates: number; migrated: number; verifyFailed: number; notMatched: number; refused: number }
  /** True when a column still had candidates beyond `batch` — run again. */
  moreRemaining: boolean
}

const ENVELOPE_LIKE = "enc:v1:%"

/**
 * PURE: seal one stored value and prove the round-trip. It is the whole "never destroy before verify"
 * rule in one place. Returns the envelope, or null when the round-trip fails (the caller leaves the
 * row untouched and counts it).
 * @proofSeam scripts/credential-migration-guard.ts asserts the round-trip rule and the "never seals an
 *            envelope twice" negative directly; the job above is its only runtime caller.
 */
export function sealVerified(plaintext: string): string | null {
  const sealed = encryptSecret(plaintext)
  if (!sealed || sealed === plaintext) return null
  try {
    return decryptSecret(sealed) === plaintext ? sealed : null
  } catch {
    return null
  }
}

export async function migrateLegacyPlaintextSecrets(
  svc: Svc,
  opts: { dryRun?: boolean; batch?: number; now?: Date } = {},
): Promise<SecretMigrationReport> {
  const dryRun = opts.dryRun === true
  const batch = Math.max(1, Math.min(opts.batch ?? 500, 2000))
  const nowIso = (opts.now ?? new Date()).toISOString()
  const columns: SecretMigrationColumnReport[] = []
  const totals = { candidates: 0, migrated: 0, verifyFailed: 0, notMatched: 0, refused: 0 }
  let moreRemaining = false

  if (!isEncryptionConfigured()) {
    return { ok: false, refused: "secrets_key_missing", dryRun, columns, totals, moreRemaining }
  }

  for (const { table, columns: cols } of SECRET_STORE_COLUMNS) {
    for (const column of cols) {
      const rep: SecretMigrationColumnReport = { table, column, candidates: 0, migrated: 0, verifyFailed: 0, notMatched: 0, refused: 0, unreadable: false }
      columns.push(rep)
      const { data, error } = await svc
        .from(table)
        .select(`id, brokerage_id, ${column}`)
        .not(column, "is", null)
        .not(column, "like", ENVELOPE_LIKE)
        .limit(batch + 1)
      if (error) { rep.unreadable = true; continue }
      const rows = (data ?? []) as Array<Record<string, unknown>>
      if (rows.length > batch) moreRemaining = true
      const work = rows.slice(0, batch)
      rep.candidates = work.length
      totals.candidates += work.length
      for (const row of work) {
        const value = row[column]
        if (typeof value !== "string" || value === "") continue
        const sealed = sealVerified(value)
        if (!sealed) { rep.verifyFailed++; totals.verifyFailed++; continue }
        if (dryRun) continue
        const tenant = row.brokerage_id
        let q = svc
          .from(table)
          .update({ [column]: sealed, updated_at: nowIso })
          .eq("id", row.id)
          .not(column, "like", ENVELOPE_LIKE)
        q = tenant === null || tenant === undefined ? q.is("brokerage_id", null) : q.eq("brokerage_id", tenant)
        const { data: written, error: writeErr } = await q.select("id")
        if (writeErr) { rep.refused++; totals.refused++; continue }
        if (!Array.isArray(written) || written.length !== 1) { rep.notMatched++; totals.notMatched++; continue }
        rep.migrated++
        totals.migrated++
      }
    }
  }

  const ok = columns.every((c) => !c.unreadable) && totals.refused === 0 && totals.verifyFailed === 0
  return { ok, refused: null, dryRun, columns, totals, moreRemaining }
}
