/**
 * scripts/direct-mail-identity-class-guard.ts
 *
 * test:direct-mail-identity-class — THE DIRECT-MAIL CREATORS WRITE EACH ID IN ITS OWN CLASS.
 *
 * CLAUDE.md §3: `agents.id` and `users.id` are DISJOINT (23503). direct_mail_campaigns has
 * one column of each class — `agent_id` FKs agents, `created_by` FKs users — and the
 * feature gate / usage counter (`canAccessFeature`, `incrementFeatureUsage`) read `users`.
 * Lane 83E found the survivor chain mixing them; lane 84E measured the damage: every caller
 * of app/actions/ai-direct-mail.ts createDirectMailCampaign (create-campaign-dialog,
 * price-reduction-sheet, lib/wizard-staging/content-staging.ts) handed a USERS id as
 * `agentId`, the action wrote it into agent_id, and the FK refused the row — live
 * direct_mail_campaigns held 0 rows on 2026-09-26. content-studio-client did the same
 * through createMailCampaign (`agentId: userId`).
 *
 * THE RULE (asserted, never a waypoint — callers are DISCOVERED, not listed):
 *   R1. Inside each creator body, every USERS sink (canAccessFeature / incrementFeatureUsage
 *       first argument, created_by / createdBy) is fed a users-class value, and every AGENTS
 *       sink (agent_id / agentId) an agents-class value. A sink fed straight from `params.*`
 *       is a violation in a creator — a "use server" body is a request body (§4).
 *   R2. At every call site of either creator (app/ lib/ hooks/ services/, comments and string
 *       contents blanked — a tombstone is not a call site), `agentId:` is never users-class
 *       and `createdBy:` is never agents-class; createDirectMailCampaign takes no `agentId`
 *       at all (it derives both classes from the session).
 *   R3. Every createDirectMailCampaign call site binds the result and reads `.success`
 *       (supabase-style refusals RESOLVE — an unread result announced campaigns that never
 *       existed), and reads only fields the action's success return actually carries.
 *
 * Positive controls: each rule is run against the PRE-84E specimens and must flag them.
 * Blind spots: the classifier follows one assignment hop (const/let, a React `setX(...)`
 * setter, an object-literal default); a value laundered through two helpers reads
 * "unknown" and is reported as unknown, never as clean. Dynamic `import()` call sites are
 * found (the name is matched, not the import).
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { blankStrings } from "./strip-comments"

let pass = 0
let fail = 0
const failures: string[] = []
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// ── class classifier ──────────────────────────────────────────────────────────
type IdClass = "users" | "agents" | "body" | "unknown"

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }

/** Classify one expression, following ONE assignment hop inside `scope` (blanked code). */
export function classify(exprRaw: string, scope: string, depth = 0): IdClass {
  const expr = exprRaw.trim().replace(/\s*\?\?\s*(undefined|null)\s*$/, "").trim()
  if (/^(params|input|body|args)\.\w+$/.test(expr)) return "body"
  if (/(^|\.)userId$|(^|\.)user_id$|^user\.id$|^actorUserId$/.test(expr)) return "users"
  if (/resolveAgentIdInBrokerage\(|resolveAgentId\(|agentRow\.id\b|(^|\.)agentId$|^agentRecordId$|(^|\.)agent_id$/.test(expr)) {
    // A bare `agentId` identifier is only agents-class if its assignment says so.
    if (expr === "agentId" && depth === 0) return classifyIdentifier(expr, scope, depth)
    return "agents"
  }
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) return classifyIdentifier(expr, scope, depth)
  return "unknown"
}

function classifyIdentifier(name: string, scope: string, depth: number): IdClass {
  if (depth > 1) return "unknown"
  const n = escapeRe(name)
  const cap = name.charAt(0).toUpperCase() + name.slice(1)
  const rhs: string[] = []
  for (const m of scope.matchAll(new RegExp(`(?:const|let|var)\\s+${n}(?:\\s*:[^=]+)?\\s*=\\s*([^\\n;]+)`, "g"))) rhs.push(m[1])
  for (const m of scope.matchAll(new RegExp(`(?<![\\w.])${n}\\s*=\\s*(?!=)([^\\n;]+)`, "g"))) rhs.push(m[1])
  for (const m of scope.matchAll(new RegExp(`set${escapeRe(cap)}\\(([^)\\n]+)\\)`, "g"))) rhs.push(m[1])
  const classes = new Set(rhs.map((r) => classify(r.replace(/^await\s+/, ""), scope, depth + 1)))
  classes.delete("unknown")
  if (classes.size === 1) return [...classes][0]
  if (classes.size > 1) return "unknown"
  return "unknown"
}

// ── argument / body extraction on BLANKED code ───────────────────────────────
function balancedFrom(code: string, open: number): string {
  const o = code[open]
  const c = o === "{" ? "}" : o === "(" ? ")" : "]"
  let d = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) d++
    else if (code[i] === c) { d--; if (d === 0) return code.slice(open, i + 1) }
  }
  return code.slice(open)
}

