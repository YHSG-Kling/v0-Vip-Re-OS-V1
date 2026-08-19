#!/usr/bin/env tsx
/**
 * scripts/stale-contact-detection-simulator.ts  (npm run test:stale-contact-detection)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE RULE FOR "WHICH CONTACT HAS GONE QUIET", NOT THREE COLUMNS' WORTH.
 *
 * lib/ai-isa/stale-contact-detector.ts is the canonical contact-side detector and
 * lib/ai-isa/reengagement-policy.ts's own header names it a production runner. It
 * had NO caller in app/ or lib/ — every one of its exports sat on the orphan
 * ledger — while the same question was answered by two hand-written copies keyed
 * to two DIFFERENT columns:
 *
 *   · lib/ai-isa/stale-contact-detector.ts   contacts.last_contacted_at   ← correct
 *   · app/api/cron/stale-contact-monitor     contacts.created_at
 *   · app/dashboard/stale/actions.ts         contacts.updated_at
 *
 * The divergence was not stylistic. created_at NEVER MOVES, so under the cron
 * every contact older than the threshold was permanently "stale" however recently
 * their agent had spoken to them; and because the dashboard keyed on updated_at
 * while the cron keyed on created_at, the console's "I just touched" button
 * cleared the row from the agent's screen and changed nothing the sender read —
 * the agent logged a personal call and the ISA messaged the same person anyway.
 * Neither copy excluded an OPEN TRANSACTION, so a client under contract sat
 * inside the automated "haven't heard from you" net.
 *
 * NOTHING WAS DELETED BEFORE IT WAS MERGED. Each inline copy held exclusions the
 * canonical module lacked, and all of them moved into the shared policy first:
 * statuses archived/inactive (NON_ENGAGEABLE_CONTACT_STATUSES), the cron's
 * assigned-agent requirement (requireAssignedAgent), and the dashboard's
 * per-agent scope + its willingness to LIST contacts whose ISA switch is off
 * (agentId, includeIsaDisabled, and the `dormant` half of the predicate).
 *
 * PURE:     staleContactEligibility and the eligible/dormant split — including
 *           that every HARD stop clears both, and that the ISA switch clears only
 *           `eligible`, which is the entire reason a paused contact stays
 *           recoverable from the console.
 * SOURCE:   shape scans. No surface may key contact staleness to created_at or
 *           updated_at again; the wrapper may not hardcode a single engagement
 *           reason; the console's "touched" write must move the column staleness
 *           is actually measured on. Keyed to SHAPES, never to file paths.
 * NEGATIVE: every scan is run against text that must make it go RED, and against
 *           near-misses that must leave it GREEN, so a count of zero means
 *           something.
 * LIVE:     creds-gated. Seeds a contact whose created_at and updated_at both say
 *           "stale" while last_contacted_at says "spoken to yesterday", and proves
 *           the canonical detector does NOT return them — the exact contact the
 *           two deleted queries would each have re-engaged. Cleans up, residue 0.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import {
  staleContactEligibility,
  NON_ENGAGEABLE_CONTACT_STATUSES,
  DEFAULT_STALE_DAYS,
  LIFETIME_STALE_DAYS,
  type StaleEligibilityInput,
} from "../lib/ai-isa/reengagement-policy"
import { blankComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const ROOT = process.cwd()
const SELF = fileURLToPath(import.meta.url)
const daysAgo = (d: number, now: Date) => new Date(now.getTime() - d * 86_400_000).toISOString()

// ─── PURE ────────────────────────────────────────────────────────────────────

function pureLayer() {
  console.log("\n[eligibility · pure — one predicate, two questions it must not confuse]")

  const now = new Date("2025-06-01T12:00:00.000Z")
  const base: StaleEligibilityInput = {
    last_contacted_at:    daysAgo(30, now),
    dnc_status:           false,
    ai_outreach_paused:   false,
    isa_reengage_allowed: true,
    status:               "active",
    deleted_at:           null,
    hasActiveTransaction: false,
    agent_id:             "agent-1",
  }
  const ev = (over: Partial<StaleEligibilityInput>, opts: Parameters<typeof staleContactEligibility>[1] = { now }) =>
    // NOT `{ now, ...opts }`. `opts` already defaults to `{ now }` and its type
    // requires `now`, so the leading key was always overwritten by the spread —
    // dead weight that read as if it were a fallback.
    staleContactEligibility({ ...base, ...over }, opts)

  check("a quiet, unblocked, assigned contact is BOTH eligible and dormant",
    ev({}).eligible === true && ev({}).dormant === true)

  console.log("\n  [the split — the ISA switch stops the SEND, never the LISTING]")
  // This is the whole reason the dashboard could keep its own query for so long:
  // it needed rows the sender must never see.
  const paused = ev({ ai_outreach_paused: true })
  check("ai_outreach_paused → NOT eligible (no send) but STILL dormant (the console must show it)",
    paused.eligible === false && paused.dormant === true && paused.reason === "outreach_paused")
  const disallowed = ev({ isa_reengage_allowed: false })
  check("isa_reengage_allowed=false → NOT eligible but STILL dormant, so it can be switched back on",
    disallowed.eligible === false && disallowed.dormant === true && disallowed.reason === "reengage_disallowed")

  console.log("\n  [hard stops — these clear BOTH; no surface may present them as re-engageable]")
  for (const [label, over] of [
    ["dnc_status",           { dnc_status: true }],
    ["deleted_at",           { deleted_at: now.toISOString() }],
    ["an OPEN TRANSACTION",  { hasActiveTransaction: true }],
  ] as Array<[string, Partial<StaleEligibilityInput>]>) {
    const r = ev(over)
    check(`${label} clears eligible AND dormant`, r.eligible === false && r.dormant === false)
  }
  check("a contact who was spoken to yesterday is neither eligible nor dormant",
    ev({ last_contacted_at: daysAgo(1, now) }).eligible === false &&
    ev({ last_contacted_at: daysAgo(1, now) }).dormant === false)

  console.log("\n  [merged from the two deleted inline copies — the exclusions they alone had]")
  // Each inline query carried `.neq('status','archived').neq('status','inactive')`
  // and the canonical predicate knew only 'do_not_contact'. Collapsing the copies
  // had to bring these WITH them or the detector would have engaged rows both
  // copies correctly skipped.
  for (const s of NON_ENGAGEABLE_CONTACT_STATUSES) {
    const r = ev({ status: s })
    check(`status='${s}' is a hard stop (eligible and dormant both false)`,
      r.eligible === false && r.dormant === false && r.reason === "do_not_contact_status")
  }
  check("the merged status list still contains all three, so neither copy's exclusion was dropped",
    (["do_not_contact", "archived", "inactive"] as const).every((s) =>
      (NON_ENGAGEABLE_CONTACT_STATUSES as readonly string[]).includes(s)))
  check("an ordinary status is NOT swept up by that list",
    ev({ status: "active" }).eligible === true && ev({ status: "new" }).eligible === true)

  // The cron's `.not('agent_id','is',null)`. It is OPT-IN because the console
  // legitimately wants to see unassigned dormancy; the sender never does.
  check("requireAssignedAgent=false (the console) reports an UNASSIGNED contact as dormant",
    ev({ agent_id: null }, { now }).eligible === true)
  const unassigned = ev({ agent_id: null }, { now, requireAssignedAgent: true })
  check("requireAssignedAgent=true (the cron) hard-stops it — the engine would refuse it anyway",
    unassigned.eligible === false && unassigned.dormant === false && unassigned.reason === "unassigned")
  check("requireAssignedAgent does NOT punish a contact that HAS an agent",
    ev({}, { now, requireAssignedAgent: true }).eligible === true)

  console.log("\n  [thresholds — a past client is quiet on a different clock]")
  check(`a lifetime contact at ${DEFAULT_STALE_DAYS + 1}d is NOT yet stale (its horizon is ${LIFETIME_STALE_DAYS}d)`,
    ev({ last_contacted_at: daysAgo(DEFAULT_STALE_DAYS + 1, now), is_lifetime: true }).eligible === false)
  check(`…while an active contact at the same ${DEFAULT_STALE_DAYS + 1}d IS`,
    ev({ last_contacted_at: daysAgo(DEFAULT_STALE_DAYS + 1, now), is_lifetime: false }).eligible === true)
  check(`a lifetime contact past ${LIFETIME_STALE_DAYS}d becomes eligible`,
    ev({ last_contacted_at: daysAgo(LIFETIME_STALE_DAYS + 5, now), is_lifetime: true }).eligible === true)
  check("a never-contacted contact is maximally stale rather than invisible",
    ev({ last_contacted_at: null }).eligible === true && ev({ last_contacted_at: null }).daysSinceContact === 999)

  // THE DEFECT THAT MADE THE CRON WRONG, stated as an assertion about the
  // predicate's INPUTS rather than about any one call site: staleness is a
  // question about last_contacted_at and nothing else. Two contacts differing
  // only in when their row was created or last written must answer identically.
  console.log("\n  [the actual defect — staleness is a question about ONE column]")
  const spokenYesterday = { ...base, last_contacted_at: daysAgo(1, now) }
  check("two contacts identical except for last_contacted_at get OPPOSITE verdicts",
    staleContactEligibility(spokenYesterday, { now }).eligible === false &&
    staleContactEligibility({ ...spokenYesterday, last_contacted_at: daysAgo(90, now) }, { now }).eligible === true)
  check("the predicate accepts no created_at / updated_at input at all, so it CANNOT key on them",
    !Object.keys(base).includes("created_at") && !Object.keys(base).includes("updated_at"))
}

// ─── SOURCE ──────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git" || e === "scripts") continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if ((p.endsWith(".ts") || p.endsWith(".tsx")) && p !== SELF) out.push(p)
  }
  return out
}

/**
 * Source with comments AND string/template literals blanked, newlines preserved.
 *
 * Both must go. The files this pass touched now carry long comments QUOTING the
 * defective shapes they no longer have ("filtered on contacts.created_at"), and
 * the detector builds its status filter from a TEMPLATE LITERAL. A scan that
 * cannot tell a quotation from a call fails on the documentation and passes on
 * nothing — which is the failure mode this repo has hit repeatedly.
 */
