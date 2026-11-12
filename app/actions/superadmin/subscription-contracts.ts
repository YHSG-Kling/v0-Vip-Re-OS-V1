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
//
// WAVE 151 (lane 151A — the owner's acceptance ruling). The rules moved to ONE
// module, lib/legal/subscription-agreement.ts, and this door became thin:
//   · a saved text is HASHED (content_sha256) and its docs/legal header read
//     (version label, the DRAFT banner);
//   · a NEW template is a DRAFT and INACTIVE; a body edit of a template that is
//     active, approved or already accepted by a tenant becomes a NEW version row
//     (supersedes_template_id) — the accepted text is never edited underneath a
//     tenant (reviseSubscriptionTemplate);
//   · APPROVAL is a recorded owner/counsel decision (who, when, the note) on a
//     text that carries no draft banner (approveSubscriptionTemplate);
//   · ACTIVATION refuses a draft or unapproved version (the m959 CHECK says the
//     same) and tells the signers of the superseded version to re-accept
//     (activateSubscriptionTemplate);
//   · an attached document is hashed from its bytes before the row claims it.

import { headers } from "next/headers"
import { createServiceClient } from "@/lib/supabase/service"
import { requireSuperadmin, requirePlatformStaff } from "@/lib/auth/platform-guard"
import { revalidatePath } from "next/cache"
import {
  mintSignedUpload,
  UPLOAD_PURPOSES,
  PLATFORM_CONTRACT_TENANT_SENTINEL,
  type SignedUploadTicket,
  type SignedUploadRefusal,
} from "@/lib/storage/signed-upload-url"
import {
  reviseSubscriptionTemplate, approveSubscriptionTemplate, activateSubscriptionTemplate, templateActivationRefusal,
  agreementBytesHash, agreementContentHash, isDraftMarked, AGREEMENT_APPROVAL_STATUSES, type AgreementApprovalStatus,
} from "@/lib/legal/subscription-agreement"

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
  /** wave 151: the document's own version label (docs/legal header), the content hash, the approval record, provenance. */
  version_label: string | null
  content_sha256: string | null
  approval_status: string | null
  approved_at: string | null
  /** wave 151: who recorded the approval (users.id) — read beside approved_at so the record is auditable, never write-only. */
  approved_by: string | null
  approval_note: string | null
  source_path: string | null
  supersedes_template_id: string | null
  /** The body still carries the draft banner — it can be neither approved nor activated. */
  draft_marked: boolean
  /** The recorded hash still equals the hash of the body on the row (false = the text was changed outside this door). */
  hash_matches: boolean | null
  /** Why this version cannot be made active right now — null when it can. */
  activation_blocker: string | null
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
    .select("id, name, contract_type, body_text, body_storage_path, version, is_active, created_at, updated_at, version_label, content_sha256, approval_status, approved_at, approved_by, approval_note, source_path, supersedes_template_id")
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
    templates: ((data ?? []) as Array<Omit<SubscriptionContractTemplate, "signature_count" | "draft_marked" | "hash_matches" | "activation_blocker">>).map((t) => {
      // ONE vocabulary: a stored status outside AGREEMENT_APPROVAL_STATUSES reads as a draft (never as approved).
      const status: AgreementApprovalStatus = (AGREEMENT_APPROVAL_STATUSES as readonly string[]).includes(t.approval_status ?? "") ? (t.approval_status as AgreementApprovalStatus) : "draft"
      const row = { ...t, approval_status: status, version_label: t.version_label ?? null, content_sha256: t.content_sha256 ?? null, approved_at: t.approved_at ?? null, approval_note: t.approval_note ?? null, source_path: t.source_path ?? null, supersedes_template_id: t.supersedes_template_id ?? null }
      return {
        ...row,
        signature_count: counts.get(t.id) ?? 0,
        draft_marked: isDraftMarked(t.body_text),
        hash_matches: t.body_text?.trim() && t.content_sha256 ? agreementContentHash(t.body_text) === t.content_sha256 : null,
        activation_blocker: templateActivationRefusal(row),
      }
    }),
  }
}

