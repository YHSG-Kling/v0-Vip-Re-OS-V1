#!/usr/bin/env tsx
/**
 * scripts/deconflict-channel-simulator.ts   (npm run test:deconflict-channel) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OVER-TOUCH CAP COULD NOT COUNT THE TWO CHANNELS THAT MATTER MOST.
 *
 * The de-confliction engine is the one gate that stops the platform's lanes
 * over-contacting a person. It has its OWN channel names (email|sms|phone|mail)
 * and sums touches across three ledgers, each of which spells its channels
 * differently under its own CHECK:
 *
 *   isa_outreach_log               … voice, direct_mail   (NOT phone, NOT mail)
 *   marketing_campaign_touchpoints … phone, direct_mail   (NOT mail)
 *   lifetime_customer_touchpoints  … call,  direct_mail   (NOT phone, NOT mail)
 *
 * Only ONE pair was ever translated (mail → direct_mail, and only on the lead
 * side). Everywhere else the engine's own word went straight into the filter.
 * A filter on a value a column cannot hold returns zero rows — and on an
 * over-touch cap a zero is not an error, it is a PERMISSION:
 *
 *   · phone — countPhoneTouches asked isa_outreach_log for channel='phone'.
 *     Always 0, so "1 call / 7 days" could never fire. It also never queried
 *     lifetime_customer_touchpoints at all.
 *   · mail  — countMailTouches asked BOTH touchpoint tables for channel='mail'.
 *     Always 0, so only direct_mail_recipients counted toward "1 piece / 30
 *     days".
 *
 * email / sms spell the same in every table, which is why half the lanes worked
 * and the failure looked like ordinary quiet.
 *
 * ── AND A FIFTH CHANNEL THAT WAS NEVER A CHANNEL ────────────────────────────
 * The engine also carried a "video" channel. Video is NOT a lane — the lanes are
 * email / phone / voicedrop / in-app / sms / blog / direct mail / ad / newsletter
 * / podcast, and a video is DELIVERED IN an sms or an email. dispatchVideo takes
 * a recipientEmail and sends over email, so its cap now spends the recipient's
 * EMAIL allowance. Before, it charged an imaginary video budget and the real
 * email lane went uncounted for that send.
 *
 * VERIFIED LIVE: each engine word was rejected by the NAMED channel constraint
 * on each ledger (isa_outreach_log_channel_check,
 * marketing_campaign_touchpoints_channel_check,
 * past_client_touchpoints_channel_check — attributed via CONSTRAINT_NAME, not
 * just "some check failed"), every mapped word inserted, and against six real
 * touches the OLD phone filter counted 0 where the NEW one counts 3, and the OLD
 * mail filter counted 0 where the NEW one counts 3. Probes deleted, counts back
 * to 0.
 *
 * ── TWO MORE DEAD FILTERS IN THE SAME CLASS ─────────────────────────────────
 * contacts.buyer_stage is a thirteen-state BUYER_* ladder. Two server-side
 * consumers used other words entirely:
 *   · the AI-ISA showing_feedback campaign filtered buyer_stage='toured'
 *     (the state is BUYER_TOURING) — it could never find one contact to ask;
 *   · calculateAllBuyerFatigue selected buyer_stage IN (ten lowercase names:
 *     prospect, touring, tour_completed, …). NOT ONE is admitted, so the batch
 *     fatigue sweep has never processed a contact.
 * The second lived in a local `const`, so the CHECK-vocabulary guard — which
 * reads inline literals only — could not see it. That is why lib/contacts/
 * buyer-stage.ts exists rather than a one-line edit: a shared, guarded module is
 * the only thing that makes a drifted SET visible.
 */
import { readFileSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  DECONFLICT_CHANNELS, TOUCH_SOURCE_TABLES, sourceChannel, leadLogChannel,
  type DeconflictChannel, type TouchSourceTable,
} from "../lib/kernel/deconflict/lead-channel"
import {
  BUYER_STAGES, BUYER_ACTIVE_STAGES, BUYER_INACTIVE_STAGES,
  BUYER_SHOWING_FEEDBACK_STAGE, isBuyerStage,
} from "../lib/contacts/buyer-stage"
import { AD_CAMPAIGN_STATUSES, AD_CAMPAIGN_RUNNING_STATUSES } from "../lib/integrations/ad-campaign-vocabulary"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  stripComments(readFileSync(p, "utf8"))

