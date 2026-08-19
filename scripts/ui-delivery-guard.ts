/**
 * scripts/ui-delivery-guard.ts
 *
 * test:ui-delivery — WHAT THE USER TYPES MUST LEAVE THE COMPONENT.
 *
 * THE OWNER NAMED THIS DEFECT EXACTLY: "the UI and the business process backend
 * know what to do, but the middle has no direction." This is its purest form —
 * a field the user fills in whose value is declared, bound to an input, and
 * then referenced nowhere else. It renders, it accepts keystrokes, it is styled
 * like every working field on the page, and on submit it is dropped.
 *
 * WHAT WAS ACTUALLY FOUND, and why this is not a tidiness check:
 *
 *   · PersonaPropertiesDashboard — the buyer's property rating dialog collected
 *     a VOTE and a COMMENT ("What do you think about this property?") and
 *     handleRateProperty called NOTHING. It toasted "Your feedback has been
 *     recorded" and closed. The single highest-signal input in the buyer
 *     journey — the client saying in their own words why a house does or does
 *     not work — was destroyed while thanking them for it. A sibling surface,
 *     CollaborativeSearchDashboard, had been doing it correctly all along.
 *
 *   · mobile-followup-panel — the agent taps Done at the door, types what the
 *     seller said into "Add notes", taps Mark as Complete, and
 *     completeActivity(taskId) was called with no notes. The handler even
 *     cleared the box on success, so the author believed it was saving. The
 *     most perishable intelligence in the business, captured at the one moment
 *     it is freshest, deleted.
 *
 *   · business-cards — referral partner notes dropped. Investigating THAT
 *     uncovered worse: partner_type offered agent_to_agent / vendor / lender /
 *     title, and agreement_type sent "referral_fee". The column's CHECK admits
 *     none of them. Every scanned card failed on insert, forever, and the agent
 *     saw only "Failed to create referral partner. Please try again."
 *
 * THE SECOND LESSON IS THE MORE GENERAL ONE. A dropped field and a UI
 * vocabulary the column refuses are the same defect wearing different clothes:
 * the screen and the schema were built from different dictionaries. The dropped
 * field is the quiet version; the refused INSERT is the loud version that gets
 * blamed on "flakiness". Whenever this guard fires, check the vocabulary too.
 *
 * A THIRD SHAPE, FOUND BY CONTINUING THE BURN: the panel that is mounted and
 * fed nothing. The mobile field OS had SEVEN panels; FIVE delivered nothing.
 * Four were rendered with a hardcoded [] — <ShowingDayPanel showings={[]} />,
 * OpenHousePanel, MobileFollowupPanel, QuickContactPanel — so an agent standing
 * in the field saw "nothing today" no matter what their day actually held,
 * while the showings, open houses, tasks and contacts sat in the database. The
 * fifth, TourDayPanel, was never mounted at all: exported from the barrel,
 * rendered by nobody, and its Start Tour button called an OPTIONAL callback no
 * parent passed, then claimed success anyway. Its own badge rendered "In
 * Progress" for a status nothing in the app could produce.
 *
 * That is the same defect as a dropped field, one layer up: the screen is
 * built, the data is there, and the middle never connects them. A literal []
 * passed as a data prop is the tell, and it is cheap to ban.
 *
 * WHY AN ALLOWLIST AND NOT A ZERO BAN. Plenty of state is legitimately local:
 * which tab is open, which mode a panel is in, a search box that filters a list
 * client-side. Those are bound to inputs and never submitted, and that is
 * correct. Banning the shape would force pointless plumbing; the honest
 * invariant is "every LOCAL-ONLY field is a deliberate, named decision."
 */
import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync } from "node:fs"
import { stripComments } from "./strip-comments"

const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = `${dir}/${e.name}`
    if (e.isDirectory()) { if (["node_modules", ".next"].includes(e.name)) continue; walk(f, out) }
    else if (/\.tsx$/.test(e.name)) out.push(f)
  }
  return out
}
const code = (s: string) =>
  stripComments(s)

/**
 * State that is bound to an input and deliberately never submitted. Each entry
 * is a decision, not an exemption: this value steers the SCREEN, not a record.
 */
const LOCAL_ONLY = new Set([
  "app/crm/components/os/relationship-ai-chat-panel.tsx#mode",            // which chat mode is displayed
  "app/dashboard/campaigns/repurpose/repurpose-dashboard-client.tsx#activeTab",
  "app/dashboard/social/components/post-composer-dialog.tsx#tab",
  "app/dashboard/admin/users/[userId]/user-edit-form.tsx#agentField",     // drives which sub-form renders
  "app/crm/contacts/[contactId]/tours/components/tour-plan-tab.tsx#duration",
  "app/dashboard/videos/components/business-context/video-context-picker.tsx#marketArea",
])

