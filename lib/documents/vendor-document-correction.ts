/**
 * lib/documents/vendor-document-correction.ts — WAVE 153 (lane 153D). AN ISSUER FILES A CORRECTED VERSION OF ITS OWN DOCUMENT.
 *
 * Owner (verbatim, 2026-11-14): "lender/title or any vendors can correct their own documents."
 *
 * The rule is pure (lib/documents/document-versions.ts decideIssuerCorrection); this is the governed write around it, on the caller's
 * client AFTER the door's session gate (app/actions/vendor-document-corrections.ts):
 *   1. read the deal and the original on its rail (documents — the compliance rail — or transaction_documents — the portal rail), both
 *      pinned to the session's tenant and to this deal; the recorded issuer comes off the original (metadata.issuer, else who uploaded it);
 *   2. the issuer's assignment to THIS deal is read here (title: the deal's escrow names the title company; a lender / vendor: a
 *      vendor_assignments row) — never taken from the caller;
 *   3. decide; a refusal writes NOTHING;
 *   4. under withActionLedger (idempotent per original + file hash — a double submit files once): a NEW transaction_documents row
 *      (the portals list it) and a NEW documents row through THE ONE documents writer (lib/documents/upload-document.ts uploadDocument —
 *      the universal scanner reads it), carrying the version link, the issuer, the file's sha256 and the issuer's corrected fields as
 *      DATA; BEFORE the close the original is marked superseded on both rails (counted — never a silent replace, never a delete);
 *      AFTER the close nothing on the closed record moves: the version is filed as a post-closing adjustment of the original and a
 *      governed adjustment task is opened;
 *   5. before the close the closing check re-runs at once (runClosingCompliance, trigger document_corrected) — the replaced version no
 *      longer counts and the settlement comparison reads the new one once it is scanned (the scanner's hook re-runs it again); a passed
 *      final closing approval is REOPENED by the change itself (its readiness fingerprint no longer matches — closing-compliance.ts closingReviewGate);
 *   6. the deal's agent, TC and compliance are told; an off-platform handoff (a vendor emailed the file) also opens a follow-up task for
 *      the agent to confirm it with the issuer.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { DOCUMENT_VERSION_KEYS as K, isSupersededDocument } from "@/lib/compliance/required-documents"
import { decideIssuerCorrection, recordedIssuerOf, type DocumentIssuer, type IssuerCorrectionRefusal, type OffPlatformProof } from "./document-versions"

type Svc = SupabaseClient<any, any, any>

/** The portal rail's document types, read as the compliance rail's classifications. */
const RAIL_DOC_TYPE_CLASS: Readonly<Record<string, string>> = {
  title_commitment: "title_report", settlement_statement: "preliminary_closing_statement", preliminary_closing_disclosure: "preliminary_closing_statement",
  final_closing_disclosure: "closing_disclosure", closing_disclosure: "closing_disclosure", wire_instructions: "wire_instructions",
  appraisal_report: "appraisal_report", appraisal: "appraisal_report", inspection_report: "inspection_report", inspection: "inspection_report",
  insurance_binder: "insurance_binder", title_report: "title_report", earnest_money_receipt: "earnest_money_receipt", lender_letter: "lender_letter",
}

interface IssuerCorrectionRequest {
  /** THE SESSION'S tenant (the door resolved it) — never a request body's. */
  brokerageId: string
  transactionId: string
  original: { rail: "documents" | "transaction_documents"; id: string }
  /** Who is filing: the issuer itself (its identity resolved from the session), or tenant staff filing what the issuer sent off platform. */
  actor:
    | { via: "issuer"; userId: string; identity: { kind: "title"; vendorId: string } | { kind: "lender" | "vendor"; vendorId: string } }
    | { via: "staff_on_behalf"; userId: string; onBehalfOf: { kind: "title" } | { kind: "lender" | "vendor"; vendorId: string }; proof: OffPlatformProof | null }
  /** The stored file: its object path / URL (stored by the door, privately) and the sha256 of the bytes. */
  file: { storageUrl: string; storagePath: string | null; fileName: string; sha256: string }
  correctedFields?: Record<string, string | number | null> | null
  note?: string | null
}

