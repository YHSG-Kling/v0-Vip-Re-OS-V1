#!/usr/bin/env tsx
/**
 * scripts/agent-id-class-guard.ts   (npm run test:agent-id-class) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WRONG-CLASS WRITE. This schema was split-brain: some columns named agent_id
 * FOREIGN KEY agents(id) and others FK users(id). m366 re-pointed the 20 stragglers,
 * so the plain spelling `agent_id` now means agents(id) everywhere — but the hazard
 * did not go away, it moved to the confusable NAMES: contacts.source_agent_id sits
 * on the same row as contacts.agent_id and is a users id, and
 * ai_isa_qualifications.assigned_to_agent_id is a users id under a name that reads
 * agents everywhere else. (The example that used to stand here,
 * closing_disclosure.title_agent_id, is gone — the table was dropped, which is why
 * scripts/agent-fk-columns.ts is now GENERATED rather than kept by hand.) The
 * column NAME still tells you nothing, so `agent_id: user.id` reads fine in review
 * and is rejected by the foreign key at runtime.
 *
 * lib/kernel/agent-identity.ts states the rule in its own header — "NEVER do:
 * agentId = user.id" — and a prior pass fixed 60+ sites. It still missed
 * saveNetSheet, where the consequence was total: every insert was FK-rejected, so
 * net_sheet_calculations held ZERO rows and the seller net sheet's Save button had
 * never once worked. A rule a human has to remember is not a rule; this is the
 * ratchet that enforces it.
 *
 * WHAT IT CHECKS. For every `.from(t)` chain that inserts/upserts/updates, any
 * payload key that is an agents(id) FK column on THAT table must not be assigned a
 * user-id expression.
 *
 * The window is cut at the NEXT `.from(` on purpose. A fixed-size window spills into
 * the following query and mis-attributes its payload — that produced 6 false
 * positives out of 15 on the first sweep, including flagging
 * newsletter_scheduled_sends.agent_id, which is CORRECTLY a users.id.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { AGENT_FK_COLUMNS, USERS_FK_AGENTISH_COLUMNS, CONTACT_FK_TABLES } from "./agent-fk-columns"

const root = process.cwd()

/** Expressions that denote a users.id. */
const USER_ID_EXPR = /\b(user\.user\.id|user\.id|session\.user\.id|\w*[Uu]serId)\b/
/** Already routed through the canonical resolver (or a value known to be an agents.id). */
const RESOLVED = /resolveAgentId|requireAgentId|actingAgentId|\bagentId\b|agent\.id|agentRow/

/**
 * Expressions that ARE an agents.id — the REVERSE-direction hazard. Writing one of
 * these into a users(id) FK is exactly as broken as the forward case, and it cost
 * more: listing_promo_videos.agent_id killed the whole lifecycle-promo path, and
 * listing_health_scores/interventions.agent_id meant the listing-health scorer had
 * never persisted a single row.
 */
const AGENT_ID_EXPR = /\b(resolveAgentId|requireAgentId|agentRecordId|actingAgentId|\w*[Ll]isting\.agent_id|\w*[Cc]ontact\.agent_id|\w*[Tt]ransaction\.agent_id|listings\.agent_id|l\.agent_id)\b/
/** A plain users.id — correct for a users(id) FK. */
const USER_ID_OK = /\b(user\.user\.id|user\.id|userId|agentUserId|\w*[Uu]serId|session\.user\.id)\b/

function* walk(dir: string): Generator<string> {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const n of entries) {
    if (n === "node_modules" || n === ".next" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(n)) yield p
  }
}

export interface WrongClassWrite { file: string; table: string; column: string; expr: string }

