/**
 * scripts/referral-os-reachability-simulator.ts
 *
 * THE REFERRAL & ADVOCACY ENGINE WAS BUILT, EXPORTED, AND UNREACHABLE.
 *
 * app/referrals/referrals-os-client.tsx composes EIGHT panels. Nothing imported
 * it. app/referrals/page.tsx was four lines — `redirect("/lifetime-customers
 * ?tab=referrals")` — and that alias resolves to the lifetime-customers `radar`
 * tab, which carries none of the referral ROI rollup, the advocacy/sphere score,
 * the top-referrer leaderboard, the review-request flow, the gifting flow or the
 * anniversary prompts. Five panels existed only behind that orphan:
 *
 *   ReferralCommandStrip · AdvocacyRadar · AdvocacyActionStack
 *   ReferralAiDraftingPanel · RepeatBusinessPanel
 *
 * So these were not duplicates of a working screen. They were dark.
 *
 * WHAT THIS GUARD KEEPS TRUE, and why each line was a real defect:
 *
 *  1. /referrals renders the composition instead of redirecting away from it,
 *     and every nav that says "Referrals" points at it.
 *
 *  2. The page reads its data through actions that already existed
 *     (loadReferralPipelineAction, loadReputationWorkspaceAction,
 *     getLifetimeCustomers, getUpcomingAnniversaries) and writes no supabase
 *     query of its own. A fifth copy of the referral read is exactly how four
 *     surfaces ended up with four different status vocabularies — see
 *     scripts/referral-consolidation-simulator.ts.
 *
 *  3. ROI counts conversion from REFERRAL_STATUSES_CONVERTED. "converted" is not
 *     a storable status (referrals_status_check admits received|contacted|
 *     qualified|assigned|under_contract|closed|lost), so any tally keyed on it
 *     was permanently zero.
 *
 *  4. AN agents.id IS NOT A contacts.id. The composition passed
 *     `contactId={selectedContactId || agentId}` into ReferralAiDraftingPanel;
 *     both AI actions behind it do `.from("contacts").eq("id", contactId)`, found
 *     nothing, and returned "Contact not found" the panel never rendered. It also
 *     printed the literal strings "Selected Contact" / "Select a contact above"
 *     where the CLIENT'S NAME goes ("Why would {contactName} refer you?").
 *
 *  5. The quick-action grid's two dialogs opened against defaultContactId = "",
 *     which fails isValidUUID upstream, so both did nothing in silence.
 *
 *  6. "Request Review" linked to #review-section and no element with that id
 *     existed anywhere in the repo.
 *
 *  7. checkThemFirstCompliance returns { score, themFirstCount, agentFirstCount,
 *     feedback }. Two panels stored it as { isCompliant, issues } — a shape it has
 *     never returned — so the badge said "Review Needed" on every draft however
 *     good, and the detail block could never render.
 *
 *  8. The drafter's "Additional context" and "Relationship type" were collected
 *     into state and sent nowhere, and its aiOptimizeReferralAsk call — GPT-4o,
 *     billed per click — was awaited and discarded.
 *
 *  9. topAdvocates and sphereSegments were hard-wired to null, so AdvocacyRadar's
 *     Top Advocates card and RepeatBusinessPanel's entire Sphere Health block
 *     (including its "View Full Sphere" link) could never render at all.
 *
 * 10. Three "Create Referral" buttons pushed /referrals?action=create and nothing
 *     read `action`, so two of the three opened nothing.
 */
import { readFileSync, existsSync } from "node:fs"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
/** Comments stripped: this file's own prose must never satisfy an assertion. */
const src = (p: string) =>
  existsSync(p)
    ? stripComments(readFileSync(p, "utf8"))
    : ""

const PAGE     = src("app/referrals/page.tsx")
const OSCLIENT = src("app/referrals/referrals-os-client.tsx")
const DRAFTER  = src("app/dashboard/referrals/components/os/referral-ai-drafting-panel.tsx")
const STACK    = src("app/dashboard/referrals/components/os/advocacy-action-stack.tsx")
const REVIEWP  = src("app/dashboard/referrals/components/os/review-request-panel.tsx")
const GIFTP    = src("app/dashboard/referrals/components/os/gratitude-gifting-panel.tsx")
const BOARD    = src("app/dashboard/referrals/components/os/referral-pipeline-panel.tsx")
const PIPECLI  = src("app/referrals/pipeline/pipeline-os-client.tsx")
const SPHEREAI = src("app/actions/ai-sphere-management.ts")
const NAV      = src("app/config/navigation-config.ts")
const UIGUARD  = src("scripts/ui-delivery-guard.ts")

