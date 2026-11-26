"use server"

// app/actions/superadmin/secret-migration.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM-STAFF DOOR for the legacy-plaintext re-seal (wave 140H). GATE FIRST, service client
// second (CLAUDE.md §4): the staff gate runs before createServiceClient() is ever called. The job
// (lib/security/secret-migration.ts) verifies decrypt(encrypt(x)) === x per row before it replaces
// anything, pins every update to id + the row's own brokerage_id, and reports COUNTS only — the
// audit row below carries those counts and never a secret value.

import { createServiceClient } from "@/lib/supabase/service"
import { gateStaffAction } from "@/lib/platform/staff-action-gate"
import { migrateLegacyPlaintextSecrets, type SecretMigrationReport } from "@/lib/security/secret-migration"

export async function resealLegacyPlaintextSecretsAction(
  input: { dryRun?: boolean } = {},
): Promise<{ ok: true; report: SecretMigrationReport } | { ok: false; error: string }> {
  const gate = await gateStaffAction("sentinel")
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()
  const report = await migrateLegacyPlaintextSecrets(svc, { dryRun: input.dryRun === true })
  if (report.refused === "secrets_key_missing") {
    return { ok: false, error: "Refused: SECRETS_ENCRYPTION_KEY is not configured on this deployment, so nothing can be re-sealed (and nothing was touched)." }
  }
  // EVIDENCE (law 5) in the same superadmin_audit_log the other staff actions write. Platform-wide, so
  // target_type is "platform" and target_id (a uuid column, verified live 2026-10-11) is null — the
  // per-tenant auditStaffAction survivor fixes target_type "brokerage" and would refuse a non-uuid
  // marker. Details are COUNTS per table.column only; no secret value is ever in the row. The write's
  // refusal is READ (CLAUDE.md §3) and reported beside the result, never swallowed.
  const { error: auditError } = await svc.from("superadmin_audit_log").insert({
    actor_user_id: gate.userId,
    actor_email: gate.email,
    action: "legacy_plaintext_secrets_resealed",
    target_type: "platform",
    target_id: null,
    details: {
      dryRun: report.dryRun,
      totals: report.totals,
      moreRemaining: report.moreRemaining,
      columns: report.columns.map((c) => ({ store: `${c.table}.${c.column}`, candidates: c.candidates, migrated: c.migrated, verifyFailed: c.verifyFailed, notMatched: c.notMatched, refused: c.refused, unreadable: c.unreadable })),
    },
  })
  if (auditError) console.error(`[secret-migration] audit row NOT written: ${auditError.message}`)
  return { ok: true, report }
}