/** PURE — exported so the checks below can exercise it directly. */
export function scanSource(src: string, file: string): WrongClassWrite[] {
  const out: WrongClassWrite[] = []
  for (const [table, cols] of Object.entries(AGENT_FK_COLUMNS)) {
    const needle = `.from("${table}")`
    let i = src.indexOf(needle)
    while (i !== -1) {
      const rest = src.slice(i + needle.length)
      const nextFrom = rest.search(/\.from\(/)
      const win = needle + (nextFrom >= 0 ? rest.slice(0, nextFrom) : rest.slice(0, 1200))
      if (/\.(insert|upsert|update)\s*\(/.test(win)) {
        for (const col of cols) {
          const re = new RegExp(`\\b${col}\\s*:\\s*([^,\\n}]+)`, "g")
          let m: RegExpExecArray | null
          while ((m = re.exec(win))) {
            const expr = m[1].trim()
            if (USER_ID_EXPR.test(expr) && !RESOLVED.test(expr)) {
              out.push({ file, table, column: col, expr: expr.slice(0, 80) })
            }
          }
        }
      }
      i = src.indexOf(needle, i + 1)
    }
  }
  return out
}

/** PURE — the REVERSE direction: an agents.id written into a users(id) FK. */
export function scanSourceReverse(src: string, file: string): WrongClassWrite[] {
  const out: WrongClassWrite[] = []
  for (const [table, cols] of Object.entries(USERS_FK_AGENTISH_COLUMNS)) {
    const needle = `.from("${table}")`
    let i = src.indexOf(needle)
    while (i !== -1) {
      const rest = src.slice(i + needle.length)
      const nextFrom = rest.search(/\.from\(/)
      const win = needle + (nextFrom >= 0 ? rest.slice(0, nextFrom) : rest.slice(0, 1200))
      if (/\.(insert|upsert|update)\s*\(/.test(win)) {
        for (const col of cols) {
          const re = new RegExp(`\\b${col}\\s*:\\s*([^,\\n}]+)`, "g")
          let m: RegExpExecArray | null
          while ((m = re.exec(win))) {
            const expr = m[1].trim()
            if (AGENT_ID_EXPR.test(expr) && !USER_ID_OK.test(expr)) {
              out.push({ file, table, column: col, expr: expr.slice(0, 80) })
            }
          }
        }
      }
      i = src.indexOf(needle, i + 1)
    }
  }
  return out
}

/**
 * PURE — the FOURTH family: an UNTYPED polymorphic scope column.
 *
 * ai_identity_profiles.scope_id is a bare uuid with no foreign key at all, so the
 * FK-driven scanners above are structurally blind to it — which is precisely why
 * it drifted the longest. At scope_type 'agent' it is an agents.id: that is what
 * the public profile page, the widget, the Twilio greeting, video identity and the
 * ISA brand-voice prompt all read, and saveAIIdentityProfile authorises the write
 * by looking the scope_id up in `agents`. Three call sites used the auth user id
 * instead, so the agent's own assistant persona could never be saved and would not
 * have been read by nine of twelve consumers if it had been.
 *
 * Both reads AND writes are scanned here — with no FK to reject a bad write, a
 * mismatched READ is just as silent and just as fatal.
 */
export function scanSourceScopeId(src: string, file: string): WrongClassWrite[] {
  const out: WrongClassWrite[] = []
  const needle = `.from("ai_identity_profiles")`
  const altNeedle = `.from('ai_identity_profiles')`
  for (const n of [needle, altNeedle]) {
    let i = src.indexOf(n)
    while (i !== -1) {
      const rest = src.slice(i + n.length)
      const nextFrom = rest.search(/\.from\(/)
      const win = n + (nextFrom >= 0 ? rest.slice(0, nextFrom) : rest.slice(0, 1200))
      // Only the agent scope is an agents.id — team/brokerage scopes are their own ids.
      if (/scope_type['"]?\s*[,:]\s*['"]agent['"]/.test(win)) {
        const re = /scope_id['"]?\s*[,:]\s*([^,)\n}]+)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(win))) {
          const expr = m[1].trim().replace(/['"]/g, "")
          if (USER_ID_EXPR.test(expr) && !RESOLVED.test(expr)) {
            out.push({ file, table: "ai_identity_profiles", column: "scope_id (scope_type=agent)", expr: expr.slice(0, 80) })
          }
        }
      }
      i = src.indexOf(n, i + 1)
    }
  }
  return out
}

/** A LEAD id — never valid in a contacts(id) FK. */
const LEAD_ID_EXPR = /\b(leadId|lead_id|lead\.id|\w*[Ll]ead\.id|rawLead\.id|scrapedLead\.id)\b/
/** A genuine contact id (some params are named leadId but resolve a contact). */
const CONTACT_ID_OK = /\b(contactId|contact\.id|\w*[Cc]ontactId|promotedContactId)\b/

/** PURE — a LEAD id written into a contacts(id) FK. */
export function scanSourceLead(src: string, file: string): WrongClassWrite[] {
  const out: WrongClassWrite[] = []
  for (const table of CONTACT_FK_TABLES) {
    const needle = `.from("${table}")`
    let i = src.indexOf(needle)
    while (i !== -1) {
      const rest = src.slice(i + needle.length)
      const nextFrom = rest.search(/\.from\(/)
      const win = needle + (nextFrom >= 0 ? rest.slice(0, nextFrom) : rest.slice(0, 1200))
      if (/\.(insert|upsert|update)\s*\(/.test(win)) {
        const re = /\bcontact_id\s*:\s*([^,\n}]+)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(win))) {
          const expr = m[1].trim()
          if (LEAD_ID_EXPR.test(expr) && !CONTACT_ID_OK.test(expr) && !/isValidUUID/.test(expr)) {
            out.push({ file, table, column: "contact_id", expr: expr.slice(0, 80) })
          }
        }
      }
      i = src.indexOf(needle, i + 1)
    }
  }
  return out
}

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

console.log("══════════════════════════════════════════════════")
console.log(" Agent id-class guard (no users.id may be written to an agents(id) FK)")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure — the detector]")
check("flags a raw user.id on an agents(id) column",
  scanSource('await svc.from("activities").insert({ agent_id: user.id })', "t.ts").length === 1)
check("accepts a resolveAgentId call",
  scanSource('await svc.from("activities").insert({ agent_id: await resolveAgentId(svc, user.id) })', "t.ts").length === 0)
check("accepts an already-resolved agent id variable",
  scanSource('await svc.from("activities").insert({ agent_id: actingAgentId })', "t.ts").length === 0)
// newsletters.agent_id carries NO foreign key at all, so no class can be asserted
// about it — the detector must stay silent rather than guess. (This fixture used to
// point at newsletter_scheduled_sends; m366 made that column an agents(id) FK, so
// the write below is now a REAL defect there and the fixture had to move.)
check("ignores a column that is NOT an agents(id) FK (FK-less agent_id)",
  scanSource('await svc.from("newsletters").insert({ agent_id: user.id })', "t.ts").length === 0)
check("does not spill into the NEXT query's payload",
  scanSource(
    'await svc.from("activities").select("id").eq("x",1)\n' +
    'await svc.from("newsletters").insert({ agent_id: user.id })', "t.ts",
  ).length === 0)
check("ignores a read-only chain (no insert/update)",
  scanSource('await svc.from("activities").select("agent_id").eq("agent_id", user.id)', "t.ts").length === 0)
// THE SPELLING THAT HID TEN DEFECTS. USER_ID_EXPR used to list `userId` with word
// boundaries, which does not match `sessionUserId` or `params.agentUserId` — so ten
// real wrong-class writes sat under a green guard. A detector that only knows the
// spellings it was born with reports zero and means "I did not look".
check("catches the session-id spelling (sessionAgentId ?? sessionUserId)",
  scanSource('await svc.from("newsletter_subscribers").insert({ agent_id: sessionAgentId ?? sessionUserId })', "t.ts").length === 1)
check("catches a params.agentUserId on an agents(id) FK",
  scanSource('await svc.from("direct_mail_campaigns").insert({ agent_id: params.agentUserId })', "t.ts").length === 1)

console.log("\n[pure — the REVERSE detector]")
// contacts.source_agent_id is the sharpest trap left after m366: it sits on the same
// row as contacts.agent_id, one is a users.id and the other an agents.id. A detector
// that keys on the TABLE instead of the COLUMN gets both of these backwards.
check("flags a resolved agents.id on a users(id) FK",
  scanSourceReverse('await svc.from("contacts").insert({ source_agent_id: await resolveAgentId(svc, x) })', "t.ts").length === 1)
check("flags listings.agent_id on a users(id) FK",
  scanSourceReverse('await svc.from("contacts").insert({ source_agent_id: listing.agent_id })', "t.ts").length === 1)
check("accepts a genuine users.id there",
  scanSourceReverse('await svc.from("contacts").insert({ source_agent_id: user.id })', "t.ts").length === 0)
check("accepts an already-normalised agentUserId",
  scanSourceReverse('await svc.from("listing_agreements").insert({ agent_user_id: agentUserId })', "t.ts").length === 0)

console.log("\n[pure — a LEAD is not a CONTACT]")
check("flags a lead id in a contacts(id) FK",
  scanSourceLead('await svc.from("activities").insert({ contact_id: ctx.leadId })', "t.ts").length === 1)
check("accepts the repo's correct shape (null + entity_type/entity_id)",
  scanSourceLead('await svc.from("activities").insert({ contact_id: null, entity_type: "lead", entity_id: ctx.leadId })', "t.ts").length === 0)
check("accepts a param named leadId that is validated as a contact",
  scanSourceLead('await svc.from("conversations").insert({ contact_id: data.leadId && isValidUUID(data.leadId) ? data.leadId : null })', "t.ts").length === 0)

console.log("\n[pure — an UNTYPED polymorphic scope column]")
check("flags the auth user id as an agent-scope scope_id",
  scanSourceScopeId(`svc.from("ai_identity_profiles").select("*").eq("scope_type","agent").eq("scope_id", user.id)`, "t").length === 1)
check("accepts a resolved agents.id there",
  scanSourceScopeId(`svc.from("ai_identity_profiles").select("*").eq("scope_type","agent").eq("scope_id", agent.id)`, "t").length === 0)
check("leaves the team + brokerage scopes alone (their ids are not agents.id)",
  scanSourceScopeId(`svc.from("ai_identity_profiles").select("*").eq("scope_type","brokerage").eq("scope_id", user.id)`, "t").length === 0)
check("catches the WRITE side too (upsert payload, not just a filter)",
  scanSourceScopeId(`svc.from("ai_identity_profiles").upsert({ scope_type: "agent", scope_id: userId })`, "t").length === 1)

console.log("\n[repo scan]")
const files: string[] = []
for (const d of ["app", "lib", "services"]) for (const f of walk(join(root, d))) files.push(f)
const offenders: WrongClassWrite[] = []
for (const f of files) {
  let src = ""
  try { src = readFileSync(f, "utf8") } catch { continue }
  if (!src.includes(".from(")) continue
  offenders.push(...scanSource(src, relative(root, f).replace(/\\/g, "/")))
}
console.log(`  · ${files.length} files scanned · ${Object.keys(AGENT_FK_COLUMNS).length} tables carry an agents(id) FK`)
check("no user-id expression is written to an agents(id) FK column",
  offenders.length === 0,
  offenders.map((o) => `${o.file}: ${o.table}.${o.column} = ${o.expr}`).join("; "))

const reverse: WrongClassWrite[] = []
for (const f of files) {
  let src = ""
  try { src = readFileSync(f, "utf8") } catch { continue }
  if (!src.includes(".from(")) continue
  reverse.push(...scanSourceReverse(src, relative(root, f).replace(/\\/g, "/")))
}
console.log(`  · ${Object.keys(USERS_FK_AGENTISH_COLUMNS).length} tables carry an agent-ISH users(id) FK`)
check("no agents-id expression is written to a users(id) FK column",
  reverse.length === 0,
  reverse.map((o) => `${o.file}: ${o.table}.${o.column} = ${o.expr}`).join("; "))

const leadHits: WrongClassWrite[] = []
for (const f of files) {
  let src = ""
  try { src = readFileSync(f, "utf8") } catch { continue }
  if (!src.includes(".from(")) continue
  leadHits.push(...scanSourceLead(src, relative(root, f).replace(/\\/g, "/")))
}
console.log(`  · ${CONTACT_FK_TABLES.length} tables carry a contacts(id) FK on contact_id`)
check("no LEAD id is written into a contacts(id) FK column",
  leadHits.length === 0,
  leadHits.map((o) => `${o.file}: ${o.table}.${o.column} = ${o.expr}`).join("; "))

const scopeHits: WrongClassWrite[] = []
for (const f of files) {
  let src = ""
  try { src = readFileSync(f, "utf8") } catch { continue }
  if (!src.includes("ai_identity_profiles")) continue
  scopeHits.push(...scanSourceScopeId(src, relative(root, f).replace(/\\/g, "/")))
}
console.log(`  · ai_identity_profiles.scope_id carries NO foreign key — the FK maps cannot see it`)
check("no auth user id is used as an agent-scope ai_identity_profiles.scope_id",
  scopeHits.length === 0,
  scopeHits.map((o) => `${o.file}: ${o.column} = ${o.expr}`).join("; "))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ AGENT_ID_CLASS_FAIL — resolve through resolveAgentId (lib/kernel/agent-identity)")
  process.exit(1)
}
console.log(" ✅ AGENT_ID_CLASS_PASS — every agents(id) FK write carries an agents.id")
