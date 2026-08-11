#!/usr/bin/env tsx
/**
 * scripts/wave11-slice-loops-simulator.ts   (npm run test:slice-loops)
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO LOOPS THAT REPORTED SUCCESS WHILE DOING NOTHING.
 *
 * L1 — THE DEAL'S AGENT WAS NEVER TOLD. `lib/kernel/notification-engine.ts`
 *      resolves recipients into `notifications.user_id`, which FKs `users(id)`.
 *      Three of its branches read AGENTS-class columns — `contacts.agent_id`,
 *      `transactions.agent_id`, `listings.agent_id` (all three FK `agents(id)`;
 *      verified live against pg_constraint and snapshotted in
 *      scripts/agent-fk-columns.ts) — and wrote them straight in. Every such
 *      insert was FK-rejected, and supabase-js RESOLVES a rejected write, so the
 *      engine printed "Created notification" for a row the database had thrown
 *      away.
 *
 * L2 — THE EARNEST-MONEY WATCHDOG COULD NOT RAISE A FLAG, AND ITS DEDUPE WAS
 *      DEAD. The cron called a `"use server"` action whose first act is a
 *      cookie-session gate, so every iteration returned Unauthorized — while the
 *      route incremented `flagged` regardless. Its 48h dedupe filtered
 *      `notes ilike '%<offerId>%em_receipt_missing%'`, a literal no writer in the
 *      tree emits, so it matched nothing on every run: fixing the auth half alone
 *      would have traded silence for a nightly re-flag of every accepted offer.
 *
 * HOW THIS PROOF IS BUILT
 *   · SOURCE assertions read the CONSTRUCT, never a spelling — "no expression
 *     whose column is `agent_id` is written into a users-FK field", "no import of
 *     this route resolves to a `use server` module", "the guard on the write's
 *     error sits before the success log" — so a correct refactor that renames a
 *     helper or moves code keeps them green.
 *   · Every source assertion carries NEGATIVE CONTROLS: the defect is written
 *     back into the real file, the mutation is verified to have applied (a
 *     find-string that no longer matches is theatre, not a control), the check is
 *     required to flip to failure, and the file is restored and verified by
 *     sha256.
 *   · BEHAVIOUR assertions drive the real `lib/compliance/raise-offer-flag.ts`
 *     through an injected stub client — no credentials, no live rows, so "the
 *     query returned nothing" can never be mistaken for health. tsx compiles to
 *     CJS, so a mutated module cannot be re-imported inside one process; those
 *     assertions are therefore controlled by DISCRIMINATION instead — each pairs
 *     the positive with the cases that must NOT match (another offer, another
 *     miss, outside the window), so an always-true implementation fails them.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { createHash } from "node:crypto"

import {
  complianceFlagKey,
  recordOfferComplianceFlag,
  OFFER_COMPLIANCE_FLAG_EVENT,
  FLAG_STATUS_OPEN,
} from "../lib/compliance/offer-flag-resolution"
import {
  raiseOfferComplianceFlag,
  resolveUnattendedRaiserUserId,
  emReceiptFlagRaisedWithin,
  emReceiptFlagSubject,
} from "../lib/compliance/raise-offer-flag"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = {
  engine: "lib/kernel/notification-engine.ts",
  core:   "lib/compliance/raise-offer-flag.ts",
  action: "app/actions/buyer-offer/flag-compliance.ts",
  cron:   "app/api/cron/em-receipt-watcher/route.ts",
}

/** Read fresh every time — the negative layer rewrites these files. */
const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
/** Comment-stripped source: prose must never satisfy a structural assertion. */
const code = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

// ─────────────────────────────────────────────────────────────────────────────
// Small source utilities (construct-level, not spelling-level)
// ─────────────────────────────────────────────────────────────────────────────

/** Index of the matching close brace for the `{` at `open`. */
function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") { depth--; if (depth === 0) return i }
  }
  return -1
}

/** Body of a top-level function declaration, by name. */
function fnBody(src: string, name: string): string | null {
  const m = new RegExp(`function\\s+${name}\\s*[(<]`).exec(src)
  if (!m) return null
  const open = src.indexOf("{", src.indexOf(")", m.index))
  const close = matchBrace(src, open)
  return close === -1 ? null : src.slice(open, close + 1)
}

/** The property name an expression ends in: `contact?.agent_id` → `agent_id`. */
function terminalProperty(expr: string): string {
  const parts = expr.split(/[.?]+/).filter(Boolean)
  return parts[parts.length - 1] ?? expr
}

/** Every import specifier in a module (static + dynamic). */
function importSpecifiers(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/import\s+[^;]*?from\s*["']([^"']+)["']/g)) out.push(m[1])
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1])
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1])
  return out
}

/** Resolve a repo-local import specifier to a file on disk (null for packages). */
function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2))
  else if (spec.startsWith(".")) base = resolve(dirname(resolve(ROOT, fromFile)), spec)
  else return null
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand)) return cand
  }
  return null
}