const liveChannel = (t: TouchSourceTable): readonly string[] =>
  (CHECK_VOCABULARIES as any)[t]?.channel ?? []

console.log("══════════════════════════════════════════════════")
console.log(" De-confliction channels (the cap can actually count)")
console.log("══════════════════════════════════════════════════")

console.log("\n── every mapped value is one its OWN table admits ──")
{
  for (const table of TOUCH_SOURCE_TABLES) {
    const live = liveChannel(table)
    check(`${table} has a live channel vocabulary (${live.length})`, live.length > 0)
    for (const ch of DECONFLICT_CHANNELS) {
      const mapped = sourceChannel(table, ch)
      check(`${table}: '${ch}' → '${mapped}' is admitted`,
        mapped === null || live.includes(mapped))
    }
  }
}

console.log("\n── the engine's own words are NOT storable — that was the bug ──")
{
  check("isa_outreach_log cannot hold 'phone' (it says 'voice')",
    !liveChannel("isa_outreach_log").includes("phone") &&
    sourceChannel("isa_outreach_log", "phone") === "voice")
  check("lifetime_customer_touchpoints cannot hold 'phone' (it says 'call')",
    !liveChannel("lifetime_customer_touchpoints").includes("phone") &&
    sourceChannel("lifetime_customer_touchpoints", "phone") === "call")
  check("marketing_campaign_touchpoints DOES say 'phone' — the map is per table",
    liveChannel("marketing_campaign_touchpoints").includes("phone") &&
    sourceChannel("marketing_campaign_touchpoints", "phone") === "phone")
  for (const t of TOUCH_SOURCE_TABLES) {
    check(`${t} cannot hold 'mail' (it says 'direct_mail')`,
      !liveChannel(t).includes("mail") && sourceChannel(t, "mail") === "direct_mail")
  }
  check("email / sms are the same word everywhere — why half the lanes worked",
    (["email", "sms"] as DeconflictChannel[]).every((ch) =>
      TOUCH_SOURCE_TABLES.every((t) => sourceChannel(t, ch) === ch)))
}

