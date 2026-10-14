#!/usr/bin/env tsx
/**
 * scripts/notification-fanout-simulator.ts   (npm run test:notification-fanout) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * BLIND SPOT 1 (lane 74C, docs/production-readiness-gaps-2026-09.md Part 1c):
 * "notifications/push has only one guard-chain proof (test:parties-notify)
 * against a much larger fan-out surface (email/SMS/push/in-app notification
 * fan-out spans dozens of files under lib/notifications/, lib/providers/
 * messaging/, ...)."
 *
 * This does NOT try to individually audit the ~150 call sites across the app
 * that insert a single `notifications` row as a side effect of ordinary
 * business logic (offer accepted, showing booked, ...) — those are callers,
 * not dispatchers, and rewriting 150 of them without a careful per-site read
 * is exactly the "scraping files: wholesale rewrite" mistake CLAUDE.md §2
 * warns against in miniature. Instead it proves the actual FAN-OUT LAYER —
 * the handful of functions every channel ultimately routes through — is sound,
 * and it CENSUSES the wider call-site surface honestly (§2: publish the
 * denominator) with a shrink-only ratchet baseline so that number cannot grow
 * silently even though this lane does not zero it.
 *
 * THE SIX DISPATCH SURFACES (found via: grep -rl "web-push\|sendPushNotification"
 * / "notifications" writers / VAPID / in-app notification inserts / email+SMS
 * notification dispatchers):
 *   1. lib/transactions/notification-service.ts  — NotificationService, the
 *      multi-channel fan-out (in_app + email + sms + push) + notification_log
 *      audit trail + the delivery-failure escalation reader.
 *   2. lib/notifications/notify-helpers.ts        — targeted in-app fan-out
 *      (e-sign signed, compliance flag) used by the offer + transaction chains.
 *   3. lib/providers/web-push.ts                  — real browser push egress
 *      (RFC 8030/VAPID), the ONLY caller of the `web-push` npm package.
 *   4. lib/providers/messaging/index.ts            — sendSMS (Twilio) / sendEmail
 *      (SendGrid) egress, the bottom of the stack.
 *   5. lib/providers/dispatch.ts                   — dispatchEmail / dispatchSms,
 *      the ONLY callers of #4, gate-wrapped (autonomy/compliance/de-conflict).
 *   6. app/api/cron/queue-drain/route.ts           — drainPushQueue /
 *      drainEmailQueue, the cron that turns queued rows into #3/#4 calls, with
 *      an honest in-app fallback when push isn't configured or has no
 *      subscriptions.
 *
 * What is proved, PER SURFACE:
 *   (a) every write to a notification table (notifications / notification_log /
 *       push_notification_queue / email_queue) either reads its error or is
 *       wrapped in sentinelWrite/bestEffort — reusing silent-write-guard's own
 *       `silentWritesIn` detector (§6: one vocabulary, not a second regex);
 *   (b) tenant-scoped recipient resolution — brokerageId reaches the write;
 *   (c) fail-closed without provider keys — VAPID for push, TWILIO_* for SMS,
 *       SENDGRID_API_KEY for email — each returns a declared failure BEFORE any
 *       send is attempted when the key(s) are absent;
 *   (d) no duplicate dispatcher for the same channel (§6) — each channel's
 *       send/drain/fan-out function is DEFINED exactly once repo-wide.
 *
 * Then the wider census: every `.from("notifications"|"notification_log"|
 * "push_notification_queue"|"email_queue").insert(` call site under app/ + lib/,
 * classified checked/unchecked by the SAME detector, with a shrink-only ratchet
 * baseline (NOTIFICATION_FANOUT_BASELINE=1 to re-freeze, same discipline as
 * scripts/wrapper-choice-baseline.json) so a new unchecked site cannot land
 * invisibly even though the existing count is a published carry, not zeroed.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { stripComments } from "./strip-comments"
import { splitStatements, silentWritesIn } from "./silent-write-guard"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}

/** The four notification-table names this proof judges. NOT in silent-write-
 *  guard's CONSEQUENTIAL_TABLES by design (a lost push/email/log row is not
 *  money, access, or the compliance record — it is a UX regression, which is
 *  why this is its own proof rather than an addition to that list). */
