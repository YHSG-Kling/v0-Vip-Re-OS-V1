"use server"

/**
 * app/actions/title/closing-appointment.ts — A TITLE PARTNER PROPOSES THE CLOSING APPOINTMENT (wave 147, lane 147H;
 * owner ruling 9: build what said "not available yet").
 *
 * /title/closing/new said "booking an appointment time and place from here is not available yet" — wave 146H routed it
 * as MISSING (no writer). The business rule stands (app/title/closing/new/page.tsx header): the closing DATE is a term
 * of the executed contract, owned by the brokerage's transaction and changed only by amendment — so this door never
 * writes transactions.close_date. What the title company DOES own is the settlement appointment: the time and the
 * place on that date. It PROPOSES them, and the deal's agent confirms with the clients — the proposal lands as the
 * agent's task on the deal (the existing tasks rail every agent surface reads), ledgered (LAW 5:
 * transaction.closing_appointment.propose) with its evidence. A proposed time on ANOTHER day is refused with the
 * reason: that is a date change, an amendment for the transaction coordinator.
 *
 * GATE FIRST (CLAUDE.md §4): the deal is read through the caller's OWN RLS session (public.transactions' SELECT
 * policies admit a vendor party only on an assigned deal), and the caller must hold a TITLE seat — a title-category
 * vendor grant in the deal's brokerage (lib/kernel/lender-linkage.ts vendorSeatsForUser, the ONE user → vendor
 * resolver; title is a VENDOR CATEGORY, never a user type) or a title_company_users row on that deal. Only then the
 * service client writes, pinned to the deal's brokerage.
 */

import { createHash } from "node:crypto"
import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export type ClosingAppointmentState = { ok: boolean; message: string } | null
export interface ClosingAppointmentDeal { id: string; propertyAddress: string | null; closeDate: string }
export interface ClosingAppointmentProposal { id: string; transactionId: string | null; title: string; description: string | null; status: string | null; dueDate: string | null; createdAt: string | null }

const SOURCE = "title_closing_appointment"

type TitleGate = { ok: true; userId: string; seatName: string | null; deal: { id: string; brokerage_id: string; agent_id: string | null; close_date: string | null; property_address: string | null } } | { ok: false; error: string }

async function requireTitlePartyOnDeal(transactionId: string): Promise<TitleGate> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Sign in to propose a closing appointment." }
  const { data: deal, error } = await supabase.from("transactions")
    .select("id, brokerage_id, agent_id, close_date, property_address").eq("id", String(transactionId ?? "")).maybeSingle()
  if (error) return { ok: false, error: `Could not read the deal: ${error.message}` }
  if (!deal) return { ok: false, error: "That deal is not one you are a party to." }
  const d = deal as { id: string; brokerage_id: string; agent_id: string | null; close_date: string | null; property_address: string | null }
  const svc = createServiceClient()
  const { vendorSeatsForUser } = await import("@/lib/kernel/lender-linkage")
  const seats = (await vendorSeatsForUser(svc, user.id)).filter((s) => s.category === "title" && s.brokerageId === d.brokerage_id)
  let seatName = seats[0]?.name ?? null
  if (!seats.length) {
    const { data: tcu, error: tErr } = await svc.from("title_company_users").select("id, company_name").eq("user_id", user.id).eq("transaction_id", d.id).limit(1).maybeSingle()
    if (tErr) return { ok: false, error: `Could not verify your title seat: ${tErr.message}` }
    if (!tcu) return { ok: false, error: "Only the deal's title company can propose its closing appointment." }
    seatName = (tcu as { company_name?: string | null }).company_name ?? null
  }
  return { ok: true, userId: user.id, seatName, deal: d }
}

/** The deals with a closing date the caller can see (their own RLS session) — the form's picker. */
export async function listClosingDealsForTitle(): Promise<{ ok: true; deals: ClosingAppointmentDeal[] } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  // The brokerages this caller is a TITLE party for (a title vendor seat, or a title_company_users row) — the RLS read
  // below is pinned to them as well, so the picker never offers a deal of a tenant the seat does not serve.
  const svc = createServiceClient()
  const { vendorSeatsForUser } = await import("@/lib/kernel/lender-linkage")
  const brokerageIds = new Set((await vendorSeatsForUser(svc, user.id)).filter((s) => s.category === "title").map((s) => s.brokerageId).filter(Boolean) as string[])
  const { data: tcu, error: tErr } = await svc.from("title_company_users").select("brokerage_id").eq("user_id", user.id).limit(50)
  if (tErr) return { ok: false, error: `Could not verify your title seat: ${tErr.message}` }
  for (const r of (tcu ?? []) as Array<{ brokerage_id: string | null }>) if (r.brokerage_id) brokerageIds.add(r.brokerage_id)
  if (brokerageIds.size === 0) return { ok: true, deals: [] }
  const { data, error } = await supabase.from("transactions").select("id, property_address, close_date")
    .in("brokerage_id", [...brokerageIds]).not("close_date", "is", null).gte("close_date", new Date().toISOString().slice(0, 10)).order("close_date", { ascending: true }).limit(50)
  if (error) return { ok: false, error: error.message }
  return { ok: true, deals: ((data ?? []) as Array<{ id: string; property_address: string | null; close_date: string }>).map((r) => ({ id: r.id, propertyAddress: r.property_address, closeDate: r.close_date })) }
}

