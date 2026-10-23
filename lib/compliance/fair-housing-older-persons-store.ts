// lib/compliance/fair-housing-older-persons-store.ts
//
// THE PERSISTENCE HALF of the housing-for-older-persons exemption (wave 143, lane 143F).
// The rules live in fair-housing-older-persons.ts (pure); this file reads and writes the tenant's
// recorded verifications in public.older_persons_housing_verifications (m846 — WRITTEN, NOT APPLIED).
//
// WRITER   saveOlderPersonsVerification — called ONLY by the tenant-admin server action
//          app/actions/fair-housing-older-persons.ts (session tenant, admin roster, ledger evidence).
// READERS  loadOlderPersonsVerifications — every public-copy gate that can meet a "55+" claim:
//          lib/kernel/lead-magnets.ts publishLeadMagnet, lib/lead-magnets/ai-draft.ts,
//          lib/lead-magnets/book-creator.ts, lib/video/script-compliance.ts assessScriptCompliance,
//          lib/podcast/auto-producer.ts; and the settings panel's list action.
//
// FAIL CLOSED (CLAUDE.md §4): a refused read — including "the table is not applied yet" — returns
// "unreadable", which assessOlderPersonsClaim turns into a HELD claim. It never returns [] for a
// failure (an empty list means "this tenant has recorded none", a different fact).
//
// Not server-only on purpose, and no client of its own: every function takes the caller's client so
// the proofs drive it on the in-memory database. Every read and write is pinned to brokerage_id.

import {
  communityKey, evaluateOlderPersonsRecord, validateOlderPersonsInput,
  type OlderPersonsBasis, type OlderPersonsEvaluation, type OlderPersonsVerification,
} from "./fair-housing-older-persons"

type Client = { from: (table: string) => any }

/** The one table name — the proofs and the migration pin it. */
export const OLDER_PERSONS_TABLE = "older_persons_housing_verifications"

const COLUMNS = "id, community_name, basis, governing_rules, occupied_units, qualifying_units, survey_completed_on, policies_published, policies_reference, age_verification_procedures, program_name, program_determination_ref, sworn_certification_on_file, certifying_representative, certification_date, state, state_law_reviewed, verified_by, verified_at"

/** The tenant's recorded verifications, or "unreadable" when the read was refused (never [] for a failure). */
export async function loadOlderPersonsVerifications(client: Client, brokerageId: string | null | undefined): Promise<OlderPersonsVerification[] | "unreadable"> {
  if (!brokerageId) return "unreadable"
  try {
    const { data, error } = await client.from(OLDER_PERSONS_TABLE).select(COLUMNS).eq("brokerage_id", brokerageId).limit(200)
    if (error) return "unreadable"
    return (data ?? []) as OlderPersonsVerification[]
  } catch {
    return "unreadable"
  }
}

export type SaveOlderPersonsResult =
  | { ok: true; id: string; created: boolean; evaluation: OlderPersonsEvaluation }
  | { ok: false; error: string }

/**
 * Record (insert or replace by community) one verification. The STATUS is computed here from the
 * conditions — the caller cannot assert "verified"; it can only supply facts. Evidence: a
 * compliance.older_persons.verify ledger row naming who attested, what was unmet, and the dates.
 */
