/**
 * lib/ai-isa/user-type-tools.ts
 *
 * Lane 77A — the BUILDERS behind lib/ai-isa/user-type-tool-policy.ts's ONE
 * seat table. Owner verbatim (wave 77): "other user types need their own
 * tools if there are no tools already covered."
 *
 * Every tool here is a THIN ADAPTER over an existing survivor (CLAUDE.md §1 —
 * never a second implementation): the vendor/lender/title portal ACTIONS
 * (app/actions/vendor-portal.ts, vendor-service-areas.ts, vendor-documents.ts,
 * lender-portal-actions.ts, title-portal.ts — each already runs its own
 * session gate from lib/kernel/portal-auth.ts, so a write here is gated
 * TWICE: once by this context's session-resolved identity, once by the
 * survivor's own requireXActor), the kernel's team/coaching readers
 * (lib/kernel/resolve-user-team.ts, lib/kernel/agent-coaching.ts), and plain
 * tenant-pinned reads of the live tables (scripts/schema-snapshot.ts).
 *
 * IDENTITY IS LOCKED FROM `ctx`, NEVER A MODEL ARGUMENT (CLAUDE.md §4): the
 * vendor id is user_role_assignments.vendor_id read off the SESSION
 * (lib/auth/role-grants.ts::selectVendorId — one vendor or none, never an
 * arbitrary row), the title identity is the session's own title_company_
 * users rows, the team is teams.team_lead_id = the session's users.id. A
 * model may name a JOB or a TRANSACTION id (it read it from a previous tool
 * result) — every such id is then re-checked against the locked vendor +
 * brokerage predicates before anything is read or written. Every read
 * destructures `{ data, error }` and reports the error (§3 — supabase-js
 * RESOLVES refusals).
 *
 * FAIL CLOSED: buildUserTypeSeatTools mounts a partner seat's tools ONLY when
 * the identity resolved; a 'vendor' role with no vendor grant gets {} (and
 * the prompt block says so) rather than tools that would read nothing.
 *
 * COST: every tool here is rank 0 — no BatchData, no RentCast, no vendor
 * spend of any kind. The seat table never allows a paid tool on a partner
 * seat, so nothing here ever competes with one for cost order.
 */

import { tool } from "ai"
import { z } from "zod"
import { createServiceClient } from "@/lib/supabase/service"
import { USER_TYPE_TOOL_POLICY, type UserTypeSeat } from "@/lib/ai-isa/user-type-tool-policy"

export interface UserTypeSeatContext {
  seat: UserTypeSeat
  /** The SESSION's tenant — never a request body. */
  brokerageId: string
  /** auth.users.id / users.id of the signed-in person. */
  userId: string
  /** vendors.id resolved from the session's vendor-bearing grant, or null. */
  vendorId: string | null
  /** The session's own title_company_users rows (id + transaction_id), or []. */
  titleMemberships: ReadonlyArray<{ id: string; transactionId: string | null }>
}

type Svc = ReturnType<typeof createServiceClient>

// ─── VENDOR SEAT ────────────────────────────────────────────────────────────

/** Own placements / invoices / payouts. SAME three reads lane 76A's catalogue
 *  tool ran, now keyed on the session-resolved vendors.id (tombstone in
 *  lib/ai-isa/capability-catalogue.ts). */