// ─── Create / revise a template (superadmin only) ────────────────────────────
// A NEW template is a draft and inactive. A body revision bumps the version — an
// edit of an active / approved / accepted text is a NEW version row, so every
// signature stays pinned to the exact text (template_version + content hash)
// that was read. `bodyChanged` is reported so the audit says what moved.

export interface UpsertSubscriptionContractTemplateInput {
  id?: string
  name: string
  bodyText: string
  /** The document's own version label (docs/legal header `Version:`); parsed from the body when omitted. */
  versionLabel?: string | null
  /** Provenance: the docs/legal path the text was taken from. */
  sourcePath?: string | null
}
export type UpsertSubscriptionContractTemplateResult =
  | { ok: true; id: string; version: number; created: boolean; supersededId: string | null; draftMarked: boolean; contentSha256: string; versionLabel: string | null }
  | { ok: false; error: string }

export async function upsertSubscriptionContractTemplateAction(input: UpsertSubscriptionContractTemplateInput): Promise<UpsertSubscriptionContractTemplateResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: gate.error }

  const name = (input.name ?? "").trim()
  const bodyText = (input.bodyText ?? "").trim()
  if (!name) return { ok: false, error: "Give the contract a name" }
  if (!bodyText) return { ok: false, error: "A contract with no body is not a contract anyone can sign" }

  const svc = createServiceClient()
  const r = await reviseSubscriptionTemplate(svc, { id: input.id ?? null, name, bodyText, versionLabel: input.versionLabel ?? null, sourcePath: input.sourcePath ?? null, actorUserId: gate.userId })
  if (!r.ok) return r
  await audit(gate.userId, r.created ? (r.supersededId ? "subscription_contract_template.new_version" : "subscription_contract_template.created") : "subscription_contract_template.updated", r.id,
    { name, version: r.version, bodyChanged: r.bodyChanged, supersededId: r.supersededId, contentSha256: r.contentSha256, versionLabel: r.versionLabel, draftMarked: r.draftMarked })
  revalidatePath("/dashboard/superadmin/contracts")
  return { ok: true, id: r.id, version: r.version, created: r.created, supersededId: r.supersededId, draftMarked: r.draftMarked, contentSha256: r.contentSha256, versionLabel: r.versionLabel }
}

// ─── Record the owner's / counsel's approval (superadmin only; wave 151) ─────
// Approval is a RECORD of a decision made outside this code — who approved the
// text and when — on a version that carries no draft banner. Nothing here infers
// approval; the note is required so the record names its source.