/** Does a module carry a top-level "use server" directive? */
function isUseServerModule(absPath: string): boolean {
  const src = readFileSync(absPath, "utf8")
    .replace(/^﻿/, "")
    .replace(/^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)+/, "")
    .trimStart()
  return /^["']use server["']/.test(src)
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion harness
// ─────────────────────────────────────────────────────────────────────────────
type Outcome = { ok: boolean; detail?: string }
interface Assertion {
  id: string
  what: string
  layer: "source" | "behaviour"
  run: () => Outcome | Promise<Outcome>
  /** Source mutations that MUST flip this assertion to failure. */
  breaks: Array<{ file: string; find: string; replace: string }>
}

const A: Assertion[] = []

// ═════════════════════════════════════════════════════════════════════════════
// L1 — notification recipients
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "L1.no-agents-id-is-written-into-a-users-fk",
  layer: "source",
  what: "notifications.user_id FKs users(id): no value written to a `user_id` field in the notification engine is an expression whose column is `agent_id` (the plain spelling is agents(id) everywhere in this schema)",
  run: () => {
    const src = code(F.engine)
    const offenders: string[] = []
    for (const m of src.matchAll(/user_id:\s*([A-Za-z_$][\w$]*(?:\s*\??\.\s*[\w$]+)*)/g)) {
      const expr = m[1].replace(/\s+/g, "")
      if (/agent_id$/.test(terminalProperty(expr))) offenders.push(expr)
    }
    return offenders.length === 0
      ? { ok: true, detail: "every user_id value is users-class" }
      : { ok: false, detail: `agents-class expression written to user_id: ${offenders.join(", ")}` }
  },
  breaks: [
    {
      file: F.engine,
      find: `    await pushResolvedAgentRecipient(recipients, transaction?.agent_id, "agent", "transactions.agent_id")`,
      replace: `    if (transaction?.agent_id) recipients.push({ user_id: transaction.agent_id, role: "agent" })`,
    },
    {
      file: F.engine,
      find: `    await pushResolvedAgentRecipient(recipients, listing?.agent_id, "agent", "listings.agent_id")`,
      replace: `    if (listing?.agent_id) recipients.push({ user_id: listing.agent_id, role: "agent" })`,
    },
    {
      file: F.engine,
      find: `    await pushResolvedAgentRecipient(recipients, contact?.agent_id, "agent", "contacts.agent_id")`,
      replace: `    if (contact?.agent_id) recipients.push({ user_id: contact.agent_id, role: "agent" })`,
    },
  ],
})