type IssuerCorrectionOutcome =
  | {
      ok: true
      replay: boolean
      mode: "pre_close_version" | "post_close_adjustment"
      documentId: string | null
      transactionDocumentId: string | null
      superseded: number
      recheck: { ran: boolean; openBlocking: number; reason: string | null } | null
      approvalReopened: boolean
      notified: number
      tasks: string[]
    }
  | { ok: false; code: IssuerCorrectionRefusal | "unreadable" | "not_found" | "write_failed"; message: string; detail?: string }

interface IssuerCorrectionDeps {
  /** THE ONE documents writer (default lib/documents/upload-document.ts uploadDocument); a proof injects one on its in-memory client. */
  fileDocument?: (p: { brokerageId: string; storageUrl: string; fileName?: string; documentType?: string; transactionId?: string | null; metadata?: Record<string, unknown> }) => Promise<{ success: boolean; documentId?: string; error?: string }>
  /** The closing check (default lib/transactions/closing-compliance.ts runClosingCompliance, trigger document_corrected). */
  recheck?: (svc: Svc, input: { transactionId: string; brokerageId: string; actorUserId: string }) => Promise<{ ran: boolean; openBlocking: number; reason: string | null }>
  notify?: (svc: Svc, a: { brokerageId: string; transactionId: string; agentUserIds: string[]; alsoUserIds: string[]; title: string; body: string }) => Promise<number>
}

// `message` is the person's sentence; the raw database text rides `detail` for staff logs ONLY (153D-8, wave 153 lane 153Q:
// it used to be spliced into the sentence the vendor reads). The doors present it through presentTenantError.
const UNREADABLE = (what: string, e: { message: string }) => ({ ok: false as const, code: "unreadable" as const, message: `The ${what} couldn't be read, so nothing was filed. Try again shortly.`, detail: e.message })

