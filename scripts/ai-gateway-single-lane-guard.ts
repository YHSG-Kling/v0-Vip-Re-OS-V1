#!/usr/bin/env tsx
/**
 * scripts/ai-gateway-single-lane-guard.ts
 *   (tsx scripts/ai-gateway-single-lane-guard.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE LANE TO THE MODELS.
 *
 * The owner ruling is four words:
 *
 *     "ai goes through vercel ai gateway"
 *
 * This guard stands over the CONSTRUCT that ruling describes, not over any
 * spelling of it. The construct is:
 *
 *     A model — text, object, image, or transcription — is reached ONLY by
 *     handing a canonical `provider/model` string to the Vercel AI Gateway,
 *     authenticated with AI_GATEWAY_API_KEY, with `lib/ai/resolve-model.ts`
 *     as the single place a name becomes that string.
 *
 * WHY IT NEEDS A GUARD AT ALL. The tree already satisfied the ruling almost
 * everywhere, and the two places it did not were both invisible to a grep for
 * import lines:
 *
 *   · `lib/ai/models.ts:executeModelCall` special-cased Perplexity into a
 *     `createOpenAI({ baseURL: "https://api.perplexity.ai" })` client on
 *     PERPLEXITY_API_KEY — a DYNAMIC import, and one that disagreed with
 *     `generateTextRouted` / `generateObjectRouted` in the same file, which had
 *     always sent the same two models through the gateway.
 *   · `app/actions/workflows.ts:generateScriptContent` did
 *     `await import("@ai-sdk/anthropic")` and called `anthropic(...)` directly,
 *     skipping the routing table, the fair-use pre-flight, the Data Guard
 *     redaction and the ai_tool_usage cost ledger.
 *
 * Both were dynamic imports inside function bodies. A guard that reads only the
 * top-of-file import block is a guard that would have missed both — so every
 * scan here blanks COMMENT CONTENT (a claim in prose can never satisfy an
 * assertion) and then looks at every `from "…"`, `import("…")` and
 * `require("…")` in the file, wherever it sits.
 *
 * ── WHAT IS ASSERTED ─────────────────────────────────────────────────────────
 *
 *   A1  NO PRODUCTION FILE IMPORTS A DIRECT PROVIDER SDK. Static or dynamic,
 *       top-level or inside a function body.
 *   A2  AND NONE IS STILL A DEPENDENCY. A package with no importer is how the
 *       next importer gets written — `npm i` is not required to reintroduce a
 *       lane that is already installed.
 *   A3  NO PRODUCTION FILE READS A PROVIDER API KEY TO REACH A MODEL, except
 *       the carve-outs NAMED in PROVIDER_KEY_CARVE_OUTS below, each with its
 *       file, its key and the reason the gateway cannot carry it.
 *   A4  ONE RESOLVER. `resolveModel` is exported from exactly one production
 *       module, and the alias table lives in that same module.
 *   A5  THE RESOLVER ACTUALLY RESOLVES — EXECUTED, not asserted. The real
 *       function is imported and run over every alias, every bare id and every
 *       MODEL_CONFIG pair; every answer must be a canonical `provider/model`.
 *   A5b EVERY PROVIDER IN MODEL_CONFIG IS ONE THE INSTALLED GATEWAY CARRIES,
 *       checked against the `GatewayModelId` union in the installed
 *       @ai-sdk/gateway typings. This is the evidence the Perplexity collapse
 *       rests on: `perplexity/…` is a gateway model id, so the second client
 *       bought nothing.
 *   A6  lib/ai/models.ts BUILDS EVERY MODEL INSTANCE THROUGH toGatewayModel.
 *       Named per-function, because the defect that existed was ONE branch of
 *       ONE function disagreeing with the other two.
 *   A7  EVERY GATEWAY FACTORY CALL GETS A CANONICAL STRING, and the two wrapper
 *       helpers check AI_GATEWAY_API_KEY before constructing anything.
 *   A8  TRANSCRIPTION IS ON THE LANE TOO. `lib/repurpose/transcribe-core.ts`
 *       dispatches audio at ai-gateway.vercel.sh on AI_GATEWAY_API_KEY, not at
 *       api.openai.com on OPENAI_API_KEY.
 *
 * Every assertion carries at least one NEGATIVE CONTROL that writes the real
 * defect into the real file, requires the assertion to go RED, restores the
 * file and verifies the restore by sha256. A control whose find-string no
 * longer matches is a FAILURE, not a pass — it proves nothing about the code it
 * meant to break. Three SPECIFICITY controls must stay GREEN.
 *
 * Run with --no-negative to skip the controls (assertions only).
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { resolve, join, relative } from "node:path"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { blankComments } from "./strip-comments"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const RESOLVER = "lib/ai/resolve-model.ts"
const MODELS = "lib/ai/models.ts"
const GENERATE = "lib/ai/generate.ts"
const TRANSCRIBE = "lib/repurpose/transcribe-core.ts"
const LICENSE = "lib/onboarding/license-verifier.ts"
const PKG = "package.json"

/** Directories that ship. `scripts/` is deliberately absent: guards carry
 *  defective constructs as STRING FIXTURES — this very file names every provider
 *  specifier below — and a fixture is not a call site (see S3). */