interface Hit { file: string; state: string }

/** A field the user TYPES INTO whose value is never mentioned outside its own wiring. */
export function findDroppedFields(files: string[]): Hit[] {
  const hits: Hit[] = []
  for (const file of files) {
    const src = code(read(file))
    if (!/useState/.test(src)) continue

    const typed = new Set<string>()
    for (const m of src.matchAll(/set([A-Z]\w*)\s*\(\s*e\.target\.value/g)) typed.add(m[1])
    for (const m of src.matchAll(/onValueChange=\{\s*\(?(\w+)\)?\s*=>\s*set([A-Z]\w*)\s*\(/g)) typed.add(m[2])

    for (const cap of typed) {
      const name = cap[0].toLowerCase() + cap.slice(1)
      const total = [...src.matchAll(new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`, "g"))].length
      // Mentions that are pure wiring: the declaration and the value/checked binding.
      const declared = new RegExp(`\\[\\s*${name}\\s*,\\s*set${cap}\\s*\\]`).test(src) ? 1 : 0
      const bound = [...src.matchAll(new RegExp(`value=\\{\\s*${name}\\s*\\}`, "g"))].length
      const checked = [...src.matchAll(new RegExp(`checked=\\{\\s*${name}`, "g"))].length
      if (total - (declared + bound + checked) <= 0) hits.push({ file, state: name })
    }
  }
  return hits
}

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

console.log("\n═══ 1. No user-entered field is silently dropped ═══")
{
  const hits = findDroppedFields([...walk("app"), ...walk("components")])
  const undeclared = hits.filter((h) => !LOCAL_ONLY.has(`${h.file}#${h.state}`))
  for (const h of undeclared) console.log(`     ${h.file}  →  ${h.state}`)
  ok("every field the user types into either reaches a payload or is declared\n    local-only on purpose",
    undeclared.length === 0,
    `${undeclared.length} collected-and-dropped — wire it, or add it to LOCAL_ONLY with a reason`)
}

console.log("\n═══ 2. The three that were dropped now actually deliver ═══")
{
  const portal = code(read("app/components/portal/PersonaPropertiesDashboard.tsx"))
  ok("the buyer's property rating calls a real action instead of toasting a lie",
    /submitPropertyFeedback\s*\(/.test(portal) && !/title:\s*"Rating Saved"/.test(portal))
  ok("...and sends BOTH the vote and the comment",
    /vote:\s*propertyVote/.test(portal) && /comments:\s*ratingComments/.test(portal))
  ok("...and reports a refusal instead of claiming success regardless",
    /if\s*\(!result\.success\)/.test(portal))

  const mobile = code(read("app/mobile/components/os/mobile-followup-panel.tsx"))
  ok("the follow-up note typed at the door is passed to completeActivity",
    /completeActivity\(taskId,\s*noteContent\)/.test(mobile))
  const activities = code(read("app/actions/activities.ts"))
  ok("...and completeActivity persists it rather than accepting and ignoring it",
    /notes\?:\s*string/.test(activities) && /notes:\s*trimmed/.test(activities))

  const cards = code(read("app/dashboard/agent/business-cards/page.tsx"))
  ok("the referral partner's notes reach createPartner",
    /notes:\s*referralNotes/.test(cards))
  const referrals = code(read("app/actions/referrals/referral-actions.ts"))
  ok("...and createPartner writes them",
    /notes\?:\s*string/.test(referrals) && /notes:\s*params\.notes/.test(referrals))
}

console.log("\n═══ 3. The screen and the schema share one dictionary ═══")
{
  // The louder half of the same defect: a value the UI offers that the column's
  // CHECK refuses. Nine of these were live at once, and several broke the
  // DEFAULT path — the video form defaulted to "custom", which the column has
  // never accepted, so an untouched form could not save at all.
  //
  // Ground truth is scripts/check-vocabularies.ts, which tracks the live CHECKs.
  const vocab = read("scripts/check-vocabularies.ts")
  const allowedFor = (table: string, column: string): string[] => {
    const tbl = vocab.match(new RegExp(`\\b${table}: \\{([\\s\\S]*?)\\n  \\}`))?.[1] ?? ""
    const list = tbl.match(new RegExp(`${column}: \\[([^\\]]*)\\]`))?.[1] ?? ""
    return list.split(",").map((v) => v.trim().replace(/^"|"$/g, "")).filter(Boolean)
  }

  // Each entry: the UI file, how its option values appear, and the column the
  // value is written to. Traced to the insert/update in every case.
  // SCOPED TO THE NAMED CONSTANT. A first cut matched every `{ value: "..." }`
  // in the file and immediately flagged the NEIGHBOURING arrays — lead sources,
  // formality levels, writing styles — which are correct values for different
  // columns. Reading "the options in THIS constant" is the question that
  // distinguishes the defect; "any option in this file" bans a shape.
  const constBody = (src: string, name: string): string =>
    src.match(new RegExp(`${name}\\s*(?::[^=]*)?=\\s*\\[([\\s\\S]*?)\\n\\]`))?.[1] ?? ""

  const SURFACES: Array<{ file: string; konst: string; table: string; column: string }> = [
    { file: "app/crm/contacts/new/page.tsx", konst: "CONTACT_TYPES", table: "contacts", column: "contact_type" },
    { file: "app/dashboard/social/components/post-composer-dialog.tsx", konst: "POST_TYPES", table: "social_posts", column: "post_type" },
    { file: "app/dashboard/marketing/studio/brand-voice/brand-voice-editor.tsx", konst: "TONE_OPTIONS", table: "brand_voice_profile", column: "tone" },
    { file: "app/settings/brand-voice/page.tsx", konst: "TONE_OPTIONS", table: "brand_voice_profile", column: "tone" },
    { file: "app/dashboard/videos/create/video-create-client.tsx", konst: "VIDEO_TYPES", table: "ai_video_projects", column: "video_type" },
  ]

  for (const s0 of SURFACES) {
    const allowed = allowedFor(s0.table, s0.column)
    const body = constBody(code(read(s0.file)), s0.konst)
    const offered = [...body.matchAll(/value:\s*"([a-z_ ]+)"/g)].map((m) => m[1])
    const bad = offered.filter((v) => !allowed.includes(v))
    ok(`${s0.table}.${s0.column} — every value in ${s0.konst} is one the column accepts (${offered.length} offered)`,
      allowed.length > 0 && offered.length > 0 && bad.length === 0,
      bad.length ? `refused by the CHECK: ${bad.join(", ")}` : "could not read the vocabulary or the options")
  }

  {
    const allowed = allowedFor("recruiting_costs", "cost_type")
    const panel = code(read("app/dashboard/recruiting-roi/cost-entry-panel.tsx"))
    const offered = [...panel.matchAll(/<option value="([a-z_]+)"/g)].map((m) => m[1])
    ok(`recruiting_costs.cost_type — every offered cost type is writable (${offered.length})`,
      offered.length > 0 && offered.every((v) => allowed.includes(v)),
      offered.filter((v) => !allowed.includes(v)).join(", "))
  }

  // Values that live inline rather than in an options array.
  const studio = code(read("app/dashboard/marketing/studio/marketing-studio-client.tsx"))
  const calAllowed = allowedFor("campaign_calendar", "event_type")
  const calOffered = [...studio.matchAll(/<SelectItem value="([a-z_]+)">(?:Publish|Send|Launch|Review|Deadline|Podcast Release|Mail Drop)</g)].map((m) => m[1])
  ok(`campaign_calendar.event_type — the studio offers only accepted values (${calOffered.length})`,
    calOffered.length > 0 && calOffered.every((v) => calAllowed.includes(v)),
    calOffered.filter((v) => !calAllowed.includes(v)).join(", "))

  const tones = code(read("app/dashboard/communications/inbox/components/AIReplyCoachPanel.tsx"))
  const toneAllowed = allowedFor("ai_message_drafts", "suggested_tone")
  const toneBody = tones.match(/TONE_LABELS[^=]*=\s*\{([\s\S]*?)\n\}/)?.[1] ?? ""
  const toneOffered = [...toneBody.matchAll(/([a-z_]+):\s*"/g)].map((m) => m[1])
  ok(`ai_message_drafts.suggested_tone — every offered tone is writable (${toneOffered.length})`,
    toneOffered.length > 0 && toneOffered.every((v) => toneAllowed.includes(v)),
    toneOffered.filter((v) => !toneAllowed.includes(v)).join(", "))

  const video = code(read("app/dashboard/videos/create/video-create-client.tsx"))
  ok("...and the library branch MAPS script_type instead of piping it straight in —\n    they are two different vocabularies",
    /SCRIPT_TYPE_TO_VIDEO_TYPE/.test(video) && /toVideoType\(/.test(video))
  ok("...and the form's default is a type the column accepts",
    /useState<string>\("listing_tour"\)/.test(video))

  // status and approval_status are two axes; conflating them broke every
  // approval-required post.
  const social = code(read("app/actions/social-media-automation.ts"))
  ok("an approval-required social post is a DRAFT with approval_status pending,\n    not a status the CHECK refuses",
    /requiresBrokerApproval \? "draft" : "scheduled"/.test(social) &&
    !/status[^\n]*===\s*"pending_approval"/.test(social))

  // The business-card scanner, the case this section started from.
  const cards = code(read("app/dashboard/agent/business-cards/page.tsx"))
  const PARTNER_TYPES = ["real_estate_agent", "mortgage_broker", "title_company", "home_inspector",
    "contractor", "insurance_agent", "attorney", "property_manager", "other"]
  const offered = [...cards.matchAll(/<option value="([a-z_]+)"/g)].map((m) => m[1])
  ok(`referral_partners.partner_type — the card scanner offers only accepted values (${offered.length})`,
    offered.length > 0 && offered.every((v) => PARTNER_TYPES.includes(v)),
    offered.filter((v) => !PARTNER_TYPES.includes(v)).join(", "))
  ok("...and its agreement_type is in the CHECK — 'referral_fee' never was,\n    so every scanned card failed on insert",
    /agreementType:\s*"(reciprocal|one_way|paid|informal)"/.test(cards))
}

console.log("\n═══ 4. No panel is mounted over a hardcoded empty list ═══")
{
  // A literal [] passed as a data prop means the screen renders its empty state
  // forever. Five of the seven mobile field panels were in this state.
  const PAGES = [...walk("app")]
  const offenders: string[] = []
  for (const f of PAGES) {
    const src = code(read(f))
    for (const m of src.matchAll(/<([A-Z]\w+)\s+(\w+)=\{\[\]\}/g)) {
      offenders.push(`${f}: <${m[1]} ${m[2]}={[]}>`)
    }
  }
  for (const o of offenders) console.log(`     ${o}`)
  ok("no component is rendered with a hardcoded empty data prop",
    offenders.length === 0, `${offenders.length} panel(s) mounted over []`)

  // Every panel the mobile OS barrel exports must actually be rendered — an
  // exported-but-unmounted panel is a whole feature the user cannot reach.
  const barrel = read("app/mobile/components/os/index.ts")
  const exported = [...barrel.matchAll(/export \{ (\w+) \}/g)].map((m) => m[1])
  const allTsx = PAGES.map((f) => read(f)).join("\n")
  const unmounted = exported.filter((c) => !new RegExp(`<${c}[\\s/>]`).test(allTsx))
  ok(`every mobile field panel the barrel exports is mounted (${exported.length} exported)`,
    unmounted.length === 0, `never rendered: ${unmounted.join(", ")}`)

  const tour = code(read("app/mobile/components/os/tour-day-panel.tsx"))
  ok("Start Tour dispatches for real instead of calling an optional callback\n    nobody passes",
    /updateTour\(/.test(tour) && !/onTourStart\?\./.test(tour))
  ok("...and reads the outcome before claiming the tour started",
    /if\s*\(!result\.success\)/.test(tour))
}

console.log("\n═══ 5. The detector fires on the real shapes ═══")
{
  // Proven against synthetic components so the assertions above have teeth.
  const dropped = `
    export function X() {
      const [note, setNote] = useState("")
      return <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
    }`
  const wired = `
    export function Y() {
      const [note, setNote] = useState("")
      const go = async () => { await save({ note }) }
      return <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
    }`
  const tmp = "/tmp/__ui_delivery_probe.tsx"

  writeFileSync(tmp, dropped)
  ok("a field bound to an input and never submitted IS caught",
    findDroppedFields([tmp]).some((h) => h.state === "note"))

  writeFileSync(tmp, wired)
  ok("...and the same field IS NOT caught once it reaches a payload",
    findDroppedFields([tmp]).length === 0)
  unlinkSync(tmp)
}

console.log(`\n${"═".repeat(70)}`)
console.log(`UI DELIVERY — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nWhat the user types must leave the component. A field that renders,")
  console.log("accepts keystrokes and is then dropped is worse than no field at all.")
  process.exit(1)
}
console.log("Every user-entered field either delivers or is local-only by decision.")
