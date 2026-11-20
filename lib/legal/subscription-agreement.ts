/**
 * lib/legal/subscription-agreement.ts — THE SUBSCRIPTION AGREEMENT ACCEPTANCE RULES (wave 151, lane 151A)
 * ─────────────────────────────────────────────────────────────────────────────
 * The survivor is m481: platform staff AUTHOR `platform_contract_templates`, the tenant ACCEPTS one into
 * `tenant_contract_signatures` (the in-app record IS the signature — no e-sign provider, nothing simulated). Audited at
 * b2c93720 the rail was missing five things the owner's acceptance ruling names, and this module holds exactly those:
 *
 *   1. AUTHORITATIVE SIGNATORY — "corporate subscriber signer ≠ any arbitrary seat user". The sign door admitted every
 *      resolveTenantAdmin seat (team_lead and compliance_officer included). The corporate signer is the seat that may
 *      obligate the brokerage's books: lib/auth/resolve-user-role.ts resolveBrokerageFinanceAdmin (user_type OR a
 *      tenant-pinned grant OR the principal lead of a team / solo subscription — m526), the SAME predicate the live
 *      public.is_brokerage_finance_admin() applies, so app and RLS agree (m959 re-pins the INSERT policy to it). In a
 *      brokerage with several locations the signer must also hold the organization's aggregated view (a tenant
 *      leadership grant — lib/kernel/resolve-user-office.ts resolveViewerHierarchy, C34): an office head signs for no one
 *      but their office. No new roster, no new role: two existing predicates composed, in this one place.
 *   2. VERSION + CONTENT HASH — sha256 of the normalized text (or the stored document's bytes), recorded on the template
 *      and copied onto the acceptance so "what was accepted" is provable byte for byte, not by an integer alone.
 *   3. AFFIRMATIVE ACCEPTANCE WITH EVIDENCE — who (session user + typed name + title + the authority basis), when, from
 *      where (ip / user agent), of which version/hash, for which legal entity (the brokerage row's name / DBA / license).
 *   4. IMMUTABLE HISTORICAL COPY — the accepted text (or the document path + hash) travels onto the acceptance row; m959
 *      makes the row append-only (trigger), and a body revision of an active / approved / accepted template is a NEW
 *      template row (`supersedes_template_id`) — the text a tenant accepted is never edited underneath them.
 *   5. RETRIEVABLE DOWNLOAD + RE-ACCEPTANCE — the copy is served back with its integrity re-checked (a copy whose hash no
 *      longer matches is refused, never handed out as the contract); a new active version leaves the tenant awaiting
 *      acceptance again, and the signers of the superseded version are told.
 *
 * DRAFTS ARE NEVER ACCEPTED. Lane 151A2 writes the legal text under docs/legal/** carrying the banner
 * `DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE`; this module reads a document's `Version:` /
 * `Status:` header and the banner, and a template whose body carries the banner or whose approval_status is not
 * 'approved' cannot be activated (code here; the m959 CHECK `platform_contract_templates_active_is_approved` at the DB).
 * Approval is a RECORD of the owner's / counsel's decision (who, when, the reference) — never an inference by this code.
 *
 * SEPARATION (owner): the tenant SaaS contract (this) ≠ a Contact's marketing consent (lib/compliance consent rails) ≠
 * a listing / purchase / referral agreement (lib/kernel/document-compliance-audit.ts family). Nothing here reads those.
 *
 * CLIENTS: the tenant half takes the CALLER's authed client (RLS stays the second gate, as m481 designed); the platform
 * half takes the service client the superadmin door already holds. This module constructs no client of its own.
 */
