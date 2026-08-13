#!/usr/bin/env tsx
/**
 * scripts/transcription-source-guard.ts
 *   (NODE_OPTIONS=--conditions=react-server tsx scripts/transcription-source-guard.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TRANSCRIPT EXISTED AND NOTHING COULD USE IT, AND THE FETCH THAT PRODUCED
 * IT WOULD GO ANYWHERE.
 *
 * `app/actions/ai-voice-transcription.ts:transcribeAudio` has been carried since
 * wave 2 as "recorded, needs an owner decision". The owner has now ruled:
 *
 *     "transcribeaudio is necessary and then added to the contact record, etc to
 *      use later.. which elevenlabs can do or other free options"
 *
 * KEEP IT — and it was missing the half that makes it worth having.
 *
 * ── WHAT IT DID WITH ITS OUTPUT BEFORE ───────────────────────────────────────
 * One `call_transcriptions` row, and the string back to the caller. That row is a
 * LEAF: its only readers are `app/dashboard/isa/page.tsx:213` and
 * `app/dashboard/voice/review/[callId]/page.tsx:117`. Nothing else on the
 * platform could see the transcript, and the surfaces that exist precisely to use
 * one could not:
 *
 *   · `lib/voice/call-analysis.ts:sweepVoiceCallIntelligence` selects candidates
 *     with `.not("transcription", "is", null)` — a `voice_calls` column this
 *     action never touched;
 *   · `call_analyses` — the row the coaching brief, the intelligence dashboards,
 *     `runMeetingFollowthroughForCall` and `composeMeetingRecap` all read;
 *   · `contact_memory` — the per-contact vector recall the drafting rails query
 *     through `lib/ai-isa/brand-voice-prompt.ts`.
 *
 * MEASURED LIVE (transaction, rolled back, `probe_leftovers = 0`): a `voice_calls`
 * row plus the `call_transcriptions` row the OLD behaviour writes leaves the
 * sweep's own candidate query returning **0**, `call_analyses` at **0**, and
 * `contact_memory` at **0**. Stamping `voice_calls.transcription` takes the sweep
 * query to **1**; the memory row comes back through the REAL
 * `contact_memory_recall` RPC at **similarity 1.0000**.
 *
 * ── THE RAILS THIS WAVE WIRED INTO (all three already existed) ───────────────
 *   1. `voice_calls.transcription` — THE one voice-transcript ledger, written
 *      ONLY when empty so the turn loop's live `Caller:`/`AI:` transcript
 *      (app/api/voice/twilio/turn/route.ts) is never overwritten.
 *   2. `lib/voice/call-analysis.ts:analyzeVoiceCallRow` — THE one
 *      conversation-intel extractor, called directly with its own provenance,
 *      exactly as `lib/connections/zoom-transcripts.ts:210-222` does. Directly,
 *      and not left to the hourly sweep, because `isAnalyzableCall` requires a
 *      `Caller:`-prefixed line — a shape the TURN LOOP produces and a recording
 *      transcription does not, so the sweep would skip it forever.
 *   3. `lib/agents/contact-memory.ts:embedContactMemory` — the extended-memory
 *      rail, tenant resolved THROUGH THE CONTACT ROW.
 *
 * ── THE SSRF SURFACE, WHICH THE RULING DOES NOT WAIVE ────────────────────────
 * "Necessary" settles whether the action exists, not that it should fetch
 * arbitrary addresses. `transcribeAudio` was the ONLY `asset-download` call site
 * in the repo taking its URL from the caller; every other one passes a
 * provider-returned or storage-returned URL. `lib/security/audio-source-allowlist.ts`
 * now constrains it to the hosts this system actually produces or stores audio
 * on, each rule naming the code that puts audio there.
 *
 * ── WHAT THIS GUARD STANDS OVER ──────────────────────────────────────────────
 *
 *   T1  THE ALLOWLIST REFUSES WHAT IT MUST, EXECUTED not asserted. The real
 *       function is imported and run against a hostile corpus (link-local
 *       metadata IP, http downgrade, label-boundary collision, suffix-of-a-host
 *       collision, embedded credentials, a non-443 port on an allowed name) and
 *       the derived corpus (this project's Supabase host, Vercel Blob, Twilio,
 *       Zoom).
 *   T2  FAIL-CLOSED ON AN EMPTY RULE SET. An allowlist that degrades to
 *       "everything" when its configuration is missing is the defect it exists
 *       to close.
 *   T3  transcribeAudio ACTUALLY PASSES ONE. A construct check on the real call,
 *       not a substring anywhere in the file.
 *   T4  NO SECOND TRANSCRIPTION EGRESS SURVIVES IN THE ACTION. The inline
 *       Whisper block is gone, not shadowed.
 *   T5  THE PRIMITIVE GATES AND METERS, through the same two functions
 *       `lib/voice/elevenlabs-tts.ts` uses.
 *   T6  THE FAIL-OPEN CONTRACT IS NOT INVERTED. Only a MEASURED
 *       `allowed: false` refuses; `degraded` (an unreadable ledger or tier) must
 *       never block a transcription. This is the assertion that stops a later
 *       "tighten the gate" edit from turning an outage into a refusal.
 *   T7  THE CALL IS CAPPED, and the cap is enforced BEFORE the vendor dispatch.
 *   T8  NO EGRESS HAPPENS ON A REFUSED HOST, executed: `fetch` is stubbed and
 *       counted. A check that runs after the request has already left is not a
 *       check.
 *   T9  THE LEDGER STAMP IS CONDITIONAL AND READS ITS ERROR. supabase-js RESOLVES
 *       a refused update, so a bare await reports a transcript on the call record
 *       that was never written.
 *   T10 THE MEMORY TENANT IS RESOLVED THROUGH THE CONTACT — not the caller's
 *       context and not the call's row. Wave 26's invariant, on a new row.
 *   T11 THE MEMORY KIND IS ONE THE LIVE CHECK ADMITS. Verified live:
 *       `contact_memory_memory_kind_check` refuses `'call_transcript'` with
 *       23514 and accepts `'agent_note'`, and no DDL is available to change that.
 *   T12 ONE TRANSCRIPTION PRIMITIVE. `experimental_transcribe` /
 *       `openai.transcription(` appear in exactly one production module.
 *   T13 THE "use server" WRAPPER DOES NOT EXPOSE THE OPTION BAG. Every export of
 *       a `"use server"` module is an RPC endpoint; the option bag carries the
 *       `brokerageId` that decides whose vendor ledger is billed.
 *
 * Every assertion carries a NEGATIVE CONTROL that writes the defect into the real
 * file, requires the assertion to go RED, restores the file and verifies the
 * restore by sha256. Two SPECIFICITY controls must stay GREEN.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const ACTION = "app/actions/ai-voice-transcription.ts"
const CORE = "lib/repurpose/transcribe-core.ts"
const WRAPPER = "lib/repurpose/transcribe.ts"
const ALLOWLIST = "lib/security/audio-source-allowlist.ts"

/** The LIVE CHECK's admitted set (contact_memory_memory_kind_check), read from
 *  pg_constraint on project hrvaqgvukzxfskkcrwbt. Copied here as a CLOSED SET so
 *  a kind that only exists in someone's head fails here rather than at runtime. */
