"use server"

/**
 * Brokerage CDA setup — onboarding flag + template library.
 *
 * Some brokerages offer Commission Disbursement Authorizations (CDAs) and
 * some don't. This is a per-brokerage toggle captured during onboarding:
 *
 *   • offers_cda = true  → broker uploads CDA template PDFs (per state /
 *                          transaction type) so agents can pick the right
 *                          one when filling out a CDA at closing
 *   • offers_cda = false → set non_cda_payout_default; agents specify
 *                          per-transaction whether they want direct deposit
 *                          or a check
 *
 * This file is the canonical place to read/write that setup. The CDA
 * runtime workflow (cda-portal.ts) reads brokerages.offers_cda + picks
 * the right template_id at draft time.
 *
 * Tables used:
 *   brokerages (offers_cda, cda_onboarding_at, non_cda_payout_default)
 *   brokerage_cda_templates (the uploaded form library)
 *   tenant_policy_versions (policy key `cda_policy` — the history of the setting, through the ONE appender)
 *   closing_disclosure_agreement.field_values.cda_mode_switch (a finance admin's switch of ONE in-progress deal)
 *
 * No new tables introduced here.
 *
 * WAVE 152 (lane 152H; owner: "if a brokerage changes their policy from a no cda to now using cda can turn the setting to opt in").
 * The setting can be changed either way after onboarding — by the brokerage's finance admin acting for the WHOLE brokerage (in a
 * multi-office brokerage, the organization's leadership — the same composition the subscription signatory rule uses), with a reason,
 * ledgered (`finance.cda_policy.set`) and versioned (`cda_policy`, effective at the save instant). Deals already in progress keep the
 * policy they opened under; a closed deal is never given a CDA (lib/transactions/cda-closing-policy.ts §1c — the treatment matrix).
 * A finance admin may switch ONE in-progress deal (`switchDealCdaModeAction`, ledgered `transaction.cda_mode.switch`); switching to a
 * CDA opens the deal's CDA for the AGENT to fill — nothing here fills, generates or signs one.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { resolveSessionActor } from "@/lib/agreements/session-actor"
import { resolveViewerHierarchy } from "@/lib/kernel/resolve-user-office"
import {
  CDA_POLICY_KEY,
  cdaPolicyValue,
  decideCdaPolicyChange,
  decideDealCdaSwitch,
  loadEffectiveCdaModes,
  resolvePayoutTiming,
} from "@/lib/transactions/cda-closing-policy"
import { revalidatePath } from "next/cache"

// BROKERAGE-WIDE MONEY (m472). "CDA storage" is named in the owner's ruling among
// the financial gates team_lead is held out of, and this file writes
// public.brokerages (offers_cda / cda_onboarding_at / non_cda_payout_default) —
// a FINANCE table whose UPDATE policy is now is_brokerage_finance_admin(). A gate
// on the widened roster here would admit a team lead the database then refuses,
// and supabase-js resolves that refusal as zero rows with `error: null`.
//
// The ONE shared roster replaces the local literal. It adds broker_owner, whom
// the literal refused from their own brokerage's CDA setup, and drops
// 'superadmin', which is MEASURED dead as a user_type (zero live rows; the
// platform's one superadmin is user_type='admin' with platform_role='superadmin').
const isCdaSetupAdmin = (userType: string) => isBrokerageFinanceAdmin({ user_type: userType })

// ─── The brokerage's CDA policy (onboarding answer, later changes either way) + payout default ─────────

/** Deal statuses that are no longer in progress — a policy change never touches them. */
const COMPLETED_DEAL_STATUSES = ["closed", "funded", "lost", "archived"]

type PolicyAdmin = { userId: string; agentId: string | null; brokerageId: string }

/**
 * THE GATE for a brokerage-wide money policy: the session's finance admin (the books roster or the tenant principal — the same
 * predicate the payout policy uses), acting with the WHOLE brokerage in scope. In a multi-office brokerage that is the organization's
 * leadership; an office or team admin is refused (lib/kernel/resolve-user-office.ts resolveViewerHierarchy — the composition
 * lib/legal/subscription-agreement.ts assessSignatoryAuthority applies to signing). FAILS CLOSED on an unreadable scope.
 */
