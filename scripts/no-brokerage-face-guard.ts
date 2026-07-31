/**
 * scripts/no-brokerage-face-guard.ts
 *
 * test:no-brokerage-face — NOBODY ELSE'S FACE. EVER.
 *
 * The owner's rule: every user sets up their own avatar (all but TC and
 * compliance), and "there should be no fallback to brokerage". Three places
 * broke it, in ascending order of how badly.
 *
 * 1. THE DEAD BROKERAGE COLUMNS. resolveAvatarSource() in lib/did/index.ts read
 *    brokerages.did_actor_id / did_avatar_url when a caller supplied no face.
 *    They had no writer anywhere in the app, no UI, and — checked live — 0 of 2
 *    brokerages had either set. The branch existed only to be skipped, and it
 *    fell through to (2). Columns dropped in m334.
 *
 * 2. THE STRANGER. With neither actor_id nor source_url in the body, a D-ID
 *    /talks submit DOES NOT FAIL. D-ID renders with its own stock presenter. The
 *    job returned an id, the poller marked it done, the composition rail
 *    attached it, and a contact received a talking-head video of a person who
 *    has never worked at the brokerage — under their agent's name. Nothing
 *    downstream could tell that apart from a real render. This is the defect
 *    class in its purest form: the OS collected the intent and shipped
 *    something else, with every status field saying success.
 *
 * 3. THE PUBLIC SPOKESPERSON NOBODY ELECTED. /api/embed/session, for a
 *    brokerage-wide embed with no pinned twin, selected "the brokerage's primary
 *    agent" — the first active agent by created_at — and put THEIR face and
 *    THEIR cloned voice on a public website. An agent's likeness and voice clone
 *    are not brokerage property to reassign by timestamp. The create dialog even
 *    told the admin brokerage-wide means "pick a twin from any agent"; the
 *    picker existed in the editor, the pick was simply never required, and the
 *    silent fallback covered the gap.
 *
 * WHAT IS *NOT* A VIOLATION, so this guard does not chase it:
 *   · ai_identity_profiles' agent → team → brokerage cascade. That resolves the
 *     AI ASSISTANT — a distinct persona with its own name, face and voice — not
 *     a substitute for a human's likeness. resolveVideoIdentity keeps
 *     contact-facing video on the licensed human, full stop.
 *   · brokerages.default_isa_voice_id. The ISA's own voice, an identity in its
 *     own right, not a stand-in for an agent's clone.
 *   · agent_voice_profiles as a fallback from agent_avatar_assets. Same agent,
 *     older table.
 */
import { readFileSync, existsSync } from "node:fs"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
/** Comments stripped — an assertion must target CODE, never prose. This file's
 *  own header names every column and table it forbids, so a src() search here
 *  would match the explanation and pass on nothing. */
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

const DID = "lib/did/index.ts"
const EMBED_SESSION = "app/api/embed/session/route.ts"
const EMBED_ACTIONS = "app/actions/embed-widgets.ts"
const CREATE_UI = "app/dashboard/settings/embeds/embeds-list-client.tsx"
const EDITOR_UI = "app/dashboard/settings/embeds/embed-editor.tsx"

console.log("\n═══ 1. The render rail never borrows a face ═══")
{
  const d = code(DID)
  ok("resolveAvatarSource no longer reads the brokerages table at all",
    !/from\("brokerages"\)/.test(d), DID)
  ok("...and the retired columns appear nowhere in code",
    !/did_actor_id|did_avatar_url/.test(d), DID)
  ok("no face → the render is REFUSED before any provider call, because a submit\n    with neither actor_id nor source_url renders D-ID's stock presenter and\n    reports success",
    /if \(!avatarSrc\.actorId && !avatarSrc\.sourceUrl\)/.test(d) && /status: "error"/.test(d))
  ok("...and the refusal names the fix rather than shrugging",
    /Settings → Voice & Avatar/.test(src(DID)))
  ok("the old 'if neither is set, D-ID uses its default presenter' fall-through\n    is gone from the submit branch",
    !/\} else if \(avatarSrc\.sourceUrl\) \{/.test(d), DID)
}

