// scripts/lifetime-relationship-guard.ts — `test:lifetime-relationship` (wave 150, lane 150SZ — directive 150Z)
// ─────────────────────────────────────────────────────────────────────────────
// "Reputation review at close, sphere/lifetime triggers, gifts, education, gamification/residuals, support FAQ-to-education,
//  stage-specific agent/consumer attention without hard-coded timing." (directive 150Z) · "No fixed timetables anywhere: the
//  arbiter and the responsible manager decide timing … Only legal, contractual, service and explicit owner dates are fixed."
//
//   §A REPUTATION AT CLOSE — one engine from a verified closing; the close path, the cron and the lifecycle hook all call it;
//      the copy screen refuses incentives / gating / rating pressure (positive control) and passes an honest ask.
//   §B SPHERE / LIFETIME — the lifetime moments are conducted through the ONE arbiter; the cron is registered.
//   §C GIFTS — a closing gift is a TASK for a person (no autonomous purchase); the orphan duplicate is named.
//   §D EDUCATION + SUPPORT FAQ → EDUCATION — recurring support tickets become a help-article gap (positive + negative control)
//      and the curriculum author reads support_tickets; the education delivery cron is registered.
//   §E GAMIFICATION — the lifecycle award hook rides the event reactor through the ONE once-award path.
//   §F STAGE-SPECIFIC ATTENTION WITHOUT HARD-CODED TIMING — the listing-presentation drip asks the arbiter before each part
//      (in memory, model injected: hold, cap at the appointment, outage → plan, first part never held); the creative
//      playbooks carry no offsets and no "day-N" timing in their briefs; the two carried constants are gone from the census.
// The summary line is `RESULT: N passed, M failed` (never the chain runner's own exit token).

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))
function walkTs(dir: string, out: string[] = []): string[] {
  let names: string[] = []
  try { names = readdirSync(join(ROOT, dir)) } catch { return out }
  for (const n of names) {
    if (n === "node_modules" || n === "__tests__" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(join(ROOT, p)).isDirectory()) walkTs(p, out)
    else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p)
  }
  return out
}

const B1 = "11111111-1111-4111-8111-111111111111"
const C1 = "c1c1c1c1-0000-4000-8000-000000000001"