export async function approveSubscriptionContractTemplateAction(input: {
  templateId: string
  /** Who approved (owner / counsel), the date or reference — stored verbatim. */
  note: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  const templateId = (input.templateId ?? "").trim()
  if (!templateId) return { ok: false, error: "No template selected" }
  const svc = createServiceClient()
  const r = await approveSubscriptionTemplate(svc, { templateId, actorUserId: gate.userId, note: input.note })
  if (!r.ok) return r
  await audit(gate.userId, "subscription_contract_template.approved", templateId, { note: (input.note ?? "").trim().slice(0, 500) })
  revalidatePath("/dashboard/superadmin/contracts")
  return { ok: true }
}

// ─── Attach an uploaded document (superadmin only) ────────────────────────────
// LANE 1 (m481), THE STORAGE-PATH ARM's WRITER — built 2026-09-07 per owner
// ruling ("complete the building and editing for owner decisions … owners
// decision is build and fix"), closing the gap the tombstone in
// app/actions/admin/subscription-agreement.ts:74-110 named: m481 gives this
// table two body arms, in-app authoring above fills only body_text, and until
// now nothing filled body_storage_path. This is that filler, plus the tenant
// renderer added in that same file (getSubscriptionAgreementAction /
// signSubscriptionAgreementAction).
//
// TWO CALLS, same shape as every other signed-upload flow in this repo
// (lib/storage/browser-upload.ts's pattern, done server-side here since the
// caller is a "use server" action rather than a route the browser POSTs to
// directly): (1) plan the upload — mint a signed PUT — (2) after the browser
// PUTs the bytes, record the resulting path on the template row. Splitting them
// is not optional: the object must exist in Storage before the row claims it,
// or a "successful" attach could point at nothing.

export type PlatformContractUploadPlan =
  Pick<SignedUploadTicket, "bucket" | "path" | "token" | "signedUrl" | "ceilingBytes">

/** Step 1 — mint a signed PUT for a contract-document PDF. Superadmin-gated: this
 *  is platform configuration, same tier as authoring the body text itself. */
export async function planPlatformContractDocumentUploadAction(input: {
  fileName: string
  contentType: string
  bytes: number
}): Promise<{ ok: true; plan: PlatformContractUploadPlan } | { ok: false; error: string }> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: gate.error }

  const svc = createServiceClient()
  const ticket: SignedUploadTicket | SignedUploadRefusal = await mintSignedUpload(svc, {
    purpose: "platform_contract_document",
    // Not a real tenant — see PLATFORM_CONTRACT_TENANT_SENTINEL's own doc.
    identity: { brokerageId: PLATFORM_CONTRACT_TENANT_SENTINEL, userId: gate.userId },
    fileName: input.fileName,
    contentType: input.contentType,
    bytes: input.bytes,
  })
  if (!ticket.ok) return { ok: false, error: ticket.reason }

  return {
    ok: true,
    plan: { bucket: ticket.bucket, path: ticket.path, token: ticket.token, signedUrl: ticket.signedUrl, ceilingBytes: ticket.ceilingBytes },
  }
}

/** Step 2 — after the browser PUTs the bytes to the signed URL from step 1,
 *  record the path. Validated against the SAME purpose prefix the mint used, so
 *  a caller cannot point a template at an object outside this lane's own tree —
 *  the path is untrusted input at this call (it came back from the browser),
 *  even though it was this server that minted the URL that produced it.
 *  WAVE 151: the object is READ BACK and HASHED before the row claims it — a
 *  document that cannot be read is not attached (fail closed), and the hash is
 *  what every acceptance of this version is pinned to. Attaching a document to a
 *  template that is active / approved / accepted is refused: that is a new version. */
export async function attachPlatformContractDocumentAction(input: {
  templateId: string
  storagePath: string
}): Promise<{ ok: true; contentSha256: string } | { ok: false; error: string }> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: gate.error }

  const templateId = (input.templateId ?? "").trim()
  const storagePath = (input.storagePath ?? "").trim()
  if (!templateId) return { ok: false, error: "No template selected" }
  if (!storagePath) return { ok: false, error: "No uploaded document to attach" }

  const expectedPrefix = `${UPLOAD_PURPOSES.platform_contract_document.prefix({
    brokerageId: PLATFORM_CONTRACT_TENANT_SENTINEL,
    userId: "",
  })}/`
  if (!storagePath.startsWith(expectedPrefix)) {
    return { ok: false, error: "That path was not issued by this upload lane — refusing to attach it" }
  }

  const svc = createServiceClient()
  const { data: t, error: tErr } = await svc.from("platform_contract_templates").select("id, is_active, approval_status").eq("id", templateId).maybeSingle()
  if (tErr) return { ok: false, error: tErr.message }
  if (!t) return { ok: false, error: "Template not found" }
  const { data: sigs, error: sigErr } = await svc.from("tenant_contract_signatures").select("id").eq("template_id", templateId).limit(1)
  if (sigErr) return { ok: false, error: `Could not count the template's acceptances: ${sigErr.message}` }
  const tpl = t as { is_active: boolean; approval_status: string | null }
  if (tpl.is_active || tpl.approval_status === "approved" || (sigs ?? []).length > 0) {
    return { ok: false, error: "This version is active, approved or already accepted by a tenant — its document cannot be replaced. Create a new version and attach the document there." }
  }

  // READ BACK + HASH: the bytes the tenant will be shown are the bytes the acceptance is pinned to.
  const { data: blob, error: dlErr } = await svc.storage.from(UPLOAD_PURPOSES.platform_contract_document.bucket).download(storagePath)
  if (dlErr || !blob) return { ok: false, error: `The uploaded document could not be read back (${dlErr?.message ?? "no object"}) — not attached.` }
  const contentSha256 = agreementBytesHash(new Uint8Array(await blob.arrayBuffer()))

  const { data: updated, error } = await svc
    .from("platform_contract_templates")
    .update({ body_storage_path: storagePath, content_sha256: contentSha256, approval_status: "draft", approved_at: null, approved_by: null, approval_note: null, updated_at: new Date().toISOString() })
    .eq("id", templateId)
    .select("id")
  if (error) return { ok: false, error: error.message }
  // CLAUDE.md §3: an UPDATE matching nothing also resolves with no error — count
  // what came back rather than trusting the absence of `error`.
  if (!updated || updated.length === 0) return { ok: false, error: "Template not found" }

  await audit(gate.userId, "subscription_contract_template.document_attached", templateId, { storagePath, contentSha256 })
  revalidatePath("/dashboard/superadmin/contracts")
  return { ok: true, contentSha256 }
}

