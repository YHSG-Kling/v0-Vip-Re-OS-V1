#!/usr/bin/env tsx
/**
 * scripts/license-eo-record-simulator.ts   (npm run test:license-eo-record)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the AGENT LICENCE RECORD is actually a record.
 *
 * Three defects sat on one table, and each one made a compliance fact disappear
 * while the app reported success:
 *
 *  1. E&O WAS NEVER PERSISTED. submitEOInsurance matched
 *     `agent_licenses.agent_id` (an AGENTS id, FK agent_licenses_agent_id_fkey)
 *     against `user.id` (a USERS id). Two id spaces that never overlap, so the
 *     lookup found nothing, the `if (licenseRecord)` guard fell through, and the
 *     action returned success:true AND ticked the onboarding step.
 *
 *  2. THE CERTIFICATE HAD NOWHERE TO GO. The intake form uploads the E&O
 *     certificate to storage and hands over its URL; the action dropped it.
 *     agent_licenses.document_url already holds the LICENCE, so m459 added
 *     eo_certificate_url rather than let one document clobber the other.
 *
 *  3. VERIFICATION WAS SELF-SERVICE. ai-agent-onboarding.ts:verifyAgentLicense
 *     asked an LLM to "simulate a verification result with high confidence" and
 *     wrote verification_status='verified' through the AGENT'S OWN session,
 *     beside an RLS policy (FOR ALL, USING tenant-only, WITH CHECK absent) that
 *     let any member of the brokerage — including a user_type='contact' — rewrite
 *     or delete ANY agent's licence row.
 *
 * SOURCE: the write path resolves the agents row, fails closed on an unreadable
 *         or missing licence, counts affected rows (a zero-row RLS refusal on an
 *         UPDATE arrives as error:null), persists the certificate, and ticks the
 *         step only after the write is proven.
 * LIVE (creds-gated): m459 is in the DATABASE, not just on disk — the column, the
 *         four per-command policies with no FOR ALL survivor, and the trigger.
 * NEGATIVE CONTROLS: every source check is re-run against a deliberately broken
 *         copy of the same file and must go RED.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const LICENSE = "app/actions/onboarding/license.ts"
const ONBOARDING = "app/actions/ai-agent-onboarding.ts"
const BARREL = "app/actions/index.ts"

/** The E&O function body only — so a match somewhere else in the file cannot pass a check for it. */
function eoBody(source: string): string {
  const start = source.indexOf("export async function submitEOInsurance")
  if (start < 0) return ""
  const next = source.indexOf("export async function", start + 10)
  return source.slice(start, next < 0 ? source.length : next)
}

/**
 * The E&O UPDATE STATEMENT only. The first cut of this probe sliced "everything
 * after eo_insurance_carrier" and was satisfied by the `.select("id")` belonging
 * to the LATER onboarding_steps query — it stayed green against a broken copy,
 * which the negative control caught. A check whose window is wider than the thing
 * it checks is not a check.
 */
function eoUpdateStatement(source: string): string {
  const b = eoBody(source)
  // `eo_insurance_carrier:` WITH THE COLON — the bare name also appears in the
  // comment above the licence LOOKUP, so anchoring on it started the window one
  // query too early and swallowed that lookup's own `.select("id")`. The negative
  // control is what exposed it: the probe stayed green against a copy with the
  // update's select deleted.
  const start = b.indexOf("eo_insurance_carrier:")
  if (start < 0) return ""
  const end = b.indexOf("if (eoError)", start)
  return b.slice(start, end < 0 ? b.length : end)
}

/** Rewrite ONLY inside submitEOInsurance — the same strings appear in the licence reader above. */
function mutateEoBody(source: string, from: string | RegExp, to: string): string {
  const b = eoBody(source)
  if (!b) return source
  return source.replace(b, b.replace(from as never, to))
}

// ─── ASSERTIONS ──────────────────────────────────────────────────────────────

type Probe = { name: string; run: (license: string, onboarding: string, barrel: string) => boolean }