const ADMITTED_MEMORY_KINDS = new Set([
  "transparency_update", "portal_message", "agent_note", "showing_feedback",
  "persona_signal", "preference", "bba_event", "agent_message",
])

const failures: string[] = []
function check(label: string, ok: boolean, detail = ""): boolean {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`)
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`)
  return ok
}

const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
const sha = (p: string) => createHash("sha256").update(raw(p)).digest("hex")

// ═════════════════════════════════════════════════════════════════════════════
// CONSTRUCT SCANNING — offsets preserved, so "is X before Y" is answerable
// ═════════════════════════════════════════════════════════════════════════════

/** Blank out comment CONTENT while preserving every byte offset, so a claim in a
 *  comment can never satisfy an assertion about code (and a negative control
 *  cannot be defeated by commenting the defect out). */
function blankComments(src: string): string {
  const out = src.split("")
  let i = 0
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
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { out[i] = " "; i++ }
      continue
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2)
      const stop = end === -1 ? src.length : end + 2
      for (let k = i; k < stop; k++) if (src[k] !== "\n") out[k] = " "
      i = stop
      continue
    }
    i++
  }
  return out.join("")
}

/** Skip a string/template literal starting at `start` (which indexes the quote). */
function skipString(src: string, start: number): number {
  const q = src[start]
  let i = start + 1
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue }
    if (q === "`" && src[i] === "$" && src[i + 1] === "{") {
      i = skipBalanced(src, i + 1) + 1
      continue
    }
    if (src[i] === q) return i
    i++
  }
  return src.length - 1
}

/** Given the index of an opening bracket, return the index of its match. */
function skipBalanced(src: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" }
  const closeCh = pairs[src[open]]
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i) + 1; continue }
    if (c === "{" || c === "(" || c === "[") depth++
    else if (c === "}" || c === ")" || c === "]") {
      depth--
      if (depth === 0) return c === closeCh ? i : i
    }
    i++
  }
  return src.length - 1
}

/** Body span of `export async function <name>(` / `function <name>(`. */
function functionBody(src: string, name: string): [number, number] | null {
  const re = new RegExp(`function\\s+${name}\\s*\\(`)
  const m = re.exec(src)
  if (!m) return null
  const paren = src.indexOf("(", m.index)
  const parenEnd = skipBalanced(src, paren)
  const brace = src.indexOf("{", parenEnd)
  if (brace === -1) return null
  return [brace, skipBalanced(src, brace)]
}

/** Top-level keys of the object literal whose `{` is at `open`. */
function topLevelKeys(src: string, open: number): string[] {
  const end = skipBalanced(src, open)
  const keys: string[] = []
  let i = open + 1
  let depth = 0
  let atKeyPosition = true
  while (i < end) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i) + 1; continue }
    if (c === "{" || c === "(" || c === "[") { depth++; i = skipBalanced(src, i) + 1; depth--; atKeyPosition = false; continue }
    if (c === ",") { atKeyPosition = true; i++; continue }
    if (depth === 0 && atKeyPosition && /[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i))
      if (m) {
        let j = i + m[0].length
        while (j < end && /\s/.test(src[j])) j++
        if (src[j] === ":") keys.push(m[0])
        i += m[0].length
        atKeyPosition = false
        continue
      }
    }
    if (!/\s/.test(c)) atKeyPosition = false
    i++
  }
  return keys
}