// ─── Activate / retire a template (superadmin only) ──────────────────────────
// ONE active subscription agreement at a time: the tenant activation surface
// shows "the active agreement", so activating one retires the others. WAVE 151:
// only an APPROVED version with no draft banner can be activated (the m959 CHECK
// platform_contract_templates_active_is_approved refuses the same at the
// database), and the signers of a superseded version are told to re-accept.

export async function setSubscriptionContractTemplateActiveAction(
  templateId: string,
  active: boolean,
): Promise<{ ok: true; retired?: number; reacceptanceNotified?: number } | { ok: false; error: string }> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()

  if (active) {
    const r = await activateSubscriptionTemplate(svc, { templateId, actorUserId: gate.userId })
    if (!r.ok) return r
    await audit(gate.userId, "subscription_contract_template.activated", templateId, { retired: r.retired, reacceptanceNotified: r.reacceptanceNotified, notifyErrors: r.notifyErrors.slice(0, 10) })
    revalidatePath("/dashboard/superadmin/contracts")
    return { ok: true, retired: r.retired, reacceptanceNotified: r.reacceptanceNotified }
  }

  const { data: updated, error } = await svc
    .from("platform_contract_templates")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", templateId)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!updated || updated.length === 0) return { ok: false, error: "Template not found" }

  await audit(gate.userId, "subscription_contract_template.retired", templateId, {})
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
  /** wave 151: the version label and content hash the acceptance is pinned to, and the signatory's typed title / authority. */
  version_label: string | null
  content_sha256: string | null
  signatory_title: string | null
  signatory_authority: string[]
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

function readSignatory(raw: unknown): { title: string | null; authority: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { title: null, authority: [] }
  const o = raw as Record<string, unknown>
  return {
    title: typeof o.typed_title === "string" && o.typed_title.trim() ? o.typed_title.trim() : null,
    authority: Array.isArray(o.authority_basis) ? o.authority_basis.filter((x): x is string => typeof x === "string") : [],
  }
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
    .select("id, brokerage_id, template_id, template_version, signed_name, signed_at, signed_by, signature, version_label, content_sha256, signatory")
    .order("signed_at", { ascending: false })
    .limit(200)
  if (error) return { ok: false, error: error.message }
  const rows = (data ?? []) as Array<{
    id: string; brokerage_id: string; template_id: string; template_version: number | null
    signed_name: string; signed_at: string; signed_by: string | null; signature: unknown
    version_label: string | null; content_sha256: string | null; signatory: unknown
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
      const who = readSignatory(r.signatory)
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
        version_label: r.version_label ?? null,
        content_sha256: r.content_sha256 ?? null,
        signatory_title: who.title,
        signatory_authority: who.authority,
      }
    }),
  }
}
