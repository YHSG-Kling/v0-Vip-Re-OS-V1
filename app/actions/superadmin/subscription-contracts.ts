"use server"

// app/actions/superadmin/subscription-contracts.ts
// ─────────────────────────────────────────────────────────────────────────────
// LANE 1 (m481) — PLATFORM → TENANT. Platform staff AUTHOR the subscription
// agreement a tenant signs to put their subscription in writing (owner ruling:
// "platform contracts for tenants has to be written in order for the tenant to
// sign for their subscription"). Templates live in platform_contract_templates;
// the tenant's signature lands in tenant_contract_signatures (see
// app/actions/admin/subscription-agreement.ts for the tenant half).
//
// Gates reuse the ONE platform predicate (lib/auth/platform-guard.ts):
//   • reads  — requirePlatformStaff (any staff role can see the catalog)
//   • writes — requireSuperadmin (authoring the platform's contract is
//     destructive platform configuration, same tier as the plan catalog)
// RLS (m481) backs both: templates writable only under is_platform_staff().
// NO e-sign provider is involved anywhere in this lane — the tenant signs
// IN-APP and the record is the signature; nothing here simulates a send.

import { headers } from "next/headers"
import { createServiceClient } from "@/lib/supabase/service"
import { requireSuperadmin, requirePlatformStaff } from "@/lib/auth/platform-guard"
import { revalidatePath } from "next/cache"

export interface SubscriptionContractTemplate {
  id: string
  name: string
  contract_type: string
  body_text: string | null
  body_storage_path: string | null
  version: number
  is_active: boolean
  created_at: string
  updated_at: string
  /** How many tenants have signed this template. */
  signature_count: number
}

// Audit — same conventions as plan-catalog: every mutation → superadmin_audit_log,
// non-fatal on failure (audit never blocks the action).
async function audit(actorUserId: string, action: string, targetId: string | null, details: Record<string, unknown>): Promise<void> {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    const { data: actor, error: actorErr } = await svc.from("users").select("email").eq("id", actorUserId).maybeSingle()
    if (actorErr) console.error("[subscription-contracts audit] actor lookup failed:", actorErr.message)
    const { error } = await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId,
      actor_email: (actor as { email?: string } | null)?.email ?? null,
      action,
      target_type: "platform_contract_template",
      target_id: targetId,
      details,
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
    if (error) console.error("[subscription-contracts audit] write failed:", error.message)
  } catch (err) {
    console.error("[subscription-contracts audit] write failed:", err)
  }
}

// ─── List templates (any platform staff) ─────────────────────────────────────

export async function listSubscriptionContractTemplatesAction(): Promise<
  { ok: true; templates: SubscriptionContractTemplate[] } | { ok: false; error: string }
> {
  const gate = await requirePlatformStaff()
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()

  const { data, error } = await svc
    .from("platform_contract_templates")
    .select("id, name, contract_type, body_text, body_storage_path, version, is_active, created_at, updated_at")
    .order("created_at", { ascending: false })
  if (error) return { ok: false, error: error.message }

  const { data: sigs, error: sigErr } = await svc
    .from("tenant_contract_signatures")
    .select("template_id")
  if (sigErr) return { ok: false, error: sigErr.message }
  const counts = new Map<string, number>()
  for (const s of (sigs ?? []) as Array<{ template_id: string }>) {
    counts.set(s.template_id, (counts.get(s.template_id) ?? 0) + 1)
  }

  return {
    ok: true,
    templates: ((data ?? []) as Array<Omit<SubscriptionContractTemplate, "signature_count">>).map((t) => ({
      ...t,
      signature_count: counts.get(t.id) ?? 0,
    })),
  }
}

// ─── Create / update a template (superadmin only) ────────────────────────────