/** The argument list span of the FIRST `callee(` at or after `from`, bounded by `to`. */
function callArgs(src: string, callee: string, from: number, to: number): [number, number] | null {
  const idx = src.indexOf(`${callee}(`, from)
  if (idx === -1 || idx >= to) return null
  const open = src.indexOf("(", idx)
  return [open, skipBalanced(src, open)]
}

/** Index of the object literal that is the Nth (0-based) top-level argument. */
function argObject(src: string, open: number, close: number, n: number): number | null {
  let i = open + 1
  let arg = 0
  while (i < close) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === ",") { arg++; i++; continue }
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i) + 1; continue }
    if (c === "{" || c === "(" || c === "[") {
      if (arg === n && c === "{") return i
      i = skipBalanced(src, i) + 1
      continue
    }
    i++
  }
  return null
}

// ═════════════════════════════════════════════════════════════════════════════
// LIVE MODULE LOADING — a patched file must be RE-EVALUATED, not served from
// the ESM cache, or a negative control proves nothing about the code it patched.
// ═════════════════════════════════════════════════════════════════════════════
let loadSeq = 0
async function freshImport<T = any>(file: string): Promise<T> {
  loadSeq += 1
  return (await import(`${pathToFileURL(resolve(ROOT, file)).href}?tsg=${loadSeq}`)) as T
}

// ═════════════════════════════════════════════════════════════════════════════
// T1 / T2 — the allowlist, EXECUTED
// ═════════════════════════════════════════════════════════════════════════════

const PROJECT_SUPABASE_URL = "https://hrvaqgvukzxfskkcrwbt.supabase.co"

/** Hosts the derivation says are legitimate — each traced to the code that puts
 *  audio there (see the allowlist module header). */
const MUST_ALLOW: Array<[string, string]> = [
  ["https://hrvaqgvukzxfskkcrwbt.supabase.co/storage/v1/object/public/media/isa-videos/a/1.mp3",
   "Supabase Storage — lib/storage/buckets.ts + lib/providers/dispatch.ts media bucket"],
  ["https://store123.public.blob.vercel-storage.com/letter-audio/b/c.mp3",
   "Vercel Blob — lib/direct-mail/render-letter-audio.ts"],
  ["https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1.mp3",
   "Twilio — the telephony provider voice_calls.recording_url points at"],
  ["https://us02web.zoom.us/rec/download/abc",
   "Zoom — lib/connections/zoom-transcripts.ts already downloads from here"],
]

/** The corpus a host allowlist exists to stop. */
const MUST_REFUSE: Array<[string, string]> = [
  ["https://169.254.169.254/latest/meta-data/iam/security-credentials/", "cloud instance metadata"],
  ["https://10.0.0.5/internal/secrets", "RFC1918 internal address"],
  ["https://localhost/admin", "loopback by name"],
  ["http://hrvaqgvukzxfskkcrwbt.supabase.co/storage/x.mp3", "http downgrade on an allowed name"],
  ["https://evilpublic.blob.vercel-storage.com/x.mp3", "label-boundary collision with the blob suffix rule"],
  ["https://api.twilio.com.evil.test/x.mp3", "allowed host as a PREFIX of an attacker domain"],
  ["https://hrvaqgvukzxfskkcrwbt.supabase.co.evil.test/x.mp3", "project host as a PREFIX of an attacker domain"],
  ["https://notzoom.us/x.mp3", "suffix rule must not match a different registrable name"],
  ["https://user:pw@api.twilio.com/x.mp3", "embedded credentials"],
  ["https://api.twilio.com:9200/_search", "non-443 port on an allowed name"],
  ["https://api.elevenlabs.io/v1/history/x/audio", "the TTS vendor — it returns BYTES, never a URL this system stores"],
]

async function assertAllowlistVerdicts(): Promise<boolean> {
  const m = await freshImport(ALLOWLIST)
  const rules = m.platformAudioHostRules({ NEXT_PUBLIC_SUPABASE_URL: PROJECT_SUPABASE_URL })
  let ok = true
  for (const [url, why] of MUST_ALLOW) {
    const v = m.checkAudioSourceUrl(url, rules)
    if (!v.allowed) {
      ok = false
      failures.push(`allowlist REFUSED a host it derives from real code (${why}): ${url}`)
    }
  }
  for (const [url, why] of MUST_REFUSE) {
    const v = m.checkAudioSourceUrl(url, rules)
    if (v.allowed) {
      ok = false
      failures.push(`allowlist ADMITTED ${why}: ${url}`)
    }
  }
  return ok
}