async function requireCdaPolicyAdmin(svc: ReturnType<typeof createServiceClient>): Promise<{ ok: true; admin: PolicyAdmin } | { ok: false; error: string }> {
  const s = await resolveSessionActor()
  if (!s.ok) return { ok: false, error: s.error === "unauthenticated" ? "You're signed out. Sign in again to change the CDA policy." : "Your role couldn't be confirmed, so nothing was changed. Try again; if it keeps happening, contact platform support." }
  if (!isBrokerageFinanceAdmin({ user_type: s.actor.userType, is_tenant_principal: s.actor.isTenantPrincipal })) {
    return { ok: false, error: "Only an admin who keeps the brokerage's books (a broker, broker owner, brokerage admin or admin) can change the CDA policy. Nothing was changed — ask one of them." }
  }
  const h = await resolveViewerHierarchy(svc as never, { userId: s.actor.userId, brokerageId: s.actor.brokerageId })
  if (!h.ok) {
    console.error(`[brokerage-cda-setup] scope unreadable for ${s.actor.userId}: ${h.error}`)
    return { ok: false, error: "Your brokerage's offices couldn't be read, so the CDA policy wasn't changed. Try again; if it keeps happening, contact platform support." }
  }
  if (!(h.scope.kind === "tenant" && h.scope.aggregate)) {
    return { ok: false, error: "In a brokerage with several offices, only the brokerage's leadership changes the CDA policy — an office or team admin can't. Nothing was changed; ask your brokerage's leadership." }
  }
  return { ok: true, admin: { userId: s.actor.userId, agentId: s.actor.agentId ?? null, brokerageId: s.actor.brokerageId } }
}

/** The tenant's deals still in progress (ids), for the impact count and the settings list. */
async function openDealIds(svc: ReturnType<typeof createServiceClient>, brokerageId: string): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const { data, error } = await svc
    .from("transactions")
    .select("id, status")
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .limit(500)
  if (error) return { ok: false, error: error.message }
  return { ok: true, ids: ((data ?? []) as Array<{ id: string; status: string | null }>).filter((t) => !COMPLETED_DEAL_STATUSES.includes(String(t.status ?? "").toLowerCase())).map((t) => t.id) }
}

/**
 * Set (or change) whether the brokerage uses a CDA. Effective at the save instant; deals already in progress keep the policy they opened
 * under and a closed deal is never given a CDA (cda-closing-policy.ts §1c). Ledgered and versioned — if the version cannot be recorded the
 * change is rolled back, because without its effective time every in-progress deal would be re-moded.
 */