A.push({
  id: "L1.every-agent_id-read-flows-through-the-canonical-resolver",
  layer: "source",
  what: "every `*.agent_id` read in the engine is an argument to a call that reaches lib/kernel/agent-identity-resolver.ts:resolveAgentRecordToUserId — no second resolver, no inline agents lookup",
  run: () => {
    const src = code(F.engine)
    if (!/resolveAgentRecordToUserId/.test(src)) return { ok: false, detail: "the canonical resolver is not named in this file at all" }

    /** Function names in this file whose body reaches the canonical resolver. */
    const resolving = new Set<string>(["resolveAgentRecordToUserId"])
    for (const m of src.matchAll(/function\s+([A-Za-z0-9_$]+)\s*[(<]/g)) {
      const body = fnBody(src, m[1])
      if (body && /resolveAgentRecordToUserId\s*\(/.test(body)) resolving.add(m[1])
    }

    const bad: string[] = []
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*\??\.\s*agent_id\b/g)) {
      // Which call is this read an argument to? Nearest `identifier(` to the left
      // with no intervening `)` closing it.
      const before = src.slice(Math.max(0, m.index! - 200), m.index!)
      const call = /([A-Za-z0-9_$]+)\s*\(\s*[^()]*$/.exec(before)
      if (!call || !resolving.has(call[1])) bad.push(`${m[0]} (callee: ${call?.[1] ?? "none"})`)
    }
    return bad.length === 0
      ? { ok: true, detail: `${resolving.size - 1} local resolver path(s)` }
      : { ok: false, detail: `agents-class read not routed through the resolver: ${bad.join(" | ")}` }
  },
  breaks: [
    {
      file: F.engine,
      find: `  const userId = await resolveAgentRecordToUserId(agentRecordId)`,
      replace: `  const userId = agentRecordId`,
    },
  ],
})

A.push({
  id: "L1.an-unresolvable-agent-yields-no-recipient",
  layer: "source",
  what: "a resolve that yields nothing produces NO recipient — it is never `??`-substituted with the agents id or any other id class",
  run: () => {
    const src = code(F.engine)
    // The function that actually calls the resolver AND pushes a recipient —
    // found by inspecting each declared function's own body, so a rename or a
    // reordering of the file does not change the answer.
    let holder: string | null = null
    let body: string | null = null
    for (const m of src.matchAll(/function\s+([A-Za-z0-9_$]+)\s*[(<]/g)) {
      const b = fnBody(src, m[1])
      if (b && /resolveAgentRecordToUserId\s*\(/.test(b) && /recipients\.push/.test(b)) {
        if (!body || b.length < body.length) { holder = m[1]; body = b }
      }
    }
    if (!holder || !body) return { ok: false, detail: "nothing in this file resolves an agents id and pushes a recipient" }
    if (/\?\?/.test(body)) return { ok: false, detail: `${holder} contains a ?? fallback across the id boundary` }
    const push = body.indexOf("recipients.push")
    const guard = body.search(/if\s*\(\s*!\s*[A-Za-z0-9_$]+\s*\)/)
    if (push === -1) return { ok: false, detail: `${holder} never pushes a recipient` }
    if (guard === -1 || guard > push) return { ok: false, detail: "the push is not guarded by the empty-resolve check" }
    return { ok: true, detail: `${holder} refuses before pushing` }
  },
  breaks: [
    {
      file: F.engine,
      find: `  const userId = await resolveAgentRecordToUserId(agentRecordId)`,
      replace: `  const userId = (await resolveAgentRecordToUserId(agentRecordId)) ?? agentRecordId`,
    },
  ],
})

A.push({
  id: "L1.a-rejected-notification-cannot-log-as-created",
  layer: "source",
  what: "the notifications insert destructures its error, and the guard on that error sits BEFORE the success log — supabase-js resolves a rejected write, so without this the log announces rows the database refused",
  run: () => {
    const src = code(F.engine)
    const m = /const\s*\{\s*error:\s*([A-Za-z0-9_$]+)\s*\}\s*=\s*await\s+[\w.]+\.from\("notifications"\)/.exec(src)
    if (!m) return { ok: false, detail: "the notifications insert does not destructure an error" }
    const errName = m[1]
    const guard = src.indexOf(`if (${errName})`, m.index)
    const success = src.search(/console\.log\([^)]*Created notification/)
    if (guard === -1) return { ok: false, detail: `${errName} is destructured but never checked` }
    if (success === -1) return { ok: true, detail: "no success log to protect" }
    return guard < success
      ? { ok: true, detail: "guard precedes the success log" }
      : { ok: false, detail: "the success log can print before the error is examined" }
  },
  breaks: [
    {
      file: F.engine,
      find: `        const { error: insertError } = await supabase.from("notifications").insert({`,
      replace: `        await supabase.from("notifications").insert({`,
    },
  ],
})

A.push({
  id: "L1.a-failed-bell-never-fails-the-deal",
  layer: "source",
  what: "the failed-insert branch does NOT rethrow — processKernelEvent sits on the emit path of every lifecycle action, so throwing there would turn an undeliverable notification into a failed offer or transaction for the human who triggered it",
  run: () => {
    const src = code(F.engine)
    const m = /const\s*\{\s*error:\s*([A-Za-z0-9_$]+)\s*\}\s*=\s*await\s+[\w.]+\.from\("notifications"\)/.exec(src)
    if (!m) return { ok: false, detail: "the notifications insert does not destructure an error" }
    const guard = src.indexOf(`if (${m[1]})`, m.index)
    if (guard === -1) return { ok: false, detail: "no error guard" }
    const open = src.indexOf("{", guard)
    const branch = src.slice(open, matchBrace(src, open) + 1)
    return /\bthrow\b/.test(branch)
      ? { ok: false, detail: "the branch rethrows — a failed bell would break the caller's write" }
      : { ok: true }
  },
  breaks: [
    {
      file: F.engine,
      find: `          continue
        }

        console.log(\`[NotificationEngine] Created notification for user \${recipient.user_id}\`)`,
      replace: `          throw insertError
        }

        console.log(\`[NotificationEngine] Created notification for user \${recipient.user_id}\`)`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// L2 — the earnest-money watchdog
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "L2.the-cron-calls-no-use-server-module",
  layer: "source",
  what: "no import of the em-receipt cron resolves to a `use server` module — a cron holds a service credential and has no cookies, so a session-gated RPC returns Unauthorized on every iteration",
  run: () => {
    const src = code(F.cron)
    const offenders: string[] = []
    for (const spec of importSpecifiers(src)) {
      const abs = resolveLocal(spec, F.cron)
      if (abs && isUseServerModule(abs)) offenders.push(spec)
    }
    return offenders.length === 0
      ? { ok: true, detail: "every dependency is session-free" }
      : { ok: false, detail: `session-gated dependency: ${offenders.join(", ")}` }
  },
  breaks: [
    {
      file: F.cron,
      find: `import { verifyCronAuth } from "@/lib/cron-auth"`,
      replace: `import { verifyCronAuth } from "@/lib/cron-auth"\nimport { flagOfferCompliance } from "@/app/actions/buyer-offer/flag-compliance"`,
    },
  ],
})

A.push({
  id: "L2.the-shared-core-is-session-free",
  layer: "source",
  what: "the extracted core is not a `use server` module and never reaches for a cookie session — it takes a client, so the action and the cron are two doors into one implementation",
  run: () => {
    const abs = resolve(ROOT, F.core)
    if (!existsSync(abs)) return { ok: false, detail: "the core module does not exist" }
    if (isUseServerModule(abs)) return { ok: false, detail: "the core is itself a use-server module" }
    const src = code(F.core)
    if (/@\/lib\/supabase\/server/.test(src)) return { ok: false, detail: "the core imports the cookie-session client" }
    if (/auth\.getUser\(/.test(src)) return { ok: false, detail: "the core reads a session" }
    if (!/export\s+async\s+function\s+raiseOfferComplianceFlag\s*\(\s*\n?\s*svc/.test(src) &&
        !/raiseOfferComplianceFlag\([\s\S]{0,80}svc:\s*SupabaseClient/.test(src)) {
      return { ok: false, detail: "the raise core does not take an injected client" }
    }
    return { ok: true }
  },
  breaks: [
    {
      file: F.core,
      find: `import { isValidUUID } from "@/lib/validations"`,
      replace: `import { createClient } from "@/lib/supabase/server"\nimport { isValidUUID } from "@/lib/validations"`,
    },
  ],
})

A.push({
  id: "L2.the-session-gate-on-the-rpc-is-untouched",
  layer: "source",
  what: "the `use server` action still authenticates BEFORE it raises anything, and takes no bypass parameter — an RPC endpoint that could be told it is a cron is one any authenticated caller could claim",
  run: () => {
    const abs = resolve(ROOT, F.action)
    if (!isUseServerModule(abs)) return { ok: false, detail: "the action lost its use-server boundary" }
    const src = code(F.action)
    const auth = src.indexOf("auth.getUser(")
    const raise = src.indexOf("raiseOfferComplianceFlag(")
    if (auth === -1) return { ok: false, detail: "the action no longer authenticates" }
    if (raise === -1) return { ok: false, detail: "the action no longer calls the shared core" }
    if (auth > raise) return { ok: false, detail: "the raise happens before the gate" }
    if (!/if\s*\(!\s*\w+\)\s*return\s*\{[^}]*Unauthorized/.test(src)) {
      return { ok: false, detail: "there is no refusal between the gate and the work" }
    }
    if (/\b(bypassAuth|isCron|systemCall|skipAuth)\b/.test(src)) {
      return { ok: false, detail: "the action accepts a bypass parameter" }
    }
    return { ok: true }
  },
  breaks: [
    {
      file: F.action,
      find: `  if (!authUser) return { success: false, error: "Unauthorized" }`,
      replace: `  const bypassAuth = true`,
    },
  ],
})

A.push({
  id: "L2.the-dedupe-keys-on-what-the-writer-writes",
  layer: "source",
  what: "the 48h window matches on `metadata.flag_key` derived from complianceFlagKey — the identity the writer actually stamps — and nowhere filters `notes` for a literal no writer emits",
  run: () => {
    const src = code(F.core)
    if (/ilike/i.test(src) && /notes/.test(src)) {
      const m = /\.filter\(\s*["']notes["']/.exec(src)
      if (m) return { ok: false, detail: "the window filters on notes text" }
    }
    if (!/\.filter\(\s*["']metadata->>flag_key["']/.test(src)) {
      return { ok: false, detail: "the window does not anchor on metadata.flag_key" }
    }
    if (!/complianceFlagKey\s*\(/.test(src)) {
      return { ok: false, detail: "the key is not derived from the shared identity function" }
    }
    if (/em_receipt_missing/.test(src.replace(/\/\/.*$/gm, ""))) {
      return { ok: false, detail: "a literal that no writer emits is back in the query" }
    }
    return { ok: true }
  },
  breaks: [
    {
      file: F.core,
      find: `    .filter("metadata->>flag_key", "eq", emReceiptFlagKey())`,
      replace: `    .filter("notes", "ilike", \`%\${params.offerId}%em_receipt_missing%\`)`,
    },
  ],
})

A.push({
  id: "L2.the-flag-title-is-stable-so-the-key-is-stable",
  layer: "source",
  what: "the raised title carries NO interpolation and the moving numbers live in the body — the flag key is a function of the title, so a title that changes daily would mint a new open flag every run",
  run: () => {
    const src = code(F.cron)
    const call = src.indexOf("raiseOfferComplianceFlag(")
    if (call === -1) return { ok: false, detail: "the cron does not call the shared core" }
    const open = src.indexOf("{", call)
    const args = src.slice(open, matchBrace(src, open) + 1)
    /** Value of one key of the argument object, up to the next top-level comma. */
    const argValue = (key: string): string => {
      const at = args.indexOf(`${key}:`)
      if (at === -1) return ""
      let depth = 0, quote: string | null = null, esc = false
      for (let i = at + key.length + 1; i < args.length; i++) {
        const c = args[i]
        if (esc) { esc = false; continue }
        if (quote) { if (c === "\\") esc = true; else if (c === quote) quote = null; continue }
        if (c === '"' || c === "'" || c === "`") { quote = c; continue }
        if ("({[".includes(c)) depth++
        else if (")}]".includes(c)) { if (depth === 0) return args.slice(at + key.length + 1, i); depth-- }
        else if (c === "," && depth === 0) return args.slice(at + key.length + 1, i)
      }
      return ""
    }
    const title = argValue("title")
    const body = argValue("body")
    if (!title.trim()) return { ok: false, detail: "no title argument found" }
    if (/\$\{/.test(title)) return { ok: false, detail: `the title interpolates: ${title.trim()}` }
    if (!body || !/\$\{/.test(body)) return { ok: false, detail: "the overdue detail is not in the body" }
    return { ok: true, detail: `title: ${title.trim()}` }
  },
  breaks: [
    {
      file: F.cron,
      find: `      title: subject.title,`,
      replace: `      title: \`\${subject.title} (\${overdueDays} days past contract deadline)\`,`,
    },
  ],
})

A.push({
  id: "L2.every-unflagged-offer-leaves-a-reason",
  layer: "source",
  what: "every `continue` in the sweep is preceded by a recorded reason, and `flagged` is only incremented after the raise reports success — the previous build counted flags it had not raised and skipped offers with no trace at all",
  run: () => {
    const src = code(F.cron)
    const loop = /for\s*\(const\s+offer\s+of\s+offers\)\s*\{/.exec(src)
    if (!loop) return { ok: false, detail: "the sweep loop changed shape" }
    const open = src.indexOf("{", loop.index)
    const body = src.slice(open, matchBrace(src, open) + 1)

    // The statement IMMEDIATELY before each `continue` must be the recorded
    // reason. A looser "somewhere in the last N characters" test passes on a
    // silent exit that merely follows an unrelated recorded one — verified: that
    // version did not flip under its own negative control.
    const unrecorded: number[] = []
    for (const m of body.matchAll(/\bcontinue\b/g)) {
      const back = body.slice(0, m.index!)
      if (!/skipped\.push\((?:[^()]|\([^()]*\))*\)\s*$/.test(back)) unrecorded.push(m.index!)
    }
    if (unrecorded.length > 0) return { ok: false, detail: `${unrecorded.length} silent continue(s)` }

    const guard = body.search(/if\s*\(\s*!\s*\w+\.success\s*\)/)
    const counted = body.indexOf("flagged++")
    if (counted === -1) return { ok: false, detail: "nothing counts a raised flag" }
    if (guard === -1 || guard > counted) return { ok: false, detail: "the count is not gated on a successful raise" }
    return { ok: true, detail: `${[...body.matchAll(/\bcontinue\b/g)].length} guarded exits` }
  },
  breaks: [
    {
      file: F.cron,
      find: `      skipped.push({ offerId, reason: "no earnest money required on this offer" })
      continue`,
      replace: `      continue`,
    },
    {
      file: F.cron,
      find: `    if (!outcome.success) {`,
      replace: `    if (outcome === null) {`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// BEHAVIOUR — the real core, driven through a stub client
// ═════════════════════════════════════════════════════════════════════════════

type Row = Record<string, any>
interface StubOpts { readError?: Record<string, string> }

/** A supabase-shaped, TABLE-AWARE stub. Only the chain shapes these modules use. */
function makeStub(tables: Record<string, Row[]>, opts: StubOpts = {}) {
  let seq = 0
  return {
    tables,
    from(table: string) {
      const rows = (tables[table] ??= [])
      const st: any = { op: "select", filters: {}, json: {}, payload: null, order: null, asc: true, single: false }
      const b: any = {
        select() { st.op = st.op === "select" ? "select" : st.op; return b },
        insert(p: any) { st.op = "insert"; st.payload = p; return b },
        update(p: any) { st.op = "update"; st.payload = p; return b },
        eq(c: string, v: any) { st.filters[c] = v; return b },
        filter(c: string, _o: string, v: any) { st.json[c] = v; return b },
        in(c: string, v: any[]) { st.inFilter = { c, v }; return b },
        or() { return b },
        not() { return b },
        lte() { return b },
        gte() { return b },
        order(c: string, o?: { ascending?: boolean }) { st.order = c; st.asc = o?.ascending !== false; return b },
        limit() { return b },
        maybeSingle() { st.single = true; return b },
        single() { st.single = true; return b },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      const matches = (r: Row) => {
        for (const [k, v] of Object.entries(st.filters)) if (r[k] !== v) return false
        for (const [k, v] of Object.entries(st.json)) {
          const m = /^metadata->>(.+)$/.exec(k)
          if (m && (r.metadata ?? {})[m[1]] !== v) return false
        }
        if (st.inFilter && !st.inFilter.v.includes(r[st.inFilter.c])) return false
        return true
      }
      function run() {
        const failure = opts.readError?.[table]
        if (st.op === "select") {
          if (failure) return { data: null, error: { message: failure } }
          let hit = rows.filter(matches)
          if (st.order) hit = [...hit].sort((a, c) =>
            st.asc ? String(a[st.order]).localeCompare(String(c[st.order]))
                   : String(c[st.order]).localeCompare(String(a[st.order])))
          return { data: st.single ? (hit[0] ?? null) : hit, error: null }
        }
        if (st.op === "update") {
          for (const r of rows.filter(matches)) Object.assign(r, st.payload)
          return { data: null, error: null }
        }
        if (st.op === "insert") {
          for (const p of (Array.isArray(st.payload) ? st.payload : [st.payload])) {
            rows.push({ id: `stub-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...p })
          }
          return { data: null, error: null }
        }
        return { data: null, error: null }
      }
      return b
    },
  } as any
}

const OFFER      = "11111111-1111-4111-8111-111111111111"
const OTHER_OFFER = "22222222-2222-4222-8222-222222222222"
const BROKERAGE  = "33333333-3333-4333-8333-333333333333"
const RAISER     = "66666666-6666-4666-8666-666666666666"
const ISA_ACTOR  = "99999999-9999-4999-8999-999999999999"
const PRINCIPAL  = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

/** Write one EM-receipt flag exactly the way production writes it. */
async function seedEmFlag(store: any, opts: { offerId?: string; at?: string; title?: string } = {}) {
  const subject = emReceiptFlagSubject()
  const result = await recordOfferComplianceFlag({
    offerId: opts.offerId ?? OFFER,
    brokerageId: BROKERAGE,
    raiserUserId: RAISER,
    agentId: null,
    contactId: null,
    flagType: opts.title ? "missing_signature" : subject.flagType,
    severity: "high",
    title: opts.title ?? subject.title,
    body: "seeded",
    client: store,
  })
  if (opts.at) {
    for (const r of store.tables.activities ?? []) {
      if (r.entity_id === (opts.offerId ?? OFFER) && !r.__stamped) {
        r.created_at = opts.at
        r.metadata = { ...(r.metadata ?? {}), raised_at: opts.at }
        r.__stamped = true
      }
    }
  }
  return result
}

const DAY = 86_400_000

A.push({
  id: "L2.behaviour.the-window-matches-the-row-the-writer-wrote",
  layer: "behaviour",
  what: "driven end to end against the REAL writer: the 48h window sees the flag production actually stamps, and does NOT see another offer's flag, another miss on the same offer, or the same flag from outside the window",
  run: async () => {
    const now = Date.now()
    const store = makeStub({ activities: [] })
    await seedEmFlag(store, { at: new Date(now - 2 * 3600_000).toISOString() })

    const inside = await emReceiptFlagRaisedWithin(store, {
      brokerageId: BROKERAGE, offerId: OFFER, since: new Date(now - 2 * DAY),
    })
    if (!inside.raisedWithinWindow) return { ok: false, detail: "the window did not see the flag the writer wrote — the dedupe is dead again" }

    const outside = await emReceiptFlagRaisedWithin(store, {
      brokerageId: BROKERAGE, offerId: OFFER, since: new Date(now - 3600_000),
    })
    if (outside.raisedWithinWindow) return { ok: false, detail: "a flag older than the window still suppressed the raise" }

    const otherOffer = await emReceiptFlagRaisedWithin(store, {
      brokerageId: BROKERAGE, offerId: OTHER_OFFER, since: new Date(now - 2 * DAY),
    })
    if (otherOffer.raisedWithinWindow) return { ok: false, detail: "one offer's flag suppressed another offer's" }

    // A DIFFERENT miss on the SAME offer must not suppress the EM receipt miss.
    const store2 = makeStub({ activities: [] })
    await seedEmFlag(store2, { title: "Signature block missing on Purchase Agreement" })
    const otherMiss = await emReceiptFlagRaisedWithin(store2, {
      brokerageId: BROKERAGE, offerId: OFFER, since: new Date(now - 2 * DAY),
    })
    if (otherMiss.raisedWithinWindow) return { ok: false, detail: "an unrelated miss suppressed the EM receipt flag" }

    const wrongTenant = await emReceiptFlagRaisedWithin(store, {
      brokerageId: OTHER_OFFER, offerId: OFFER, since: new Date(now - 2 * DAY),
    })
    if (wrongTenant.raisedWithinWindow) return { ok: false, detail: "the window is not tenant-scoped" }

    return { ok: true, detail: `last raise ${inside.lastRaisedAt}` }
  },
  breaks: [],
})

A.push({
  id: "L2.behaviour.the-legacy-predicate-matched-nothing",
  layer: "behaviour",
  what: "THE PREMISE, proven rather than asserted: the literal the old dedupe searched `notes` for is absent from the row the writer produces, so that filter could never match — and the key that IS present is the shared flag identity",
  run: async () => {
    const store = makeStub({ activities: [] })
    await seedEmFlag(store)
    const row = (store.tables.activities as Row[])[0]
    if (!row) return { ok: false, detail: "the writer produced no row" }
    const notes = String(row.notes ?? "")
    if (/em_receipt_missing/.test(notes)) return { ok: false, detail: "the legacy literal is present — the premise changed, re-read the audit" }
    if (!notes.includes(OFFER)) return { ok: false, detail: "notes does not even carry the offer id" }
    const expected = complianceFlagKey(emReceiptFlagSubject())
    if (row.metadata?.flag_key !== expected) return { ok: false, detail: "the stored key is not the shared identity" }
    return { ok: true, detail: `stored key ${expected}` }
  },
  breaks: [],
})

A.push({
  id: "L2.behaviour.a-stable-title-does-not-stack-flags",
  layer: "behaviour",
  what: "the same miss raised on two different days refreshes ONE open row instead of minting a second — the property the day-count-in-the-title would have destroyed",
  run: async () => {
    const store = makeStub({ activities: [] })
    const first = await seedEmFlag(store)
    const second = await seedEmFlag(store)
    const open = (store.tables.activities as Row[]).filter(
      r => r.activity_type === OFFER_COMPLIANCE_FLAG_EVENT && r.entity_id === OFFER && r.status === FLAG_STATUS_OPEN,
    )
    if (open.length !== 1) return { ok: false, detail: `${open.length} open rows for one miss` }
    if (first.flag_key !== second.flag_key) return { ok: false, detail: "two raises of one miss produced two identities" }
    if (second.deduped !== true) return { ok: false, detail: "the second raise did not report a dedupe" }
    return { ok: true }
  },
  breaks: [],
})

A.push({
  id: "L2.behaviour.an-unreadable-ledger-is-reported-not-swallowed",
  layer: "behaviour",
  what: "a refused window read comes back with an error and does NOT claim the miss was already flagged — supabase-js resolves a refused query, and a silent 'already handled' is how a watchdog goes quiet",
  run: async () => {
    const store = makeStub({ activities: [] }, { readError: { activities: "permission denied" } })
    const r = await emReceiptFlagRaisedWithin(store, {
      brokerageId: BROKERAGE, offerId: OFFER, since: new Date(Date.now() - 2 * DAY),
    })
    if (!r.error) return { ok: false, detail: "a refused read reported no error" }
    if (r.raisedWithinWindow) return { ok: false, detail: "a refused read suppressed the raise" }
    return { ok: true, detail: r.error }
  },
  breaks: [],
})

A.push({
  id: "L2.behaviour.the-raise-refuses-rather-than-writing-a-broken-row",
  layer: "behaviour",
  what: "every fail-closed exit of the raise core writes NOTHING and says why: unreadable offer, missing offer, wrong tenant, tenant-less offer, and an actor id that is not a users id",
  run: async () => {
    const base = () => ({
      offers: [{ id: OFFER, brokerage_id: BROKERAGE, contact_id: null, agent_id: null, transaction_id: null }],
      activities: [] as Row[],
    })
    const cases: Array<[string, () => Promise<any>, () => Row[]]> = []

    const s1 = makeStub(base(), { readError: { offers: "permission denied" } })
    cases.push(["a refused offer read", () => raiseOfferComplianceFlag(s1, {
      offerId: OFFER, raiserUserId: RAISER, flagType: "missing_form", severity: "high", title: "t",
    }), () => s1.tables.activities])

    const s2 = makeStub({ offers: [], activities: [] })
    cases.push(["an offer that does not exist", () => raiseOfferComplianceFlag(s2, {
      offerId: OFFER, raiserUserId: RAISER, flagType: "missing_form", severity: "high", title: "t",
    }), () => s2.tables.activities])

    const s3 = makeStub(base())
    cases.push(["a caller from another tenant", () => raiseOfferComplianceFlag(s3, {
      offerId: OFFER, raiserUserId: RAISER, requireBrokerageId: OTHER_OFFER,
      flagType: "missing_form", severity: "high", title: "t",
    }), () => s3.tables.activities])

    const s4 = makeStub({ offers: [{ id: OFFER, brokerage_id: null, agent_id: null }], activities: [] })
    cases.push(["an offer with no brokerage (activities.brokerage_id is NOT NULL)", () => raiseOfferComplianceFlag(s4, {
      offerId: OFFER, raiserUserId: RAISER, flagType: "missing_form", severity: "high", title: "t",
    }), () => s4.tables.activities])

    const s5 = makeStub(base())
    cases.push(["an actor that is not a users id", () => raiseOfferComplianceFlag(s5, {
      offerId: OFFER, raiserUserId: "system", flagType: "missing_form", severity: "high", title: "t",
    }), () => s5.tables.activities])

    for (const [name, run, rows] of cases) {
      const out = await run()
      if (out.success) return { ok: false, detail: `${name} reported success` }
      if (!out.error) return { ok: false, detail: `${name} refused without saying why` }
      if (rows().length > 0) return { ok: false, detail: `${name} still wrote ${rows().length} row(s)` }
      if (out.notified_count !== 0) return { ok: false, detail: `${name} claimed recipients` }
    }
    return { ok: true, detail: `${cases.length} refusals, zero rows written` }
  },
  breaks: [],
})

A.push({
  id: "L2.behaviour.the-unattended-actor-is-resolved-or-refused",
  layer: "behaviour",
  what: "an unattended sweep files the flag under a REAL users id — the brokerage's system actor, else a brokerage principal — and returns null with a reason when neither exists, so the caller skips loudly instead of writing a placeholder into a users FK",
  run: async () => {
    // Distinct brokerage ids per case: getIsaSystemUserIdCached memoises.
    const B1 = "b1111111-1111-4111-8111-111111111111"
    const B2 = "b2222222-2222-4222-8222-222222222222"
    const B3 = "b3333333-3333-4333-8333-333333333333"

    const s1 = makeStub({ brokerages: [{ id: B1, ai_isa_system_user_id: ISA_ACTOR }], users: [] })
    const r1 = await resolveUnattendedRaiserUserId(s1, { brokerageId: B1 })
    if (r1.userId !== ISA_ACTOR || r1.via !== "isa_system_actor") return { ok: false, detail: "the system actor was not preferred" }

    const s2 = makeStub({
      brokerages: [{ id: B2, ai_isa_system_user_id: null }],
      users: [{ id: PRINCIPAL, brokerage_id: B2, user_type: "broker", created_at: "2026-01-01" }],
    })
    const r2 = await resolveUnattendedRaiserUserId(s2, { brokerageId: B2 })
    if (r2.userId !== PRINCIPAL || r2.via !== "brokerage_principal") return { ok: false, detail: "no fallback to a brokerage principal" }

    const s3 = makeStub({ brokerages: [{ id: B3, ai_isa_system_user_id: null }], users: [] })
    const r3 = await resolveUnattendedRaiserUserId(s3, { brokerageId: B3 })
    if (r3.userId !== null || !r3.error) return { ok: false, detail: "an unresolvable actor did not refuse with a reason" }

    const r4 = await resolveUnattendedRaiserUserId(s3, { brokerageId: null })
    if (r4.userId !== null) return { ok: false, detail: "a tenant-less row still produced an actor" }

    return { ok: true }
  },
  breaks: [],
})

// ═════════════════════════════════════════════════════════════════════════════
// RUN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  let pass = 0, fail = 0
  const failures: string[] = []

  console.log("\n─── ASSERTIONS ───────────────────────────────────────────────────")
  for (const a of A) {
    const r = await a.run()
    if (r.ok) { pass++; console.log(`  ✔ ${a.id}\n      ${a.what}${r.detail ? `\n      → ${r.detail}` : ""}`) }
    else { fail++; failures.push(`${a.id}: ${r.detail ?? ""}`); console.log(`  ✘ ${a.id}\n      ${a.what}\n      → ${r.detail ?? ""}`) }
  }

  let negPass = 0, negFail = 0
  const negProblems: string[] = []
  if (RUN_NEGATIVE) {
    console.log("\n─── NEGATIVE CONTROLS (the defect is written back on purpose) ────")
    for (const a of A) {
      if (a.breaks.length === 0) {
        // Behaviour assertions run against an ALREADY-IMPORTED module (tsx emits
        // CJS, so a mutated file cannot be re-imported in-process). Their control
        // is discrimination instead: each one pairs the positive case with the
        // cases that must NOT match, so an always-true implementation fails it.
        if (a.layer === "behaviour") { console.log(`  · ${a.id}  controlled by discrimination (see the assertion body)`); continue }
        negFail++
        negProblems.push(`${a.id}: source assertion with NO negative control`)
        console.log(`  ✘ ${a.id}  no negative control defined`)
        continue
      }
      for (let i = 0; i < a.breaks.length; i++) {
        const b = a.breaks[i]
        const path = resolve(ROOT, b.file)
        const before = readFileSync(path, "utf8")
        const digest = createHash("sha256").update(before).digest("hex")
        const after = before.replace(b.find, b.replace)
        if (after === before) {
          negFail++
          negProblems.push(`${a.id}[${i}]: the mutation DID NOT APPLY to ${b.file} — the control is theatre`)
          console.log(`  ✘ ${a.id}[${i}]  mutation did not apply — fix the find string`)
          continue
        }
        writeFileSync(path, after, "utf8")
        let broke = false, detail = ""
        try { const r = await a.run(); broke = !r.ok; detail = r.detail ?? "" }
        catch (e) { broke = true; detail = `threw: ${(e as Error).message}` }
        finally { writeFileSync(path, before, "utf8") }
        const restored = createHash("sha256").update(readFileSync(path)).digest("hex") === digest
        if (broke && restored) { negPass++; console.log(`  ✔ ${a.id}[${i}]  flipped RED as required, file restored (sha256 verified)`) }
        else {
          negFail++
          if (!broke) negProblems.push(`${a.id}[${i}]: still PASSED with the defect reintroduced — the assertion is worthless as written`)
          if (!restored) negProblems.push(`${a.id}[${i}]: FILE NOT RESTORED (${b.file})`)
          console.log(`  ✘ ${a.id}[${i}]  ${!broke ? "did NOT flip" : ""}${!restored ? " FILE NOT RESTORED" : ""}${detail ? ` (${detail})` : ""}`)
        }
      }
    }
  }

  console.log("\n" + "═".repeat(70))
  console.log(` ASSERTIONS  ${pass} passed, ${fail} failed`)
  if (RUN_NEGATIVE) console.log(` CONTROLS    ${negPass} flipped RED as required, ${negFail} did not`)
  console.log("═".repeat(70))
  if (failures.length) { console.log("\nFailures:"); failures.forEach(f => console.log("  · " + f)) }
  if (negProblems.length) { console.log("\nControl problems:"); negProblems.forEach(f => console.log("  · " + f)) }

  if (fail > 0 || negFail > 0) { console.log("\n ❌ SLICE_LOOPS_FAIL"); process.exit(1) }
  console.log("\n ✅ SLICE_LOOPS_PASS — the agent is addressable, and the watchdog can raise a flag exactly once per miss")
}
main()
