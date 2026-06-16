#!/usr/bin/env tsx
/**
 * scripts/dry-run-cockpit-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the DRY-RUN TOMORROW cockpit: preview every planned touch with its gates green/blocked
 * BEFORE it fires — the decision-receipts shape projected forward. Reuses the REAL consent +
 * channel-preference gates, so the preview matches what the executor would actually do.
 * Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/dry-run-cockpit-simulator.ts   (npm run test:dry-run-cockpit)
 */
import { assemblePlannedDay, previewTouch } from "../lib/intelligence/dry-run-cockpit"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Dry-run cockpit verified — planned touches previewed through the real gates.")
  console.log(" DRY_RUN_COCKPIT_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Dry-run tomorrow cockpit simulator")
  console.log("══════════════════════════════════════════════════\n")

  // A clean email → will send.
  check("email to a consented contact → will send", previewTouch({ contactId: "c1", channel: "email", scheduledAt: "2026-06-17T09:00:00Z", consent: {} }).willSend)

  // SMS with no TCPA consent → blocked with the real reason.
  const sms = previewTouch({ contactId: "c2", channel: "sms", scheduledAt: "2026-06-17T10:00:00Z", consent: { tcpa_consent: false } })
  check("sms w/o TCPA consent → blocked (real gate reason)", !sms.willSend && /tcpa/i.test(sms.gate))

  // Email to an SMS-preferring contact → blocked by channel preference.
  const pref = previewTouch({ contactId: "c3", channel: "email", scheduledAt: "2026-06-17T11:00:00Z", consent: { preferred_channel: "sms" } })
  check("email to an sms-only contact → blocked by preference", !pref.willSend && /prefer/i.test(pref.gate))

  // Portal isn't direct-gated → will send.
  check("portal channel → will send (not consent-gated)", previewTouch({ contactId: "c4", channel: "portal", scheduledAt: "2026-06-17T12:00:00Z", consent: {} }).willSend)

  // Full day: counts + time-ordering.
  const day = assemblePlannedDay([
    { contactId: "c2", channel: "sms", scheduledAt: "2026-06-17T10:00:00Z", consent: { tcpa_consent: false } },
    { contactId: "c1", channel: "email", scheduledAt: "2026-06-17T08:00:00Z", consent: {} },
    { contactId: "c3", channel: "email", scheduledAt: "2026-06-17T09:00:00Z", consent: { preferred_channel: "sms" } },
  ])
  check("day summary counts send vs blocked", day.total === 3 && day.willSend === 1 && day.blocked === 2, JSON.stringify({ t: day.total, s: day.willSend, b: day.blocked }))
  check("day is time-ordered (earliest first)", day.touches[0].scheduledAt === "2026-06-17T08:00:00Z")
  check("empty → empty day", assemblePlannedDay([]).total === 0)

  report()
}

main()