function buildGetMyVendorStatusTool(ctx: UserTypeSeatContext & { vendorId: string }) {
  return tool({
    description: "Look up YOUR OWN vendor account with this brokerage: open assignments/placements (type, status, scheduled/completed dates), your invoices (number, status, due date, paid date, total), your payouts (status, amount, method, dates) and your stored availability (typical turnaround in days — the one availability fact the OS keeps; there is no vendor calendar). Your own records only.",
    inputSchema: z.object({}),
    execute: async () => {
      const svc = createServiceClient()
      // Lane 78D, blind spot (5) — vendor availability. The READ half of
      // update_my_availability: `vendors.estimated_turnaround_days` is the only
      // stored availability fact (no vendor calendar/availability table exists in
      // scripts/schema-snapshot.ts; `vendor_bookings` holds the dates already
      // booked, read by get_my_jobs_and_bookings). Exposed here, honestly labelled,
      // rather than as a second tool that would imply a calendar.
      const { data: vendor, error: vErr } = await svc.from("vendors").select("id, name, category, status, rating, preferred, verified_at, estimated_turnaround_days").eq("id", ctx.vendorId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
      if (vErr) return { success: false, error: vErr.message }
      if (!vendor) return { success: false, error: "Your vendor account is not on this brokerage's bench" }
      const [a, i, p] = await Promise.all([
        svc.from("vendor_assignments").select("id, transaction_id, assignment_type, status, scheduled_date, completed_date").eq("vendor_id", ctx.vendorId).eq("brokerage_id", ctx.brokerageId).order("scheduled_date", { ascending: false }).limit(10),
        svc.from("vendor_invoices").select("id, invoice_number, status, invoice_date, due_date, paid_at, total_amount, billed_to").eq("vendor_id", ctx.vendorId).eq("brokerage_id", ctx.brokerageId).order("invoice_date", { ascending: false }).limit(10),
        // No `currency` here: nothing writes vendor_payouts.currency (opposite-missing 1b) — a read of it would be a value that is only ever the column default.
        svc.from("vendor_payouts").select("id, status, amount, payout_method, initiated_at, completed_at").eq("vendor_id", ctx.vendorId).eq("brokerage_id", ctx.brokerageId).order("initiated_at", { ascending: false }).limit(10),
      ])
      const firstError = a.error ?? i.error ?? p.error
      if (firstError) return { success: false, error: firstError.message }
      return {
        success: true,
        vendor: { name: vendor.name, category: vendor.category, status: vendor.status, rating: vendor.rating, preferred: vendor.preferred, verifiedAt: vendor.verified_at },
        availability: {
          estimatedTurnaroundDays: (vendor as { estimated_turnaround_days?: number | null }).estimated_turnaround_days ?? null,
          note: "typical turnaround in days is the only availability the OS stores (set it with update_my_availability); booked dates are in get_my_jobs_and_bookings — no vendor calendar exists",
        },
        assignments: a.data ?? [],
        invoices: i.data ?? [],
        payouts: p.data ?? [],
      }
    },
  })
}

function buildGetMyJobsAndBookingsTool(ctx: UserTypeSeatContext & { vendorId: string }) {
  return tool({
    description: "List YOUR OWN jobs (title, status, estimate vs actual cost, linked transaction) and bookings (service, status, scheduled date, time window) with this brokerage. Use the ids returned here for respond_to_booking / send_vendor_message_to_agent.",
    inputSchema: z.object({
      only_open: z.boolean().nullable().describe("true to hide completed/cancelled rows"),
    }),
    execute: async ({ only_open }: { only_open: boolean | null }) => {
      const svc = createServiceClient()
      let jobs = svc.from("vendor_jobs").select("id, job_title, status, cost_estimate, cost_actual, transaction_id, assignment_id, created_at, updated_at").eq("vendor_id", ctx.vendorId).eq("brokerage_id", ctx.brokerageId).order("updated_at", { ascending: false }).limit(15)
      let bookings = svc.from("vendor_bookings").select("id, service_type, status, scheduled_date, preferred_time_window, transaction_id, listing_id, request_message, booked_at").eq("vendor_id", ctx.vendorId).eq("brokerage_id", ctx.brokerageId).order("scheduled_date", { ascending: true }).limit(15)
      if (only_open) {
        jobs = jobs.not("status", "in", "(completed,cancelled)")
        bookings = bookings.not("status", "in", "(completed,cancelled,no_show)")
      }
      const [j, b] = await Promise.all([jobs, bookings])
      if (j.error) return { success: false, error: j.error.message }
      if (b.error) return { success: false, error: b.error.message }
      return { success: true, jobs: j.data ?? [], bookings: b.data ?? [] }
    },
  })
}

/** Takes NO context on purpose: the survivor (getVendorDocuments) resolves the
 *  vendor from the SAME session grant this seat's context came from, so the
 *  identity gate lives there — passing ctx here would be an inert argument.
 *  Still registered as a vendor-keyed builder so it never mounts without a
 *  resolved vendor identity (buildUserTypeSeatTools' fail-closed rule). */
function buildGetMyDocumentsTool() {
  return tool({
    description: "List YOUR OWN documents on file with this brokerage — invoices, job deliverables, W-9 / insurance / licence items — with each one's status. Returns names and statuses only, never a download link (those open in the portal).",
    inputSchema: z.object({}),
    execute: async () => {
      // Survivor: app/actions/vendor-documents.ts::getVendorDocuments — resolves
      // the vendor from the SAME session grant this context did, and reads the
      // SAME rails (vendor_invoices, transaction_documents by metadata.vendor_id,
      // vendors.compliance_credentials). URLs are stripped here: a chat reply
      // never carries a signed download link.
      const { getVendorDocuments } = await import("@/app/actions/vendor-documents")
      const summary = await getVendorDocuments()
      const strip = (rows: unknown): unknown =>
        Array.isArray(rows) ? rows.map((r) => (r && typeof r === "object" ? { ...(r as Record<string, unknown>), url: undefined } : r)) : rows
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(summary as unknown as Record<string, unknown>)) out[k] = strip(v)
      return { success: true, ...out }
    },
  })
}

function buildGetMyRatingsTool(ctx: UserTypeSeatContext & { vendorId: string }) {
  return tool({
    description: "Your OWN rating summary (agent and client averages, review count, star distribution) and your most recent published reviews (rating, headline, text, your response if any) so you can respond or improve. Never another vendor's, never a reviewer's identity.",
    inputSchema: z.object({}),
    execute: async () => {
      const svc = createServiceClient()
      const [r, v] = await Promise.all([
        svc.from("vendor_ratings").select("avg_agent_rating, avg_client_rating, review_avg, review_count, verified_review_count, total_bookings, five_star_count, one_star_count, last_updated").eq("vendor_id", ctx.vendorId).eq("brokerage_id", ctx.brokerageId).maybeSingle(),
        svc.from("vendor_reviews").select("id, rating, headline, review, sub_ratings, is_verified, moderation_status, vendor_response, vendor_response_at, created_at").eq("vendor_id", ctx.vendorId).eq("brokerage_id", ctx.brokerageId).eq("moderation_status", "approved").order("created_at", { ascending: false }).limit(8),
      ])
      if (r.error) return { success: false, error: r.error.message }
      if (v.error) return { success: false, error: v.error.message }
      return { success: true, summary: r.data ?? null, reviews: v.data ?? [] }
    },
  })
}

