/**
 * lib/finance/invoice-draft.ts
 *
 * ★ THE INVOICE DRAFTER ★ — MOVED here from
 * app/actions/ai-financial-management.ts::generateInvoice (see the tombstone there).
 * Same name, same job; what changed is that it no longer assumes a session, and it
 * takes the db client and the tenant from whoever calls it.
 *
 * ── WHY THIS FILE EXISTS (researched 2026-08-26, owner ruling: "idor shapes need
 *    to include them but that is a researched call for business reason") ────────
 *
 * `generateInvoice` was flagged as an IDOR because it is a `"use server"` export
 * whose params carry `brokerageId`. Reading it settled two things, both surprising:
 *
 *   1. `params.brokerageId` WAS INERT. It appeared exactly once in the whole
 *      function — in the type. Nothing read it. So the flagged parameter governed
 *      no row, granted no access and could not be exploited: it was an ORPHAN
 *      argument, not an IDOR. §1 says the answer to a missing half is to BUILD it,
 *      not to delete the half that exists — the tenant is genuinely needed here,
 *      it simply was never used. It is load-bearing now: it scopes the `documents`
 *      update below and it books the AI spend.
 *
 *   2. THE WORKFLOW PATH WAS SILENTLY DEAD. The action built its own cookie
 *      (RLS) client with `createClient()`, but its only in-tree caller is
 *      lib/workflow/adapters/draft-document.ts, which runs inside the CRON step
 *      executor — where there is no session at all. `documents` RLS is
 *      `brokerage_id = current_user_brokerage_id()`, which is NULL there, so the
 *      update matched nothing; the call was a bare `await` with no error binding,
 *      and supabase-js RESOLVES a refusal, so `generateInvoice` returned
 *      `{ success: true }` over a document it had not written. Every AI-drafted
 *      invoice in a sequence has been a no-op that reported success.
 *
 * ── THE TWO AUTHORITIES, AND WHY NEITHER IS A BODY PARAMETER ──────────────────
 *
 *   · WORKFLOW (no session): the adapter passes `ctx.supabase` — the service
 *     client the step executor built — and `ctx.brokerageId`, which
 *     lib/campaign-sequences/step-executor.ts:77 reads from
 *     `enrollment.brokerage_id`. That is SERVER-RESOLVED from the row that owns
 *     the job. A workflow step is not a browsing user, and the tenant of a cron
 *     job is the tenant of its enrollment; there is no request body anywhere in
 *     that path for a caller to lie in. This is trustworthy, it is recorded here
 *     so the next audit does not re-flag it, and it is NOT the IDOR shape §4
 *     forbids — §4 forbids taking the tenant from a REQUEST, and this is a row.
 *
 *   · BROWSER (session): there is no such caller today, and the old public
 *     `"use server"` export that pretended to be one is gone — it had no UI behind
 *     it and, being session-bound, could never serve the workflow caller it was
 *     actually written for. When a UI does want to draft an invoice it adds an
 *     action that gates through
 *     lib/platform/acting-context.ts:resolveWriteContextForTenant — which verifies
 *     the caller's claimed brokerageId against the session and hands back both the
 *     session's tenant and the client to write through — and passes those two
 *     values here. Nothing about this module needs to change for that.
 *
 * Callers must therefore have already established their tenant. This module does
 * not resolve one and deliberately has no way to: `brokerageId` is required, and
 * every write is scoped by it, because `db` here may be a service client.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { generateTextRouted as generateText } from "@/lib/ai/models"

export interface InvoiceDraftParams {
  /** The tenant, already established by the caller. Never a request body value. */
  brokerageId: string
  contactId?: string | null
  agentUserId?: string | null
  transactionId?: string | null
  documentId?: string | null
  /** Optional pre-filled line items; AI suggests if omitted */
  lineItems?: Array<{ description: string; quantity: number; unitPrice: number }>
  /** Free-form description of what the invoice is for (used for AI generation) */
  invoicePurpose?: string
}

export interface InvoiceDraftResult {
  success: boolean
  documentId?: string
  invoiceTotal?: number
  error?: string
}

/**
 * Drafts invoice line items + memo and writes them onto an existing `documents`
 * row. `db` is the client to write THROUGH: the caller's RLS client for a session
 * request, the executor's service client for a workflow step.
 */