import { createHash } from "node:crypto"
import { resolveTenantAdmin, resolveBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { resolveViewerHierarchy } from "@/lib/kernel/resolve-user-office"

type Client = any // eslint-disable-line @typescript-eslint/no-explicit-any -- the authed or service supabase client the caller holds

/** The banner every draft under docs/legal/** carries (lane 151A2 writes it; this is the ONE spelling the code reads). */
export const DRAFT_BANNER = "DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE"
/** ONE vocabulary for platform_contract_templates.approval_status (m959 CHECK platform_contract_templates_approval_status_check). */
export const AGREEMENT_APPROVAL_STATUSES = ["draft", "approved"] as const
export type AgreementApprovalStatus = (typeof AGREEMENT_APPROVAL_STATUSES)[number]
/** The execution method the in-app record carries (m481's spelling, unchanged). */
const ACCEPTANCE_METHOD = "in_app_click_to_sign"

// ── text identity ────────────────────────────────────────────────────────────────────────────────────────────────

/** Line endings and trailing whitespace are not contract terms: the hash is over this normal form. */
function normalizeAgreementText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim()
}

/** sha256 (hex) of the normalized agreement text — the version's content identity. */
export function agreementContentHash(text: string): string {
  return createHash("sha256").update(normalizeAgreementText(text), "utf8").digest("hex")
}

/** sha256 (hex) of a stored document's bytes (the storage-path arm). */
export function agreementBytesHash(bytes: ArrayBuffer | Uint8Array): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return createHash("sha256").update(buf).digest("hex")
}

// Tolerates an em dash, an en dash or a hyphen, any spacing, any case: the banner is read, not matched byte-for-byte.
const DRAFT_RE = /DRAFT\s*[—–-]+\s*OWNER\s+AND\s+QUALIFIED\s+LEGAL\s+COUNSEL\s+REVIEW\s*[—–-]+\s*NOT\s+APPROVED\s+FOR\s+USE/i

/** Does this text carry the draft banner anywhere? A draft is never the version a tenant accepts. */
export function isDraftMarked(text: string | null | undefined): boolean {
  return !!text && DRAFT_RE.test(text.replace(/\s+/g, " "))
}

interface LegalDocumentHeader {
  title: string | null
  /** The document's own `Version:` line (lane 151A2's header contract), or null when it carries none. */
  version: string | null
  /** The document's own `Status:` line, or null. */
  status: string | null
  /** The banner is present (anywhere in the text). */
  draft: boolean
}

/** Read the version / status header of a docs/legal/** document (tolerant of markdown emphasis, blockquotes and tables). */
function parseLegalDocumentHeader(markdown: string): LegalDocumentHeader {
  // `Version: 1.0.0`, `**Version:** 1.0.0`, `> Version: 1.0.0` and the table form `| **Version:** | 1.0.0 |` all read the same.
  const field = (name: string): string | null => {
    const re = new RegExp(`^[>*_\\-|\\s]*\\**\\s*${name}\\s*\\**\\s*[:：]\\s*\\**\\s*(?:\\|\\s*)?\\**\\s*([^|\\n]+?)\\s*\\**\\s*(?:\\|.*)?$`, "im")
    const m = re.exec(markdown)
    const v = m ? m[1].replace(/^\*+|\*+$/g, "").trim() : ""
    return v || null
  }
  const title = /^#\s+(.+?)\s*$/m.exec(markdown)?.[1]?.trim() ?? null
  return { title, version: field("version"), status: field("status"), draft: isDraftMarked(markdown) }
}

// ── template lifecycle rules (pure) ───────────────────────────────────────────────────────────────────────────────

export interface AgreementTemplateFacts {
  approval_status?: string | null
  body_text?: string | null
  body_storage_path?: string | null
  content_sha256?: string | null
}

/** Why this template cannot be recorded as APPROVED — null when it can. Approval is an owner/counsel act this only admits. */
function templateApprovalRefusal(t: AgreementTemplateFacts): string | null {
  if (!t.body_text?.trim() && !t.body_storage_path) return "This agreement has no body — there is nothing to approve."
  if (isDraftMarked(t.body_text)) return `This text still carries the draft banner ("${DRAFT_BANNER}") — a draft cannot be recorded as approved. Remove the banner only when the owner and qualified legal counsel have approved the text.`
  if (!t.content_sha256) return "This version has no content hash — save it again so the approved text can be proven."
  return null
}