console.log("\n── /referrals is a page, not a bounce ──")
{
  check("the route no longer redirects to the lifetime-customers radar tab",
    !/redirect\(\s*["']\/lifetime-customers/.test(PAGE))
  check("…it renders the composition",
    /<ReferralsOsClient/.test(PAGE) && /from ["']\.\/referrals-os-client["']/.test(PAGE))
  check("…as a server component with the repo's identity call",
    /await getAgentContext\(\)/.test(PAGE) && /from ["']@\/lib\/identity["']/.test(PAGE))
  check("…and refuses to render the OS with empty-string ids",
    /if \(!agentId \|\| !brokerageId\)/.test(PAGE))
  check("every nav that says Referrals points at it",
    /id: 'sphere-referrals'[^}]*href: '\/referrals'/.test(NAV) &&
    !/id: 'sphere-referrals'[^}]*tab=referrals/.test(NAV))
}

console.log("\n── the loader reuses the actions that already existed ──")
{
  check("referrals and the counts rollup come from the kernel action",
    /loadReferralPipelineAction/.test(PAGE))
  check("reviews come from the reputation workspace action",
    /loadReputationWorkspaceAction/.test(PAGE))
  check("past clients and their engagement scores come from getLifetimeCustomers",
    /getLifetimeCustomers/.test(PAGE))
  check("anniversaries come from getUpcomingAnniversaries",
    /getUpcomingAnniversaries/.test(PAGE))
  check("the page writes no supabase query of its own",
    !/\.from\(/.test(PAGE) && !/createClient\(/.test(PAGE))
  check("every load result is checked instead of silently yielding null",
    /loadErrors/.test(PAGE) && /!pipelineRes\.success/.test(PAGE))
}

console.log("\n── conversion is counted from the storable statuses ──")
{
  check("the ROI rollup imports the canonical converted list",
    /REFERRAL_STATUSES_CONVERTED/.test(PAGE) &&
    /from ["']@\/lib\/referrals\/referral-status["']/.test(PAGE))
  check("…and hard-codes neither 'converted' nor 'new'",
    !/["']converted["']/.test(PAGE) && !/status\s*===\s*["']new["']/.test(PAGE))
  check("the counts rollup is used rather than thrown away",
    /counts\[/.test(PAGE))
  check("deal value and commission are not summed into one figure",
    !/commission_amount[\s\S]{0,80}value_estimate/.test(PAGE))
}

console.log("\n── an agents.id is never handed to a contacts lookup ──")
{
  check("the composition no longer substitutes agentId for a contact id",
    !/selectedContactId \|\| agentId/.test(OSCLIENT))
  check("…and no longer prints a placeholder where the client's name goes",
    !/"Selected Contact"/.test(OSCLIENT) && !/"Select a contact above"/.test(OSCLIENT))
  check("the drafter is mounted only with a resolved contact",
    /selectedContact \?/.test(OSCLIENT) &&
    /contactId=\{selectedContact\.id\}/.test(OSCLIENT) &&
    /contactName=\{selectedContact\.name\}/.test(OSCLIENT))
  check("the page supplies real contacts for the picker to resolve from",
    /sphereContacts/.test(PAGE) && /sphereContacts=\{sphereContacts\}/.test(PAGE))
}

console.log("\n── the quick actions act on a real person or say they cannot ──")
{
  check("the stack is given the selected contact's id and name",
    /defaultContactId=\{selectedContact\?\.id/.test(OSCLIENT) &&
    /defaultContactName=\{selectedContact\?\.name/.test(OSCLIENT))
  check("…and disables the two one-to-one actions when there is none",
    /const hasContact/.test(STACK) && /disabled=\{!hasContact\}/.test(STACK))
  check("…explaining why rather than failing in silence",
    /noContactHint/.test(STACK))
  check("neither dialog mounts against an empty contact id",
    /\{hasContact && \(\s*<Dialog/.test(STACK))
}

console.log("\n── the dead links and the dead prop ──")
{
  check("Request Review no longer targets an id that does not exist",
    !/href="#review-section"/.test(STACK))
  check("…the review section carries that id on the page that shows it",
    /id="review-section"/.test(OSCLIENT))
  check("…and the button is wired to reach it",
    /onRequestReview/.test(STACK) && /handleRequestReview/.test(OSCLIENT))
  check("onOpenReputationFull is used instead of being destructured and ignored",
    /onClick=\{onOpenReputationFull\}/.test(STACK))
  check("…and the caller supplies it, without the button losing its destination",
    /onOpenReputationFull=\{/.test(OSCLIENT) && /\/dashboard\/reputation/.test(STACK))
}

console.log("\n── the compliance badge reads the shape the function returns ──")
{
  check("the drafter reads .score, not an isCompliant that never existed",
    /complianceResult\.score/.test(DRAFTER) && !/complianceResult\.isCompliant/.test(DRAFTER))
  check("…on the same threshold the gifting panel already used",
    /score >= 50/.test(DRAFTER) && /score >= 50/.test(GIFTP))
  check("the review panel stopped reading the phantom flag too",
    !/compliance\.isCompliant/.test(REVIEWP))
  check("…and the drafter surfaces the feedback the function does return",
    /complianceResult\.feedback/.test(DRAFTER))
}

console.log("\n── every input on the drafter changes the output ──")
{
  check("the typed context is sent to the generator",
    /additionalContext:\s*context/.test(DRAFTER))
  check("the chosen relationship type is sent too",
    /relationshipType,/.test(DRAFTER))
  check("…and both actions actually consume them",
    /params\.additionalContext/.test(SPHEREAI) && /params\.relationshipType/.test(SPHEREAI))
  check("the ui-delivery allowlist no longer excuses the dropped field",
    !/referral-ai-drafting-panel\.tsx#context/.test(UIGUARD))
  check("the aiOptimizeReferralAsk result is used, not billed and binned",
    /setStrategy\(/.test(DRAFTER) && /strategy\.readinessScore/.test(DRAFTER))
  check("…including as the draft when the touchpoint call fails",
    /optimized\?\.askScript/.test(DRAFTER))
  check("a refusal is shown instead of leaving the panel unchanged",
    /setError\(/.test(DRAFTER))
}

console.log("\n── the cards that could never render now have a source ──")
{
  check("topAdvocates is no longer hard-wired to null",
    !/topAdvocates=\{null\}/.test(OSCLIENT) && /topAdvocates=\{topAdvocates/.test(OSCLIENT))
  check("sphereSegments is no longer hard-wired to null",
    !/sphereSegments=\{null\}/.test(OSCLIENT) && /sphereSegments=\{sphereSegments/.test(OSCLIENT))
  check("the sphere score is counted from stored engagement rows",
    /engagement_score/.test(PAGE) && /referrals_given/.test(PAGE))
  check("the leaderboard is built from the referrer named on the referral row",
    /source_contact_name/.test(PAGE) && /referred_by/.test(PAGE))
  check("…and every one of them is null when there is nothing to count",
    /clients\.length > 0[\s\S]{0,400}: null/.test(PAGE))
  check("the review panel's Send has an address to send to",
    /contactEmail/.test(PAGE) && /contactEmail/.test(OSCLIENT))
}

console.log("\n── ?action=create opens the create flow ──")
{
  check("the page reads the parameter",
    /searchParams/.test(PAGE) && /action === "create"/.test(PAGE))
  check("…and it seeds the dialog the board owns",
    /initialAction === "create"/.test(OSCLIENT))
  check("the board accepts the parent's control of that dialog",
    /createOpen\?: boolean/.test(BOARD) && /onCreateOpenChange/.test(BOARD))
  check("onCreateReferral is called instead of being destructured and ignored",
    /onClick=\{onCreateReferral\}/.test(BOARD))
  check("the pipeline page opens it in place rather than navigating away",
    /setCreateOpen\(true\)/.test(PIPECLI) && !/action=create/.test(PIPECLI))
  check("a stored referral re-reads the board instead of leaving it stale",
    /onCreated\?\.\(\)/.test(BOARD) && /onCreated=\{/.test(OSCLIENT))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ REFERRAL_OS_REACHABILITY_FAIL"); process.exit(1) }
console.log(" ✅ REFERRAL_OS_REACHABILITY_PASS — the engine is reachable and every control in it acts")
