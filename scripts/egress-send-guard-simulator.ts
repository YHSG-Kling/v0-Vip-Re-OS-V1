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
  "app/actions/lender-status-request.ts":       { cls: "b2b-transactional", why: "transactional request to a lender (B2B, not consumer marketing)" },
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

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(` ✅ EGRESS_SEND_GUARD_PASS — no ungoverned egress; ${importers.length} sender-touching files all reviewed, surface frozen`)