const PRODUCTION_DIRS = ["app", "lib", "services", "hooks", "contexts", "remotion", "workflows", "constants", "types"]

/** Package names that ARE a second lane to a model. Matched as the whole
 *  specifier or as its package root (`@ai-sdk/openai/internal` counts). */
const PROVIDER_SDKS = [
  "@ai-sdk/anthropic",
  "@ai-sdk/openai",
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/mistral",
  "@ai-sdk/cohere",
  "@ai-sdk/xai",
  "@ai-sdk/perplexity",
  "@ai-sdk/deepseek",
  "@ai-sdk/groq",
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/azure",
  "@ai-sdk/togetherai",
  "@ai-sdk/fireworks",
  "@anthropic-ai/sdk",
  "@anthropic-ai/bedrock-sdk",
  "@anthropic-ai/vertex-sdk",
  "@google/genai",
  "@google/generative-ai",
  "@google-cloud/vertexai",
  "@mistralai/mistralai",
  "@azure/openai",
  "openai",
  "cohere-ai",
  "groq-sdk",
  "replicate",
  "together-ai",
]

/** Env vars that are a provider's own model credential. AI_GATEWAY_API_KEY is
 *  deliberately NOT here — it is the lane. */
const PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_AI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "PERPLEXITY_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "COHERE_API_KEY",
  "DEEPSEEK_API_KEY",
  "AZURE_OPENAI_API_KEY",
]

/**
 * THE CARVE-OUTS, NAMED. A file may read a provider key ONLY if it appears here
 * with the capability the Vercel AI Gateway does not carry. "It was already like
 * that" is not a reason; each entry states what the gateway cannot do.
 *
 * There is no transcription entry. There used to be: the Whisper fallback in
 * lib/repurpose/transcribe-core.ts held `@ai-sdk/openai` and OPENAI_API_KEY
 * because @ai-sdk/gateway@3.x has no transcriptionModel factory. The gateway
 * platform DOES proxy speech-to-text, at `POST /v4/ai/transcription-model`, and
 * that REST surface needs no SDK upgrade — so the carve-out was closed rather
 * than documented, and A8 now stands over the result.
 */
const PROVIDER_KEY_CARVE_OUTS: Array<{ file: string; keys: string[]; why: string }> = [
  {
    file: "lib/agents/managed-agents-egress.ts",
    keys: ["ANTHROPIC_API_KEY"],
    why:
      "Anthropic's MANAGED AGENTS API (/v1/agents, /v1/sessions) — persistent, versioned agent " +
      "and session resources, not model inference. The Vercel AI Gateway proxies inference " +
      "(chat/completions, responses, images, embeddings, transcription); it exposes no agent or " +
      "session resource surface at all, so there is nothing to route this through. Still goes out " +
      "via callConnector, so the single-egress + healer observability invariants hold.",
  },
  {
    file: "lib/agents/spawn-helper.ts",
    keys: ["ANTHROPIC_API_KEY"],
    why:
      "Presence check that short-circuits the managed-agent spawn above into a graceful no-op. " +
      "Gates the same non-inference surface; makes no model call of its own.",
  },
  {
    file: "app/api/webhooks/anthropic-agent/route.ts",
    keys: ["ANTHROPIC_API_KEY"],
    why:
      "The callback half of the same Managed Agents surface — reads session events back from " +
      "api.anthropic.com. Same capability gap, same non-inference resource.",
  },
  {
    file: "lib/ai/image-generation.ts",
    keys: ["OPENAI_API_KEY"],
    why:
      "DALL·E 3 fallback that fires ONLY after the gateway image path " +
      "(ai-gateway.vercel.sh /v1/images/generations, openai/gpt-image-1) has been tried and " +
      "returned nothing. The gateway is the primary; this is a second image vendor path, not a " +
      "second text lane. Left in place deliberately: deleting a working image fallback is not " +
      "something the text-lane ruling asks for.",
  },
  {
    file: "lib/listings/photo-intelligence.ts",
    keys: ["OPENAI_API_KEY"],
    why:
      "gpt-image-1 /v1/images/edits (virtual staging) fallback, attempted only after the same " +
      "endpoint on ai-gateway.vercel.sh. Gateway-first, identical shape to image-generation.ts.",
  },
]

// ═════════════════════════════════════════════════════════════════════════════
// HARNESS
// ═════════════════════════════════════════════════════════════════════════════

const failures: string[] = []
let assertionsRun = 0
let controlsRun = 0

function check(label: string, ok: boolean, detail = ""): boolean {
  assertionsRun += 1
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`)
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`)
  return ok
}

const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
const sha = (p: string) => createHash("sha256").update(raw(p)).digest("hex")

// blankComments() now comes from scripts/strip-comments.ts — see the import above.
// hand-rolled scanner replaced (finding #250): it could not see nested `${…}` templates, regex literals, or an apostrophe in JSX text, and went blind on the code it judges.

/** Index just past the balanced closer for the bracket at `open`. */
function skipBalanced(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" }
  const close = pairs[src[open]]
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") {
      const q = c
      i++
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue }
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    if (c === src[open]) depth++
    else if (c === close) { depth--; if (depth === 0) return i }
    i++
  }
  return src.length
}