function functionBody(code: string, name: string): string | null {
  const m = new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`).exec(code)
  if (!m) return null
  const params = balancedFrom(code, m.index + m[0].length - 1)
  const braceAt = code.indexOf("{", m.index + m[0].length - 1 + params.length)
  return balancedFrom(code, braceAt)
}

/** Top-level `key: value` pairs of an object literal (blanked). */
function topLevelProps(obj: string): Map<string, string> {
  const out = new Map<string, string>()
  const inner = obj.slice(1, -1)
  let d = 0, start = 0
  const parts: string[] = []
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if ("{([".includes(ch)) d++
    else if ("})]".includes(ch)) d--
    else if (ch === "," && d === 0) { parts.push(inner.slice(start, i)); start = i + 1 }
  }
  parts.push(inner.slice(start))
  for (const p of parts) {
    const t = p.trim()
    if (!t) continue
    const km = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(t)
    if (km) out.set(km[1], km[2].trim())
    else if (/^[A-Za-z_$][\w$]*$/.test(t)) out.set(t, t) // shorthand
  }
  return out
}

// ── R1: sinks inside a creator body ──────────────────────────────────────────
export interface SinkViolation { sink: string; expr: string; got: IdClass; want: "users" | "agents" }
export function creatorSinkViolations(body: string): SinkViolation[] {
  const v: SinkViolation[] = []
  const check = (sink: string, expr: string, want: "users" | "agents") => {
    const got = classify(expr, body)
    if (got !== want) v.push({ sink, expr: expr.trim(), got, want })
  }
  for (const m of body.matchAll(/\b(canAccessFeature|incrementFeatureUsage)\(\s*([^,)]+)/g)) check(m[1], m[2], "users")
  for (const m of body.matchAll(/\b(created_by|createdBy)\s*:\s*([^,\n}]+)/g)) check(m[1], m[2], "users")
  for (const m of body.matchAll(/\b(agent_id|agentId)\s*:\s*([^,\n}]+)/g)) check(m[1], m[2], "agents")
  return v
}

// ── R2 / R3: call sites ──────────────────────────────────────────────────────
export interface CallSite { file: string; line: number; args: Map<string, string>; bound: string | null; tail: string }
export function callSites(file: string, code: string, fn: string): CallSite[] {
  const out: CallSite[] = []
  const re = new RegExp(`(?<![\\w.$])${fn}\\s*\\(`, "g")
  for (const m of code.matchAll(re)) {
    const before = code.slice(Math.max(0, m.index! - 40), m.index!)
    if (/(function|async)\s+$/.test(before)) continue // a definition
    const open = m.index! + m[0].length - 1
    const argText = balancedFrom(code, open)
    const firstBrace = argText.indexOf("{")
    const args = firstBrace >= 0 ? topLevelProps(balancedFrom(argText, firstBrace)) : new Map<string, string>()
    const bm = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*)?await\s+$/.exec(code.slice(Math.max(0, m.index! - 80), m.index!))
    out.push({
      file, line: code.slice(0, m.index!).split("\n").length, args,
      bound: bm ? bm[1] : null,
      tail: code.slice(open + argText.length, open + argText.length + 2500),
    })
  }
  return out
}

export function callSiteViolations(site: CallSite, scope: string, fn: string): string[] {
  const v: string[] = []
  const agentExpr = site.args.get("agentId")
  if (fn === "createDirectMailCampaign" && agentExpr !== undefined) {
    v.push(`passes agentId (${agentExpr}) — the action derives both id classes from the session`)
  }
  if (agentExpr !== undefined && classify(agentExpr, scope) === "users") {
    v.push(`agentId is users-class (${agentExpr}) — agent_id FKs agents`)
  }
  const createdBy = site.args.get("createdBy")
  if (createdBy !== undefined && classify(createdBy, scope) === "agents") {
    v.push(`createdBy is agents-class (${createdBy}) — created_by FKs users`)
  }
  return v
}

export function resultReadViolations(site: CallSite, returnKeys: Set<string>): string[] {
  const v: string[] = []
  if (!site.bound) return ["result is not bound — a resolved { success: false } is never read"]
  const b = escapeRe(site.bound)
  if (!new RegExp(`\\b${b}\\??\\.success\\b|\\(${b}\\s+as\\b[^)]*\\)\\.success`).test(site.tail)) {
    v.push(`result \`${site.bound}\` never has .success read`)
  }
  const reads = new Set<string>()
  for (const m of site.tail.matchAll(new RegExp(`(?<![\\w.])${b}\\??\\.([A-Za-z_$][\\w$]*)`, "g"))) reads.add(m[1])
  for (const m of site.tail.matchAll(new RegExp(`\\(${b}\\s+as\\s+[^)]*\\)\\??\\.([A-Za-z_$][\\w$]*)`, "g"))) reads.add(m[1])
  for (const k of reads) if (!returnKeys.has(k)) v.push(`reads \`${site.bound}.${k}\`, a field the action never returns`)
  return v
}

