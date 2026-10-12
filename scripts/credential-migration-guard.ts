#!/usr/bin/env tsx
/**
 * scripts/credential-migration-guard.ts   (npm run test:credential-migration)
 * ─────────────────────────────────────────────────────────────────────────────
 * NO PLAINTEXT CREDENTIAL WRITER REMAINS + THE LEGACY RE-SEAL (wave 140H; owner wave 140 "approve
 * all": migrate reader-encrypted → write encrypted → migrate → verify → stop plaintext; never destroy
 * before verify).
 *
 *  W  WRITER CENSUS (derived, not a list): every insert/update/upsert payload on one of the credential
 *     stores (SECRET_STORE_COLUMNS — the ONE list) that names a secret column seals it with
 *     encryptSecret( or writes null. Object-literal payloads are read in place; identifier payloads are
 *     resolved to their `const x = {…}` literal in the same file; a bare-identifier spread is OPAQUE
 *     and must be adjudicated by name with a reason. Six positive controls. Set
 *     CREDENTIAL_CENSUS_REF=<git ref> to print the same census over that ref (the before/after number).
 *  R  READER CENSUS: every file that selects a secret column from a store references decryptSecret /
 *     decryptSecretFields; a wildcard (select("*")) reader never dereferences a secret field unless
 *     adjudicated by name.
 *  M  THE JOB against an injected store: refuses with no key (no read, no write); re-seals plaintext
 *     rows that then decrypt back; an already-sealed row is untouched; the second pass writes 0
 *     (idempotent); every update is pinned to id + the row's own brokerage_id (IS NULL for a platform
 *     row) + NOT LIKE 'enc:v1:%' and COUNTS the matched row; a row the filter should have excluded is
 *     counted verify-failed and NOT written (never destroy before verify); no payload carries the
 *     plaintext as a filter.
 *  T  TENANT SCOPE: every store in SECRET_STORE_COLUMNS has a brokerage_id column (schema snapshot).
 *  D  DOORS + DOCS: the platform-staff action gates BEFORE createServiceClient; the sentinel heartbeat
 *     runs the job only behind keyConfigured && legacyPlaintextTotal > 0; the board wires the action;
 *     .env.example + PRODUCTION-ARCHITECTURE document SECRETS_ENCRYPTION_KEY as fail-closed.
 *  REG package.json + guard chain + MAINTENANCE_DOMAINS.
 * No network. Scans read stripped source (scripts/strip-comments.ts).
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { stripComments } from "./strip-comments"
import { SECRET_STORE_COLUMNS } from "../lib/security/credential-rotation"
import { CREDENTIAL_STORE_PUBLIC_COLUMNS, canonicalCredentialSelect } from "../lib/security/credential-projection"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let pass = 0, fail = 0
const check = (n: string, c: boolean, detail = "") => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) } }
const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(read(p))

const STORES = SECRET_STORE_COLUMNS.map((s) => s.table)
const SECRET_COLS = Array.from(new Set(SECRET_STORE_COLUMNS.flatMap((s) => s.columns)))
const SECRET_KEY_RE = new RegExp(`(^|[{,\\n]\\s*)(${SECRET_COLS.join("|")})\\s*(:|,|\\})`, "g")

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(join(ROOT, dir))) {
    const p = `${dir}/${f}`
    if (f === "node_modules" || f.startsWith(".")) continue
    const st = statSync(join(ROOT, p))
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(f)) out.push(p)
  }
  return out
}

// ── balanced extraction helpers ────────────────────────────────────────────────────────────────
function balanced(s: string, open: number, o: string, c: string): string | null {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const ch = s[i]
    if (ch === o) depth++
    else if (ch === c) { depth--; if (depth === 0) return s.slice(open, i + 1) }
  }
  return null
}
/** Top-level (depth-1) entries of an object literal `{ … }` — split on commas outside nested braces/parens/brackets. */
function topLevelEntries(obj: string): string[] {
  const inner = obj.slice(1, -1)
  const out: string[] = []
  let depth = 0, cur = ""
  for (const ch of inner) {
    if ("{([".includes(ch)) depth++
    else if ("})]".includes(ch)) depth--
    if (ch === "," && depth === 0) { out.push(cur); cur = "" } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map((e) => e.trim()).filter(Boolean)
}

interface WriterFinding { file: string; store: string; op: string; kind: "plaintext_write" | "opaque_payload" | "opaque_spread"; detail: string }
interface WriterCensus { sites: number; literal: number; identifier: number; findings: WriterFinding[]; files: Set<string> }

/** Bare-identifier spreads inside a store payload that the census cannot see through — adjudicated by name. */
const ADJUDICATED_SPREADS: Record<string, string> = {
  "lib/platform/platform-social.ts|fields": "upsertPlatformCredential: every caller passes access_token/refresh_token in `fields`; both are re-sealed EXPLICITLY after the spread (encryptSecret), which overrides the spread value",
}

function judgePayload(file: string, store: string, op: string, obj: string, findings: WriterFinding[]) {
  for (const entry of topLevelEntries(obj)) {
    if (entry.startsWith("...")) {
      const m = /^\.\.\.\(?\s*([A-Za-z_$][\w$]*)\s*\)?$/.exec(entry)
      if (m) {
        if (!ADJUDICATED_SPREADS[`${file}|${m[1]}`]) findings.push({ file, store, op, kind: "opaque_spread", detail: `...${m[1]}` })
        continue
      }
      // a conditional spread literal: judge the literal it carries
      const i = entry.indexOf("{")
      if (i >= 0) { const inner = balanced(entry, i, "{", "}"); if (inner) judgePayload(file, store, op, inner, findings) }
      continue
    }
    const km = /^(?:\[?["']?)([A-Za-z_]\w*)(?:["']?\]?)\s*(:|$)/.exec(entry)
    if (!km) continue
    const key = km[1]
    if (!SECRET_COLS.includes(key)) continue
    if (km[2] !== ":") { findings.push({ file, store, op, kind: "plaintext_write", detail: `${key} (shorthand)` }); continue }
    const value = entry.slice(entry.indexOf(":") + 1).trim()
    if (/^encryptSecret\(/.test(value) || value === "null" || value === "undefined" || value === '""') continue
    findings.push({ file, store, op, kind: "plaintext_write", detail: `${key}: ${value.slice(0, 60)}` })
  }
}

/** The writer census over ONE file's stripped source. */
function writerCensusIn(file: string, src: string, census: WriterCensus) {
  for (const store of STORES) {
    const marker = `.from("${store}")`
    let at = 0
    for (;;) {
      const i = src.indexOf(marker, at)
      if (i < 0) break
      at = i + marker.length
      const nextFrom = src.indexOf(".from(", at)
      const window = src.slice(at, nextFrom < 0 ? at + 1500 : Math.min(nextFrom, at + 1500))
      const wm = /\.(insert|update|upsert)\(/.exec(window)
      if (!wm) continue
      const open = at + (wm.index ?? 0) + wm[0].length - 1
      const arg = balanced(src, open, "(", ")")
      if (!arg) continue
      census.sites++; census.files.add(file)
      const body = arg.slice(1, -1).trim()
      if (body.startsWith("{")) {
        const obj = balanced(body, 0, "{", "}")
        census.literal++
        if (obj) judgePayload(file, store, wm[1], obj, census.findings)
        continue
      }
      const im = /^([A-Za-z_$][\w$]*)\s*(,|$)/.exec(body)
      if (im) {
        const def = new RegExp(`(?:const|let)\\s+${im[1]}\\s*(?::[^=]+)?=\\s*\\{`).exec(src)
        if (def) {
          const obj = balanced(src, (def.index ?? 0) + def[0].length - 1, "{", "}")
          census.identifier++
          if (obj) judgePayload(file, store, wm[1], obj, census.findings)
          continue
        }
        census.findings.push({ file, store, op: wm[1], kind: "opaque_payload", detail: im[1] })
        continue
      }
      // a call / computed expression payload — opaque
      census.findings.push({ file, store, op: wm[1], kind: "opaque_payload", detail: body.slice(0, 40) })
    }
  }
}

function runWriterCensus(reader: (p: string) => string | null, files: string[]): WriterCensus {
  const census: WriterCensus = { sites: 0, literal: 0, identifier: 0, findings: [], files: new Set() }
  for (const f of files) { const raw = reader(f); if (raw !== null) writerCensusIn(f, stripComments(raw), census) }
  return census
}

function writerLayer(files: string[]) {
  console.log("\n[W — writer census: every secret column written to a credential store is sealed]")
  // positive controls — the finder sees the defects it exists for
  const ctl = (src: string) => { const c: WriterCensus = { sites: 0, literal: 0, identifier: 0, findings: [], files: new Set() }; writerCensusIn("ctl.ts", stripComments(src), c); return c }
  check("CONTROL: a literal payload writing access_token in plaintext is caught", ctl(`await svc.from("platform_credentials").insert({ brokerage_id: b, access_token: tokens.access_token })`).findings.some((f) => f.kind === "plaintext_write" && /access_token/.test(f.detail)))
  check("CONTROL: an identifier payload (const row = {…}) writing api_key is resolved and caught", ctl(`const row = { brokerage_id: b, api_key: apiKey }\nconst { error } = await svc.from("platform_credentials").update(row).eq("id", x)`).findings.some((f) => f.kind === "plaintext_write" && /api_key/.test(f.detail)))
  check("CONTROL: a shorthand { access_token } is caught", ctl(`await svc.from("social_media_accounts").upsert({ access_token, platform })`).findings.some((f) => /shorthand/.test(f.detail)))
  check("CONTROL: a sealed payload (encryptSecret / null) is clean", ctl(`await svc.from("agent_api_credentials").insert({ api_key: encryptSecret(k), api_secret: null, refresh_token: encryptSecret(r ?? null) })`).findings.length === 0)
  check("CONTROL: a plaintext key inside a COMMENT is not counted (stripped)", ctl(`await svc.from("integration_credentials").insert({ api_key: encryptSecret(k) }) // api_key: raw\n/* api_key: raw */`).findings.length === 0)
  check("CONTROL: an unresolvable payload (function parameter) is reported opaque, never clean", ctl(`async function save(payload: any) { await svc.from("platform_credentials").insert(payload) }`).findings.some((f) => f.kind === "opaque_payload"))
  check("CONTROL: a bare spread the census cannot see through is reported unless adjudicated", ctl(`const row = { platform: p, ...creds }\nawait svc.from("platform_credentials").insert(row)`).findings.some((f) => f.kind === "opaque_spread"))

  const now = runWriterCensus((p) => read(p), files)
  const plaintext = now.findings.filter((f) => f.kind === "plaintext_write")
  const opaque = now.findings.filter((f) => f.kind !== "plaintext_write")
  console.log(`    census: ${files.length} files in lib/ + app/; ${now.sites} store write sites in ${now.files.size} files (${now.literal} literal, ${now.identifier} identifier payloads); plaintext writers: ${plaintext.length}; opaque: ${opaque.length}`)
  const ref = process.env.CREDENTIAL_CENSUS_REF
  if (ref) {
    const before = runWriterCensus((p) => { try { return execFileSync("git", ["show", `${ref}:${p}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) } catch { return null } }, files)
    const bp = before.findings.filter((f) => f.kind === "plaintext_write")
    console.log(`    at ${ref}: ${before.sites} sites; plaintext writers: ${bp.length}; opaque: ${before.findings.length - bp.length}`)
    for (const f of bp) console.log(`      ${ref}: ${f.file} ${f.store}.${f.op} — ${f.detail}`)
  }
  for (const f of now.findings) console.log(`      HEAD: ${f.kind} ${f.file} ${f.store}.${f.op} — ${f.detail}`)
  check("no credential-store write site writes a secret column in plaintext", plaintext.length === 0, plaintext.map((f) => `${f.file}:${f.detail}`).join("; "))
  check("no credential-store write site has an unadjudicated opaque payload or spread", opaque.length === 0, opaque.map((f) => `${f.file}:${f.detail}`).join("; "))
  for (const [key, why] of Object.entries(ADJUDICATED_SPREADS)) {
    const [file, ident] = key.split("|")
    const src = code(file)
    check(`adjudicated spread ...${ident} in ${file} still exists and is overridden by sealed keys (${why.slice(0, 40)}…)`, new RegExp(`\\.\\.\\.${ident}\\b`).test(src) && /access_token:\s*encryptSecret\(/.test(src) && /refresh_token:\s*encryptSecret\(/.test(src))
  }
}

// ── R — reader census ─────────────────────────────────────────────────────────────────────────
const SELECT_SECRET_RE = new RegExp(`\\.select\\("[^"]*\\b(${SECRET_COLS.join("|")})\\b`)
/** Wildcard readers that dereference a secret field with no decrypt — adjudicated by name with the reason.
 *  Wave 140P emptied it: the two entries (the IDX browser page, getPlatformCredentials) now read the NON-secret
 *  projection (lib/security/credential-projection.ts) and dereference no secret field. */
const ADJUDICATED_WILDCARD: Record<string, string> = {}

/** PURE — chain-level: every `.from("<store>")` whose chain (up to the next blank line / statement end)
 *  selects `*`. File-level co-occurrence (a `select("*")` on some OTHER table in a store-reading file) is
 *  NOT a hit — that is what the file-level census above counts as "wildcard"; this is the stricter rule. */
function wildcardStoreChains(src: string, stores: readonly string[]): string[] {
  const out: string[] = []
  const re = new RegExp(`\\.from\\("(${stores.join("|")})"\\)`, "g")
  for (const m of src.matchAll(re)) {
    const start = m.index ?? 0
    const rest = src.slice(start)
    const endBlank = rest.indexOf("\n\n")
    const chain = rest.slice(0, Math.min(endBlank < 0 ? 600 : endBlank, 600))
    if (/\.select\("\*"\)/.test(chain)) out.push(`${m[1]}@${src.slice(0, start).split("\n").length}`)
  }
  return out
}
function readerLayer(files: string[]) {
  console.log("\n[R — reader census: every secret-selecting store reader decrypts]")
  const storeRe = new RegExp(`\\.from\\("(${STORES.join("|")})"\\)`)
  const judge = (src: string): "ok" | "missing_decrypt" | "n/a" => {
    if (!storeRe.test(src) || !SELECT_SECRET_RE.test(src)) return "n/a"
    return /\bdecryptSecret(Fields)?\(/.test(src) ? "ok" : "missing_decrypt"
  }
  check("CONTROL: a store reader selecting access_token with no decrypt is caught", judge(`const { data } = await svc.from("social_media_accounts").select("id, access_token").eq("id", x)\nuse(data.access_token)`) === "missing_decrypt")
  check("CONTROL: the same reader through decryptSecret is clean", judge(`const { data } = await svc.from("social_media_accounts").select("id, access_token")\nuse(decryptSecret(data.access_token))`) === "ok")
  const missing: string[] = []; let readers = 0
  const wildcardBad: string[] = []; let wildcard = 0
  for (const f of files) {
    const src = code(f)
    const v = judge(src)
    if (v !== "n/a") readers++
    if (v === "missing_decrypt") missing.push(f)
    if (storeRe.test(src) && /\.select\("\*"\)/.test(src)) {
      wildcard++
      // a wildcard reader that dereferences a secret field must decrypt it somewhere (file-level, like R
      // above) or be adjudicated by name
      const deref = new RegExp(`\\.(${SECRET_COLS.join("|")})\\b`).test(src.replace(/\.select\("[^"]*"\)/g, ""))
      if (deref && !/\bdecryptSecret(Fields)?\(/.test(src) && !ADJUDICATED_WILDCARD[f]) wildcardBad.push(f)
    }
  }
  console.log(`    census: ${readers} files select a secret column from a store; ${wildcard} wildcard (select("*")) store readers`)
  check("every file that selects a secret column from a store references decryptSecret / decryptSecretFields", missing.length === 0, missing.join(", "))
  check("no wildcard store reader dereferences a secret field without decrypting (or it is adjudicated by name)", wildcardBad.length === 0, wildcardBad.join(", "))
  check("CONTROL: a wildcard reader dereferencing access_token with no decrypt is what the finder catches", (() => { const s = `const { data } = await svc.from("social_media_accounts").select("*")\nuse(data.access_token)`; return /\.select\("\*"\)/.test(s) && /\.(access_token)\b/.test(s.replace(/\.select\("[^"]*"\)/g, "")) && !/decryptSecret/.test(s) })())
  for (const f of Object.keys(ADJUDICATED_WILDCARD)) check(`adjudicated wildcard reader ${f} still exists and still has no decrypt (a stale adjudication fails)`, files.includes(f) && !/\bdecryptSecret(Fields)?\(/.test(code(f)))

  // ── wave 140 (lane 140P): rows that reach a BROWSER never carry a secret column ──────────────────
  // THE RULE: a store read whose rows become a "use server" return value or a page/component prop
  // (any `"use server"` module, any .tsx module) selects the NON-secret projection, never `*`.
  // Derived (chain-level), zero baseline — lib/ and route handlers are outside this population
  // (their rows stay server-side; the file-level census above still counts them).
  console.log("\n[P — the browser projection: no \"use server\" module and no .tsx reads a credential store with select(\"*\")]")
  const surface = files.filter((f) => f.endsWith(".tsx") || /^\s*["']use server["']/m.test(read(f).split("\n").slice(0, 40).join("\n")))
  const surfaceHits = surface.flatMap((f) => wildcardStoreChains(code(f), STORES).map((h) => `${f} ${h}`))
  console.log(`    census: ${surface.length} surface modules (.tsx + "use server") in lib/ + app/; ${surfaceHits.length} wildcard store chain(s)`)
  check("no surface module reads a credential store with select(\"*\") (rows that reach a browser carry the projection only)", surfaceHits.length === 0, surfaceHits.join("; "))
  check("CONTROL: a store chain selecting * is caught; a select(*) on another table in the same file is not; a projected read is not",
    wildcardStoreChains(`const { data } = await svc.from("platform_credentials")\n  .select("*")\n  .eq("id", x)`, STORES).length === 1 &&
    wildcardStoreChains(`const { data } = await svc.from("platform_credentials").select("id, platform").eq("id", x)\n\nconst { data: o } = await svc.from("provider_overrides").select("*")`, STORES).length === 0 &&
    wildcardStoreChains(`await svc.from("social_media_accounts").select(publicCredentialSelect("social_media_accounts"))`, STORES).length === 0)
  // the projection module: every list is live columns MINUS the store's secret columns, spelled once
  const snapshot = SCHEMA_SNAPSHOT as Record<string, readonly string[]>
  for (const [store, cols] of Object.entries(CREDENTIAL_STORE_PUBLIC_COLUMNS)) {
    const secret = SECRET_STORE_COLUMNS.find((s) => s.table === store)?.columns ?? []
    const live = snapshot[store] ?? []
    const leaked = (cols as readonly string[]).filter((c) => secret.includes(c))
    const dead = (cols as readonly string[]).filter((c) => !live.includes(c))
    check(`credential-projection ${store}: ${cols.length} columns — no secret column (${secret.join("/")}) and every column is LIVE (schema snapshot)`, leaked.length === 0 && dead.length === 0 && live.length > 0, `leaked=${leaked.join(",")} dead=${dead.join(",")}`)
  }
  const projectionReaders = files.filter((f) => /publicCredentialSelect\(/.test(code(f)) && f !== "lib/security/credential-projection.ts")
  check(`the projection has real readers (${projectionReaders.length}): the five 140P surfaces (platform_credentials ×2, social_media_accounts ×3, integration_credentials ×1)`, projectionReaders.length >= 6, projectionReaders.join(", "))
  // Every call site spells the column list LITERALLY (what the column scanners read) and that literal IS the
  // canonical list — a drift is a finding here, and the helper would have served the canonical list anyway.
  const siteDrift: string[] = []
  for (const f of projectionReaders) {
    for (const m of code(f).matchAll(/publicCredentialSelect\("([^"]+)",\s*CREDENTIAL_STORES\.([a-z_]+)\)/g)) {
      if (m[1] !== canonicalCredentialSelect(m[2] as any)) siteDrift.push(`${f}: ${m[2]}`)
    }
    if (!/publicCredentialSelect\("[^"]+",\s*CREDENTIAL_STORES\.[a-z_]+\)/.test(code(f))) siteDrift.push(`${f}: literal-less call`)
  }
  check("every projection call site spells the canonical column list literally (scanner-visible) — no drift, no identifier-only call", siteDrift.length === 0, siteDrift.join("; "))
  const getCreds = code("app/actions/settings/integrations.ts")
  const getCredsBody = getCreds.slice(getCreds.indexOf("export async function getPlatformCredentials"), getCreds.indexOf("export async function getProviderOverrides"))
  check("getPlatformCredentials never SELECTS a secret column: presence is answered by NOT NULL filters (api_key_configured / access_token_configured) and config is redacted of CONFIG_SECRET_KEYS", !SELECT_SECRET_RE.test(getCredsBody) && /\.not\("api_key", "is", null\)/.test(getCredsBody) && /\.not\("access_token", "is", null\)/.test(getCredsBody) && /api_key_configured: hasKey\.has/.test(getCredsBody) && /redactConfigSecrets\(row\.config\)/.test(getCredsBody) && /CONFIG_SECRET_KEYS/.test(getCreds))
  check("CONTROL: the secret-select finder recognises a select that names access_token", SELECT_SECRET_RE.test(`.select("id, platform, access_token")`) && !SELECT_SECRET_RE.test(`.select("id, platform, account_name")`))
}

// ── M — the job against an injected store ─────────────────────────────────────────────────────
type Row = Record<string, unknown>
function fakeStore(tables: Record<string, Row[]>, opts: { ignoreLikeOnSelect?: boolean } = {}) {
  const updates: Array<{ table: string; payload: Row; filters: string[] }> = []
  const from = (table: string) => {
    const rows = tables[table] ?? []
    let op: "select" | "update" = "select"; let payload: Row = {}
    const filters: Array<(r: Row) => boolean> = []; const desc: string[] = []
    const b: any = {
      select: () => b,
      limit: () => b,
      update: (p: Row) => { op = "update"; payload = p; return b },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); desc.push(`eq:${c}`); return b },
      is: (c: string, v: unknown) => { filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); desc.push(`is:${c}`); return b },
      not: (c: string, o: string, v: unknown) => {
        desc.push(`not:${c}:${o}`)
        if (o === "is") filters.push((r) => !(r[c] === null || r[c] === undefined))
        else if (o === "like") { if (!(op === "select" && opts.ignoreLikeOnSelect)) filters.push((r) => !(typeof r[c] === "string" && (r[c] as string).startsWith(String(v).replace(/%$/, "")))) }
        return b
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        const matched = rows.filter((r) => filters.every((f) => f(r)))
        if (op === "update") { for (const r of matched) Object.assign(r, payload); updates.push({ table, payload, filters: [...desc] }); return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null }).then(res, rej) }
        return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null }).then(res, rej)
      },
    }
    return b
  }
  return { client: { from }, updates, tables }
}

async function jobLayer() {
  console.log("\n[M — the re-seal job: refuse with no key; verify before rewrite; idempotent; pinned to id + tenant]")
  const sc = await import("../lib/security/secret-crypto")
  const { migrateLegacyPlaintextSecrets, sealVerified } = await import("../lib/security/secret-migration")
  const PLANT_A = "plain-PLANTED-token-a1", PLANT_K = "plain-PLANTED-key-k2", PLANT_P = "plain-PLANTED-platform-p3"
  const seed = () => ({
    platform_credentials: [
      { id: "p1", brokerage_id: "t1", access_token: PLANT_A, refresh_token: null, api_key: null },
      { id: "p2", brokerage_id: "t1", access_token: "enc:v1:already:sealed:row", refresh_token: null, api_key: null },
      { id: "p3", brokerage_id: "t2", access_token: null, refresh_token: null, api_key: PLANT_K },
      { id: "p4", brokerage_id: null, access_token: PLANT_P, refresh_token: null, api_key: null },
    ],
    agent_api_credentials: [], integration_credentials: [], social_media_accounts: [],
  })
  delete process.env.SECRETS_ENCRYPTION_KEY; delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS
  const noKey = fakeStore(seed())
  const r0 = await migrateLegacyPlaintextSecrets(noKey.client as any)
  check("no key → the job REFUSES (secrets_key_missing) before any write", r0.refused === "secrets_key_missing" && !r0.ok && noKey.updates.length === 0 && r0.totals.candidates === 0)

  process.env.SECRETS_ENCRYPTION_KEY = "d".repeat(64)
  try {
    check("sealVerified proves the round-trip (decrypt(encrypt(x)) === x) and returns the envelope", (() => { const s = sealVerified(PLANT_A); return !!s && sc.isEncrypted(s) && sc.decryptSecret(s) === PLANT_A })())
    check("sealVerified refuses to 'seal' an envelope (nothing is sealed twice)", sealVerified("enc:v1:already:sealed:row") === null)
    const store = fakeStore(seed())
    const r1 = await migrateLegacyPlaintextSecrets(store.client as any)
    const p = Object.fromEntries(store.tables.platform_credentials.map((r) => [r.id as string, r]))
    check("three legacy rows re-sealed (p1 access_token, p3 api_key, p4 access_token) and each decrypts back", r1.ok && r1.totals.migrated === 3 && sc.isEncrypted(p.p1.access_token as string) && sc.decryptSecret(p.p1.access_token as string) === PLANT_A && sc.decryptSecret(p.p3.api_key as string) === PLANT_K && sc.decryptSecret(p.p4.access_token as string) === PLANT_P, JSON.stringify(r1.totals))
    check("the already-sealed row is untouched (byte-identical)", p.p2.access_token === "enc:v1:already:sealed:row")
    check("every update is pinned to id AND the row's tenant AND NOT LIKE 'enc:v1:%' (never overwrites a concurrently sealed row)", store.updates.length === 3 && store.updates.every((u) => u.filters.includes("eq:id") && (u.filters.includes("eq:brokerage_id") || u.filters.includes("is:brokerage_id")) && u.filters.some((f) => /^not:(access_token|api_key):like$/.test(f))), store.updates.map((u) => u.filters.join("+")).join(" | "))
    check("a platform-owned row (brokerage_id NULL) is pinned with IS NULL, never left unpinned", store.updates.some((u) => u.filters.includes("is:brokerage_id")) && store.updates.filter((u) => u.filters.includes("eq:brokerage_id")).length === 2)
    check("no update payload carries the plaintext (only the envelope + updated_at)", store.updates.every((u) => Object.values(u.payload).every((v) => typeof v !== "string" || (!v.includes("PLANTED")))))
    check("the report carries counts per table.column and no secret value", !JSON.stringify(r1).includes("PLANTED") && r1.columns.some((c) => c.table === "platform_credentials" && c.column === "access_token" && c.migrated === 2))
    const r2 = await migrateLegacyPlaintextSecrets(store.client as any)
    check("IDEMPOTENT: the second pass finds 0 candidates and writes 0", r2.ok && r2.totals.candidates === 0 && r2.totals.migrated === 0 && store.updates.length === 3)
    const dry = fakeStore(seed())
    const r3 = await migrateLegacyPlaintextSecrets(dry.client as any, { dryRun: true })
    check("dryRun counts the candidates and writes nothing", r3.dryRun && r3.totals.candidates === 3 && dry.updates.length === 0 && dry.tables.platform_credentials[0].access_token === PLANT_A)
    // never destroy before verify: a store whose SELECT ignores the NOT LIKE filter hands the job an
    // already-sealed row — sealVerified returns null for it, it is counted verify-failed and NOT written.
    const leaky = fakeStore(seed(), { ignoreLikeOnSelect: true })
    const r4 = await migrateLegacyPlaintextSecrets(leaky.client as any)
    const lp = Object.fromEntries(leaky.tables.platform_credentials.map((r) => [r.id as string, r]))
    check("a row the filter should have excluded is counted verify-failed, NOT written, and the run is not ok", r4.totals.verifyFailed === 1 && !r4.ok && lp.p2.access_token === "enc:v1:already:sealed:row" && r4.totals.migrated === 3)
  } finally {
    delete process.env.SECRETS_ENCRYPTION_KEY
  }
}

// ── T — tenant scope of every migrated table ─────────────────────────────────────────────────
function tenantLayer() {
  console.log("\n[T — every store the job touches has a tenant column to pin]")
  const missing = SECRET_STORE_COLUMNS.filter((s) => !(SCHEMA_SNAPSHOT[s.table] ?? []).includes("brokerage_id")).map((s) => s.table)
  check(`every store in SECRET_STORE_COLUMNS (${STORES.join(", ")}) has brokerage_id in the schema snapshot`, missing.length === 0, missing.join(", "))
  const unknown = SECRET_STORE_COLUMNS.flatMap((s) => s.columns.filter((c) => !(SCHEMA_SNAPSHOT[s.table] ?? []).includes(c)).map((c) => `${s.table}.${c}`))
  check("every secret column in SECRET_STORE_COLUMNS exists in the schema snapshot", unknown.length === 0, unknown.join(", "))
  const job = code("lib/security/secret-migration.ts")
  check("the job pins brokerage_id on every update (eq for a tenant row, is-null for a platform row)", /\.is\("brokerage_id",\s*null\)/.test(job) && /\.eq\("brokerage_id",\s*tenant\)/.test(job) && /\.eq\("id",\s*row\.id\)/.test(job))
  check("the job seals through sealVerified BEFORE the update and skips on a failed round-trip", job.indexOf("sealVerified(value)") < job.indexOf(".update({ [column]: sealed") && /if \(!sealed\) \{ rep\.verifyFailed\+\+/.test(job))
  check("the job COUNTS the matched row (.select(\"id\") + length === 1)", /\.select\("id"\)/.test(job) && /written\.length !== 1/.test(job))
  check("the job never uses the plaintext as a filter (no .eq(column, value))", !/\.eq\(column,\s*value\)/.test(job))
}

// ── D — doors + docs ──────────────────────────────────────────────────────────────────────────
function doorsLayer() {
  console.log("\n[D — doors gate first; heartbeat retries; docs say fail-closed]")
  const action = code("app/actions/superadmin/secret-migration.ts")
  check("the platform-staff action gates (gateStaffAction) BEFORE createServiceClient()", action.indexOf("gateStaffAction(") >= 0 && action.indexOf("gateStaffAction(") < action.indexOf("createServiceClient()"))
  check("the action writes its evidence row with counts only and READS the write's error", /superadmin_audit_log/.test(action) && /auditError/.test(action) && !/decryptSecret|access_token:/.test(action))
  const sentinel = code("lib/platform/os-sentinel.ts")
  check("the sentinel heartbeat runs the re-seal only behind keyConfigured && legacyPlaintextTotal > 0", /posture\.keyConfigured && posture\.legacyPlaintextTotal > 0/.test(sentinel) && /migrateLegacyPlaintextSecrets\(svc/.test(sentinel))
  const board = code("app/dashboard/superadmin/sentinel/os-sentinel-board.tsx")
  check("the OS Sentinel board wires the action (a real surface, not an orphan)", /resealLegacyPlaintextSecretsAction\(/.test(board))
  const env = read(".env.example")
  const envBlock = env.slice(Math.max(0, env.indexOf("SECRETS_ENCRYPTION_KEY=") - 700), env.indexOf("SECRETS_ENCRYPTION_KEY="))
  check(".env.example documents SECRETS_ENCRYPTION_KEY as REQUIRED / FAIL CLOSED (refuse, never plaintext)", /FAIL CLOSED/i.test(envBlock) && /REFUSED|refuse/i.test(envBlock) && /never stored in plaintext|never plaintext/i.test(envBlock))
  const arch = read("docs/architecture/PRODUCTION-ARCHITECTURE.md")
  const row = arch.split("\n").find((l) => l.startsWith("| `SECRETS_ENCRYPTION_KEY`")) ?? ""
  check("PRODUCTION-ARCHITECTURE env table row says fail closed, refused, never plaintext, and names the re-seal job", /fail closed/i.test(row) && /refused/i.test(row) && /plaintext/i.test(row) && /secret-migration\.ts/.test(row))
  check("PRODUCTION-ARCHITECTURE no longer claims encrypt is a no-op without the key", !/Encrypting is a no-op without it/.test(arch) && !/fail-open on encrypt/.test(arch))
  // the OAuth callbacks refuse BEFORE the exchange and write sealed columns only
  for (const f of ["app/api/social/oauth/[platform]/route.ts", "app/api/integrations/oauth/[provider]/route.ts"]) {
    const src = code(f)
    check(`${f}: refuses before the token exchange when the key is absent, and writes access_token through encryptSecret only`, src.indexOf("!isEncryptionConfigured()") > 0 && src.indexOf("!isEncryptionConfigured()") < src.indexOf("access_token: encryptSecret(") && !/access_token:\s*tokens\.access_token\b/.test(src))
  }
}

function registrationLayer() {
  console.log("\n[REG]")
  const pkg = read("package.json")
  check("package.json wires test:credential-migration", /"test:credential-migration":\s*"tsx scripts\/credential-migration-guard\.ts"/.test(pkg))
  check("the guard chain runs it", new RegExp("npm run test:credential-migration(\\s|&|$)").test(JSON.parse(pkg).scripts.guard ?? ""))
  check("a MAINTENANCE_DOMAINS entry owns it", /proof:\s*"test:credential-migration"/.test(code("lib/kernel/manager-registry.ts")))
}

async function main() {
  const files = [...walk("lib"), ...walk("app")]
  writerLayer(files)
  readerLayer(files)
  await jobLayer()
  tenantLayer()
  doorsLayer()
  registrationLayer()
  console.log("\nBLIND SPOTS: the writer census judges payloads reachable from a literal `.from(\"<store>\")` chain in the same file")
  console.log("  (a store name held in a variable, or a payload built in another module, is not seen); secrets kept INSIDE the")
  console.log("  `config` jsonb (CONFIG_SECRET_KEYS — e.g. the Twilio auth_token under config.auth_token, written by")
  console.log("  phone-connect / tenant-connections / connection-center) are OUTSIDE the four column census and remain plaintext;")
  console.log("  the reader census is file-level (a file that decrypts one read and not another passes); the job is proven")
  console.log("  against an injected store, not the live database (the posture census is the live reading).")
  console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
