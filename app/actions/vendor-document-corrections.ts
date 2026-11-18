"use server"

/**
 * app/actions/vendor-document-corrections.ts — WAVE 153 (lane 153D). THE DOORS FOR AN ISSUER'S CORRECTED DOCUMENT.
 *
 * Owner (verbatim, 2026-11-14): "lender/title or any vendors can correct their own documents."
 *
 * Two doors, one governed write (lib/documents/vendor-document-correction.ts fileIssuerCorrection):
 *   · submitIssuerDocumentCorrectionAction — the lender / title company / vendor ITSELF, signed in to its portal. Its identity is
 *     derived from the SESSION only (lib/kernel/portal-auth.ts resolveExternalPartnerIdentity — no partner id is taken from the
 *     caller); its tenant is its own users.brokerage_id; its assignment to the deal is read by the core.
 *   · recordOffPlatformIssuerDocumentAction — the deal's agent, its TC or tenant staff filing what an issuer sent OFF the platform
 *     (an emailed corrected statement), with the proof of how it arrived; a follow-up task asks the agent to confirm it with the issuer.
 * Every export is a public endpoint (CLAUDE.md §4): gate first, then the service client; the tenant never comes from the body. The
 * bytes go to the PRIVATE transaction-documents bucket under the tenant / deal prefix (lib/storage/put-and-sign.ts), and their
 * sha256 rides the filing so the version is tied to exactly what was received.
 */

import { createHash, randomUUID } from "node:crypto"
import { createClient } from "@/lib/supabase/server"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** What an issuer's document arrives as — a scan or a PDF. */
const ALLOWED_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/heic", "image/webp"])

type Result = { success: true; message: string; documentId: string | null; reopenedApproval: boolean } | { success: false; error: string }
type Original = { rail: "documents" | "transaction_documents"; id: string }

/** Store the bytes privately under the tenant / deal prefix and hash them. Module-private (a "use server" file exports endpoints only). */
async function storeCorrectionFile(brokerageId: string, transactionId: string, fileName: string, contentType: string, fileData: string): Promise<{ ok: true; storageUrl: string; path: string; sha256: string; name: string } | { ok: false; error: string }> {
  if (!ALLOWED_TYPES.has(String(contentType ?? "").toLowerCase())) return { ok: false, error: "Upload the corrected document as a PDF or an image (PNG, JPEG, HEIC or WebP)." }
  const raw = String(fileData ?? "")
  const b64 = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw
  const bytes = b64 ? Buffer.from(b64, "base64") : Buffer.alloc(0)
  if (bytes.length === 0) return { ok: false, error: "No file was received. Choose the corrected document and try again." }
  const { checkUpload } = await import("@/lib/storage/file-limits")
  const size = checkUpload({ bucket: "transaction-documents", transport: "server_action_base64", bytes: bytes.length, contentType })
  if (!size.ok) return { ok: false, error: size.reason }
  const { sanitizeUploadFileName } = await import("@/lib/storage/signed-upload-url")
  const name = sanitizeUploadFileName(fileName)
  const path = `issuer-corrections/${brokerageId}/${transactionId}/${randomUUID()}-${name}`
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { putAndSign } = await import("@/lib/storage/put-and-sign")
  const stored = await putAndSign(createServiceClient() as never, { bucket: "transaction-documents", path, body: bytes, contentType, brokerageId, reason: "issuer_document_correction" })
  if (!stored.ok) return { ok: false, error: "The file couldn't be stored, so nothing was filed. Try again shortly." }
  return { ok: true, storageUrl: stored.ref, path: stored.path, sha256: createHash("sha256").update(bytes).digest("hex"), name }
}

/** A refusal the person reads, through THE PRESENTER (153D-8, wave 153 lane 153Q). A raw database / ledger detail is LOGGED with a
 *  reference by presentTenantError and never shown; every other refusal is the contract sentence, gated by tenantCopyVerdict. */