/** Why this template cannot become the ACTIVE (acceptable) version — null when it can. */
export function templateActivationRefusal(t: AgreementTemplateFacts): string | null {
  const approval = templateApprovalRefusal(t)
  if (approval) return approval
  if (t.approval_status !== "approved") return "This version has not been recorded as approved by the owner and qualified legal counsel — approve it first, then make it active."
  return null
}

type TemplateRevisionPlan = "in_place" | "new_version"

/**
 * May the body be edited on this row, or must the edit be a NEW version? Anything a tenant may have read as the active
 * version, anything approved, and anything accepted is immutable: its revision is a new row that supersedes it.
 */
function templateRevisionPlan(existing: { is_active: boolean; approval_status?: string | null; signature_count: number; body_text: string | null }, nextBody: string): TemplateRevisionPlan {
  if (normalizeAgreementText(existing.body_text ?? "") === normalizeAgreementText(nextBody)) return "in_place"
  if (existing.is_active || existing.approval_status === "approved" || existing.signature_count > 0) return "new_version"
  return "in_place"
}

// ── the signatory ────────────────────────────────────────────────────────────────────────────────────────────────

export interface SignatoryAuthority {
  authorized: boolean
  /** Why — one entry per predicate that decided it (recorded on the acceptance; shown to the human). */
  basis: string[]
  /** The sentence shown when not authorized. */
  refusal: string | null
  /** The tenant runs several locations (the leadership-grant rule applied). */
  multiLocation: boolean
}
export type SignatoryAuthorityResult = { ok: true; authority: SignatoryAuthority } | { ok: false; error: string }

/**
 * May this SESSION user sign the subscription agreement FOR the brokerage on their row?
 *   floor      resolveTenantAdmin — a tenant admin at all (m481's own gate; RLS parity with is_brokerage_admin)
 *   corporate  resolveBrokerageFinanceAdmin — may keep the brokerage's books (user_type / pinned grant / team principal)
 *   scope      resolveViewerHierarchy — in a multi-location tenant, the aggregated view (tenant leadership grant)
 * Every refused read REFUSES (ok:false): a gate that cannot run does not pass (CLAUDE.md §4).
 */
export async function assessSignatoryAuthority(client: Client, userId: string, caller: { user_type?: string | null; brokerage_id?: string | null }): Promise<SignatoryAuthorityResult> {
  const tenantId = caller.brokerage_id ?? null
  if (!tenantId) return { ok: true, authority: { authorized: false, basis: [], refusal: "No brokerage on this account", multiLocation: false } }
  const floor = await resolveTenantAdmin(client, userId, caller)
  if (!floor.ok) return { ok: false, error: floor.error }
  if (!floor.isTenantAdmin) return { ok: true, authority: { authorized: false, basis: [], refusal: "Only your brokerage's admins can sign the subscription agreement", multiLocation: false } }
  const corporate = await resolveBrokerageFinanceAdmin(client, userId, caller)
  if (!corporate.ok) return { ok: false, error: corporate.error }
  if (!corporate.isFinanceAdmin) {
    return { ok: true, authority: { authorized: false, basis: [`tenant admin via ${floor.via}`], multiLocation: false,
      refusal: "Signing binds the brokerage to its subscription and its invoices. Only a seat that may keep the brokerage's books can sign for it — a broker, broker owner, brokerage admin or admin, or the principal lead of a team or solo subscription. A compliance officer, or a team lead inside a brokerage, cannot sign for the brokerage; ask one of them to." } }
  }
  // SEVERAL LOCATIONS → the organization's leadership grant (C34). A single-office tenant is bound by the books predicate
  // alone (which honors the grant-only admin — the ruling's second seat — that the hierarchy's user_type roster rule does
  // not read). The office count is read here, by id, so the rule is applied to the tenant's SHAPE, never to its name.
  const { data: offices, error: offErr } = await client.from("locations").select("id, status").eq("brokerage_id", tenantId)
  if (offErr) return { ok: false, error: `Your brokerage's offices could not be read (${offErr.message}) — signing is held until they can.` }
  const activeOffices = ((offices ?? []) as Array<{ status?: string | null }>).filter((o) => (o.status ?? "active") === "active").length
  const hierarchy = await resolveViewerHierarchy(client, { userId, brokerageId: tenantId })
  if (!hierarchy.ok) return { ok: false, error: `Your scope in the brokerage could not be read (${hierarchy.error}) — signing is held until it can.` }
  const multiLocation = hierarchy.tier === "multi_location" || activeOffices >= 2
  const basis = [`tenant admin via ${floor.via}`, `books via ${corporate.via}`, `hierarchy ${hierarchy.scope.kind}${hierarchy.scope.aggregate ? " (every office)" : ""}`, ...hierarchy.scope.basis]
  if (multiLocation && !hierarchy.scope.aggregate) {
    return { ok: true, authority: { authorized: false, basis, multiLocation,
      refusal: "In a brokerage with several locations only the organization's leadership signs for it — an office head or team lead signs for no one but their own office or team. Ask the brokerage's leadership to sign." } }
  }
  return { ok: true, authority: { authorized: true, basis, refusal: null, multiLocation } }
}