export async function setBrokerageCdaSettingAction(input: {
  offersCda:             boolean
  nonCdaPayoutDefault?:  "direct_deposit" | "check" | null
  /** Why the policy is changing — required when the change moves deals between CDA and no CDA. */
  reason?:               string | null
}) {
  if (typeof input?.offersCda !== "boolean") return { success: false as const, error: "Choose whether your brokerage uses a CDA." }
  const svc = createServiceClient()
  const gate = await requireCdaPolicyAdmin(svc)
  if (!gate.ok) return { success: false as const, error: gate.error }
  const { admin } = gate

  const { data: before, error: readErr } = await svc
    .from("brokerages")
    .select("offers_cda, non_cda_payout_default, cda_onboarding_at, commission_payout_timing")
    .eq("id", admin.brokerageId)
    .maybeSingle()
  if (readErr || !before) {
    console.error(`[brokerage-cda-setup] policy read refused for ${admin.brokerageId}: ${readErr?.message ?? "no row"}`)
    return { success: false as const, error: "Your CDA policy couldn't be read, so nothing was changed. Try again; if it keeps happening, contact platform support." }
  }
  const b = before as { offers_cda: boolean | null; non_cda_payout_default: string | null; cda_onboarding_at: string | null; commission_payout_timing: string | null }
  const open = await openDealIds(svc, admin.brokerageId)
  if (!open.ok) {
    console.error(`[brokerage-cda-setup] open deals unreadable for ${admin.brokerageId}: ${open.error}`)
    return { success: false as const, error: "Your deals in progress couldn't be read, so the CDA policy wasn't changed (their treatment depends on it). Try again shortly." }
  }
  const decision = decideCdaPolicyChange({
    before: { offersCda: b.offers_cda, nonCdaPayoutDefault: b.non_cda_payout_default },
    next: { offersCda: input.offersCda, nonCdaPayoutDefault: input.nonCdaPayoutDefault ?? null },
    reason: input.reason,
    openDeals: open.ids.length,
  })
  if (!decision.ok) return { success: false as const, error: decision.message, code: decision.error }
  if (!decision.changed) return { success: true as const, changed: false, policyVersion: null, effectiveAt: b.cda_onboarding_at, dealsKeepingPriorPolicy: 0, note: null }

  // The update the ONE writer makes — the payout default is null when CDA is offered (direct deposit unless chosen otherwise).
  const patch = {
    offers_cda:             input.offersCda,
    cda_onboarding_at:      new Date().toISOString(),
    non_cda_payout_default: input.offersCda ? null : (input.nonCdaPayoutDefault ?? "direct_deposit"),
    updated_at:             new Date().toISOString(),
  }
  const effectiveAt = patch.cda_onboarding_at
  const previous = cdaPolicyValue(b, b.cda_onboarding_at)
  const value = cdaPolicyValue(patch, effectiveAt)

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const { appendTenantPolicyVersion } = await import("@/lib/kernel/tenant-policy")
  type Outcome = { ok: true; version: number | null } | { ok: false; error: string; rolledBack: boolean }
  const outcome = await withActionLedger<Outcome>(
    {
      brokerageId: admin.brokerageId,
      action: "finance.cda_policy.set",
      actor: { type: "user", userId: admin.userId, agentId: admin.agentId },
      subject: { type: "brokerage", id: admin.brokerageId },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: decision.reason.slice(0, 500),
      riskClass: "FINANCIAL",
      systemSource: CDA_POLICY_KEY,
      policyKey: CDA_POLICY_KEY,
      idempotencyKey: `cda_policy:${admin.brokerageId}:${effectiveAt}`,
      detail: { previous, value, effective_at: effectiveAt, scope: "brokerage", mode_changed: decision.modeChanged, open_deals_keep_prior_policy: decision.modeChanged ? open.ids.length : 0 },
    },
    async () => {
      const { data: updated, error } = await svc.from("brokerages").update(patch).eq("id", admin.brokerageId).select("id")
      if (error) return { ok: false, error: `the setting was not saved (${error.message})`, rolledBack: false }
      if (!updated || updated.length !== 1) return { ok: false, error: "the setting was not saved (no brokerage row matched)", rolledBack: false }
      const v = await appendTenantPolicyVersion(svc, { brokerageId: admin.brokerageId, policyKey: CDA_POLICY_KEY, value, previous, actor: { type: "user", userId: admin.userId, reason: decision.reason } })
      if (v.ok) return { ok: true, version: v.skipped ? null : v.version }
      // The effective time is what keeps in-progress deals on the policy they opened under — without it, put the setting back.
      const { data: restored, error: restoreErr } = await svc
        .from("brokerages")
        .update({ offers_cda: b.offers_cda, non_cda_payout_default: b.non_cda_payout_default, cda_onboarding_at: b.cda_onboarding_at, updated_at: new Date().toISOString() })
        .eq("id", admin.brokerageId)
        .select("id")
      return { ok: false, error: `the change's effective date could not be recorded (${v.error})`, rolledBack: !restoreErr && (restored ?? []).length === 1 }
    },
    {
      settle: (o) => (o.ok ? { status: "executed", outcome: "policy_set" } : { status: "failed", outcome: o.rolledBack ? "rolled_back" : "refused", error: o.error }),
      replay: (claim) => (claim.kind === "refused" ? { ok: false, error: `the action ledger refused: ${claim.error}`, rolledBack: false } : { ok: false, error: "this exact change is already being saved", rolledBack: false }),
    },
    { client: svc as never },
  )
  if (!outcome.ok) {
    console.error(`[brokerage-cda-setup] cda_policy change for ${admin.brokerageId} not saved: ${outcome.error}`)
    return {
      success: false as const,
      error: outcome.rolledBack
        ? "Your CDA policy wasn't changed: the date it takes effect couldn't be recorded, so the setting was put back as it was. Try again; if it keeps happening, contact platform support."
        : "Your CDA policy wasn't changed. Try again; if it keeps happening, contact platform support.",
    }
  }
  const timing = resolvePayoutTiming({ offersCda: input.offersCda, payoutTiming: b.commission_payout_timing })
  revalidatePath("/dashboard/admin")
  return {
    success: true as const,
    changed: true,
    policyVersion: outcome.version,
    effectiveAt,
    dealsKeepingPriorPolicy: decision.modeChanged ? open.ids.length : 0,
    note: timing.finding ? "Your payout setting was \"pay at closing per the CDA\". Without a CDA, agents are paid after the commission is received until you change it in Payouts." : null,
  }
}

