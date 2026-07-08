#!/usr/bin/env tsx
/**
 * scripts/egress-send-guard-simulator.ts  (npm run test:egress-send-guard) — pure, no DB.
 *
 * NO UNGOVERNED EGRESS — the audit that proves nothing ships outside the gate. Every real outbound
 * send funnels through ONE consent/quiet-hours/de-confliction gate: lib/providers/dispatch.ts. The
 * low-level provider senders (sendEmail / sendSMS / sendVia* in lib/providers/messaging) must only be
 * reached from that gate — a NEW file importing them directly is a potential ungoverned egress and
 * FAILS CI until it either routes through dispatch.ts or is reviewed onto the allowlist with a reason.
 *
 * This is a baseline ratchet (like schema-drift): the CURRENT direct callers are frozen + classified;
 * the surface can only shrink. KNOWN-GAP entries are honest TODOs to route through the gate.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const MESSAGING = "@/lib/providers/messaging"
const SENDERS = /\b(sendEmail|sendSMS|sendViaTwilio|sendViaTelnyx|sendViaBandwidth)\b/

type Class = "gate" | "gated-inline" | "non-client" | "b2b-transactional" | "known-gap"
/** The reviewed surface — every file allowed to touch the low-level senders, with WHY. */
const ALLOWLIST: Record<string, { cls: Class; why: string }> = {
  "lib/providers/dispatch.ts":                  { cls: "gate", why: "THE GATE — consent / opt-out / DNC / quiet-hours / de-confliction enforced here" },
  "lib/services/communication.service.tsx":     { cls: "b2b-transactional", why: "shared comms service — callers supply the gate context" },
  "app/actions/instant-property-alerts.ts":     { cls: "gated-inline", why: "buyer alerts check opt-out / consent inline before send" },
  "app/api/agent-assistant/tool-call/route.ts": { cls: "gated-inline", why: "voice admin tool-call checks consent/opt-out inline before any send" },
  "app/api/cron/weekly-income-digest/route.ts": { cls: "non-client", why: "agent-facing weekly digest (to the user themselves, not a client)" },
  "lib/kernel/showing-lifecycle.ts":            { cls: "gated-inline", why: "T-24h reminder for a showing the buyer THEMSELVES booked (transactional per TCPA: EWC skipped but DNC/quiet-hours/opt-out enforced inside sendSMS); one per showing, metadata-deduped" },
  "lib/billing/dunning.ts":                     { cls: "b2b-transactional", why: "dunning email to the TENANT billing admin (the platform own customer, past-due recovery, not consumer marketing; SendGrid-gated, one step per episode via platform_dunning_events)" },
  "app/actions/lender-status-request.ts":       { cls: "b2b-transactional", why: "transactional request to a lender (B2B, not consumer marketing)" },
  "lib/transactions/deal-vendor-notify.ts":     { cls: "b2b-transactional", why: "Deal-Save Huddle B2B leg — notifies the loan officer / title-escrow officer of a deal issue (business counterparty on the file; deduped + audited)" },
  "lib/kernel/vendors.ts":                      { cls: "b2b-transactional", why: "vendor-facing email (B2B service coordination)" },
  "lib/showings/dispatchers.ts":                { cls: "b2b-transactional", why: "agent-to-agent showing coordination (listing agent's phone, no consumer contact) via the connector-gateway adapter" },
  // Client sends below were CLOSED this PR — they now route through lib/providers/dispatch.ts
  // (credit-copilot, listing-lifecycle, external-services, workflow-engine) and no longer touch
  // the raw senders, so they fall off this list entirely. Zero known-gaps remain.
}

// ── Walk lib/ + app/ for every file that touches the low-level senders ──
function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
}
const files: string[] = []
walk(join(root, "lib"), files)
walk(join(root, "app"), files)

const importers: string[] = []
for (const abs of files) {
  const src = readFileSync(abs, "utf8")
  if (src.includes(MESSAGING) && SENDERS.test(src)) importers.push(relative(root, abs).replace(/\\/g, "/"))
}

console.log("\n[1 · every file touching the low-level senders is on the reviewed allowlist]")
const unreviewed = importers.filter((f) => !(f in ALLOWLIST))
for (const f of importers) {
  const entry = ALLOWLIST[f]
  check(`${f} — ${entry ? entry.cls : "UNREVIEWED"}`, !!entry, entry ? undefined : "NEW ungoverned egress — route through lib/providers/dispatch.ts or get it reviewed")
}
check("no NEW ungoverned-egress importer (the surface can only shrink)", unreviewed.length === 0, unreviewed.join(", "))

console.log("\n[2 · the gate exists and the allowlist is honest]")
check("the single gate (lib/providers/dispatch.ts) is present + classified as the gate",
  ALLOWLIST["lib/providers/dispatch.ts"]?.cls === "gate" && importers.includes("lib/providers/dispatch.ts"))
const knownGaps = Object.entries(ALLOWLIST).filter(([, v]) => v.cls === "known-gap").map(([f]) => f)
check("every allowlisted file is actually still an importer (no stale allowlist entry)",
  Object.keys(ALLOWLIST).every((f) => importers.includes(f)),
  Object.keys(ALLOWLIST).filter((f) => !importers.includes(f)).join(", "))
check("ZERO known-gap consumer sends remain — every client send is routed through the gate",
  knownGaps.length === 0, knownGaps.join(", "))

console.log(`\n  ℹ ${importers.length} files touch the senders · ${knownGaps.length} KNOWN-GAP (route-through-dispatch TODOs):`)
for (const g of knownGaps) console.log(`     - ${g}`)