// ── the acceptance row ───────────────────────────────────────────────────────────────────────────────────────────

export interface AcceptanceTemplate {
  id: string
  version: number
  version_label?: string | null
  content_sha256?: string | null
  approval_status?: string | null
  body_text: string | null
  body_storage_path: string | null
  is_active: boolean
}

/** Why this template cannot be ACCEPTED right now — null when it can. */
export function acceptanceRefusal(t: AcceptanceTemplate | null | undefined): string | null {
  if (!t || !t.is_active) return "This agreement is no longer the active version — reload and sign the current one"
  const activation = templateActivationRefusal(t)
  if (activation) return `This agreement cannot be accepted yet: ${activation}`
  return null
}

export interface AcceptanceRowInput {
  template: AcceptanceTemplate
  signedName: string
  signedTitle: string | null
  signer: { id: string; email: string | null; userType: string | null }
  authority: SignatoryAuthority
  /** The corporate subscriber as the brokerages row states it (name / DBA / license) — the legal entity bound. */
  legalEntity: { name: string | null; dba?: string | null; licenseNumber?: string | null; licenseState?: string | null } | null
  ip: string | null
  userAgent: string | null
  /** The execution method the door states for itself (the in-app record rail — never a provider). Default ACCEPTANCE_METHOD. */
  method?: typeof ACCEPTANCE_METHOD
  now?: Date
}

/**
 * PURE: the acceptance row's EVIDENCE columns (everything but the identity keys the door writes itself). Refuses when
 * the text on screen is not the recorded version (hash mismatch) — what is accepted must be what was hashed.
 */
export function buildAcceptanceRow(input: AcceptanceRowInput): { ok: true; row: Record<string, unknown> } | { ok: false; error: string } {
  const t = input.template
  const signedName = input.signedName.trim()
  if (!signedName) return { ok: false, error: "Type your full name to sign" }
  const bodyHash = t.body_text?.trim() ? agreementContentHash(t.body_text) : null
  if (bodyHash && t.content_sha256 && bodyHash !== t.content_sha256) return { ok: false, error: "The text on screen is not the recorded version of this agreement (content hash mismatch) — reload and read the current one before signing." }
  const contentSha = bodyHash ?? t.content_sha256 ?? null
  if (!contentSha) return { ok: false, error: "This agreement has no content hash — nothing can be accepted until the platform records its text." }
  const at = (input.now ?? new Date()).toISOString()
  const title = input.signedTitle?.trim() || null
  const signatory = {
    user_id: input.signer.id, email: input.signer.email, user_type: input.signer.userType, typed_name: signedName, typed_title: title,
    legal_entity: input.legalEntity, authority_basis: input.authority.basis, multi_location: input.authority.multiLocation,
  }
  return {
    ok: true,
    row: {
      template_version: t.version,
      version_label: t.version_label ?? null,
      content_sha256: contentSha,
      accepted_body_text: t.body_text?.trim() ? t.body_text : null,
      accepted_document_path: t.body_text?.trim() ? null : t.body_storage_path ?? null,
      signed_name: signedName,
      signature: { method: input.method ?? ACCEPTANCE_METHOD, typed_name: signedName, typed_title: title, signed_at: at, content_sha256: contentSha, version_label: t.version_label ?? null, template_version: t.version },
      signatory,
      accepted_ip: input.ip,
      accepted_user_agent: input.userAgent,
    },
  }
}