/**
 * The CDA setting as it stands, plus — for a finance admin — its recorded history and the in-progress deals whose treatment differs from
 * the current policy (with the reason in plain words). Everyone signed in to the tenant reads the setting itself (unchanged).
 */
export async function getBrokerageCdaSettingAction() {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data, error: settingErr } = await supabase
    .from("brokerages")
    .select("offers_cda, cda_onboarding_at, non_cda_payout_default")
    .eq("id", auth.brokerageId)
    .maybeSingle()
  // An unreadable setting is said, never shown as "not answered" (§3: a refused read resolves with data null).
  if (settingErr) {
    console.error(`[brokerage-cda-setup] CDA setting unreadable for ${auth.brokerageId}: ${settingErr.message}`)
    return { success: false as const, error: "Your CDA setting couldn't be loaded right now. Nothing was changed — reload the page; if it keeps happening, contact platform support." }
  }

  const base = {
    success:        true as const,
    offersCda:      data?.offers_cda ?? null,
    onboardingAt:   data?.cda_onboarding_at ?? null,
    payoutDefault:  data?.non_cda_payout_default ?? null,
  }
  // The history and the deal list (other agents' deals) are shown only to someone who may change the policy for the whole brokerage.
  if (!isBrokerageFinanceAdmin({ user_type: auth.userType }) && auth.userType !== "team_lead") return { ...base, canEdit: false, policy: null }
  const svc = createServiceClient()
  const gate = await requireCdaPolicyAdmin(svc)
  if (!gate.ok || gate.admin.brokerageId !== auth.brokerageId) return { ...base, canEdit: false, policy: null }

  const open = await openDealIds(svc, auth.brokerageId)
  const eff = await loadEffectiveCdaModes(svc, {
    brokerageId: auth.brokerageId,
    transactionIds: open.ok ? open.ids : [],
    live: data ? { offersCda: data.offers_cda ?? null, nonCdaPayoutDefault: data.non_cda_payout_default ?? null } : null,
  })
  if (!open.ok || !eff.ok) {
    console.error(`[brokerage-cda-setup] policy detail unreadable for ${auth.brokerageId}: ${!open.ok ? open.error : !eff.ok ? eff.error : ""}`)
    return { ...base, canEdit: true, policy: { readable: false as const } }
  }
  const differing = Object.entries(eff.deals).filter(([, d]) => d.differsFromCurrent || d.basis === "deal_switch")
  let labels = new Map<string, { address: string | null; stage: string | null }>()
  if (differing.length) {
    const { data: rows, error: labelErr } = await svc.from("transactions").select("id, property_address, stage").eq("brokerage_id", auth.brokerageId).in("id", differing.map(([id]) => id))
    if (labelErr) console.error(`[brokerage-cda-setup] deal labels unreadable for ${auth.brokerageId} (the deals are listed without an address): ${labelErr.message}`)
    labels = new Map(((rows ?? []) as Array<{ id: string; property_address: string | null; stage: string | null }>).map((r) => [r.id, { address: r.property_address, stage: r.stage }]))
  }
  const changers = Array.from(new Set(eff.history.map((h) => h.changed_by).filter((x): x is string => !!x)))
  const names = new Map<string, string>()
  if (changers.length) {
    const { data: users, error: nameErr } = await svc.from("users").select("id, first_name, last_name, email").eq("brokerage_id", auth.brokerageId).in("id", changers)
    if (nameErr) console.error(`[brokerage-cda-setup] policy changers' names unreadable for ${auth.brokerageId} (shown as "a team member"): ${nameErr.message}`)
    for (const u of (users ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>) names.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || "a team member")
  }
  return {
    ...base,
    canEdit: true,
    policy: {
      readable: true as const,
      current: eff.current.current,
      version: eff.current.policyVersion,
      unrecordedChange: eff.current.unrecordedChange,
      openDeals: open.ids.length,
      history: eff.history.slice(-10).reverse().map((h) => ({
        version: h.version,
        usesCda: h.value.offers_cda,
        effectiveAt: h.value.effective_at ?? h.created_at,
        changedBy: h.changed_by ? names.get(h.changed_by) ?? "a team member" : null,
        reason: h.reason,
      })),
      deals: differing.map(([id, d]) => ({
        transactionId: id,
        address: labels.get(id)?.address ?? null,
        stage: labels.get(id)?.stage ?? null,
        mode: d.mode,
        basis: d.basis,
        explanation: d.explanation,
      })),
    },
  }
}

