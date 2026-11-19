/**
 * scripts/owner-resolution-guard.ts — `npm run test:owner-resolution` (wave 155, lane 155R7).
 *
 * WHAT IT HOLDS. An owner the arbitration census credits must be a manager the code really resolves AT RUN TIME, for
 * that call, and records — never a name written into a table to move a number (CLAUDE.md §1, directive B4).
 *   A. THE REGISTRY'S PER-CALL RESOLVER (lib/voice/tool-registry.ts voiceToolOwnerForCall) returns a registered manager
 *      for THAT call and fails closed on an invented manager, an unknown form mode and an unlisted tool.
 *   B. THE REAL DISPATCHER (lib/voice/team-commands.ts dispatchTeamCommand, in-memory client, SIMULATED) puts the call's
 *      owner on the result the route stores on the per-call audit row (agent_assistant_tool_calls.tool_output):
 *      a fixed-owner command → its owner; a per-call command → the fact its case resolved; a bench read → none;
 *      a refused per-call command that resolved nothing → none.
 *   C. THE CENSUS (scripts/os-coverage-ledger.ts, run once with a planted fixture): every row this lane repaired names a
 *      manager in MANAGERS (a per-call owner: EVERY candidate in MANAGERS); every tool classified READ has an OWN path that
 *      writes, sends and spends nothing; the rows left open stay open with their link; and the POSITIVE CONTROLS — a planted
 *      log-only write and a planted resolver token in a server action stay unowned (a token is not a resolution).
 * RED AT ce4200fa: A cannot import voiceToolOwnerForCall; B's results carry no ownerManager; C's repaired rows read
 * `unresolved` (measured: 19 rows partial at the base — see $S/lane155R7-notes.md).
 */