// ── the retrievable copy ─────────────────────────────────────────────────────────────────────────────────────────

export interface AcceptedSignatureRow {
  id: string
  signed_name: string
  signed_at: string
  template_version: number | null
  version_label?: string | null
  content_sha256?: string | null
  accepted_body_text?: string | null
  accepted_document_path?: string | null
  signatory?: Record<string, unknown> | null
  accepted_ip?: string | null
}

/** Does the stored copy still hash to what was accepted? A text copy is re-hashed; a document copy carries its path + hash. */
function acceptedCopyIntegrity(sig: AcceptedSignatureRow): { ok: true } | { ok: false; error: string } {
  if (!sig.content_sha256) return { ok: false, error: "This acceptance carries no content hash (recorded before hashing existed) — the copy cannot be verified." }
  if (sig.accepted_body_text) {
    const now = agreementContentHash(sig.accepted_body_text)
    if (now !== sig.content_sha256) return { ok: false, error: "The stored copy no longer matches the hash recorded at acceptance — refusing to hand out an altered contract. Contact platform support." }
    return { ok: true }
  }
  if (sig.accepted_document_path) return { ok: true }
  return { ok: false, error: "This acceptance holds no copy of the agreement text." }
}

export interface AcceptedCopy { fileName: string; contentType: "text/markdown"; body: string; sha256: string }

/** PURE: the downloadable copy — a provenance header, then the accepted text verbatim (or the document reference). */
function acceptedCopyDocument(sig: AcceptedSignatureRow, tenantName: string | null, templateName: string | null): AcceptedCopy {
  const s = (sig.signatory ?? {}) as Record<string, unknown>
  const entity = (s.legal_entity ?? null) as { name?: string | null; dba?: string | null; licenseNumber?: string | null; licenseState?: string | null } | null
  const header = [
    `# ${templateName ?? "Subscription Agreement"} — accepted copy`,
    "",
    `- Subscriber: ${entity?.name ?? tenantName ?? "not recorded"}${entity?.dba ? ` (DBA ${entity.dba})` : ""}${entity?.licenseNumber ? ` · license ${entity.licenseNumber}${entity.licenseState ? ` (${entity.licenseState})` : ""}` : ""}`,
    `- Accepted by: ${sig.signed_name}${typeof s.typed_title === "string" && s.typed_title ? `, ${s.typed_title}` : ""}${typeof s.email === "string" ? ` <${s.email}>` : ""}`,
    `- Accepted at: ${sig.signed_at}${sig.accepted_ip ? ` from ${sig.accepted_ip}` : ""}`,
    `- Agreement version: ${sig.version_label ?? (sig.template_version !== null && sig.template_version !== undefined ? `v${sig.template_version}` : "not recorded")}`,
    `- Content sha256: ${sig.content_sha256 ?? "not recorded"}`,
    `- Acceptance record: ${sig.id}`,
    "",
    "---",
    "",
  ].join("\n")
  const body = sig.accepted_body_text ?? `The accepted agreement is a stored document: ${sig.accepted_document_path ?? "(path not recorded)"} — sha256 ${sig.content_sha256 ?? "not recorded"}.`
  const text = header + body + "\n"
  const stamp = sig.signed_at.slice(0, 10)
  return { fileName: `subscription-agreement-${sig.version_label ?? `v${sig.template_version ?? "x"}`}-accepted-${stamp}.md`.replace(/[^a-zA-Z0-9._-]+/g, "-"), contentType: "text/markdown", body: text, sha256: sig.content_sha256 ?? "" }
}