/**
 * A finance admin switches ONE in-progress deal to (or away from) a CDA — the "unless an authorized user switches that deal" half of the
 * treatment matrix. A closed deal is refused; a CDA already approved / signed / with title is never dropped here. Switching to a CDA
 * opens the deal's CDA row for the AGENT to fill (status pending, no figures) and tells the agent; nothing is filled or signed.
 */
export async function switchDealCdaModeAction(input: { transactionId: string; mode: "cda" | "no_cda"; reason: string }) {
  const tx = String(input?.transactionId ?? "")
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tx)) return { success: false as const, error: "Choose a deal." }
  const svc = createServiceClient()
  const gate = await requireCdaPolicyAdmin(svc)
  if (!gate.ok) return { success: false as const, error: gate.error }
  const { admin } = gate

  const { data: txn, error: txErr } = await svc.from("transactions").select("id, status, agent_id, property_address").eq("id", tx).eq("brokerage_id", admin.brokerageId).is("deleted_at", null).maybeSingle()
  if (txErr) return { success: false as const, error: "This deal couldn't be read, so nothing was changed. Try again shortly." }
  if (!txn) return { success: false as const, error: "That deal isn't in your brokerage." }
  const deal = txn as { id: string; status: string | null; agent_id: string | null; property_address: string | null }
  const eff = await loadEffectiveCdaModes(svc, { brokerageId: admin.brokerageId, transactionIds: [tx] })
  const current = eff.ok ? eff.deals[tx] : undefined
  if (!eff.ok || !current) {
    console.error(`[brokerage-cda-setup] effective CDA mode unreadable for ${tx}: ${!eff.ok ? eff.error : "deal absent"}`)
    return { success: false as const, error: "This deal's CDA treatment couldn't be read, so nothing was changed. Try again shortly." }
  }
  const { data: rows, error: rowErr } = await svc
    .from("closing_disclosure_agreement")
    .select("id, status, broker_approved_at, sent_to_title_at, uses_cda, field_values")
    .eq("transaction_id", tx)
    .eq("brokerage_id", admin.brokerageId)
    .order("created_at", { ascending: false })
    .limit(1)
  if (rowErr) return { success: false as const, error: "This deal's CDA record couldn't be read, so nothing was changed. Try again shortly." }
  const row = ((rows ?? [])[0] ?? null) as { id: string; status: string | null; broker_approved_at: string | null; sent_to_title_at: string | null; uses_cda: boolean | null; field_values: Record<string, unknown> | null } | null
  const decision = decideDealCdaSwitch({ effective: current, target: input.mode, dealStatus: deal.status, cdaRow: row, reason: input.reason })
  if (!decision.ok) return { success: false as const, error: decision.message, code: decision.error }
  if (!row && !deal.agent_id) return { success: false as const, error: "Assign this deal's agent first — the agent's CDA record is where the deal's CDA treatment is kept." }

  const at = new Date().toISOString()
  const sw = { mode: input.mode, by: admin.userId, at, reason: String(input.reason).trim().slice(0, 500), from: current.mode, policy_version: current.policyVersion }
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  type Outcome = { ok: true; cdaId: string } | { ok: false; error: string }
  const outcome = await withActionLedger<Outcome>(
    {
      brokerageId: admin.brokerageId,
      action: "transaction.cda_mode.switch",
      actor: { type: "user", userId: admin.userId, agentId: admin.agentId },
      subject: { type: "transaction", id: tx },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: sw.reason,
      riskClass: "FINANCIAL",
      systemSource: CDA_POLICY_KEY,
      policyKey: CDA_POLICY_KEY,
      idempotencyKey: `cda_mode_switch:${tx}:${input.mode}:${at}`,
      detail: { from: current.mode, to: input.mode, basis_before: current.basis, policy_version: current.policyVersion },
    },
    async () => {
      if (row) {
        const { data: saved, error } = await svc
          .from("closing_disclosure_agreement")
          .update({ uses_cda: input.mode === "cda", field_values: { ...(row.field_values ?? {}), cda_mode_switch: sw }, updated_at: at })
          .eq("id", row.id)
          .eq("brokerage_id", admin.brokerageId)
          .select("id")
        if (error) return { ok: false, error: error.message }
        if (!saved || saved.length !== 1) return { ok: false, error: "no CDA row matched" }
        return { ok: true, cdaId: row.id }
      }
      const { data: created, error } = await svc
        .from("closing_disclosure_agreement")
        .insert({ transaction_id: tx, brokerage_id: admin.brokerageId, agent_id: deal.agent_id, status: "pending", revision_number: 1, uses_cda: input.mode === "cda", field_values: { cda_mode_switch: sw } })
        .select("id")
      const id = (Array.isArray(created) ? created[0] : created)?.id as string | undefined
      if (error || !id) return { ok: false, error: error?.message ?? "the CDA record was not created" }
      return { ok: true, cdaId: id }
    },
    {
      settle: (o) => (o.ok ? { status: "executed", outcome: `switched_to_${input.mode}` } : { status: "failed", outcome: "refused", error: o.error }),
      replay: (claim) => (claim.kind === "refused" ? { ok: false, error: `the action ledger refused: ${claim.error}` } : { ok: false, error: "this switch is already recorded" }),
    },
    { client: svc as never },
  )
  if (!outcome.ok) {
    console.error(`[brokerage-cda-setup] deal ${tx} switch to ${input.mode} not saved: ${outcome.error}`)
    return { success: false as const, error: "This deal's CDA treatment wasn't changed. Try again; if it keeps happening, contact platform support." }
  }

  // The agent fills the CDA (CDA_FILL_RULE) — tell them it is now theirs to fill. A lost heads-up never undoes the switch.
  if (input.mode === "cda" && deal.agent_id) {
    const { data: agentRow, error: agentErr } = await svc.from("agents").select("user_id").eq("id", deal.agent_id).eq("brokerage_id", admin.brokerageId).maybeSingle()
    if (agentErr) console.error(`[brokerage-cda-setup] the agent of ${tx} could not be resolved for the heads-up (the switch stands): ${agentErr.message}`)
    const agentUserId = (agentRow as { user_id?: string | null } | null)?.user_id ?? null
    if (agentUserId) {
      const { error: nErr } = await svc.from("notifications").insert({
        user_id: agentUserId,
        brokerage_id: admin.brokerageId,
        type: "cda_required",
        title: "This deal now uses a CDA",
        body: `Your brokerage switched${deal.property_address ? ` ${deal.property_address}` : " this deal"} to use a Commission Disbursement Authorization. Fill it from the deal's CDA page; it then goes to compliance, the broker signs it and it is sent to the title company.`,
        entity_type: "transaction",
        entity_id: tx,
        priority: "high",
        channel: "in_app",
      })
      if (nErr) console.error(`[brokerage-cda-setup] agent heads-up for ${tx} not delivered (the switch stands): ${nErr.message}`)
    }
  }
  revalidatePath(`/dashboard/transactions/${tx}`)
  revalidatePath("/dashboard/admin")
  return { success: true as const, mode: input.mode, cdaId: outcome.cdaId }
}