async function refusal(what: string, audience: "vendor" | "account", detail?: string): Promise<{ success: false; error: string }> {
  const { presentTenantError, presentTenantMessage } = await import("@/lib/errors")
  const m = detail
    ? presentTenantError({ what, raw: detail, next: "you", action: null, context: "issuer-document-correction", audience })
    : presentTenantMessage({ what, next: "you", audience })
  return { success: false, error: m.sentence }
}

async function plainResult(out: Awaited<ReturnType<typeof import("@/lib/documents/vendor-document-correction").fileIssuerCorrection>>, audience: "vendor" | "account"): Promise<Result> {
  if (!out.ok) return refusal(out.message, audience, out.detail)
  if (out.replay) return { success: true, message: "This corrected file was already filed — nothing was filed twice.", documentId: null, reopenedApproval: false }
  const message = out.mode === "post_close_adjustment"
    ? "The deal has closed, so the closed record was not changed. Your corrected version was filed as a post-closing adjustment and the brokerage was asked to review it."
    : `Your corrected version was filed as the current version; the earlier one is kept as history. The agent, TC and compliance were told${out.recheck?.ran ? " and the closing checks re-ran" : ""}.`
  return { success: true, message, documentId: out.documentId, reopenedApproval: out.approvalReopened }
}

/** The issuer (lender / title company / vendor) files a corrected version of ITS OWN document on a deal it is assigned to. */
export async function submitIssuerDocumentCorrectionAction(input: {
  transactionId: string
  original: Original
  fileName: string
  contentType: string
  /** Base64 or a data: URL. */
  fileData: string
  correctedFields?: Record<string, string | number | null> | null
  note?: string | null
  /** Only when the signed-in account is BOTH a title user and a vendor: which hat files this. */
  as?: "title" | "vendor"
}): Promise<Result> {
  if (!UUID.test(String(input?.transactionId ?? "")) || !UUID.test(String(input?.original?.id ?? "")) || !["documents", "transaction_documents"].includes(String(input?.original?.rail))) {
    return { success: false, error: "Choose the document on your deal and the corrected file." }
  }
  const supabase = await createClient()
  const { resolveExternalPartnerIdentity } = await import("@/lib/kernel/portal-auth")
  const who = await resolveExternalPartnerIdentity(supabase)
  if (!who.ok) return { success: false, error: who.reason === "refused" ? "Your access couldn't be confirmed just now, so nothing was filed. Try again shortly." : "Only a lender, title company or vendor on the deal can file a corrected version of its document." }
  const id = who.identity
  if (!id.brokerageId) return { success: false, error: "Your account isn't linked to a business on the platform, so nothing was filed. Ask the agent you work with." }
  const asTitle = input.as === "title" ? id.isTitlePartner : input.as === "vendor" ? false : !id.vendorId && id.isTitlePartner
  let identity: { kind: "title"; email: string } | { kind: "lender" | "vendor"; vendorId: string }
  if (asTitle) {
    const { data: tu, error: tuErr } = await supabase.from("title_company_users").select("email").eq("user_id", id.userId).limit(1)
    if (tuErr) return { success: false, error: "Your title company access couldn't be confirmed just now, so nothing was filed. Try again shortly." }
    const email = ((tu ?? []) as Array<{ email: string | null }>)[0]?.email ?? null
    if (!email) return { success: false, error: "Your title company profile has no email, so the deal's title assignment can't be matched. Ask the agent to update it." }
    identity = { kind: "title", email }
  } else if (id.vendorId) {
    identity = { kind: id.isLenderVendor ? "lender" : "vendor", vendorId: id.vendorId }
  } else {
    return { success: false, error: "Only a lender, title company or vendor on the deal can file a corrected version of its document." }
  }

  const stored = await storeCorrectionFile(id.brokerageId, input.transactionId, input.fileName, input.contentType, input.fileData)
  if (!stored.ok) return { success: false, error: stored.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { fileIssuerCorrection } = await import("@/lib/documents/vendor-document-correction")
  const out = await fileIssuerCorrection(createServiceClient() as never, {
    brokerageId: id.brokerageId, transactionId: input.transactionId, original: input.original,
    actor: { via: "issuer", userId: id.userId, identity },
    file: { storageUrl: stored.storageUrl, storagePath: stored.path, fileName: stored.name, sha256: stored.sha256 },
    correctedFields: input.correctedFields ?? null, note: input.note ?? null,
  })
  return plainResult(out, "vendor")
}

/** The deal's agent, TC or tenant staff file what an issuer sent OFF the platform, with the proof of how it arrived. */
export async function recordOffPlatformIssuerDocumentAction(input: {
  transactionId: string
  original: Original
  onBehalfOf: { kind: "title" } | { kind: "lender" | "vendor"; vendorId: string }
  proof: { channel: string; sender: string; receivedAt: string; reference?: string | null }
  fileName: string
  contentType: string
  fileData: string
  note?: string | null
}): Promise<Result> {
  if (!UUID.test(String(input?.transactionId ?? "")) || !UUID.test(String(input?.original?.id ?? "")) || !["documents", "transaction_documents"].includes(String(input?.original?.rail))) {
    return { success: false, error: "Choose the document on the deal and the corrected file." }
  }
  if (input.onBehalfOf?.kind !== "title" && !UUID.test(String((input.onBehalfOf as { vendorId?: string })?.vendorId ?? ""))) return { success: false, error: "Choose which vendor on the deal sent the corrected file." }
  const { resolveSessionActor } = await import("@/lib/agreements/session-actor")
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: "Sign in again to file a document." }
  const B = s.actor.brokerageId
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  // GATE: the deal's agent, its TC or tenant staff (the roster that may answer the closing question) — read after the session tenant pin.
  const { data: tx, error: tErr } = await svc.from("transactions").select("id, agent_id, buyer_agent_id, seller_agent_id, coordinator_id").eq("id", input.transactionId).eq("brokerage_id", B).maybeSingle()
  if (tErr) return { success: false, error: "The deal couldn't be read just now, so nothing was filed. Try again shortly." }
  if (!tx) return { success: false, error: "This deal isn't in your account, so nothing was filed." }
  const t = tx as { agent_id: string | null; buyer_agent_id: string | null; seller_agent_id: string | null; coordinator_id: string | null }
  let coordinatorUserId: string | null = null
  if (t.coordinator_id) {
    const { data: tc, error: tcErr } = await svc.from("transaction_coordinators").select("user_id").eq("id", t.coordinator_id).eq("brokerage_id", B).maybeSingle()
    if (tcErr) return { success: false, error: "The deal team couldn't be read just now, so nothing was filed. Try again shortly." }
    coordinatorUserId = (tc as { user_id?: string | null } | null)?.user_id ?? null
  }
  const { mayAttestClosing } = await import("@/lib/commission/closing-verification")
  if (!mayAttestClosing(s.actor, { agentIds: [t.agent_id, t.buyer_agent_id, t.seller_agent_id], coordinatorUserId })) return { success: false, error: "Only the deal's agent, its TC or your compliance team can file a vendor's document for this deal." }

  const stored = await storeCorrectionFile(B, input.transactionId, input.fileName, input.contentType, input.fileData)
  if (!stored.ok) return { success: false, error: stored.error }
  const { fileIssuerCorrection } = await import("@/lib/documents/vendor-document-correction")
  const out = await fileIssuerCorrection(svc as never, {
    brokerageId: B, transactionId: input.transactionId, original: input.original,
    actor: { via: "staff_on_behalf", userId: s.actor.userId, onBehalfOf: input.onBehalfOf, proof: input.proof ? { channel: String(input.proof.channel ?? "").slice(0, 40), sender: String(input.proof.sender ?? "").slice(0, 200), receivedAt: String(input.proof.receivedAt ?? "").slice(0, 40), reference: input.proof.reference ? String(input.proof.reference).slice(0, 200) : null } : null },
    file: { storageUrl: stored.storageUrl, storagePath: stored.path, fileName: stored.name, sha256: stored.sha256 },
    note: input.note ?? null,
  })
  return plainResult(out, "account")
}