/** The proposals this caller made (newest first), read back from the agent's task rail. */
export async function listMyClosingAppointmentProposals(): Promise<{ ok: true; proposals: ClosingAppointmentProposal[] } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const { data, error } = await svc.from("tasks").select("id, transaction_id, title, description, status, due_date, created_at")
    .eq("source", SOURCE).contains("tags", [`proposed_by:${user.id}`]).order("created_at", { ascending: false }).limit(25)
  if (error) return { ok: false, error: error.message }
  return { ok: true, proposals: ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({ id: String(r.id), transactionId: (r.transaction_id as string | null) ?? null, title: String(r.title ?? ""), description: (r.description as string | null) ?? null, status: (r.status as string | null) ?? null, dueDate: (r.due_date as string | null) ?? null, createdAt: (r.created_at as string | null) ?? null })) }
}

/** The proposal (useActionState form action on /title/closing/new). */
export async function proposeClosingAppointment(_prev: ClosingAppointmentState, formData: FormData): Promise<ClosingAppointmentState> {
  const transactionId = String(formData.get("transactionId") ?? "")
  const time = String(formData.get("time") ?? "").trim()
  const location = String(formData.get("location") ?? "").trim().slice(0, 300)
  const note = String(formData.get("note") ?? "").trim().slice(0, 600)
  if (!transactionId) return { ok: false, message: "Choose the deal." }
  if (!/^\d{2}:\d{2}$/.test(time)) return { ok: false, message: "Give the appointment time." }
  if (!location) return { ok: false, message: "Give the place (office address, or 'mobile signing at …')." }

  const gate = await requireTitlePartyOnDeal(transactionId)
  if (!gate.ok) return { ok: false, message: gate.error }
  if (!gate.deal.close_date) return { ok: false, message: "This deal has no closing date on the contract yet — the transaction coordinator sets it first." }
  if (!gate.deal.agent_id) return { ok: false, message: "This deal has no agent attached to confirm with the clients — ask the brokerage to assign one." }
  const date = String(formData.get("date") ?? gate.deal.close_date).slice(0, 10)
  if (date !== gate.deal.close_date.slice(0, 10)) {
    return { ok: false, message: `The contract closes on ${gate.deal.close_date.slice(0, 10)}. A different day is a date change — an amendment the deal's transaction coordinator handles, not an appointment.` }
  }

  const svc = createServiceClient()
  const who = gate.seatName ?? "The title company"
  const where = gate.deal.property_address ?? "the property"
  const fingerprint = createHash("sha256").update(`${date}T${time}|${location.toLowerCase()}`).digest("hex").slice(0, 16)
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const r = await withActionLedger<{ ok: boolean; message: string; taskId?: string | null }>(
    {
      brokerageId: gate.deal.brokerage_id, action: "transaction.closing_appointment.propose",
      actor: { type: "user", userId: gate.userId },
      subject: { type: "transaction", id: gate.deal.id },
      reasonDetail: `title partner proposed the settlement appointment ${date} ${time} at ${location}`.slice(0, 400),
      idempotencyKey: `closing_appt:${gate.deal.id}:${fingerprint}`, riskClass: "LOW_RISK_WRITE", channel: "title_portal",
      detail: { date, time, location, close_date: gate.deal.close_date, proposed_by_seat: who },
    },
    async () => {
      const { data, error } = await svc.from("tasks").insert({
        brokerage_id: gate.deal.brokerage_id, transaction_id: gate.deal.id, assigned_to_agent_id: gate.deal.agent_id, assignee_type: "agent",
        title: `Confirm the closing appointment ${who} proposed — ${date} ${time}`.slice(0, 250),
        description: `${who} proposes the settlement appointment for ${where}: ${date} at ${time}, ${location}.${note ? ` Note: ${note}` : ""} The closing date itself is unchanged (it is a contract term). Confirm the time with your clients and the other side, then reply to the title company.`.slice(0, 2000),
        due_date: date, priority: "high", status: "pending", source: SOURCE, auto_generated: false,
        tags: [SOURCE, `proposed_by:${gate.userId}`], created_at: new Date().toISOString(),
      }).select("id").single()
      if (error || !data) return { ok: false, message: `The proposal could not be recorded: ${error?.message ?? "no row"}` }
      try {
        const { emitKernelEvent } = await import("@/lib/kernel/emit")
        await emitKernelEvent({ event: "transaction.closing_appointment_proposed", brokerageId: gate.deal.brokerage_id, entityType: "transaction", entityId: gate.deal.id, actorUserId: gate.userId, source: "ui", auditOnly: true, client: svc, metadata: { task_id: (data as { id: string }).id, date, time, location, proposed_by_seat: who } })
      } catch (e) { console.error("[closing-appointment] evidence row failed:", e instanceof Error ? e.message : String(e)) }
      return { ok: true, message: `Sent to the deal's agent to confirm: ${date} at ${time}, ${location}.`, taskId: (data as { id: string }).id }
    },
    {
      settle: (x) => ({ status: x.ok ? "executed" : "failed", outcome: x.ok ? "proposed" : "not_proposed", providerRef: x.taskId ?? null, error: x.ok ? null : x.message }),
      replay: (claim) => (claim.kind === "refused" ? { ok: false, message: `Not sent — the proposal could not be recorded (${claim.error}).` } : { ok: true, message: "That exact proposal was already sent to the deal's agent." }),
    },
    { client: svc },
  )
  if (r.ok) revalidatePath("/title/closing/new")
  return { ok: r.ok, message: r.message }
}