export async function fileIssuerCorrection(svc: Svc, req: IssuerCorrectionRequest, deps: IssuerCorrectionDeps = {}): Promise<IssuerCorrectionOutcome> {
  const B = req.brokerageId, T = req.transactionId
  if (!B || !T || !req.original?.id || !req.file?.sha256) return { ok: false, code: "not_found", message: "Choose the document and the corrected file." }

  // 1 · the deal, pinned to the session tenant
  const { data: txRow, error: txErr } = await svc.from("transactions").select("id, brokerage_id, stage, status, financing_type, agent_id, buyer_agent_id, seller_agent_id").eq("id", T).eq("brokerage_id", B).maybeSingle()
  if (txErr) return UNREADABLE("deal", txErr)
  if (!txRow) return { ok: false, code: "cross_tenant", message: "This document is not on a deal you work on, so nothing was filed." }
  const tx = txRow as { id: string; brokerage_id: string; stage: string | null; status: string | null; financing_type: string | null; agent_id: string | null; buyer_agent_id: string | null; seller_agent_id: string | null }
  const closed = tx.stage === "CLOSED" || ["closed", "funded"].includes(String(tx.status ?? "").toLowerCase())
  const { financingKindFor } = await import("@/lib/compliance/checklist-dimensions")
  const kind = financingKindFor(tx.financing_type)
  const financed = kind === "financed" ? true : kind === "cash" ? false : null

  // 1b · the original, on its rail, and its counterpart on the other rail
  type DocRow = { id: string; brokerage_id: string; transaction_id: string | null; classification: string | null; metadata: Record<string, unknown> | null }
  type RailRow = { id: string; brokerage_id: string; transaction_id: string | null; doc_type: string | null; uploaded_by: string | null; uploaded_by_type: string | null; metadata: Record<string, unknown> | null }
  let doc: DocRow | null = null
  let rail: RailRow | null = null
  if (req.original.rail === "documents") {
    const { data, error } = await svc.from("documents").select("id, brokerage_id, transaction_id, classification, metadata").eq("id", req.original.id).eq("brokerage_id", B).maybeSingle()
    if (error) return UNREADABLE("document", error)
    doc = (data as DocRow | null) ?? null
    const railId = typeof doc?.metadata?.transaction_document_id === "string" ? (doc!.metadata!.transaction_document_id as string) : null
    if (railId) {
      const { data: r, error: rErr } = await svc.from("transaction_documents").select("id, brokerage_id, transaction_id, doc_type, uploaded_by, uploaded_by_type, metadata").eq("id", railId).eq("brokerage_id", B).maybeSingle()
      if (rErr) return UNREADABLE("document", rErr)
      rail = (r as RailRow | null) ?? null
    }
  } else {
    const { data, error } = await svc.from("transaction_documents").select("id, brokerage_id, transaction_id, doc_type, uploaded_by, uploaded_by_type, metadata").eq("id", req.original.id).eq("brokerage_id", B).maybeSingle()
    if (error) return UNREADABLE("document", error)
    rail = (data as RailRow | null) ?? null
    if (rail) {
      const { data: d, error: dErr } = await svc.from("documents").select("id, brokerage_id, transaction_id, classification, metadata").eq("brokerage_id", B).eq("metadata->>transaction_document_id", rail.id).limit(1)
      if (dErr) return UNREADABLE("document", dErr)
      doc = (((d ?? []) as DocRow[])[0]) ?? null
    }
  }
  if (!doc && !rail) return { ok: false, code: "not_found", message: "That document was not found on this deal, so nothing was filed." }
  const originalTx = doc?.transaction_id ?? rail?.transaction_id ?? null
  const classification = doc?.classification ?? (rail?.doc_type ? RAIL_DOC_TYPE_CLASS[rail.doc_type] ?? null : null) ?? (rail?.doc_type ?? null)

  // the issuer recorded on the original — its metadata, else whoever uploaded it on the portal rail (a vendor's category is read)
  let recorded: DocumentIssuer | null = recordedIssuerOf(doc?.metadata) ?? recordedIssuerOf(rail?.metadata)
  if (!recorded && rail?.uploaded_by_type === "title") recorded = { kind: "title", vendorId: null, category: "title" }
  if (!recorded && rail?.uploaded_by_type === "vendor" && typeof rail.metadata?.vendor_id === "string") {
    const { data: v, error: vErr } = await svc.from("vendors").select("id, category").eq("id", rail.metadata.vendor_id as string).eq("brokerage_id", B).maybeSingle()
    if (vErr) return UNREADABLE("vendor", vErr)
    const { isLenderVendorCategory } = await import("@/lib/kernel/lender-linkage")
    const cat = ((v as { category?: string | null } | null)?.category) ?? null
    recorded = { kind: isLenderVendorCategory(cat) ? "lender" : "vendor", vendorId: rail.metadata.vendor_id as string, category: cat }
  }

  // 2 · the issuer the filing speaks for, and its assignment to THIS deal (read here, never handed in)
  let issuer: DocumentIssuer
  let assigned = false
  const target = req.actor.via === "issuer" ? req.actor.identity : req.actor.onBehalfOf
  if (req.actor.via === "issuer" && req.actor.identity.kind === "title") {
    const titleVendorId = req.actor.identity.vendorId
    // THE TITLE COMPANY ITSELF (an issuer seat): title is a VENDOR CATEGORY (CLAUDE.md §4) — its assignment is the
    // vendor rail's, the same rule as lib/kernel/portal-auth.ts requireTitleVendorActor (a title-category vendor of
    // THIS brokerage with a vendor_assignments row on THIS deal). Lane 155T3 replaced the escrow-email match that stood
    // here (the email came from title_company_users: 0 rows, no writer).
    const { data: v, error: vErr } = await svc.from("vendors").select("id, category").eq("id", titleVendorId).eq("brokerage_id", B).maybeSingle()
    if (vErr) return UNREADABLE("vendor", vErr)
    const { isTitleVendorCategory } = await import("@/lib/kernel/lender-linkage")
    const isTitle = !!v && isTitleVendorCategory((v as { category?: string | null }).category)
    issuer = { kind: "title", vendorId: isTitle ? titleVendorId : null, category: "title" }
    if (isTitle) {
      const { data, error } = await svc.from("vendor_assignments").select("id").eq("vendor_id", titleVendorId).eq("transaction_id", T).eq("brokerage_id", B).limit(1)
      if (error) return UNREADABLE("deal's title assignment", error)
      assigned = (data ?? []).length > 0
    }
  } else if (target.kind === "title") {
    // Staff filing ON BEHALF of the deal's title company: the deal must record one (its escrow row).
    issuer = { kind: "title", vendorId: null, category: "title" }
    const { data, error } = await svc.from("transaction_title_escrow").select("id").eq("transaction_id", T).eq("brokerage_id", B).limit(1)
    if (error) return UNREADABLE("deal's title assignment", error)
    assigned = (data ?? []).length > 0
  } else {
    const { data: v, error: vErr } = await svc.from("vendors").select("id, category").eq("id", target.vendorId).eq("brokerage_id", B).maybeSingle()
    if (vErr) return UNREADABLE("vendor", vErr)
    const cat = ((v as { category?: string | null } | null)?.category) ?? null
    const { isLenderVendorCategory } = await import("@/lib/kernel/lender-linkage")
    issuer = { kind: v && isLenderVendorCategory(cat) ? "lender" : "vendor", vendorId: target.vendorId, category: cat }
    if (v) {
      const { data, error } = await svc.from("vendor_assignments").select("id").eq("vendor_id", target.vendorId).eq("transaction_id", T).eq("brokerage_id", B).limit(1)
      if (error) return UNREADABLE("deal's vendor assignment", error)
      assigned = (data ?? []).length > 0
    }
  }

  // 2b · a double submit of the SAME file: the version that replaced the original was filed from these exact bytes → a replay, not a refusal
  const replacedBy = [doc?.metadata?.[K.supersededBy], rail?.metadata?.[K.supersededBy]].find((v): v is string => typeof v === "string" && !!v)
  if (replacedBy) {
    const { data: successor, error: sErr } = await svc.from("documents").select("id, metadata").eq("id", replacedBy).eq("brokerage_id", B).maybeSingle()
    if (sErr) return UNREADABLE("newer version", sErr)
    if ((successor as { metadata?: Record<string, unknown> | null } | null)?.metadata?.[K.contentSha256] === req.file.sha256) {
      return { ok: true, replay: true, mode: closed ? "post_close_adjustment" : "pre_close_version", documentId: replacedBy, transactionDocumentId: null, superseded: 0, recheck: null, approvalReopened: false, notified: 0, tasks: [] }
    }
  }

  // 3 · decide (pure)
  const verdict = decideIssuerCorrection({
    actor: req.actor.via === "issuer"
      ? { via: "issuer", issuer, brokerageId: B, assigned }
      : { via: "staff_on_behalf", issuer, brokerageId: B, assigned, proof: req.actor.proof },
    original: { brokerageId: doc?.brokerage_id ?? rail!.brokerage_id, transactionId: originalTx, classification, recordedIssuer: recorded, superseded: isSupersededDocument(doc?.metadata) || isSupersededDocument(rail?.metadata) },
    transaction: { id: tx.id, brokerageId: tx.brokerage_id, closed, financed },
  })
  if (!verdict.ok) return verdict

  // 4 · the governed write
  const priorVersion = Number(doc?.metadata?.[K.versionNo] ?? rail?.metadata?.[K.versionNo] ?? 1)
  const versionNo = Number.isFinite(priorVersion) ? priorVersion + 1 : 2
  const now = new Date().toISOString()
  const issuerMeta = { kind: issuer.kind, vendorId: issuer.vendorId, category: issuer.category }
  const proof = req.actor.via === "staff_on_behalf" ? req.actor.proof : null
  const link = verdict.mode === "pre_close_version"
    ? { [K.supersedes]: doc?.id ?? null, supersedes_transaction_document_id: rail?.id ?? null }
    : { [K.postCloseAdjustmentOf]: doc?.id ?? rail?.id ?? null }
  const corrected = req.correctedFields && typeof req.correctedFields === "object" ? Object.fromEntries(Object.entries(req.correctedFields).slice(0, 30).map(([k, v]) => [String(k).slice(0, 60), typeof v === "number" ? v : v === null ? null : String(v).slice(0, 200)])) : null
  const meta = {
    ...link, [K.versionNo]: versionNo, [K.issuer]: issuerMeta, [K.contentSha256]: req.file.sha256, storage_path: req.file.storagePath,
    corrected_fields: corrected, correction_note: (req.note ?? "").slice(0, 1000) || null, filed_by_user_id: req.actor.userId, filed_via: req.actor.via,
    ...(proof ? { off_platform_proof: { channel: proof.channel, sender: proof.sender, received_at: proof.receivedAt, reference: proof.reference ?? null } } : {}),
  }

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  type Written = { documentId: string | null; transactionDocumentId: string | null; superseded: number; replay: boolean; error?: string }
  // The ledger settles a thrown write `failed` (a retry re-claims it) and rethrows; the throw is turned into the refusal here.
  const written = await withActionLedger<Written>(
    {
      brokerageId: B,
      action: "documents.issuer_correction.file",
      actor: { type: "user", userId: req.actor.userId },
      subject: { type: "transaction", id: T, ref: req.original.id },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: `${issuer.kind} correction of ${classification ?? "a document"} (${verdict.mode})${proof ? ` filed for the issuer from ${proof.channel}` : ""}`.slice(0, 500),
      riskClass: "LOW_RISK_WRITE",
      systemSource: "issuer_document_correction",
      idempotencyKey: `issuer-correction:${B}:${T}:${req.original.id}:${req.file.sha256}`,
      detail: { original: req.original, classification, mode: verdict.mode, version_no: versionNo, sha256: req.file.sha256, via: req.actor.via, issuer: issuerMeta },
    },
    async (): Promise<Written> => {
      const railType = rail?.doc_type ?? classification ?? "corrected_document"
      const { data: ins, error: insErr } = await svc.from("transaction_documents").insert({
        transaction_id: T, brokerage_id: B, doc_type: railType, doc_label: req.file.fileName.slice(0, 200), status: "uploaded", storage_url: req.file.storageUrl,
        uploaded_by: req.actor.userId, uploaded_by_type: req.actor.via === "issuer" ? (issuer.kind === "title" ? "title" : "vendor") : "staff",
        uploaded_at: now, metadata: { ...meta, ...(issuer.vendorId ? { vendor_id: issuer.vendorId } : {}) },
      }).select("id")
      if (insErr || !ins || ins.length !== 1) throw new Error(`the corrected version was not filed: ${insErr?.message ?? "no row"}`)
      const railId = (ins[0] as { id: string }).id
      const fileDoc = deps.fileDocument ?? (async (p) => (await import("./upload-document")).uploadDocument(p))
      const filed = await fileDoc({ brokerageId: B, storageUrl: req.file.storageUrl, fileName: req.file.fileName, documentType: classification ?? railType, transactionId: T, metadata: { ...meta, transaction_document_id: railId, upload_source: "issuer_correction" } })
      if (!filed.success || !filed.documentId) {
        // nothing half-filed: the portal row this call just wrote is taken back (counted — a delete that matched nothing also resolves)
        const { data: undone, error: undoErr } = await svc.from("transaction_documents").delete().eq("id", railId).eq("brokerage_id", B).select("id")
        const leftover = undoErr || !undone || undone.length !== 1 ? ` — and the portal row ${railId} could not be taken back (${undoErr?.message ?? "no row matched"}); it is listed without a compliance copy` : ""
        throw new Error(`the corrected version was not filed: ${filed.error ?? "no document row"}${leftover}`)
      }
      let superseded = 0
      if (verdict.mode === "pre_close_version") {
        const stamp = { [K.supersededBy]: filed.documentId, superseded_by_transaction_document_id: railId, [K.supersededAt]: now }
        for (const [table, row] of [["documents", doc], ["transaction_documents", rail]] as const) {
          if (!row) continue
          const { data: upd, error: uErr } = await svc.from(table).update({ metadata: { ...(row.metadata ?? {}), ...stamp } }).eq("id", row.id).eq("brokerage_id", B).select("id")
          // An UPDATE that matches nothing also resolves (CLAUDE.md §3): the original vanished or the tenant predicate refused.
          if (uErr || !upd || upd.length !== 1) throw new Error(`the replaced version could not be marked: ${uErr?.message ?? "no row matched"}`)
          superseded++
        }
      }
      return { documentId: filed.documentId, transactionDocumentId: railId, superseded, replay: false }
    },
    {
      settle: (r) => (r.documentId ? { status: "executed", outcome: `${verdict.mode}:v${versionNo}` } : { status: "failed", outcome: "not_filed", error: r.error ?? "not filed" }),
      replay: (claim) => (claim.kind === "refused" ? { documentId: null, transactionDocumentId: null, superseded: 0, replay: false, error: `the action ledger refused the filing: ${claim.error}` } : { documentId: null, transactionDocumentId: null, superseded: 0, replay: true }),
    },
    { client: svc as never },
  ).catch((e: unknown): Written => ({ documentId: null, transactionDocumentId: null, superseded: 0, replay: false, error: e instanceof Error ? e.message : String(e) }))
  if (written.error) return { ok: false, code: "write_failed", message: "The corrected version was not filed. Nothing changed — try again.", detail: written.error }
  if (written.replay) return { ok: true, replay: true, mode: verdict.mode, documentId: null, transactionDocumentId: null, superseded: 0, recheck: null, approvalReopened: false, notified: 0, tasks: [] }

  // 5 · re-run the comparisons (before close) and learn whether a passed approval stood on the replaced version
  let recheck: { ran: boolean; openBlocking: number; reason: string | null } | null = null
  let approvalReopened = false
  if (verdict.mode === "pre_close_version") {
    const { CLOSING_REVIEW_TARGET } = await import("@/lib/transactions/closing-compliance")
    const { data: rv } = await svc.from("policy_decisions").select("decision").eq("brokerage_id", B).eq("transaction_id", T).eq("target_type", CLOSING_REVIEW_TARGET).order("created_at", { ascending: false }).limit(1)
    approvalReopened = (((rv ?? []) as Array<{ decision: string }>)[0])?.decision === "green"
    try {
      recheck = await (deps.recheck ?? defaultRecheck)(svc, { transactionId: T, brokerageId: B, actorUserId: req.actor.userId })
    } catch (e) {
      recheck = { ran: false, openBlocking: 0, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  // 6 · tell the deal team; open the follow-up (off platform) or the adjustment (after close)
  const agentIds = [...new Set([tx.agent_id, tx.buyer_agent_id, tx.seller_agent_id].filter((x): x is string => !!x))]
  const agentUserIds: string[] = []
  if (agentIds.length) {
    const { data: ag } = await svc.from("agents").select("user_id").eq("brokerage_id", B).in("id", agentIds)
    for (const r of (ag ?? []) as Array<{ user_id: string | null }>) if (r.user_id) agentUserIds.push(r.user_id)
  }
  const { data: co } = await svc.from("users").select("id").eq("brokerage_id", B).eq("user_type", "compliance_officer").limit(10)
  const complianceUserIds = ((co ?? []) as Array<{ id: string }>).map((u) => u.id)
  const { documentClassificationLabel } = await import("@/lib/compliance/document-classifications")
  const label = documentClassificationLabel(classification)
  const who = issuer.kind === "title" ? "The title company" : issuer.kind === "lender" ? "The lender" : "A vendor on the deal"
  const title = verdict.mode === "pre_close_version" ? `${label}: a corrected version was filed` : `${label}: a correction arrived after closing`
  const body = verdict.mode === "pre_close_version"
    ? `${who} filed version ${versionNo} of its ${label.toLowerCase()}${proof ? ` (sent ${proof.channel === "email" ? "by email" : `by ${proof.channel}`} from ${proof.sender}, filed by your team)` : ""}. The earlier version is kept as history and no longer counts. The closing checks re-ran${recheck && recheck.ran ? ` — ${recheck.openBlocking} item(s) still hold the closing` : ""}.${approvalReopened ? " The final closing approval was reopened — compliance re-reviews before closing." : ""}`
    : `${who} sent a corrected ${label.toLowerCase()} after the deal closed. The closed record was not changed; a post-closing adjustment task was opened for review.`
  const notified = await (deps.notify ?? defaultNotify)(svc, { brokerageId: B, transactionId: T, agentUserIds, alsoUserIds: complianceUserIds, title, body })

  const tasks: string[] = []
  const task = async (category: string, taskTitle: string, description: string, assignee: string | null, priority: "high" | "medium") => {
    const { data, error } = await svc.from("transaction_tasks").insert({ transaction_id: T, brokerage_id: B, title: taskTitle.slice(0, 180), description: description.slice(0, 2000), category, priority, status: "pending", ai_generated: false, assigned_user_id: assignee }).select("id")
    if (error || !data || data.length !== 1) console.error(`[issuer-correction] the ${category} task was not opened: ${error?.message ?? "no row"}`)
    else tasks.push(category)
  }
  if (proof) {
    await task("vendor_document_followup", `[Vendor document] Confirm the corrected ${label.toLowerCase()} with its issuer`,
      `Your team filed a corrected ${label.toLowerCase()} for the issuer from ${proof.channel} (${proof.sender}, received ${proof.receivedAt}${proof.reference ? `, reference ${proof.reference}` : ""}). Confirm with the issuer that this is their final version.`, agentUserIds[0] ?? null, "medium")
  }
  if (verdict.mode === "post_close_adjustment") {
    await task("closing_adjustment", `[Post-closing adjustment] ${label} corrected after closing`,
      `${who} sent a corrected ${label.toLowerCase()} after the deal closed (document ${written.documentId}). The closed transaction and its paid records were not changed. Review whether a post-closing adjustment is needed and record it through the finance adjustment process.`, complianceUserIds[0] ?? agentUserIds[0] ?? null, "high")
  }
  return { ok: true, replay: false, mode: verdict.mode, documentId: written.documentId, transactionDocumentId: written.transactionDocumentId, superseded: written.superseded, recheck, approvalReopened, notified, tasks }
}

const defaultRecheck: NonNullable<IssuerCorrectionDeps["recheck"]> = async (svc, input) => {
  const { runClosingCompliance } = await import("@/lib/transactions/closing-compliance")
  const r = await runClosingCompliance(svc, { transactionId: input.transactionId, brokerageId: input.brokerageId, trigger: "document_corrected", actorUserId: input.actorUserId })
  return { ran: r.ran, openBlocking: r.openBlocking, reason: r.reason }
}

const defaultNotify: NonNullable<IssuerCorrectionDeps["notify"]> = async (svc, a) => {
  try {
    const { notifyComplianceFlag } = await import("@/lib/notifications/notify-helpers")
    const r = await notifyComplianceFlag(svc as never, {
      brokerageId: a.brokerageId, agentUserId: a.agentUserIds[0] ?? null, alsoNotifyUserIds: [...a.agentUserIds.slice(1), ...a.alsoUserIds], transactionId: a.transactionId,
      flag: { type: "compliance.document_corrected", severity: "high", title: a.title, body: a.body, entityType: "transaction", entityId: a.transactionId },
    })
    return r.notified_count
  } catch (e) {
    console.error("[issuer-correction] the deal team was not told (the filing stands):", e instanceof Error ? e.message : String(e))
    return 0
  }
}