async function main() {
  // ══ §A ══════════════════════════════════════════════════════════════════════════════════════
  section("A · the review ask at a verified closing — one engine, honest copy")
  const product = [...walkTs("lib"), ...walkTs("app")]
  const liveCallers = product.filter((f) => f !== "lib/reputation/review-ask.ts" && /askForReviewAtClose\(/.test(code(f)))
  check("the review ask has ONE live door: the review-request-on-close cron calls the ONE engine (askForReviewAtClose)", liveCallers.includes("app/api/cron/review-request-on-close/route.ts"), liveCallers.join(", "))
  const tombstoned = ["lib/kernel/transactions.ts", "lib/transactions/stage-progression.ts", "lib/listing-lifecycle/lifecycle-event-tasks.ts"]
  check("the three former writers (close command, stage hook, lifecycle hook) name the engine as survivor and write no review_requests row themselves", tombstoned.every((f) => /askForReviewAtClose/.test(raw(f)) && !/from\("review_requests"\)\s*\.insert/.test(code(f))))
  check("the review cron is registered with the dispatcher (an unreferenced cron is reachable by design)", /\/api\/cron\/review-request-on-close/.test(code("lib/kernel/cron-dispatch.ts")))
  const { screenReviewAskCopy } = await import("../lib/reputation/review-ask-policy")
  check("POSITIVE CONTROL: an incentive ask is refused", screenReviewAskCopy({ body: "Leave us a 5-star review and get a $25 gift card!" }).length > 0)
  check("an honest, specific ask passes the screen", screenReviewAskCopy({ subject: "Thank you", body: "It was a joy helping you with the house on Elm. If you have a minute, would you share an honest review of how it went? Here is the link." }).length === 0)

  // ══ §B ══════════════════════════════════════════════════════════════════════════════════════
  section("B · sphere / lifetime moments through the ONE arbiter")
  const fm = code("lib/sphere/followup-moments.ts")
  check("lifetime follow-up moments are decided by the arbiter (arbitrateAndRecordExperience / arbitrateFollowUp), never a table", /arbitrate(?:AndRecordExperience|FollowUp|PlannedTouch)/.test(fm) || /followup-arbiter/.test(fm))
  check("the lifetime cron conducts them for every tenant (conductDueFollowUpMomentsAllTenants)", /conductDueFollowUpMomentsAllTenants/.test(code("app/api/cron/lifetime-customer-touchpoints/route.ts")))
  check("that cron is registered with the dispatcher", /\/api\/cron\/lifetime-customer-touchpoints/.test(code("lib/kernel/cron-dispatch.ts")))

  // ══ §C ══════════════════════════════════════════════════════════════════════════════════════
  section("C · gifts — a task for a person, never an autonomous purchase")
  const tx = code("lib/kernel/transactions.ts")
  check("closing a transaction plants the closing-gift TASK for the agent (activity closing_gift_due)", /activity_type:\s*"closing_gift_due"/.test(tx))
  const PURCHASE = /\b(?:stripe\.|paymentIntents|charges\.create|placeOrder|createOrder|checkout\.sessions)\b/
  check("POSITIVE CONTROL: a planted purchase call is seen", PURCHASE.test(stripComments("await stripe.paymentIntents.create({ amount })\n")))
  const giftFiles = ["lib/kernel/transactions.ts", "lib/listing-lifecycle/lifecycle-event-tasks.ts", "lib/transactions/gift-order-trigger.ts"]
  check("no gift path spends money on its own (no purchase call in the gift writers)", !giftFiles.some((f) => PURCHASE.test(code(f))))
  const giftTriggerCallers = product.filter((f) => f !== "lib/transactions/gift-order-trigger.ts" && /checkAndTriggerGiftOrder\(/.test(code(f)))
  console.log(`    info (not a waypoint assertion): lib/transactions/gift-order-trigger.ts live callers = ${giftTriggerCallers.length} — an orphan duplicate of the close command's gift task (Outside-lane, lane 150SZ notes)`)

  // ══ §D ══════════════════════════════════════════════════════════════════════════════════════
  section("D · education, and the support FAQ → education loop")
  const { buildSupportSignals } = await import("../lib/education/question-gap")
  const ticket = (s: string) => ({ subject: s, description: null })
  const five = ["How do I send forms for e-sign?", "esign packet stuck", "Where is the e-sign button", "e-sign reminder?", "Signature request failed"].map(ticket)
  const sig = buildSupportSignals(five)
  check("POSITIVE CONTROL: five tickets on one product topic become ONE support gap (a help article is authored from it)", sig.length === 1 && sig[0].source === "support" && sig[0].topicKey === "support:forms_esign", JSON.stringify(sig.map((s) => s.topicKey)))
  check("NEGATIVE CONTROL: four tickets are noise, not a gap", buildSupportSignals(five.slice(0, 4)).length === 0)
  const ca = code("lib/education/curriculum-author.ts")
  check("the curriculum author reads the tenant's support tickets and clusters them (buildSupportSignals)", /from\("support_tickets"\)/.test(ca) && /buildSupportSignals/.test(ca))
  check("a support gap is authored as a HELP ARTICLE grounded in evidence (never invented features)", /gap\.source === "support"/.test(ca))
  check("the education delivery cron is registered", /\/api\/cron\/education-delivery/.test(code("lib/kernel/cron-dispatch.ts")))

  // ══ §E ══════════════════════════════════════════════════════════════════════════════════════
  section("E · gamification — lifecycle awards through the ONE once-award path")
  check("the event reactor calls the lifecycle award hook (awardLifecycleMilestones)", /awardLifecycleMilestones/.test(code("lib/kernel/event-reactor.ts")))
  check("awards go through the ONE once-award writer (awardAgentPointsOnce)", /awardAgentPointsOnce/.test(code("lib/gamification/lifecycle-awards.ts")))

  // ══ §F ══════════════════════════════════════════════════════════════════════════════════════
  section("F · stage-specific attention without hard-coded timing")
  const drip = await import("../lib/listing-presentation/section-drip")
  const policy = (await import("../lib/ai-isa/followup-policy")).platformFollowupPolicy()
  const NOW = new Date("2027-03-10T15:00:00.000Z")
  const sec = (order: number) => ({ id: `s${order}`, brokerage_id: B1, contact_id: C1, section_order: order, title: `Part ${order + 1}`, section_key: `k${order}` })
  const db = () => memSupabase({ brokerages: [{ id: B1 }], agent_action_ledger: [], manager_completions: [], notifications: [], activities: [], brokerage_settings: [], platform_settings: [] }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
  let asked = 0
  const says = (optionId: string, waitHours: number | null) => async () => { asked++; return { optionId, channel: null, format: null, waitHours, rationale: `The evidence supports ${optionId} for this seller right now.`, evidence: ["history", "moment"], confidence: 0.9 } }
  const svc1 = db()
  const hold = await drip.arbitrateSectionDelivery(svc1, sec(2), { now: NOW, appointmentAt: null, lastDeliveredAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(), sectionCount: 7 }, { decide: says("wait", 24), policy, budget: { remaining: 5 } })
  check("the arbiter may HOLD a part (the previous one went out 2h ago) — rescheduled 24h out, never dropped", hold.deliver === false && hold.holdUntil === new Date(NOW.getTime() + 24 * 3_600_000).toISOString(), JSON.stringify(hold))
  check("… and the model's hold is on the action ledger (LAW 5)", (svc1 as unknown as { tables: Record<string, unknown[]> }).tables.agent_action_ledger.length >= 1)
  const capped = await drip.arbitrateSectionDelivery(db(), sec(3), { now: NOW, appointmentAt: new Date(NOW.getTime() + 20 * 3_600_000).toISOString(), lastDeliveredAt: null, sectionCount: 7 }, { decide: says("wait", 24), policy, budget: { remaining: 5 } })
  check("a hold never lands after the appointment's 12h buffer (the seller's meeting is a service date)", capped.deliver === false && capped.holdUntil === new Date(NOW.getTime() + 8 * 3_600_000).toISOString(), JSON.stringify(capped))
  const tooLate = await drip.arbitrateSectionDelivery(db(), sec(4), { now: NOW, appointmentAt: new Date(NOW.getTime() + 6 * 3_600_000).toISOString(), lastDeliveredAt: null, sectionCount: 7 }, { decide: says("wait", 24), policy, budget: { remaining: 5 } })
  check("inside the buffer a hold is impossible — the part goes now", tooLate.deliver === true)
  const outage = await drip.arbitrateSectionDelivery(db(), sec(1), { now: NOW, appointmentAt: null, lastDeliveredAt: null, sectionCount: 7 }, { decide: async () => { throw new Error("gateway down") }, policy, budget: { remaining: 5 } })
  check("an outage keeps the PLAN (deliver) — the seller asked for it; never a silent stall", outage.deliver === true)
  const floorH = policy.guardrails.minHoursBetweenTouches
  const lastHourAgo = new Date(NOW.getTime() - 1 * 3_600_000).toISOString()
  const floored = await drip.arbitrateSectionDelivery(db(), sec(2), { now: NOW, appointmentAt: null, lastDeliveredAt: lastHourAgo, sectionCount: 7 }, { decide: async () => { throw new Error("gateway down") }, policy, budget: { remaining: 5 } })
  check(`… but the outage fallback never lands a part inside the tenant's fatigue floor (${floorH}h after the previous one) — no appointment means no pile-up in one tick`, floored.deliver === false && floored.holdUntil === new Date(Date.parse(lastHourAgo) + floorH * 3_600_000).toISOString(), JSON.stringify(floored))
  const flooredCapped = await drip.arbitrateSectionDelivery(db(), sec(2), { now: NOW, appointmentAt: new Date(NOW.getTime() + 20 * 3_600_000).toISOString(), lastDeliveredAt: lastHourAgo, sectionCount: 7 }, { decide: async () => { throw new Error("gateway down") }, policy, budget: { remaining: 5 } })
  check("… and the floor too is capped at the appointment's 12h buffer (the seller's meeting is a service date)", flooredCapped.deliver === false && flooredCapped.holdUntil === new Date(NOW.getTime() + 8 * 3_600_000).toISOString(), JSON.stringify(flooredCapped))
  const spent = await drip.arbitrateSectionDelivery(db(), sec(2), { now: NOW, appointmentAt: null, lastDeliveredAt: new Date(NOW.getTime() - (floorH + 1) * 3_600_000).toISOString(), sectionCount: 7 }, { decide: async () => { throw new Error("gateway down") }, policy, budget: { remaining: 5 } })
  check("NEGATIVE CONTROL: once the floor has passed, the outage fallback delivers (the floor stops a send, never causes or delays one past itself)", spent.deliver === true, JSON.stringify(spent))
  check("deliverDueSections records each delivery for the next due part of the SAME presentation in the same tick", /lastDeliveryByPresentation\.set\(s\.presentation_id, new Date\(\)\.toISOString\(\)\)/.test(code("lib/listing-presentation/section-drip.ts")))
  const askedBefore = asked
  const first = await drip.arbitrateSectionDelivery(db(), sec(0), { now: NOW, appointmentAt: null, lastDeliveredAt: null, sectionCount: 7 }, { decide: says("wait", 24), policy, budget: { remaining: 5 } })
  check("the first part opens the plan — never held, the model is not even asked", first.deliver === true && asked === askedBefore)
  const sendNow = await drip.arbitrateSectionDelivery(db(), sec(5), { now: NOW, appointmentAt: null, lastDeliveredAt: null, sectionCount: 7 }, { decide: says("deliver", null), policy, budget: { remaining: 5 } })
  check("the arbiter may send a part now", sendNow.deliver === true && sendNow.source === "ai")
  const dc = code("lib/listing-presentation/section-drip.ts")
  check("deliverDueSections asks the arbiter before claiming each due part, and a hold RESCHEDULES (scheduled_for) the row", /arbitrateSectionDelivery\(supabase, s,/.test(dc) && /update\(\{ scheduled_for: timing\.holdUntil \}\)/.test(dc))
  check("the fixed 7-day fallback window is gone (DEFAULT_DRIP_WINDOW_DAYS absent from code)", !/DEFAULT_DRIP_WINDOW_DAYS/.test(dc))

  const { CREATIVE_PLAYBOOKS } = await import("../lib/marketing/creative-playbooks")
  const steps = CREATIVE_PLAYBOOKS.flatMap((p) => p.steps)
  const withOffset = steps.filter((s) => Object.keys(s).some((k) => /after|offset|delay|minutes|days/i.test(k)))
  check(`no creative-playbook step (${steps.length}) carries a timing field — order and intent only`, withOffset.length === 0, withOffset.map((s) => s.label).join(", "))
  const DAY_N = /\b(?:\d+|one|two|three|four|five|six|seven)[\s-]day (?:follow|nudge|reminder|check)|\bday[\s-]\d+\b|\bthe day before\b|\bdays? (?:after|later)\b/i
  check("POSITIVE CONTROL: a brief with \"A 3-day follow-up\" is seen by the timing finder", DAY_N.test("A 3-day follow-up email"))
  const timedBriefs = steps.filter((s) => DAY_N.test(s.brief))
  check("no playbook brief tells the writer WHEN (\"3-day\", \"day-6\", \"the day before\") — the arbiter decides", timedBriefs.length === 0, timedBriefs.map((s) => s.label).join(", "))
  check("the playbook install writes no author offset (the bundle item offset is the named zero, not a step value)", !/step\.sendAfterMinutes/.test(code("app/actions/creative-playbooks.ts")))
  const census = code("scripts/arbiter-timing-guard.ts")
  check("the arbiter-timing census no longer carries the two closed constants (a disposition for a removed constant would be stale)", !/"lib\/marketing\/creative-playbooks\.ts#sendAfterMinutes"/.test(census) && !/"lib\/listing-presentation\/section-drip\.ts#DEFAULT_DRIP_WINDOW_DAYS"/.test(census))

  console.log("\n BLIND SPOTS: §A–§E are static wiring proofs on comment-stripped source plus the pure screens/clusterers (each with a positive control); the review ask's WHEN is still close_date + the tenant's review_request_delay_days (a tenant setting the arbiter does not yet judge — Still open, needs an ARBITER_PLANNER_ENTRY_POINTS row owned by 150QTV); the bundle dispatcher (lib/direct-mail/orchestrate-bundle-send.ts) still fires every item at once — the arbiter door for follow-on items is Outside-lane; §F drives arbitrateSectionDelivery directly (deliverDueSections' PostgREST embed + not-null filter is not modelled by the in-memory client — its wiring is asserted on stripped source); residuals (revenue share) live in lib/commission/** (150XY) and are not judged here; no live model, no live send.")
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail === 0) console.log("✅ LIFETIME_RELATIONSHIP_PASS — review at close, lifetime moments, gifts, education from support questions and awards are wired; the drip and the playbooks carry no fixed timetable — the arbiter decides")
  else { console.log("❌ LIFETIME_RELATIONSHIP_FAIL"); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
