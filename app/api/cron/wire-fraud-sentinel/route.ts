import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runWireFraudSentinel } from "@/lib/wire-fraud/wire-fraud-runner"
import type { WireFraudInput } from "@/lib/wire-fraud/wire-fraud-sentinel"

/**
 * WIRE-FRAUD SENTINEL sweep — every 15 minutes
 * (lib/kernel/cron-dispatch.ts, "4,19,34,49 * * * *").
 *
 * WHY (wave 26). lib/wire-fraud/wire-fraud-runner.ts:26 runWireFraudSentinel —
 * the detector for the single most catastrophic scam in this industry — had NO
 * caller anywhere in the tree. Its only reference was its own proof
 * (scripts/wire-fraud-simulator.ts). The sentinel has never run. This is the
 * trigger.
 *
 * FREQUENT BY RULING: a spoofed wire is a same-day, irreversible loss, so this
 * ticks four times an hour rather than daily. Re-scanning is nearly free —
 * detectWireFraudRisk is pure — which is why the lookback is a generous 7 days
 * instead of a cadence-width window that could miss a row on a skipped tick.
 *
 * WHAT IT SCANS — the two places a wire instruction actually lands:
 *   · transaction_documents where doc_type = 'wire_instructions' — written by
 *     app/actions/title-portal.ts:304-320 (the title portal's upload).
 *   · documents where classification = 'wire_instructions' — a live CHECK value
 *     (scripts/check-vocabularies.ts), extracted by
 *     lib/documents/scan-uploaded-document.ts:115 into
 *     { receiving_institution, account_number_last_4, beneficiary_name }, and
 *     carrying metadata.from_email / metadata.subject when it arrived by email
 *     (app/api/webhooks/inbound-mail/route.ts:364-372).
 *
 * PRIOR-vs-NEW is the point. The #1 fraud signature is a LAST-MINUTE CHANGE of
 * bank details, so for every row we look up the PREVIOUS wire-instructions
 * document on the same transaction and hand both to the detector. Without that
 * pairing the `account_changed` critical flag is unreachable.
 *
 * IDEMPOTENCY IS EXPLICIT, NOT emitKernelEvent's WINDOW. That window is clamped
 * to one hour (lib/kernel/emit.ts) and defaults to 60s, so on a 15-minute
 * cadence with a 7-day lookback it would let the same document re-alert forever.
 * Instead we query lifecycle_events for this document's marker row with NO time
 * bound before escalating, and write that marker through emitKernelEvent after.
 *
 * BLIND SPOT, published beside the number (CLAUDE.md §2): this OS stores no
 * inbound EMAIL BODY — `messages` is SMS/DM-shaped and `communications` holds
 * Zoom transcripts — so the urgency/pressure flag is evaluated over the
 * document's subject + label + summary + notes only, never a full email body.
 * `routing` is likewise never available (the extraction schema carries
 * account_number_last_4 and no routing number), so a routing-only change cannot
 * be seen. Both are reported in the payload as `text_sources` / `routing_seen`.
 *
 * Tenant: the service client reads across tenants ON PURPOSE — this is a
 * platform cron gated by the cron secret, and every escalation is written back
 * under the row's own brokerage_id (CLAUDE.md §4 — the tenant is never taken
 * from a request).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

const LOOKBACK_DAYS = 7
const BATCH = 200

type Svc = ReturnType<typeof createServiceClient>

interface Candidate {
  key: string
  source: "transaction_documents" | "documents"
  documentId: string
  transactionId: string | null
  createdAt: string
  senderEmail: string | null
  account: string | null
  text: string[]
}

/** The @-domain of an email address, lowercased. Null for anything unparseable. */
function domainOf(email: string | null | undefined): string | null {
  const d = String(email ?? "").split("@")[1]?.trim().toLowerCase()
  return d || null
}

/** Pull the account identifier out of whatever extraction blob the row carries. */
function accountFrom(blob: unknown): string | null {
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return null
  const b = blob as Record<string, unknown>
  const v = b.account_number_last_4 ?? b.account_number ?? b.account ?? null
  return typeof v === "string" || typeof v === "number" ? String(v) : null
}