function buildRespondToBookingTool(ctx: UserTypeSeatContext & { vendorId: string }) {
  return tool({
    description: "Accept or decline ONE of your own bookings (id from get_my_jobs_and_bookings). Accepting may set the scheduled date; declining takes a short reason. Only when the vendor explicitly asks.",
    inputSchema: z.object({
      booking_id: z.string().describe("vendor_bookings.id from get_my_jobs_and_bookings"),
      decision: z.enum(["accept", "decline"]),
      scheduled_date: z.string().nullable().describe("ISO date/time to confirm for, or null"),
      reason: z.string().nullable().describe("Why declining, or null"),
    }),
    execute: async ({ booking_id, decision, scheduled_date, reason }: { booking_id: string; decision: "accept" | "decline"; scheduled_date: string | null; reason: string | null }) => {
      // The survivors re-gate on the session (requireVendorActor) AND re-check
      // the booking's own vendor_id + brokerage_id — the model-named id can
      // only ever reach this vendor's own row.
      const { acceptVendorBookingAction, declineVendorBookingAction } = await import("@/app/actions/vendor-portal")
      const result = decision === "accept"
        ? await acceptVendorBookingAction({ bookingId: booking_id, vendorId: ctx.vendorId, scheduledDate: scheduled_date ?? undefined })
        : await declineVendorBookingAction({ bookingId: booking_id, vendorId: ctx.vendorId, reason: reason ?? undefined })
      return result.success ? { success: true, decision, bookingId: booking_id } : { success: false, error: result.error ?? "Could not update the booking" }
    },
  })
}

