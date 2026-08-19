#!/usr/bin/env tsx
/**
 * scripts/outcome-reconciliation-simulator.ts (npm run test:outcome-reconciliation)
 * ─────────────────────────────────────────────────────────────────────────────
 * "SENT" WAS NEVER CHECKED AGAINST THE PROVIDER — ON THE TWO LANES THAT COST MONEY.
 *
 * Every manager records outcomes, and those records drive the seller report, the
 * campaign ROI board, the ISA's touch caps, the de-conflict allowance and the
 * broker's willingness to switch autonomy on. The audit found:
 *
 *   email        RECONCILED already — SendGrid Event Webhook, exact sg_message_id.
 *   video render RECONCILED already — the poll-did-avatars cron on provider_status.
 *   SMS          NOT reconciled. dispatchSms returned success on Twilio's "queued"
 *                and DISCARDED the returned status. No StatusCallback was registered
 *                and no webhook existed, so a carrier rejection — landline,
 *                disconnected, blocked, spam-filtered — was never learned, and every
 *                text read as sent forever.
 *   direct mail  NOT reconciled. lob_order_id was already stored by five writers and
 *                Lob's tracking was never read, so a re-routed or returned-to-sender
 *                piece stayed "sent" for good.
 *
 * This is a truthfulness failure, not a missing feature: an autonomous team whose
 * proxy ("I wrote sent") drifts from its true objective ("the client received it") is
 * the textbook reward-misalignment mode, and the broker cannot see it because both
 * states look identical in the database.
 *
 * The verdict core is PURE and each provider's own vocabulary is mapped verbatim —
 * which is where the interesting assertions are. Twilio's "sent" is IN-FLIGHT, not
 * delivery: treating the carrier hand-off as arrival is the original mistake. Lob's
 * re_routed is in-flight (USPS forwarded it) while returned_to_sender contradicts. An
 * unmodelled status resolves to pending rather than guessed, because a fabricated
 * proof in the ledger is worse than an honest "not yet".
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  TRUTH_SOURCES, OVERDUE_HOURS,
  reconcile, isVerifiable, isOverdue, summarizeReconciliations,
  type OutcomeChannel, type ReconciliationVerdict,
} from "../lib/outcomes/reconciliation"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { classifyCoordination } from "../lib/kernel/coordination-kind"
import { MAINTENANCE_DOMAINS, MANAGERS } from "../lib/kernel/manager-registry"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")

console.log("══════════════════════════════════════════════════")
console.log(" Outcome reconciliation — the OS proves it, or says it cannot")
console.log("══════════════════════════════════════════════════")

const CHANNELS = Object.keys(TRUTH_SOURCES) as OutcomeChannel[]
const claim = (channel: OutcomeChannel, claimedStatus = "sent", claimedAt = "2026-07-30T00:00:00Z") =>
  ({ channel, providerRef: "ref_1", claimedStatus, claimedAt })
const truth = (status: string, at = "2026-07-30T01:00:00Z") => ({ status, at })

console.log("\n[every lane declares WHERE its truth comes from]")
{
  check(`all ${CHANNELS.length} lanes have a declared truth source spec`,
    CHANNELS.every((c) => !!TRUTH_SOURCES[c].why))
  check("the lane that was already reconciled names its real mechanism",
    TRUTH_SOURCES.email.source === "sendgrid.event_webhook")
  // `video` is deliberately NOT a lane here. D-ID render status answers "did the
  // video get MADE", which is production, not delivery; a finished render nobody
  // received must never read as a landed outcome. A reel's outcome is the
  // outcome of the email / SMS / portal push that carried it.
  check("video is not a delivery lane",
    !(CHANNELS as readonly string[]).includes("video"))
  check("the lane we own end to end names our OWN ledger as the authority",
    TRUTH_SOURCES.in_app.source === "notifications.delivered_at")
  check("a correlatable-but-unwired lane says so rather than assuming delivery",
    TRUTH_SOURCES.voice_drop.source === null &&
    TRUTH_SOURCES.voice_drop.why.includes("no provider callback"))
  check("…and the two that were NOT now name theirs",
    TRUTH_SOURCES.sms.source === "twilio.status_callback" &&
    TRUTH_SOURCES.direct_mail.source === "lob.event_webhook")
  check("a lane with no source resolves to UNVERIFIABLE, never to confirmed",
    CHANNELS.every((c) => isVerifiable(c) || reconcile(claim(c), null).verdict === "unverifiable"))
  check("no lane's status sets overlap — a status cannot both confirm and contradict",
    CHANNELS.every((c) => {
      const s = TRUTH_SOURCES[c]
      const all = [...s.confirms, ...s.contradicts, ...s.inFlight].map((x) => x.toLowerCase())
      return new Set(all).size === all.length
    }))
  // The invariant is about VERIFIABLE lanes: if a lane claims a truth source, that
  // source must be able to say no. A lane with no source declares no statuses at
  // all and resolves to `unverifiable` — it is not a lane that "can only succeed",
  // it is a lane that never claims success in the first place.
  check("every VERIFIABLE lane can be contradicted — a lane that can only succeed proves nothing",
    CHANNELS.filter(isVerifiable).every((c) => TRUTH_SOURCES[c].contradicts.length > 0))
  check("an unverifiable lane declares NO statuses at all, so it cannot imply success",
    CHANNELS.filter((c) => !isVerifiable(c)).every((c) => {
      const s = TRUTH_SOURCES[c]
      return s.confirms.length === 0 && s.contradicts.length === 0 && s.inFlight.length === 0
    }))
}

console.log("\n[TWILIO'S 'sent' IS NOT DELIVERY — the original mistake]")
{
  // THE assertion. dispatchSms recorded Twilio's accept response and stopped.
  const handedToCarrier = reconcile(claim("sms", "queued"), truth("sent"))
  check("Twilio 'sent' resolves to PENDING, not confirmed",
    handedToCarrier.verdict === "pending", handedToCarrier.verdict)
  check("…and says why, so nobody re-reads it as success",
    /still in flight, not delivery/.test(handedToCarrier.explanation))
  check("'queued' and 'accepted' are in-flight too",
    reconcile(claim("sms"), truth("queued")).verdict === "pending" &&
    reconcile(claim("sms"), truth("accepted")).verdict === "pending")
  check("ONLY 'delivered' confirms an SMS",
    TRUTH_SOURCES.sms.confirms.length === 1 && TRUTH_SOURCES.sms.confirms[0] === "delivered")
  check("…and it does confirm", reconcile(claim("sms"), truth("delivered")).verdict === "confirmed")

  for (const bad of ["undelivered", "failed", "canceled"]) {
    const r = reconcile(claim("sms"), truth(bad))
    check(`Twilio '${bad}' CONTRADICTS the claim`, r.verdict === "contradicted")
    check(`…and raises a manager, because we told the brokerage it went`, r.needsManager)
  }
  check("the contradiction names both sides, so the message is actionable",
    /recorded "sent"/.test(reconcile(claim("sms"), truth("failed")).explanation) &&
    /did not land/.test(reconcile(claim("sms"), truth("failed")).explanation))
}

console.log("\n[a Lob ACCEPT is not a delivery, and re_routed is not a failure]")
{
  check("processed_for_delivery confirms",
    reconcile(claim("direct_mail"), truth("postcard.processed_for_delivery")).verdict === "confirmed")
  check("returned_to_sender CONTRADICTS and raises a manager",
    reconcile(claim("direct_mail"), truth("postcard.returned_to_sender")).verdict === "contradicted" &&
    reconcile(claim("direct_mail"), truth("letter.returned_to_sender")).needsManager)
  // The nuance that would be easy to get wrong: USPS forwarding is not failure.
  check("re_routed is IN-FLIGHT — the USPS forwarded it, it did not fail",
    reconcile(claim("direct_mail"), truth("postcard.re_routed")).verdict === "pending")
  check("in_transit and in_local_area are in-flight",
    reconcile(claim("direct_mail"), truth("letter.in_transit")).verdict === "pending" &&
    reconcile(claim("direct_mail"), truth("postcard.in_local_area")).verdict === "pending")
  check("a render failure (deleted) contradicts — the piece never existed",
    reconcile(claim("direct_mail"), truth("postcard.deleted")).verdict === "contradicted")
  check("all three piece types are covered, not just postcards",
    ["postcard", "letter", "self_mailer"].every((t) =>
      TRUTH_SOURCES.direct_mail.confirms.some((c) => c.startsWith(t)) &&
      TRUTH_SOURCES.direct_mail.contradicts.some((c) => c.startsWith(t))))
}

console.log("\n[nothing is ever guessed]")
{
  const none = reconcile(claim("sms"), null)
  check("no provider report → PENDING, never confirmed", none.verdict === "pending" && !none.needsManager)
  check("…and it says the provider has not reported, rather than implying success",
    /has not reported yet/.test(none.explanation))

  const unknown = reconcile(claim("sms"), truth("carrier_did_something_new"))
  check("an UNMODELLED provider status is pending, not guessed either way",
    unknown.verdict === "pending")
  check("…and says so plainly, so the gap is visible rather than silent",
    /does not model yet/.test(unknown.explanation))
  check("…and never raises a manager on a status we do not understand", !unknown.needsManager)

  check("provider status is matched case-insensitively (providers are inconsistent)",
    reconcile(claim("sms"), truth("DELIVERED")).verdict === "confirmed" &&
    reconcile(claim("sms"), truth(" delivered ")).verdict === "confirmed")
  check("the provider's verbatim status is carried through, never normalised away",
    reconcile(claim("sms"), truth("DELIVERED")).providerStatus === "DELIVERED")
}

console.log("\n[silence is itself a finding]")
{
  // A provider that never reports is indistinguishable from a lost message unless
  // somebody counts the clock.
  check("the overdue windows match how each provider actually behaves",
    OVERDUE_HOURS.sms === 6 && OVERDUE_HOURS.email === 24 && OVERDUE_HOURS.direct_mail === 24 * 14)
  check("…direct mail is allowed WEEKS, because a physical piece takes them",
    OVERDUE_HOURS.direct_mail > OVERDUE_HOURS.sms * 50)
  const now = new Date("2026-07-30T12:00:00Z")
  check("an SMS unreported for 8h is overdue", isOverdue("sms", "2026-07-30T03:00:00Z", now))
  check("…one from 2h ago is not", !isOverdue("sms", "2026-07-30T10:00:00Z", now))
  check("a postcard from 3 days ago is NOT overdue", !isOverdue("direct_mail", "2026-07-27T12:00:00Z", now))
  check("an unparseable timestamp is never called overdue (no invented findings)",
    !isOverdue("sms", "not-a-date", now))
}

console.log("\n[the proven rate cannot be inflated by pending]")
{
  const rows: Array<{ verdict: ReconciliationVerdict }> = [
    { verdict: "confirmed" }, { verdict: "confirmed" }, { verdict: "confirmed" },
    { verdict: "contradicted" },
    { verdict: "pending" }, { verdict: "pending" }, { verdict: "pending" }, { verdict: "pending" },
    { verdict: "unverifiable" },
  ]
  const s = summarizeReconciliations(rows)
  check("counts are kept SEPARATE — pending is never folded into confirmed",
    s.confirmed === 3 && s.contradicted === 1 && s.pending === 4 && s.unverifiable === 1)
  check("the proven rate is over DECIDED outcomes only (3 of 4 = 75%)",
    s.provenRatePct === 75, String(s.provenRatePct))
  check("…so four unreported sends cannot make it look better than it is",
    s.provenRatePct !== Math.round((3 / 9) * 1000) / 10 && s.provenRatePct === 75)
  check("no decided outcomes → NULL, not a flattering 100%",
    summarizeReconciliations([{ verdict: "pending" }]).provenRatePct === null)
  check("an empty ledger is null too, never zero-implies-failure",
    summarizeReconciliations([]).provenRatePct === null)
}

console.log("\n[the truth can actually ARRIVE — the intakes exist]")
{
  // A reconciliation layer with no way to hear from the provider proves nothing.
  const adapter = src("lib/providers/messaging/sms-adapters.ts")
  check("Twilio sends now register a StatusCallback", /StatusCallback/.test(adapter))
  check("…pointing at the webhook this build added",
    /webhooks\/twilio-sms-status/.test(adapter))
  check("…and omitted when there is no public URL, rather than pointing at localhost",
    /localhost/.test(adapter) && /return null/.test(adapter))

  const twilioHook = src("app/api/webhooks/twilio-sms-status/route.ts")
  check("the Twilio status webhook exists", twilioHook.length > 0)
  check("…secret-gated, unset = 404 (never a silently-open endpoint)",
    /TWILIO_STATUS_WEBHOOK_SECRET/.test(twilioHook) && /status: 404/.test(twilioHook))
  check("…correlates EXACTLY on MessageSid, no fuzzy matching",
    /MessageSid/.test(twilioHook) && /providerRef: sid/.test(twilioHook))
  // Caught by test:schema-drift, not by review: the first draft filtered on
  // messages.provider_message_id — a column messages does not have (only metadata
  // jsonb). It would have matched nothing and mirrored no status, silently.
  // Comment-stripped: the fix DOCUMENTS the dead column by name, so a raw search
  // trips on the very explanation that proves the code no longer uses it.
  const twilioCode = twilioHook
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n")
  check("…mirrors onto messages via metadata containment, the column that EXISTS",
    /contains\("metadata", \{ twilio_sid: sid \}\)/.test(twilioCode) &&
    !/provider_message_id/.test(twilioCode))
  check("…and the sender STORES that key, or the truth would have nothing to attach to",
    /twilio_sid: providerMessageId/.test(src("lib/kernel/communications.ts")))
  // test:tenant-scope refused the unscoped read. Platform Twilio runs as
  // SUBACCOUNTS under one master, so two tenants can share an account and "a sid is
  // globally unique" is not a tenancy boundary. The ledger row is the authority.
  check("…scoped by the brokerage from the LEDGER, never trusted from the provider",
    /eq\("brokerage_id", recon\.brokerageId\)/.test(twilioCode))
  check("…and no claim means no mirror at all, rather than a cross-tenant guess",
    /mapped && recon\.brokerageId/.test(twilioCode))
  check("the ledger returns that owner deliberately, with the reason recorded",
    /is not a tenancy boundary/.test(src("lib/outcomes/reconciliation-ledger.ts")))
  check("…always ACKs, so one bad row cannot lose every other message's truth",
    /ok: true, ignored/.test(twilioHook))
  check("…and never downgrades a delivered message to sent",
    /Never downgrade/.test(twilioHook))

  const lobHook = src("app/api/webhooks/lob-events/route.ts")
  check("the Lob event webhook exists", lobHook.length > 0)
  check("…secret-gated the same way",
    /LOB_WEBHOOK_SECRET/.test(lobHook) && /status: 404/.test(lobHook))
  check("…and only mirrors TERMINAL events onto the campaign, not every hop",
    /campaignStatusFor/.test(lobHook) && /return null/.test(lobHook))
  check("…keyed on lob_order_id, the column five writers already populate",
    /lob_order_id/.test(lobHook))

  const dispatch = src("lib/providers/dispatch.ts")
  check("dispatchSms opens a PENDING claim on the Twilio sid",
    /channel: "sms"/.test(dispatch) && /recordOutcomeClaim/.test(dispatch))
  check("…recording the PROVIDER's word for the state, not our optimistic label",
    /claimedStatus: raw\.status \?\? "queued"/.test(dispatch))
  check("dispatchDirectMail opens one on the Lob piece id",
    /channel: "direct_mail"/.test(dispatch) && /accepted_by_lob/.test(dispatch))
  check("…and neither can fail the send it is recording",
    /must never fail a send/.test(dispatch) || /\)\(\)\.catch\(\(\) => \{\}\)/.test(dispatch))
}

console.log("\n[the ledger holds ONE row per touch and never walks backwards]")
{
  const ledger = src("lib/outcomes/reconciliation-ledger.ts")
  check("the write side exists", ledger.length > 0)
  check("a claim opens PENDING — handing over is not proof",
    /verdict: ReconciliationVerdict = spec\.source === null \? "unverifiable" : "pending"/.test(ledger))
  check("repeat provider reports UPDATE one row (upsert on channel+provider_ref)",
    /onConflict: "channel,provider_ref"/.test(ledger))
  check("a TERMINAL verdict is never downgraded by a late in-flight event",
    /already terminal — late in-flight event ignored/.test(ledger))
  check("an unknown provider reference is NOT invented into a claim",
    /not ours to record/.test(ledger))
  check("neither entry point throws — a send already happened, a webhook must ACK",
    /Never throws/.test(ledger))

  const vocab = CHECK_VOCABULARIES.outcome_reconciliations
  check("the live CHECK admits exactly the four verdicts",
    !!vocab?.verdict &&
    [...vocab.verdict].sort().join(",") === "confirmed,contradicted,pending,unverifiable",
    (vocab?.verdict ?? []).join(","))
  // WAS "exactly the five channels … direct_mail,email,sms,social,video". That
  // asserted a fiction: the live CHECK has never admitted `video` and does admit
  // `in_app` and `voice_drop` (m-wave "video is a payload, voice_drop + in_app
  // are the missing channels"). The assertion passed only because the vocabulary
  // cache it reads was hand-maintained and stale — regenerating that cache from
  // the database is what exposed it.
  check("…and exactly the six channels the database admits",
    !!vocab?.channel &&
    [...vocab.channel].sort().join(",") === "direct_mail,email,in_app,sms,social,voice_drop",
    (vocab?.channel ?? []).join(","))
}

console.log("\n[the loop closes: a false claim reaches the manager that made it]")
{
  const ledger = src("lib/outcomes/reconciliation-ledger.ts")
  check("outcome_contradicted is catalogued on the bus",
    "outcome_contradicted" in SIGNAL_REGISTRY)
  const spec = SIGNAL_REGISTRY.outcome_contradicted
  check("…as an alert, matching the live classifier",
    spec?.kind === "alert" && classifyCoordination("outcome_contradicted") === "alert")
  check("…feed_only, because what to do about it is a relationship judgement",
    spec?.disposition === "feed_only" &&
    /relationship judgement/.test(spec?.what ?? ""))
  check("it routes to the manager that MADE the claim",
    /toManager: claimer/.test(ledger))
  check("…and never a manager to itself",
    /claimer === "data_steward" \? "cron_manager" : "data_steward"/.test(ledger))
  check("raised ONCE per touch — escalated_at guards a re-sent failure event",
    /!row\.escalated_at/.test(ledger) && /escalated_at: new Date/.test(ledger))
  check("entity_id carries the claim's own uuid, never the provider's string ref",
    /entityId: row\.entity_id/.test(ledger) && /never the provider's string reference/.test(ledger))

  const domain = MAINTENANCE_DOMAINS.outcome_reconciliation
  check("a manager owns the whole feature", domain?.manager === "compliance_officer")
  check("…and that manager is a real seat", (domain?.manager ?? "") in MANAGERS)
  check("…proved by this script", domain?.proof === "test:outcome-reconciliation")
}

console.log("\n[a human can see it]")
{
  const panel = src("app/dashboard/system/components/os/outcome-proof-panel.tsx")
  check("the proof panel exists", panel.length > 0)
  check("…reads the ledger, not the managers' own records",
    /loadReconciliations/.test(panel))
  check("…shows the four verdicts separately",
    /confirmed', 'contradicted', 'pending', 'unverifiable'/.test(panel))
  check("…says plainly that pending is not success",
    /are not counted as successes/.test(panel))
  check("…lists what did NOT reach the client",
    /These did not reach the client/.test(panel))
  check("…and shows which lanes can be proven at all",
    /How each lane is proven/.test(panel) && /no proof source/.test(panel))
  check("it is actually mounted",
    /OutcomeProofPanel/.test(src("app/dashboard/system/page.tsx")) &&
    /OutcomeProofPanel/.test(src("app/dashboard/system/components/os/index.ts")))
  check("package.json wires this proof", /test:outcome-reconciliation/.test(src("package.json")))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ OUTCOME_RECONCILIATION_FAIL"); process.exit(1) }
console.log(" ✅ OUTCOME_RECONCILIATION_PASS — the claim is proven, contradicted, or honestly pending")
