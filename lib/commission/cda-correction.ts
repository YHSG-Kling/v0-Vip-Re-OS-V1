// lib/commission/cda-correction.ts — THE CDA CORRECTION PATH (wave 145, lane 145C; owner ruling 8, 2026-10-27).
//
// Owner, verbatim: "There can be executed addendums after the transaction has been created which can change a term/price etc."
// → new executed addendum · effective date · modified terms · affected financial obligations · revised authoritative contract
// terms · broker/TC notification · compliance re-review · settlement reconciliation · CDA CORRECTION.
//
// SURVIVOR (CLAUDE.md §1): the CDA workflow of app/actions/cda-portal.ts — closing_disclosure_agreement (status, revision_number,
// changes_requested_*, agent sign-off) + its audit log closing_disclosure_agreement_revisions (every state change of a money
// instruction). Its only send-back door, requestCdaChangesAction, works from 'submitted' only and is a compliance officer's
// review act; nothing could re-open an APPROVED (broker-signed, possibly delivered to title) CDA when the contract it
// authorises changed — the CDA kept instructing title to disburse on superseded terms. This is that path, on the same rows and
// the same vocabulary (status 'changes_requested', revision action 'changes_requested' — the live CHECKs, no new member):
//   · submitted | approved      → re-opened: changes_requested, agent sign-off cleared, revision +1, the reason names the
//                                  executed change; an approved CDA already sent to title is flagged "re-send the corrected CDA —
//                                  the earlier instruction is superseded" (sent_to_title_* is kept as the record of what went);
//   · pending | drafting | changes_requested | awaiting_preliminary_cd → nothing to re-open: the agent is told the draft must
//                                  reflect the change;
//   · closed (closed_at set)    → NOT re-opened: money may have moved; a finance admin corrects through the ledger correction
//                                  path (lib/kernel/financial.ts correctCommissionDistribution), told by name;
//   · cancelled | rejected      → nothing.
// The signed CDA PDF and every earlier revision row are never edited. Ledgered (LAW 5); notifications to the agent and the
// brokerage's admins.

type Db = { from: (t: string) => any }

export const CDA_REOPENABLE_STATUSES = ["submitted", "approved"] as const
const CDA_DRAFT_STATUSES = new Set(["pending", "drafting", "changes_requested", "awaiting_preliminary_cd"])

export type CdaCorrectionOutcome = "reopened" | "draft_notified" | "closed_needs_ledger_correction" | "no_cda" | "nothing_to_correct"

export interface CdaCorrectionResult {
  outcome: CdaCorrectionOutcome
  cdaId: string | null
  /** The CDA had already been delivered to the closing agent — the corrected one must be re-sent. */
  resendToTitle: boolean
  detail: string
}

/**
 * Re-open the deal's CDA for correction after an executed change (or a human's correction request). `actedBy` is the users.id
 * the revision row records (the person who recorded the executed change, or requested the correction). Tenant-pinned; every
 * read's error is read; the status move is compare-and-swap on the status it was read in and COUNTED.
 */
