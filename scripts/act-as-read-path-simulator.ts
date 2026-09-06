#!/usr/bin/env tsx
/**
 * scripts/act-as-read-path-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO CLOSURES ON THE ACT-AS SEAM, PROVED BY RUNNING THE CODE.
 *
 *   #1  A read_only support grant could not READ. The act-as merge classified
 *       several gate helpers as WRITERS because their callers write, and routed
 *       every export behind them through resolveWriteContext — which refuses a
 *       'read_only' grant outright. The refusal was fail-closed and visible
 *       rather than silent, so nothing was ever mis-reported; what it did was
 *       BLANK the settings cards a support seat opens first. §5: "a grant walks
 *       the account and never exceeds it" — a read-only grant that cannot see
 *       the account is not walking it.
 *
 *   #2  lib/application/transactions.ts wrote on the COOKIE client at 40 writer
 *       functions. Under act-as the staff user is not a member of the target
 *       tenant, so tenant RLS refuses — and supabase-js RESOLVES a refusal
 *       (CLAUDE.md §3), so a refused UPDATE is byte-identical to one that
 *       worked. On the transactions kernel that is a commission marked paid
 *       that was not marked paid. The same client also had no concept of a
 *       grant MODE, so a read_only grant could write.
 *
 * ── WHY THIS FILE RUNS THE CODE INSTEAD OF READING IT ────────────────────────
 *
 * Both findings are about BEHAVIOUR under a grant mode, and a regex over source
 * text cannot see behaviour: a gate can name the right function and still be
 * reached from the wrong branch. So each subject below is COMPILED AND EXECUTED
 * twice — once from the file as it stands, once from the same file with the
 * pre-fix line spliced back in — and the assertion is on what the exported
 * server action actually RETURNS to a scripted read_only session.
 *
 * The bundle is real code, not a re-implementation. `lib/platform/acting-context.ts`
 * is bundled AS-IS, so decideWriteChannel, the fresh getAgentContext resolution
 * and the READ_ONLY_ACTING_ERROR string are the shipping ones. Only the LEAVES
 * are stubbed: the identity resolver (so a session can be scripted without a
 * browser), the two supabase client constructors (so "which client did this
 * write go through" is observable), and the Next/server-only shims a bundler
 * cannot execute outside a request. Every stub is listed in STUBS below — that
 * list IS the blind spot, published beside the number (§2).
 *
 * Run: npx tsx scripts/act-as-read-path-simulator.ts
 */
import { execFileSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { stripComments } from "./strip-comments"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE HARNESS
// ═══════════════════════════════════════════════════════════════════════════

/** A scripted session, exactly the shape getAgentContext returns. */
interface ScriptedSession {
  isAuthenticated: boolean
  userId: string
  agentId: string | null
  brokerageId: string | null
  userType: string
  isImpersonating?: boolean
  impersonationMode?: string | null
  impersonatorUserId?: string | null
}

/**
 * The leaves that are replaced, and why each one has to be.
 * PUBLISHED, because a proof that stubs something it does not name is a proof of
 * whatever is left (§2 — "publish blind spots beside the number").
 */
const STUBS: Record<string, string> = {
  // ── Identity. The ONLY way to script a grant mode without a browser session.
  //    Everything downstream of it — decideWriteChannel, the read/write split,
  //    the refusal string — is the real module.
  "@/lib/identity/get-agent-context": `
    exports.getAgentContext = async () => globalThis.__SESSION__
  `,
  // ── The two client constructors. Stubbed so the test can OBSERVE which
  //    channel a write went through, which is the whole subject of #2.
  "@/lib/supabase/server": `exports.createClient = async () => globalThis.__mkdb("cookie")`,
  "@/lib/supabase/service": `exports.createServiceClient = () => globalThis.__mkdb("service")`,
  // ── FK-safe agentId resolution: a DB round trip the harness has no rows for.
  "@/lib/kernel/agent-identity": `exports.resolveAgentId = async () => null`,
  // ── Next.js request-scoped APIs. Cannot execute outside a request.
  "next/cache": `exports.revalidatePath = () => {}; exports.revalidateTag = () => {}`,
  "next/headers": `exports.cookies = async () => ({ getAll: () => [], set: () => {} })`,
  "server-only": ``,
  // ── Leaves the subjects import at module scope but never reach on the gate
  //    path under test. Anything NOT listed here is a Proxy no-op (see
  //    stubModule) — that is the published blind spot.
  "@/lib/voice/twilio-tenancy": `
    exports.loadVoiceUsage = async () => ({ calls: 0, minutes: 0, costCents: 0 })
    exports.resolveTenantTwilioCreds = async () => null
  `,
  "@/lib/ai": `exports.runPipelineSimple = async () => "{}"`,
  "@/lib/kernel/lifecycle": `exports.transitionLifecycle = async () => ({ ok: true })`,
  "@/lib/commission/ledger-sync": `exports.syncStampToAgentLedger = async () => ({ ok: true })`,
  "@/lib/brokerage": `exports.getDefaultCommissionStructure = async () => null`,
  "@/lib/notifications/transaction-parties-packet": `exports.rosterForPrincipal = async () => []`,
}

/**
 * A fake postgrest builder. Records every call so the assertions can ask which
 * CHANNEL a write went through and how many writes were attempted.
 */
const DB_HARNESS = `
  globalThis.__CALLS__ = []
  globalThis.__mkdb = (channel) => {
    const rec = (op, table) => globalThis.__CALLS__.push({ channel, op, table })
    const mk = (table) => {
      const thenable = {
        select: () => thenable, eq: () => thenable, in: () => thenable, is: () => thenable,
        neq: () => thenable, gte: () => thenable, lte: () => thenable, lt: () => thenable,
        gt: () => thenable, like: () => thenable, or: () => thenable, order: () => thenable,
        limit: () => thenable, range: () => thenable,
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (res) => res({ data: [], error: null }),
      }
      return {
        select: () => thenable,
        insert: (...a) => { rec("insert", table); return thenable },
        update: (...a) => { rec("update", table); return thenable },
        upsert: (...a) => { rec("upsert", table); return thenable },
        delete: () => { rec("delete", table); return thenable },
      }
    }
    // A cookie client carries the SESSION; a service client never does. Several
    // pre-fix gates called auth.getUser() directly on a client they opened
    // themselves, and that difference is exactly what the conversion had to
    // account for — so the harness models it rather than returning null to both.
    const sess = globalThis.__SESSION__
    const user = channel === "cookie" && sess && sess.isAuthenticated ? { id: sess.userId } : null
    return { from: (table) => mk(table), auth: { getUser: async () => ({ data: { user } }) } }
  }
`

/**
 * Every stub is emitted as CommonJS behind a Proxy, for one reason: a stub with
 * a fixed export list has to be extended every time an unrelated file downstream
 * imports one more name from the same module, and a proof that has to be nursed
 * gets weakened until it passes. The Proxy answers ANY unlisted name with a
 * no-op, so the stub boundary is stable and the listed behaviour is the only
 * behaviour that matters. `then` is deliberately undefined — a thenable module
 * namespace would deadlock `await import()`.
 */
function stubModule(realExports: string): string {
  return `
    const __impl = (() => { const exports = {}; ${realExports} ; return exports })()
    module.exports = new Proxy(__impl, {
      has: () => true,
      get(t, k) {
        if (k === "then") return undefined
        if (typeof k === "symbol") return Reflect.get(t, k)
        if (k in t) return t[k]
        if (k === "__esModule") return true
        return function __unstubbed() {}
      },
    })
  `
}

const stubPlugin = (overrides: Record<string, string>) => ({
  name: "lane-bq-stubs",
  setup(b: any) {
    b.onResolve({ filter: /.*/ }, (args: any) => {
      if (args.kind === "entry-point") return null
      if (overrides[args.path] || STUBS[args.path]) return { path: args.path, namespace: "stub" }
      if (args.path.startsWith("@/")) return null // real module, resolved by tsconfig paths
      if (args.path.startsWith(".") || args.path.startsWith("/")) return null
      // Any other bare specifier is a third-party leaf: proxy-stub it too, so an
      // npm package pulled in transitively cannot decide whether this proof runs.
      return { path: args.path, namespace: "stub" }
    })
    b.onLoad({ filter: /.*/, namespace: "stub" }, (args: any) => ({
      contents: stubModule(overrides[args.path] ?? STUBS[args.path] ?? ""),
      loader: "js",
    }))
  },
})

/**
 * Compile ONE source file (given as text, so a pre-fix variant can be spliced)
 * and hand back its live module namespace.
 */
const TEMP_FILES: string[] = []

async function loadModule(
  relPath: string,
  source: string,
  extraStubs: Record<string, string> = {},
  variant: "before" | "after" | "seam" = "after",
): Promise<any> {
  const abs = join(ROOT, relPath)
  const result = await build({
    stdin: { contents: source, resolveDir: dirname(abs), sourcefile: abs, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent",
    tsconfig: join(ROOT, "tsconfig.json"),
    plugins: [stubPlugin(extraStubs)],
  })
  const code = DB_HARNESS + "\n" + result.outputFiles[0].text
  // Written to a real file rather than a data: URL — a data: URL puts the whole
  // (megabyte) bundle into every stack frame, which turns one runtime error into
  // an unreadable dump. `variant` keeps BEFORE and AFTER on separate paths so
  // Node's module cache cannot hand one back for the other.
  const out = join(tmpdir(), `lane-bq-${variant}-${relPath.replace(/[^a-z0-9]+/gi, "_")}.mjs`)
  writeFileSync(out, code)
  TEMP_FILES.push(out)
  return import(pathToFileURL(out).href)
}

function session(over: Partial<ScriptedSession> = {}): ScriptedSession {
  return {
    isAuthenticated: true,
    userId: "11111111-1111-1111-1111-111111111111",
    agentId: null,
    // VIP Premier Realty — a real live tenant, so "the acting tenant" is not a
    // placeholder (SELECT id FROM brokerages, 2026-08-26).
    brokerageId: "b0000000-0000-0000-0000-000000000001",
    userType: "broker",
    isImpersonating: false,
    impersonationMode: null,
    impersonatorUserId: null,
    ...over,
  }
}

const READ_ONLY_GRANT = session({
  isImpersonating: true,
  impersonationMode: "read_only",
  impersonatorUserId: "99999999-9999-9999-9999-999999999999",
})
const FULL_GRANT = session({
  isImpersonating: true,
  impersonationMode: "full",
  impersonatorUserId: "99999999-9999-9999-9999-999999999999",
})

/** Run `fn` with a scripted session installed, and report the calls it made. */
async function underSession(s: ScriptedSession, fn: () => Promise<any>): Promise<{ result: any; calls: any[] }> {
  ;(globalThis as any).__SESSION__ = s
  ;(globalThis as any).__CALLS__ = []
  const result = await fn()
  return { result, calls: [...((globalThis as any).__CALLS__ ?? [])] }
}

const REFUSAL = "Read-only impersonation — switch to full access to make changes."

/**
 * Did this call SUCCEED? Every subject speaks one of two shapes — `{ ok }` or
 * `{ success }` — and several of the pre-fix gates flattened the seam's refusal
 * into their own generic "Unauthorized" before returning it.
 *
 * WHICH IS WHY THE ASSERTIONS BELOW ARE DIFFERENTIAL. Matching the seam's
 * refusal STRING would have been a waypoint (§2): it passes only while the
 * message survives every gate unrewritten, and it says nothing about whether a
 * FULL grant fared any better. The claim being proved is "this grant mode was
 * treated differently from that one", so both modes are run and compared. A
 * finder that cannot tell them apart fails the control in section 0.
 */
function succeeded(r: any): boolean {
  if (!r || typeof r !== "object") return false
  return r.ok === true || r.success === true
}

/** Did this result carry the seam's read_only refusal verbatim? */
function refusedReadOnly(r: any): boolean {
  if (!r || typeof r !== "object") return false
  const text = [r.error, r.message, r.reason].filter((v) => typeof v === "string").join(" | ")
  return text.includes(REFUSAL)
}

/**
 * THE LAST VERSION OF THIS FILE THAT STILL HAD THE DEFECT.
 *
 * WAS `git show HEAD:<path>`, AND THAT WAS A §2 WAYPOINT — one that could only
 * be discovered by finishing. While this lane's work sat uncommitted, HEAD was
 * genuinely the pre-fix tree and every BEFORE assertion reproduced the finding.
 * The instant the fix was COMMITTED, HEAD became the fixed tree, "before" and
 * "after" compiled to the same module, and all 21 BEFORE assertions went red —
 * not because anything regressed, but because the work was done. That is
 * CLAUDE.md §2's "do not pin an assertion to a WAYPOINT" exactly: during a
 * multi-step change every intermediate state is briefly true and then
 * permanently false.
 *
 * DERIVED INSTEAD OF PINNED. A hardcoded base SHA would be the same mistake in
 * slower motion — correct until the branch is rebased or squash-merged. So the
 * rule is stated and the commit derived from it: walk this file's history
 * newest-first and take the first blob that does NOT yet contain the fix
 * marker. Whatever the history looks like later, "the last version without the
 * fix" still means the same thing.
 *
 * SHALLOW CLONES ARE DEEPENED, NOT TOLERATED. The first CI run after this
 * function landed proved the fail-closed path works — by failing CI. actions/
 * checkout fetches depth 1, so `git log` saw exactly one commit, its blob
 * carried the marker, and the guard threw exactly as designed:
 *
 *   Error: act-as-read-path: no pre-fix version of app/actions/voice-tenancy.ts
 *   is reachable in this history (searched 1 commit(s) …)
 *
 * The refusal was correct — the environment genuinely could not supply the
 * BEFORE half — but the environment is fixable from here: a shallow repo can be
 * DEEPENED from origin. So when the walk comes up empty AND the repo is
 * shallow, this fetches more history and retries, escalating depth, before
 * refusing. The fail-closed throw is unchanged for the cases deepening cannot
 * cure: a squash-merged history where no pre-fix blob exists on any depth, a
 * marker that stopped matching, no reachable remote.
 *
 * FAILS CLOSED (§4). If no such version exists — a squashed history, a fresh
 * clone with no ancestry, a marker that stopped matching — this THROWS rather
 * than falling back to HEAD. Falling back would silently compare the fixed file
 * against itself, which is precisely how these assertions would go green while
 * proving nothing: the failure mode this function was rewritten to remove.
 */
function beforeFix(relPath: string, marker: RegExp = /resolveActingContext|actingWriteContext/): string {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

  const walk = (): string | null => {
    const log = git("log", "--format=%H", "--", relPath).split("\n").filter(Boolean)
    for (const sha of log) {
      let blob: string
      try {
        blob = git("show", `${sha}:${relPath}`)
      } catch {
        continue // the file did not exist at that commit
      }
      if (!marker.test(blob)) return blob
    }
    return null
  }

  let found = walk()

  // Depths chosen so the common CI case (depth 1, pre-fix a handful of commits
  // back) resolves on the first deepen, while a pathological history gets two
  // more chances before --unshallow fetches everything. Each step is a no-op
  // once the repo is no longer shallow.
  for (const deepen of ["--deepen=64", "--deepen=512", "--unshallow"]) {
    if (found) break
    let shallow = false
    try {
      shallow = git("rev-parse", "--is-shallow-repository").trim() === "true"
    } catch {
      break // not even a git repo worth deepening — fall through to the throw
    }
    if (!shallow) break
    try {
      git("fetch", "--quiet", deepen, "origin")
    } catch {
      break // no reachable remote — deepening cannot cure this, refuse below
    }
    found = walk()
  }

  if (found) return found

  throw new Error(
    `act-as-read-path: no pre-fix version of ${relPath} is reachable in this history ` +
      `(walked every commit touching it, deepening a shallow clone from origin where possible, ` +
      `for a blob without ${marker}). The BEFORE half of this proof cannot run, so it refuses ` +
      `rather than comparing the fixed file to itself.`,
  )
}

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Act-as READ paths + transactions-kernel writes (lane BQ)")
  console.log("══════════════════════════════════════════════════\n")

  // ── 0. The harness itself must be able to see a refusal ───────────────────
  //
  // POSITIVE CONTROL FOR THE WHOLE FILE. If the seam never refuses under this
  // harness, every "does not refuse" assertion below is vacuously true and the
  // file is a clean bill of health for a broken instrument (§2).
  console.log("[0 — the instrument works: the seam still refuses a read_only WRITE]")
  const seam = await loadModule("lib/platform/acting-context.ts", read("lib/platform/acting-context.ts"), {}, "seam")
  {
    const ro = await underSession(READ_ONLY_GRANT, () => seam.resolveWriteContext())
    check("resolveWriteContext REFUSES a read_only grant, with the standard string",
      ro.result.ok === false && ro.result.error === REFUSAL, JSON.stringify(ro.result))
    const full = await underSession(FULL_GRANT, () => seam.resolveWriteContext())
    check("…and ADMITS a full grant, on the SERVICE channel",
      full.result.ok === true && full.result.db?.__channel !== "cookie")
    const roRead = await underSession(READ_ONLY_GRANT, () => seam.resolveActingContext())
    check("resolveActingContext ADMITS the same read_only grant and flags it readOnly",
      roRead.result.ok === true && roRead.result.readOnly === true)
    const plain = await underSession(session(), () => seam.resolveWriteContext())
    check("a normal tenant user is unaffected — still admitted, still the cookie client",
      plain.result.ok === true)
    check("the refusal string the harness matches on IS the module's own constant",
      seam.READ_ONLY_ACTING_ERROR === REFUSAL)
  }

  // ── 1. THE READ PATHS ─────────────────────────────────────────────────────
  //
  // Each subject is one converted gate helper. BEFORE = the file at HEAD;
  // AFTER = the file on disk. The assertion is the same both times, so the
  // BEFORE run is the positive control for the AFTER run: if the finder cannot
  // see the old refusal it cannot certify the new admission.
  console.log("\n[1 — reads a read_only support grant was refused, and now is not]")

  interface ReadSubject {
    file: string
    /** Exported READ action that must now admit a read_only grant. */
    reader: string
    /** Exported WRITE action on the same gate that must STILL refuse it. */
    writer: string
    writerArgs?: unknown[]
    readerArgs?: unknown[]
    extraStubs?: Record<string, string>
  }

  const READ_SUBJECTS: ReadSubject[] = [
    { file: "app/actions/voice-tenancy.ts", reader: "getTwilioByoStatusAction", writer: "setTwilioByoCredsAction",
      writerArgs: [{ accountSid: "AC" + "0".repeat(32), authToken: "x".repeat(32) }] },
    { file: "app/actions/tenant-connections.ts", reader: "getTenantConnectionsAction", writer: "saveTenantConnectionAction",
      writerArgs: [{ platform: "listhub", apiKey: "abcdefgh" }],
      extraStubs: { "@/lib/settings/tenant-connection-slots": `exports.TENANT_CONNECTION_SLOTS = [{ key: "listhub", label: "ListHub", note: "", fields: ["apiKey"] }]` } },
    { file: "app/actions/a2p-registration.ts", reader: "getA2pStatusAction", writer: "saveA2pBusinessProfileAction",
      writerArgs: [{}],
      extraStubs: { "@/lib/voice/a2p-registration": `
        exports.validateA2pProfile = () => ({ ok: true, value: {} })
        exports.loadA2pState = async () => ({ state: {} })
        exports.runA2pRegistration = async () => ({ ok: true })
        exports.describeA2pState = () => ""
        exports.nextA2pStep = () => ""
      ` } },
  ]

  for (const s of READ_SUBJECTS) {
    const label = s.file.split("/").pop()
    const before = await loadModule(s.file, beforeFix(s.file), s.extraStubs, "before")
    const after = await loadModule(s.file, read(s.file), s.extraStubs, "after")
    const rArgs = s.readerArgs ?? []
    const wArgs = s.writerArgs ?? []

    // THE FINDING, stated differentially: on the SAME reader, a full grant got
    // through and a read_only grant did not.
    const beforeFull = await underSession(FULL_GRANT, () => before[s.reader](...rArgs))
    const beforeRo = await underSession(READ_ONLY_GRANT, () => before[s.reader](...rArgs))
    check(`${label} · BEFORE — ${s.reader} answered a FULL grant but REFUSED a read_only one (the finding)`,
      succeeded(beforeFull.result) && !succeeded(beforeRo.result),
      `full=${JSON.stringify(beforeFull.result).slice(0, 80)} ro=${JSON.stringify(beforeRo.result).slice(0, 80)}`)

    const afterRo = await underSession(READ_ONLY_GRANT, () => after[s.reader](...rArgs))
    check(`${label} · AFTER — ${s.reader} answers the read_only grant, and wrote NOTHING doing so`,
      succeeded(afterRo.result) && afterRo.calls.length === 0,
      JSON.stringify(afterRo.result).slice(0, 160) + " | writes=" + afterRo.calls.length)

    // THE OTHER HALF, and the one that matters more: nothing was widened.
    const afterWriteFull = await underSession(FULL_GRANT, () => after[s.writer](...wArgs))
    const afterWriteRo = await underSession(READ_ONLY_GRANT, () => after[s.writer](...wArgs))
    check(`${label} · AFTER — ${s.writer} STILL refuses that grant, before any write, and refuses a FULL grant for no such reason`,
      !succeeded(afterWriteRo.result) && afterWriteRo.calls.length === 0 && !refusedReadOnly(afterWriteFull.result),
      `ro=${JSON.stringify(afterWriteRo.result).slice(0, 80)} roWrites=${afterWriteRo.calls.length} full=${JSON.stringify(afterWriteFull.result).slice(0, 80)}`)

    // …and an ordinary tenant seat is untouched in both directions.
    const tenantRead = await underSession(session(), () => after[s.reader](...rArgs))
    check(`${label} · a normal tenant admin still reads (no seat lost to the change)`,
      succeeded(tenantRead.result))
    const outsider = await underSession(session({ userType: "agent" }), () => after[s.reader](...rArgs))
    check(`${label} · the ROLE gate is unchanged — a plain agent is still refused the admin read`,
      !succeeded(outsider.result), JSON.stringify(outsider.result).slice(0, 120))
  }

  // Two more readers that moved directly (no local gate helper).
  console.log("\n[1b — direct conversions: no gate helper, same rule]")
  {
    const file = "app/actions/vendors/vendor-plan-subscriptions.ts"
    const extraStubs = {
      "@/lib/vendors/vendor-money-directions": `
        exports.VENDOR_PACKAGE = "vendor_package"
        exports.VENDOR_PLATFORM_TIER = "platform"
        exports.VENDOR_PACKAGE_BILLING_DIRECTION = "vendor_to_brokerage"
        exports.describeDirection = () => ""
      `,
    }
    const before = await loadModule(file, beforeFix(file), extraStubs, "before")
    const after = await loadModule(file, read(file), extraStubs, "after")
    const bFull = await underSession(FULL_GRANT, () => before.listVendorPackageEnrolmentsAction())
    const bRo = await underSession(READ_ONLY_GRANT, () => before.listVendorPackageEnrolmentsAction())
    const aRo = await underSession(READ_ONLY_GRANT, () => after.listVendorPackageEnrolmentsAction())
    check("vendor-plan-subscriptions · BEFORE — the enrolment LIST answered a full grant and refused a read_only one",
      succeeded(bFull.result) && !succeeded(bRo.result),
      `full=${JSON.stringify(bFull.result).slice(0, 70)} ro=${JSON.stringify(bRo.result).slice(0, 70)}`)
    check("vendor-plan-subscriptions · AFTER — it reads for read_only, and writes nothing",
      succeeded(aRo.result) && aRo.calls.length === 0, JSON.stringify(aRo.result).slice(0, 140))
    const w = await underSession(READ_ONLY_GRANT, () =>
      after.enrolVendorInPackageAction({ vendorId: "v", planId: "p" }))
    check("vendor-plan-subscriptions · AFTER — the ENROLMENT write still refuses it, with the seam's own message",
      refusedReadOnly(w.result) && w.calls.length === 0, JSON.stringify(w.result).slice(0, 140))
  }

  // ── 2. THE TRANSACTIONS KERNEL ────────────────────────────────────────────
  console.log("\n[2 — lib/application/transactions.ts: writers ride the seam]")
  {
    const file = "lib/application/transactions.ts"
    const extraStubs = {
      "@/lib/transactions/milestone-catalog": `exports.milestoneJourneyFor = () => []`,
      "@/lib/transactions/transaction-stages": `exports.MILESTONE_STATUS = { PENDING: "pending", COMPLETED: "completed" }`,
      "@/lib/transactions/coordination-status": `exports.DOCUMENT_OPEN_STATUSES = []`,
      "@/lib/transactions/transaction-status": `
        exports.TRANSACTION_STATUSES_IN_ESCROW = []
        exports.TRANSACTION_STATUSES_TERMINAL = []
        exports.TRANSACTION_STATUSES_OPEN = []
        exports.inPipelineColumn = () => false
      `,
      "@/lib/enrichment/deal-vocabulary": `exports.TXN_STATUSES_AFTER = []; exports.TXN_STAGES_AFTER = []`,
    }
    const before = await loadModule(file, beforeFix(file), extraStubs, "before")
    const after = await loadModule(file, read(file), extraStubs, "after")

    // WRITERS, one from each family the file owns. Chosen because each is a
    // different table and a different return shape — the conversion had to keep
    // 40 separate contracts, so the proof samples across them rather than
    // asserting one shape seven times.
    const WRITERS: Array<[string, unknown[]]> = [
      ["markCommissionPaid", ["c1", "2026-08-26", "1001"]],           // money
      ["updateTransaction", ["t1", { status: "active" }]],            // the deal row
      ["completeMilestone", ["m1", "u1", "done"]],                    // journey
      ["removeParticipant", ["p1"]],                                  // a DELETE
      ["addTransactionDocument", [{ transaction_id: "t1", document_name: "d" }]],
      ["updateDocumentStatus", ["d1", "signed"]],
      ["addDeadline", [{ transaction_id: "t1", deadline_type: "x", due_date: "2026-09-01" }]],
      ["scheduleInspection", [{ transaction_id: "t1", inspection_type: "general" }]],
    ]

    for (const [fn, args] of WRITERS) {
      const b = await underSession(READ_ONLY_GRANT, () => before[fn](...args))
      const a = await underSession(READ_ONLY_GRANT, () => after[fn](...args))
      check(`transactions · BEFORE — ${fn} let a read_only grant reach a WRITE (${b.calls.length} attempted)`,
        b.calls.length > 0 && !refusedReadOnly(b.result))
      check(`transactions · AFTER — ${fn} refuses the grant and attempts NO write`,
        refusedReadOnly(a.result) && a.calls.length === 0,
        JSON.stringify(a.result).slice(0, 140) + " | writes=" + a.calls.length)
    }

    // THE OTHER DIRECTION — the one that was silently losing support's work.
    for (const [fn, args] of WRITERS) {
      const b = await underSession(FULL_GRANT, () => before[fn](...args))
      const a = await underSession(FULL_GRANT, () => after[fn](...args))
      check(`transactions · BEFORE — ${fn} wrote a full act-as grant through the COOKIE client (RLS refuses; supabase-js resolves it as success)`,
        b.calls.length > 0 && b.calls.every((c: any) => c.channel === "cookie"))
      check(`transactions · AFTER — ${fn} writes through the SERVICE client, so the support write lands`,
        a.calls.length > 0 && a.calls.every((c: any) => c.channel === "service"))
    }

    // A NORMAL TENANT SEAT MUST NOT MOVE AT ALL.
    for (const [fn, args] of WRITERS) {
      const a = await underSession(session(), () => after[fn](...args))
      check(`transactions · a normal tenant user still writes on their OWN RLS client — ${fn}`,
        a.calls.length > 0 && a.calls.every((c: any) => c.channel === "cookie"))
    }

    // READERS ARE DELIBERATELY NOT CONVERTED — that is what keeps a read_only
    // grant able to SEE the tenant. Negative control in the other direction.
    for (const fn of ["getTransactions", "getTransactionById", "getTransactionMilestones", "getClientTasks"]) {
      const a = await underSession(READ_ONLY_GRANT, () => after[fn]("t1"))
      check(`transactions · reader ${fn} still answers a read_only grant`, !refusedReadOnly(a.result))
    }

    // addTimelineEntry returns void: its refusal has no field to inspect, so the
    // assertion is the only observable there is — no write was attempted. This
    // is the function whose unbraced `if` would have made it a no-op for
    // EVERYONE; the tenant case below is what catches that.
    const voidRo = await underSession(READ_ONLY_GRANT, () => after.addTimelineEntry("t1", "x", "y"))
    check("transactions · addTimelineEntry (void) attempts no write under a read_only grant",
      voidRo.calls.length === 0)
    const voidTenant = await underSession(session(), () => after.addTimelineEntry("t1", "x", "y"))
    check("transactions · …and STILL inserts for an ordinary tenant user (not silently disabled)",
      voidTenant.calls.length === 1 && voidTenant.calls[0].channel === "cookie" &&
      voidTenant.calls[0].table === "transaction_timeline")
  }

  // ── 3. COVERAGE, DERIVED — no writer left on a bare cookie client ─────────
  //
  // The runtime proof above samples 8 of the file's writers. This one is the
  // CENSUS, and it is derived rather than pinned (§2): every function that
  // performs a write token must resolve its client from the seam, and the count
  // is printed, not asserted against a literal.
  console.log("\n[3 — census: every writer in the transactions kernel, derived]")
  {
    const src = stripComments(read("lib/application/transactions.ts"))
    const lines = src.split("\n")
    const FN = /^(export\s+)?(async\s+)?function\s+([A-Za-z0-9_$]+)/
    const spans: Array<{ name: string; start: number; end: number }> = []
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(FN)
      if (!m) continue
      let j = i + 1
      while (j < lines.length && !FN.test(lines[j])) j++
      spans.push({ name: m[3], start: i, end: j })
    }
    const WRITE = /\.(insert|update|upsert|delete)\s*\(/
    const writers = spans.filter((s) => WRITE.test(lines.slice(s.start, s.end).join("\n")) && s.name !== "actingWriteContext")
    const ungated = writers.filter((s) => {
      const body = lines.slice(s.start, s.end).join("\n")
      return !/const gate = await actingWriteContext\(\)/.test(body)
        && !/resolveWriteContext(ForTenant)?\(\)/.test(body)
    })
    const cookieLeft = spans.filter((s) => /await createClient\(\)/.test(lines.slice(s.start, s.end).join("\n")))
    const cookieWriters = cookieLeft.filter((s) => WRITE.test(lines.slice(s.start, s.end).join("\n")))
    console.log(`   functions: ${spans.length} | writers: ${writers.length} | still holding a raw createClient(): ${cookieLeft.length} (all readers: ${cookieWriters.length === 0})`)
    check("every writer in the file resolves its client from the act-as seam",
      ungated.length === 0, ungated.map((s) => s.name).join(", "))
    check("no function both WRITES and opens its own cookie client",
      cookieWriters.length === 0, cookieWriters.map((s) => s.name).join(", "))
    check("…and the readers were deliberately left alone (a read_only grant must still SEE)",
      cookieLeft.length > 0)
    // POSITIVE CONTROL — the census finder must recognise the pre-fix shape.
    const headSpans = (() => {
      const h = stripComments(beforeFix("lib/application/transactions.ts")).split("\n")
      const out: string[] = []
      for (let i = 0; i < h.length; i++) {
        const m = h[i].match(FN)
        if (!m) continue
        let j = i + 1
        while (j < h.length && !FN.test(h[j])) j++
        const body = h.slice(i, j).join("\n")
        if (WRITE.test(body) && /await createClient\(\)/.test(body)) out.push(m[3])
      }
      return out
    })()
    console.log(`   control · the same finder over HEAD reports ${headSpans.length} writers on a raw cookie client`)
    check("control · the finder GOES RED on the pre-fix file (it is not a constant zero)",
      headSpans.length > 0)
  }

  // ── 4. THE READ/WRITE SPLIT IS DECLARED, not incidental ───────────────────
  //
  // Stripped AND string-blanked: every file below now EXPLAINS the split in a
  // comment that names both entry points, and a tombstone is not a call site (§2).
  console.log("\n[4 — the split is in the code, not only in the prose]")
  {
    const SPLIT_FILES = [
      "app/actions/voice-tenancy.ts",
      "app/actions/tenant-connections.ts",
      "app/actions/a2p-registration.ts",
      "app/actions/vendors/vendor-plans.ts",
    ]
    for (const f of SPLIT_FILES) {
      // COMMENT-STRIPPED but NOT string-masked, deliberately. The discriminator
      // here IS a pair of quoted literals — `mode: "read" | "write"` is a
      // string-literal TYPE — and blankStrings cannot tell a type annotation from
      // a value, so masking blanks exactly the text being looked for. (Caught by
      // this assertion going red on correct code, which is the right direction
      // for a control to fail in.) Comments are still removed, so the prose that
      // explains the split cannot stand in for the split.
      const code = stripComments(read(f))
      check(`${f.split("/").pop()} — the gate takes a mode and reaches BOTH entry points`,
        /mode: "read" \| "write"/.test(code)
        && /resolveActingContext\(\)/.test(code)
        && /resolveWriteContext\(\)/.test(code))
    }
    check("control · a COMMENT naming both entry points does not satisfy that finder",
      !/resolveActingContext\(\)/.test(
        stripComments("// we call resolveActingContext() for reads and resolveWriteContext() for writes")))
    check("control · …and the finder DOES fire on the real declaration",
      /mode: "read" \| "write"/.test(stripComments('async function g(mode: "read" | "write") {}')))
  }

  for (const f of TEMP_FILES) { try { rmSync(f) } catch {} }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(` BLIND SPOTS: ${Object.keys(STUBS).length} stubbed leaves (listed in STUBS) + per-subject extraStubs;`)
  console.log("   the seam, the gate helpers and the subject files themselves are the real, shipping source.")
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ read_only grants READ again; every transactions writer rides the seam; no seat widened.")
  console.log(" ACT_AS_READ_PATH_PASS")
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