function buildUpdateMyServiceAreaTool(ctx: UserTypeSeatContext & { vendorId: string }) {
  return tool({
    description: "Declare a state (and optionally a ZIP) you now cover, in your own trade category. Statewide coverage = state only. Survivor: the vendor coverage rail (requires your marketplace profile; the agent is told if you have none).",
    inputSchema: z.object({
      state: z.string().describe("Two-letter state code"),
      zip_code: z.string().nullable().describe("A ZIP for local coverage, or null for statewide"),
      notes: z.string().nullable(),
    }),
    execute: async ({ state, zip_code, notes }: { state: string; zip_code: string | null; notes: string | null }) => {
      const svc = createServiceClient()
      const { data: vendor, error } = await svc.from("vendors").select("id, category, platform_vendor_id").eq("id", ctx.vendorId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
      if (error) return { success: false, error: error.message }
      if (!vendor) return { success: false, error: "Your vendor account is not on this brokerage's bench" }
      if (!vendor.platform_vendor_id) return { success: false, error: "No marketplace profile is linked to your vendor account yet — coverage is declared on the profile; the agent can link one" }
      if (!vendor.category) return { success: false, error: "Your vendor account has no trade category set — the agent sets it before coverage can be declared" }
      // Survivor: app/actions/vendor-service-areas.ts::declareVendorServiceAreaAction
      // (requireCoverageWriter gates on the session; normalises state/ZIP).
      const { declareVendorServiceAreaAction } = await import("@/app/actions/vendor-service-areas")
      const result = await declareVendorServiceAreaAction({
        platformVendorId: vendor.platform_vendor_id as string,
        state,
        zipCode: zip_code,
        tradeCategory: vendor.category as string,
        notes: notes ?? undefined,
      })
      return result.ok ? { success: true, serviceAreaId: result.serviceAreaId ?? null, state, zipCode: zip_code } : { success: false, error: result.error ?? "Could not declare coverage" }
    },
  })
}

function buildUpdateMyAvailabilityTool(ctx: UserTypeSeatContext & { vendorId: string }) {
  return tool({
    description: "Set your typical turnaround in days (how soon you can usually take a job) on your own vendor record — the field agents see when booking. No calendar exists for vendors; this is the ONE availability fact the OS stores.",
    inputSchema: z.object({
      estimated_turnaround_days: z.number().int().min(0).max(365),
    }),
    execute: async ({ estimated_turnaround_days }: { estimated_turnaround_days: number }) => {
      const svc = createServiceClient()
      const { data, error } = await svc.from("vendors")
        .update({ estimated_turnaround_days, updated_at: new Date().toISOString() })
        .eq("id", ctx.vendorId).eq("brokerage_id", ctx.brokerageId)
        .select("id, estimated_turnaround_days")
      if (error) return { success: false, error: error.message }
      // A matched-nothing update also resolves (§3) — count what came back.
      if (!data || data.length === 0) return { success: false, error: "Your vendor account is not on this brokerage's bench — nothing was updated" }
      return { success: true, estimatedTurnaroundDays: data[0].estimated_turnaround_days }
    },
  })
}

function buildSendVendorMessageToAgentTool(ctx: UserTypeSeatContext & { vendorId: string }) {
  return tool({
    description: "Send a short message to the agent on ONE of your own jobs (job id + its transaction id from get_my_jobs_and_bookings). Only when the vendor asks you to pass something along.",
    inputSchema: z.object({
      job_id: z.string(),
      transaction_id: z.string(),
      message: z.string().min(1).max(1000),
    }),
    execute: async ({ job_id, transaction_id, message }: { job_id: string; transaction_id: string; message: string }) => {
      // Survivor re-gates on the session and verifies the job ↔ transaction ↔
      // vendor link before any inbox row is written.
      const { sendVendorMessageToAgent } = await import("@/app/actions/vendor-portal")
      try {
        await sendVendorMessageToAgent({ jobId: job_id, transactionId: transaction_id, vendorId: ctx.vendorId, message })
        return { success: true, jobId: job_id }
      } catch (e) {
        return { success: false, error: (e as Error).message }
      }
    },
  })
}

// ─── LENDER SEAT ────────────────────────────────────────────────────────────

const LOAN_STATUS_OPTIONS = ["pre_approved", "processing", "underwriting", "pending_conditions", "approved", "clear_to_close", "funded", "denied", "withdrawn"] as const

async function lenderTransactionIds(svc: Svc, ctx: UserTypeSeatContext & { vendorId: string }): Promise<string[]> {
  // Survivor: lib/kernel/lender-linkage.ts — pinned to the vendor's OWN
  // brokerage (the un-pinned read folded two tenants' deals together once).
  const { lenderVendorTransactionIds, lenderFilterIds } = await import("@/lib/kernel/lender-linkage")
  return lenderFilterIds(await lenderVendorTransactionIds(svc, ctx.vendorId, ctx.brokerageId))
}

function buildGetMyLoanPipelineTool(ctx: UserTypeSeatContext & { vendorId: string }) {
  return tool({
    description: "Your OWN loan pipeline: every transaction your lender company is assigned to, with the deal name/address/status/close date and the loan's milestones — pre-approval amount/date, rate lock date and expiration, appraisal ordered/completed, underwriting status, clear-to-close date. Only deals you are assigned to.",
    inputSchema: z.object({}),
    execute: async () => {
      const svc = createServiceClient()
      const ids = await lenderTransactionIds(svc, ctx)
      const [t, l] = await Promise.all([
        svc.from("transactions").select("id, deal_name, property_address, status, stage, close_date").in("id", ids).eq("brokerage_id", ctx.brokerageId).limit(25),
        svc.from("transaction_lenders").select("transaction_id, lender_name, loan_officer_name, loan_type, loan_amount, pre_approval_amount, pre_approval_date, rate_lock_date, rate_lock_expiration_date, rate_lock_extended_at, appraisal_ordered_date, appraisal_completed_date, underwriting_status, clear_to_close_date, updated_at").in("transaction_id", ids).eq("brokerage_id", ctx.brokerageId).limit(25),
      ])
      if (t.error) return { success: false, error: t.error.message }
      if (l.error) return { success: false, error: l.error.message }
      const loansByTx = new Map((l.data ?? []).map((r: { transaction_id: string }) => [r.transaction_id, r]))
      return {
        success: true,
        deals: (t.data ?? []).map((tx: Record<string, unknown>) => ({ ...tx, loan: loansByTx.get(tx.id as string) ?? null })),
      }
    },
  })
}

function buildUpdateLoanStatusTool(ctx: UserTypeSeatContext & { vendorId: string }) {
  return tool({
    description: "Move a loan's underwriting status forward on ONE of your own deals (transaction id from get_my_loan_pipeline). Only when the loan officer explicitly asks. Clear-to-close is issued from the portal's own action, not here.",
    inputSchema: z.object({
      transaction_id: z.string(),
      new_status: z.enum(LOAN_STATUS_OPTIONS),
    }),
    execute: async ({ transaction_id, new_status }: { transaction_id: string; new_status: (typeof LOAN_STATUS_OPTIONS)[number] }) => {
      if (new_status === "clear_to_close") return { success: false, error: "Clear-to-close is issued from the portal's Clear to Close action (it runs its own checks) — not from chat" }
      const svc = createServiceClient()
      const ids = await lenderTransactionIds(svc, ctx)
      if (!ids.includes(transaction_id)) return { success: false, error: "That transaction is not one your lender company is assigned to" }
      // Survivor re-gates via requireLenderVendorActor(transactionId).
      const { updateLenderLoanStatus } = await import("@/app/actions/lender-portal-actions")
      const result = await updateLenderLoanStatus({ transactionId: transaction_id, newStatus: new_status })
      return result.success ? { success: true, transactionId: transaction_id, underwritingStatus: new_status } : { success: false, error: result.error ?? "Could not update the loan status" }
    },
  })
}

function buildFlagLoanIssueTool(ctx: UserTypeSeatContext & { vendorId: string }) {
  return tool({
    description: "Flag an issue or outstanding condition on ONE of your own deals so the agent is notified (e.g. a missing document, an appraisal gap, a rate lock about to expire).",
    inputSchema: z.object({
      transaction_id: z.string(),
      issue: z.string().min(3).max(800),
    }),
    execute: async ({ transaction_id, issue }: { transaction_id: string; issue: string }) => {
      const svc = createServiceClient()
      const ids = await lenderTransactionIds(svc, ctx)
      if (!ids.includes(transaction_id)) return { success: false, error: "That transaction is not one your lender company is assigned to" }
      const { flagLenderIssue } = await import("@/app/actions/lender-portal-actions")
      const result = await flagLenderIssue({ transactionId: transaction_id, issueDescription: issue })
      return result.success ? { success: true, transactionId: transaction_id } : { success: false, error: result.error ?? "Could not flag the issue" }
    },
  })
}

function buildListTransactionDocumentsTool(ctx: UserTypeSeatContext & { vendorId: string }) {
  return tool({
    description: "List the documents on ONE of your own deals — label, type, status, signature status, upload date — AND the agent's OUTSTANDING asks of you on that deal (status updates and documents requested, with who asked and when). Names and statuses only; downloads happen in the portal.",
    inputSchema: z.object({ transaction_id: z.string() }),
    execute: async ({ transaction_id }: { transaction_id: string }) => {
      const svc = createServiceClient()
      const ids = await lenderTransactionIds(svc, ctx)
      if (!ids.includes(transaction_id)) return { success: false, error: "That transaction is not one your lender company is assigned to" }
      // Lane 78D, blind spot (4): the OUTSTANDING ASKS — `document_requests`
      // rows app/actions/lender-status-request.ts files (one per requested
      // item, status 'pending' until the portal marks them 'submitted'). Read
      // alongside what is already on the deal, so "what has the agent asked
      // me for" has a reader on the lender seat.
      const [docs, asks] = await Promise.all([
        svc.from("transaction_documents")
          .select("id, doc_label, doc_type, status, signature_status, uploaded_at, uploaded_by_type")
          .eq("transaction_id", transaction_id).eq("brokerage_id", ctx.brokerageId)
          .order("uploaded_at", { ascending: false }).limit(40),
        svc.from("document_requests")
          .select("id, document_name, document_type, status, due_date, created_at, fulfilled_at")
          .eq("transaction_id", transaction_id).eq("brokerage_id", ctx.brokerageId)
          .eq("status", "pending")
          .order("created_at", { ascending: false }).limit(20),
      ])
      if (docs.error) return { success: false, error: docs.error.message }
      // A refused asks read is REPORTED beside the documents, never rendered as
      // "nothing outstanding" (§3: a refusal resolves with data: null).
      if (asks.error) return { success: true, documents: docs.data ?? [], outstandingRequests: [], outstandingRequestsError: asks.error.message }
      return { success: true, documents: docs.data ?? [], outstandingRequests: asks.data ?? [] }
    },
  })
}

function buildSendLenderMessageToAgentTool(ctx: UserTypeSeatContext & { vendorId: string }) {
  return tool({
    description: "Send a short message to the agent on ONE of your own deals. Only when the loan officer asks you to pass something along.",
    inputSchema: z.object({ transaction_id: z.string(), message: z.string().min(1).max(1000) }),
    execute: async ({ transaction_id, message }: { transaction_id: string; message: string }) => {
      const svc = createServiceClient()
      const ids = await lenderTransactionIds(svc, ctx)
      if (!ids.includes(transaction_id)) return { success: false, error: "That transaction is not one your lender company is assigned to" }
      const { sendLenderMessageToAgent } = await import("@/app/actions/lender-portal-actions")
      const result = await sendLenderMessageToAgent(message, { partnerId: ctx.vendorId, partnerType: "lender", transactionId: transaction_id })
      return result.success ? { success: true, transactionId: transaction_id } : { success: false, error: result.error ?? "Could not send the message" }
    },
  })
}

// ─── TITLE SEAT ─────────────────────────────────────────────────────────────

const TITLE_STATUS_VALUES = ["title_search", "commitment_issued", "closing_ready", "closed"] as const

function titleMembershipFor(ctx: UserTypeSeatContext, transactionId: string) {
  return ctx.titleMemberships.find((m) => m.transactionId === transactionId) ?? null
}

function buildGetMyTitleTransactionsTool(ctx: UserTypeSeatContext) {
  return tool({
    description: "Your OWN closings: every transaction your title company is on, with deal name/address/status/close date and the title & escrow milestones — title search ordered/completed, commitment date, closing scheduled date, title status, open title issues. Never earnest-money or wire details.",
    inputSchema: z.object({}),
    execute: async () => {
      const ids = ctx.titleMemberships.map((m) => m.transactionId).filter((x): x is string => !!x)
      if (ids.length === 0) return { success: true, deals: [], note: "No transactions are linked to your title account yet" }
      const svc = createServiceClient()
      const [t, e] = await Promise.all([
        svc.from("transactions").select("id, deal_name, property_address, status, stage, close_date").in("id", ids).eq("brokerage_id", ctx.brokerageId).limit(25),
        svc.from("transaction_title_escrow").select("transaction_id, title_status, title_search_ordered_date, title_search_completed_date, title_commitment_date, closing_scheduled_date, closing_location, title_issues, updated_at").in("transaction_id", ids).eq("brokerage_id", ctx.brokerageId).limit(25),
      ])
      if (t.error) return { success: false, error: t.error.message }
      if (e.error) return { success: false, error: e.error.message }
      const byTx = new Map((e.data ?? []).map((r: { transaction_id: string }) => [r.transaction_id, r]))
      return { success: true, deals: (t.data ?? []).map((tx: Record<string, unknown>) => ({ ...tx, title: byTx.get(tx.id as string) ?? null })) }
    },
  })
}

function buildUpdateTitleStatusTool(ctx: UserTypeSeatContext) {
  return tool({
    description: "Move ONE of your own files' title status forward: title_search → commitment_issued → closing_ready → closed. Only when the title officer explicitly asks.",
    inputSchema: z.object({ transaction_id: z.string(), new_status: z.enum(TITLE_STATUS_VALUES) }),
    execute: async ({ transaction_id, new_status }: { transaction_id: string; new_status: (typeof TITLE_STATUS_VALUES)[number] }) => {
      const membership = titleMembershipFor(ctx, transaction_id)
      if (!membership) return { success: false, error: "That transaction is not one your title company is on" }
      // Survivor re-gates via requireTitleActor(titleUserId) — the id is OURS
      // (the session's own title_company_users row), never model-supplied.
      const { updateTitleStatus } = await import("@/app/actions/title-portal")
      const result = await updateTitleStatus({ transactionId: transaction_id, titleUserId: membership.id, newStatus: new_status })
      return result.success ? { success: true, transactionId: transaction_id, titleStatus: new_status } : { success: false, error: result.error ?? "Could not update the title status" }
    },
  })
}

function buildSendTitleMessageToAgentTool(ctx: UserTypeSeatContext) {
  return tool({
    description: "Send a short message to the agent on ONE of your own closings. Only when the title officer asks you to pass something along.",
    inputSchema: z.object({ transaction_id: z.string(), message: z.string().min(1).max(1000) }),
    execute: async ({ transaction_id, message }: { transaction_id: string; message: string }) => {
      const membership = titleMembershipFor(ctx, transaction_id)
      if (!membership) return { success: false, error: "That transaction is not one your title company is on" }
      const { sendTitleMessageToAgent } = await import("@/app/actions/title-portal")
      try {
        await sendTitleMessageToAgent({ transactionId: transaction_id, titleUserId: membership.id, message })
        return { success: true, transactionId: transaction_id }
      } catch (e) {
        return { success: false, error: (e as Error).message }
      }
    },
  })
}

// ─── TEAM LEAD SEAT ─────────────────────────────────────────────────────────

async function ledTeam(svc: Svc, ctx: UserTypeSeatContext): Promise<{ ok: true; teamId: string; agentIds: string[] } | { ok: false; error: string }> {
  // Survivor: lib/kernel/resolve-user-team.ts::resolveLedTeamId — anchored on
  // teams.team_lead_id = users.id (CLAUDE.md §4), deterministic, refusal visible.
  const { resolveLedTeamId } = await import("@/lib/kernel/resolve-user-team")
  const led = await resolveLedTeamId(svc as never, ctx.userId)
  if (!led.ok) return { ok: false, error: led.error }
  if (!led.teamId) return { ok: false, error: "You do not lead a team on this brokerage" }
  const { data: team, error: tErr } = await svc.from("teams").select("id").eq("id", led.teamId).eq("brokerage_id", ctx.brokerageId).is("deleted_at", null).maybeSingle()
  if (tErr) return { ok: false, error: tErr.message }
  if (!team) return { ok: false, error: "The team you lead is not on this brokerage" }
  const { data: members, error: mErr } = await svc.from("team_members").select("agent_id").eq("team_id", led.teamId).eq("brokerage_id", ctx.brokerageId).eq("is_active", true)
  if (mErr) return { ok: false, error: mErr.message }
  return { ok: true, teamId: led.teamId, agentIds: (members ?? []).map((m: { agent_id: string | null }) => m.agent_id).filter((x): x is string => !!x) }
}

function buildGetTeamBoardTool(ctx: UserTypeSeatContext) {
  return tool({
    description: "Your team's board: each active member's YTD production (GCI, transactions), open deals and lead counts by lifecycle state — the team you lead only, never another team's and never the brokerage's books.",
    inputSchema: z.object({}),
    execute: async () => {
      const svc = createServiceClient()
      const team = await ledTeam(svc, ctx)
      if (!team.ok) return { success: false, error: team.error }
      if (team.agentIds.length === 0) return { success: true, teamId: team.teamId, members: [], note: "No active members on the team yet" }
      const [a, t, l] = await Promise.all([
        svc.from("agents").select("id, user_id, ytd_gci, ytd_transactions, is_active, career_tier").in("id", team.agentIds).eq("brokerage_id", ctx.brokerageId),
        svc.from("transactions").select("id, agent_id, status, stage, close_date").in("agent_id", team.agentIds).eq("brokerage_id", ctx.brokerageId).not("status", "in", "(closed,cancelled,lost)").limit(200),
        svc.from("leads").select("id, agent_id, lifecycle_state").in("agent_id", team.agentIds).eq("brokerage_id", ctx.brokerageId).eq("is_active", true).limit(500),
      ])
      if (a.error) return { success: false, error: a.error.message }
      if (t.error) return { success: false, error: t.error.message }
      if (l.error) return { success: false, error: l.error.message }
      const userIds = (a.data ?? []).map((r: { user_id: string | null }) => r.user_id).filter((x): x is string => !!x)
      const { data: users } = userIds.length ? await svc.from("users").select("id, first_name, last_name").in("id", userIds) : { data: [] as Array<{ id: string; first_name: string | null; last_name: string | null }> }
      const nameByUser = new Map((users ?? []).map((u: { id: string; first_name: string | null; last_name: string | null }) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(" ")]))
      const members = (a.data ?? []).map((ag: Record<string, unknown>) => {
        const openDeals = (t.data ?? []).filter((d: { agent_id: string | null }) => d.agent_id === ag.id)
        const leads = (l.data ?? []).filter((d: { agent_id: string | null }) => d.agent_id === ag.id)
        const leadsByState: Record<string, number> = {}
        for (const ld of leads) leadsByState[(ld as { lifecycle_state: string | null }).lifecycle_state ?? "unknown"] = (leadsByState[(ld as { lifecycle_state: string | null }).lifecycle_state ?? "unknown"] ?? 0) + 1
        return {
          agentId: ag.id,
          name: nameByUser.get(ag.user_id as string) || "(no name on file)",
          careerTier: ag.career_tier ?? null,
          ytdGci: ag.ytd_gci ?? null,
          ytdTransactions: ag.ytd_transactions ?? null,
          openDeals: openDeals.length,
          activeLeads: leads.length,
          leadsByState,
        }
      })
      return { success: true, teamId: team.teamId, members }
    },
  })
}