console.log("\n── video is NOT a channel (owner ruling) ──")
{
  // The channels are email / phone / voicedrop / in-app / sms / blog / direct
  // mail / ad / newsletter / podcast. A VIDEO IS DELIVERED IN an sms or an
  // email — it is a payload, not a lane. The engine had a fifth channel named
  // "video" whose cap counted an imaginary budget while the real email lane
  // that actually carried the send went uncounted for that send.
  check("the engine has exactly four channels", DECONFLICT_CHANNELS.length === 4)
  check("'video' is not one of them",
    !(DECONFLICT_CHANNELS as readonly string[]).includes("video"))

  const lc = src("lib/kernel/deconflict/lead-channel.ts")
  check("no channel type still declares video", !/"video"/.test(lc))
  const d = src("lib/kernel/deconflict/index.ts")
  check("the policy table has no video entry", !/^\s*video:\s*\{/m.test(d))
  check("countVideoTouches is gone", !/countVideoTouches/.test(d))

  // A video send spends the allowance of whatever CARRIED it. dispatchVideo
  // takes a recipientEmail, so it consumes email.
  const dp = src("lib/providers/dispatch.ts")
  check("dispatchVideo no longer gates on a 'video' channel",
    !/channel:\s*"video"/.test(dp))
  check("dispatchVideo still gates — it is not simply uncapped",
    /export async function dispatchVideo[\s\S]*?deconflictGate\(\{[\s\S]*?channel:\s*"email"/.test(dp))
  check("…and it is still the video PROVIDER that renders it",
    /providerType:\s*"video"/.test(dp))
}

console.log("\n── the lead-side helper is the same map, not a second one ──")
{
  for (const ch of DECONFLICT_CHANNELS) {
    check(`leadLogChannel('${ch}') agrees with the isa_outreach_log row`,
      leadLogChannel(ch) === sourceChannel("isa_outreach_log", ch))
  }
}

console.log("\n── the engine routes every counter through the map ──")
{
  const d = src("lib/kernel/deconflict/index.ts")
  check("a per-table counter exists", /function countLedger\(/.test(d))
  check("…and it translates before filtering", /sourceChannel\(table, channel\)/.test(d))
  check("…and SKIPS rather than filtering on null", /if \(value === null\) return 0/.test(d))
  check("no counter still hardcodes the engine's word for phone",
    !/\.eq\("channel", "phone"\)/.test(d))
  check("no counter still hardcodes the engine's word for mail",
    !/\.eq\("channel", "mail"\)/.test(d))
  check("phone now sums every ledger", /countLedgerTouches\(svc, "phone"/.test(d))
  check("mail now sums every ledger", /countLedgerTouches\(svc, "mail"/.test(d))
  check("the channel-implicit tables are still counted directly",
    /from\("email_sends"\)/.test(d) && /from\("direct_mail_recipients"\)/.test(d))
}

console.log("\n── contacts.buyer_stage: two consumers off the ladder entirely ──")
{
  const live = CHECK_VOCABULARIES.contacts?.buyer_stage ?? []
  check(`the ladder is ${live.length} BUYER_* states`, live.length === BUYER_STAGES.length)
  check("every declared stage is admitted", BUYER_STAGES.every((s) => live.includes(s)))
  check("every admitted stage is declared", live.every((s) => (BUYER_STAGES as readonly string[]).includes(s)))
  check("'toured' is not a stage — the AI-ISA campaign asked for it", !live.includes("toured"))
  check("the showing-feedback stage IS admitted", live.includes(BUYER_SHOWING_FEEDBACK_STAGE))
  check("none of the ten lowercase names the fatigue sweep used are admitted",
    ["prospect", "pre_approval_pending", "financially_verified", "search_configured",
     "searching", "touring", "tour_completed", "offer_strategy", "offer_submitted",
     "buyer_under_contract"].every((s) => !live.includes(s)))
  check("ACTIVE is the complement of INACTIVE — a new stage counts as active",
    BUYER_ACTIVE_STAGES.length === BUYER_STAGES.length - BUYER_INACTIVE_STAGES.length &&
    BUYER_ACTIVE_STAGES.every((s) => !(BUYER_INACTIVE_STAGES as readonly string[]).includes(s)))
  check("every active stage is admitted", BUYER_ACTIVE_STAGES.every((s) => live.includes(s)))
  check("the guard rejects the drifted spellings", !isBuyerStage("toured") && !isBuyerStage("touring"))

  const isa = src("lib/application/ai-isa.ts")
  check("the ISA campaign uses the shared stage",
    /BUYER_SHOWING_FEEDBACK_STAGE/.test(isa) && !/"toured"/.test(isa))
  const fat = src("lib/fatigue/fatigue-calculator.ts")
  check("the fatigue sweep uses the shared active set",
    /BUYER_ACTIVE_STAGES/.test(fat) && !/"tour_completed"/.test(fat))
}

console.log("\n── ad_campaigns.status: the dead 'active' rider ──")
{
  const live = CHECK_VOCABULARIES.ad_campaigns?.status ?? []
  check("the ladder is the eight declared statuses",
    live.length === AD_CAMPAIGN_STATUSES.length && AD_CAMPAIGN_STATUSES.every((s) => live.includes(s)))
  check("'active' is NOT one of them", !live.includes("active"))
  check("the running set is admitted", AD_CAMPAIGN_RUNNING_STATUSES.every((s) => live.includes(s)))
  check("…and includes 'launching' — committed spend the managers must see",
    (AD_CAMPAIGN_RUNNING_STATUSES as readonly string[]).includes("launching"))
  for (const f of ["lib/managers/cross-referral.ts", "lib/managers/deliberation.ts"]) {
    const t = src(f)
    check(`${f}: no ["live", "active"] literal remains`, !/\["live", "active"\]/.test(t))
    check(`${f}: uses the shared running set`, /AD_CAMPAIGN_RUNNING_STATUSES/.test(t))
  }
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ DECONFLICT_CHANNEL_FAIL"); process.exit(1) }
console.log(" ✅ DECONFLICT_CHANNEL_PASS — every lane the cap claims to count, it can count")