console.log("\n═══ 2. The refusal lands BEFORE money is spent ═══")
{
  const d = code(DID)
  const refusalAt = d.indexOf("!avatarSrc.actorId && !avatarSrc.sourceUrl")
  const budgetAt = d.indexOf("checkVendorBudget")
  // The SUBMIT, not the helper. `didPost(` alone matches the function's own
  // definition near the top of the file, which sits before the refusal and made
  // this assertion fail on correct code — the same wrong-pattern trap as the
  // did-egress guard's generic-call regex. Anchor on the endpoint instead.
  const submitAt = d.indexOf('didPost("/talks"')
  ok("the no-face refusal precedes the vendor budget gate", refusalAt > 0 && refusalAt < budgetAt,
    `refusal@${refusalAt} budget@${budgetAt}`)
  ok("...and precedes the D-ID submit", refusalAt > 0 && refusalAt < submitAt,
    `refusal@${refusalAt} submit@${submitAt}`)
}

console.log("\n═══ 3. The public embed elects nobody ═══")
{
  const e = code(EMBED_SESSION)
  ok("the session route no longer picks a 'primary agent' by created_at",
    !/order\("created_at"/.test(e), EMBED_SESSION)
  ok("...and never queries the agents table looking for a stand-in",
    !/from\("agents"\)/.test(e), EMBED_SESSION)
  ok("an unpinned brokerage-wide embed REFUSES",
    /if \(!widget\.agent_id\)/.test(e) && /status: 409/.test(e))
  ok("...with an operator hint naming where to fix it, so a 409 on a live site\n    is diagnosable instead of mysterious",
    /operator_hint/.test(e) && /Website Embeds/.test(src(EMBED_SESSION)))
  ok("a PERSONAL embed still resolves the OWNER agent's own default twin —\n    that is the agent's own face, not a borrowed one",
    /\.eq\("agent_id", widget\.agent_id\)/.test(e) && /is_default", true/.test(e))
}

console.log("\n═══ 4. The pick is required where it is promised ═══")
{
  const a = code(EMBED_ACTIONS)
  ok("createEmbed REFUSES a brokerage-wide embed with no twin",
    /params\.scope === "brokerage" && !params\.defaultTwinId/.test(a), EMBED_ACTIONS)
  ok("updateEmbed refuses to CLEAR the twin on a brokerage-wide embed",
    /!params\.defaultTwinId && existing\.agent_id === null/.test(a), EMBED_ACTIONS)
  ok("any pinned twin is validated server-side — same brokerage, ready, approved\n    (the picker is a convenience; these actions take an id from the client)",
    /assertTwinAssignable/.test(a) && /approval_status !== "approved"/.test(a))
  ok("...and it is actually CALLED on both write paths",
    (a.match(/await assertTwinAssignable\(/g) ?? []).length >= 2)

  const ui = code(CREATE_UI)
  ok("the create dialog collects the twin it promises, at the moment it promises\n    it — the copy said 'pick a twin from any agent' while passing nothing",
    /listTwinsForEmbed\("brokerage"\)/.test(ui) && /defaultTwinId: needsTwin \? twinId : null/.test(ui))
  ok("...and Create stays disabled until a brokerage-wide embed has one",
    /const canCreate =/.test(ui) && /disabled=\{!canCreate\}/.test(ui))

  const ed = code(EDITOR_UI)
  ok("the editor stops offering \"use owner agent's default\" on an embed that\n    HAS no owner agent — an option naming a capability the route lacks",
    /widget\.agentId \? "— Use owner agent's default —" :/.test(ed), EDITOR_UI)
}

console.log("\n═══ 5. The columns are gone from the schema, not just unread ═══")
{
  ok("m334 drops them", /DROP COLUMN IF EXISTS did_avatar_url/.test(src("supabase/migrations/m334-retire-brokerage-avatar-fallback.sql")))
  ok("...and the migration records the dependency investigation that licensed the\n    drop: zero writers, one reader (removed here), zero rows live",
    /WRITERS: none/.test(src("supabase/migrations/m334-retire-brokerage-avatar-fallback.sql")))
  ok("the schema snapshot no longer lists them, so drift detection agrees",
    !/did_actor_id|did_avatar_url/.test(src("scripts/schema-snapshot.ts")))
  ok("no code anywhere still reads them",
    !/did_actor_id|did_avatar_url/.test(
      ["lib/did/index.ts", "lib/video/video-identity.ts", "app/api/embed/session/route.ts",
       "app/api/did/agents/session/route.ts"].map(code).join("\n")))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`NO BROKERAGE FACE — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nEvery user sets up their own avatar. A missing face is a refusal —")
  console.log("never the brokerage's, never another agent's, never D-ID's stock presenter.")
  process.exit(1)
}
console.log("No render and no live session can front an agent with a face they did not choose.")