function successReturnKeys(body: string): Set<string> {
  const keys = new Set<string>(["success", "error"])
  for (const m of body.matchAll(/return\s*\{/g)) {
    const obj = balancedFrom(body, m.index! + m[0].length - 1)
    if (!/success\s*:\s*true/.test(obj)) continue
    for (const k of topLevelProps(obj).keys()) keys.add(k)
  }
  return keys
}

// ── walk ─────────────────────────────────────────────────────────────────────
const ROOTS = ["app", "lib", "hooks", "services"]
function walk(dir: string, out: string[]) {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p)
  }
}

console.log("\n── R1: each creator writes each id in its own class ──")
const CREATORS: Array<[string, string]> = [
  ["app/actions/direct-mail.ts", "createMailCampaign"],
  ["app/actions/ai-direct-mail.ts", "createDirectMailCampaign"],
]
const bodies = new Map<string, string>()
for (const [file, fn] of CREATORS) {
  const body = functionBody(blankStrings(read(file)), fn)
  ok(`${fn} found in ${file}`, !!body)
  if (!body) continue
  bodies.set(fn, body)
  const v = creatorSinkViolations(body)
  const sinks = [...body.matchAll(/\b(canAccessFeature|incrementFeatureUsage|created_by|createdBy|agent_id|agentId)\b\s*[:(]/g)].length
  ok(`${fn}: ${sinks} identity sinks, 0 fed the wrong class or a raw params.* value`, v.length === 0,
    v.map((x) => `${x.sink} ← ${x.expr} (${x.got}, want ${x.want})`).join("; "))
  ok(`${fn}: the tenant is the SESSION's (a foreign brokerageId is refused)`,
    /getAgentContext\(\)/.test(body) && /params\.brokerageId\s*(!==|&&)/.test(body))
}
const mailBody = bodies.get("createMailCampaign") ?? ""
ok("createMailCampaign verifies a supplied agentId is an agents row IN the session tenant",
  /\.from\("\s*"\)|\.from\(/.test(mailBody) &&
  /\.eq\("\s*",\s*params\.agentId\)\s*\.eq\("\s*",\s*actor\.brokerageId\)/.test(mailBody))
ok("createMailCampaign refuses a createdBy that is not the session user",
  /params\.createdBy\s*!==\s*actor\.userId/.test(mailBody))

console.log("\n── R2 / R3: every call site (discovered) ──")
const files: string[] = []
for (const r of ROOTS) walk(join(process.cwd(), r), files)
const directReturnKeys = successReturnKeys(bodies.get("createDirectMailCampaign") ?? "")
let sitesSeen = 0
for (const abs of files) {
  const rel = abs.slice(process.cwd().length + 1)
  const raw = readFileSync(abs, "utf8")
  if (!/createMailCampaign|createDirectMailCampaign/.test(raw)) continue
  const code = blankStrings(raw)
  for (const fn of ["createMailCampaign", "createDirectMailCampaign"]) {
    for (const site of callSites(rel, code, fn)) {
      // lib/kernel/marketing.ts defines its own (unwired) kernel createDirectMailCampaign; a
      // call to THAT one carries `ctx`, not the action's shape — judged by its args.
      if (fn === "createDirectMailCampaign" && site.args.has("ctx")) continue
      sitesSeen++
      const v = callSiteViolations(site, code, fn)
      const r = fn === "createDirectMailCampaign" ? resultReadViolations(site, directReturnKeys) : []
      ok(`${rel}:${site.line} ${fn}(…) — ids in class${fn === "createDirectMailCampaign" ? ", result read" : ""}`,
        v.length === 0 && r.length === 0, [...v, ...r].join("; "))
    }
  }
}
ok(`call sites discovered: ${sitesSeen} (denominator; a zero here means the finder is blind)`, sitesSeen >= 4)

console.log("\n── positive controls: the pre-84E shapes must be flagged ──")
{
  const oldAction = blankStrings(`export async function createDirectMailCampaign(params: { agentId: string }) {
    const access = await canAccessFeature(params.agentId, "direct_mail")
    const campaignResult = await createMailCampaign({
      brokerageId: params.brokerageId,
      agentId: params.agentId,
      createdBy: params.agentId,
    })
  }`)
  const v = creatorSinkViolations(functionBody(oldAction, "createDirectMailCampaign") ?? "")
  ok("control: old createDirectMailCampaign (one agentId into gate + createdBy + agentId) is flagged",
    v.some((x) => x.sink === "canAccessFeature") && v.some((x) => x.sink === "createdBy"))

  const oldCreator = blankStrings(`export async function createMailCampaign(params: P) {
    const access = await canAccessFeature(params.createdBy, "direct_mail")
    await supabase.from("direct_mail_campaigns").insert({ agent_id: params.agentId ?? null, created_by: params.createdBy })
  }`)
  const vc = creatorSinkViolations(functionBody(oldCreator, "createMailCampaign") ?? "")
  ok("control: old createMailCampaign (raw params into agent_id / created_by) is flagged",
    vc.some((x) => x.sink === "agent_id" && x.got === "body") && vc.some((x) => x.sink === "created_by"))

  const oldStaging = blankStrings(`async function s(ctx: AgentCtx) {
    const result = await createDirectMailCampaign({
      agentId: ctx.userId,
      brokerageId: ctx.brokerageId,
    })
    if (!result.success) return
    const campaignId = (result as { campaignId?: string }).campaignId
  }`)
  const [ss] = callSites("specimen", oldStaging, "createDirectMailCampaign")
  ok("control: content-staging's old `agentId: ctx.userId` is flagged users-class",
    !!ss && callSiteViolations(ss, oldStaging, "createDirectMailCampaign").some((x) => /users-class/.test(x)))
  ok("control: content-staging's old `.campaignId` read (a field never returned) is flagged",
    !!ss && resultReadViolations(ss, directReturnKeys).some((x) => /campaignId/.test(x)))

  const oldStudio = blankStrings(`function C({ userId }: { userId?: string }) {
    const result = await createMailCampaign({ brokerageId: b, agentId: userId, createdBy: userId })
  }`)
  const [cs] = callSites("specimen", oldStudio, "createMailCampaign")
  ok("control: content-studio's old `agentId: userId` is flagged users-class",
    !!cs && callSiteViolations(cs, oldStudio, "createMailCampaign").some((x) => /users-class/.test(x)))

  const oldDialog = blankStrings(`function D() {
    const [agentId, setAgentId] = useState("")
    setAgentId(user.id)
    const result = await createDirectMailCampaign({ brokerageId, agentId })
  }`)
  const [ds] = callSites("specimen", oldDialog, "createDirectMailCampaign")
  ok("control: the dialog's old shorthand `agentId` (set from user.id) is flagged, class followed through the setter",
    !!ds && callSiteViolations(ds, oldDialog, "createDirectMailCampaign").some((x) => /users-class/.test(x)))

  const oldSheet = blankStrings(`async function f() {
    await createDirectMailCampaign({ brokerageId })
    toast.success("launched")
  }`)
  const [ps] = callSites("specimen", oldSheet, "createDirectMailCampaign")
  ok("control: the price sheet's old unbound result (success toast on a refusal) is flagged",
    !!ps && resultReadViolations(ps, directReturnKeys).length > 0)

  const tomb = blankStrings(`// createMailCampaign({ agentId: userId, createdBy: userId })\nconst x = "createMailCampaign({ agentId: userId })"`)
  ok("control: a tombstone / string mention is NOT a call site", callSites("specimen", tomb, "createMailCampaign").length === 0)

  ok("control: the classifier reads a verified agents local as agents and a session user as users",
    classify("agentRecordId", "") === "agents" && classify("actor.userId", "") === "users" && classify("auth.userId", "") === "users")
}

console.log(`\n${"═".repeat(70)}`)
console.log(`DIRECT MAIL IDENTITY CLASS — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log("OK — agent_id gets an agents id, created_by / the gate a users id, at every discovered site")