function buildGetTeamAssignmentRulesTool(ctx: UserTypeSeatContext) {
  return tool({
    description: "The lead-assignment rules routing to your team (name, type, priority, active, conditions, times triggered) — your team's rules only.",
    inputSchema: z.object({}),
    execute: async () => {
      const svc = createServiceClient()
      const team = await ledTeam(svc, ctx)
      if (!team.ok) return { success: false, error: team.error }
      const { data, error } = await svc.from("assignment_rules")
        .select("id, name, description, rule_type, priority, is_active, conditions, agent_ids, times_triggered, updated_at")
        .eq("brokerage_id", ctx.brokerageId).eq("team_id", team.teamId)
        .order("priority", { ascending: true }).limit(30)
      if (error) return { success: false, error: error.message }
      return { success: true, teamId: team.teamId, rules: data ?? [] }
    },
  })
}

function buildGetAgentCoachingBriefTool(ctx: UserTypeSeatContext) {
  return tool({
    description: "A weekly coaching brief for ONE agent on your team (agent id from get_team_board): outcome stats and the composed coaching points. Refuses an agent who is not on the team you lead.",
    inputSchema: z.object({ agent_id: z.string().describe("agents.id from get_team_board") }),
    execute: async ({ agent_id }: { agent_id: string }) => {
      const svc = createServiceClient()
      const team = await ledTeam(svc, ctx)
      if (!team.ok) return { success: false, error: team.error }
      if (!team.agentIds.includes(agent_id)) return { success: false, error: "That agent is not on the team you lead" }
      // Survivor: lib/kernel/agent-coaching.ts::getAgentWeeklyReport (the real
      // outcome stats, the SAME brief the coaching dashboard renders).
      const { getAgentWeeklyReport } = await import("@/lib/kernel/agent-coaching")
      const report = await getAgentWeeklyReport(agent_id, {}, svc)
      if (!report) return { success: false, error: "No coaching data for that agent yet" }
      return { success: true, report }
    },
  })
}