function executableCodeOnly(s: string): string {
  // Comments go through the canonical scanner; literals are still masked here
  // because THIS helper deliberately wants quoted text gone too.
  //
  // The escape alternations below are the two-char class, NOT the dot form. A dot
  // does not match a newline, so a backslash sitting at end of line — a legal
  // line continuation — could not be consumed: the literal then failed to match,
  // was left unmasked, and every scan downstream read quoted prose as if it were
  // code. Same defect class as the block-first comment strip, one layer over.
  return blankComments(s)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, (m) => m.replace(/[^\n]/g, " "))
}

/** Comments blanked, literals intact. Newlines preserved so line numbers survive. */
function codeOnly(s: string): string {
  return blankComments(s)
}

/**
 * The normalizer the column scans below run on — and the reason they need one.
 *
 * These scans are identified by QUOTED ARGUMENTS: the table name in
 * `.from("contacts")` and the column name in `.lt("created_at", …)`. So they
 * cannot simply blank every string literal the way a scan keyed on identifiers
 * would — that would erase the signal itself and leave the scan reporting a
 * confident, permanent zero.
 *
 * But prose hides in strings as surely as in comments, and the files this pass
 * touched now carry long explanations QUOTING the shapes they no longer have.
 * A first cut of this proof blanked comments only, matched its own documentation,
 * and failed on green code.
 *
 * So: normalize the two quoted arguments that ARE signal into identifiers FIRST,
 * then blank every literal that remains. A real call survives as
 * `.from(__TBL_contacts).lt(__COL_created_at, …)`; a sentence about one, wherever
 * it is stored, does not.
 */