// ─── Template library CRUD ────────────────────────────────────────────────

export async function uploadCdaTemplateAction(input: {
  name:            string
  description?:    string
  state?:          string                                   // 2-letter, optional (universal templates)
  transactionType?: "sale_buy" | "sale_sell" | "dual" | "lease" | "referral"
  pdfUrl:          string                                   // Vercel Blob URL
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }
  if (!isCdaSetupAdmin(auth.userType)) {
    return { success: false as const, error: "forbidden" }
  }
  if (!input.name?.trim()) return { success: false as const, error: "name_required" }
  if (!input.pdfUrl?.trim()) return { success: false as const, error: "pdf_url_required" }

  const { data, error } = await supabase
    .from("brokerage_cda_templates")
    .insert({
      brokerage_id:     auth.brokerageId,
      name:             input.name.trim(),
      description:      input.description?.trim() || null,
      state:            input.state ? input.state.trim().toUpperCase() : null,
      transaction_type: input.transactionType ?? null,
      pdf_url:          input.pdfUrl,
      uploaded_by:      auth.userId,
      is_active:        true,
    })
    .select("*")
    .single()

  if (error || !data) return { success: false as const, error: error?.message ?? "create_failed" }
  revalidatePath("/dashboard/admin")
  return { success: true as const, template: data }
}

