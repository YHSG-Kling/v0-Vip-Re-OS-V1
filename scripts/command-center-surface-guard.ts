#!/usr/bin/env tsx
/**
 * scripts/command-center-surface-guard.ts   (npm run test:command-center-surface — in memory, no DB, no network)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 150, LANE 150DAC (directive 150AC): "one coherent, striking and accessible command-center UI / mobile views for
 * platform / office / team / solo / agent / customer / vendor, working buttons and natural-language / voice navigation".
 *
 * ALREADY EXISTED — REUSED, never re-spelled:
 *   · app/dashboard/admin/command-center/** — THE command center (platform via platform_role, office / team / solo
 *     through the egress scope; loadCommandCenter in lib/kernel/command-center.ts);
 *   · lib/kernel/egress-scope.ts — THE scope resolver; lib/kernel/resolve-user-office.ts resolveViewerHierarchy — THE
 *     C34 hierarchy (lane 150C, batch 1);
 *   · app/config/navigation-config.ts NAVIGATION_BY_ROLE / getNavigationForRole — every seat's menu (the doors);
 *   · lib/voice-admin/intent-interface.ts interpretIntent — THE one intent interface (C17).
 * BUILT (150DAC): resolveEgressScopeForViewer + egressScopeFromHierarchy (lane 150C Outside-lane #4 — a multi-location
 * tenant's scope is the hierarchy, never a user_type), the multi-office loader (`.in` over scope.locationIds), the
 * Offices door on the command center, the NAVIGATION branch of interpretIntent (a menu label said after a verb opens it).
 *
 * WHAT IT HOLDS (STRIPPED source — scripts/strip-comments.ts; a tombstone is never a door, CLAUDE.md §2):
 *   A. multi-location scope from the hierarchy — DRIVEN over memSupabase (broker without a grant ≠ brokerage-wide;
 *      leadership grant = all offices; an office head = their offices; two offices → `.in`; single office = the ladder;
 *      a refused read → own work with the reason — fail closed), plus the consumers census;
 *   B. every command-center BUTTON is a wired door (onClick / submit inside a handled form / asChild link) — derived
 *      from every <Button>/<button> tag in the directory, with a positive control;
 *   C. every server action the command center imports is an exported async function of a "use server" module;
 *   D. every literal href on the command center resolves to a page (route groups / dynamic segments honoured);
 *   E. every list the command center renders says so when empty ("No … yet" / "Nothing …");
 *   F. every seat has a home door that resolves, and the principal tiers (platform / office / team / solo) reach the
 *      command center from their own menu; customers land on the portal, vendors on their dashboard;
 *   G. natural-language / voice navigation — DRIVEN: every label on a broker's menu, said after "go to", opens its own
 *      href; a domain request that merely names a screen is not navigation; a contact cannot navigate to staff screens;
 *      the live door never sends a navigation answer to the model; the affordance opens it;
 *   H. the mail surface never calls a printed piece handwritten and offers the zero-cost proof before Send (lane 150R);
 *   I. the mobile views: every tab resolves, none opens the brokerage lead desk, both bottom bars are labelled navs.
 *
 * BLIND SPOTS (published beside the numbers, §2):
 *   · B is lexical: a Button whose handler is spread in from props (`{...props}`) is counted as wired only if the tag
 *     names onClick / asChild / type="submit"; a handler that exists but does nothing is test:ui-wiring-census's;
 *   · D checks LITERAL hrefs only (template hrefs are skipped and counted);
 *   · E is per FILE: a file that renders two lists with one empty state passes;
 *   · A drives the reader over an in-memory client — live RLS on organization_members is not exercised (the reader
 *     uses the service client with session ids, by design);
 *   · contrast (WCAG AA) is not computed here — the new text uses the existing foreground / muted tokens and red-700.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments, stringLiterals } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { NAVIGATION_BY_ROLE, getNavigationForRole } from "../app/config/navigation-config"
import {
  resolveEgressScope, resolveEgressScopeForViewer, scopeFilter, describeScope,
} from "../lib/kernel/egress-scope"
import { interpretIntent, type IntentActor } from "../lib/voice-admin/intent-interface"

const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")
const stripped = (p: string) => stripComments(src(p))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── finders (exported shape kept local; each has a positive control below) ─────────────────────────────────────

/** Every JSX opening tag of <Button …> / <button …> in stripped source, brace- and quote-aware. */
function buttonTags(code: string): string[] {
  const out: string[] = []
  const re = /<(Button|button)(?=[\s>/])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length, depth = 0, quote: string | null = null
    for (; i < code.length; i++) {
      const c = code[i]
      if (quote) { if (c === quote && code[i - 1] !== "\\") quote = null; continue }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue }
      if (c === "{") depth++
      else if (c === "}") depth--
      else if (c === ">" && depth === 0) break
    }
    out.push(code.slice(m.index, i + 1))
  }
  return out
}
/** A button tag is a wired door when it names its handler, submits a handled form, or renders a link. */
function buttonIsWired(tag: string, fileHasHandledForm: boolean): boolean {
  if (/\bonClick=\{/.test(tag) || /\basChild\b/.test(tag) || /\bformAction=\{/.test(tag)) return true
  if (/\btype=["']submit["']/.test(tag)) return fileHasHandledForm
  return false
}
function routeExists(href: string): boolean {
  const path = href.split(/[?#]/)[0]
  const segs = path.split("/").filter(Boolean)
  const walk = (dir: string, rest: string[]): boolean => {
    if (!existsSync(dir)) return false
    const kids = readdirSync(dir).filter((k) => { try { return statSync(join(dir, k)).isDirectory() } catch { return false } })
    if (rest.length === 0) {
      if (existsSync(join(dir, "page.tsx")) || existsSync(join(dir, "page.ts"))) return true
      return kids.some((k) => (/^\(.*\)$/.test(k) && walk(join(dir, k), [])) || (/^\[\[\.\.\./.test(k) && walk(join(dir, k), [])))
    }
    const [h, ...tail] = rest
    if (kids.includes(h) && walk(join(dir, h), tail)) return true
    for (const k of kids) {
      if (/^\(.*\)$/.test(k) && walk(join(dir, k), rest)) return true
      if (/^\[\[?\.\.\./.test(k) && walk(join(dir, k), [])) return true
      if (/^\[[^.]/.test(k) && walk(join(dir, k), tail)) return true
    }
    return false
  }
  return walk(join(ROOT, "app"), segs)
}
const EMPTY_STATE_RE = /\bNo [A-Za-z][^<"`{}]{0,90}\byet\b|\bNothing\b[^<"`{}]{0,90}|\bNo [a-z][a-z' ]{0,60}(?:found|recorded|waiting|open|to show|in this|in the last|on the ledger|right now)\b/
/** A DATA list in stripped source: `{x.map((` over a lowercase binding whose rendered element is not a select option
 *  (an option list of a form control is not a list surface) and is not `.join(`ed into text. UPPERCASE constants
 *  (example chips, a fixed vocabulary) are not data. */
function rendersDataList(code: string): boolean {
  for (const m of code.matchAll(/\{\s*([a-z][A-Za-z0-9_.?]*)\.map\(\s*\(?/g)) {
    const after = code.slice(m.index! + m[0].length, m.index! + m[0].length + 160)
    if (/<(option|SelectItem)\b/.test(after)) continue
    return true
  }
  return false
}

async function main() {
  console.log("[A · MULTI-LOCATION SCOPE COMES FROM THE C34 HIERARCHY — never from a user_type]")
  {
    const T = "11111111-1111-4111-8111-111111111111", L1 = "aaaaaaaa-0000-4000-8000-000000000001", L2 = "aaaaaaaa-0000-4000-8000-000000000002", S = "22222222-2222-4222-8222-222222222222", LS = "aaaaaaaa-0000-4000-8000-000000000009"
    const seed = () => ({
      brokerages: [{ id: T, plan_tier: "multi_location" }, { id: S, plan_tier: "brokerage" }],
      locations: [
        { id: L1, brokerage_id: T, status: "active", managing_broker_user_id: "u-head1" },
        { id: L2, brokerage_id: T, status: "active", managing_broker_user_id: null },
        { id: LS, brokerage_id: S, status: "active", managing_broker_user_id: null },
      ],
      teams: [{ id: "t1", brokerage_id: T, location_id: L1, team_lead_id: "u-lead", deleted_at: null }],
      users: [
        { id: "u-broker", brokerage_id: T, user_type: "broker", location_id: null },
        { id: "u-lead-grant", brokerage_id: T, user_type: "broker", location_id: null },
        { id: "u-head1", brokerage_id: T, user_type: "admin", location_id: null },
        { id: "u-head2", brokerage_id: T, user_type: "agent", location_id: null },
        { id: "u-lead", brokerage_id: T, user_type: "team_lead", location_id: null },
        { id: "u-single", brokerage_id: S, user_type: "broker", location_id: null },
      ],
      organization_members: [
        { brokerage_id: T, user_id: "u-lead-grant", scope_kind: "tenant", location_id: null, team_id: null, access_level: "leadership", revoked_at: null },
        { brokerage_id: T, user_id: "u-head2", scope_kind: "location", location_id: L1, team_id: null, access_level: "leadership", revoked_at: null },
        { brokerage_id: T, user_id: "u-head2", scope_kind: "location", location_id: L2, team_id: null, access_level: "leadership", revoked_at: null },
      ],
    })
    const db = memSupabase(seed())
    const broker = await resolveEgressScopeForViewer(db, { userType: "broker", userId: "u-broker", brokerageId: T })
    const ladder = resolveEgressScope({ userType: "broker", userId: "u-broker", brokerageId: T })
    check("CONTROL: the user_type ladder alone would have shown this broker ALL locations (the defect lane 150C named)", ladder.kind === "brokerage" && ladder.seesAllLocations)
    check("a multi-location BROKER without a leadership grant or an office is NOT brokerage-wide (own work, with the reason)", broker.multiLocation && broker.scope.kind === "agent" && !broker.scope.seesAllLocations && (broker.scope.basis ?? []).some((b) => /without a leadership grant/.test(b)), JSON.stringify(broker.scope))
    const lead = await resolveEgressScopeForViewer(db, { userType: "broker", userId: "u-lead-grant", brokerageId: T })
    check("a tenant LEADERSHIP grant → the whole brokerage, all locations", lead.scope.kind === "brokerage" && lead.scope.seesAllLocations && describeScope(lead.scope) === "Brokerage — all locations")
    const head1 = await resolveEgressScopeForViewer(db, { userType: "admin", userId: "u-head1", brokerageId: T })
    check("a managing broker of office 1 → kind 'location', that office only", head1.scope.kind === "location" && head1.scope.locationId === L1 && JSON.stringify(head1.scope.locationIds) === JSON.stringify([L1]) && !head1.scope.seesAllLocations)
    const head2 = await resolveEgressScopeForViewer(db, { userType: "agent", userId: "u-head2", brokerageId: T })
    const f2 = scopeFilter(head2.scope)
    check("an office head of TWO offices → both (scopeFilter.location_ids, header 'My offices (2)')", head2.scope.kind === "location" && (f2.location_ids ?? []).length === 2 && describeScope(head2.scope) === "My offices (2)", JSON.stringify(f2))
    const tl = await resolveEgressScopeForViewer(db, { userType: "team_lead", userId: "u-lead", brokerageId: T })
    check("a team lead on a multi-location tenant → their team (the teams.team_lead_id fact)", tl.scope.kind === "team" && tl.scope.teamId === "t1")
    const single = await resolveEgressScopeForViewer(db, { userType: "broker", userId: "u-single", brokerageId: S })
    check("a SINGLE-office tenant keeps the ladder byte-identically (broker → brokerage, all locations)", !single.multiLocation && JSON.stringify(single.scope) === JSON.stringify(resolveEgressScope({ userType: "broker", userId: "u-single", brokerageId: S })))
    const refusedMem = await resolveEgressScopeForViewer(memSupabase(seed(), { refuse: { organization_members: "permission denied" } }), { userType: "broker", userId: "u-lead-grant", brokerageId: T })
    check("FAIL CLOSED: a refused memberships read → own work, and the refusal is SAID", refusedMem.scope.kind === "agent" && !!refusedMem.refusal && /could not be read/.test(refusedMem.refusal))
    const refusedLoc = await resolveEgressScopeForViewer(memSupabase(seed(), { refuse: { locations: "permission denied" } }), { userType: "broker", userId: "u-single", brokerageId: S })
    check("FAIL CLOSED: a refused offices read → own work (never 'brokerage-wide because nobody checked')", refusedLoc.scope.kind === "agent" && !!refusedLoc.refusal)
    check("an 'own' hierarchy → own work, keyed to the viewer's own user id", broker.scope.agentUserId === "u-broker" && !broker.refusal)
    // The reader returns the hierarchy's shape the structural type names (kind / aggregate / locationIds / teamIds / basis).
    const { resolveViewerHierarchy } = await import("../lib/kernel/resolve-user-office")
    const h = await resolveViewerHierarchy(db as any, { userId: "u-head2", brokerageId: T })
    check("HierarchyScopeLike agrees with the live HierarchyScope shape", h.ok && ["kind", "aggregate", "locationIds", "teamIds", "basis"].every((k) => k in (h as any).scope))
    // Consumers census.
    const cc = stripped("app/dashboard/admin/command-center/page.tsx")
    check("CONSUMER: the command center resolves through resolveEgressScopeForViewer (service client, session ids)", /resolveEgressScopeForViewer\(createServiceClient\(\), \{ userType, userId: user\.id, brokerageId/.test(cc))
    check("CONSUMER: reporting-scope (analytics / source reports) and campaigns ROI read the same resolver", /resolveEgressScopeForViewer\(supabase,/.test(stripped("lib/kernel/reporting-scope.ts")) && /resolveEgressScopeForViewer\(createServiceClient\(\),/.test(stripped("app/dashboard/campaigns/roi/page.tsx")))
    check("LOADER: loadCommandCenter honours several offices (`.in(\"location_id\", offices)`) and reads its errors", /\.in\("location_id", offices\)/.test(stripped("lib/kernel/command-center.ts")) && /scoped entity read refused/.test(stripped("lib/kernel/command-center.ts")))
  }

  const DIR = "app/dashboard/admin/command-center"
  const files = readdirSync(join(ROOT, DIR)).filter((f) => f.endsWith(".tsx")).map((f) => `${DIR}/${f}`)

  console.log("\n[B · EVERY COMMAND-CENTER BUTTON IS A WIRED DOOR]")
  {
    check("CONTROL: a bare <Button> with no handler is flagged", !buttonIsWired(buttonTags(`<Button variant="ghost" size="sm">Go</Button>`)[0], false))
    check("CONTROL: an arrow handler with '>' inside braces is read whole and passes", buttonIsWired(buttonTags(`<Button onClick={() => a > b ? go() : stop()} disabled={x}>Go</Button>`)[0], false))
    check("CONTROL: a submit button outside a handled form is flagged", !buttonIsWired(`<button type="submit">`, false))
    let count = 0
    const dead: string[] = []
    for (const f of files) {
      const code = stripped(f)
      const handledForm = /<form[^>]*\b(onSubmit|action)=\{/.test(code)
      for (const tag of buttonTags(code)) { count++; if (!buttonIsWired(tag, handledForm)) dead.push(`${f}: ${tag.slice(0, 90).replace(/\s+/g, " ")}`) }
    }
    check(`every button is wired (${count} buttons across ${files.length} files)`, count > 20 && dead.length === 0, dead.join(" | "))
  }

  console.log("\n[C · EVERY IMPORTED SERVER ACTION IS A REAL ASYNC DOOR]")
  {
    const isDoor = (file: string, name: string): boolean => {
      for (const p of [`${file}.ts`, `${file}.tsx`, `${file}/index.ts`]) {
        if (!existsSync(join(ROOT, p))) continue
        const code = stripComments(src(p))
        if (!/^\s*["']use server["']/.test(code)) return false
        return new RegExp(`export\\s+(?:async\\s+function\\s+${name}\\b|const\\s+${name}\\s*=\\s*async\\b)`).test(code)
      }
      return false
    }
    check("CONTROL: a name the module does not export is flagged", !isDoor("app/actions/missions", "noSuchActionXyz"))
    let n = 0
    const broken: string[] = []
    for (const f of files) {
      for (const m of stripped(f).matchAll(/import\s+\{([^}]+)\}\s+from\s+"@\/(app\/actions\/[^"]+)"/g)) {
        for (const raw of m[1].split(",")) {
          const name = raw.trim()
          if (!name || name.startsWith("type ")) continue
          n++
          if (!isDoor(m[2], name.split(/\s+as\s+/)[0])) broken.push(`${f}: ${name} ← ${m[2]}`)
        }
      }
    }
    check(`every imported action resolves to an exported async "use server" door (${n} imports)`, n > 15 && broken.length === 0, broken.join(" | "))
  }

  console.log("\n[D · EVERY LITERAL HREF RESOLVES TO A PAGE]")
  {
    check("CONTROL: a route nobody built is flagged", !routeExists("/dashboard/no-such-surface-xyz"))
    check("CONTROL: a dynamic segment resolves", routeExists("/crm/contacts/abc"))
    let n = 0, templated = 0
    const missing: string[] = []
    for (const f of files) {
      const code = stripped(f)
      templated += (code.match(/href=\{`/g) ?? []).length
      for (const m of code.matchAll(/href(?:=|:\s*)"(\/[^"#?]*)/g)) { n++; if (!routeExists(m[1])) missing.push(`${f}: ${m[1]}`) }
    }
    check(`every literal href resolves (${n} literal, ${templated} templated skipped)`, n > 0 && missing.length === 0, missing.join(" | "))
    check("OFFICES DOOR: the command center links Settings → Offices (lane 150C's surface) and the page exists", /href="\/dashboard\/settings\/offices"/.test(stripped(`${DIR}/page.tsx`)) && routeExists("/dashboard/settings/offices"))
  }

  console.log("\n[E · EVERY LIST SAYS SO WHEN EMPTY]")
  {
    check("CONTROL: the empty-state finder recognises \"No missions yet\" and rejects a bare list", EMPTY_STATE_RE.test("No missions yet — give the OS") && !EMPTY_STATE_RE.test("<ul>{rows.map((r) => <li>{r}</li>)}</ul>"))
    check("CONTROL: a data list is recognised; an option list and an UPPERCASE constant are not", rendersDataList("<ul>{rows.map((r) => <li>{r}</li>)}</ul>") && !rendersDataList("{agents.map((a) => <option key={a.id}>{a.name}</option>)}") && !rendersDataList("{EXAMPLES.map((ex) => <b>{ex}</b>)}"))
    const lists = files.filter((f) => rendersDataList(stripped(f)))
    const silent = lists.filter((f) => !EMPTY_STATE_RE.test(stringLiterals(src(f)).map((s) => s.text).join(" \n ") + "\n" + stripped(f)))
    check(`every list-rendering file carries an empty state (${lists.length} files)`, lists.length > 5 && silent.length === 0, silent.join(" | "))
  }

  console.log("\n[F · EVERY SEAT HAS A COMMAND DOOR — platform / office / team / solo / agent / customer / vendor]")
  {
    const nav = NAVIGATION_BY_ROLE as Record<string, { sidebarItems: Array<{ href?: string; label?: string; children?: any[] }> }>
    const hrefs = (role: string): string[] => {
      const out: string[] = []
      const walk = (items: any[] | undefined) => { for (const it of items ?? []) { if (it.href) out.push(it.href); walk(it.children) } }
      walk(nav[role]?.sidebarItems)
      return out
    }
    for (const role of ["superadmin", "broker", "admin", "team_lead", "agent"]) {
      check(`${role}: the AI Command Center is on its own menu`, hrefs(role).includes("/dashboard/admin/command-center"))
    }
    for (const role of ["superadmin", "broker", "admin", "team_lead", "agent", "compliance_officer", "tc", "isa", "vendor", "lender", "title_agent", "contact"]) {
      const home = hrefs(role)[0]
      check(`${role}: a home door that resolves (${home ?? "none"})`, !!home && routeExists(home))
    }
    check("vendor lands on the vendor dashboard; lender / title on their portals (external personas never see the staff command center)", hrefs("vendor")[0] === "/vendor/dashboard" && !hrefs("vendor").includes("/dashboard/admin/command-center") && !hrefs("contact").includes("/dashboard/admin/command-center"))
    const page = stripped(`${DIR}/page.tsx`)
    check("the command center's entry gate admits the solo principal and the team lead (tier parity), refuses everyone else with a notice", /tier === "solo_agent"/.test(page) && /\.eq\("team_lead_id", user\.id\)/.test(page) && /<RoleGateNotice/.test(page))
    check("OFFICE tier: on a multi-location tenant an office head / team lead enters by the HIERARCHY (never by user_type alone)", /if \(!mayEnter && viewerScope\.multiLocation && viewerScope\.scope\.kind !== "agent"\) mayEnter = true/.test(page))
    check("a head of several offices / teams may drill into ONE of their OWN (options read only their ids — a URL cannot widen)", /\.in\("id", ownOffices\.length \? ownOffices : \[NONE\]\)/.test(page) && /\.in\("id", ownTeams\.length \? ownTeams : \[NONE\]\)/.test(page) && /scopeOptions\.some\(\(o\) => o\.value === view\)/.test(page))
    check("CONSUMER: the workflow-report default scope reads the same resolver (a multi-location broker without a grant opens on own work)", /resolveEgressScopeForViewer\(createServiceClient\(\),/.test(stripped("app/dashboard/campaigns/workflow-reports/page.tsx")))
  }

  console.log("\n[G · NATURAL-LANGUAGE / VOICE NAVIGATION — the NAVIGATION branch of C17]")
  {
    const actor = (userType: string, extra: Partial<IntentActor> = {}): IntentActor => ({ userId: "u", userType, platformRole: null, agentId: null, ...extra })
    const T = { brokerageId: "b" } as any
    const say = (u: string, who = "broker") => interpretIntent({ utterance: u, modality: "voice", actor: actor(who), tenant: T })
    check("CONTROL: an unknown destination is not navigation; a known menu label (with an article and a full stop) is", !say("go to the moon").navigation && say("Go to the AI Command Center.").navigation?.href === "/dashboard/admin/command-center")
    // The broker's own menu, walked INDEPENDENTLY of the interpreter (sidebar incl. children, top nav, mobile bar,
    // palette; deduped by href) — the proof never reuses the code it judges.
    const dests: Array<{ label: string; href: string }> = []
    {
      const cfg = getNavigationForRole(["broker"]) as any
      const seenHref = new Set<string>()
      const walk = (items: any[] | undefined) => { for (const it of items ?? []) { if (!it.divider && it.label && typeof it.href === "string" && it.href.startsWith("/") && !seenHref.has(it.href)) { seenHref.add(it.href); dests.push({ label: it.label, href: it.href }) } walk(it.children) } }
      walk(cfg.sidebarItems); walk(cfg.topNavItems); walk(cfg.mobileBottomNav); walk(cfg.commandPaletteItems)
    }
    const misses: string[] = []
    const seen = new Map<string, string>()
    for (const d of dests) {
      const key = d.label.toLowerCase()
      if (!seen.has(key)) seen.set(key, d.href)
      const r = interpretIntent({ utterance: `go to ${d.label}`, modality: "voice", actor: actor("broker"), tenant: T })
      if (r.navigation?.href !== seen.get(key)) misses.push(`${d.label} → ${r.navigation?.href ?? "none"}`)
    }
    check(`every label on a broker's own menu, said after "go to", opens its href (${dests.length} destinations, derived)`, dests.length > 20 && misses.length === 0, misses.slice(0, 5).join(" | "))
    const cc = interpretIntent({ utterance: "Take me to the AI Command Center", modality: "voice", actor: actor("broker"), tenant: T })
    check("\"take me to the AI command center\" → /dashboard/admin/command-center, nothing executes, nothing changes", cc.navigation?.href === "/dashboard/admin/command-center" && cc.capability === null && cc.plan.willChange === false && cc.authority_check.allowed)
    const domain = interpretIntent({ utterance: "show me which contacts may need help", modality: "text", actor: actor("broker"), tenant: T })
    check("a domain request that merely names a screen stays the domain route (never hijacked into navigation)", domain.capability === "contact_care_scan" && !domain.navigation)
    const client = interpretIntent({ utterance: "take me to the AI command center", modality: "voice", actor: actor("contact"), tenant: T })
    check("a contact cannot navigate to a staff screen (it is not on their menu)", !client.navigation)
    check("the live door never sends a navigation answer to the model (no spend, no swap)", /const ambiguous = !result\.navigation &&/.test(stripped("lib/voice-admin/intent-interface-live.ts")))
    check("the one affordance OPENS it (router.push) and links it in words", /router\.push\(json\.interpretation\.navigation\.href\)/.test(stripped("app/components/shared/intent-affordance.tsx")) && /Go to \{interp\.navigation\.label\}/.test(stripped("app/components/shared/intent-affordance.tsx")))
  }

  console.log("\n[H · MAIL SURFACE — no printed piece called handwritten; proof before Send (lane 150R Outside-lane 4, Still open 5)]")
  {
    const mailDir = "app/dashboard/campaigns/mail/components"
    const lits = readdirSync(join(ROOT, mailDir)).filter((f) => f.endsWith(".tsx")).flatMap((f) => stringLiterals(src(`${mailDir}/${f}`)).map((s) => ({ f, v: s.text })))
    // POSITIVE CONTROL on the literal reader itself (a reader that returned undefined made this check blind once).
    check("CONTROL: the literal reader returns each literal's text", stringLiterals(`const a = "Handwritten Letter"`).map((s) => s.text).join("") === "Handwritten Letter")
    const jsxText = readdirSync(join(ROOT, mailDir)).filter((f) => f.endsWith(".tsx")).map((f) => stripped(`${mailDir}/${f}`).replace(/handwritten_letter|HandwrittenLetterPreview/g, "")).join("\n")
    const calls = (s: string) => /\bhandwrit(ten|ing)\b/i.test(s) && !/not pen handwriting|handwriting provider|handwritten cards come only/i.test(s)
    check("CONTROL: the finder flags \"Handwritten Letter\" and passes the honest sentence", calls("Handwritten Letter") && !calls("a script typeface, not pen handwriting"))
    const offenders = lits.filter((l) => l.v !== "handwritten_letter" && calls(l.v)).map((l) => `${l.f}: "${l.v}"`)
    const textHits = (jsxText.match(/>[^<{]*\bHandwritten\b[^<{]*</g) ?? [])
    check("no label, sub-label or JSX text calls a printed piece handwritten", offenders.length === 0 && textHits.length === 0, [...offenders, ...textHits].join(" | "))
    check("the campaigns tab offers the zero-cost proof (sendCampaign({ …, previewOnly: true }))", /sendCampaign\(\{[^}]*previewOnly: true/.test(stripped(`${mailDir}/campaigns-tab.tsx`)))
  }

  console.log("\n[I · MOBILE VIEWS — every tab a door every seat may open; labelled for assistive tech]")
  {
    const bar = stripped("app/mobile/mobile-bottom-nav.tsx")
    const tabs = [...bar.matchAll(/href: "(\/[^"]*)"/g)].map((m) => m[1])
    check("CONTROL: the tab finder reads the mobile bar (≥ 4 tabs)", tabs.length >= 4, tabs.join(","))
    check(`every mobile tab resolves to a page (${tabs.length} tabs)`, tabs.every((h) => routeExists(h)), tabs.filter((h) => !routeExists(h)).join(","))
    check("no mobile tab opens the brokerage lead desk (agents see CONTACTS only — owner ruling)", !tabs.some((h) => h === "/leads" || h.startsWith("/leads/")))
    for (const f of ["app/mobile/mobile-bottom-nav.tsx", "app/components/layout/mobile-bottom-nav.tsx"]) {
      const code = stripped(f)
      check(`${f}: the bar is a labelled <nav> and marks the current tab (aria-current)`, /<nav aria-label=/.test(code) && /aria-current=\{isActive \?/.test(code))
    }
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log(`FAILED: ${failures.join("; ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