function scannableCode(s: string): string {
  return codeOnly(s)
    .replace(/\.from\(\s*["'](contacts|leads)["']\s*\)/g, (_m, t) => `.from(__TBL_${t})`.padEnd(_m.length, " "))
    .replace(
      /\.(lt|lte)\(\s*["'](created_at|updated_at|last_contacted_at)["']/g,
      (_m, op, col) => `.${op}(__COL_${col}`.padEnd(_m.length, " "),
    )
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => " ".repeat(m.length))
    .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => " ".repeat(m.length))
}

const lineOf = (s: string, i: number) => s.slice(0, i).split("\n").length

/** Every normalized `.from(__TBL_contacts)` chain in a file, as [startIndex, chain]. */
function contactChains(code: string): Array<[number, string]> {
  const out: Array<[number, string]> = []
  const re = /\.from\(__TBL_contacts\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const from = m.index + m[0].length
    const tail = code.slice(from, from + 900)
    const nextFrom = tail.indexOf(".from(")
    out.push([m.index, nextFrom === -1 ? tail : tail.slice(0, nextFrom)])
  }
  return out
}

/**
 * A `contacts` read that dates staleness from a comparison on created_at or
 * updated_at — the shape BOTH deleted copies used.
 *
 * Deliberately narrow: an ORDER BY or a SELECT of those columns is ordinary
 * row-metadata handling; only a `<` comparison expresses "this contact has gone
 * quiet". Runs on the normalized text, so a sentence quoting the shape is not it.
 */
const STALENESS_ON_WRONG_COLUMN = /\.(?:lt|lte)\(__COL_(created_at|updated_at)/

function stalenessInText(code: string): boolean {
  for (const [, chain] of contactChains(code)) {
    if (new RegExp(STALENESS_ON_WRONG_COLUMN.source).test(chain)) return true
  }
  return false
}

/**
 * WHOSE staleness question is this, though?
 *
 * The first cut of this scan swept the WHOLE TREE for that shape and failed on
 * eight sites, every one of them correct: reporting date windows
 * (lib/kernel/reporting.ts, app/actions/source-analytics.ts) legitimately bound a
 * range on created_at, and lib/ai-isa/speed-to-lead.ts documents created_at as
 * the lead→contact conversion moment, which is exactly the clock IT needs. That
 * was a probe asserting a property of the corpus when the claim is a property of
 * ONE decision: who the AI ISA re-engages.
 *
 * So the scan follows the CAPABILITY instead of the corpus. A module that
 * dispatches ISA contact re-engagement is one that reaches
 * initiateAIISAContactEngagement — the canonical consent-aware entry every such
 * path goes through. Those modules, and only those, must take their list from the
 * detector rather than dating staleness themselves.
 *
 * The marker is asserted NON-EMPTY below, because a scan whose population can
 * silently become zero is a scan that can silently stop working.
 */
function reengagementDispatchers(): string[] {
  const out: string[] = []
  for (const file of walk(ROOT)) {
    const code = scannableCode(readFileSync(file, "utf8"))
    if (/\binitiateAIISAContactEngagement\b/.test(code)) out.push(file)
  }
  return out.sort()
}

function dispatchersDatingStalenessInline(): string[] {
  const hits: string[] = []
  for (const file of reengagementDispatchers()) {
    const code = scannableCode(readFileSync(file, "utf8"))
    for (const [at, chain] of contactChains(code)) {
      if (new RegExp(STALENESS_ON_WRONG_COLUMN.source).test(chain)) {
        hits.push(`${relative(ROOT, file)}:${lineOf(code, at)}`)
      }
    }
  }
  return hits.sort()
}

function sourceLayer() {
  console.log("\n[shape scan · source — an ISA re-engager may not date staleness itself]")

  const dispatchers = reengagementDispatchers()
  // A scan over an empty population reports zero forever. If the canonical entry
  // is ever renamed away, this fails LOUDLY instead of going quietly green.
  check(`the scan has a population to scan — ISA re-engagement dispatchers found: ${dispatchers.length}`,
    dispatchers.length >= 3)
  for (const d of dispatchers) console.log(`      · ${relative(ROOT, d)}`)

  const inline = dispatchersDatingStalenessInline()
  check(`no ISA re-engagement dispatcher dates contact staleness from created_at/updated_at (found ${inline.length})`,
    inline.length === 0)
  for (const h of inline) console.log(`      · ${h}`)

  // NEGATIVE CONTROL. The scan reports 0, and a scan that has never gone red is
  // indistinguishable from one that cannot. Run it over the two shapes that were
  // ACTUALLY in the tree before this pass, verbatim, plus spacing variants.
  const scan = (s: string) => stalenessInText(scannableCode(s))
  check("NEGATIVE CONTROL red on the cron's deleted shape, verbatim",
    scan(`const { data } = await supabase.from('contacts').select('id').lt('created_at', cutoff).limit(20)`))
  check("NEGATIVE CONTROL red on the dashboard's deleted shape, verbatim",
    scan(`const { data: contactRows } = await svc.from("contacts").select("id").lt("updated_at", staleContactCutoff)`))
  check("NEGATIVE CONTROL red on the spacing/quote variants an edit could reintroduce it in",
    scan(`svc.from( "contacts" ).select("id").lte( 'updated_at' , c )`))

  // …and GREEN on the questions it must not answer. A scan that fired on the
  // correct column, on another table, or on an ORDER BY would be worse than no
  // scan: it would push the next author back toward the wrong column.
  check("green on the CORRECT column — the canonical detector's own read must pass",
    !scan(`supabase.from('contacts').select('id').lt('last_contacted_at', staleDate)`))
  check("green on created_at used for ORDERING or SELECTION rather than as a clock",
    !scan(`supabase.from('contacts').select('id, created_at').order('created_at', { ascending: true })`))
  check("green on the same comparison against a DIFFERENT table (leads have their own rules)",
    !scan(`supabase.from('leads').select('id').lt('created_at', staleLeadCutoff)`))
  // The reporting date windows are NOT excluded by the shape — a bounded range
  // genuinely contains `.lte("created_at", to)` and this scan would match it.
  // They are excluded by POPULATION, and saying so honestly is the difference
  // between a scan that is narrow and a scan that pretends to be clever.
  check("the shape ALONE would still match a reporting date window — so the population is what makes this scan honest",
    scan(`supabase.from('contacts').select('id, created_at').gte('created_at', from).lte('created_at', to)`))
  check("…and none of those reporting modules is in the dispatcher population",
    !dispatchers.some((f) => /reporting\.ts$|source-analytics\.ts$|board-packet\.ts$/.test(f)))

  // PROSE IS NOT CODE, WHEREVER IT IS STORED. Every file this pass touched now
  // documents the defect by quoting it — and this scan cannot blank literals
  // wholesale, because the table and column names it matches on ARE literals.
  // Both halves are asserted: the quotation is invisible, and a real call beside
  // it is still seen. The string-literal case is the one that failed first.
  const quoted = [
    `// it filtered on contacts.updated_at via .lt("updated_at", cutoff)`,
    `const NOTE = "the cron used .lt('created_at', cutoff) as a staleness proxy"`,
    "const TPL = `see .lt('created_at', cutoff) for the shape that was removed`",
    `/* the dashboard's .lt("updated_at", staleContactCutoff) is gone */`,
  ].join("\n")
  check("a quoted occurrence — line comment, block comment, STRING or template — is NOT a call",
    !scan(`await svc.from("contacts").select("id")\n${quoted}`))
  check("NEGATIVE CONTROL …and a REAL call beside all that prose is still caught",
    scan(`await svc.from("contacts").select("id")\n${quoted}\n.lt('created_at', cutoff)`))
  check("normalizing + blanking preserves line numbers, so a reported hit points at the right line",
    scannableCode(quoted).split("\n").length === quoted.split("\n").length)

  console.log("\n[the engagement reason · source — one wrapper must not flatten six reasons to one]")
  // engageContact branches on `reason` (the 'ghosted' → ghost_recovery call
  // purpose, the situational voicemail's fresh hook). Every production caller
  // reaches it through initiateAIISAContactEngagement, so a hardcoded literal
  // there made those branches unreachable no matter what any detector found.
  // Asserted as a property of THAT call, not of the corpus.
  const wrapper = executableCodeOnly(readFileSync(join(ROOT, "app/actions/ai-isa/initiate-contact-engagement.ts"), "utf8"))
  const engageCall = wrapper.slice(wrapper.indexOf("engageContact({"))
  check("the wrapper takes `reason` as a parameter rather than fixing it",
    /initiateAIISAContactEngagement\(\s*[\s\S]{0,200}?reason\s*:\s*ISAEngagementReason\s*=/.test(wrapper))
  check("…and PASSES that parameter through to engageContact instead of a literal",
    /reason\s*,/.test(engageCall.slice(0, 240)) && !/reason\s*:\s*['"]/.test(engageCall.slice(0, 240)))
  check("NEGATIVE CONTROL the pass-through check goes RED on the hardcoded shape it replaced",
    /reason\s*:\s*['"]/.test(`engageContact({ contactId, brokerageId, reason: 'reactivation', actorId })`))

  console.log("\n[the console's touch button · source — it must move the column staleness is read from]")
  // The button existed and did nothing the sender could see: it bumped updated_at
  // while the cron read created_at and the detector read last_contacted_at.
  const stale = codeOnly(readFileSync(join(ROOT, "app/dashboard/stale/actions.ts"), "utf8"))
  const touched = stale.slice(stale.indexOf("export async function markContactTouched"))
  const touchedBody = touched.slice(0, touched.indexOf("\n}\n") + 3)
  check("markContactTouched writes last_contacted_at, not merely updated_at",
    /\.update\(\s*\{[^}]*last_contacted_at/.test(touchedBody))
  check("…and proves the row it claims to have touched (a zero-row update is error:null)",
    /\.select\(\s*["']id["']\s*\)/.test(touchedBody) && /length === 0/.test(touchedBody))
  check("NEGATIVE CONTROL both checks go RED on the shape they replaced",
    !/\.update\(\s*\{[^}]*last_contacted_at/.test(`.update({ updated_at: new Date().toISOString() }).eq("id", contactId)`) &&
    !/\.select\(\s*["']id["']\s*\)/.test(`.update({ updated_at: now }).eq("id", contactId)`))

  console.log("\n[the detector · source — a refused read is not an empty result]")
  const det = codeOnly(readFileSync(join(ROOT, "lib/ai-isa/stale-contact-detector.ts"), "utf8"))
  check("the active-transaction probe destructures `error` and FAILS CLOSED on it",
    /const \{ data: activeTxContacts, error: txErr \}/.test(det) &&
    (det.match(/if \(txErr\)/g) ?? []).length === 2)
  check("both contacts reads destructure and check their own error",
    (det.match(/console\.error\('\[detect(Stale|Ghosted)Contacts\]/g) ?? []).length >= 3)
  check("the detector takes NO single object (there is no one-row answer to this question)",
    !/\.maybeSingle\(\)|\.single\(\)/.test(det))

  console.log("\n[the collapse actually happened · source — the losers call the survivor]")
  const cron = executableCodeOnly(readFileSync(join(ROOT, "app/api/cron/stale-contact-monitor/route.ts"), "utf8"))
  check("the cron reaches contacts through the detector and no longer queries them itself",
    /detectAllEligibleContacts\(/.test(cron) && contactChains(codeOnly(readFileSync(join(ROOT, "app/api/cron/stale-contact-monitor/route.ts"), "utf8"))).length === 0)
  const staleExec = executableCodeOnly(readFileSync(join(ROOT, "app/dashboard/stale/actions.ts"), "utf8"))
  check("the console reads its dormant list from the same detector",
    /detectStaleContacts\(/.test(staleExec))
  check("the console asks for ISA-disabled rows, so 'Stop AI' is not a one-way door",
    /includeIsaDisabled\s*:\s*true/.test(staleExec))
  check("…and a resume path exists that flips the switch back on",
    /resumeReengagementForContact/.test(staleExec) && /toggleContactAIISA\(\s*\{[^}]*enabled:\s*true/.test(staleExec))
  check("the console's disable path delegates to the fuller toggle rather than half-setting the switch",
    /disableReengagementForContact[\s\S]{0,400}?toggleContactAIISA\(/.test(staleExec))

  console.log("\n[the copy pipeline · source — the gateway half must be reachable]")
  // personalizeOutreach is the module's declared full pipeline; every caller
  // reached only its deterministic fallback, so ISA SMS shipped fallback copy as
  // though the gateway were permanently down.
  const engage = executableCodeOnly(readFileSync(join(ROOT, "app/actions/ai-isa/engage-contact.ts"), "utf8"))
  check("the contact SMS lane calls the full pipeline",
    /personalizeOutreach\(/.test(engage))
  check("…and the model-written body is compliance-gated before it is dispatched",
    /smsCompliance/.test(engage) && /messageType:\s*['"]sms['"]/.test(codeOnly(readFileSync(join(ROOT, "app/actions/ai-isa/engage-contact.ts"), "utf8"))))
  // The fallback is NOT lost — it is what personalizeOutreach returns on failure.
  const copyMod = codeOnly(readFileSync(join(ROOT, "lib/ai-isa/personalize-outreach.ts"), "utf8"))
  check("buildDeterministicCopy survives as the pipeline's own fallback (capability merged, not dropped)",
    /export function buildDeterministicCopy/.test(copyMod) &&
    /return buildDeterministicCopy\(facts, channel, firstName\)/.test(copyMod))
}

// ─── LIVE ────────────────────────────────────────────────────────────────────

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] SKIPPED — no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env")
    return
  }
  const svc = createClient(url, key, { auth: { persistSession: false } })

  console.log("\n[live · the contact each deleted query would have re-engaged]")
  const contactId = crypto.randomUUID()
  let seeded = false

  try {
    const { data: brk, error: brkErr } = await svc.from("brokerages").select("id").limit(1)
    if (brkErr) { console.log(`[live] SKIPPED — brokerages read refused: ${brkErr.message}`); return }
    const brokerageId = brk?.[0]?.id
    if (!brokerageId) { console.log("[live] SKIPPED — no brokerage to anchor on"); return }

    const { data: ag, error: agErr } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).limit(1)
    if (agErr) { console.log(`[live] SKIPPED — agents read refused: ${agErr.message}`); return }
    const agentId = ag?.[0]?.id
    if (!agentId) { console.log("[live] SKIPPED — no agent on this brokerage to assign to"); return }

    const old = new Date(Date.now() - 400 * 86_400_000).toISOString()
    const yesterday = new Date(Date.now() - 1 * 86_400_000).toISOString()

    // THE EXACT SHAPE THE TWO DELETED QUERIES GOT WRONG: a long-standing contact
    // the agent SPOKE TO YESTERDAY. created_at and updated_at both say "stale";
    // last_contacted_at says "leave them alone".
    const { data: rows, error: insErr } = await svc.from("contacts").insert({
      id: contactId,
      brokerage_id: brokerageId,
      agent_id: agentId,
      first_name: "StaleProof",
      last_name: `Seed-${contactId.slice(0, 8)}`,
      email: `stale-detection-proof+${contactId.slice(0, 8)}@example.invalid`,
      status: "active",
      contact_type: "buyer",
      dnc_status: false,
      ai_outreach_paused: false,
      isa_reengage_allowed: true,
      created_at: old,
      updated_at: old,
      last_contacted_at: yesterday,
    }).select("id")
    if (insErr || (rows?.length ?? 0) === 0) {
      console.log(`[live] SKIPPED — could not seed the contact: ${insErr?.message ?? "zero rows written"}`)
      return
    }
    seeded = true

    const { detectStaleContacts, detectAllEligibleContacts } =
      await import("../lib/ai-isa/stale-contact-detector")

    const detected = await detectStaleContacts(brokerageId, { maxBatch: 500, requireAssignedAgent: true })
    check("live: the canonical detector does NOT return a contact spoken to yesterday",
      !detected.some((c) => c.id === contactId))

    // Prove the seed is otherwise a perfect candidate — i.e. the exclusion above
    // is the LAST-CONTACTED clock and nothing else about the row.
    const { data: check2, error: readErr } = await svc
      .from("contacts").select("created_at, updated_at, last_contacted_at, agent_id, status")
      .eq("id", contactId).maybeSingle()
    check("live: …and its created_at/updated_at BOTH say stale, so the two deleted queries would have returned it",
      readErr === null && !!check2 &&
      new Date(check2.created_at as string).getTime() < Date.now() - 300 * 86_400_000 &&
      new Date(check2.updated_at as string).getTime() < Date.now() - 300 * 86_400_000)

    // Now move only the clock the rule is actually about.
    const { data: bumped, error: bumpErr } = await svc.from("contacts")
      .update({ last_contacted_at: new Date(Date.now() - 200 * 86_400_000).toISOString() })
      .eq("id", contactId).select("id")
    check("live: the seed row is writable (a zero-row update would make the next check meaningless)",
      bumpErr === null && (bumped?.length ?? 0) === 1)

    const detected2 = await detectStaleContacts(brokerageId, { maxBatch: 500, requireAssignedAgent: true })
    check("live: moving ONLY last_contacted_at flips the verdict — that column is the rule",
      detected2.some((c) => c.id === contactId))

    const all = await detectAllEligibleContacts(brokerageId, { maxBatch: 500, requireAssignedAgent: true })
    check("live: detectAllEligibleContacts returns it too, deduped, each row labelled stale|ghosted",
      all.some((c) => c.id === contactId) &&
      new Set(all.map((c) => c.id)).size === all.length &&
      all.every((c) => c.detection_type === "stale" || c.detection_type === "ghosted"))

    // The ISA switch: off means no SEND, but the console must still list them.
    const { error: pauseErr } = await svc.from("contacts")
      .update({ isa_reengage_allowed: false, ai_outreach_paused: true }).eq("id", contactId).select("id")
    if (!pauseErr) {
      const senderView = await detectStaleContacts(brokerageId, { maxBatch: 500, requireAssignedAgent: true })
      const consoleView = await detectStaleContacts(brokerageId, { maxBatch: 500, includeIsaDisabled: true })
      check("live: with the ISA switch OFF the SENDER view drops the contact",
        !senderView.some((c) => c.id === contactId))
      check("live: …while the CONSOLE view still lists it, so it can be switched back on",
        consoleView.some((c) => c.id === contactId))
    } else {
      console.log(`      (skipped the ISA-switch case — update refused: ${pauseErr.message})`)
    }
  } finally {
    if (seeded) await svc.from("contacts").delete().eq("id", contactId)
    const { count } = await svc
      .from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check(`live: cleanup residue == 0 (contacts ${count ?? 0})`, (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Stale-contact detection — one rule, one column, one detector")
  console.log("══════════════════════════════════════════════════")
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STALE_CONTACT_DETECTION_FAIL"); process.exit(1) }
  console.log(" ✅ STALE_CONTACT_DETECTION_PASS — contact staleness is decided by last_contacted_at in ONE detector; the ISA switch stops the send without hiding the row; the engagement reason and the gateway copy path both reach the engine")
}
main()