export async function reopenCdaForCorrection(
  db: Db,
  input: { brokerageId: string; transactionId: string; reason: string; actedBy: string; source: "contract_addendum" | "manual" },
): Promise<{ ok: true; result: CdaCorrectionResult } | { ok: false; error: string }> {
  if (!input.brokerageId) return { ok: false, error: "no_tenant" }
  const reason = String(input.reason ?? "").trim()
  if (reason.length < 5) return { ok: false, error: "reason_required: say what changed and where the executed evidence is" }
  const { data, error } = await db
    .from("closing_disclosure_agreement")
    .select("id, status, revision_number, agent_id, sent_to_title_at, closed_at, transaction_id")
    .eq("brokerage_id", input.brokerageId)
    .eq("transaction_id", input.transactionId)
    .order("updated_at", { ascending: false })
    .limit(1)
  if (error) return { ok: false, error: `cda_read_refused: ${error.message}` }
  const cda = ((data ?? [])[0] ?? null) as { id: string; status: string; revision_number: number | null; agent_id: string | null; sent_to_title_at: string | null; closed_at: string | null } | null
  if (!cda) return { ok: true, result: { outcome: "no_cda", cdaId: null, resendToTitle: false, detail: "no CDA exists for this transaction yet — the CDA will be drafted on the governing terms" } }

  const notify = async (title: string, body: string) => {
    try {
      if (cda.agent_id) {
        const { data: ag } = await db.from("agents").select("user_id").eq("id", cda.agent_id).eq("brokerage_id", input.brokerageId).maybeSingle()
        const uid = (ag as { user_id?: string | null } | null)?.user_id
        if (uid) {
          const { error: nErr } = await db.from("notifications").insert({ user_id: uid, brokerage_id: input.brokerageId, type: "cda_correction_required", title: title.slice(0, 200), body: body.slice(0, 480), entity_type: "transaction", entity_id: input.transactionId, priority: "high", channel: "in_app", is_read: false })
          if (nErr) console.error("[cda-correction] agent notice not written:", nErr.message)
        }
      }
      const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
      await notifyBrokerageAdmins(db as never, input.brokerageId, { type: "cda_correction_required", title, body, entityType: "transaction", entityId: input.transactionId, priority: "high" })
    } catch (e) {
      console.error("[cda-correction] notice failed:", e instanceof Error ? e.message : String(e))
    }
  }

  if (cda.closed_at) {
    const detail = `the CDA file is closed (${cda.closed_at.slice(0, 10)}) — it is not re-opened; a finance admin corrects the posted commission through the ledger correction path. ${reason}`
    await notify("Executed change after the CDA closed — ledger correction needed", detail)
    return { ok: true, result: { outcome: "closed_needs_ledger_correction", cdaId: cda.id, resendToTitle: false, detail } }
  }
  if (CDA_DRAFT_STATUSES.has(cda.status)) {
    const detail = `the CDA is still a draft (${cda.status}) — it must reflect the change before it is submitted. ${reason}`
    await notify("Update the CDA draft for an executed change", detail)
    return { ok: true, result: { outcome: "draft_notified", cdaId: cda.id, resendToTitle: false, detail } }
  }
  if (!(CDA_REOPENABLE_STATUSES as readonly string[]).includes(cda.status)) {
    return { ok: true, result: { outcome: "nothing_to_correct", cdaId: cda.id, resendToTitle: false, detail: `the CDA is ${cda.status} — nothing to correct` } }
  }

  const resendToTitle = !!cda.sent_to_title_at
  const now = new Date().toISOString()
  const nextRevision = (cda.revision_number ?? 1) + 1
  const notes = `${input.source === "contract_addendum" ? "Executed contract change" : "Correction requested"}: ${reason}${resendToTitle ? " — the CDA already delivered to the closing agent is superseded; the corrected CDA must be re-sent." : ""}`
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  let moved = false
  const res = await withActionLedger<{ ok: boolean; error?: string }>(
    {
      brokerageId: input.brokerageId,
      action: "finance.cda.correction_reopened",
      actor: { type: "user", userId: input.actedBy, agentId: null },
      subject: { type: "closing_disclosure_agreement", id: cda.id, ref: input.transactionId },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: notes.slice(0, 500),
      riskClass: "FINANCIAL",
      systemSource: "cda_correction",
      detail: { cda_id: cda.id, from_status: cda.status, revision_from: cda.revision_number, revision_to: nextRevision, resend_to_title: resendToTitle, source: input.source },
    },
    async () => {
      const { data: upd, error: uErr } = await db
        .from("closing_disclosure_agreement")
        .update({
          status: "changes_requested", changes_requested_at: now, changes_requested_by: input.actedBy, changes_requested_notes: notes.slice(0, 2000),
          agent_signed_off_at: null, agent_signed_off_by: null, revision_number: nextRevision, updated_at: now,
        })
        .eq("id", cda.id)
        .eq("brokerage_id", input.brokerageId)
        .eq("status", cda.status)
        .select("id")
      if (uErr) return { ok: false, error: `cda_reopen_refused: ${uErr.message}` }
      if (((upd ?? []) as unknown[]).length !== 1) return { ok: false, error: "cda_changed: the CDA moved under you — re-read it" }
      moved = true
      const { error: rErr } = await db.from("closing_disclosure_agreement_revisions").insert({
        cda_id: cda.id, revision_number: cda.revision_number ?? 1, status_at_snapshot: "changes_requested", action: "changes_requested",
        notes: input.source === "contract_addendum" ? "re-opened for an executed contract change" : "re-opened for correction", changes_requested_notes: notes.slice(0, 2000), acted_by: input.actedBy,
      })
      if (rErr) console.error("[cda-correction] revision audit row NOT written:", rErr.message)
      return { ok: true }
    },
    {
      settle: (r) => (r.ok ? { status: "executed", outcome: "recorded" } : { status: "failed", outcome: "refused", error: r.error ?? null }),
      replay: (claim) => ({ ok: false, error: `already ${claim.kind === "in_flight" ? "in flight" : "recorded"}` }),
    },
    { client: db as never },
  )
  if (!res.ok || !moved) return { ok: false, error: res.error ?? "cda_not_reopened" }
  await notify(resendToTitle ? "Corrected CDA required — re-send to the closing agent" : "CDA re-opened for correction", notes)
  return { ok: true, result: { outcome: "reopened", cdaId: cda.id, resendToTitle, detail: notes } }
}