import { census } from "./os-coverage-ledger" // registers the `server-only` / service-client stubs before the imports below run
import { memSupabase } from "./in-memory-supabase"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n═══ ${t} ═══`)

// The rows this lane closed (before: partial at ce4200fa, `owner` missing or a READ tool held at IRREVERSIBLE).
const REPAIRED_OWNED = [
  "assistant_tool:run_skill", "assistant_tool:broker_objective", "assistant_tool:run_team_command",
  "kernel_event:behavioral_pattern_detected", "kernel_event:client_portal_message_sent", "kernel_event:portal_accessed",
  "kernel_event:portal_education_viewed", "kernel_event:portal_module_viewed", "kernel_event:prediction_created",
  "kernel_event:video_generation_requested",
]
const READ_TOOLS = ["team_query", "area_query", "morning_standup", "manager_status", "read_form_status", "next_unfilled_field", "whos_slipping", "explain_touches"]
// Still open, each with its exact missing link (notes): they must NOT read owned until that link lands.
const STILL_OPEN: Record<string, string> = {
  "assistant_tool:standup_action": "lib/kernel/standup-action.ts must return the acted item's manager (Outside-lane request)",
  "assistant_tool:fill_form_field": "the route's fillFormField must call voiceToolOwnerForCall (155B3's file — Outside-lane request)",
  "assistant_tool:ask_guidance": "a static VOICE_TOOL_MANAGER row (integrator)",
}

async function main(): Promise<void> {
  const reg = await import("../lib/kernel/manager-registry")
  const toolReg = await import("../lib/voice/tool-registry")
  const MANAGER_KEYS = new Set(Object.keys(reg.MANAGERS))

  section("A — the registry's per-call resolver")
  const own = (t: string, r: { manager?: string | null; formMode?: string | null }) => toolReg.voiceToolOwnerForCall(t, r, reg.MANAGERS)
  check("POSITIVE: run_skill / broker_objective / run_team_command take the manager their handler resolved for THIS call",
    own("run_skill", { manager: "ads_manager" }) === "ads_manager" && own("broker_objective", { manager: "listing_concierge" }) === "listing_concierge" && own("run_team_command", { manager: "deal_coordinator" }) === "deal_coordinator")
  check("POSITIVE: fill_form_field takes the form's packet owner (offer → stage_offer_packet → shopping_agent; listing → stage_listing_packet → listing_concierge)",
    own("fill_form_field", { formMode: "offer" }) === "shopping_agent" && own("fill_form_field", { formMode: "listing" }) === "listing_concierge")
  check("NEGATIVE: an invented manager, an unknown form mode, a missing fact and an unlisted (bench) tool resolve to null — never a guess",
    own("run_skill", { manager: "invented_manager" }) === null && own("fill_form_field", { formMode: "deed" }) === null && own("broker_objective", {}) === null && own("team_query", { manager: "ads_manager" }) === null)
  check("the per-call table and the fixed table stay disjoint (one tool, one answer — CLAUDE.md §6)",
    Object.keys(toolReg.VOICE_TOOL_PER_CALL_OWNER).every((t) => !(t in toolReg.VOICE_TOOL_MANAGER)))
  check("every packet tool a form mode names has a fixed owner in MANAGERS",
    Object.values(toolReg.FORM_MODE_PACKET_TOOL).every((t) => MANAGER_KEYS.has((toolReg.VOICE_TOOL_MANAGER as Record<string, string>)[t])))

  section("B — the real dispatcher records the call's owner (SIMULATED: in-memory client, no provider, no model)")
  const { dispatchTeamCommand } = await import("../lib/voice/team-commands")
  const B = "00000000-0000-4000-8000-0000000000b1", ADMIN = "00000000-0000-4000-8000-0000000000a1", AGENT = "00000000-0000-4000-8000-0000000000a2"
  const svc = () => memSupabase({
    users: [{ id: ADMIN, user_type: "broker", brokerage_id: B }, { id: AGENT, user_type: "agent", brokerage_id: B }],
    tenant_ai_teammates: [], user_role_assignments: [],
  }) as never
  const run = async (name: string, params: Record<string, unknown>, user: string) => {
    try { return await dispatchTeamCommand(name, params, { brokerageId: B, agentUserId: user }, svc()) } catch (e) { return { ok: false, spoken: `THREW: ${e instanceof Error ? e.message : String(e)}`, ownerManager: "threw" as never } }
  }
  const proposals = await run("kernel_proposals", {}, ADMIN)
  check("POSITIVE: a fixed-owner command (kernel_proposals) records its owner on the result", proposals.ownerManager === "deal_coordinator", JSON.stringify(proposals).slice(0, 200))
  const bench = await run("team_query", { query: "Hendersons" }, ADMIN)
  check("NEGATIVE: a bench read (team_query) records NO owner — attributing a bench answer to one manager would be dishonest", "ownerManager" in bench && bench.ownerManager === null, JSON.stringify(bench).slice(0, 200))
  const { MANAGER_SKILLS } = await import("../lib/kernel/skill-registry")
  const { assistantSkillRefusal } = await import("../lib/voice-admin/assistant-reach")
  const skill = MANAGER_SKILLS.find((s) => !assistantSkillRefusal(s))
  const ran = skill ? await run("run_skill", { skill: skill.name }, ADMIN) : null
  check(`POSITIVE: a per-call command (run_skill ${skill?.name ?? "—"}) records the manager its case resolved — the skill's declared manager_owner (${skill?.manager_owner ?? "—"}) — whether the request was accepted or refused downstream`,
    !!skill && !!ran && ran.ownerManager === skill.manager_owner && MANAGER_KEYS.has(String(ran.ownerManager)), JSON.stringify(ran).slice(0, 240))
  const refused = await run("broker_objective", { text: "grow listings ten percent in the north territory" }, AGENT)
  check("NEGATIVE: a per-call command refused before it resolves anything (broker_objective by a non-admin seat) records no owner",
    refused.ok === false && refused.ownerManager === null, JSON.stringify(refused).slice(0, 200))

  section("C — the census credits only real, per-call resolutions (one run, with a planted fixture)")
  const FX = "app/actions/__owner_resolution_fixture__.ts"
  const raw = [
    `"use server"`,
    `import { createServiceClient } from "@/lib/supabase/service"`,
    `export async function plantedLogOnly(id: string) { const svc = createServiceClient(); await svc.from("self_heal_events").insert({ subject: id }); await svc.from("notifications").insert({ title: "x" }) }`,
    `export async function plantedResolverToken(id: string) { const owner = voiceToolOwnerForCall("run_skill", { manager: "ads_manager" }, {}); const svc = createServiceClient(); await svc.from("self_heal_events").insert({ subject: id, detail: { owner } }) }`,
  ].join("\n")
  const c = await census([], [{ file: FX, raw }])
  const byId = new Map(c.rows.map((r) => [r.id, r]))
  const candidatesOf = (m: string) => /\{([^}]*)\}/.exec(m)?.[1].split("|").map((s) => s.trim()).filter(Boolean) ?? []
  const repairedBad = REPAIRED_OWNED.filter((id) => { const r = byId.get(id); return !r || r.missing.includes("owner") || r.registered_manager.startsWith("unresolved") })
  check(`every repaired row is owned (${REPAIRED_OWNED.length - repairedBad.length}/${REPAIRED_OWNED.length})`, repairedBad.length === 0, repairedBad.join(", "))
  const perCall = c.rows.filter((r) => r.registered_manager.startsWith("per-call: toManager"))
  const badCand = perCall.filter((r) => { const k = candidatesOf(r.registered_manager); return !k.length || !k.every((x) => MANAGER_KEYS.has(x)) })
  check(`every per-call reactor owner lists ONLY managers in MANAGERS (${perCall.length} rows)`, perCall.length >= 7 && badCand.length === 0, badCand.map((r) => r.id).join(", "))
  const toolPerCall = c.rows.filter((r) => r.registered_manager.startsWith("per-call: voiceToolOwnerForCall"))
  check(`every per-call tool owner is a tool listed in VOICE_TOOL_PER_CALL_OWNER (${toolPerCall.length} rows)`,
    toolPerCall.length >= 3 && toolPerCall.every((r) => r.id.replace("assistant_tool:", "") in toolReg.VOICE_TOOL_PER_CALL_OWNER))
  const readBad = READ_TOOLS.filter((t) => { const r = byId.get(`assistant_tool:${t}`); return !r || r.path_effects.writes.length || r.path_effects.egress.length || r.path_effects.spend || !r.typed_action.includes(", READ)") })
  check(`every tool classified READ has an OWN path that writes, sends and spends nothing (${READ_TOOLS.length - readBad.length}/${READ_TOOLS.length})`, readBad.length === 0, readBad.join(", "))
  const openBad = Object.keys(STILL_OPEN).filter((id) => { const r = byId.get(id); return !r || !r.missing.includes("owner") })
  check("the tools whose per-call fact is not yet recorded stay OPEN on `owner` (no credit before the link lands)", openBad.length === 0, openBad.map((id) => `${id}: ${STILL_OPEN[id]}`).join(" | "))
  const logOnly = byId.get(`server_action:${FX}#plantedLogOnly`), token = byId.get(`server_action:${FX}#plantedResolverToken`)
  check("POSITIVE CONTROL: a planted log-only write (self_heal_events + notifications) stays unowned", !!logOnly && logOnly.missing.includes("owner"), logOnly?.registered_manager)
  check("POSITIVE CONTROL: a planted resolver TOKEN in a server action is not a resolution — it stays unowned", !!token && token.missing.includes("owner"), token?.registered_manager)
  const fakeOwner = c.rows.filter((r) => { const m = r.registered_manager; return !(m.startsWith("unresolved") || m.startsWith("feed") || m.startsWith("per-call") || MANAGER_KEYS.has(m)) })
  check("no row names a manager outside MANAGERS", fakeOwner.length === 0, fakeOwner.slice(0, 5).map((r) => r.id).join(", "))

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("FAILURES:\n  - " + failures.join("\n  - ")); process.exit(1) }
  console.log("✅ OWNER_RESOLUTION_PASS — every credited owner is a registered manager resolved for that call and recorded; a log write or a resolver token alone owns nothing")
}
main().catch((e) => { console.error(e); process.exit(1) })