export async function upsertSubscriptionContractTemplateAction(input: {
  id?: string
  name: string
  bodyText: string
  isActive?: boolean
}): Promise<{ ok: true; id: string; version: number } | { ok: false; error: string }> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: gate.error }

  const name = (input.name ?? "").trim()
  const bodyText = (input.bodyText ?? "").trim()
  if (!name) return { ok: false, error: "Give the contract a name" }
  if (!bodyText) return { ok: false, error: "A contract with no body is not a contract anyone can sign" }

  const svc = createServiceClient()

  if (input.id) {
    // A body revision bumps the version — signatures snapshot the version they
    // were given, so what a tenant signed stays provable after an edit.
    const { data: existing, error: readErr } = await svc
      .from("platform_contract_templates")
      .select("id, body_text, version")
      .eq("id", input.id)
      .maybeSingle()
    if (readErr) return { ok: false, error: readErr.message }
    if (!existing) return { ok: false, error: "Template not found" }
    const bodyChanged = (existing as { body_text: string | null }).body_text !== bodyText
    const nextVersion = (existing as { version: number }).version + (bodyChanged ? 1 : 0)

    const { error } = await svc
      .from("platform_contract_templates")
      .update({
        name,
        body_text: bodyText,
        version: nextVersion,
        ...(typeof input.isActive === "boolean" ? { is_active: input.isActive } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.id)
    if (error) return { ok: false, error: error.message }
    await audit(gate.userId, "subscription_contract_template.updated", input.id, { name, version: nextVersion, bodyChanged })
    revalidatePath("/dashboard/superadmin/contracts")
    return { ok: true, id: input.id, version: nextVersion }
  }

  const { data, error } = await svc
    .from("platform_contract_templates")
    .insert({
      name,
      contract_type: "subscription_agreement",
      body_text: bodyText,
      version: 1,
      is_active: input.isActive ?? true,
      created_by: gate.userId,
    })
    .select("id")
    .single()
  if (error) return { ok: false, error: error.message }
  const id = (data as { id: string }).id
  await audit(gate.userId, "subscription_contract_template.created", id, { name })
  revalidatePath("/dashboard/superadmin/contracts")
  return { ok: true, id, version: 1 }
}

// ─── Activate / retire a template (superadmin only) ──────────────────────────
// ONE active subscription agreement at a time: the tenant activation surface
// shows "the active agreement", so activating one retires the others.

export async function setSubscriptionContractTemplateActiveAction(
  templateId: string,
  active: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()

  if (active) {
    const { error: retireErr } = await svc
      .from("platform_contract_templates")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("contract_type", "subscription_agreement")
      .neq("id", templateId)
    if (retireErr) return { ok: false, error: retireErr.message }
  }

  const { data: updated, error } = await svc
    .from("platform_contract_templates")
    .update({ is_active: active, updated_at: new Date().toISOString() })
    .eq("id", templateId)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!updated || updated.length === 0) return { ok: false, error: "Template not found" }

  await audit(gate.userId, active ? "subscription_contract_template.activated" : "subscription_contract_template.retired", templateId, {})
  revalidatePath("/dashboard/superadmin/contracts")
  return { ok: true }
}

// ─── Who has signed (any platform staff) ─────────────────────────────────────

export interface TenantContractSignatureRow {
  id: string
  brokerage_id: string
  brokerage_name: string | null
  template_id: string
  template_version: number | null
  signed_name: string
  signed_at: string
  /** tenant_contract_signatures.signed_by — the SERVER-RESOLVED session account
   *  that executed the agreement (app/actions/admin/subscription-agreement.ts:157).
   *  A users.id: `signed_by` FKs users(id) (scripts/schema-fk-map.ts:704), and
   *  users.id / agents.id are disjoint id spaces. NULL on any row written before
   *  the column existed — "account not recorded", never "unverified signer". */
  signed_by: string | null
  /** Resolved from `users` in one batched `.in()`. NULL when signed_by is NULL, or
   *  when the account no longer exists — which is NOT the same as no signer. */
  signer_name: string | null
  signer_email: string | null
  /** The `signature` jsonb attestation. A TYPED NAME IS NOT AN ATTESTATION: the
   *  string in signed_name is whatever the signer keyed in, while this records
   *  HOW the agreement was executed. Missing or malformed jsonb yields NULLs and
   *  the surface says "method not recorded" — unknown-not-asserted, never
   *  "verified". */
  attestation_method: string | null
  attestation_signed_at: string | null
  attestation_typed_name: string | null
  /** TRUE only when the jsonb was present but did not carry a readable method —
   *  a malformed record is a different fact from an absent one and reads that way. */
  attestation_malformed: boolean
}

/** Read the `signature` jsonb defensively. Anything that is not an object with a
 *  non-empty string `method` is reported as NOT ASSERTED. This is a contract
 *  execution record for a paid subscription; guessing here would be manufacturing
 *  evidence. */