/**
 * Brace-balanced body of the named function, comments already blanked.
 *
 * The `{` that opens the BODY is not simply the first `{` after the parameter
 * list: `): Promise<{ text: string }> {` puts an object literal inside the
 * return-type annotation first. Angle-bracket depth separates them — the body
 * brace is the first one at generic depth 0.
 */
function functionBody(src: string, name: string): string {
  const re = new RegExp(`function\\s+${name}\\b`)
  const m = re.exec(src)
  if (!m) return ""
  // The parameter list opens at the first `(` after any generic parameters.
  let p = m.index + m[0].length
  let angle = 0
  while (p < src.length) {
    const c = src[p]
    if (c === "<") angle++
    else if (c === ">") angle--
    else if (c === "(" && angle === 0) break
    p++
  }
  if (p >= src.length) return ""
  let i = skipBalanced(src, p) + 1
  angle = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "<") angle++
    else if (c === ">") angle--
    else if (c === "{" && angle === 0) break
    else if (c === "{") { i = skipBalanced(src, i) } // an object inside a generic
    i++
  }
  if (i >= src.length) return ""
  return src.slice(i, skipBalanced(src, i) + 1)
}

/** The object literal assigned to a `const NAME[: Type] = { … }`, comments blanked.
 *  Anchored on the `=`, because the TYPE may itself contain braces
 *  (`Record<AIModel, { provider: string }> = {`) and the first `{` would be that one. */
function assignedObjectLiteral(src: string, declaration: string): string {
  const i = src.indexOf(declaration)
  if (i === -1) return ""
  const eq = src.indexOf("=", i)
  if (eq === -1) return ""
  const open = src.indexOf("{", eq)
  if (open === -1) return ""
  return src.slice(open, skipBalanced(src, open) + 1)
}

function walk(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx|mts|cts)$/.test(e)) out.push(relative(ROOT, p))
  }
  return out
}

let PRODUCTION_FILES: string[] | null = null
function productionFiles(): string[] {
  if (!PRODUCTION_FILES) {
    PRODUCTION_FILES = PRODUCTION_DIRS.flatMap((d) => walk(join(ROOT, d))).sort()
  }
  return PRODUCTION_FILES
}

/** Every bare module specifier this file imports — `from "x"`, `import("x")`,
 *  `require("x")` — wherever it appears, comments blanked. */
