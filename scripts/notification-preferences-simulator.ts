#!/usr/bin/env tsx
/**
 * scripts/notification-preferences-simulator.ts   (npm run test:notification-preferences)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUYER'S SETTINGS ARE REAL — proves the notification-preference resolver + matchers honor a
 * buyer's choices: service updates default opt-IN, marketing defaults opt-OUT, an explicit opt-out
 * suppresses, a muted channel suppresses across categories, and a corrupt blob degrades safely.
 * Pure: no I/O.
 */
import {
  resolveBuyerNotificationPreferences,
  buyerWantsNotification,
  DEFAULT_BUYER_NOTIFICATION_PREFERENCES,
} from "../lib/notifications/buyer-preferences"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Defaults — never touched settings: service on, marketing off]")
  const d = resolveBuyerNotificationPreferences(null)
  check("service categories default opt-IN", d.showing_reminders && d.offer_updates && d.document_alerts && d.weekly_digest)
  check("marketing defaults opt-OUT", d.marketing === false)
  check("email/sms channels default on, push off", d.email && d.sms && d.push === false)
  check("a never-set buyer welcomes the newsletter? NO (marketing off)", buyerWantsNotification(d, "marketing", "email") === false)
  check("a never-set buyer welcomes an offer update", buyerWantsNotification(d, "offer_updates", "email") === true)

  console.log("\n[Explicit opt-out suppresses that category]")
  const optOut = resolveBuyerNotificationPreferences({ notification_preferences: { marketing: true, weekly_digest: false } })
  check("buyer opted INTO marketing → newsletter allowed", buyerWantsNotification(optOut, "marketing", "email") === true)
  check("buyer opted OUT of weekly digest → suppressed", buyerWantsNotification(optOut, "weekly_digest", "email") === false)

  console.log("\n[A muted channel suppresses across every category]")
  const noEmail = resolveBuyerNotificationPreferences({ notification_preferences: { email: false } })
  check("email muted → offer update on email suppressed", buyerWantsNotification(noEmail, "offer_updates", "email") === false)
  check("email muted → same category on sms still allowed", buyerWantsNotification(noEmail, "offer_updates", "sms") === true)
  check("category check without a channel ignores channel mute", buyerWantsNotification(noEmail, "offer_updates") === true)

  console.log("\n[Robust against bad input — a read error never silently drops a deal-critical update]")
  check("string JSON blob parses", resolveBuyerNotificationPreferences(JSON.stringify({ notification_preferences: { sms: false } })).sms === false)
  check("garbage string → safe defaults", JSON.stringify(resolveBuyerNotificationPreferences("{not json")) === JSON.stringify(DEFAULT_BUYER_NOTIFICATION_PREFERENCES))
  check("non-boolean values ignored (fall back to default)", resolveBuyerNotificationPreferences({ notification_preferences: { marketing: "yes" } }).marketing === false)
  check("result is always TOTAL (every key present)", Object.keys(resolveBuyerNotificationPreferences({})).length === Object.keys(DEFAULT_BUYER_NOTIFICATION_PREFERENCES).length)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ NOTIFICATION_PREFERENCES_FAIL"); process.exit(1) }
  console.log(" ✅ NOTIFICATION_PREFERENCES_PASS — the buyer's settings panel is enforced, not cosmetic")
}

main()