async function assertAllowlistFailsClosed(): Promise<boolean> {
  const m = await freshImport(ALLOWLIST)
  const empty = m.checkAudioSourceUrl("https://api.twilio.com/x.mp3", [])
  const noEnv = m.platformAudioHostRules({})
  const stillRefusesUnknown = m.checkAudioSourceUrl("https://evil.test/x.mp3", noEnv)
  return (
    !empty.allowed &&
    empty.reason === "no_rules_resolved" &&
    !stillRefusesUnknown.allowed
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// T3 / T4 / T9 / T10 / T11 — the action
// ═════════════════════════════════════════════════════════════════════════════

function transcribeAudioBody(): string {
  const src = blankComments(raw(ACTION))
  const span = functionBody(src, "transcribeAudio")
  if (!span) return ""
  return src.slice(span[0], span[1] + 1)
}

function assertActionPassesAllowlist(): boolean {
  const src = blankComments(raw(ACTION))
  const span = functionBody(src, "transcribeAudio")
  if (!span) return check("T3 transcribeAudio passes a host allowlist", false, "transcribeAudio not found")
  const args = callArgs(src, "transcribeMediaUrl", span[0], span[1])
  if (!args) return check("T3 transcribeAudio passes a host allowlist", false, "no transcribeMediaUrl( call in the body")
  const obj = argObject(src, args[0], args[1], 1)
  if (obj == null) return check("T3 transcribeAudio passes a host allowlist", false, "no options object as the 2nd argument")
  const keys = topLevelKeys(src, obj)
  const hasHosts = keys.includes("allowedHosts")
  const hasTenant = keys.includes("brokerageId")
  return check(
    "T3 transcribeAudio passes a host allowlist AND its tenant to the primitive",
    hasHosts && hasTenant,
    `option keys: ${keys.join(", ") || "(none)"}`,
  )
}

const DIRECT_STT_CONSTRUCTS = ["experimental_transcribe", "openai.transcription("]

function assertNoDirectSttInAction(): boolean {
  const body = blankComments(raw(ACTION))
  const found = DIRECT_STT_CONSTRUCTS.filter((c) => body.includes(c))
  const download = /connector:\s*["']asset-download["']/.test(body)
  return check(
    "T4 the action holds no transcription egress of its own (no inline Whisper, no asset-download)",
    found.length === 0 && !download,
    found.length ? `still present: ${found.join(", ")}` : download ? "still calls asset-download directly" : "",
  )
}

function assertLedgerStampIsConditionalAndChecked(): boolean {
  const body = transcribeAudioBody()
  const upd = body.indexOf('.from("voice_calls")')
  const hasUpdate = upd !== -1 && body.indexOf(".update(", upd) !== -1
  // The stamp must be guarded by an emptiness test on the ledger's CURRENT value.
  const guarded = /if\s*\(\s*!\s*\(\s*voiceCall\.transcription\s*\?\?\s*""\s*\)\.trim\(\)\s*\)/.test(body)
  // …and the refusal must be readable: supabase-js RESOLVES a refused update.
  const destructured = /const\s*\{\s*error:\s*\w+\s*\}\s*=\s*await\s+supabase\s*\n?\s*\.from\("voice_calls"\)/.test(body)
  return check(
    "T9 the voice_calls.transcription stamp is guarded by emptiness AND destructures its error",
    hasUpdate && guarded && destructured,
    `update:${hasUpdate} guarded:${guarded} error-destructured:${destructured}`,
  )
}

function embedMemoryOptions(): { keys: string[]; brokerageValue: string; kind: string } | null {
  const src = blankComments(raw(ACTION))
  const span = functionBody(src, "transcribeAudio")
  if (!span) return null
  const args = callArgs(src, "embedContactMemory", span[0], span[1])
  if (!args) return null
  const obj = argObject(src, args[0], args[1], 0)
  if (obj == null) return null
  const text = src.slice(obj, skipBalanced(src, obj) + 1)
  const brokerage = /brokerageId\s*:\s*([A-Za-z0-9_$.]+)/.exec(text)
  const kind = /memoryKind\s*:\s*"([a-z_]+)"/.exec(text)
  return {
    keys: topLevelKeys(src, obj),
    brokerageValue: brokerage?.[1] ?? "",
    kind: kind?.[1] ?? "",
  }
}

function assertMemoryTenantResolvesThroughTheContact(): boolean {
  const o = embedMemoryOptions()
  if (!o) return check("T10 the contact_memory tenant is resolved THROUGH the contact row", false, "no embedContactMemory( call found")
  const throughContact = o.brokerageValue === "contact.brokerage_id"
  const entityFromContact = /entityId\s*:\s*contact\.id/.test(raw(ACTION))
  return check(
    "T10 the contact_memory tenant is resolved THROUGH the contact row (never the caller's or the call's)",
    throughContact && entityFromContact,
    `brokerageId: ${o.brokerageValue || "(unreadable)"} entityId-from-contact: ${entityFromContact}`,
  )
}

function assertMemoryKindIsAdmittedLive(): boolean {
  const o = embedMemoryOptions()
  if (!o) return check("T11 the memory_kind is one the LIVE CHECK admits", false, "no embedContactMemory( call found")
  return check(
    "T11 the memory_kind is one the LIVE contact_memory_memory_kind_check admits",
    ADMITTED_MEMORY_KINDS.has(o.kind),
    `memoryKind: "${o.kind}" (admitted: ${[...ADMITTED_MEMORY_KINDS].join(", ")})`,
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// T5 / T6 / T7 — the primitive gates, meters, does not invert fail-open, caps
// ═════════════════════════════════════════════════════════════════════════════

function coreBody(): string {
  const src = blankComments(raw(CORE))
  const span = functionBody(src, "transcribeMediaUrl")
  return span ? src.slice(span[0], span[1] + 1) : ""
}

function assertPrimitiveGatesAndMeters(): boolean {
  const src = blankComments(raw(CORE))
  const body = coreBody()
  const importsGate = /await import\("@\/lib\/vendor-governance\/budget-gate"\)/.test(body)
  const callsGate = /checkVendorBudget\(\s*\{[^}]*brokerageId[^}]*addCost/.test(body.replace(/\s+/g, " "))
  const meters = /meterVendorSpend\(\s*\{/.test(body)
  // The ledger entry must name a vendor and a unit, not just fire.
  const meterArgs = (() => {
    const a = callArgs(src, "meterVendorSpend", 0, src.length)
    if (!a) return [] as string[]
    const o = argObject(src, a[0], a[1], 0)
    return o == null ? [] : topLevelKeys(src, o)
  })()
  const meterComplete = ["vendorName", "usageType", "cost", "unitCount", "brokerageId"].every((k) => meterArgs.includes(k))
  return check(
    "T5 the primitive pre-flights checkVendorBudget(addCost) and records meterVendorSpend",
    importsGate && callsGate && meters && meterComplete,
    `gate-import:${importsGate} gate-call:${callsGate} meter:${meters} meter-keys:[${meterArgs.join(",")}]`,
  )
}

function assertFailOpenNotInverted(): boolean {
  const body = coreBody()
  // The ONE refusal condition must be the measured verdict and nothing else.
  const refusals = [...body.matchAll(/if\s*\(([^)]*budget\.[A-Za-z]+[^)]*)\)/g)].map((m) => m[1].trim())
  if (refusals.length === 0) {
    return check("T6 only a MEASURED budget refusal blocks a transcription (fail-open intact)", false, "no budget condition found")
  }
  const onlyAllowed = refusals.every((r) => /^!\s*budget\.allowed$/.test(r))
  return check(
    "T6 only a MEASURED budget refusal blocks a transcription (degraded/degradedTier/degradedSpend never do)",
    onlyAllowed,
    `budget conditions: ${refusals.map((r) => `"${r}"`).join(", ")}`,
  )
}

function assertCappedBeforeTheVendor(): boolean {
  const src = blankComments(raw(CORE))
  const declared = /const\s+MAX_TRANSCRIBE_BYTES\s*=\s*25\s*\*\s*1024\s*\*\s*1024/.test(src)
  const body = coreBody()
  const capAt = body.search(/audioBytes\s*>\s*MAX_TRANSCRIBE_BYTES/)
  const ctAt = body.search(/MEDIA_CT\.test\(contentType\)/)
  const vendorAt = body.search(/transcribeWithScribe\(|transcribeWithWhisper\(/)
  const gateAt = body.search(/checkVendorBudget\(/)
  const ordered = capAt !== -1 && vendorAt !== -1 && capAt < vendorAt && ctAt !== -1 && ctAt < vendorAt && gateAt !== -1 && gateAt < vendorAt
  return check(
    "T7 a 25MB byte cap + a media content-type cap + the budget gate all precede the vendor dispatch",
    declared && ordered,
    `declared:${declared} cap@${capAt} content-type@${ctAt} gate@${gateAt} vendor@${vendorAt}`,
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// T8 — EXECUTED: a refused host must produce ZERO egress
// ═════════════════════════════════════════════════════════════════════════════

const REFUSED_PROBE_HOST = "169.254.169.254"
const ALLOWED_PROBE_HOST = "api.twilio.com"

async function assertNoEgressOnRefusedHost(): Promise<boolean> {
  const core = await freshImport(CORE)
  const allow = await freshImport(ALLOWLIST)
  const rules = allow.platformAudioHostRules({ NEXT_PUBLIC_SUPABASE_URL: PROJECT_SUPABASE_URL })

  // A VENDOR KEY MUST BE PRESENT FOR THIS PROBE TO MEAN ANYTHING. Without one the
  // primitive refuses `not_configured` BEFORE the download, so BOTH arms would
  // report zero fetches and the "allowed host still reaches the gateway" half
  // would pass for the wrong reason — which is exactly how a control comes to
  // lie. (Found by watching this assertion go red on its own first run.) The
  // stub key never reaches a vendor: the fake response below is `text/html`, so
  // the content-type cap stops the flow one step after the download.
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, "ELEVENLABS_API_KEY")
  const priorKey = process.env.ELEVENLABS_API_KEY
  process.env.ELEVENLABS_API_KEY = "guard-stub-never-sent"

  const realFetch = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = (async (input: any) => {
    seen.push(String(typeof input === "string" ? input : input?.url ?? input))
    return new Response("<html>not audio</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })
  }) as typeof fetch

  let refusedHostFetches = -1
  let allowedHostFetches = -1
  let refusedVerdict = ""
  try {
    const refused = await core.transcribeMediaUrl(`https://${REFUSED_PROBE_HOST}/latest/meta-data/`, {
      allowedHosts: rules,
      provider: "elevenlabs",
    })
    refusedVerdict = refused.success ? "success" : String(refused.reason)
    // Counted BY TARGET, not by total: the gateway also fires a best-effort
    // telemetry write, and a stubbed fetch would otherwise count that too.
    refusedHostFetches = seen.filter((u) => u.includes(REFUSED_PROBE_HOST)).length
    await core.transcribeMediaUrl(`https://${ALLOWED_PROBE_HOST}/2010-04-01/Accounts/AC1/Recordings/RE1.mp3`, {
      allowedHosts: rules,
      provider: "elevenlabs",
    })
    allowedHostFetches = seen.filter((u) => u.includes(ALLOWED_PROBE_HOST)).length
  } finally {
    globalThis.fetch = realFetch
    if (hadKey) process.env.ELEVENLABS_API_KEY = priorKey
    else delete process.env.ELEVENLABS_API_KEY
  }

  return check(
    "T8 a refused host produces ZERO outbound requests, while an allowed host does reach the gateway",
    refusedHostFetches === 0 && allowedHostFetches >= 1 && refusedVerdict === "host_not_allowed",
    `refused-host fetches: ${refusedHostFetches} (must be 0, verdict "${refusedVerdict}"), allowed-host fetches: ${allowedHostFetches} (must be ≥1)`,
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// T12 / T13 — one primitive, and no RPC widening
// ═════════════════════════════════════════════════════════════════════════════

import { readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

function* walk(dir: string): Generator<string> {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const n of entries) {
    if (n === "node_modules" || n === ".next" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.tsx?$/.test(n)) yield relative(ROOT, p).replace(/\\/g, "/")
  }
}

function productionFilesCalling(construct: string): string[] {
  const hits: string[] = []
  for (const dir of ["app", "lib"]) {
    for (const f of walk(join(ROOT, dir))) {
      if (blankComments(raw(f)).includes(construct)) hits.push(f)
    }
  }
  return hits.sort()
}

function assertOneTranscriptionPrimitive(): boolean {
  const all = new Set<string>()
  for (const c of DIRECT_STT_CONSTRUCTS) for (const f of productionFilesCalling(c)) all.add(f)
  const files = [...all].sort()
  return check(
    "T12 exactly ONE production module holds a speech-to-text vendor call",
    files.length === 1 && files[0] === CORE,
    `files: ${files.join(", ") || "(none)"}`,
  )
}

function assertWrapperKeepsOneArgument(): boolean {
  const src = blankComments(raw(WRAPPER))
  const useServer = /^\s*["']use server["']/m.test(src.split("\n").slice(0, 3).join("\n"))
  const m = /export\s+async\s+function\s+transcribeFromUrl\s*\(/.exec(src)
  if (!useServer || !m) {
    return check("T13 the \"use server\" wrapper exposes no option bag", false, `use-server:${useServer} export-found:${!!m}`)
  }
  const open = src.indexOf("(", m.index)
  const params = src.slice(open + 1, skipBalanced(src, open))
  const count = params.trim() === "" ? 0 : params.split(",").filter((s) => s.trim()).length
  return check(
    "T13 the \"use server\" wrapper takes ONE argument — the option bag (with its brokerageId) is not an RPC surface",
    count === 1,
    `transcribeFromUrl parameters: ${count} (${params.trim()})`,
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// CONTROLS
// ═════════════════════════════════════════════════════════════════════════════

interface Control { file: string; find: string; replace: string }

/** Apply a patch, VERIFY IT CHANGED THE FILE, run `fn`, require RED, restore,
 *  verify the restore by sha256. A control whose find-string no longer matches is
 *  a FAILURE, not a pass — it proves nothing about the code it meant to break. */
async function controlled(label: string, c: Control, fn: () => boolean | Promise<boolean>): Promise<void> {
  const before = raw(c.file)
  const beforeSha = sha(c.file)
  const after = before.replace(c.find, c.replace)
  if (after === before) {
    console.log(`  ✗ NEGATIVE CONTROL ${label} — PATCH DID NOT APPLY (find-string not found); control proves nothing`)
    failures.push(`negative control did not apply: ${label}`)
    return
  }
  writeFileSync(resolve(ROOT, c.file), after)
  let wentRed = false
  try {
    const marker = failures.length
    const ok = await fn()
    wentRed = !ok || failures.length > marker
    while (failures.length > marker) failures.pop()
  } finally {
    writeFileSync(resolve(ROOT, c.file), before)
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
  const before = raw(c.file)
  const beforeSha = sha(c.file)
  const after = before.replace(c.find, c.replace)
  if (after === before) {
    console.log(`  ✗ SPECIFICITY CONTROL ${label} — PATCH DID NOT APPLY`)
    failures.push(`specificity control did not apply: ${label}`)
    return
  }
  writeFileSync(resolve(ROOT, c.file), after)
  let stillGreen = false
  try {
    const marker = failures.length
    const ok = await fn()
    stillGreen = ok && failures.length === marker
    while (failures.length > marker) failures.pop()
  } finally {
    writeFileSync(resolve(ROOT, c.file), before)
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

async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" transcribeAudio — the transcript reaches the contact, and the")
  console.log(" fetch that produced it cannot go anywhere it likes")
  console.log("══════════════════════════════════════════════════════════════\n")

  console.log("ASSERTIONS")
  check("T1 the allowlist admits every derived host and refuses the hostile corpus", await assertAllowlistVerdicts())
  check("T2 the allowlist FAILS CLOSED when no rule resolves", await assertAllowlistFailsClosed())
  assertActionPassesAllowlist()
  assertNoDirectSttInAction()
  assertPrimitiveGatesAndMeters()
  assertFailOpenNotInverted()
  assertCappedBeforeTheVendor()
  await assertNoEgressOnRefusedHost()
  assertLedgerStampIsConditionalAndChecked()
  assertMemoryTenantResolvesThroughTheContact()
  assertMemoryKindIsAdmittedLive()
  assertOneTranscriptionPrimitive()
  assertWrapperKeepsOneArgument()

  if (RUN_NEGATIVE) {
    console.log("\nNEGATIVE CONTROLS (each must go RED)")

    // C1: the suffix rule stops matching on a label boundary, so
    //     `evilpublic.blob.vercel-storage.com` satisfies the Vercel Blob rule.
    await controlled(
      "the blob suffix rule matches on a bare endsWith (label boundary lost)",
      {
        file: ALLOWLIST,
        find: "return host === s || host.endsWith(`.${s}`)",
        replace: "return host.endsWith(s)",
      },
      assertAllowlistVerdicts,
    )

    // C2: the http downgrade is admitted — the scheme an SSRF probe reaches
    //     internal services on.
    await controlled(
      "plain http is admitted on an allowed host name",
      {
        file: ALLOWLIST,
        find: 'if (parsed.protocol !== "https:") {',
        replace: 'if (false && parsed.protocol !== "https:") {',
      },
      assertAllowlistVerdicts,
    )

    // C3: a non-443 port on an allowed name — the right hostname pointed at a
    //     different service.
    await controlled(
      "a non-443 port on an allowed host is admitted",
      {
        file: ALLOWLIST,
        find: 'if (parsed.port && parsed.port !== "443") {',
        replace: 'if (false) {',
      },
      assertAllowlistVerdicts,
    )

    // C4: the empty rule set degrades to "allow everything" — the exact failure
    //     mode an allowlist exists to prevent.
    await controlled(
      "an empty rule set degrades to allow-everything instead of refusing",
      {
        file: ALLOWLIST,
        find: "  if (rules.length === 0) {\n    return {\n      allowed: false,\n      reason: \"no_rules_resolved\",",
        replace: "  if (rules.length === 0) {\n    return {\n      allowed: true as any,\n      reason: \"no_rules_resolved\",",
      },
      assertAllowlistFailsClosed,
    )

    // C5: the action stops passing the allowlist — back to an arbitrary
    //     server-side fetch for any authenticated caller.
    await controlled(
      "transcribeAudio stops passing allowedHosts to the primitive",
      {
        file: ACTION,
        find: "      allowedHosts: platformAudioHostRules(),\n",
        replace: "",
      },
      assertActionPassesAllowlist,
    )

    // C6: the action stops passing its tenant, so the budget gate and the vendor
    //     ledger both go dark while every other line still looks right.
    await controlled(
      "transcribeAudio stops passing brokerageId (gate + ledger silently disengage)",
      {
        file: ACTION,
        find: "      brokerageId: voiceCall.brokerage_id,\n",
        replace: "",
      },
      assertActionPassesAllowlist,
    )

    // C7: an inline Whisper call comes back to the action — the second lane
    //     that put the two copies out of step in the first place.
    await controlled(
      "an inline Whisper transcription reappears in the action",
      {
        file: ACTION,
        find: "    const transcriptText = spoken.transcript",
        replace:
          "    const { experimental_transcribe } = await import(\"ai\")\n" +
          "    const transcriptText = spoken.transcript",
      },
      assertNoDirectSttInAction,
    )

    // C8: the budget gate is removed while the metering stays — the shape that
    //     bills accurately for spend nobody was allowed to make.
    await controlled(
      "the vendor budget pre-flight is removed (metering left in place)",
      {
        file: CORE,
        find: "      const budget = await checkVendorBudget({ brokerageId: options.brokerageId, addCost: estimatedCost })",
        replace: "      const budget = { allowed: true }",
      },
      assertPrimitiveGatesAndMeters,
    )

    // C9: THE INVERSION. `degraded` means "we could not read the ledger or the
    //     tier", and the whole contract is that it does NOT block. Refusing on it
    //     turns one unreadable read into a customer-visible outage.
    await controlled(
      "the gate starts refusing on `degraded` — the fail-open contract inverted",
      {
        file: CORE,
        find: "      if (!budget.allowed) {",
        replace: "      if (!budget.allowed || budget.degraded) {",
      },
      assertFailOpenNotInverted,
    )

    // C10: the byte cap is removed — an uncapped transcription is an uncapped
    //      bill, and the cap is the only bound on it before the vendor answers.
    await controlled(
      "the 25MB byte cap is removed",
      {
        file: CORE,
        find: "    if (audioBytes > MAX_TRANSCRIBE_BYTES) {",
        replace: "    if (false) {",
      },
      assertCappedBeforeTheVendor,
    )

    // C11: the content-type cap is removed, so an HTML page is billed as audio.
    await controlled(
      "the media content-type cap is removed (an HTML page becomes billable audio)",
      {
        file: CORE,
        find: "    if (!MEDIA_CT.test(contentType)) {",
        replace: "    if (false) {",
      },
      assertCappedBeforeTheVendor,
    )

    // C12: the allowlist check is neutered, so the refusal happens — if at all —
    //      AFTER the request has already left. Caught by counting real fetches,
    //      not by reading the source.
    await controlled(
      "the allowlist branch is skipped, so the request leaves before anything is checked",
      {
        file: CORE,
        find: "  if (options.allowedHosts) {",
        replace: "  if (false && options.allowedHosts) {",
      },
      assertNoEgressOnRefusedHost,
    )

    // C13: the ledger stamp stops reading its error. supabase-js RESOLVES a
    //      refused update, so this reports a transcript that was never written.
    await controlled(
      "the voice_calls.transcription stamp stops destructuring its error",
      {
        file: ACTION,
        find: "      const { error: ledgerErr } = await supabase\n        .from(\"voice_calls\")",
        replace: "      const ledgerErr = null; await supabase\n        .from(\"voice_calls\")",
      },
      assertLedgerStampIsConditionalAndChecked,
    )

    // C14: the emptiness guard goes, so a post-hoc recording transcription
    //      overwrites the turn loop's live conversation transcript.
    await controlled(
      "the emptiness guard goes, so the live turn transcript is overwritten",
      {
        file: ACTION,
        find: '    if (!(voiceCall.transcription ?? "").trim()) {',
        replace: "    if (true) {",
      },
      assertLedgerStampIsConditionalAndChecked,
    )

    // C15: the memory row carries the CALL's tenant instead of the CONTACT's.
    //      They coincide under the tenancy invariant and diverge exactly when it
    //      is broken — which is the case the stamp exists for. Wave 26's rule.
    await controlled(
      "the contact_memory row is stamped with the CALL's tenant rather than the CONTACT's",
      {
        file: ACTION,
        find: "          brokerageId: contact.brokerage_id,",
        replace: "          brokerageId: voiceCall.brokerage_id,",
      },
      assertMemoryTenantResolvesThroughTheContact,
    )

    // C16: a memory_kind the LIVE CHECK refuses (23514). The row would be
    //      rejected by the database and — since embedContactMemory returns
    //      {ok:false} rather than throwing — reported as a skipped memory.
    await controlled(
      "the memory_kind becomes a value the live CHECK refuses",
      {
        file: ACTION,
        find: '          memoryKind: "agent_note",',
        replace: '          memoryKind: "call_transcript",',
      },
      assertMemoryKindIsAdmittedLive,
    )

    // C17: a second speech-to-text call site appears in production code — the
    //      exact drift this wave collapsed.
    await controlled(
      "a second speech-to-text call site appears in a production module",
      {
        file: "lib/voice/elevenlabs-tts.ts",
        find: "export async function synthesizeSpeech(",
        replace:
          "async function transcribeSomewhereElse(bytes: Uint8Array) {\n" +
          "  const { experimental_transcribe } = await import(\"ai\")\n" +
          "  return experimental_transcribe({ model: null as any, audio: bytes })\n" +
          "}\n\n" +
          "export async function synthesizeSpeech(",
      },
      assertOneTranscriptionPrimitive,
    )

    // C18: the "use server" wrapper grows the option bag, handing every
    //      authenticated session the brokerageId that decides whose ledger pays.
    await controlled(
      "the \"use server\" wrapper grows an options parameter (brokerageId becomes browser-reachable)",
      {
        file: WRAPPER,
        find: "export async function transcribeFromUrl(url: string): Promise<TranscribeResult> {",
        replace:
          "export async function transcribeFromUrl(url: string, options: Record<string, unknown> = {}): Promise<TranscribeResult> {",
      },
      assertWrapperKeepsOneArgument,
    )

    console.log("\nSPECIFICITY CONTROLS (each must stay GREEN)")

    // S1: the STATEMENT-LEVEL control. The same call, split across more lines and
    //     reordered keys. A line-oriented scan anchored on "the line after the
    //     call" sails past this; the construct scan must still find both options.
    await specificity(
      "the transcribeMediaUrl call is reformatted across lines with reordered keys",
      {
        file: ACTION,
        find: "      allowedHosts: platformAudioHostRules(),\n      brokerageId: voiceCall.brokerage_id,",
        replace:
          "      brokerageId:\n        voiceCall.brokerage_id,\n\n      allowedHosts:\n        platformAudioHostRules(),",
      },
      assertActionPassesAllowlist,
    )

    // S2: the SCOPE control. T12 scans app/ + lib/ only, because scripts/ carries
    //     defective constructs as STRING FIXTURES — this very file names
    //     `experimental_transcribe` in its own control payloads. The identical
    //     text added under scripts/ must stay GREEN.
    await specificity(
      "a speech-to-text construct added under scripts/ is NOT a production call site",
      {
        file: "scripts/transcription-source-guard.ts",
        find: "const ROOT = process.cwd()",
        replace:
          "const ROOT = process.cwd()\n" +
          "// S2 fixture: experimental_transcribe / openai.transcription( as literal text",
      },
      assertOneTranscriptionPrimitive,
    )

    // S3: comments must not satisfy an assertion. Adding a COMMENT that names the
    //     option keys, while the real ones stay, must not change the verdict —
    //     and (paired with C5, which deletes the real key and goes RED) this is
    //     what shows the scan reads code rather than prose.
    await specificity(
      "a comment naming allowedHosts/brokerageId does not by itself satisfy the assertion",
      {
        file: ACTION,
        find: "    const spoken = await transcribeMediaUrl(params.audioUrl, {",
        replace:
          "    // allowedHosts: platformAudioHostRules(), brokerageId: voiceCall.brokerage_id\n" +
          "    const spoken = await transcribeMediaUrl(params.audioUrl, {",
      },
      assertActionPassesAllowlist,
    )
  }

  console.log("")
  if (failures.length) {
    console.log(`FAILED (${failures.length})`)
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log("PASSED")
}

main()
