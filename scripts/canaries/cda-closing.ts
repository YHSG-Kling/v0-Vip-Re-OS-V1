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
import { LIVE, canary } from "./_harness"
import { hooksFor, readRepo, strippedRepo } from "./_registry"
import { exportedAsyncBodies } from "./crm-inbound"

export async function run() {
  const c = canary("CDA: only when the brokerage uses CDA · agent fills manually, AI explains only · approve → broker signs → title · deadline + escalation")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — closing_disclosure_agreement holds 0 live rows")

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
  c.step("SIGNED DOCUMENT TRACKED: sendCdaToTitleAction records the method and the sent_to_title stamp on the CDA (sent_to_title_method CHECK = docusign | dotloop | email | manual) — a retry reads the stamp, never a second delivery", /sent_to_title_method:\s*\[\s*["']docusign["'],\s*["']dotloop["'],\s*["']email["'],\s*["']manual["']\s*\]/.test(vocab) && /sent_to_title/.test(send), "")

  // ── WAVE142 HOOK (integrator): 142C — the CDA doors read brokerages.offers_cda; the deadline anchored to the closing (tenant timezone) + the title-portal inbox delivery. ──
  for (const h of hooksFor("cda-closing")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, /EXISTS ONLY/.test(h.contract) ? "measured: app/actions/cda-portal.ts names offers_cda in prose only (stripped → absent) — the doors do not read the brokerage setting; the manual-fill rule is BUILT (asserted above)" : `measured: the reaper escalates ${CDA_DELIVERY_GRACE_HOURS} h after approval (updated_at), not at the scheduled closing; send methods email|docusign|dotloop|manual (no title-portal inbox)`); continue }
    c.step(`${h.lane} landed (${at}) — wire its export into this canary (WAVE142 HOOK (integrator): ${h.lane}): ${/EXISTS ONLY/.test(h.contract) ? "drive a brokerage with offers_cda=false through the CDA door and assert the refusal + the no-CDA payout path; offers_cda=true → the manual-fill flow" : "drive an approved, broker-signed CDA against a closing 2 h away in the tenant timezone and assert the reminder, the escalation to the registered owner and ONE title delivery on retry"}`, false, h.contract.slice(0, 120))
  }
  c.blind("The CDA doors are 'use server' (session-bound) and are asserted on stripped source; the pure policies ran on fixtures. The e-sign dispatch itself is the cda-esign canary's. No storage, no e-mail, no envelope.")
  return c.report([], 0)
}
