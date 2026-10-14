#!/usr/bin/env tsx
/**
 * scripts/isa-system-identity-guard.ts   (npm run test:isa-system-identity)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 88B (wave 88). Owner, verbatim: "Isa is a system ai ai isa."
 *
 * The ISA is the platform's AI ISA, acting through each brokerage's SYSTEM identity
 * (brokerages.ai_isa_system_user_id → users.platform_role 'ai_isa_system', lib/auth/isa-actor.ts —
 * the arm public.is_lead_visible_role() admits through is_ai_isa_system()). It is NOT a human
 * `user_type='isa'` seat (live: zero such rows). So a HUMAN escalation — "this lead needs a person" —
 * must never be addressed to an `isa` seat: that is the AI paging itself, and with no such rows it
 * pages nobody. Proven on the REAL code (in-memory client, no DB/network):
 *   A · lib/auth/lead-visibility.ts::leadDeskRecipientUserIds (the ONE lead-stage bell rule, used by
 *       escalate_to_agent, the opt-out bell and the missing-handle bell) reaches broker / admin staff
 *       and the TEAM LEAD of the team working the lead — never the `isa` seat, never a producer.
 *   B · the AI-ISA handoff classification bell (lib/kernel/manager-signals.ts) goes through that rule,
 *       not `.eq("user_type", "isa")`; census: zero `user_type = 'isa'` recipient queries in lib/app.
 *   C · CLAUDE.md §4 is intact: LEAD_DESK_USER_TYPES still derives from TENANT_ADMIN_USER_TYPES plus
 *       `isa` minus compliance_officer (a READ admission, inert for zero rows) — only the HUMAN
 *       escalation subtracts the AI seat.
 *   D · the calendar's ISA lens is labelled for what it is — the AI ISA's bookings.
 *   E · (lane 88B2) a human cannot be invited / created / role-changed INTO the ISA, and the seat
 *       meter never counts it: lib/kernel/tier-role-matrix.ts SYSTEM_AI_USER_TYPES is the ONE list,
 *       off FREE_STAFF_ROLES and the invite menu, refused by roleRefusalReason, never producing;
 *       every creation menu drops it; the user_type stays STORABLE (no CHECK change).
 * Rule, not waypoint; every absence has a positive control. Blind spot: the census regex reads
 * comment-stripped `.eq("user_type", "isa")` / an `.in("user_type", […])` literal naming "isa" — a
 * roster spread from a Set is judged through A (behavior), not by the census.
 * Run: npx tsx scripts/isa-system-identity-guard.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const rel = join(dir, name)
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel)
  }
  return out
}

const BRK = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"

async function main() {
  const V = await import("../lib/auth/lead-visibility")
  const { TENANT_ADMIN_USER_TYPES } = await import("../lib/auth/resolve-user-role")

  // ── A · the ONE lead-stage bell rule reaches humans ──────────────────────────────
  console.log("\n[A · leadDeskRecipientUserIds — human staff, never the AI ISA seat]")
  const world = (extra: Record<string, any[]> = {}) => memSupabase({
    agents: [
      { id: "a-prod", user_id: "u-prod" }, { id: "a-isa", user_id: "u-isa" }, { id: "a-tl", user_id: "u-tl" }, { id: "a-solo", user_id: "u-solo" },
    ],
    users: [
      { id: "u-prod", brokerage_id: BRK, user_type: "agent" },
      { id: "u-solo", brokerage_id: BRK, user_type: "agent" },
      { id: "u-isa", brokerage_id: BRK, user_type: "isa" },
      { id: "u-sys", brokerage_id: BRK, user_type: "system", platform_role: "ai_isa_system" },
      { id: "u-broker", brokerage_id: BRK, user_type: "broker" },
      { id: "u-admin", brokerage_id: BRK, user_type: "admin" },
      { id: "u-tl", brokerage_id: BRK, user_type: "team_lead" },
      { id: "u-tl2", brokerage_id: BRK, user_type: "team_lead" },
      { id: "u-co", brokerage_id: BRK, user_type: "compliance_officer" },
      { id: "u-other", brokerage_id: OTHER, user_type: "broker" },
    ],
    team_members: [
      { team_id: "t1", agent_id: "a-prod", brokerage_id: BRK, is_active: true },
      { team_id: "t2", agent_id: "a-prod", brokerage_id: BRK, is_active: false },
    ],
    teams: [
      { id: "t1", brokerage_id: BRK, team_lead_id: "u-tl" },
      { id: "t2", brokerage_id: BRK, team_lead_id: "u-tl2" },
    ],
    ...extra,
  })
  const viaProducer = await V.leadDeskRecipientUserIds(world() as any, BRK, { preferAgentId: "a-prod" })
  ok("a lead a producing agent is on → that agent's TEAM LEAD + broker + admin", ["u-tl", "u-broker", "u-admin"].every((u) => viaProducer.includes(u)), viaProducer.join())
  ok("…never the producer, the AI ISA seat, the system identity, compliance, an inactive team's lead, or another tenant",
    !["u-prod", "u-isa", "u-sys", "u-co", "u-tl2", "u-other"].some((u) => viaProducer.includes(u)), viaProducer.join())
  const viaIsa = await V.leadDeskRecipientUserIds(world() as any, BRK, { preferAgentId: "a-isa" })
  ok("a lead the `isa` seat is on → the HUMAN desk, not the ISA (the AI does not page itself)", !viaIsa.includes("u-isa") && viaIsa.includes("u-broker"), viaIsa.join())
  const viaTl = await V.leadDeskRecipientUserIds(world() as any, BRK, { preferAgentId: "a-tl" })
  ok("a lead a team lead works → exactly that team lead (a human desk seat)", JSON.stringify(viaTl) === JSON.stringify(["u-tl"]), viaTl.join())
  const noAgent = await V.leadDeskRecipientUserIds(world() as any, BRK)
  ok("a brokerage-owned lead (no agent) → broker + admin only", noAgent.includes("u-broker") && noAgent.includes("u-admin") && !noAgent.includes("u-isa") && !noAgent.includes("u-tl"), noAgent.join())
  const refused = await V.leadDeskRecipientUserIds(memSupabase({ users: [] }, { refuse: { users: "denied" } }) as any, BRK)
  ok("a refused desk read → [] (the bell does not ring; it never falls back to an agent)", refused.length === 0)
  // POSITIVE CONTROL — the brokerage-wide READ roster still carries `isa`; the subtraction is the fix.
  ok("POSITIVE CONTROL: BROKERAGE_WIDE_LEAD_USER_TYPES still contains `isa` (the pre-88B desk query paged it)", V.BROKERAGE_WIDE_LEAD_USER_TYPES.has("isa"))
  const lv = code("lib/auth/lead-visibility.ts")
  ok("rule: the desk query reads the HUMAN roster (derived by subtracting AI_ISA_SEAT_USER_TYPES), not the read roster",
    /\.in\("user_type", \[\.\.\.HUMAN_BROKERAGE_WIDE_LEAD_USER_TYPES\]\)/.test(lv) && /AI_ISA_SEAT_USER_TYPES\.has\(t\)/.test(lv))

  // ── B · no bell addressed to `user_type = 'isa'` ─────────────────────────────────
  console.log("\n[B · the handoff-classification bell and the census]")
  const ms = code("lib/kernel/manager-signals.ts")
  const s = ms.indexOf('"data_steward:ai_isa_handoff_to_agent"')
  const handler = ms.slice(s, ms.indexOf("\n  },", s))
  ok("the AI-ISA handoff classification bell asks the human lead desk (leadDeskRecipientUserIds)", s > 0 && /leadDeskRecipientUserIds\(/.test(handler))
  const ISA_RECIPIENT = /\.eq\(\s*["']user_type["']\s*,\s*["']isa["']\s*\)|\.in\(\s*["']user_type["']\s*,\s*\[[^\]]*["']isa["'][^\]]*\]\s*\)/
  const files = [...walk("lib"), ...walk("app")]
  // DISPLAY rosters are published exclusions, not blind spots: they LIST a legacy `isa` row if one
  // existed (zero live) and ring no bell / assign nothing — proven per file below, not assumed.
  const DISPLAY_ROSTERS: Record<string, string> = {
    "app/dashboard/team/page.tsx": "the team page's member LIST (a display read)",
  }
  const matched = files.filter((f) => ISA_RECIPIENT.test(code(f)))
  const offenders = matched.filter((f) => !(f in DISPLAY_ROSTERS))
  ok(`census: 0 of ${files.length} lib/app files address a bell / assignment by user_type 'isa' (${matched.length} matched, ${matched.length - offenders.length} published display roster(s))`, offenders.length === 0, offenders.join(", "))
  for (const [f, why] of Object.entries(DISPLAY_ROSTERS)) {
    const src = code(f)
    ok(`exclusion holds: ${f} is ${why} — it inserts no notification and writes no assignment`,
      !/\.from\(\s*["']notifications["']\s*\)\s*\.insert/.test(src) && !/\.from\(\s*["']assignment_log["']\s*\)\s*\.insert/.test(src))
  }
  ok("POSITIVE CONTROL: the census recognises the retired query shape", ISA_RECIPIENT.test(`svc.from("users").select("id").eq("brokerage_id", b).eq("user_type", "isa").limit(25)`))
  ok("POSITIVE CONTROL: …and a literal `.in(\"user_type\", [\"broker\", \"isa\"])` roster", ISA_RECIPIENT.test(`.in("user_type", ["broker", "isa"])`))
  ok("POSITIVE CONTROL: a tombstone comment naming the old query is NOT a call site",
    !ISA_RECIPIENT.test(stripComments(`// was: .eq("user_type", "isa")\nconst a = 1`)))
  for (const f of ["lib/ai-isa/tools.ts", "lib/ai-isa/conversation-handler.ts", "app/actions/ai-isa/initiate-engagement.ts"]) {
    ok(`${f} addresses its lead-stage bell through the one rule`, /leadDeskRecipientUserIds\(/.test(code(f)))
  }

  // ── C · CLAUDE.md §4 roster intact ───────────────────────────────────────────────
  console.log("\n[C · CLAUDE.md §4 — LEAD_DESK_USER_TYPES unchanged (read roster)]")
  const expected = new Set([...[...TENANT_ADMIN_USER_TYPES].filter((t) => t !== "compliance_officer"), "isa"])
  ok("LEAD_DESK_USER_TYPES = TENANT_ADMIN_USER_TYPES + isa − compliance_officer (CLAUDE.md §4)",
    V.LEAD_DESK_USER_TYPES.size === expected.size && [...expected].every((t) => V.LEAD_DESK_USER_TYPES.has(t)))
  ok("the AI ISA acts through the system identity: lib/auth/isa-actor.ts resolves brokerages.ai_isa_system_user_id",
    /ai_isa_system_user_id/.test(code("lib/auth/isa-actor.ts")))

  // ── D · the calendar's ISA lens ──────────────────────────────────────────────────
  console.log("\n[D · calendar ISA lens = the AI ISA's bookings]")
  const bar = code("app/dashboard/calendar/components/os/calendar-role-filter-bar.tsx")
  ok("the role filter labels the lens \"AI ISA\" (booked by the AI ISA), not a human ISA seat", /value: "isa", label: "AI ISA"/.test(bar) && !/label: "ISA"/.test(bar))
  ok("the ISA calendar page is titled for the AI ISA", /title: "AI ISA Calendar/.test(code("app/dashboard/isa/calendar/page.tsx")))

  // ── E · not a seat, not on any human menu (lane 88B2) ────────────────────────────
  console.log("\n[E · the ISA is not a human seat: menus, seat meter, role change]")
  const T = await import("../lib/kernel/tier-role-matrix")
  const TIERS = ["solo_agent", "team", "brokerage", "multi_location", "unknown_tier"]
  ok("SYSTEM_AI_USER_TYPES is the one list and names the AI ISA", (T.SYSTEM_AI_USER_TYPES as readonly string[]).join() === "isa")
  ok("the AI ISA's type is off FREE_STAFF_ROLES and the working roster (the invite menu)",
    !(T.FREE_STAFF_ROLES as readonly string[]).includes("isa") && !(T.WORKSPACE_STAFF_ROLES as readonly string[]).includes("isa"))
  ok("no tier may invite / seat it (tierAllowsRole, seatableUserTypes against the live vocabulary)",
    TIERS.every((t) => !T.tierAllowsRole(t, "isa" as any) && !(T.seatableUserTypes(t, ["isa", "agent", "tc"]) as readonly string[]).includes("isa")))
  const why = T.roleRefusalReason("isa") ?? ""
  ok("roleRefusalReason names it as the AI ISA (update-user and both invite doors surface this sentence)", /AI ISA/.test(why) && /not a workspace seat/.test(why), why)
  ok("the seat meter: it never consumes a seat and never produces — even with the desk the provisioning spec seeds",
    !T.roleConsumesSeat("isa", { produces: true }) && TIERS.every((t) => !T.roleProducesOnTier("isa", t)))
  ok("POSITIVE CONTROL: a real staff type is still invitable and free (tc)", T.tierAllowsRole("team", "tc") && !T.roleConsumesSeat("tc", { produces: true }))
  const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
  ok("still STORABLE — users_user_type_check keeps 'isa' (no CHECK change; legacy rows stay readable)",
    ((CHECK_VOCABULARIES as any).users?.user_type ?? []).includes("isa"))
  const MENUS: Record<string, RegExp> = {
    "app/actions/superadmin/tenant-users.ts": /TENANT_CREATABLE_ROLES = new Set<string>\(\[([^\]]*)\]/,
    "app/dashboard/superadmin/brokerages/[id]/tenant-users-panel.tsx": /CREATABLE_ROLES = \[([^\]]*)\]/,
    "app/actions/admin/invite-user.ts": /BROKERAGE_ASSIGNABLE_ROLES = new Set\(\[([^\]]*)\]/,
    "app/dashboard/admin/users/[userId]/user-edit-form.tsx": /USER_TYPE_OPTIONS = \[([\s\S]*?)\n\]/,
    "app/api/internal/voice-command/route.ts": /"role": one of \[([^\]]*)\]/,
  }
  for (const [f, re] of Object.entries(MENUS)) {
    const m = code(f).match(re)
    ok(`menu ${f} offers no ISA`, !!m && !/["']isa["']/.test(m[1]), m ? m[1].replace(/\s+/g, " ").slice(0, 140) : "menu not found")
  }
  ok("POSITIVE CONTROL: the menu finder recognises a menu that still offers it",
    /["']isa["']/.test((`const CREATABLE_ROLES = ["admin", "tc", "isa"]`.match(MENUS["app/dashboard/superadmin/brokerages/[id]/tenant-users-panel.tsx"]) ?? ["", ""])[1]))
  ok("lead-visibility's AI subtraction derives from the ONE list (no second spelling)",
    /new Set<string>\(SYSTEM_AI_USER_TYPES\)/.test(code("lib/auth/lead-visibility.ts")))

  // ── F · wave 101C — EVERY ISA send/call/voice audit row resolves its actor via lib/auth/isa-actor.ts ──
  console.log("\n[F · ISA sends, calls and voice name the SYSTEM AI ISA on every audit row (wave 101C)]")
  {
    const { isaAuditActor } = await import("../lib/auth/isa-actor")
    const ISA_USER = "99999999-9999-4999-8999-999999999999"
    const AGENT_USER = "88888888-8888-4888-8888-888888888888"
    const client = (isaId: string | null) => ({
      from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { ai_isa_system_user_id: isaId }, error: null }) }; return q },
    }) as any
    const a = await isaAuditActor(client(ISA_USER), BRK, AGENT_USER)
    ok("isaAuditActor: the ISA's system user is the actor; the agent it ran beside rides as on_behalf_of", a.actorUserId === ISA_USER && a.onBehalfOfUserId === AGENT_USER)
    const none = await isaAuditActor(client(null), OTHER, AGENT_USER)
    ok("isaAuditActor FAILS SAFE: an unprovisioned ISA names NO user — never falls back to the human", none.actorUserId === null && none.onBehalfOfUserId === AGENT_USER)
    // The three audit writers an ISA send/call reaches OUTSIDE the action ledger (the ledger itself is
    // proven in test:action-ledger — attributedActor / ledgerActorFor).
    const WRITERS: Array<[string, string, RegExp]> = [
      ["compliance_events (outbound suppression gate)", "lib/kernel/communication-compliance.ts", /actorContext\.actorType === "ai_isa"[\s\S]{0,200}isaAuditActor\([\s\S]{0,300}actor_user_id: isaActor \? isaActor\.actorUserId/],
      ["compliance_events (content-safety backstop)", "lib/providers/content-safety.ts", /isAiIsaSystemSource\(input\.systemSource\) && input\.humanApproved !== true[\s\S]{0,200}isaAuditActor\([\s\S]{0,900}actor_user_id: isaActor \? isaActor\.actorUserId/],
      ["outbound_message_compliance_log (TCPA gate — voice + SMS)", "lib/communication/tcpa-gate.ts", /isAiIsaSystemSource\(input\.systemSource\) && input\.humanApproved !== true[\s\S]{0,200}isaAuditActor\([\s\S]{0,400}initiated_by:\s*isaActor \? isaActor\.actorUserId/],
    ]
    for (const [what, file, re] of WRITERS) ok(`WIRED: ${what} — ${file} names the ISA via isaAuditActor`, re.test(code(file)))
    ok("POSITIVE CONTROL: the writer finder rejects the pre-101C shape (actor = the send's human userId)",
      !WRITERS[0][2].test(`supabase.from("compliance_events").insert({ actor_user_id: actorContext.userId ?? null, actor_role: actorContext.actorType })`))
    const disp = code("lib/providers/dispatch.ts")
    ok("dispatch: the compliance actorType uses THE ONE ISA predicate (isAiIsaSystemSource — ghost_recovery / lead_action_plan are the ISA too), not a substring test; a human-approved draft keeps the human",
      (disp.match(/actorType: isAiIsaSystemSource\(params\.systemSource\) && params\.humanApproved !== true \? "ai_isa" : "system"/g) ?? []).length === 2 && !/systemSource\?\.includes\("ai_isa"\)/.test(disp))
    ok("dispatch → content-safety and dispatch → SMS → TCPA carry the systemSource + human approval the rule needs",
      (disp.match(/systemSource: params\.systemSource, humanApproved: params\.humanApproved === true/g) ?? []).length === 3 &&
      /messagingSendSMS\(\{[\s\S]{0,400}systemSource: params\.systemSource,\s*humanApproved: params\.humanApproved === true/.test(disp) &&
      /systemSource:\s*params\.systemSource \?\? null,\s*humanApproved: params\.humanApproved === true/.test(code("lib/providers/messaging/index.ts")))
    ok("voice: the outbound call gates hand the dial's systemSource + human approval to the TCPA log",
      /enforceTCPACompliance\(\{[\s\S]{0,300}systemSource: ctx\.systemSource \?\? null,\s*humanApproved: ctx\.humanApproved === true/.test(code("lib/voice/outbound-call-gates.ts")))
    // The ISA's own dialers name the ISA source (so every row above resolves the ISA), census over the callers.
    const dialers: Array<[string, RegExp]> = [
      ["app/actions/ai-isa/engage-contact.ts", /placeOutboundAiCall\([\s\S]{0,1500}systemSource: reason === "ghosted" \? "ghost_recovery" : "ai_isa"/],
      ["app/actions/ai-isa/initiate-engagement.ts", /placeOutboundAiCall\([\s\S]{0,1500}systemSource: "ai_isa"/],
      ["app/api/cron/ai-callback-dispatch/route.ts", /placeOutboundAiCall\([\s\S]{0,600}systemSource: "ai_isa"/],
    ]
    for (const [f, re] of dialers) ok(`ISA dialer ${f} names an ISA systemSource (→ the ledger, TCPA log and compliance rows resolve the ISA)`, re.test(code(f)))
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
  console.log(" ISA_SYSTEM_IDENTITY_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
