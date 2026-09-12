import { createClient } from "@/lib/supabase/server"
import { NextRequest, NextResponse } from "next/server"
import { generateAiDisclosureLedger } from "@/lib/compliance/ai-disclosure-ledger"
// THE tenant roster, defined once — see the tombstone below.
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

/**
 * AI DISCLOSURE LEDGER — CSV EXPORT. The engine + page call this "the exportable
 * compliance record regulators / counsel ask for"; this is the actual export.
 * Same role gate as the page. One row per AI-generated client message with the
 * human-approver proof + the recipient's live consent state — the EU AI Act /
 * FTC human-oversight evidence, as a file counsel can file.
 */
// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONE — the six-role literal that used to sit here
// ═══════════════════════════════════════════════════════════════════════════
// DELETED as a LITERAL (§6, 2026-09-04, lane ROSTER). It read
// ["broker","broker_owner","broker_admin","admin","team_lead","compliance_officer"]
// and described itself as a scope ladder kept deliberately inline. The owner's
// 2026-09-04 ruling ("there is a compliance officer for tenant staff which was
// not included") added the sixth role to TENANT_ADMIN_USER_TYPES, at which point
// this list became BYTE-FOR-BYTE the tenant roster — a second spelling of one
// idea, which is the §6 defect. test:admin-vocabulary's shape scan reported it
// the same day, having reported zero the day before.
//
// ── THE SURVIVOR, AT file:line ─────────────────────────────────────────────
//     lib/auth/resolve-user-role.ts  isAdminOrBroker / TENANT_ADMIN_USER_TYPES
// Membership is IDENTICAL, so this is a deletion and not a behaviour change.

/**
 * RFC-4180 CSV cell: always quoted, embedded quotes doubled. Also neutralizes
 * spreadsheet formula injection — a value beginning with a formula trigger
 * (`=`, `+`, `-`, `@`, tab, CR) is prefixed with a single quote so Excel / Sheets
 * render it as literal text instead of evaluating it. recipient_name / subject
 * are sourced from externally-influenceable data (contact intake, message
 * subjects) and this file is opened by counsel / regulators, so an unescaped
 * `=HYPERLINK(...)` / `=cmd|...` must never execute.
 */
function cell(v: unknown): string {
  let s = String(v ?? "")
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: profile } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return NextResponse.json({ error: "Brokerage not configured" }, { status: 400 })
  if (!isAdminOrBroker({ user_type: profile.user_type })) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  // Optional window override (?since=&until= ISO); defaults to the ledger's 30-day window.
  const { searchParams } = new URL(request.url)
  const sinceIso = searchParams.get("since") || undefined
  const untilIso = searchParams.get("until") || undefined

  const ledger = await generateAiDisclosureLedger({
    brokerageId: profile.brokerage_id,
    sinceIso,
    untilIso,
  })

  const headers = [
    "message_id", "manager", "audience", "channel", "recipient_name", "recipient_contact_id",
    "subject", "status", "proposed_at", "approved_by", "approved_at", "sent_at",
    "consent_now", "suppression_reason",
  ]
  const lines = [
    headers.join(","),
    ...ledger.entries.map((e) => [
      e.messageId, e.managerLabel, e.audience, e.channel, e.recipientName, e.recipientContactId,
      e.subject, e.status, e.proposedAt, e.approvedBy, e.approvedAt, e.sentAt,
      e.channelAllowedNow === null ? "n/a" : e.channelAllowedNow ? "allowed" : "suppressed",
      e.suppressionReason,
    ].map(cell).join(",")),
  ]
  const csv = lines.join("\n")

  const stamp = ledger.until.slice(0, 10)
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ai-disclosure-ledger-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  })
}
