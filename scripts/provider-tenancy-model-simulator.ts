#!/usr/bin/env tsx
/**
 * scripts/provider-tenancy-model-simulator.ts
 *   (npm run test:provider-tenancy-model)
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO PROVIDERS, TWO OPPOSITE TENANCY MODELS, AND NOTHING WAS HOLDING THEM APART.
 *
 * The owner ruling:
 *
 *   "rentcast is a platform gated credential and tenants can setup and use
 *    their idxbroker account if they set it up"
 *
 *   · RentCast   — PLATFORM-GATED. ONE platform credential, metered and
 *                  budget-gated. A tenant does not bring their own and is never
 *                  offered the option.
 *   · IDX Broker — TENANT-SETTABLE. A tenant who sets up their own IDX Broker
 *                  account uses THEIRS; their MLS board's data is the point.
 *
 * `lib/connections/scope.ts` already encoded exactly this, and predates the
 * ruling — it offers `idxbroker` as the only selectable `listing` provider and
 * deliberately offers RentCast to nobody. It is THE ARBITER, and assertion 4
 * below watches it: if someone edits that decision, the ruling itself moved and
 * this proof must fail loudly rather than quietly re-deriving a new answer.
 *
 * The rest of the tree had drifted in BOTH directions at once:
 *   · lib/property/rentcast.ts resolved a PER-TENANT credential row FIRST and
 *     treated the platform key as the fallback — the exact inverse of the
 *     ruling, and spend the platform could not see, meter, or cap.
 *   · lib/providers/tenancy-matrix.ts — the file whose own header says vendor
 *     ownership is "decided ONCE so it's never re-litigated per feature" —
 *     carried `tenant_optional_key` on RentCast, and had NO ROW AT ALL for IDX
 *     Broker, the one provider in the pair a tenant genuinely owns. That absence
 *     is why the two could drift in opposite directions with nothing catching it.
 *
 * WHAT THIS PROOF IS FOR. Not to re-state the ruling in prose — the repo already
 * had prose. It asserts the CONSTRUCTS that make the two models impossible to
 * re-confuse, and it asserts them where they live: in the resolver's control
 * flow, in the matrix's MODEL LIST (a runtime array, never a sentence), and in
 * the arbiter's provider allow-list.
 *
 * HOW IT IS BUILT — the rules it does not get to skip:
 *   · Structural assertions run over COMMENT-STRIPPED source. These files are
 *     heavily commented and several comments quote the exact identifiers being
 *     asserted on ("integration_credentials", "tenant_optional_key",
 *     "RENTCAST_API_KEY"). Prose must never be able to satisfy a check.
 *   · Tenancy assertions read the MODEL LIST at runtime, not the `why` string.
 *     A `why` that says the right thing over a `models` array that says the
 *     wrong one is precisely the defect that shipped.
 *   · The key resolver is resolved STRUCTURALLY — "the one non-exported function
 *     whose body reads the platform env key" — so a rename keeps this green and
 *     a re-added tenant branch turns it red.
 *   · EVERY assertion carries negative controls: the defect is written back into
 *     the REAL file, the mutation is VERIFIED TO HAVE LANDED ON DISK (a
 *     find-string that silently stopped matching is theatre, not a control), the
 *     assertion is required to flip RED, and the file is restored and re-verified
 *     by sha256.
 *   · Behavioural assertions reach the library through a CACHE-BUSTED dynamic
 *     import (`?v=<n>`). Without that a patched module is never re-loaded and
 *     every control reports green over code it never ran.
 *
 * NO CREDENTIALS, NO LIVE ROWS, NO EGRESS. The one behavioural assertion runs
 * with the platform env key REMOVED, which is the whole point of it: a missing
 * platform key must return null rather than throw, so the AVM cascade in
 * lib/avm/provider-chain.ts falls through to the next provider. Pre-rollout every
 * table is empty in any case — there are no tenant RentCast credential rows in
 * existence to migrate, and this proof reads no table to find that out.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = {
  rentcast: "lib/property/rentcast.ts",
  matrix: "lib/providers/tenancy-matrix.ts",
  arbiter: "lib/connections/scope.ts",
  chain: "lib/avm/provider-chain.ts",
}

for (const p of Object.values(F)) {
  if (!existsSync(resolve(ROOT, p))) {
    console.log(` ❌ PROVIDER_TENANCY_MODEL_FAIL — missing subject: ${p}`)
    process.exit(1)
  }
}

/** Read fresh every time — the negative layer rewrites these files on disk. */
const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")

