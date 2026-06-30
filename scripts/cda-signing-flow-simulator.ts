#!/usr/bin/env tsx
/**
 * scripts/cda-signing-flow-simulator.ts   (npm run test:cda-signing-flow)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CDA two-signature state machine (cda-signing-policy): agent e-signs →
 * submit → compliance APPROVES → BROKER signs → sent to title. Separation of duties:
 * compliance can approve but not apply the broker signature; the signed CDA can't
 * reach title until the broker signs; a non-broker can't broker-sign. Pure: no I/O.
 */
import { canApproveCda, canBrokerSignCda, canSendCdaToTitle } from "../lib/transactions/cda-signing-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[compliance approval gate]")
  check("submitted + agent-signed + compliance role → ok", canApproveCda({ status: "submitted", agentSignedOff: true, role: "compliance_officer" }).ok)
  check("agent NOT signed → blocked (agent_signoff_required)", canApproveCda({ status: "submitted", agentSignedOff: false, role: "compliance_officer" }).error === "agent_signoff_required")
  check("not submitted (drafting) → blocked", !canApproveCda({ status: "drafting", agentSignedOff: true, role: "broker" }).ok)
  check("non-compliance role → forbidden", canApproveCda({ status: "submitted", agentSignedOff: true, role: "agent" }).error === "forbidden")

  console.log("\n[broker signature gate — the 2nd signature, after approval]")
  check("approved + not-yet-signed + broker role → ok", canBrokerSignCda({ status: "approved", brokerSigned: false, role: "broker" }).ok)
  check("admin can broker-sign", canBrokerSignCda({ status: "approved", brokerSigned: false, role: "admin" }).ok)
  check("compliance_officer alone CANNOT broker-sign (separation of duties)", canBrokerSignCda({ status: "approved", brokerSigned: false, role: "compliance_officer" }).error === "forbidden_broker_only")
  check("agent cannot broker-sign", !canBrokerSignCda({ status: "approved", brokerSigned: false, role: "agent" }).ok)
  check("can't broker-sign before compliance approval (submitted)", canBrokerSignCda({ status: "submitted", brokerSigned: false, role: "broker" }).error === "cannot_sign_from_status:submitted")
  check("already signed → blocked", canBrokerSignCda({ status: "approved", brokerSigned: true, role: "broker" }).error === "already_signed")

  console.log("\n[send-to-title gate — only after the broker signs]")
  check("approved + broker-signed → ok to send", canSendCdaToTitle({ status: "approved", brokerSigned: true }).ok)
  check("approved but NOT broker-signed → blocked (broker_signature_required)", canSendCdaToTitle({ status: "approved", brokerSigned: false }).error === "broker_signature_required")
  check("not approved → can't send", canSendCdaToTitle({ status: "submitted", brokerSigned: true }).error === "cannot_send_from_status:submitted")

  console.log("\n[the happy-path sequence holds end to end]")
  const approve = canApproveCda({ status: "submitted", agentSignedOff: true, role: "compliance_officer" })
  const brokerSign = canBrokerSignCda({ status: "approved", brokerSigned: false, role: "broker" })
  const send = canSendCdaToTitle({ status: "approved", brokerSigned: true })
  check("approve → broker-sign → send all OK in order", approve.ok && brokerSign.ok && send.ok)
  check("skipping broker-sign blocks the send", !canSendCdaToTitle({ status: "approved", brokerSigned: false }).ok)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CDA_SIGNING_FLOW_FAIL"); process.exit(1) }
  console.log(" ✅ CDA_SIGNING_FLOW_PASS — agent→submit→compliance→broker→title, separation of duties enforced")
}
main()
