/**
 * lib/vendors/w9.ts — VENDOR W-9 ON FILE (owner round 43).
 *
 * Vendors invoice buyers/sellers and receive payouts (rounds 34/37), so the
 * tenant is a PAYER with 1099 reporting obligations — which needs a W-9 on
 * file (TIN + certification). Round 42's audit found no tax-doc capture
 * anywhere (vendors.compliance_credentials holds verification creds only).
 *
 * CAPTURE SHAPE (migration m275, vendor_tax_documents):
 *   • The CERTIFIED record is the signed W-9 PDF, uploaded through the
 *     EXISTING client-documents rail (bucket 'client-documents' +
 *     client_documents row) — never a new storage path.
 *   • Structured basics alongside: legal_name (line 1), business_type (the
 *     W-9 line-3 classification enum), TIN TYPE only (EIN vs SSN — the TIN
 *     itself is NEVER stored in any column; it lives only inside the PDF,
 *     which sits in the non-public tenant-scoped bucket), signature_date.
 *   • status: 'missing' | 'on_file' | 'expired'. A W-9 doesn't age out on a
 *     clock — it expires when the vendor's legal identity changes after
 *     filing. We snapshot vendors.name at filing and DERIVE 'expired' at
 *     read time (deriveW9Status), so the stored status can never go stale.
 *
 * SOFT GATE (deliberate verdict): payouts and invoice issuance are NEVER
 * hard-blocked on a missing W-9 — a hard block would strand every existing
 * vendor mid-flight (open invoices, earned payouts). Instead both lanes
 * surface an honest 'W-9 not on file' warning to both sides and the
 * brokerage console shows who to chase.
 *
 * THE CHASE: maybeSendVendorW9Reminder — the governed b2b transactional
 * dispatchEmail (the round-34 vendor invoice-notification idiom: vendor
 * comms are AUTO transactional sends, not proposals) — deduped to ONCE per
 * W9_REMINDER_PERIOD_DAYS via a claim-then-send update on
 * reminder_last_sent_at, so concurrent lanes can never double-send.
 *
 * LAYOUT: the PURE half (vocabulary, types, deriveW9Status,
 * w9SoftGateWarning, shouldSendW9Reminder) lives in ./w9-vocab so "use
 * client" surfaces can import it without dragging the dispatch rail into
 * the client bundle; this module re-exports it and adds the IO layer
 * (client passed in; dispatch imported dynamically).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  deriveW9Status,
  shouldSendW9Reminder,
  W9_REMINDER_PERIOD_DAYS,
  type VendorW9Read,
  type VendorW9Record,
  type W9BusinessType,
  type W9Status,
  type W9TinType,
} from "./w9-vocab"

export * from "./w9-vocab"

type Svc = SupabaseClient<any, any, any>

// ─── IO — reads (fail-soft pre-migration: absent table reads as 'missing') ───

function rowToRecord(row: any): VendorW9Record {
  return {
    status: (row?.status as W9Status) ?? "missing",
    legalName: row?.legal_name ?? null,
    businessType: (row?.business_type as W9BusinessType) ?? null,
    tinType: (row?.tin_type as W9TinType) ?? null,
    signatureDate: row?.signature_date ?? null,
    documentUrl: row?.document_url ?? null,
    clientDocumentId: row?.client_document_id ?? null,
    vendorNameAtFiling: row?.vendor_name_at_filing ?? null,
    reminderLastSentAt: row?.reminder_last_sent_at ?? null,
  }
}

/** Read one vendor's W-9 posture with the derived (never-stale) status. */
export async function readVendorW9(svc: Svc, vendorId: string): Promise<VendorW9Read> {
  const [{ data: vendor }, taxDoc] = await Promise.all([
    svc.from("vendors").select("name").eq("id", vendorId).maybeSingle(),
    svc.from("vendor_tax_documents").select("*").eq("vendor_id", vendorId).maybeSingle(),
  ])
  // Pre-migration (42P01 undefined table) or no row → honest 'missing'.
  const row = taxDoc?.error ? null : taxDoc?.data ?? null
  const record = row ? rowToRecord(row) : null
  return {
    record,
    status: deriveW9Status(record, vendor?.name ?? null),
    vendorName: vendor?.name ?? null,
  }
}

/**
 * Brokerage console read: vendor_id → derived W9Status for every vendor in
 * the tenant. Pre-migration the map is simply empty (callers render vendors
 * with a 'missing' default — honest, nothing fabricated).
 */
export async function readW9StatusMap(svc: Svc, brokerageId: string): Promise<Map<string, W9Status>> {
  const map = new Map<string, W9Status>()
  const { data, error } = await svc
    .from("vendor_tax_documents")
    .select("vendor_id, status, vendor_name_at_filing, vendors!inner(name)")
    .eq("brokerage_id", brokerageId)
  if (error || !data) return map
  for (const row of data as any[]) {
    map.set(
      row.vendor_id as string,
      deriveW9Status(
        { status: row.status, vendorNameAtFiling: row.vendor_name_at_filing },
        row.vendors?.name ?? null,
      ),
    )
  }
  return map
}

// ─── IO — the governed chase (claim-then-send, once per period) ──────────────

export interface W9ReminderResult {
  sent: boolean
  reason: "sent" | "on_file" | "deduped" | "no_email" | "claim_lost" | "send_failed" | "unavailable"
}