/** Read ONE acceptance of THIS tenant through the caller's client (RLS keeps it the tenant's own), verify it, render it. */
export async function readAcceptedCopy(client: Client, input: { signatureId: string; brokerage_id: string }): Promise<{ ok: true; copy: AcceptedCopy } | { ok: false; error: string }> {
  const { data, error } = await client.from("tenant_contract_signatures")
    .select("id, brokerage_id, template_id, signed_name, signed_at, template_version, version_label, content_sha256, accepted_body_text, accepted_document_path, signatory, accepted_ip")
    .eq("id", input.signatureId).eq("brokerage_id", input.brokerage_id).maybeSingle()
  if (error) return { ok: false, error: `Could not read your acceptance record: ${error.message}` }
  const sig = data as (AcceptedSignatureRow & { brokerage_id: string; template_id: string }) | null
  if (!sig) return { ok: false, error: "No such acceptance record for your brokerage" }
  const integrity = acceptedCopyIntegrity(sig)
  if (!integrity.ok) return integrity
  const [{ data: tpl, error: tplErr }, { data: tenant, error: tenantErr }] = await Promise.all([
    client.from("platform_contract_templates").select("name").eq("id", sig.template_id).maybeSingle(),
    client.from("brokerages").select("name").eq("id", sig.brokerage_id).maybeSingle(),
  ])
  if (tplErr) return { ok: false, error: `Could not read the agreement's name: ${tplErr.message}` }
  if (tenantErr) return { ok: false, error: `Could not read your brokerage's name: ${tenantErr.message}` }
  return { ok: true, copy: acceptedCopyDocument(sig, (tenant as { name?: string | null } | null)?.name ?? null, (tpl as { name?: string | null } | null)?.name ?? null) }
}

// ── the platform half (service client the superadmin door holds) ────────────────────────────────────────────────

export interface ReviseTemplateInput {
  id?: string | null
  name: string
  bodyText: string
  /** The document's own version label (docs/legal header `Version:`), when the operator supplies one; else parsed from the body. */
  versionLabel?: string | null
  /** Where the text came from (a docs/legal path) — provenance only. */
  sourcePath?: string | null
  actorUserId: string
}
export type ReviseTemplateResult =
  | { ok: true; id: string; version: number; created: boolean; supersededId: string | null; plan: TemplateRevisionPlan | "new"; bodyChanged: boolean; draftMarked: boolean; contentSha256: string; versionLabel: string | null }
  | { ok: false; error: string }

/**
 * Save a template's text. A NEW template is a DRAFT and INACTIVE (m959: is_active defaults false; a draft is never active).
 * An edit of a template that is active, approved or accepted becomes a NEW row (version + 1, supersedes the old one, draft,
 * inactive) — the old row's text is never changed. An edit of an unaccepted inactive draft happens in place.
 */