export async function saveOlderPersonsVerification(
  client: Client,
  args: { brokerageId: string; actorUserId: string; input: Partial<OlderPersonsVerification>; now?: Date },
): Promise<SaveOlderPersonsResult> {
  if (!args.brokerageId) return { ok: false, error: "No tenant on the session." }
  if (!args.actorUserId) return { ok: false, error: "An attestation needs an attesting user — none on the session." }
  const problems = validateOlderPersonsInput(args.input)
  if (problems.length > 0) return { ok: false, error: problems.join("; ") }
  const now = args.now ?? new Date()
  const i = args.input
  const record: OlderPersonsVerification = {
    community_name: String(i.community_name).trim(),
    basis: i.basis as OlderPersonsBasis,
    governing_rules: i.governing_rules?.trim() || null,
    occupied_units: i.occupied_units ?? null,
    qualifying_units: i.qualifying_units ?? null,
    survey_completed_on: i.survey_completed_on || null,
    policies_published: i.policies_published === true,
    policies_reference: i.policies_reference?.trim() || null,
    age_verification_procedures: i.age_verification_procedures === true,
    program_name: i.program_name?.trim() || null,
    program_determination_ref: i.program_determination_ref?.trim() || null,
    sworn_certification_on_file: i.sworn_certification_on_file === true,
    certifying_representative: i.certifying_representative?.trim() || null,
    certification_date: i.certification_date || null,
    state: i.state ? String(i.state).toUpperCase() : null,
    state_law_reviewed: i.state_law_reviewed === true,
    verified_by: args.actorUserId,
    verified_at: now.toISOString(),
  }
  const evaluation = evaluateOlderPersonsRecord(record, now)
  const key = communityKey(record.community_name)
  if (key.length < 3) return { ok: false, error: "community_name must have at least 3 letters or digits." }

  const { data: existing, error: readErr } = await client.from(OLDER_PERSONS_TABLE).select("id")
    .eq("brokerage_id", args.brokerageId).eq("community_key", key).limit(1)
  if (readErr) return { ok: false, error: `Could not read the existing record: ${readErr.message}` }
  const existingId = ((existing ?? []) as Array<{ id: string }>)[0]?.id ?? null

  const row = {
    ...record,
    community_key: key,
    status: evaluation.status,
    expires_on: evaluation.expiresOn,
    updated_at: now.toISOString(),
  }

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const outcome = await withActionLedger<{ ok: true; id: string; created: boolean } | { ok: false; error: string }>(
    {
      brokerageId: args.brokerageId,
      action: "compliance.older_persons.verify",
      actor: { type: "user", userId: args.actorUserId },
      subject: { type: "older_persons_housing_verification", id: existingId ?? key },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: `human attestation: ${record.basis} housing-for-older-persons exemption for ${record.community_name} (${evaluation.status})`,
      riskClass: "LOW_RISK_WRITE",
      systemSource: "fair_housing_older_persons",
      detail: {
        community: record.community_name, basis: record.basis, status: evaluation.status, expires_on: evaluation.expiresOn,
        unmet: evaluation.unmet.map((c) => c.id), authority: "42 U.S.C. § 3607(b); 24 CFR 100.300–100.308",
      },
    },
    async () => {
      if (existingId) {
        const { data, error } = await client.from(OLDER_PERSONS_TABLE).update(row).eq("id", existingId).eq("brokerage_id", args.brokerageId).select("id")
        if (error) return { ok: false as const, error: `Could not update the verification: ${error.message}` }
        if ((data ?? []).length !== 1) return { ok: false as const, error: "The verification matched no row for this tenant (it may have been removed)." }
        return { ok: true as const, id: existingId, created: false }
      }
      const { data, error } = await client.from(OLDER_PERSONS_TABLE).insert({ ...row, brokerage_id: args.brokerageId, created_at: now.toISOString() }).select("id")
      if (error) return { ok: false as const, error: `Could not record the verification: ${error.message}` }
      const id = ((data ?? []) as Array<{ id: string }>)[0]?.id
      if (!id) return { ok: false as const, error: "The verification insert returned no row." }
      return { ok: true as const, id, created: true }
    },
    {
      settle: (r) => r.ok ? { status: "executed", outcome: evaluation.status, providerRef: key } : { status: "failed", outcome: "write_refused", error: r.error },
      replay: (claim) => ({ ok: false as const, error: `ledger refused the attestation: ${claim.kind}` }),
    },
    { client: client as any },
  )
  if (!outcome.ok) return { ok: false, error: outcome.error }
  return { ok: true, id: outcome.id, created: outcome.created, evaluation }
}

/** Remove one recorded verification (tenant-pinned, COUNTED — a delete that matches nothing is reported, not "removed"). */
export async function removeOlderPersonsVerification(client: Client, args: { brokerageId: string; id: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!args.brokerageId || !args.id) return { ok: false, error: "Missing tenant or record id." }
  const { data, error } = await client.from(OLDER_PERSONS_TABLE).delete().eq("id", args.id).eq("brokerage_id", args.brokerageId).select("id")
  if (error) return { ok: false, error: `Could not remove the verification: ${error.message}` }
  if ((data ?? []).length !== 1) return { ok: false, error: "No verification matched this tenant and id." }
  return { ok: true }
}