/** Free-text fields on a row that a pressure-language scan can honestly read. */
function textFrom(...parts: unknown[]): string[] {
  return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
}

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "wire-fraud-sentinel",
    cron_path: "/app/api/cron/wire-fraud-sentinel/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[WireFraudSentinel] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase: Svc = createServiceClient()
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()

    // ── 1. The title-portal upload lane ──────────────────────────────────────
    const { data: txDocs, error: txDocsError } = await supabase
      .from("transaction_documents")
      .select("id, transaction_id, brokerage_id, doc_label, notes, metadata, extracted_data, uploaded_by, uploaded_by_type, created_at")
      .eq("doc_type", "wire_instructions")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(BATCH)
    if (txDocsError) throw new Error(`transaction_documents read refused: ${txDocsError.message}`)

    // ── 2. The classified-document lane (includes emailed-in attachments) ────
    const { data: docs, error: docsError } = await supabase
      .from("documents")
      .select("id, transaction_id, brokerage_id, contact_id, summary, metadata, extracted_fields, created_at")
      .eq("classification", "wire_instructions")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(BATCH)
    if (docsError) throw new Error(`documents read refused: ${docsError.message}`)

    const candidates: Candidate[] = []

    for (const d of (txDocs ?? []) as Record<string, any>[]) {
      const meta = (d.metadata ?? {}) as Record<string, unknown>
      candidates.push({
        key: `td:${d.id}`,
        source: "transaction_documents",
        documentId: d.id,
        transactionId: d.transaction_id ?? null,
        createdAt: d.created_at,
        // The title portal records the uploader, not a from-address; resolved below.
        senderEmail: typeof meta.from_email === "string" ? meta.from_email : null,
        account: accountFrom(d.extracted_data),
        text: textFrom(meta.subject, d.doc_label, d.notes, meta.warning),
      })
    }
    for (const d of (docs ?? []) as Record<string, any>[]) {
      const meta = (d.metadata ?? {}) as Record<string, unknown>
      candidates.push({
        key: `doc:${d.id}`,
        source: "documents",
        documentId: d.id,
        transactionId: d.transaction_id ?? null,
        createdAt: d.created_at,
        senderEmail: typeof meta.from_email === "string" ? meta.from_email : null,
        account: accountFrom(d.extracted_fields),
        text: textFrom(meta.subject, d.summary),
      })
    }
    candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    let scanned = 0
    let escalated = 0
    let clean = 0
    let alreadyEscalated = 0
    let skippedNoTransaction = 0
    let refused = 0
    const refusals: Array<{ key: string; error: string }> = []
    const verdicts: Record<string, number> = { block: 0, warn: 0, ok: 0 }

    // Per-transaction caches — a closing usually carries several of these rows.
    const expectedCache = new Map<string, string[]>()
    const priorCache = new Map<string, string | null>()

    for (const c of candidates) {
      scanned += 1
      if (!c.transactionId) {
        // No transaction → no title/escrow on file → no expected domains and no
        // prior instructions. Scoring it would be a verdict with no evidence.
        skippedNoTransaction += 1
        continue
      }

      const { data: txn, error: txnError } = await supabase
        .from("transactions")
        .select("id, brokerage_id, agent_id, buyer_contact_id, contact_id, close_date")
        .eq("id", c.transactionId)
        .maybeSingle()
      if (txnError) {
        refused += 1
        if (refusals.length < 20) refusals.push({ key: c.key, error: `transaction read: ${txnError.message}` })
        continue
      }
      if (!txn?.brokerage_id) continue

      const brokerageId = txn.brokerage_id as string
      const contactId = (txn.buyer_contact_id ?? txn.contact_id ?? null) as string | null
      if (!contactId) {
        // runWireFraudSentinel keys its notification and its bus signal on the
        // buyer contact. Without one there is nobody to warn.
        skippedNoTransaction += 1
        continue
      }

      // ── expectedDomains: the title/escrow on file for THIS deal ────────────
      let expectedDomains = expectedCache.get(c.transactionId)
      if (!expectedDomains) {
        const domains = new Set<string>()
        const { data: te, error: teError } = await supabase
          .from("transaction_title_escrow")
          .select("title_company_email, title_officer_email, escrow_officer_email")
          .eq("transaction_id", c.transactionId)
          .maybeSingle()
        if (teError) {
          refused += 1
          if (refusals.length < 20) refusals.push({ key: c.key, error: `title_escrow read: ${teError.message}` })
        } else if (te) {
          for (const e of [te.title_company_email, te.title_officer_email, te.escrow_officer_email]) {
            const d = domainOf(e as string | null)
            if (d) domains.add(d)
          }
        }
        const { data: parts, error: partsError } = await supabase
          .from("transaction_participants")
          .select("email, role")
          .eq("transaction_id", c.transactionId)
          .limit(50)
        if (partsError) {
          refused += 1
          if (refusals.length < 20) refusals.push({ key: c.key, error: `participants read: ${partsError.message}` })
        } else {
          for (const p of (parts ?? []) as Array<{ email: string | null; role: string | null }>) {
            if (!/title|escrow|settlement|closing|lender/i.test(String(p.role ?? ""))) continue
            const d = domainOf(p.email)
            if (d) domains.add(d)
          }
        }
        expectedDomains = [...domains]
        expectedCache.set(c.transactionId, expectedDomains)
      }

      // ── priorInstructions: the PREVIOUS wire doc on this transaction ───────
      if (!priorCache.has(c.transactionId)) {
        const { data: priorRows, error: priorError } = await supabase
          .from("transaction_documents")
          .select("id, extracted_data, created_at")
          .eq("transaction_id", c.transactionId)
          .eq("doc_type", "wire_instructions")
          .order("created_at", { ascending: true })
          .limit(20)
        if (priorError) {
          refused += 1
          if (refusals.length < 20) refusals.push({ key: c.key, error: `prior wire read: ${priorError.message}` })
          priorCache.set(c.transactionId, null)
        } else {
          // The EARLIEST account on file is the baseline the buyer was told to
          // wire to; anything different arriving later is the change to flag.
          const first = ((priorRows ?? []) as Record<string, any>[])
            .map((r) => ({ id: r.id as string, account: accountFrom(r.extracted_data) }))
            .find((r) => r.account !== null && r.id !== c.documentId)
          priorCache.set(c.transactionId, first?.account ?? null)
        }
      }
      const priorAccount = priorCache.get(c.transactionId) ?? null

      // ── senderEmail: the from-address, else the uploader's account email ───
      let senderEmail = c.senderEmail
      if (!senderEmail && c.source === "transaction_documents") {
        const uploadedBy = (txDocs ?? []).find((d: any) => d.id === c.documentId)?.uploaded_by
        if (uploadedBy) {
          const { data: uploader, error: uploaderError } = await supabase
            .from("users").select("email").eq("id", uploadedBy).maybeSingle()
          if (uploaderError) {
            refused += 1
            if (refusals.length < 20) refusals.push({ key: c.key, error: `uploader read: ${uploaderError.message}` })
          } else {
            senderEmail = (uploader?.email as string | null) ?? null
          }
        }
      }

      // ── daysToClose ───────────────────────────────────────────────────────
      let daysToClose: number | null = null
      if (txn.close_date) {
        const t = new Date(txn.close_date as string).getTime()
        if (Number.isFinite(t)) daysToClose = Math.floor((t - Date.now()) / 86_400_000)
      }

      const wire: WireFraudInput = {
        senderEmail,
        expectedDomains,
        priorInstructions: priorAccount ? { account: priorAccount, routing: null } : null,
        newInstructions: c.account ? { account: c.account, routing: null } : null,
        messageText: c.text.join(" — ") || null,
        daysToClose,
      }

      // ── IDEMPOTENCY: has this document already been escalated? ─────────────
      // No time bound on purpose (see the header) — one escalation per document,
      // ever, no matter how many times the lookback re-reads it.
      const dedupeKey = `wire_fraud:${c.documentId}`
      const { data: priorMarker, error: markerError } = await supabase
        .from("lifecycle_events")
        .select("id")
        .eq("event_type", KernelEvent.WIRE_FRAUD_RISK_DETECTED)
        .eq("dedupe_key", dedupeKey)
        .limit(1)
      if (markerError) {
        // FAIL CLOSED on the dedupe read: an unreadable marker table must not be
        // read as "never escalated" and re-alert the agent on every tick.
        refused += 1
        if (refusals.length < 20) refusals.push({ key: c.key, error: `dedupe read: ${markerError.message}` })
        continue
      }
      if (priorMarker && priorMarker.length > 0) {
        alreadyEscalated += 1
        continue
      }

      const { verdict, escalated: didEscalate, notificationId } = await runWireFraudSentinel({
        brokerageId,
        contactId,
        // §3 — agents.id and users.id are DISJOINT. transactions.agent_id is an
        // agents.id; notifications.user_id needs a users.id. Cross via
        // agents.user_id, and pass null rather than substituting the id we hold.
        agentUserId: await resolveAgentUserId(supabase, txn.agent_id as string | null),
        wire,
      }, supabase)

      verdicts[verdict.riskLevel] = (verdicts[verdict.riskLevel] ?? 0) + 1
      if (verdict.riskLevel === "ok") {
        clean += 1
        continue
      }

      const emitResult = await emitKernelEvent({
        event: KernelEvent.WIRE_FRAUD_RISK_DETECTED,
        brokerageId,
        entityType: c.source === "documents" ? "document" : "transaction_document",
        entityId: c.documentId,
        contactId,
        transactionId: c.transactionId,
        source: "cron",
        dedupeKey,
        metadata: {
          risk_level: verdict.riskLevel,
          flags: verdict.flags,
          protective_action: verdict.protectiveAction,
          escalated: didEscalate,
          notification_id: notificationId ?? null,
          expected_domains: expectedDomains,
          account_changed: !!(priorAccount && c.account && priorAccount !== c.account),
          days_to_close: daysToClose,
          source_table: c.source,
          text_sources: c.text.length,
          routing_seen: false,
        },
      })
      if (emitResult.error) {
        refused += 1
        if (refusals.length < 20) refusals.push({ key: c.key, error: `emit: ${emitResult.error}` })
        continue
      }
      escalated += 1
    }

    const payload = {
      scanned,
      batch_cap: BATCH * 2,
      capped: (txDocs?.length ?? 0) >= BATCH || (docs?.length ?? 0) >= BATCH,
      lookback_days: LOOKBACK_DAYS,
      escalated,
      clean,
      already_escalated: alreadyEscalated,
      skipped_no_transaction_or_contact: skippedNoTransaction,
      verdicts,
      refused,
      refusals,
      // Blind spots, published beside the number (CLAUDE.md §2).
      blind_spots: [
        "no inbound email BODY is stored anywhere in this OS, so urgency/pressure language is read from the document subject/label/summary/notes only",
        "the wire-instructions extraction carries account_number_last_4 and no routing number, so a routing-only change cannot be detected",
      ],
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: scanned,
      output_count: escalated,
      metadata: payload,
    })
    return NextResponse.json({ success: true, ...payload })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[WireFraudSentinel] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

/** agents.id → users.id (CLAUDE.md §3: the two id spaces are disjoint). */
async function resolveAgentUserId(supabase: Svc, agentId: string | null): Promise<string | null> {
  if (!agentId) return null
  const { data, error } = await supabase
    .from("agents").select("user_id").eq("id", agentId).maybeSingle()
  if (error) {
    console.error("[WireFraudSentinel] agent user_id read refused:", error.message)
    return null
  }
  return (data?.user_id as string | null) ?? null
}