export async function reviseSubscriptionTemplate(svc: Client, input: ReviseTemplateInput): Promise<ReviseTemplateResult> {
  const name = (input.name ?? "").trim()
  const bodyText = (input.bodyText ?? "").trim()
  if (!name) return { ok: false, error: "Give the contract a name" }
  if (!bodyText) return { ok: false, error: "A contract with no body is not a contract anyone can sign" }
  const header = parseLegalDocumentHeader(bodyText)
  const versionLabel = (input.versionLabel ?? "").trim() || header.version
  const contentSha256 = agreementContentHash(bodyText)
  const draftMarked = header.draft
  const sourcePath = (input.sourcePath ?? "").trim() || null
  const now = new Date().toISOString()

  if (input.id) {
    const { data: existing, error: readErr } = await svc.from("platform_contract_templates").select("id, name, body_text, version, is_active, approval_status").eq("id", input.id).maybeSingle()
    if (readErr) return { ok: false, error: readErr.message }
    if (!existing) return { ok: false, error: "Template not found" }
    const { data: sigs, error: sigErr } = await svc.from("tenant_contract_signatures").select("id").eq("template_id", input.id)
    if (sigErr) return { ok: false, error: `Could not count the template's acceptances: ${sigErr.message}` }
    const ex = existing as { id: string; body_text: string | null; version: number; is_active: boolean; approval_status: string | null }
    const plan = templateRevisionPlan({ is_active: ex.is_active, approval_status: ex.approval_status, signature_count: (sigs ?? []).length, body_text: ex.body_text }, bodyText)
    const bodyChanged = normalizeAgreementText(ex.body_text ?? "") !== normalizeAgreementText(bodyText)
    if (plan === "new_version") {
      const { data: made, error: insErr } = await svc.from("platform_contract_templates").insert({
        name, contract_type: "subscription_agreement", body_text: bodyText, version: ex.version + 1, is_active: false,
        approval_status: "draft", content_sha256: contentSha256, version_label: versionLabel, source_path: sourcePath,
        supersedes_template_id: ex.id, created_by: input.actorUserId,
      }).select("id").single()
      if (insErr || !made) return { ok: false, error: `The new version was not recorded: ${insErr?.message ?? "no row"}` }
      return { ok: true, id: (made as { id: string }).id, version: ex.version + 1, created: true, supersededId: ex.id, plan, bodyChanged, draftMarked, contentSha256, versionLabel }
    }
    const { data: up, error: upErr } = await svc.from("platform_contract_templates").update({
      name, body_text: bodyText, version: ex.version + (bodyChanged ? 1 : 0), content_sha256: contentSha256, version_label: versionLabel, source_path: sourcePath,
      // Any text change on a draft re-opens approval; a name-only edit keeps whatever was recorded.
      ...(bodyChanged ? { approval_status: "draft", approved_at: null, approved_by: null, approval_note: null } : {}),
      updated_at: now,
    }).eq("id", ex.id).select("id")
    if (upErr) return { ok: false, error: upErr.message }
    if ((up ?? []).length !== 1) return { ok: false, error: "Template not found" }
    return { ok: true, id: ex.id, version: ex.version + (bodyChanged ? 1 : 0), created: false, supersededId: null, plan, bodyChanged, draftMarked, contentSha256, versionLabel }
  }

  const { data, error } = await svc.from("platform_contract_templates").insert({
    name, contract_type: "subscription_agreement", body_text: bodyText, version: 1, is_active: false, approval_status: "draft",
    content_sha256: contentSha256, version_label: versionLabel, source_path: sourcePath, created_by: input.actorUserId,
  }).select("id").single()
  if (error || !data) return { ok: false, error: error?.message ?? "Template was not recorded" }
  return { ok: true, id: (data as { id: string }).id, version: 1, created: true, supersededId: null, plan: "new", bodyChanged: true, draftMarked, contentSha256, versionLabel }
}