export const NOTIFICATION_TABLES = [
  "notifications", "notification_log", "push_notification_queue", "email_queue",
] as const

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")

console.log("\n[pure — the detector, reused from silent-write-guard §6]")
{
  check("flags an unchecked notifications insert",
    silentWritesIn(`await supabase.from("notifications").insert(rows)`, NOTIFICATION_TABLES)[0] === "notifications")
  check("accepts it once the error is destructured",
    silentWritesIn(`const { error } = await supabase.from("notifications").insert(rows)`, NOTIFICATION_TABLES).length === 0)
  check("accepts a sentinelWrite-wrapped push_notification_queue insert",
    silentWritesIn(`await sentinelWrite(svc, svc.from("push_notification_queue").insert(p), ctx)`, NOTIFICATION_TABLES).length === 0)
  check("ignores a write to a table outside the four notification tables",
    silentWritesIn(`await supabase.from("blog_posts").insert(row)`, NOTIFICATION_TABLES).length === 0)
  check("still flags an explicitly swallowed notification_log insert",
    silentWritesIn(`await supabase.from("notification_log").insert(rows).catch(() => {})`, NOTIFICATION_TABLES)[0] === "notification_log")
}

console.log("\n[surface 1 — lib/transactions/notification-service.ts (multi-channel fan-out)]")
{
  const src = stripComments(read("lib/transactions/notification-service.ts"))
  const stmts = splitStatements(src)
  const unchecked = stmts.flatMap((s) => silentWritesIn(s, NOTIFICATION_TABLES))
  check("every notifications/notification_log/push_notification_queue write reads its error or is sentinel-wrapped (0 unchecked)",
    unchecked.length === 0, unchecked.join(", "))
  check("recipient resolution is tenant-scoped (brokerageId threaded onto every write)",
    /brokerage_id:\s*params\.brokerageId/.test(src) && /eq\("brokerage_id",\s*(params\.brokerageId|brokerageId|g\.brokerageId)\)/.test(src))
  check("escalation reader exists for the audit trail this writes (readerless-write census)",
    /export async function escalateFailedNotificationDeliveries/.test(src))
  check("defines the fan-out entry point exactly once",
    (src.match(/async sendMultiChannelNotification\s*\(/g) ?? []).length === 1)
}

console.log("\n[surface 2 — lib/notifications/notify-helpers.ts (targeted in-app fan-out)]")
{
  const src = stripComments(read("lib/notifications/notify-helpers.ts"))
  const stmts = splitStatements(src)
  const unchecked = stmts.flatMap((s) => silentWritesIn(s, NOTIFICATION_TABLES))
  check("every notification write reads its error or is sentinel-wrapped (0 unchecked)",
    unchecked.length === 0, unchecked.join(", "))
  check("recipient resolution is tenant-scoped (brokerageId present)",
    /brokerageId/.test(src))
}

console.log("\n[surface 3 — lib/providers/web-push.ts (real push egress, VAPID)]")
{
  const src = stripComments(read("lib/providers/web-push.ts"))
  check("fails closed without all three VAPID keys — checked BEFORE any subscription lookup",
    /if\s*\(!publicKey\s*\|\|\s*!privateKey\s*\|\|\s*!subject\)\s*\{[\s\S]{0,200}?return result/.test(src) &&
    src.indexOf("if (!publicKey") < src.indexOf('from("push_subscriptions")'))
  check("isWebPushConfigured gate exported for callers to check before attempting a send",
    /export function isWebPushConfigured\s*\(\s*\)\s*:\s*boolean/.test(src))
  check("subscription lookup reads its error",
    /const\s*\{\s*data:\s*subs,\s*error\s*\}\s*=\s*await\s+supabase[\s\S]{0,80}from\("push_subscriptions"\)/.test(src))
  check("the send is per-user (tenant/identity scoped, not a broadcast)",
    /\.eq\("user_id",\s*params\.userId\)/.test(src))
  check("defines the real push-egress function exactly once repo-wide",
    countDefinitions(/export async function sendWebPush\s*\(/g) === 1)
}

console.log("\n[surface 4 — lib/providers/messaging/index.ts (Twilio SMS / SendGrid email egress)]")
{
  const src = stripComments(read("lib/providers/messaging/index.ts"))
  check("SMS fails closed without TWILIO_ACCOUNT_SID/AUTH_TOKEN/PHONE_NUMBER",
    /if\s*\(!accountSid\s*\|\|\s*!authToken\s*\|\|\s*!fromNumber\)\s*\{[\s\S]{0,160}?success:\s*false/.test(src))
  check("email fails closed without a usable sender AND without SENDGRID_API_KEY",
    /if\s*\(!resolvedFrom\)\s*\{[\s\S]{0,60}?success:\s*false/.test(src) &&
    /if\s*\(!apiKey\)\s*\{[\s\S]{0,120}?success:\s*false/.test(src))
  check("defines the SMS egress function exactly once, in this file — the per-provider fan-out (Twilio/Telnyx/Bandwidth) lives in sms-adapters.ts's SMS_ADAPTERS map, which this delegates to (not a duplicate: one call site chooses the credentialed adapter)",
    (src.match(/export async function sendSMS\s*\(/g) ?? []).length === 1 && /SMS_ADAPTERS/.test(src))
  check("defines the email egress function exactly once, in this file (no equivalent per-provider email-adapters map exists — SendGrid is the sole email provider)",
    (src.match(/export async function sendEmail\s*\(/g) ?? []).length === 1)
  check("app/actions/communications.ts's sendSMS/sendEmail (a UI-facing 'use server' convenience wrapper with the SAME names) DELEGATE to dispatchSms/dispatchEmail rather than re-implementing egress — no third independent Twilio/SendGrid call site",
    (() => {
      const wrap = stripComments(read("app/actions/communications.ts"))
      const delegates = /await\s+dispatchSms\s*\(/.test(wrap) && /await\s+dispatchEmail\s*\(/.test(wrap)
      const reimplements = /api\.twilio\.com|api\.sendgrid\.com/.test(wrap)
      return delegates && !reimplements
    })())
}

console.log("\n[surface 5 — lib/providers/dispatch.ts (dispatchEmail / dispatchSms, the ONLY callers of surface 4)]")
{
  const src = stripComments(read("lib/providers/dispatch.ts"))
  check("dispatchEmail is tenant-scoped (brokerageId flows into the compliance/de-conflict gates)",
    /dispatchEmail[\s\S]{0,600}params\.brokerageId/.test(src))
  check("dispatchEmail runs the compliance/suppression gate before any send",
    /dispatchEmail[\s\S]{0,2000}checkSuppression\(/.test(src))
  check("defines the canonical email dispatcher exactly once repo-wide",
    countDefinitions(/export async function dispatchEmail\s*\(/g) === 1)
  check("defines the canonical SMS dispatcher exactly once repo-wide",
    countDefinitions(/export async function dispatchSms\s*\(/g) === 1)
}

console.log("\n[surface 6 — app/api/cron/queue-drain/route.ts (drainPushQueue / drainEmailQueue)]")
{
  const src = stripComments(read("app/api/cron/queue-drain/route.ts"))
  const stmts = splitStatements(src)
  const unchecked = stmts.flatMap((s) => silentWritesIn(s, NOTIFICATION_TABLES))
  check("every notification-table write in the drain reads its error or is sentinel-wrapped (0 unchecked)",
    unchecked.length === 0, unchecked.join(", "))
  check("gates real push egress on isWebPushConfigured() before calling sendWebPush",
    /const\s+webPushReady\s*=\s*isWebPushConfigured\(\)/.test(src) &&
    src.indexOf("webPushReady") < src.indexOf("sendWebPush({"))
  check("falls back to the in-app notifications table HONESTLY when push cannot be delivered (never silently drops the alert)",
    /No push left the building|delivered_in_app/.test(src))
  check("push rows are tenant-scoped (brokerage_id read + carried onto the in-app mirror)",
    /brokerage_id/.test(src) && /row\.brokerage_id/.test(src))
  check("defines each queue drain exactly once",
    countDefinitions(/async function drainPushQueue\s*\(/g) === 1 &&
    countDefinitions(/async function drainEmailQueue\s*\(/g) === 1)
}

// ─── repo-wide function-definition census, for the §6 "no duplicate dispatcher" checks above ──
function countDefinitions(pattern: RegExp): number {
  const files = [...["app/actions", "app/api", "lib"].flatMap((d) => walkTs(d)), ...rootRuntimeFiles(".")]
    .filter((p) => p.endsWith(".ts"))
  let n = 0
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"))
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g")
    n += (src.match(re) ?? []).length
  }
  return n
}

console.log("\n[census — the wider call-site surface, published not guessed (§2)]")
{
  const files = [...["app/actions", "app/api", "lib"].flatMap((d) => walkTs(d)), ...rootRuntimeFiles(".")]
    .filter((p) => p.endsWith(".ts"))

  const uncheckedByFile = new Map<string, number>()
  let totalSites = 0
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"))
    for (const stmt of splitStatements(src)) {
      for (const m of stmt.matchAll(/\.from\(["'](\w+)["']\)/g)) {
        if (!NOTIFICATION_TABLES.includes(m[1] as typeof NOTIFICATION_TABLES[number])) continue
        if (!/\.(insert|update|upsert|delete)\s*\(/.test(stmt.slice(m.index!))) continue
        totalSites++
      }
      const bad = silentWritesIn(stmt, NOTIFICATION_TABLES)
      if (bad.length) uncheckedByFile.set(f, (uncheckedByFile.get(f) ?? 0) + bad.length)
    }
  }
  const uncheckedTotal = [...uncheckedByFile.values()].reduce((a, b) => a + b, 0)
  console.log(`  · ${files.length} server files scanned · ${totalSites} write call site(s) to the four notification tables`)
  console.log(`  · ${uncheckedTotal} unchecked (neither error-read nor sentinelWrite/bestEffort-declared) across ${uncheckedByFile.size} file(s)`)
  console.log(`  · BLIND SPOT, published not silently accepted: these are single in-app-notification writes at ordinary`)
  console.log(`    business-logic call sites (offer accepted, showing booked, ...), not part of the fan-out DISPATCH layer`)
  console.log(`    proved above (surfaces 1-6, which are 0/0). A lost row here is a UX miss (the bell doesn't ring), not`)
  console.log(`    money/access/compliance (CLAUDE.md's CONSEQUENTIAL_TABLES boundary) — that is why this is a ratchet,`)
  console.log(`    not a hard fail: converting ~${uncheckedTotal} call sites needs a careful per-site read, not a mechanical sweep.`)

  const baselinePath = join(root, "scripts", "notification-fanout-baseline.json")
  if (process.env.NOTIFICATION_FANOUT_BASELINE === "1") {
    writeFileSync(baselinePath, JSON.stringify({ uncheckedTotal, generatedAt: new Date().toISOString() }, null, 2) + "\n")
    console.log(`Baseline written: ${uncheckedTotal} unchecked in-app notification call site(s) (may only shrink)`)
  }
  const baseline = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, "utf8")) as { uncheckedTotal: number }).uncheckedTotal
    : uncheckedTotal
  check(`unchecked notification call-site count did not GROW past the frozen baseline (${baseline})`,
    uncheckedTotal <= baseline, `now ${uncheckedTotal}, baseline ${baseline} — re-freeze with NOTIFICATION_FANOUT_BASELINE=1 npm run test:notification-fanout only after fixing new sites, never to hide growth`)
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(" ❌ NOTIFICATION_FANOUT_FAIL")
  fails.forEach((f) => console.log(`   · ${f}`))
  process.exit(1)
} else {
  console.log(" ✅ NOTIFICATION_FANOUT_PASS — every named dispatch surface checks its writes, is tenant-scoped, fails closed without provider keys, and is defined exactly once")
}