export async function listCdaTemplatesAction(input?: {
  state?:           string
  transactionType?: string
  includeInactive?: boolean
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  let query = supabase
    .from("brokerage_cda_templates")
    .select("id, name, description, state, transaction_type, pdf_url, is_active, created_at, updated_at")
    .eq("brokerage_id", auth.brokerageId)
    .order("state", { ascending: true })
    .order("name", { ascending: true })

  if (!input?.includeInactive) query = query.eq("is_active", true)
  if (input?.state) query = query.eq("state", input.state.trim().toUpperCase())
  if (input?.transactionType) query = query.eq("transaction_type", input.transactionType)

  const { data, error } = await query
  if (error) return { success: false as const, error: error.message }
  return { success: true as const, templates: data ?? [] }
}

export async function updateCdaTemplateAction(input: {
  id:               string
  name?:            string
  description?:     string
  state?:           string
  transactionType?: string
  isActive?:        boolean
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }
  if (!isCdaSetupAdmin(auth.userType)) {
    return { success: false as const, error: "forbidden" }
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.name !== undefined)            updates.name             = input.name.trim()
  if (input.description !== undefined)     updates.description      = input.description?.trim() || null
  if (input.state !== undefined)           updates.state            = input.state ? input.state.trim().toUpperCase() : null
  if (input.transactionType !== undefined) updates.transaction_type = input.transactionType ?? null
  if (input.isActive !== undefined)        updates.is_active        = input.isActive

  // COUNTED (§3): an UPDATE that matches nothing also resolves — `error` is null
  // and the call is byte-identical to one that worked. Without the .select() a
  // wrong-tenant id, or an id that no longer exists, reported "Template updated"
  // to a broker while nothing changed. The tenant predicate above is what makes
  // zero rows meaningful here: this table's rows always belong to one brokerage,
  // so a matched-nothing update is a refusal, not a legitimate no-op.
  const { data: updated, error } = await supabase
    .from("brokerage_cda_templates")
    .update(updates)
    .eq("id", input.id)
    .eq("brokerage_id", auth.brokerageId)
    .select("id")

  if (error) return { success: false as const, error: error.message }
  if (!updated || updated.length === 0) return { success: false as const, error: "template_not_found" }
  revalidatePath("/dashboard/admin")
  return { success: true as const }
}

export async function deactivateCdaTemplateAction(input: { id: string }) {
  return updateCdaTemplateAction({ id: input.id, isActive: false })
}