function importedSpecifiers(src: string): string[] {
  const body = blankComments(src)
  const specs: string[] = []
  const patterns = [
    /\bfrom\s*(["'])([^"']+)\1/g,
    /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g,
    /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g,
    /^\s*import\s+(["'])([^"']+)\1/gm,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(body))) specs.push(m[2])
  }
  return specs
}

function isProviderSdk(spec: string): string | null {
  for (const p of PROVIDER_SDKS) {
    if (spec === p || spec.startsWith(`${p}/`)) return p
  }
  return null
}

// ═════════════════════════════════════════════════════════════════════════════
// A1 — no production file imports a direct provider SDK
// ═════════════════════════════════════════════════════════════════════════════

function assertNoProviderSdkImports(): boolean {
  const hits: string[] = []
  for (const f of productionFiles()) {
    for (const spec of importedSpecifiers(raw(f))) {
      const pkg = isProviderSdk(spec)
      if (pkg) hits.push(`${f} → ${spec}`)
    }
  }
  return check(
    "A1 no production file imports a direct provider SDK (static or dynamic)",
    hits.length === 0,
    hits.join("; "),
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// A2 — and none is still an installed dependency
// ═════════════════════════════════════════════════════════════════════════════

function assertNoProviderSdkDependencies(): boolean {
  const pkg = JSON.parse(raw(PKG)) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const declared = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]
  const hits = declared.filter((d) => PROVIDER_SDKS.includes(d))
  return check(
    "A2 no direct provider SDK remains in package.json dependencies",
    hits.length === 0,
    hits.join(", "),
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// A3 — no production file reads a provider API key, outside the NAMED carve-outs
// ═════════════════════════════════════════════════════════════════════════════

function assertNoProviderKeyReads(): boolean {
  const carveOut = new Map(PROVIDER_KEY_CARVE_OUTS.map((c) => [c.file, new Set(c.keys)]))
  const hits: string[] = []
  const re = new RegExp(`process\\.env\\.(${PROVIDER_KEYS.join("|")})\\b`, "g")
  for (const f of productionFiles()) {
    const body = blankComments(raw(f))
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(body))) {
      const allowed = carveOut.get(f)
      if (allowed?.has(m[1])) continue
      hits.push(`${f} → process.env.${m[1]}`)
    }
  }
  return check(
    "A3 no production file reads a provider API key to reach a model (outside the named carve-outs)",
    hits.length === 0,
    hits.join("; "),
  )
}

/** A carve-out that no longer describes reality is a stale exemption, and a stale
 *  exemption is a hole. Every named file must still exist and still read its key. */
function assertCarveOutsAreLive(): boolean {
  const stale: string[] = []
  for (const c of PROVIDER_KEY_CARVE_OUTS) {
    let body: string
    try { body = blankComments(raw(c.file)) } catch { stale.push(`${c.file} (missing)`); continue }
    for (const k of c.keys) {
      if (!body.includes(`process.env.${k}`)) stale.push(`${c.file} no longer reads ${k}`)
    }
  }
  return check(
    "A3b every named carve-out is still live (a stale exemption is a hole)",
    stale.length === 0,
    stale.join("; "),
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// A4 — one resolver
// ═════════════════════════════════════════════════════════════════════════════

function assertOneResolver(): boolean {
  const definers = productionFiles().filter((f) =>
    /export\s+function\s+resolveModel\b/.test(blankComments(raw(f))),
  )
  const okOne = definers.length === 1 && definers[0] === RESOLVER
  const aliasTableHere = /const\s+ALIASES\s*:\s*Record<string,\s*string>/.test(blankComments(raw(RESOLVER)))
  return check(
    "A4 resolveModel is exported from exactly one production module, and the alias table lives there",
    okOne && aliasTableHere,
    `definers: ${definers.join(", ") || "(none)"}; alias table in ${RESOLVER}: ${aliasTableHere}`,
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// A5 — the resolver, EXECUTED
// ═════════════════════════════════════════════════════════════════════════════

let loadSeq = 0
async function freshImport<T = any>(file: string): Promise<T> {
  loadSeq += 1
  return (await import(`${pathToFileURL(resolve(ROOT, file)).href}?agl=${loadSeq}`)) as T
}

/** `provider/model` — exactly one slash, both halves non-empty. */
function isCanonical(s: unknown): boolean {
  return typeof s === "string" && /^[a-z0-9._-]+\/[^/\s]+$/i.test(s)
}

/** The alias keys the resolver's own table declares, read from source. */
function aliasKeys(): string[] {
  const table = assignedObjectLiteral(blankComments(raw(RESOLVER)), "const ALIASES")
  return [...table.matchAll(/["']([^"']+)["']\s*:/g)].map((m) => m[1])
}

/** MODEL_CONFIG's provider/modelId pairs, read from lib/ai/models.ts source
 *  (the module itself is server-only and cannot be imported here). */
function modelConfigPairs(): Array<{ provider: string; modelId: string }> {
  const table = assignedObjectLiteral(blankComments(raw(MODELS)), "const MODEL_CONFIG")
  return [...table.matchAll(/provider:\s*["']([^"']+)["']\s*,\s*modelId:\s*["']([^"']+)["']/g)].map((m) => ({
    provider: m[1],
    modelId: m[2],
  }))
}

async function assertResolverProducesCanonicalStrings(): Promise<boolean> {
  const { resolveModel } = await freshImport<{ resolveModel: (m: any) => any }>(RESOLVER)
  const bad: string[] = []

  // Every alias the table declares must resolve to a canonical gateway string.
  for (const a of aliasKeys()) {
    const r = resolveModel(a)
    if (!isCanonical(r)) bad.push(`alias "${a}" → ${JSON.stringify(r)}`)
  }
  // Bare ids must acquire a provider prefix, never reach the SDK naked.
  for (const bare of ["gpt-4o", "gpt-4o-mini", "claude-sonnet", "claude-haiku", "some-claude-variant"]) {
    const r = resolveModel(bare)
    if (!isCanonical(r)) bad.push(`bare "${bare}" → ${JSON.stringify(r)}`)
  }
  // Already-canonical strings pass through unchanged (double resolution is safe).
  for (const c of ["openai/gpt-4o", "anthropic/claude-opus-4-5", "perplexity/sonar-pro"]) {
    const r = resolveModel(c)
    if (r !== c) bad.push(`canonical "${c}" mutated → ${JSON.stringify(r)}`)
  }
  // Every routed model in MODEL_CONFIG survives the round trip.
  for (const { provider, modelId } of modelConfigPairs()) {
    const r = resolveModel(`${provider}/${modelId}`)
    if (!isCanonical(r)) bad.push(`MODEL_CONFIG "${provider}/${modelId}" → ${JSON.stringify(r)}`)
  }
  // A provider instance (non-string) passes through untouched.
  const instance = { __model: true }
  if (resolveModel(instance as any) !== instance) bad.push("a resolved provider instance was not passed through")

  return check(
    "A5 the REAL resolveModel returns a canonical provider/model string for every alias, bare id and MODEL_CONFIG pair",
    bad.length === 0,
    bad.join("; "),
  )
}

/** The providers the INSTALLED @ai-sdk/gateway advertises, harvested from the
 *  GatewayModelId union in its shipped typings. */
function gatewayProviderPrefixes(): Set<string> {
  const dts = readFileSync(
    resolve(ROOT, "node_modules/@ai-sdk/gateway/dist/index.d.ts"),
    "utf8",
  )
  const m = /type GatewayModelId\s*=([\s\S]*?);/.exec(dts)
  const out = new Set<string>()
  if (!m) return out
  for (const lit of m[1].matchAll(/'([^']+\/[^']+)'/g)) out.add(lit[1].split("/")[0])
  return out
}

function assertModelConfigProvidersAreOnTheGateway(): boolean {
  const carried = gatewayProviderPrefixes()
  const pairs = modelConfigPairs()
  const missing = [...new Set(pairs.map((p) => p.provider))].filter((p) => !carried.has(p))
  return check(
    "A5b every provider in MODEL_CONFIG is one the INSTALLED @ai-sdk/gateway advertises",
    pairs.length > 0 && carried.size > 0 && missing.length === 0,
    `pairs: ${pairs.length}, gateway providers: ${carried.size}, not carried: ${missing.join(", ") || "(none)"}`,
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// A6 — lib/ai/models.ts builds every model instance through toGatewayModel
// ═════════════════════════════════════════════════════════════════════════════

/** Constructs that mint a model instance WITHOUT the gateway. */
const DIRECT_MODEL_FACTORIES = [
  "createOpenAI(",
  "createAnthropic(",
  "createGoogleGenerativeAI(",
  "createVertex(",
  "createMistral(",
  "createXai(",
  "createPerplexity(",
  "new OpenAI(",
  "new Anthropic(",
  "new GoogleGenerativeAI(",
  "new GoogleGenAI(",
]

function assertModelsFileIsGatewayOnly(): boolean {
  const src = blankComments(raw(MODELS))
  const direct = DIRECT_MODEL_FACTORIES.filter((c) => src.includes(c))
  // Named per-function: the defect that existed was ONE branch of ONE of these
  // three disagreeing with the other two.
  const perFn = ["executeModelCall", "generateTextRouted", "generateObjectRouted"].map((fn) => ({
    fn,
    body: functionBody(src, fn),
  }))
  const missing = perFn.filter((f) => !f.body || !f.body.includes("toGatewayModel(")).map((f) => f.fn)
  return check(
    "A6 lib/ai/models.ts mints every model instance through toGatewayModel — no direct provider factory in any branch",
    direct.length === 0 && missing.length === 0,
    [
      direct.length ? `direct factories: ${direct.join(", ")}` : "",
      missing.length ? `not routed through toGatewayModel: ${missing.join(", ")}` : "",
    ].filter(Boolean).join("; "),
  )
}

/** Nothing anywhere in production may mint a model instance directly. */
function assertNoDirectModelFactoryAnywhere(): boolean {
  const hits: string[] = []
  for (const f of productionFiles()) {
    const body = blankComments(raw(f))
    for (const c of DIRECT_MODEL_FACTORIES) if (body.includes(c)) hits.push(`${f} → ${c}`)
  }
  return check(
    "A6b no production file anywhere constructs a provider model client directly",
    hits.length === 0,
    hits.join("; "),
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// A7 — gateway factory calls get canonical strings; the wrappers check the key
// ═════════════════════════════════════════════════════════════════════════════

function gatewayImporters(): string[] {
  return productionFiles().filter((f) =>
    importedSpecifiers(raw(f)).some((s) => s === "@ai-sdk/gateway" || s.startsWith("@ai-sdk/gateway/")),
  )
}

function assertGatewayCallsAreCanonical(): boolean {
  const bad: string[] = []
  let literals = 0
  for (const f of gatewayImporters()) {
    const body = blankComments(raw(f))
    // `gateway("…")` / `createGateway({…})("…")` — a STRING literal handed to the
    // gateway factory. A resolveModel(...) argument is an expression, not a
    // literal, and is checked by A5 instead.
    for (const m of body.matchAll(/(?<![A-Za-z0-9_$.])(?:create)?[Gg]ateway\s*(?:\([^()]*\)\s*)?\(\s*(["'])([^"']+)\1/g)) {
      literals += 1
      if (!isCanonical(m[2])) bad.push(`${f} → gateway("${m[2]}") is not provider/model`)
    }
  }
  return check(
    "A7 every string literal handed to the gateway factory is a canonical provider/model id",
    bad.length === 0,
    `${literals} literal(s) checked across ${gatewayImporters().length} gateway importer(s)${bad.length ? `; ${bad.join("; ")}` : ""}`,
  )
}

function assertGatewayWrappersCheckTheKey(): boolean {
  const bad: string[] = []
  for (const [file, fn] of [[MODELS, "toGatewayModel"], [GENERATE, "resolveGatewayModel"]] as const) {
    const body = functionBody(blankComments(raw(file)), fn)
    if (!body) { bad.push(`${file}:${fn} not found`); continue }
    if (!body.includes("process.env.AI_GATEWAY_API_KEY")) bad.push(`${file}:${fn} does not read AI_GATEWAY_API_KEY`)
    if (!/throw\s+new\s+Error/.test(body)) bad.push(`${file}:${fn} does not refuse when the key is missing`)
  }
  return check(
    "A7b both gateway wrappers read AI_GATEWAY_API_KEY and REFUSE when it is missing",
    bad.length === 0,
    bad.join("; "),
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// A8 — transcription rides the same lane
// ═════════════════════════════════════════════════════════════════════════════

function assertTranscriptionIsOnTheGateway(): boolean {
  const src = blankComments(raw(TRANSCRIBE))
  const onGateway = src.includes("ai-gateway.vercel.sh") && src.includes("/v4/ai/transcription-model")
  const usesGatewayKey = src.includes("process.env.AI_GATEWAY_API_KEY")
  const noOpenAiHost = !src.includes("api.openai.com")
  const noOpenAiKey = !src.includes("process.env.OPENAI_API_KEY")
  return check(
    "A8 the transcription primitive dispatches audio through the AI Gateway on AI_GATEWAY_API_KEY, not at api.openai.com",
    onGateway && usesGatewayKey && noOpenAiHost && noOpenAiKey,
    `gateway-endpoint:${onGateway} gateway-key:${usesGatewayKey} no-openai-host:${noOpenAiHost} no-openai-key:${noOpenAiKey}`,
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// CONTROLS
// ═════════════════════════════════════════════════════════════════════════════

interface Control { file: string; find: string; replace: string }

/** Apply a patch, VERIFY IT CHANGED THE FILE, run `fn`, require RED, restore,
 *  verify the restore by sha256. A control whose find-string no longer matches is
 *  a FAILURE — it proves nothing about the code it meant to break. */
async function controlled(label: string, c: Control, fn: () => boolean | Promise<boolean>): Promise<void> {
  controlsRun += 1
  const before = raw(c.file)
  const beforeSha = sha(c.file)
  const after = before.replace(c.find, c.replace)
  if (after === before) {
    console.log(`  ✗ NEGATIVE CONTROL ${label} — PATCH DID NOT APPLY (find-string not found); control proves nothing`)
    failures.push(`negative control did not apply: ${label}`)
    return
  }
  writeFileSync(resolve(ROOT, c.file), after)
  PRODUCTION_FILES = null
  let wentRed = false
  try {
    const marker = failures.length
    const runs = assertionsRun
    const ok = await fn()
    wentRed = !ok || failures.length > marker
    while (failures.length > marker) failures.pop()
    assertionsRun = runs // controls do not inflate the assertion tally
  } finally {
    writeFileSync(resolve(ROOT, c.file), before)
    PRODUCTION_FILES = null
    if (sha(c.file) !== beforeSha) {
      failures.push(`FAILED TO RESTORE ${c.file}`)
      console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
      return
    }
  }
  if (wentRed) console.log(`  ✓ NEGATIVE CONTROL ${label} — went RED as required`)
  else {
    console.log(`  ✗ NEGATIVE CONTROL ${label} — STAYED GREEN with the defect present`)
    failures.push(`negative control stayed green: ${label}`)
  }
}

/** Same mechanics, opposite requirement: the assertion must stay GREEN. */
async function specificity(label: string, c: Control, fn: () => boolean | Promise<boolean>): Promise<void> {
  controlsRun += 1
  const before = raw(c.file)
  const beforeSha = sha(c.file)
  const after = before.replace(c.find, c.replace)
  if (after === before) {
    console.log(`  ✗ SPECIFICITY CONTROL ${label} — PATCH DID NOT APPLY`)
    failures.push(`specificity control did not apply: ${label}`)
    return
  }
  writeFileSync(resolve(ROOT, c.file), after)
  PRODUCTION_FILES = null
  let stillGreen = false
  try {
    const marker = failures.length
    const runs = assertionsRun
    const ok = await fn()
    stillGreen = ok && failures.length === marker
    while (failures.length > marker) failures.pop()
    assertionsRun = runs
  } finally {
    writeFileSync(resolve(ROOT, c.file), before)
    PRODUCTION_FILES = null
    if (sha(c.file) !== beforeSha) {
      failures.push(`FAILED TO RESTORE ${c.file}`)
      console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
      return
    }
  }
  if (stillGreen) console.log(`  ✓ SPECIFICITY CONTROL ${label} — stayed GREEN, as required`)
  else {
    console.log(`  ✗ SPECIFICITY CONTROL ${label} — went RED`)
    failures.push(`specificity control went red: ${label}`)
  }
}

// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("AI GATEWAY SINGLE-LANE GUARD")
  console.log(`  production dirs: ${PRODUCTION_DIRS.join(", ")} (${productionFiles().length} files)`)
  console.log(`  named provider-key carve-outs: ${PROVIDER_KEY_CARVE_OUTS.length}`)
  for (const c of PROVIDER_KEY_CARVE_OUTS) {
    console.log(`    · ${c.file} [${c.keys.join(", ")}]`)
    console.log(`      ${c.why.replace(/\s+/g, " ").slice(0, 160)}…`)
  }
  console.log("\nASSERTIONS")

  assertNoProviderSdkImports()
  assertNoProviderSdkDependencies()
  assertNoProviderKeyReads()
  assertCarveOutsAreLive()
  assertOneResolver()
  await assertResolverProducesCanonicalStrings()
  assertModelConfigProvidersAreOnTheGateway()
  assertModelsFileIsGatewayOnly()
  assertNoDirectModelFactoryAnywhere()
  assertGatewayCallsAreCanonical()
  assertGatewayWrappersCheckTheKey()
  assertTranscriptionIsOnTheGateway()

  if (RUN_NEGATIVE) {
    console.log("\nNEGATIVE CONTROLS (each must go RED)")

    // C1 (A1): a provider SDK comes back as a DYNAMIC import inside a function
    //          body — the exact shape both real defects had, and the shape a
    //          top-of-file import scan misses.
    await controlled(
      "a provider SDK returns as a dynamic import inside a function body",
      {
        file: GENERATE,
        find: "    const text = await runPipelineSimple(jsonPrompt, {",
        replace:
          '    const { anthropic } = await import("@ai-sdk/anthropic")\n' +
          "    void anthropic\n" +
          "    const text = await runPipelineSimple(jsonPrompt, {",
      },
      assertNoProviderSdkImports,
    )

    // C2 (A1): and as a plain top-level static import.
    await controlled(
      "a provider SDK returns as a top-level static import",
      {
        file: GENERATE,
        find: 'import { createGateway } from "@ai-sdk/gateway"',
        replace: 'import { createGateway } from "@ai-sdk/gateway"\nimport { openai } from "@ai-sdk/openai"',
      },
      assertNoProviderSdkImports,
    )

    // C3 (A2): the package is reinstated as a dependency. No importer yet — and
    //          that is the point: an installed lane is one line away from used.
    await controlled(
      "a provider SDK is reinstated in package.json dependencies",
      {
        file: PKG,
        find: '    "@ai-sdk/gateway": "^3.0.66",',
        replace: '    "@ai-sdk/anthropic": "^3.0.46",\n    "@ai-sdk/gateway": "^3.0.66",',
      },
      assertNoProviderSdkDependencies,
    )

    // C4 (A3): a provider key read appears in a file that is NOT a named
    //          carve-out — the "just this once" that becomes the second lane.
    await controlled(
      "a provider API key is read from a file that is not a named carve-out",
      {
        file: GENERATE,
        find: "  const apiKey = process.env.AI_GATEWAY_API_KEY",
        replace: "  const apiKey = process.env.AI_GATEWAY_API_KEY ?? process.env.OPENAI_API_KEY",
      },
      assertNoProviderKeyReads,
    )

    // C5 (A3b): a carve-out goes stale — the file stops reading the key the
    //           exemption was granted for, and the exemption silently widens.
    await controlled(
      "a named carve-out stops reading the key its exemption was granted for",
      {
        file: "lib/agents/spawn-helper.ts",
        find: "  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, skipped: \"no-api-key\" }",
        replace: "  if (!process.env.MANAGED_AGENTS_KEY) return { ok: false, skipped: \"no-api-key\" }",
      },
      assertCarveOutsAreLive,
    )

    // C6 (A4): a SECOND resolveModel appears — two alias tables is how
    //          "claude-sonnet" starts meaning two different models.
    await controlled(
      "a second resolveModel is exported from another production module",
      {
        file: GENERATE,
        find: "// ─── JSON GENERATION ─────────────────────────────────────────────────────────",
        replace:
          "export function resolveModel(m: string): string { return m }\n\n" +
          "// ─── JSON GENERATION ─────────────────────────────────────────────────────────",
      },
      assertOneResolver,
    )

    // C7 (A5): an alias resolves to a NESTED path ("anthropic/claude/opus-4-5")
    //          rather than a gateway model id. The gateway addresses models as
    //          exactly `provider/model`; anything else 404s at request time.
    //
    //          NOTE ON WHAT THIS CONTROL IS *NOT*. The obvious control — point an
    //          alias at a BARE id — was tried first and STAYED GREEN, because the
    //          resolver's own prefixing heuristic repairs it: a slash-free value
    //          containing "claude" comes back as "anthropic/…" anyway. That is
    //          correct behaviour, so the control was measuring nothing. C8 below
    //          removes the heuristic itself, which is the defect that actually
    //          lets a bare id reach the SDK.
    await controlled(
      "an alias resolves to a nested path instead of a gateway provider/model id",
      {
        file: RESOLVER,
        find: '  "claude-opus":       "anthropic/claude-opus-4-5",',
        replace: '  "claude-opus":       "anthropic/claude/opus-4-5",',
      },
      assertResolverProducesCanonicalStrings,
    )

    // C7b (A5): the already-resolved pass-through breaks, so a provider instance
    //           handed back from a previous call is stringified into nonsense.
    //           Double resolution is safe TODAY and several call sites rely on it.
    await controlled(
      "an already-resolved provider instance is no longer passed through unchanged",
      {
        file: RESOLVER,
        find: '  if (typeof modelOrId !== "string") {\n    return modelOrId\n  }',
        replace: '  if (typeof modelOrId !== "string") {\n    return String(modelOrId)\n  }',
      },
      assertResolverProducesCanonicalStrings,
    )

    // C8 (A5): the bare-id prefixing heuristic is removed, so any short id
    //          reaches the SDK naked.
    await controlled(
      "the bare-id provider-prefix heuristic is removed",
      {
        file: RESOLVER,
        find: '  if (!resolved.includes("/")) {',
        replace: "  if (false) {",
      },
      assertResolverProducesCanonicalStrings,
    )

    // C9 (A5b): MODEL_CONFIG routes to a provider the installed gateway does not
    //           carry — the check that would have caught a bad Perplexity collapse.
    await controlled(
      "MODEL_CONFIG routes a task to a provider the gateway does not carry",
      {
        file: MODELS,
        find: '"perplexity-sonar": { provider: "perplexity", modelId: "sonar" }',
        replace: '"perplexity-sonar": { provider: "perplexitee", modelId: "sonar" }',
      },
      assertModelConfigProvidersAreOnTheGateway,
    )

    // C10 (A6): THE REAL DEFECT, restored verbatim — the Perplexity branch that
    //           built its own OpenAI-compatible client on a provider key. This is
    //           the one control that reproduces what was actually found.
    await controlled(
      "the Perplexity direct-client branch returns to executeModelCall",
      {
        file: MODELS,
        find: "  const modelStr = `${config.provider}/${config.modelId}` as Parameters<typeof resolveModel>[0]\n  const modelInstance: ReturnType<typeof resolveModel> = toGatewayModel(resolveModel(modelStr) as string)",
        replace:
          "  let modelInstance: ReturnType<typeof resolveModel>\n" +
          '  if (config.provider === "perplexity") {\n' +
          '    const { createOpenAI } = await import("@ai-sdk/openai")\n' +
          '    const perplexity = createOpenAI({ apiKey: process.env.PERPLEXITY_API_KEY || "", baseURL: "https://api.perplexity.ai" })\n' +
          "    modelInstance = perplexity(config.modelId)\n" +
          "  } else {\n" +
          "    const modelStr = `${config.provider}/${config.modelId}` as Parameters<typeof resolveModel>[0]\n" +
          "    modelInstance = toGatewayModel(resolveModel(modelStr) as string)\n" +
          "  }",
      },
      assertModelsFileIsGatewayOnly,
    )

    // C11 (A6b): the same construct anywhere else in production.
    await controlled(
      "a provider model client is constructed in some other production module",
      {
        file: GENERATE,
        find: "export async function generateAIText(",
        replace:
          "function makeClient() { return createOpenAI({ apiKey: \"\" }) }\n\n" +
          "export async function generateAIText(",
      },
      assertNoDirectModelFactoryAnywhere,
    )

    // C12 (A7): the gateway is handed a bare ALIAS instead of a canonical id.
    //           It resolves to nothing and the call 404s at request time.
    await controlled(
      "a gateway factory call is handed a bare alias instead of provider/model",
      {
        file: LICENSE,
        find: 'model: gateway("anthropic/claude-sonnet-4"),',
        replace: 'model: gateway("claude-sonnet"),',
      },
      assertGatewayCallsAreCanonical,
    )

    // C13 (A7b): the wrapper stops refusing on a missing key, so an unconfigured
    //            deployment produces provider errors instead of one clear message.
    await controlled(
      "the gateway wrapper stops refusing when AI_GATEWAY_API_KEY is missing",
      {
        file: MODELS,
        find: '  if (!key) throw new Error("AI_GATEWAY_API_KEY is not configured")',
        replace: "  if (!key) { /* carry on regardless */ }",
      },
      assertGatewayWrappersCheckTheKey,
    )

    // C14 (A8): transcription is pointed back at api.openai.com on a provider key
    //           — the carve-out this wave closed, reopening itself.
    await controlled(
      "transcription is pointed back at api.openai.com on OPENAI_API_KEY",
      {
        file: TRANSCRIBE,
        find: '    baseUrl: "https://ai-gateway.vercel.sh",\n    path: "/v4/ai/transcription-model",',
        replace: '    baseUrl: "https://api.openai.com",\n    path: "/v1/audio/transcriptions",',
      },
      assertTranscriptionIsOnTheGateway,
    )

    console.log("\nSPECIFICITY CONTROLS (each must stay GREEN)")

    // S1 (A1): PROSE control. A comment naming a provider SDK is documentation —
    //          the header of transcribe-core.ts legitimately names @ai-sdk/openai
    //          to explain why it is gone. Comments must never trip the scan.
    await specificity(
      "a COMMENT naming a provider SDK specifier is not an import",
      {
        file: GENERATE,
        find: "// ─── TEXT GENERATION ─────────────────────────────────────────────────────────",
        replace:
          '// NOTE: we do not import "@ai-sdk/openai" or "@anthropic-ai/sdk" here — see the gateway ruling.\n' +
          "// ─── TEXT GENERATION ─────────────────────────────────────────────────────────",
      },
      assertNoProviderSdkImports,
    )

    // S2 (A3): SCOPE control. A carve-out file may read its named key MORE than
    //          once; the exemption is per (file, key), not per occurrence.
    await specificity(
      "a named carve-out reading its key a second time is still exempt",
      {
        file: "lib/agents/managed-agents-egress.ts",
        find: "function getAnthropicKey(): string | null {",
        replace:
          "function hasAnthropicKey(): boolean { return !!process.env.ANTHROPIC_API_KEY }\n" +
          "function getAnthropicKey(): string | null {",
      },
      assertNoProviderKeyReads,
    )

    // S3 (A1): DIRECTORY control. scripts/ is not production — this guard names
    //          every provider specifier in the repo as string fixtures, and the
    //          identical text under scripts/ must stay GREEN.
    await specificity(
      "provider specifiers written under scripts/ are fixtures, not call sites",
      {
        file: "scripts/ai-gateway-single-lane-guard.ts",
        find: "const ROOT = process.cwd()",
        replace:
          "const ROOT = process.cwd()\n" +
          'const S3_FIXTURE = [require("openai"), require("@anthropic-ai/sdk")] // S3 fixture: real require() text\n' +
          "void S3_FIXTURE",
      },
      assertNoProviderSdkImports,
    )
  }

  console.log("")
  console.log(`TALLY: ${assertionsRun} assertions, ${controlsRun} controls`)
  if (failures.length) {
    console.log(`FAILED (${failures.length})`)
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log("PASSED")
}

main()