/** Record the owner's / counsel's approval on a version that carries no draft banner. The note names who approved and when. */
export async function approveSubscriptionTemplate(svc: Client, input: { templateId: string; actorUserId: string; note: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const note = (input.note ?? "").trim()
  if (!note) return { ok: false, error: "Name the approval: who approved this text (owner, counsel) and the date or reference" }
  const { data: t, error } = await svc.from("platform_contract_templates").select("id, body_text, body_storage_path, content_sha256, approval_status").eq("id", input.templateId).maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!t) return { ok: false, error: "Template not found" }
  const refusal = templateApprovalRefusal(t as AgreementTemplateFacts)
  if (refusal) return { ok: false, error: refusal }
  const { data: up, error: upErr } = await svc.from("platform_contract_templates")
    .update({ approval_status: "approved", approved_at: new Date().toISOString(), approved_by: input.actorUserId, approval_note: note.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("id", input.templateId).select("id")
  if (upErr) return { ok: false, error: upErr.message }
  if ((up ?? []).length !== 1) return { ok: false, error: "Template not found" }
  return { ok: true }
}

/**
 * Make an APPROVED version the active one (retiring the others) — and tell every brokerage that accepted a superseded
 * version that re-acceptance is needed (one notification to the account that signed, per brokerage). Refuses a draft.
 */
export async function activateSubscriptionTemplate(svc: Client, input: { templateId: string; actorUserId: string }): Promise<{ ok: true; retired: number; reacceptanceNotified: number; notifyErrors: string[] } | { ok: false; error: string }> {
  const { data: t, error } = await svc.from("platform_contract_templates").select("id, name, body_text, body_storage_path, content_sha256, approval_status, version, version_label").eq("id", input.templateId).maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!t) return { ok: false, error: "Template not found" }
  const tpl = t as AgreementTemplateFacts & { id: string; name: string; version: number; version_label: string | null }
  const refusal = templateActivationRefusal(tpl)
  if (refusal) return { ok: false, error: refusal }
  const now = new Date().toISOString()
  const { data: retiredRows, error: retireErr } = await svc.from("platform_contract_templates").update({ is_active: false, updated_at: now })
    .eq("contract_type", "subscription_agreement").eq("is_active", true).neq("id", tpl.id).select("id")
  if (retireErr) return { ok: false, error: retireErr.message }
  const { data: up, error: upErr } = await svc.from("platform_contract_templates").update({ is_active: true, updated_at: now }).eq("id", tpl.id).select("id")
  if (upErr) return { ok: false, error: upErr.message }
  if ((up ?? []).length !== 1) return { ok: false, error: "Template not found" }

  // RE-ACCEPTANCE: brokerages that accepted some OTHER version and not this one.
  const { data: sigs, error: sigErr } = await svc.from("tenant_contract_signatures").select("brokerage_id, template_id, signed_by, signed_at")
  const notifyErrors: string[] = []
  let notified = 0
  if (sigErr) notifyErrors.push(`acceptances read refused: ${sigErr.message}`)
  else {
    const rows = (sigs ?? []) as Array<{ brokerage_id: string; template_id: string; signed_by: string | null; signed_at: string }>
    const acceptedCurrent = new Set(rows.filter((r) => r.template_id === tpl.id).map((r) => r.brokerage_id))
    const latestOther = new Map<string, { signed_by: string | null; signed_at: string }>()
    for (const r of rows) {
      if (r.template_id === tpl.id || acceptedCurrent.has(r.brokerage_id)) continue
      const prev = latestOther.get(r.brokerage_id)
      if (!prev || prev.signed_at < r.signed_at) latestOther.set(r.brokerage_id, { signed_by: r.signed_by, signed_at: r.signed_at })
    }
    for (const [brokerageId, last] of latestOther) {
      if (!last.signed_by) { notifyErrors.push(`${brokerageId}: no signer account on the prior acceptance`); continue }
      const { error: nErr } = await svc.from("notifications").insert({
        user_id: last.signed_by, brokerage_id: brokerageId, type: "subscription_agreement_reacceptance",
        title: "A new version of the Subscription Agreement needs your acceptance",
        body: `${tpl.name} ${tpl.version_label ?? `v${tpl.version}`} is now the current agreement. Your brokerage accepted an earlier version; please review and accept the current one on Billing.`,
        priority: "high", is_read: false,
      })
      if (nErr) notifyErrors.push(`${brokerageId}: ${nErr.message}`)
      else notified++
    }
  }
  return { ok: true, retired: (retiredRows ?? []).length, reacceptanceNotified: notified, notifyErrors }
}
