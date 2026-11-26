/**
 * scripts/canaries/cda-closing.ts — CDA canary (wave 142, lane 142J):
 *   CDA disabled → none · enabled → the AGENT fills it MANUALLY (AI explains only) · separation of duties on
 *   approve / broker-sign / send-to-title · signed document tracked · delivery deadline + escalation
 * through the survivors at HEAD: lib/transactions/cda-signing-policy.ts (canApproveCda / canBrokerSignCda /
 * canSendCdaToTitle — pure gates the CDA doors call), lib/transactions/cda-esign.ts (resolveCdaSignMode — the
 * tenant's e-sign selection or in-app, never a provider the matrix does not certify), lib/transactions/
 * cda-delivery-policy.ts (classifyUndeliveredCda — the reaper's rule), lib/transactions/cda-template-fields.ts
 * (resolveCdaTemplateFields — a waterfall figure is NEVER pre-filled: the agent types it, the expected value sits
 * beside it) and app/actions/brokerage-cda-setup.ts (the ONE writer of brokerages.offers_cda / cda_onboarding_at /
 * non_cda_payout_default — live columns). Owner (wave 142): "AI MUST NOT FILL THE CDA (it may explain waterfall
 * figures when asked)"; the CDA exists "ONLY when brokerage settings say the brokerage uses CDA".
 *
 * MEASURED AT HEAD (the two 142C hooks): app/actions/cda-portal.ts never READS brokerages.offers_cda (the name
 * appears in a comment only — stripped, absent), and the delivery deadline is anchored to the approval time
 * (CDA_DELIVERY_GRACE_HOURS after updated_at), not to the scheduled closing in the tenant's timezone; the
 * send-to-title methods are email | docusign | dotloop | manual — no title-portal inbox. In-memory only
 * (closing_disclosure_agreement: 0 live rows at 2026-10-19).
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, readRepo, strippedRepo } from "./_registry"
import { exportedAsyncBodies } from "./crm-inbound"

export async function run() {
  const c = canary("CDA: only when the brokerage uses CDA · agent fills manually, AI explains only · approve → broker signs → title · deadline + escalation")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — closing_disclosure_agreement holds 0 live rows")
  // WIRED 142K (lane 142C): two tenants for the deadline reaper — a CDA brokerage (FL, closing in 2 h) and a no-CDA one.
  const B = uuid(), BN = uuid(), ADMIN = uuid(), AG_U = uuid(), AG = uuid(), TC_U = uuid(), TX = uuid(), CDA = uuid(), TXN = uuid(), CDAN = uuid()
  const tick = new Date()
  const closingSoon = new Date(tick.getTime() + 2 * 3_600_000).toISOString()
  const svc = canaryClient({
    brokerages: [
      { id: B, name: `${CANARY_TAG} CDA Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-cda`, state: "FL", offers_cda: true, non_cda_payout_default: null },
      { id: BN, name: `${CANARY_TAG} No-CDA Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-nocda`, state: "TX", offers_cda: false, non_cda_payout_default: "check" },
    ],
    users: [
      { id: ADMIN, email: `broker@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: B, platform_role: null },
      { id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, platform_role: null },
      { id: TC_U, email: `tc@${CANARY_EMAIL_DOMAIN}`, user_type: "tc", brokerage_id: B, platform_role: null },
    ],
    agents: [{ id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
    transactions: [
      { id: TX, brokerage_id: B, agent_id: AG, coordinator_id: TC_U, property_address: `1 ${CANARY_TAG} Way`, close_date: closingSoon, estimated_close_date: null, status: "under_contract" },
      { id: TXN, brokerage_id: BN, agent_id: null, coordinator_id: null, property_address: `2 ${CANARY_TAG} Way`, close_date: closingSoon, estimated_close_date: null, status: "under_contract" },
    ],
    closing_disclosure_agreement: [
      { id: CDA, brokerage_id: B, transaction_id: TX, agent_id: AG, status: "approved", broker_signed_at: nowIso(), sent_to_title_at: null, uses_cda: true, created_at: nowIso() },
      { id: CDAN, brokerage_id: BN, transaction_id: TXN, agent_id: null, status: "approved", broker_signed_at: null, sent_to_title_at: null, uses_cda: true, created_at: nowIso() },
    ],
  })
  setSvc(svc)

  // ── 1 · the brokerage setting is the switch (live columns; one writer) ──
  const setup = strippedRepo("app/actions/brokerage-cda-setup.ts") ?? ""
  const snapshot = readRepo("scripts/schema-snapshot.ts") ?? ""
  const setBody = exportedAsyncBodies(setup).find((f) => f.name === "setBrokerageCdaSettingAction")?.body ?? ""
  c.step("CDA IS A BROKERAGE SETTING: brokerages.offers_cda / cda_onboarding_at / non_cda_payout_default exist live (schema-snapshot) and setBrokerageCdaSettingAction is their writer — offers_cda=false clears the CDA template path and records the payout default (direct_deposit unless chosen); offers_cda=true leaves the payout default null", /offers_cda/.test(snapshot) && /cda_onboarding_at/.test(snapshot) && /non_cda_payout_default/.test(snapshot) && /offers_cda:\s*input\.offersCda/.test(setBody) && /non_cda_payout_default:\s*input\.offersCda\s*\?\s*null\s*:/.test(setBody) && /["']direct_deposit["']/.test(setBody), "")
  const cda = strippedRepo("app/actions/cda-portal.ts") ?? ""
  const vocab = readRepo("scripts/check-vocabularies.ts") ?? ""
  c.step("the no-CDA flow exists beside it: recordNonCdaPayoutPreferenceAction records CHECK or DIRECT DEPOSIT on the deal (closing_disclosure_agreement.non_cda_payout_method CHECK = check | direct_deposit), the two spellings the live CHECK admits", /non_cda_payout_method:\s*\[\s*["']check["'],\s*["']direct_deposit["']\s*\]/.test(vocab) && /recordNonCdaPayoutPreferenceAction/.test(cda) && /["']direct_deposit["']\s*\|\s*["']check["']/.test(cda), "")

  // ── 2 · separation of duties (pure) ──
  const { canApproveCda, canBrokerSignCda, canSendCdaToTitle, CDA_APPROVE_ROLES, CDA_BROKER_SIGN_ROLES } = await import("../../lib/transactions/cda-signing-policy")
  const { TENANT_ADMIN_USER_TYPES } = await import("../../lib/auth/resolve-user-role")
  c.step("APPROVAL: a compliance role approves a SUBMITTED CDA the agent has signed off; an agent never approves; nothing approves from drafting; no sign-off → agent_signoff_required; every approving role is a TENANT ADMIN type (never a retyped list wider than the roster)", canApproveCda({ status: "submitted", agentSignedOff: true, role: "compliance_officer" }).ok && !canApproveCda({ status: "submitted", agentSignedOff: true, role: "agent" }).ok && canApproveCda({ status: "drafting", agentSignedOff: true, role: "broker" }).error === "cannot_approve_from_status:drafting" && canApproveCda({ status: "submitted", agentSignedOff: false, role: "broker" }).error === "agent_signoff_required" && [...CDA_APPROVE_ROLES].every((r) => (TENANT_ADMIN_USER_TYPES as ReadonlySet<string>).has(r)), [...CDA_APPROVE_ROLES].join(","))
  c.step("BROKER SIGNATURE: only a broker role signs, only an APPROVED CDA, only once (already_signed); a compliance officer who approved cannot also sign as the broker (separation of duties)", canBrokerSignCda({ status: "approved", brokerSigned: false, role: "broker_owner" }).ok && canBrokerSignCda({ status: "approved", brokerSigned: true, role: "broker" }).error === "already_signed" && canBrokerSignCda({ status: "submitted", brokerSigned: false, role: "broker" }).error === "cannot_sign_from_status:submitted" && !CDA_BROKER_SIGN_ROLES.has("compliance_officer") && canBrokerSignCda({ status: "approved", brokerSigned: false, role: "compliance_officer" }).error === "forbidden_broker_only", "")
  c.step("SEND TO TITLE: only an approved AND broker-signed CDA leaves the brokerage — an envelope merely sent is not a signature (broker_signature_required); never from any other status", canSendCdaToTitle({ status: "approved", brokerSigned: true }).ok && canSendCdaToTitle({ status: "approved", brokerSigned: false }).error === "broker_signature_required" && canSendCdaToTitle({ status: "pending", brokerSigned: true }).error === "cannot_send_from_status:pending", "")

  // ── 3 · the signing mode follows the tenant's e-sign selection (pure) ──
  const { resolveCdaSignMode } = await import("../../lib/transactions/cda-esign")
  c.step("SIGN MODE: no e-sign provider → in-app (broker outside VIPAgents: download, sign outside, return); an UNCERTIFIED provider → in-app (never routed to a provider the matrix does not certify); a certified provider with a filled PDF → the existing authorized e-sign workflow; no filled PDF → in-app", resolveCdaSignMode({ providerConfigured: false, hasFilledPdf: true }).reason === "no_esign_provider_configured" && resolveCdaSignMode({ providerConfigured: true, hasFilledPdf: true, providerCertified: false }).reason === "esign_provider_not_certified" && resolveCdaSignMode({ providerConfigured: true, hasFilledPdf: true }).mode === "esign" && resolveCdaSignMode({ providerConfigured: true, hasFilledPdf: false }).mode === "in_app", "")

  // ── 4 · the AGENT fills it; the AI never does (pure) ──
  const { resolveCdaTemplateFields } = await import("../../lib/transactions/cda-template-fields")
  const defs = [
    { field_key: "property_address", label: "Property", source: "transaction" as const, source_key: "property_address", field_type: "text" as const, required: true, pdf_field: "Property" },
    { field_key: "gross_commission", label: "Gross commission", source: "waterfall" as const, source_key: "gross_commission", field_type: "currency" as const, required: true, pdf_field: "Gross" },
    { field_key: "agent_net", label: "Net to agent", source: "waterfall" as const, source_key: "agent_net", field_type: "currency" as const, required: true, pdf_field: "AgentNet" },
  ]
  const waterfall = { gross_commission: 24_000, agent_net: 16_800, brokerage_net: 7_200, agent_split_percent: 70, team_split: 0, fees: 0, referral_fee: 0 } as Record<string, number>
  const blank = resolveCdaTemplateFields(defs, { waterfall: waterfall as never, transaction: { property_address: "1 Canary Way" }, agentInputs: {} })
  const filled = resolveCdaTemplateFields(defs, { waterfall: waterfall as never, transaction: { property_address: "1 Canary Way" }, agentInputs: { gross_commission: "24000", agent_net: "16800" } })
  c.step("MANUAL FILL: an objective deal fact (the address) pre-fills; EVERY money line is blank until the agent types it — the waterfall's figure sits beside it as 'expected' (the explanation the AI may give), never in the field; the CDA is unsubmittable while a required money line is blank, complete once the agent has typed matching values", blank.fields.find((f) => f.field_key === "property_address")?.value === "1 Canary Way" && blank.fields.filter((f) => f.source === "waterfall").every((f) => f.value === null && f.expected !== null) && blank.missingRequired.join() === "gross_commission,agent_net" && filled.missingRequired.length === 0 && filled.fields.filter((f) => f.source === "waterfall").every((f) => f.value === f.expected), blank.missingRequired.join(","))
  const modelInCda = ["app/actions/cda-portal.ts", "lib/transactions/cda-template-fields.ts", "lib/transactions/cda-pdf-fill.ts", "lib/transactions/cda-esign.ts", "app/actions/brokerage-cda-setup.ts"].filter((f) => /generateText|generateObject|gatewayChat|Routed\(/.test(strippedRepo(f) ?? ""))
  c.step("NO MODEL FILLS THE CDA: the CDA doors, the field resolver, the PDF fill plan, the e-sign dispatch and the setting writer name no model call (0 of 5)", modelInCda.length === 0, modelInCda.join(",") || "0 of 5")

  // ── 5 · deadline + delivery (pure; the anchoring is the hook's subject) ──
  const { classifyUndeliveredCda, CDA_DELIVERY_GRACE_HOURS } = await import("../../lib/transactions/cda-delivery-policy")
  const now = new Date("2026-10-19T12:00:00Z")
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString()
  c.step(`DELIVERY ESCALATION (as it stands): an APPROVED CDA not sent to title ${CDA_DELIVERY_GRACE_HOURS} h after approval escalates; a sent one, a drafting one and a no-CDA deal (usesCda=false — the brokerage payout model owes title nothing) never do`, classifyUndeliveredCda({ status: "approved", sentToTitleAt: null, usesCda: true, updatedAt: hoursAgo(13), now }) === "escalate" && classifyUndeliveredCda({ status: "approved", sentToTitleAt: null, usesCda: true, updatedAt: hoursAgo(2), now }) === "keep" && classifyUndeliveredCda({ status: "approved", sentToTitleAt: hoursAgo(1), usesCda: true, updatedAt: hoursAgo(30), now }) === "keep" && classifyUndeliveredCda({ status: "drafting", sentToTitleAt: null, usesCda: true, updatedAt: hoursAgo(30), now }) === "keep" && classifyUndeliveredCda({ status: "approved", sentToTitleAt: null, usesCda: false, updatedAt: hoursAgo(30), now }) === "keep", "")
  const send = exportedAsyncBodies(cda).find((f) => f.name === "sendCdaToTitleAction")?.body ?? ""
  // THE RULE (m788 landed 142C, applied live, cache regenerated): the CHECK's vocabulary = the action's method union.
  const methodList = /sent_to_title_method:\s*\[([^\]]*)\]/.exec(vocab)?.[1]?.replace(/["'\s]/g, "").split(",").filter(Boolean) ?? []
  const methodUnion = [...(/method\?:\s*([^\n]+)/.exec(cda)?.[1] ?? "").matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1])
  c.step("SIGNED DOCUMENT TRACKED + ONE DELIVERY VOCABULARY (m788, landed 142C): sent_to_title_method's CHECK admits exactly the action's five methods — email | portal | docusign | dotloop | manual ('portal' = the title company on the Deal Team, the authorized title-portal inbox); sendCdaToTitleAction records the method + the sent_to_title stamp, routes through cdaDeliveryRoute and refuses a retry by deliveryIdempotency (already_delivered unless an explicit re-send carries a reason) — never a second delivery", methodList.includes("portal") && new Set(methodList).size === 5 && ["email", "portal", "docusign", "dotloop", "manual"].every((m) => methodList.includes(m) && methodUnion.includes(m)) && methodUnion.length === 5 && /sent_to_title_method/.test(send) && /deliveryIdempotency\(/.test(send) && /cdaDeliveryRoute\(/.test(send) && /sent_to_title_at/.test(send), `CHECK ${methodList.join("|")}; action ${methodUnion.join("|")}`)

  // ── WAVE142 HOOK (integrator): 142C — the CDA doors read brokerages.offers_cda; the deadline anchored to the closing (tenant timezone) + the title-portal inbox delivery. ──
  for (const h of hooksFor("cda-closing")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, /EXISTS ONLY/.test(h.contract) ? "measured: app/actions/cda-portal.ts names offers_cda in prose only (stripped → absent) — the doors do not read the brokerage setting; the manual-fill rule is BUILT (asserted above)" : `measured: the reaper escalates ${CDA_DELIVERY_GRACE_HOURS} h after approval (updated_at), not at the scheduled closing; send methods email|docusign|dotloop|manual (no title-portal inbox)`); continue }
    // WAVE142 HOOK (integrator): 142C — wired 142K: the ONE policy (lib/transactions/cda-closing-policy.ts) driven pure and
    // the deadline reaper driven in memory (no e-mail, no envelope: the bells and the bus are what land).
    const P = await import("../../lib/transactions/cda-closing-policy")
    const { reapCdaDeadlines } = await import("../../lib/transactions/cda-delivery-reaper")
    if (/EXISTS ONLY/.test(h.contract)) {
      const on = P.resolveCdaMode({ offersCda: true }), off = P.resolveCdaMode({ offersCda: false, nonCdaPayoutDefault: "check" }), undeclared = P.resolveCdaMode({ offersCda: null })
      const noCda = await reapCdaDeadlines(BN, svc as never, { now: tick })
      const readers = ["app/dashboard/transactions/[id]/cda/page.tsx", "lib/commission/reconcile-tracking.ts", "lib/transactions/cda-delivery-reaper.ts"].filter((f) => /\bresolveCdaMode\s*\(/.test(strippedRepo(f) ?? ""))
      c.step(`${h.lane} landed (${at}) — CDA EXISTS ONLY WHEN THE BROKERAGE SAYS SO: resolveCdaMode is the ONE answer (offers_cda true → cda mode, required, never blocks closing, no payout default; false → no_cda with the DECLARED payout default, check; undeclared → no_cda 'cda_not_declared' with direct deposit — an unanswered setting never manufactures a mandatory CDA); the CDA page, the commission finalization and the deadline reaper all read it (${readers.length} readers, one spelling); the reaper on the no-CDA brokerage is NOT APPLICABLE (0 scanned, no bell on that tenant); the fill rule is the AGENT's (aiFills false, agentFills true, aiMayExplainFigures true — the manual-fill flow asserted above)`, on.mode === "cda" && on.cdaRequired && on.blocksClosing === false && on.payoutMethodDefault === null && on.reason === "offers_cda" && off.mode === "no_cda" && !off.cdaRequired && off.payoutMethodDefault === "check" && off.reason === "no_cda_declared" && undeclared.mode === "no_cda" && undeclared.reason === "cda_not_declared" && undeclared.payoutMethodDefault === "direct_deposit" && noCda.notApplicable && noCda.scanned === 0 && noCda.escalated === 0 && (svc.tables.notifications ?? []).filter((n) => n.brokerage_id === BN).length === 0 && readers.length === 3 && P.CDA_FILL_RULE.aiFills === false && P.CDA_FILL_RULE.agentFills === true && P.CDA_FILL_RULE.aiMayExplainFigures === true, `readers: ${readers.join(", ")}`)
      continue
    }
    const tz = P.resolveTenantTimeZone({ state: "FL" }), tzNone = P.resolveTenantTimeZone({ state: null })
    const dl = P.resolveClosingDeadline({ closingScheduledDate: "2026-11-02", timeZone: tz.zone })
    const dlEarly = P.resolveClosingDeadline({ closingScheduledDate: "2026-11-02", timeZone: tz.zone, earlierCutoffHours: 24 })
    const localHour = dl.dueAt ? new Date(dl.dueAt).toLocaleString("en-US", { timeZone: tz.zone, hour: "2-digit", hourCycle: "h23" }) : "?"
    const inHours = (h: number) => P.cdaDeadlineVerdict({ dueAt: new Date(tick.getTime() + h * 3_600_000).toISOString(), now: tick })
    const reaped = await reapCdaDeadlines(B, svc as never, { now: tick })
    const escBells = () => (svc.tables.notifications ?? []).filter((n) => n.brokerage_id === B && n.type === "cda_deadline_escalated")
    const bells1 = escBells().length
    const bus = (svc.tables.manager_signals ?? []).filter((s) => s.brokerage_id === B && s.signal_type === "cda_deadline_at_risk")
    const again = await reapCdaDeadlines(B, svc as never, { now: tick })
    const idem = P.deliveryIdempotency({ sentToTitleAt: nowIso(), sentRecipient: "title@canary.test", recipient: "title@canary.test" })
    const resend = P.deliveryIdempotency({ sentToTitleAt: nowIso(), recipient: "title@canary.test", resend: true, resendReason: "title asked for a re-send" })
    const fresh = P.deliveryIdempotency({ sentToTitleAt: null, recipient: "title@canary.test" })
    c.step(`${h.lane} landed (${at}) — DEADLINE + DELIVERY anchored to the CLOSING in the TENANT's zone: FL → America/New_York from the brokerage's state (no state → UTC, SAID as a fallback); a date-only closing reads 09:00 local that day; an earlier title / brokerage cutoff wins by subtraction; no source → no deadline, said; the verdict ladder ok → 48h → 24h → escalate (≤ 12 h) → overdue, while delivered / not_applicable never ring; the reaper on a broker-signed, approved CDA closing in 2 h ESCALATES — the agent (agents.id → users.id, resolved) + the TC paged critical, the brokerage admins told, the finance_manager bus signal raised — and the second sweep rings NOBODY again (one open bell per CDA × state); delivery routes to the Deal-Team title portal inbox first, else the verified email, else refused by name; a recorded delivery is never repeated on retry (already_delivered) unless an explicit re-send carries a reason`, tz.zone === "America/New_York" && tz.source === "brokerage_state" && tzNone.zone === "UTC" && tzNone.source === "fallback" && dl.basis === "closing_scheduled_date" && dl.dateOnly && localHour === "09" && !!dl.dueAt && !!dlEarly.dueAt && Date.parse(dl.dueAt) - Date.parse(dlEarly.dueAt) === 24 * 3_600_000 && P.resolveClosingDeadline({ timeZone: tz.zone }).basis === "none" && inHours(100).state === "ok" && inHours(40).state === "reminder_48h" && inHours(20).state === "reminder_24h" && inHours(2).state === "escalate" && inHours(2).escalates && inHours(-1).state === "overdue" && P.cdaDeadlineVerdict({ dueAt: closingSoon, now: tick, sentToTitleAt: nowIso() }).state === "delivered" && P.cdaDeadlineVerdict({ dueAt: closingSoon, now: tick, usesCda: false }).state === "not_applicable" && P.CDA_DEADLINE_NOTIFICATION.escalate === "cda_deadline_escalated" && P.CDA_DEADLINE_NOTIFICATION.ok === null && reaped.scanned === 1 && reaped.escalated === 1 && reaped.reminded === 0 && reaped.zone === "America/New_York" && [AG_U, TC_U, ADMIN].every((u) => escBells().some((n) => n.user_id === u)) && escBells().filter((n) => n.user_id === AG_U).every((n) => n.priority === "critical") && bus.length === 1 && bus[0].to_manager === "finance_manager" && bus[0].from_manager === "deal_coordinator" && again.scanned === 1 && again.escalated === 0 && again.reminded === 0 && escBells().length === bells1 && P.cdaDeliveryRoute({ titlePortalUserId: "u", titleEmail: "t@canary.test" }).route === "portal" && P.cdaDeliveryRoute({ titleEmail: "t@canary.test" }).route === "email" && P.cdaDeliveryRoute({}).route === "none" && P.cdaDeliveryRoute({ titleEmail: "t@canary.test", requested: "portal" }).reason === "title_not_on_deal_team" && !idem.ok && idem.error === "already_delivered" && resend.ok && resend.resend && fresh.ok && !fresh.resend, `reaped ${JSON.stringify(reaped)}; escalation bells ${bells1}; bus ${bus.length}`)
  }
  c.blind("The CDA doors are 'use server' (session-bound) and are asserted on stripped source; the pure policies ran on fixtures; the deadline reaper ran in memory (its bells and bus signal are what landed — no e-mail, no portal message, no envelope). The e-sign dispatch itself is the cda-esign canary's.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(svc, BN)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length === 0 && a.residual + b.residual === 0, [...a.cleanup, ...b.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup], a.residual + b.residual)
}