/**
 * Governed W-9 reminder — the round-34 vendor-notification idiom: a b2b
 * TRANSACTIONAL dispatchEmail straight to the vendor's email (vendor comms
 * are auto transactional sends in this codebase — issueVendorCharge,
 * createAndSendVendorClientInvoice — not proposals).
 *
 * Dedupe is CLAIM-THEN-SEND: the reminder_last_sent_at stamp is written
 * first with a conditional update (only when null or older than the
 * period), so two concurrent lanes can never double-send. If the send then
 * fails, the stamp stays — worst case the vendor is nudged again next
 * period, never spammed within one.
 *
 * Best-effort by contract: callers wrap in try/catch; a failure never
 * blocks the payout/invoice lane that triggered it.
 */
export async function maybeSendVendorW9Reminder(
  svc: Svc,
  args: {
    vendorId: string
    brokerageId: string
    /** The acting user for the dispatch ledger (lane caller). */
    userId?: string | null
    /** What surfaced the gap — 'payout' | 'invoice' (email copy context). */
    trigger: "payout" | "invoice"
    now?: Date
  },
): Promise<W9ReminderResult> {
  const now = args.now ?? new Date()
  const read = await readVendorW9(svc, args.vendorId)
  if (read.status === "on_file") return { sent: false, reason: "on_file" }

  // Ensure the dedupe anchor row exists (status 'missing' — honest default).
  if (!read.record) {
    const { error: insErr } = await svc.from("vendor_tax_documents").insert({
      vendor_id: args.vendorId,
      brokerage_id: args.brokerageId,
      status: "missing",
    })
    // Pre-migration (table absent) → the chase is unavailable, never fatal.
    if (insErr && !/duplicate key/i.test(insErr.message ?? "")) {
      return { sent: false, reason: "unavailable" }
    }
  }

  if (!shouldSendW9Reminder({
    status: read.status,
    reminderLastSentAt: read.record?.reminderLastSentAt ?? null,
    now,
  })) {
    return { sent: false, reason: "deduped" }
  }

  const { data: vendor } = await svc
    .from("vendors").select("name, email").eq("id", args.vendorId).maybeSingle()
  if (!vendor?.email) return { sent: false, reason: "no_email" }

  // CLAIM: stamp the period before sending — conditional on the anchor still
  // being claimable, so a concurrent caller loses the race instead of
  // double-sending.
  const cutoffIso = new Date(now.getTime() - W9_REMINDER_PERIOD_DAYS * 86_400_000).toISOString()
  const { data: claimed } = await svc
    .from("vendor_tax_documents")
    .update({ reminder_last_sent_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("vendor_id", args.vendorId)
    .eq("brokerage_id", args.brokerageId)
    .or(`reminder_last_sent_at.is.null,reminder_last_sent_at.lt.${cutoffIso}`)
    .select("id")
  if (!claimed || claimed.length === 0) return { sent: false, reason: "claim_lost" }

  try {
    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    const { DEFAULT_PRODUCT_BRAND } = await import("@/lib/platform/product-brand")
    const esc = (s: string) => s.replace(/</g, "&lt;")
    // No invented sender: an unverified from-address fails at SendGrid and
    // takes the W-9 request with it. Null → the caller sees why.
    const { resolveOutboundSender } = await import("@/lib/providers/outbound-sender")
    const resolvedSender = await resolveOutboundSender(svc as any, args.brokerageId)
    if (!resolvedSender) return { sent: false, reason: "unavailable" }
    const fromEmail = resolvedSender.email
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
    const why = args.trigger === "payout"
      ? "a payout was initiated to you"
      : "you issued an invoice"
    const expired = read.status === "expired"
    const result = await dispatchEmail({
      brokerageId: args.brokerageId,
      userId: args.userId ?? undefined,
      systemSource: "vendor_w9_reminder",
      channelPurpose: "transactional",
      from: `${DEFAULT_PRODUCT_BRAND.name} <${fromEmail}>`,
      to: vendor.email,
      subject: expired
        ? "Action needed: your W-9 on file needs an update"
        : "Action needed: put your W-9 on file",
      html: `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#f9fafb;padding:32px 0">
        <table width="560" style="margin:0 auto;background:#fff;border-radius:8px;overflow:hidden">
          <tr><td style="padding:20px;background:#1f2937;color:#fff"><h2 style="margin:0">W-9 needed for tax reporting</h2></td></tr>
          <tr><td style="padding:20px;font-size:14px">
            <p style="margin:0 0 12px">Hi ${esc(vendor.name ?? "there")},</p>
            <p style="margin:0 0 12px">Because ${why} on the platform, your brokerage partner is required to report payments to the IRS (Form 1099) — and that needs a ${expired ? "current" : "completed"} <strong>W-9</strong> on file.${expired ? " The W-9 we have no longer matches your legal name." : ""}</p>
            <p style="margin:0 0 12px">Payments are not blocked, but please upload your signed W-9 so reporting stays accurate.</p>
            <p style="margin:16px 0 0"><a href="${appUrl}/vendor/documents" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Upload your W-9</a></p>
          </td></tr>
        </table></body></html>`,
      metadata: { vendor_id: args.vendorId, w9_trigger: args.trigger, w9_status: read.status },
    })
    return result.success
      ? { sent: true, reason: "sent" }
      : { sent: false, reason: "send_failed" }
  } catch {
    return { sent: false, reason: "send_failed" }
  }
}
