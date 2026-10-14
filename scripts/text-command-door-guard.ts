#!/usr/bin/env tsx
/**
 * scripts/text-command-door-guard.ts   (npm run test:text-command-door) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * A STAFF PHONE CAN TEXT THE TEAM AN ACTION, AND THE TEAM IS THE ONE THAT EXISTS.
 *
 * Owner, 2026-09-06: "halo has a very easy way to text some sort of action with
 * 30+ agents on standby … each capability should be used autonomously as much
 * as you can in this agentic saas os."
 *
 * Proved: (1) the door is a THIRD front-end onto the ONE voice-command brain,
 * spelling no classifier and no intent of its own; (2) the brain admits an
 * internal caller only under the cron secret AND resolves the acting user from
 * the header, never from a session-less body; (3) the ingress asks the door
 * BEFORE the contact/lead match, so a staff phone is not captured as a lead;
 * (4) staff is resolved by phone inside the tenant the called number belongs
 * to, and a refused read falls through (fail closed); (5) the reply goes back
 * through the ONE outbound sender.
 *
 * BLIND SPOTS (§2): static. A retry is deduped on (user, transcript, two
 * minutes) against voice_commands rather than on MessageSid, so the same staff
 * user texting the identical sentence twice inside two minutes on purpose is
 * treated as one command. Intents that resolve the user from cookies inside
 * their action (draft_offer, draft_listing) will refuse over text and say so.
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

const DOOR    = src("lib/voice/text-command.ts")
const BRAIN   = src("app/api/internal/voice-command/route.ts")
const INGRESS = src("app/api/providers/inbound/route.ts")

console.log("══════════════════════════════════════════════════")
console.log(" Text an action: a staff phone → the one team brain → a texted answer")
console.log("══════════════════════════════════════════════════")

console.log("\n── 1 · one brain, no second classifier (§6) ──")
check("the door self-calls /api/internal/voice-command", /\/api\/internal\/voice-command/.test(DOOR))
check("…and spells no intent list of its own",
  !/query_showings|morning_standup|cut_promo|generateText\(/.test(DOOR))
check("…and never reaches dispatchTeamCommand or the tool-call route around the brain",
  !/dispatchTeamCommand|agent-assistant\/tool-call/.test(DOOR))

console.log("\n── 2 · the brain admits an internal caller only under the cron secret ──")
check("the brain reads x-acting-user-id", /x-acting-user-id/.test(BRAIN))
check("…only after verifyCronAuth passed (a header alone is not an identity)",
  /verifyCronAuth\(req\)[\s\S]{0,400}x-acting-user-id/.test(BRAIN))
check("…and a session user is still the default path", /supabase\.auth\.getUser\(\)/.test(BRAIN))
check("the door sends the secret as the cron bearer and the user in the header",
  /authorization":\s*`Bearer \$\{secret\}`/.test(DOOR) && /"x-acting-user-id":\s*staff\.userId/.test(DOOR))
check("the door refuses to run when the secret is not configured", /CRON_SECRET[\s\S]{0,200}return \{ handled: true, intent: null/.test(DOOR))

console.log("\n── 3 · the ingress asks the door before the contact/lead match ──")
const doorAt  = INGRESS.indexOf("runStaffTextCommand")
const matchAt = INGRESS.indexOf('.from("contacts")')
check("the ingress calls runStaffTextCommand", doorAt > 0)
check("…BEFORE the contact match (a staff phone is not captured as a lead)", doorAt > 0 && matchAt > doorAt)
check("…only for a Twilio text on a registered tenant number",
  /providerType === "twilio" && numberCtx && inbound\.fromPhone[\s\S]{0,200}runStaffTextCommand/.test(INGRESS))
check("…and returns without the contact path when handled", /cmd\.handled\)\s*return NextResponse\.json/.test(INGRESS))

console.log("\n── 4 · staff by phone, inside the tenant, fail closed ──")
check("users are read inside the tenant of the CALLED number", /from\("users"\)[\s\S]{0,200}\.eq\("brokerage_id", brokerageId\)/.test(DOOR))
check("a refused users read falls through to the contact path (not 'unknown phone')",
  /users read refused[\s\S]{0,120}return null/.test(DOOR))
check("only staff user types may command (contacts, vendors, lenders stay customers)",
  /STAFF_USER_TYPES = new Set\(/.test(DOOR) && !/"contact"|"vendor"|"lender"/.test(DOOR.slice(DOOR.indexOf("STAFF_USER_TYPES = new Set("), DOOR.indexOf("STAFF_USER_TYPES = new Set(") + 260)))
check("agents.user_id is the bridge to users (§3 — the ids are disjoint)", /agents"\)[\s\S]{0,120}user_id/.test(DOOR))
check("a webhook retry runs the command ONCE: same user + transcript within two minutes on voice_commands is a duplicate",
  /from\("voice_commands"\)[\s\S]{0,300}\.eq\("raw_transcript", text\)[\s\S]{0,500}duplicate delivery/.test(DOOR))
check("…and a refused duplicate check is logged, not read as 'not a duplicate' silently", /duplicate check refused/.test(DOOR))

console.log("\n── 5 · the answer goes back through the GOVERNED egress ──")
check("dispatchSms from lib/providers/dispatch (autonomy, budget, fair-housing and TCPA gates live there)",
  /import\("@\/lib\/providers\/dispatch"\)/.test(DOOR) && /dispatchSms\(\{/.test(DOOR))
check("…never the raw sender", !/lib\/providers\/messaging|sendSMS\(/.test(DOOR))
check("…to the phone that asked, attributed to the staff user, as a recipient-initiated transactional reply",
  /to:\s*input\.fromPhone/.test(DOOR) && /userId:\s*staff\.userId/.test(DOOR) && /transactional:\s*true/.test(DOOR))
check("…and the send result is READ (a refused send is logged, not assumed)", /if \(!r\.success\) console\.error/.test(DOOR))

console.log("\n── CONTROLS ──")
check("POSITIVE CONTROL: the intent finder would catch a copied classifier", /query_showings|morning_standup/.test('if (intent === "morning_standup")'))
check("POSITIVE CONTROL: the order finder fails when the door comes after the match",
  (() => { const s = 'x.from("contacts") … runStaffTextCommand('; return !(s.indexOf("runStaffTextCommand") > 0 && s.indexOf('.from("contacts")') > s.indexOf("runStaffTextCommand")) })())
check("BLINDNESS CONTROL: scans read comment-STRIPPED source",
  !stripComments("// runStaffTextCommand(svc, …)\n").includes("runStaffTextCommand"))

console.log("\n──────────────────────────────────────────────────")
console.log(" BLIND SPOTS (§2): static. Retries dedupe on (user, transcript, 2 min), not MessageSid;")
console.log(" cookie-resolving intents refuse over text and say so.")
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(`\n RESULT: ${pass} passed, ${fails.length} failed`)
if (fails.length > 0) { console.log(" ❌ TEXT_COMMAND_DOOR_FAIL"); process.exit(1) }
console.log(" ✅ TEXT_COMMAND_DOOR_PASS — a staff text reaches the one team brain and the answer comes back by text")
