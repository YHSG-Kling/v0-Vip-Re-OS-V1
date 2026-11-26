#!/usr/bin/env tsx
/**
 * scripts/deal-work-ownership-guard.ts — WHO OWNS WHICH WORK ON A DEAL (wave 153, lane 153C; directive §153C C1). npm run test:deal-work-ownership
 *
 * Owner (verbatim, 2026-11-14): "the agetn takes charge and a transaction coordinator can see and assist active listings and
 * transactions, and compliance can review/make notes etc on listings and transactions".
 *
 *   A  the PURE rule (lib/auth/deal-work-ownership.ts resolveDealWork): agent leads its ACTIVE deal; the TC reads and, on an active
 *      deal, assists and flags — never acts as the agent; compliance annotates throughout (closed deals too) and holds closing approval;
 *      tenant admins are the operational roster by NAMED SUBTRACTION (derived from TENANT_ADMIN_USER_TYPES, never retyped); a team
 *      lead sees only its own team's deal; a vendor, a lender, a Contact and another tenant's seat get nothing; capabilities UNION.
 *   B  the DOORS, driven for real on the in-memory client with a signed-in session (SIMULATED — scripts/canaries/_harness.ts stubs the
 *      supabase clients, next/cache and the lender session gate): a TC flags an active deal (persisted, the agent's bell rings) and
 *      records what the lender said (tc_reported, pending) but cannot add a compliance note, cannot verify, and cannot assist a closed
 *      deal; compliance's review note persists on a transaction AND a listing, and on a closed deal; a vendor / another tenant / a team
 *      lead of another team are refused before anything is written; a body-supplied tenant / actor / "today" is ignored; the assigned
 *      lender's receipt is lender-confirmed and an unrelated vendor (title) is refused at the lender door.
 *
 * BLIND SPOTS (published): RLS is not modelled (the doors' tenant predicates are what scope the reads — exactly what is asserted);
 * lib/kernel/portal-auth.ts requireLenderVendorActor is STUBBED with a table-driven resolver of the same rule (lender-category vendor
 * seat + vendor_assignments row) because the in-memory client has no embed support — the writer's own re-check of assignment,
 * category and tenant (lib/compliance/trid-disclosure-clock-evidence.ts) runs for real; React renders are not executed.
 */
import { canaryClient, setSvc, setSessionUser, stubModule, type CanarySvc } from "./canaries/_harness"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f; export const unstable_noStore = () => {}")
// The lender session gate, table-driven: session user → a LENDER-category vendor seat → assigned to THIS transaction.
stubModule("@/lib/kernel/portal-auth", `
export class PortalAuthError extends Error {}
export async function requireLenderVendorActor(transactionId) {
  const svc = globalThis.__W140.svc
  const uid = svc.canary.sessionUserId
  if (!uid) throw new PortalAuthError("Not authenticated")
  const seats = (svc.tables.user_role_assignments ?? []).filter((r) => r.user_id === uid && r.vendor_id)
  const vendor = seats.map((s) => (svc.tables.vendors ?? []).find((v) => v.id === s.vendor_id)).find((v) => v && (v.category === "lender" || v.category === "refinance_lender"))
  if (!vendor) throw new PortalAuthError("Not authorized — your account is not a lender vendor")
  const assigned = (svc.tables.vendor_assignments ?? []).find((a) => a.vendor_id === vendor.id && a.transaction_id === transactionId)
  if (!assigned) throw new PortalAuthError("Unauthorized: lender not assigned to this transaction")
  return { userId: uid, vendorId: vendor.id, brokerageId: vendor.brokerage_id, lenderCompany: vendor.name }
}`)