function readAttestation(raw: unknown): {
  method: string | null
  signedAt: string | null
  typedName: string | null
  malformed: boolean
} {
  const empty = { method: null, signedAt: null, typedName: null, malformed: false }
  if (raw === null || raw === undefined) return empty
  let obj: Record<string, unknown> | null = null
  if (typeof raw === "string") {
    // jsonb normally arrives parsed; a string column or a double-encoded write
    // would not. Try once, and treat a failure as malformed rather than absent.
    try { const p = JSON.parse(raw); obj = p && typeof p === "object" && !Array.isArray(p) ? p as Record<string, unknown> : null }
    catch { return { ...empty, malformed: true } }
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>
  }
  if (!obj) return { ...empty, malformed: true }

  const method = typeof obj.method === "string" && obj.method.trim() ? obj.method.trim() : null
  const signedAt = typeof obj.signed_at === "string" && obj.signed_at.trim() ? obj.signed_at.trim() : null
  const typedName = typeof obj.typed_name === "string" && obj.typed_name.trim() ? obj.typed_name.trim() : null
  return { method, signedAt, typedName, malformed: method === null }
}

export async function listTenantContractSignaturesAction(): Promise<
  { ok: true; signatures: TenantContractSignatureRow[] } | { ok: false; error: string }
> {
  // PLATFORM surface — requirePlatformStaff reads the `platform_role` column
  // (lib/auth/platform-guard.ts), never user_type='superadmin' (§4). Gate first,
  // service client second.
  const gate = await requirePlatformStaff()
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()

  const { data, error } = await svc
    .from("tenant_contract_signatures")
    .select("id, brokerage_id, template_id, template_version, signed_name, signed_at, signed_by, signature")
    .order("signed_at", { ascending: false })
    .limit(200)
  if (error) return { ok: false, error: error.message }
  const rows = (data ?? []) as Array<{
    id: string; brokerage_id: string; template_id: string; template_version: number | null
    signed_name: string; signed_at: string; signed_by: string | null; signature: unknown
  }>

  const brokerageIds = Array.from(new Set(rows.map((r) => r.brokerage_id)))
  const names = new Map<string, string>()
  if (brokerageIds.length > 0) {
    const { data: brokerages, error: bErr } = await svc
      .from("brokerages")
      .select("id, name")
      .in("id", brokerageIds)
    if (bErr) return { ok: false, error: bErr.message }
    for (const b of (brokerages ?? []) as Array<{ id: string; name: string | null }>) {
      names.set(b.id, b.name ?? "")
    }
  }

  // WHICH ACCOUNT SIGNED. One batched `.in()` over users — a platform surface
  // spans every tenant by design (platform sees all tenants, §4), so the read is
  // keyed on the signer ids this query already returned rather than pinned to one
  // brokerage. Each row's brokerage is rendered beside its signer.
  const signerIds = Array.from(new Set(rows.map((r) => r.signed_by).filter((v): v is string => !!v)))
  const signers = new Map<string, { name: string | null; email: string | null }>()
  if (signerIds.length > 0) {
    const { data: users, error: uErr } = await svc
      .from("users")
      .select("id, first_name, last_name, email")
      .in("id", signerIds)
    // A failed signer lookup must NOT read as "no signer account": fail the read
    // rather than render a signature record that quietly lost its account column.
    if (uErr) return { ok: false, error: `Signer accounts could not be resolved: ${uErr.message}` }
    for (const u of (users ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>) {
      const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim()
      signers.set(u.id, { name: full || null, email: u.email ?? null })
    }
  }

  return {
    ok: true,
    signatures: rows.map((r) => {
      const att = readAttestation(r.signature)
      const signer = r.signed_by ? signers.get(r.signed_by) : undefined
      return {
        id: r.id,
        brokerage_id: r.brokerage_id,
        brokerage_name: names.get(r.brokerage_id) ?? null,
        template_id: r.template_id,
        template_version: r.template_version,
        signed_name: r.signed_name,
        signed_at: r.signed_at,
        signed_by: r.signed_by ?? null,
        signer_name: signer?.name ?? null,
        signer_email: signer?.email ?? null,
        attestation_method: att.method,
        attestation_signed_at: att.signedAt,
        attestation_typed_name: att.typedName,
        attestation_malformed: att.malformed,
      }
    }),
  }
}