export async function generateInvoice(
  db: SupabaseClient,
  params: InvoiceDraftParams,
): Promise<InvoiceDraftResult> {
  try {
    if (!params.brokerageId) {
      return { success: false, error: "Invoice draft requires a tenant" }
    }

    // Fetch context for the AI to draft against. Both reads carry the tenant
    // predicate: `db` may be a service client, which RLS does not confine (§4
    // gate-then-service — the caller gated, this scopes).
    let contactName = "Client"
    let agentName = "Agent"
    if (params.contactId) {
      const { data: c } = await db
        .from("contacts")
        .select("first_name, last_name")
        .eq("id", params.contactId)
        .eq("brokerage_id", params.brokerageId)
        .maybeSingle()
      if (c) contactName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Client"
    }
    if (params.agentUserId) {
      const { data: u } = await db
        .from("users")
        .select("first_name, last_name")
        .eq("id", params.agentUserId)
        .eq("brokerage_id", params.brokerageId)
        .maybeSingle()
      if (u) agentName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Agent"
    }

    // AI drafts line items if none provided.
    // THE SPEND IS BOOKED. Both generateText calls here passed `feature` and
    // messages and NO brokerageId — and lib/ai/models.ts writes an ai_tool_usage
    // row only `if (request.brokerageId)`. So every invoice draft was AI spend
    // that reached no ledger, no meter_readings.ai_tokens and no overage
    // projection (§5: a wrong number there is a wrong invoice — literally, here).
    let lineItems = params.lineItems ?? []
    if (lineItems.length === 0) {
      const prompt = `Draft a professional real estate invoice from ${agentName} to ${contactName}.
Purpose: ${params.invoicePurpose ?? "real estate services rendered"}.
Output ONLY a JSON array of line items: [{"description":"string","quantity":number,"unitPrice":number}].
Typical items: consultation fee, listing prep, marketing services, transaction coordination, photography reimbursement, etc.
Suggest 2-4 realistic line items totalling $500-$2500. JSON only, no prose.`

      try {
        const { text } = await generateText({
          feature: "invoice_draft",
          brokerageId: params.brokerageId,
          messages: [{ role: "user", content: prompt }],
        })
        const cleaned = text.replace(/```json|```/g, "").trim()
        const parsed = JSON.parse(cleaned)
        if (Array.isArray(parsed)) {
          lineItems = parsed.filter(
            (i: any) =>
              typeof i?.description === "string" &&
              typeof i?.quantity === "number" &&
              typeof i?.unitPrice === "number",
          )
        }
      } catch { /* keep empty */ }
    }

    const subtotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
    const invoiceTotal = subtotal // tax handling deferred to per-state config

    // AI drafts a payment memo
    let memo = `Invoice from ${agentName} for services rendered.`
    try {
      const memoPrompt = `Write a professional 1-2 sentence invoice memo for an invoice from ${agentName} to ${contactName} for ${params.invoicePurpose ?? "real estate services"}. Total: $${invoiceTotal.toLocaleString()}. Polite, brief, professional.`
      const { text } = await generateText({
        feature: "invoice_memo",
        brokerageId: params.brokerageId,
        messages: [{ role: "user", content: memoPrompt }],
      })
      if (text) memo = text.trim()
    } catch { /* keep default */ }

    const invoiceContent = JSON.stringify(
      {
        from: agentName,
        to: contactName,
        issuedAt: new Date().toISOString(),
        lineItems,
        subtotal,
        total: invoiceTotal,
        memo,
      },
      null,
      2,
    )

    // Update the documents record (created upstream by the draft_document adapter).
    //
    // THREE THINGS THIS WRITE NOW DOES THAT IT DID NOT.
    //  · It is TENANT-SCOPED (`.eq("brokerage_id", …)`): `db` may be a service
    //    client, so nothing else would stop a wrong documentId writing into
    //    another brokerage's file.
    //  · The error is BOUND. It was a bare `await`, and supabase-js resolves a
    //    refusal — which is exactly how the session-less workflow path came to
    //    report success over an RLS-refused write.
    //  · It COUNTS what came back. CLAUDE.md §3: an UPDATE that matches NOTHING
    //    also resolves, with `error: null` and an empty array — byte-identical to
    //    one that worked. Here zero rows IS a failure: the adapter created that
    //    row moments ago, so no match means the id or the tenant is wrong and the
    //    invoice does not exist. Say so instead of returning success.
    if (params.documentId) {
      const { data: updated, error: updErr } = await db
        .from("documents")
        .update({
          content: invoiceContent,
          status: "draft_ready",
          metadata: {
            line_items: lineItems,
            total_cents: Math.round(invoiceTotal * 100),
            memo,
            contact_name: contactName,
            agent_name: agentName,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", params.documentId)
        .eq("brokerage_id", params.brokerageId)
        .select("id")

      if (updErr) {
        return { success: false, error: `Invoice draft not written: ${updErr.message}` }
      }
      if (!updated || updated.length === 0) {
        return {
          success: false,
          error: "Invoice draft not written: document not found in this brokerage",
        }
      }
    }

    return { success: true, documentId: params.documentId ?? undefined, invoiceTotal }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