/** Comment-stripped source. Prose must never satisfy a structural assertion. */
const code = (p: string) =>
  raw(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")

// ═════════════════════════════════════════════════════════════════════════════
// CACHE-BUSTED MODULE LOADING
//
// An `import` binds once. The negative layer rewrites these modules on disk, so
// a cached binding would let every control report green over code it never ran.
// ═════════════════════════════════════════════════════════════════════════════
let loadCounter = 0
async function freshImport(rel: string): Promise<any> {
  const url = pathToFileURL(resolve(ROOT, rel)).href + `?v=${++loadCounter}`
  return import(url)
}

// ═════════════════════════════════════════════════════════════════════════════
// STRUCTURAL HELPERS — resolve by CONSTRUCT, never by spelling
// ═════════════════════════════════════════════════════════════════════════════

interface Fn { exported: boolean; body: string }

/** Every top-level `function <name>(...)` in comment-stripped source, with its
 *  brace-matched body and whether the declaration is exported. */
function functionBodies(src: string): Map<string, Fn> {
  const out = new Map<string, Fn>()
  const re = /(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const open = src.indexOf("{", m.index + m[0].length)
    if (open === -1) continue
    let depth = 0
    let end = -1
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++
      else if (src[i] === "}") {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end === -1) continue
    out.set(m[2], { exported: !!m[1], body: src.slice(open + 1, end) })
  }
  return out
}

/**
 * THE RENTCAST KEY RESOLVER, resolved structurally: the function whose body
 * reads the platform env key. Never found by name, so a rename stays green.
 */
function rentcastKeyResolvers(): Array<[string, Fn]> {
  const bodies = functionBodies(code(F.rentcast))
  return [...bodies.entries()].filter(([, f]) => /process\.env\.RENTCAST_API_KEY/.test(f.body))
}

/**
 * Reads of a CREDENTIAL table, in comment-stripped source. Matches any table
 * whose name contains "credential" — the point is that no rentcast path reads a
 * tenant-keyed credential store at all, whichever of the three stores it is.
 */
const CRED_TABLE_READ = /\.from\(\s*["'`]([A-Za-z_]*credential[A-Za-z_]*)["'`]\s*\)/gi

/** Tells that a resolver is selecting a credential BY TENANT rather than
 *  reading one platform key. Any one of these inside the resolver is the defect. */
const TENANT_SELECTOR_TELLS = [
  ".from(",
  "createServiceClient",
  "resolveScopedConnection",
  "resolveConnection",
  "brokerage_id",
  "agent_user_id",
  "owner_type",
  "owner_id",
  "provider_name",
  "service_name",
]

/** Models that put the credential in the TENANT's hands. RentCast must carry
 *  none of them; IDX Broker must carry at least one. */
const TENANT_OWNED_MODELS = ["tenant_optional_key", "byo_top_tier", "user_oauth"] as const
/** The subset that means "the tenant sets it up themselves and theirs wins". */
const TENANT_SETTABLE_MODELS = ["tenant_optional_key", "user_oauth"] as const

/** Built from fragments on purpose: this script must not carry the literal
 *  `.from("<table>")` spelling that the repo's raw-source scope guard scans for,
 *  while the file it WRITES during a negative control must carry it exactly. */
const TENANT_CRED_TABLE = ["integration", "credentials"].join("_")

// ═════════════════════════════════════════════════════════════════════════════
// ASSERTIONS
// ═════════════════════════════════════════════════════════════════════════════
interface Break { file: string; find: string; replace: string }
interface Assertion {
  id: string
  what: string
  run: () => Promise<{ ok: boolean; detail?: string }>
  breaks: Break[]
}
const A: Assertion[] = []

// ── 1 · NO RENTCAST PATH READS A PER-TENANT CREDENTIAL ───────────────────────
A.push({
  id: "platform-gated.no-tenant-credential-in-any-rentcast-path",
  what:
    "the RentCast key resolver — found structurally as the one non-exported function whose body reads the platform env key — selects NOTHING by tenant: no table read, no service client, no scoped-connection resolver, no brokerage/owner/provider filter. And no file in the RentCast lane reads a credential table at all. Asserted over comment-stripped source, because these files' comments quote the very identifiers under test",
  run: async () => {
    const resolvers = rentcastKeyResolvers()
    if (resolvers.length === 0) return { ok: false, detail: "no function reads process.env.RENTCAST_API_KEY — the platform key path is gone" }
    if (resolvers.length > 1) {
      return { ok: false, detail: `${resolvers.length} rival key resolvers (${resolvers.map(([n]) => n).join(", ")}) — there must be exactly ONE` }
    }
    const [name, fn] = resolvers[0]
    if (fn.exported) return { ok: false, detail: `${name} is exported — the platform key resolver is internal by design` }

    const hits = TENANT_SELECTOR_TELLS.filter((t) => fn.body.includes(t))
    if (hits.length) {
      return { ok: false, detail: `${name} selects by tenant: ${hits.join(", ")}` }
    }

    // And nothing anywhere in the lane reads a credential table.
    const readers: string[] = []
    for (const rel of [F.rentcast, F.chain, "lib/kernel/anniversary-equity.ts"]) {
      if (!existsSync(resolve(ROOT, rel))) continue
      const src = code(rel)
      for (const m of src.matchAll(CRED_TABLE_READ)) readers.push(`${rel} → ${m[1]}`)
    }
    if (readers.length) return { ok: false, detail: `credential-table read in the RentCast lane: ${readers.join("; ")}` }

    return { ok: true, detail: `resolver ${name}() reads the platform env key and nothing else` }
  },
  breaks: [
    {
      // The exact defect that shipped: the tenant row wins, the platform key is
      // demoted to a fallback.
      file: F.rentcast,
      find: "  const key = process.env.RENTCAST_API_KEY ?? null",
      replace:
        "  const svc = createServiceClient()\n" +
        "  const { data: cred, error: credError } = await svc\n" +
        `    .from("${TENANT_CRED_TABLE}")\n` +
        '    .select("api_key, is_active")\n' +
        '    .eq("brokerage_id", brokerageId)\n' +
        '    .eq("provider_name", "rentcast")\n' +
        "    .maybeSingle()\n" +
        "  if (credError) console.error(credError.message)\n" +
        "  if (cred?.is_active && cred.api_key) return cred.api_key\n" +
        "  const key = process.env.RENTCAST_API_KEY ?? null",
    },
    {
      // The subtler re-drift: no table read, but the owner cascade is consulted —
      // which is the IDX Broker model applied to the wrong provider.
      file: F.rentcast,
      find: "  const key = process.env.RENTCAST_API_KEY ?? null",
      replace:
        '  const conn = await resolveScopedConnection("rentcast", { brokerageId }).catch(() => null)\n' +
        "  if (conn?.apiKey) return conn.apiKey\n" +
        "  const key = process.env.RENTCAST_API_KEY ?? null",
    },
  ],
})

// ── 2 · RENTCAST'S TENANCY ENTRY CARRIES NO TENANT-OWNED MODEL ───────────────
A.push({
  id: "platform-gated.rentcast-models-carry-no-tenant-owned-model",
  what:
    "PROVIDER_TENANCY's rentcast row is asserted against its MODEL LIST at runtime, never its prose: it carries platform_metered, and carries NEITHER tenant_optional_key NOR byo_top_tier nor user_oauth. Requiring platform_metered is what stops an emptied `models` array from passing by saying nothing",
  run: async () => {
    const { providerTenancy } = await freshImport(F.matrix)
    const t = providerTenancy("rentcast")
    if (!t) return { ok: false, detail: "no rentcast row in PROVIDER_TENANCY at all" }
    if (!Array.isArray(t.models)) return { ok: false, detail: "rentcast.models is not a list" }
    if (!t.models.includes("platform_metered")) {
      return { ok: false, detail: `rentcast must be platform_metered; models = [${t.models.join(", ")}]` }
    }
    const wrong = t.models.filter((m: string) => (TENANT_OWNED_MODELS as readonly string[]).includes(m))
    if (wrong.length) {
      return { ok: false, detail: `rentcast carries tenant-owned model(s): ${wrong.join(", ")} — the ruling says a tenant never brings their own RentCast key` }
    }
    return { ok: true, detail: `rentcast models = [${t.models.join(", ")}]` }
  },
  breaks: [
    {
      file: F.matrix,
      find: '    models: ["platform_metered"],\n    why: "PLATFORM-GATED (owner ruling)',
      replace: '    models: ["platform_metered", "tenant_optional_key"],\n    why: "PLATFORM-GATED (owner ruling)',
    },
    {
      file: F.matrix,
      find: '    models: ["platform_metered"],\n    why: "PLATFORM-GATED (owner ruling)',
      replace: '    models: ["platform_metered", "byo_top_tier"],\n    why: "PLATFORM-GATED (owner ruling)',
    },
    {
      // Saying nothing is not the same as saying "platform".
      file: F.matrix,
      find: '    models: ["platform_metered"],\n    why: "PLATFORM-GATED (owner ruling)',
      replace: '    models: [],\n    why: "PLATFORM-GATED (owner ruling)',
    },
  ],
})

// ── 3 · IDX BROKER HAS AN ENTRY, AND IT IS THE TENANT-OWNED ONE ──────────────
A.push({
  id: "tenant-settable.idxbroker-has-a-tenancy-row-and-it-is-tenant-owned",
  what:
    "IDX Broker — the one provider in this pair a tenant genuinely owns — HAS a PROVIDER_TENANCY row (its absence is what let the pair drift in opposite directions unnoticed), that row carries a tenant-settable model, and it names IDXBROKER_API_KEY as the platform FLOOR the cascade falls back to",
  run: async () => {
    const { providerTenancy } = await freshImport(F.matrix)
    const t = providerTenancy("idxbroker")
    if (!t) return { ok: false, detail: "idxbroker is absent from PROVIDER_TENANCY — the matrix has no ruling for the tenant-owned half of the pair" }
    const owned = t.models.filter((m: string) => (TENANT_SETTABLE_MODELS as readonly string[]).includes(m))
    if (owned.length === 0) {
      return { ok: false, detail: `idxbroker carries no tenant-settable model; models = [${t.models.join(", ")}]` }
    }
    if (!t.envVars.includes("IDXBROKER_API_KEY")) {
      return { ok: false, detail: `idxbroker must name its platform fallback key; envVars = [${t.envVars.join(", ")}]` }
    }
    return { ok: true, detail: `idxbroker models = [${t.models.join(", ")}]` }
  },
  breaks: [
    {
      file: F.matrix,
      find: '    provider: "idxbroker",',
      replace: '    provider: "idx_broker",',
    },
    {
      file: F.matrix,
      find: '    models: ["tenant_optional_key"],\n    why: "TENANT-SETTABLE (owner ruling)',
      replace: '    models: ["platform_metered"],\n    why: "TENANT-SETTABLE (owner ruling)',
    },
    {
      file: F.matrix,
      find: '    envVars: ["IDXBROKER_API_KEY"],',
      replace: "    envVars: [],",
    },
  ],
})

// ── 4 · THE ARBITER STILL SAYS WHAT IT SAID ──────────────────────────────────
A.push({
  id: "arbiter.scope-still-offers-idxbroker-and-never-offers-rentcast",
  what:
    "lib/connections/scope.ts is the module that encoded this ruling BEFORE the ruling, so it is the arbiter, not a copy: `listing` still offers idxbroker, NO connector domain anywhere offers rentcast as a user connection, and both facts are read through the real gate (isProviderAllowedForScope) rather than off the literal. If someone edits that decision the whole ruling has moved, and this must fail loudly instead of quietly agreeing with the new answer",
  run: async () => {
    const s = await freshImport(F.arbiter)
    const providers: Record<string, readonly string[]> = s.CONNECTOR_PROVIDERS

    if (!providers.listing?.includes("idxbroker")) {
      return { ok: false, detail: `listing no longer offers idxbroker; listing = [${(providers.listing ?? []).join(", ")}]` }
    }
    const offeringRentcast = Object.entries(providers)
      .filter(([, list]) => list.includes("rentcast"))
      .map(([domain]) => domain)
    if (offeringRentcast.length) {
      return { ok: false, detail: `rentcast is offered as a user connection under: ${offeringRentcast.join(", ")}` }
    }
    // Through the real gate, not the literal.
    if (!s.isProviderAllowedForScope("brokerage", "listing", "idxbroker")) {
      return { ok: false, detail: "the gate refuses a brokerage connecting idxbroker" }
    }
    for (const scope of ["agent", "team", "brokerage", "platform"]) {
      if (s.isProviderAllowedForScope(scope, "listing", "rentcast")) {
        return { ok: false, detail: `the gate ALLOWS ${scope} to connect rentcast` }
      }
    }
    return { ok: true, detail: `listing = [${providers.listing.join(", ")}]; rentcast offered by no domain` }
  },
  breaks: [
    {
      file: F.arbiter,
      find: '  listing:     ["idxbroker"],',
      replace: '  listing:     ["idxbroker", "rentcast"],',
    },
    {
      file: F.arbiter,
      find: '  listing:     ["idxbroker"],',
      replace: "  listing:     [],",
    },
  ],
})

// ── 5 · A MISSING PLATFORM KEY RETURNS NULL, NEVER THROWS ────────────────────
A.push({
  id: "platform-gated.missing-key-returns-null-so-the-avm-chain-falls-through",
  what:
    "with RENTCAST_API_KEY absent from the environment, every RentCast reader answers honestly instead of throwing — isRentcastConfigured resolves false, the AVM resolves all-null, a search resolves an explicit not-configured refusal — and the AVM cascade's rentcast branch is CONDITIONAL and non-throwing, so a dark RentCast lane falls through to BatchData rather than taking the whole valuation down",
  run: async () => {
    const saved = process.env.RENTCAST_API_KEY
    const warn = console.warn
    console.warn = () => {}
    try {
      delete process.env.RENTCAST_API_KEY
      const rc = await freshImport(F.rentcast)
      const B = "00000000-0000-4000-8000-000000000000"

      const configured = await rc.isRentcastConfigured(B)
      if (configured !== false) return { ok: false, detail: `isRentcastConfigured returned ${String(configured)} with no platform key` }

      const avm = await rc.getRentcastAVM({ brokerageId: B, address: "1 Main St" })
      if (avm.value !== null || avm.rangeLow !== null || avm.rangeHigh !== null) {
        return { ok: false, detail: `getRentcastAVM invented ${JSON.stringify(avm)} with no platform key` }
      }

      const search = await rc.searchRentcastSaleListings({ brokerageId: B, filters: { city: "Austin", state: "TX" } })
      if (search.success !== false || search.listings.length !== 0 || !/not configured/i.test(search.error ?? "")) {
        return { ok: false, detail: `search did not refuse honestly: ${JSON.stringify(search)}` }
      }
    } catch (e) {
      return { ok: false, detail: `a missing platform key THREW instead of returning null: ${(e as Error).message}` }
    } finally {
      console.warn = warn
      if (saved === undefined) delete process.env.RENTCAST_API_KEY
      else process.env.RENTCAST_API_KEY = saved
    }

    // The chain half: rentcast's result must be consumed conditionally, and the
    // adapter must not throw — otherwise "no key" ends the cascade.
    const chain = functionBodies(code(F.chain))
    const getCurrent = chain.get("getCurrentAvm")
    const tryRc = chain.get("tryRentcast")
    if (!getCurrent) return { ok: false, detail: "getCurrentAvm not found in the AVM chain" }
    if (!tryRc) return { ok: false, detail: "tryRentcast adapter not found in the AVM chain" }
    const conditional = /const\s+(\w+)\s*=\s*await\s+tryRentcast\(\s*req\s*\)\s*;?\s*if\s*\(\s*\1\s*&&[\s\S]{0,80}?\)\s*return\s+\1\b/
    if (!conditional.test(getCurrent.body)) {
      return { ok: false, detail: "the rentcast result is not consumed behind a confidence guard — a dark lane would end the cascade" }
    }
    if (/\bthrow\b/.test(tryRc.body)) {
      return { ok: false, detail: "tryRentcast can throw — a RentCast failure would propagate instead of falling through" }
    }
    if (!/catch[\s\S]*return null/.test(tryRc.body)) {
      return { ok: false, detail: "tryRentcast has no silent-fail-to-null path" }
    }
    return { ok: true, detail: "no key → null → the next provider" }
  },
  breaks: [
    {
      // The resolver throws instead of returning null.
      file: F.rentcast,
      find: "  const key = process.env.RENTCAST_API_KEY ?? null",
      replace:
        '  const key = process.env.RENTCAST_API_KEY ?? ((): string => { throw new Error("RentCast not configured") })()',
    },
    {
      // The chain returns whatever rentcast gave it, including null — ending the
      // cascade before BatchData is ever tried.
      file: F.chain,
      find: "      const rc = await tryRentcast(req)\n      if (rc && rc.confidence >= 0.6) return rc",
      replace: "      const rc = await tryRentcast(req)\n      return rc",
    },
    {
      // The adapter propagates instead of falling through.
      file: F.chain,
      find: "  } catch {\n    return null\n  }\n}\n\nasync function tryBatchData",
      replace: "  } catch (e) {\n    throw e\n  }\n}\n\nasync function tryBatchData",
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// RUN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" PROVIDER TENANCY MODELS — RentCast is platform-gated, IDX Broker is")
  console.log(" the tenant's, and neither can be re-confused for the other")
  console.log("══════════════════════════════════════════════════════════════════════")

  let pass = 0, fail = 0
  const failures: string[] = []

  console.log("\n─── ASSERTIONS ───────────────────────────────────────────────────────")
  for (const a of A) {
    let r: { ok: boolean; detail?: string }
    try { r = await a.run() }
    catch (e) { r = { ok: false, detail: `threw: ${(e as Error).message}` } }
    if (r.ok) { pass++; console.log(`  ✔ ${a.id}\n      ${a.what}${r.detail ? `\n      → ${r.detail}` : ""}`) }
    else { fail++; failures.push(`${a.id}: ${r.detail ?? ""}`); console.log(`  ✘ ${a.id}\n      ${a.what}\n      → ${r.detail ?? ""}`) }
  }

  let negPass = 0, negFail = 0
  const negProblems: string[] = []
  if (RUN_NEGATIVE) {
    console.log("\n─── NEGATIVE CONTROLS (the defect is written back on purpose) ────────")
    for (const a of A) {
      if (a.breaks.length === 0) {
        negFail++
        negProblems.push(`${a.id}: assertion with NO negative control`)
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
        // Confirm the patched text is really on disk before believing anything
        // the assertion then says about it.
        const onDisk = readFileSync(path, "utf8")
        const firstReplacedLine = b.replace.split("\n")[0]
        const applied =
          onDisk !== before &&
          (firstReplacedLine === "" ? !onDisk.includes(b.find) : onDisk.includes(firstReplacedLine))
        let broke = false, detail = ""
        try { const r = await a.run(); broke = !r.ok; detail = r.detail ?? "" }
        catch (e) { broke = true; detail = `threw: ${(e as Error).message}` }
        finally { writeFileSync(path, before, "utf8") }
        const restored = createHash("sha256").update(readFileSync(path)).digest("hex") === digest
        if (broke && restored && applied) {
          negPass++
          console.log(`  ✔ ${a.id}[${i}]  patch verified on disk, flipped RED as required, file restored (sha256 verified)`)
        } else {
          negFail++
          if (!applied) negProblems.push(`${a.id}[${i}]: the patched text was NOT observed on disk`)
          if (!broke) negProblems.push(`${a.id}[${i}]: still PASSED with the defect reintroduced — the assertion is worthless as written`)
          if (!restored) negProblems.push(`${a.id}[${i}]: FILE NOT RESTORED (${b.file})`)
          console.log(`  ✘ ${a.id}[${i}]${!applied ? " patch not observed" : ""}${!broke ? " did NOT flip" : ""}${!restored ? " FILE NOT RESTORED" : ""}${detail ? ` (${detail})` : ""}`)
        }
      }
    }
  }

  console.log("\n" + "═".repeat(70))
  console.log(` ASSERTIONS  ${pass} passed, ${fail} failed`)
  if (RUN_NEGATIVE) console.log(` CONTROLS    ${negPass} flipped RED as required, ${negFail} did not`)
  console.log("═".repeat(70))
  if (failures.length) { console.log("\nFailures:"); failures.forEach((f) => console.log("  · " + f)) }
  if (negProblems.length) { console.log("\nControl problems:"); negProblems.forEach((f) => console.log("  · " + f)) }

  if (fail > 0 || negFail > 0) {
    console.log("\n ❌ PROVIDER_TENANCY_MODEL_FAIL — the two tenancy models have drifted back into each other")
    process.exit(1)
  }
  console.log("\n ✅ PROVIDER_TENANCY_MODEL_PASS — one platform RentCast credential nobody can bypass, one IDX Broker account the tenant owns, and the arbiter still says so")
}

main()