// ─── BROKER / ADMIN SEAT ────────────────────────────────────────────────────

function buildGetSetupReadinessTool(_ctx: UserTypeSeatContext) {
  return tool({
    description: "What is and isn't set up for this brokerage to run autonomously — the SAME readiness the setup checklist shows (blocking items first).",
    inputSchema: z.object({}),
    execute: async () => {
      // Survivor: app/actions/setup-readiness.ts::getMySetupReadiness — reads
      // the SESSION's own brokerage, never an argument.
      const { getMySetupReadiness } = await import("@/app/actions/setup-readiness")
      const readiness = await getMySetupReadiness()
      if (!readiness) return { success: false, error: "Setup readiness could not be resolved for your account" }
      return { success: true, readiness }
    },
  })
}

function buildGetBillingSummaryTool(ctx: UserTypeSeatContext) {
  return tool({
    description: "READ-ONLY billing summary for this brokerage: subscription status, tier, current period, trial end, cancellation, and the active agent seat count. Changes are made in Billing, never here.",
    inputSchema: z.object({}),
    execute: async () => {
      const svc = createServiceClient()
      const [s, a] = await Promise.all([
        svc.from("subscriptions").select("id, status, tier_id, current_period_start, current_period_end, trial_end, cancel_at, cancelled_at, updated_at").eq("brokerage_id", ctx.brokerageId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
        svc.from("agents").select("id", { count: "exact", head: true }).eq("brokerage_id", ctx.brokerageId).eq("is_active", true),
      ])
      if (s.error) return { success: false, error: s.error.message }
      if (a.error) return { success: false, error: a.error.message }
      return { success: true, subscription: s.data ?? null, activeAgentSeats: a.count ?? 0, note: "Read-only — seat, plan and payment changes are made in Billing." }
    },
  })
}

function buildGetComplianceSummaryTool(ctx: UserTypeSeatContext) {
  return tool({
    description: "Open compliance flags for this brokerage by severity and violation type, plus what's waiting for approval — counts and the most recent open items.",
    inputSchema: z.object({}),
    execute: async () => {
      const svc = createServiceClient()
      const [f, p] = await Promise.all([
        svc.from("compliance_flags").select("id, violation_type, severity, status, content_type, created_at").eq("brokerage_id", ctx.brokerageId).neq("status", "resolved").order("created_at", { ascending: false }).limit(200),
        svc.from("approval_items").select("id, item_type, status, submitted_at", { count: "exact" }).eq("brokerage_id", ctx.brokerageId).eq("status", "pending").order("submitted_at", { ascending: true }).limit(20),
      ])
      if (f.error) return { success: false, error: f.error.message }
      if (p.error) return { success: false, error: p.error.message }
      const bySeverity: Record<string, number> = {}
      const byType: Record<string, number> = {}
      for (const row of f.data ?? []) {
        bySeverity[(row as { severity: string | null }).severity ?? "unknown"] = (bySeverity[(row as { severity: string | null }).severity ?? "unknown"] ?? 0) + 1
        byType[(row as { violation_type: string | null }).violation_type ?? "unknown"] = (byType[(row as { violation_type: string | null }).violation_type ?? "unknown"] ?? 0) + 1
      }
      return { success: true, openFlags: (f.data ?? []).length, bySeverity, byType, recentOpen: (f.data ?? []).slice(0, 10), pendingApprovals: p.count ?? 0, oldestPending: p.data ?? [] }
    },
  })
}

// ─── REGISTRY + ASSEMBLY ────────────────────────────────────────────────────

type VendorBuilder = (ctx: UserTypeSeatContext & { vendorId: string }) => unknown
type SeatBuilder = (ctx: UserTypeSeatContext) => unknown

/** Builders that need a resolved vendors.id (vendor + lender seats). */
const VENDOR_KEYED_BUILDERS: Record<string, VendorBuilder> = {
  get_my_vendor_status: buildGetMyVendorStatusTool,
  get_my_jobs_and_bookings: buildGetMyJobsAndBookingsTool,
  get_my_documents: buildGetMyDocumentsTool,
  get_my_ratings: buildGetMyRatingsTool,
  respond_to_booking: buildRespondToBookingTool,
  update_my_service_area: buildUpdateMyServiceAreaTool,
  update_my_availability: buildUpdateMyAvailabilityTool,
  send_vendor_message_to_agent: buildSendVendorMessageToAgentTool,
  get_my_loan_pipeline: buildGetMyLoanPipelineTool,
  update_loan_status: buildUpdateLoanStatusTool,
  flag_loan_issue: buildFlagLoanIssueTool,
  list_transaction_documents: buildListTransactionDocumentsTool,
  send_lender_message_to_agent: buildSendLenderMessageToAgentTool,
}

/** Builders that need a title membership (title seat). */
const TITLE_KEYED_BUILDERS: Record<string, SeatBuilder> = {
  get_my_title_transactions: buildGetMyTitleTransactionsTool,
  update_title_status: buildUpdateTitleStatusTool,
  send_title_message_to_agent: buildSendTitleMessageToAgentTool,
}

/** Builders keyed on the session's users.id / brokerage only (staff-side seats). */
const STAFF_SIDE_BUILDERS: Record<string, SeatBuilder> = {
  get_team_board: buildGetTeamBoardTool,
  get_team_assignment_rules: buildGetTeamAssignmentRulesTool,
  get_agent_coaching_brief: buildGetAgentCoachingBriefTool,
  get_setup_readiness: buildGetSetupReadinessTool,
  get_billing_summary: buildGetBillingSummaryTool,
  get_compliance_summary: buildGetComplianceSummaryTool,
}

/** THE registry — every seat tool name the policy table may promise. The
 *  proof (scripts/user-type-tool-surfaces-guard.ts) asserts
 *  USER_TYPE_SEAT_TOOL_NAMES ⊆ Object.keys(USER_TYPE_SEAT_TOOL_BUILDERS). */
export const USER_TYPE_SEAT_TOOL_BUILDERS: Readonly<Record<string, VendorBuilder | SeatBuilder>> = {
  ...VENDOR_KEYED_BUILDERS,
  ...TITLE_KEYED_BUILDERS,
  ...STAFF_SIDE_BUILDERS,
}

/**
 * Builds the seat tools the policy names for `ctx.seat`, FAILING CLOSED on a
 * missing identity: a vendor-keyed tool never mounts without ctx.vendorId, a
 * title-keyed tool never mounts without a title membership. Pure over the
 * context (no I/O at build time — every read happens inside execute).
 */
export function buildUserTypeSeatTools(ctx: UserTypeSeatContext): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const name of USER_TYPE_TOOL_POLICY[ctx.seat].seatToolNames) {
    if (name in VENDOR_KEYED_BUILDERS) {
      if (!ctx.vendorId) continue // fail closed — no vendor identity, no vendor tool
      out[name] = VENDOR_KEYED_BUILDERS[name]({ ...ctx, vendorId: ctx.vendorId })
    } else if (name in TITLE_KEYED_BUILDERS) {
      if (ctx.titleMemberships.length === 0) continue // fail closed
      out[name] = TITLE_KEYED_BUILDERS[name](ctx)
    } else if (name in STAFF_SIDE_BUILDERS) {
      out[name] = STAFF_SIDE_BUILDERS[name](ctx)
    }
    // A policy name with no builder is deliberately NOT mounted — the proof
    // catches it as a phantom promise rather than a live call discovering it.
  }
  return out
}