// ── 3. SOCIAL PUBLISH — the other consumer-reaching primitive — only from approval-gated chokepoints ──
console.log("\n[3 · the social-publish primitive is only reached from an approval-gated chokepoint]")
const SOCIAL_MODULE = "@/lib/social/publisher"
const SOCIAL_PRIMITIVE = /\bpublishToSocialPlatform\b/
const SOCIAL_ALLOWLIST: Record<string, string> = {
  "app/api/cron/publish-social-posts/route.ts": "approval-gated — publishes ONLY social_posts with approval_status='approved'",
}
const socialCallers = files
  .map((abs) => ({ abs, src: readFileSync(abs, "utf8") }))
  .filter(({ abs, src }) => !abs.endsWith("lib/social/publisher.ts") && src.includes(SOCIAL_MODULE) && SOCIAL_PRIMITIVE.test(src))
  .map(({ abs }) => relative(root, abs).replace(/\\/g, "/"))
for (const f of socialCallers) {
  check(`${f} — ${SOCIAL_ALLOWLIST[f] ? "approval-gated" : "UNREVIEWED"}`, f in SOCIAL_ALLOWLIST,
    SOCIAL_ALLOWLIST[f] ? undefined : "NEW direct social publish — must publish only approved posts or be reviewed")
}
check("no NEW direct social-publish caller (broadcast egress stays approval-gated)",
  socialCallers.every((f) => f in SOCIAL_ALLOWLIST), socialCallers.filter((f) => !(f in SOCIAL_ALLOWLIST)).join(", "))

// ── 4. NO BACKDOOR — the gate cannot be told to skip consent ──
console.log("\n[4 · the gate has no consent-skip backdoor]")
const gateSrc = readFileSync(join(root, "lib/providers/dispatch.ts"), "utf8")
const BACKDOOR = /\b(skipSuppression|skipConsent|skipCompliance|bypassGate|bypassConsent|forceSend|ignoreSuppression|disableGate|skipGate)\b/
const m = gateSrc.match(BACKDOOR)
check("lib/providers/dispatch.ts exposes NO consent-skip flag (no force/bypass/skip-suppression backdoor)",
  m === null, m ? `found '${m[0]}'` : undefined)

// ── 5. NO CONNECTOR BYPASS — a consumer message must not go via a raw messaging-connector call ──
console.log("\n[5 · no consumer send via a raw messaging-connector (bypassing the consent gate)]")
const CONNECTOR_SEND = /callConnector[\s\S]{0,300}connector:\s*["'](twilio|telnyx|bandwidth|sendgrid)["']/
const CONNECTOR_ALLOWLIST: Record<string, string> = {
  "lib/providers/messaging/index.ts":      "the provider layer (called BY dispatch.ts, behind the gate)",
  "lib/providers/messaging/sms-adapters.ts": "the provider adapters (behind the gate)",
  "lib/showings/dispatchers.ts":           "agent-to-agent showing coordination (B2B, no consumer contact)",
  "lib/onboarding/integration-tester.ts":  "onboarding self-test send (the agent tests their OWN integration, not a consumer)",
  "app/actions/phone-provisioning.ts":     "Twilio number provisioning (admin API, not a message)",
  "lib/voice/twilio-tenancy.ts":           "Twilio SUBACCOUNT administration (creates per-tenant subaccounts; admin API, not a message)",
  "lib/voice/twilio-voice.ts":              "Twilio number VoiceUrl binding for the AI reception lane (admin API config write, not a message)",
  "app/actions/superadmin/platform-reception.ts": "PLATFORM line VoiceUrl binding (master-account admin API config write, not a message)",
  "lib/voice/twilio-outbound.ts":           "outbound AI voice dial — the TCPA chokepoint (enforceTCPACompliance) + vendor budget gate run INSIDE this module BEFORE the Twilio request (same governance as the Vapi lane it replaces)",
  "app/api/voice/relay/plan/route.ts":      "live-call transfer redirect (call-control REST on an ALREADY-GATED in-progress call; secret-gated endpoint, not a message)",
  "lib/voice/a2p-registration.ts":          "A2P 10DLC carrier registration (TrustHub/Messaging admin APIs — compliance filings, not messages)",
  "app/api/voice/twilio/intelligence/route.ts": "Conversational Intelligence transcript/operator READS (GET-only merge onto the call ledger, not a message)",
  "lib/platform/go-live-readiness.ts":      "go-live readiness probes (read-only GET reachability checks per vendor — never a message)",
}
const connectorSenders = files
  .map((abs) => ({ abs, src: readFileSync(abs, "utf8") }))
  .filter(({ src }) => CONNECTOR_SEND.test(src))
  .map(({ abs }) => relative(root, abs).replace(/\\/g, "/"))
for (const f of connectorSenders) {
  check(`${f} — ${CONNECTOR_ALLOWLIST[f] ? "reviewed" : "UNREVIEWED"}`, f in CONNECTOR_ALLOWLIST,
    CONNECTOR_ALLOWLIST[f] ? undefined : "consumer message via raw connector — route through dispatchSms/dispatchEmail (the gate)")
}
check("no consumer message bypasses the gate via a raw messaging-connector",
  connectorSenders.every((f) => f in CONNECTOR_ALLOWLIST), connectorSenders.filter((f) => !(f in CONNECTOR_ALLOWLIST)).join(", "))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(` ✅ EGRESS_SEND_GUARD_PASS — no ungoverned egress across email/SMS/voice + social; ${importers.length} sender files reviewed, ${socialCallers.length} social-publish chokepoint(s) approval-gated, gate has no backdoor`)