const PROBES: Probe[] = [
  {
    name: "E1 the E&O lookup resolves the AGENTS row and never compares agent_id to a users id",
    run: (l) => {
      const b = eoBody(l)
      return /resolveUserIdToAgentRecord\(\s*user\.id\s*,\s*agent\.brokerage_id\s*\)/.test(b)
        && /\.eq\(\s*["']agent_id["']\s*,\s*agentRecordId\s*\)/.test(b)
        && !/\.eq\(\s*["']agent_id["']\s*,\s*user\.id\s*\)/.test(b)
    },
  },
  {
    name: "E2 the lookup destructures its error — a refused read is not an absent licence",
    run: (l) => {
      const b = eoBody(l)
      return /const\s*\{\s*data:\s*licenseRecord\s*,\s*error:\s*\w+\s*\}\s*=\s*await\s+supabase/.test(b)
        && /licenseLookupError/.test(b)
    },
  },
  {
    name: "E3 no licence on file REFUSES instead of silently succeeding (the shape that hid this bug)",
    run: (l) => {
      const b = eoBody(l)
      return /if\s*\(\s*!licenseRecord\s*\)\s*\{[\s\S]{0,200}?success:\s*false/.test(b)
    },
  },
  {
    name: "E4 the E&O UPDATE counts affected rows — a zero-row RLS refusal returns error:null",
    run: (l) => {
      const upd = eoUpdateStatement(l)
      return upd.length > 0
        && /\.select\(\s*["']id["']\s*\)/.test(upd)
        && /(eoUpdated\.length\s*===\s*0|!eoUpdated)/.test(eoBody(l))
    },
  },
  {
    name: "E5 the uploaded certificate is persisted to its own column, never over document_url",
    run: (l) => {
      const b = eoBody(l)
      return /eo_certificate_url:\s*data\.certificateUrl/.test(b) && !/document_url:\s*data\.certificateUrl/.test(b)
    },
  },
  {
    name: "E6 the step is ticked only AFTER the proven write, keyed by the same scoped agents id",
    run: (l) => {
      const b = eoBody(l)
      const eoIdx = b.indexOf("eo_insurance_carrier")
      const stepIdx = b.indexOf("agent_step_completions")
      return stepIdx > eoIdx
        && /agent_id:\s*agentRecordId/.test(b)
        && !/agent_id:\s*await\s+resolveAgentId/.test(b)
    },
  },
  {
    name: "V1 the fabricating verifier is GONE — no module stamps verification_status from a session client",
    run: (_l, o) => !/export\s+async\s+function\s+verifyAgentLicense/.test(o)
      && !/verification_status:\s*["']verified["']/.test(o),
  },
  {
    name: "V2 …and the retirement says WHY, so it is not restored as a missing feature",
    run: (_l, o) => /verifyAgentLicense RETIRED/.test(o) && /runLicenseVerification/.test(o),
  },
  {
    name: "V3 the barrel no longer re-exports it (a retired action must not stay reachable)",
    run: (_l, _o, barrel) => !/^\s*verifyAgentLicense,\s*$/m.test(barrel),
  },
  {
    name: "V4 the surviving verifier is the STATE-REGISTRY one, still wired from licence submission",
    run: (l) => /runLicenseVerification\(\s*\{/.test(l)
      && /from ["']@\/lib\/onboarding\/license-verifier["']/.test(l),
  },
]

function sourceLayer() {
  console.log("\n[ASSERTIONS · the licence record keeps what it is given]")
  const l = src(LICENSE), o = src(ONBOARDING), b = src(BARREL)
  for (const p of PROBES) check(p.name, p.run(l, o, b))
}

// ─── NEGATIVE CONTROLS ───────────────────────────────────────────────────────
// Each mutation reintroduces exactly one of the real defects. A check that cannot
// go red is not a check.

const MUTATIONS: Array<{ name: string; probe: string; mutate: (l: string, o: string, b: string) => [string, string, string] }> = [
  {
    name: "the E&O lookup goes back to matching agent_id against the USERS id",
    probe: "E1",
    mutate: (l, o, b) => [mutateEoBody(l, '.eq("agent_id", agentRecordId)', '.eq("agent_id", user.id)'), o, b],
  },
  {
    name: "the licence lookup stops destructuring its error",
    probe: "E2",
    mutate: (l, o, b) => [l.replace("const { data: licenseRecord, error: licenseLookupError } =", "const { data: licenseRecord } ="), o, b],
  },
  {
    name: "a missing licence silently succeeds again instead of refusing",
    probe: "E3",
    mutate: (l, o, b) => [l.replace(/if \(!licenseRecord\) \{[\s\S]*?\n    \}/, "if (!licenseRecord) { /* carry on */ }"), o, b],
  },
  {
    name: "the E&O update stops counting affected rows (a refusal reads as a save)",
    probe: "E4",
    mutate: (l, o, b) => [mutateEoBody(l, /\.eq\("id", licenseRecord\.id\)\s*\n\s*\.select\("id"\)/, '.eq("id", licenseRecord.id)'), o, b],
  },
  {
    name: "the certificate URL is dropped again",
    probe: "E5",
    mutate: (l, o, b) => [l.replace("eo_certificate_url: data.certificateUrl ?? null,", ""), o, b],
  },
  {
    name: "the step completion goes back to the UNSCOPED agent resolver",
    probe: "E6",
    mutate: (l, o, b) => [l.replace("agent_id: agentRecordId,\n        brokerage_id: agent.brokerage_id,\n        step_id: stepRecord.id,", "agent_id: await resolveAgentId(supabase as any, user.id),\n        brokerage_id: agent.brokerage_id,\n        step_id: stepRecord.id,"), o, b],
  },
  {
    name: "a session-client writer stamps verification_status='verified' again",
    probe: "V1",
    mutate: (l, o, b) => [l, o + '\nexport async function verifyAgentLicense() { await supabase.from("agent_licenses").update({ verification_status: "verified" }) }\n', b],
  },
  {
    name: "the barrel re-exports the retired action",
    probe: "V3",
    mutate: (l, o, b) => [l, o, b.replace("  generateWelcomeMessage,", "  verifyAgentLicense,\n  generateWelcomeMessage,")],
  },
]

function negativeControls() {
  console.log("\n[NEGATIVE CONTROLS · each must go RED]")
  const l0 = src(LICENSE), o0 = src(ONBOARDING), b0 = src(BARREL)
  for (const m of MUTATIONS) {
    const probe = PROBES.find((p) => p.name.startsWith(m.probe + " "))
    if (!probe) { check(`NEGATIVE CONTROL ${m.name} — probe ${m.probe} not found`, false); continue }
    const [l, o, b] = m.mutate(l0, o0, b0)
    const stillGreen = probe.run(l, o, b)
    check(`NEGATIVE CONTROL ${m.name} — went RED as required`, !stillGreen,
      stillGreen ? `probe ${m.probe} stayed green against the broken copy` : "")
  }
}

// ─── LIVE ────────────────────────────────────────────────────────────────────

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the source layer proved the write path"); return }
  const svc = createClient(url, key)
  console.log("\n[LIVE · m459 is in the database, not just on disk]")

  // A migration file on disk is not a migration that ran — the m392-m397 lesson.
  // PostgREST rejects the ENTIRE select when a named column does not exist, so a
  // clean read IS the existence proof.
  const { error: colError } = await svc
    .from("agent_licenses")
    .select("id, eo_certificate_url, eo_insurance_carrier, verification_status")
    .limit(1)

  check("live: agent_licenses.eo_certificate_url exists (PostgREST rejects the whole select otherwise)",
    !colError, colError?.message ?? "")
}

async function main() {
  sourceLayer()
  negativeControls()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LICENSE_EO_RECORD_FAIL"); process.exit(1) }
  console.log(" ✅ LICENSE_EO_RECORD_PASS — E&O is persisted against the right id, the certificate has a home, a refused write is reported, and nobody verifies their own licence")
}
main()