async function main() {
  const { resolveDealWork } = await import("../lib/auth/deal-work-ownership")
  const { TENANT_ADMIN_USER_TYPES } = await import("../lib/auth/resolve-user-role")

  console.log("\nA — the pure stage-aware rule")
  const base = { sameTenant: true, userType: "agent", grantedRoles: [] as string[], isOwningAgent: false, isAssignedTc: false, isTeamLeadOfDealAgent: false, dealStatus: "under_contract", dealStage: "INSPECTION" }
  const r = (o: Partial<typeof base>) => resolveDealWork({ ...base, ...o })
  const agent = r({ isOwningAgent: true })
  check("the OWNING AGENT leads its active deal (representation / negotiation / decisions) and assists — no compliance note, no closing approval", agent.role === "owning_agent" && agent.capabilities.actAsAgent && agent.capabilities.assist && !agent.capabilities.annotate && !agent.capabilities.closingApproval)
  const agentClosed = r({ isOwningAgent: true, dealStatus: "closed", dealStage: "CLOSED" })
  check("…on a CLOSED deal the agent still reads but no longer acts or assists", agentClosed.capabilities.read && !agentClosed.capabilities.actAsAgent && !agentClosed.capabilities.assist)
  const tc = r({ userType: "tc" })
  check("a TC seat on an ACTIVE deal: reads, assists, flags — NEVER acts as the agent, no compliance note, no closing approval", tc.role === "assisting_tc" && tc.capabilities.read && tc.capabilities.assist && tc.capabilities.flag && !tc.capabilities.actAsAgent && !tc.capabilities.annotate && !tc.capabilities.closingApproval)
  const tcClosed = r({ userType: "tc", dealStatus: "closed", dealStage: "CLOSED" })
  check("…on a CLOSED deal the TC reads but no longer assists", tcClosed.capabilities.read && !tcClosed.capabilities.assist)
  check("the deal's ASSIGNED coordinator (transactions.coordinator_id / transaction_assignments) assists even without a tc seat", r({ isAssignedTc: true }).role === "assisting_tc" && r({ isAssignedTc: true }).capabilities.assist)
  const comp = r({ userType: "compliance_officer" })
  check("COMPLIANCE inspects and annotates, verifies lender evidence and decides closing approval — never assists as staff or acts as the agent", comp.role === "compliance_reviewer" && comp.capabilities.annotate && comp.capabilities.closingApproval && comp.capabilities.verifyLenderEvidence && !comp.capabilities.assist && !comp.capabilities.actAsAgent)
  check("…THROUGHOUT: compliance annotates a CLOSED deal too", r({ userType: "compliance_officer", dealStatus: "closed", dealStage: "CLOSED" }).capabilities.annotate)
  check("a compliance GRANT (user_role_assignments) counts like the seat (one person, several roles)", r({ grantedRoles: ["compliance_officer"] }).capabilities.annotate)
  const derived = [...TENANT_ADMIN_USER_TYPES].filter((t) => t !== "team_lead" && t !== "compliance_officer")
  const allAdmin = derived.every((t) => { const x = r({ userType: t }); return x.role === "tenant_admin" && x.capabilities.annotate && x.capabilities.closingApproval && !x.capabilities.actAsAgent })
  check(`the tenant admin roster is DERIVED (TENANT_ADMIN_USER_TYPES minus team_lead minus compliance_officer: ${derived.join(", ")}) — each reviews, annotates, approves, never acts as the agent`, derived.length > 0 && allAdmin)
  const tl = r({ userType: "team_lead", isTeamLeadOfDealAgent: true })
  check("the deal agent's TEAM LEAD reads, assists and flags its own team's deal — no closing approval", tl.role === "team_lead" && tl.capabilities.assist && !tl.capabilities.closingApproval)
  check("a team lead of ANOTHER team gets nothing on this deal (teams see only their own board)", r({ userType: "team_lead" }).role === "none" && !r({ userType: "team_lead" }).capabilities.read)
  const outsiders = ["vendor", "lender", "contact", "title_agent", "isa", "agent"].map((t) => [t, r({ userType: t })] as const)
  check("a VENDOR, a lender, a Contact, a title seat, an ISA and an unrelated agent get NOTHING (positive control: the same rule admits the owning agent above)", outsiders.every(([, x]) => x.role === "none" && !x.capabilities.read) && agent.capabilities.read, outsiders.filter(([, x]) => x.capabilities.read).map(([t]) => t).join(","))
  check("another tenant's seat gets nothing, whatever its role", r({ sameTenant: false, userType: "broker" }).role === "none")
  const both = r({ isOwningAgent: true, userType: "compliance_officer" })
  check("capabilities are a UNION over roles (an owning agent who is also compliance leads AND annotates)", both.capabilities.actAsAgent && both.capabilities.annotate)

  console.log("\nB — the doors, driven for real (SIMULATED, in-memory, signed-in sessions)")
  const B1 = "brk-1", B2 = "brk-2"
  const U = { agent: "u-agent", tc: "u-tc", comp: "u-comp", lender: "u-lender", title: "u-title", other: "u-other", lead: "u-lead", vendor: "u-vendor" }
  const svc: CanarySvc = canaryClient({
    brokerages: [{ id: B1, name: "One" }, { id: B2, name: "Two" }],
    users: [
      { id: U.agent, brokerage_id: B1, user_type: "agent" }, { id: U.tc, brokerage_id: B1, user_type: "tc" }, { id: U.comp, brokerage_id: B1, user_type: "compliance_officer" },
      { id: U.lender, brokerage_id: B1, user_type: "vendor" }, { id: U.title, brokerage_id: B1, user_type: "vendor" }, { id: U.vendor, brokerage_id: B1, user_type: "vendor" },
      { id: U.other, brokerage_id: B2, user_type: "broker" }, { id: U.lead, brokerage_id: B1, user_type: "team_lead" },
    ],
    agents: [{ id: "a-1", user_id: U.agent, brokerage_id: B1, team_id: "team-1" }],
    teams: [{ id: "team-1", brokerage_id: B1, team_lead_id: "u-someone-else" }],
    transaction_coordinators: [{ id: "tc-1", user_id: U.tc, brokerage_id: B1, is_active: true }],
    transaction_assignments: [],
    transactions: [
      { id: "t1", brokerage_id: B1, agent_id: "a-1", coordinator_id: "tc-1", status: "under_contract", stage: "CLOSING_PREP", financing_type: "conventional", close_date: "2026-06-26", deal_type: "buyer" },
      { id: "t-closed", brokerage_id: B1, agent_id: "a-1", coordinator_id: "tc-1", status: "closed", stage: "CLOSED", financing_type: "conventional", close_date: "2026-05-01", deal_type: "buyer" },
    ],
    listings: [{ id: "l1", brokerage_id: B1, agent_id: "a-1", status: "active", lifecycle_stage: "active" }],
    vendors: [{ id: "lv-1", name: "Acme Mortgage", category: "lender", brokerage_id: B1 }, { id: "tv-1", name: "Clear Title", category: "title", brokerage_id: B1 }],
    vendor_assignments: [{ id: "va-1", vendor_id: "lv-1", transaction_id: "t1", brokerage_id: B1, status: "confirmed" }, { id: "va-2", vendor_id: "tv-1", transaction_id: "t1", brokerage_id: B1, status: "confirmed" }],
    user_role_assignments: [{ id: "ura-l", user_id: U.lender, vendor_id: "lv-1", role: "vendor", brokerage_id: null }, { id: "ura-t", user_id: U.title, vendor_id: "tv-1", role: "vendor", brokerage_id: null }],
    transaction_documents: [{ id: "d-conf", transaction_id: "t1", brokerage_id: B1, doc_type: "lender_correspondence", doc_label: "Lender confirmation" }],
    transaction_compliance_log: [], trid_timeline: [], trid_disclosure_receipts: [], ai_assistant_notes: [], notifications: [], transaction_tasks: [],
  }, { unique: { trid_disclosure_receipts: [["transaction_id", "idempotency_key"]], trid_timeline: [["transaction_id"]] } })
  setSvc(svc)
  const N = await import("../app/actions/deal-review-notes")
  const R = await import("../app/actions/trid-disclosure-receipt")
  const notes = () => svc.tables.ai_assistant_notes ?? []
  const receipt = (o: Record<string, unknown> = {}) => ({
    transactionId: "t1", version: 1, issuerName: "Acme Mortgage", senderRole: "creditor", deliveryMethod: "email",
    deliveredAt: "2026-06-15T14:00:00-04:00", receivedAt: "2026-06-15T18:00:00-04:00", receiptTimezone: "America/New_York", receiptEvidence: "lender_statement", lenderContactName: "Pat Lender", ...o,
  })

  setSessionUser(svc, U.tc)
  const flag = await N.addDealReviewNoteAction({ entityType: "transaction", entityId: "t1", kind: "flag", body: "The appraisal addendum is missing the buyer's initials." })
  const flagRow = notes().find((n) => n.note_type === "action_item")
  const bell = (svc.tables.notifications ?? []).find((n) => n.user_id === U.agent && n.type === "deal_flag")
  check("the TC FLAGS an active deal: persisted (source human, role tc, note_type action_item) and the OWNING AGENT's bell rings (users.id via agents.user_id)", flag.success && flagRow?.source === "human" && flagRow?.role === "tc" && flagRow?.transaction_id === "t1" && !!bell, JSON.stringify(flag))
  const tcNote = await N.addDealReviewNoteAction({ entityType: "transaction", entityId: "t1", kind: "review_note", body: "Compliance-style note from the TC" })
  check("…but the TC cannot add a COMPLIANCE review note", !tcNote.success)
  const tcView = await N.listDealReviewNotesAction({ entityType: "transaction", entityId: "t1" })
  check("the TC's view says it assists and CANNOT act as the agent", tcView.success && tcView.access.canAssist && !tcView.access.canActAsAgent && !tcView.access.closingApproval)
  const tcReport = await R.reportClosingDisclosureReceiptAction({ ...receipt(), brokerageId: B2, actor: { userId: U.tc, kind: "lender" }, today: "2099-01-01" } as never)
  const tcRow = (svc.tables.trid_disclosure_receipts ?? [])[0]
  check("the TC ASSISTS: records what the lender said → tc_reported / pending; a body-supplied tenant, actor and 'today' are IGNORED", tcReport.success && tcRow?.source === "tc_reported" && tcRow?.verification_status === "pending_lender_confirmation" && tcRow?.brokerage_id === B1 && tcRow?.reported_by === U.tc, JSON.stringify(tcReport))
  const tcVerify = await R.verifyReportedClosingDisclosureReceiptAction({ transactionId: "t1", reportedReceiptId: String(tcRow?.id), documentId: "d-conf" })
  check("…the TC cannot VERIFY a receipt (compliance / admins only)", !tcVerify.success)
  const tcClosed2 = await R.reportClosingDisclosureReceiptAction(receipt({ transactionId: "t-closed" }) as never)
  check("…and cannot assist a CLOSED deal", !tcClosed2.success)

  setSessionUser(svc, U.comp)
  const cNote = await N.addDealReviewNoteAction({ entityType: "transaction", entityId: "t1", kind: "review_note", body: "Executed counter matches the purchase agreement terms; HOA addendum still pending." })
  const cRow = notes().find((n) => n.note_type === "observation" && n.transaction_id === "t1")
  check("COMPLIANCE's review note is PERSISTED on the transaction (role compliance_officer, observation, created_by the session user)", cNote.success && cRow?.role === "compliance_officer" && cRow?.created_by === U.comp)
  const cClosed = await N.addDealReviewNoteAction({ entityType: "transaction", entityId: "t-closed", kind: "review_note", body: "Post-close file review: CDA and settlement statement on file." })
  check("…on a CLOSED deal too (throughout)", cClosed.success)
  const cListing = await N.addDealReviewNoteAction({ entityType: "listing", entityId: "l1", kind: "review_note", body: "Listing remarks reviewed for fair-housing language." })
  check("…and on a LISTING (listing_id set)", cListing.success && notes().some((n) => n.listing_id === "l1" && n.role === "compliance_officer"))
  const cVerify = await R.verifyReportedClosingDisclosureReceiptAction({ transactionId: "t1", reportedReceiptId: String(tcRow?.id), documentId: "d-conf" })
  check("compliance VERIFIES the TC's report with the lender's written confirmation → the clock starts (earliest 6/18)", cVerify.success && cVerify.earliestConsummationDate === "2026-06-18", JSON.stringify(cVerify))

  const before = notes().length
  setSessionUser(svc, U.vendor)
  const vList = await N.listDealReviewNotesAction({ entityType: "transaction", entityId: "t1" })
  const vFlag = await N.addDealReviewNoteAction({ entityType: "transaction", entityId: "t1", kind: "flag", body: "vendor note" })
  setSessionUser(svc, U.other)
  const oFlag = await N.addDealReviewNoteAction({ entityType: "transaction", entityId: "t1", kind: "review_note", body: "other tenant" })
  setSessionUser(svc, U.lead)
  const lFlag = await N.addDealReviewNoteAction({ entityType: "transaction", entityId: "t1", kind: "flag", body: "another team's lead" })
  check("an UNRELATED VENDOR, ANOTHER TENANT's broker and ANOTHER team's lead are refused — nothing written", !vList.success && !vFlag.success && !oFlag.success && !lFlag.success && notes().length === before)

  setSessionUser(svc, U.title)
  const titleAsLender = await R.recordLenderClosingDisclosureReceiptAction(receipt({ receiptEvidence: "lender_esign_receipt" }) as never)
  check("the deal's TITLE company cannot record the lender's Closing Disclosure (unrelated vendor refused at the lender door)", !titleAsLender.success)
  setSessionUser(svc, U.lender)
  const len = await R.recordLenderClosingDisclosureReceiptAction(receipt({ version: 2, revisionChanges: ["other_terms"], receivedAt: "2026-06-16T10:00:00-04:00", receiptEvidence: "lender_esign_receipt", deliveryMethod: "electronic_portal" }) as never)
  const lenRow = (svc.tables.trid_disclosure_receipts ?? []).find((x) => x.source === "lender_portal")
  check("the ASSIGNED LENDER records its revised CD → lender_portal / lender-confirmed (an ordinary revision keeps the 6/18 date)", len.success && lenRow?.verification_status === "lender_confirmed" && len.earliestConsummationDate === "2026-06-18", JSON.stringify(len))
  setSessionUser(svc, U.agent)
  const agentVerify = await R.verifyReportedClosingDisclosureReceiptAction({ transactionId: "t1", reportedReceiptId: String(tcRow?.id), documentId: "d-conf" })
  check("the owning agent cannot verify its own report (verification is compliance's)", !agentVerify.success)
  const status = await R.getTridDisclosureStatusAction("t1")
  check("the agent's status read shows the lender on the platform, the confirmed record, and offers report (assist) but not verify", status.success && status.lender.onPlatform && status.receipts.length >= 2 && status.can.report && !status.can.verify)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
  console.log(" ✅ DEAL_WORK_OWNERSHIP_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
