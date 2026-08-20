#!/usr/bin/env tsx
/**
 * scripts/video-script-compliance-guard.ts  (npm run test:video-script-compliance)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PRIVATE GATE. Seven functions in this repo are named generateVideoScript.
 * Exactly one of them — app/actions/video/generate-script.ts, behind the
 * /dashboard/videos/create wizard — enforced brand voice, ThemFirst, and Fair
 * Housing. It wrote those rules out inline, so no other generator could reuse
 * them. The other four reachable generators produced agent-facing marketing
 * copy with no Fair Housing check at all:
 *
 *   app/actions/video-generation.ts   → /video-assistant, agent superpowers panel
 *   app/actions/link-to-video.ts      → /content-studio
 *   lib/kernel/video.ts               → the script that actually gets rendered
 *   lib/content-generation/           → EducationEditor, via the engine action
 *     content-generator.ts              app/actions/content-generation-engine.ts
 *
 * That fifth path was nearly missed: it is imported through the barrel
 * @/lib/content-generation, so resolving import specifiers to file paths does
 * not find it. Re-exports hide callers — check the barrel, not just the module.
 *
 * The gate now lives in lib/video/script-compliance.ts and all five call it.
 * This guard is what stops it drifting back into one file's private business.
 *
 * THE SILENT AUDIT. Nine call sites passed evaluateOutbound a stub contact with
 * a non-uuid id ("broadcast", "contextual_draft_target", "broadcast_persona_hook").
 * contacts.id and compliance_events.entity_id are both uuid, so BOTH the contact
 * re-fetch and the compliance_events INSERT failed with 22P02 — silently, since
 * neither destructures `error`. The gates still blocked correctly, but every
 * evaluation went unrecorded, and COMPLIANCE_VIOLATION never fired because that
 * notification is guarded on the audit insert having succeeded. Verified against
 * the live database, not inferred.
 *
 * EvaluateOutboundParams documents `contact` as optional precisely for broadcast
 * payloads, so omitting it is what the stubs were trying to express. Every stub
 * set tcpa_consent true / dnc false / no status and used only social or email,
 * so Gates 2 and 3 contributed nothing — omitting the contact is
 * violation-identical and makes the audit write succeed.
 *
 * ASSERTS THE CONSTRUCT, NOT THE SPELLING. Each check is written so that
 * gutting the branch fails it — a bare token-presence check would keep passing
 * on the function's own import line or a comment mentioning it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")

const failures: string[] = []
const passes: string[] = []

function check(id: string, ok: boolean, detail: string) {
  if (ok) passes.push(id)
  else failures.push(`${id}: ${detail}`)
}

// ── 1. The shared gate exists and exports the three pieces ───────────────────

const gate = stripComments(read("lib/video/script-compliance.ts"))

check(
  "GATE-EXPORTS-THREE",
  /export\s+async\s+function\s+buildComplianceSystemBlocks\s*\(/.test(gate) &&
    /export\s+async\s+function\s+precheckBriefForFairHousing\s*\(/.test(gate) &&
    /export\s+async\s+function\s+postcheckScript\s*\(/.test(gate),
  "lib/video/script-compliance.ts must export buildComplianceSystemBlocks, precheckBriefForFairHousing, postcheckScript",
)

// Assert the constructs, not the spellings: a bare /brand_voice_profile/ test
// still matches "brand_voice_profileGUTTED", so it cannot detect the table
// being repointed. Require the declarations and the actual .from() target.
check(
  "GATE-CARRIES-ALL-THREE-BLOCKS",
  /\bconst\s+THEM_FIRST_BLOCK\s*=/.test(gate) &&
    /\bconst\s+FAIR_HOUSING_BLOCK\s*=/.test(gate) &&
    /\.from\(\s*["']brand_voice_profile["']\s*\)/.test(gate),
  "the shared gate must carry brand voice, ThemFirst and Fair Housing — not a subset",
)

// A failed brand-voice read must not read as "no brand voice configured".
check(
  "GATE-BRAND-VOICE-CHECKS-ERROR",
  /const\s*\{\s*data:\s*bvp,\s*error\s*\}/.test(gate) && /if\s*\(\s*error\s*\|\|\s*!bvp\s*\)/.test(gate),
  "loadBrandVoiceBlock must destructure `error` and branch on it — supabase-js resolves a refused read",
)

// The pre-check blocks on Fair Housing ONLY. If it ever blocks on the whole
// violation list, an agent's shorthand brief gets refused for ThemFirst.
check(
  "GATE-PRECHECK-FAIR-HOUSING-ONLY",
  /startsWith\(\s*["']FairHousing:["']\s*\)/.test(gate),
  "precheckBriefForFairHousing must filter to FairHousing: violations before blocking",
)

// ── 2. Every reachable generator calls the shared gate ───────────────────────

const GENERATORS: Array<{ id: string; file: string; needs: string[] }> = [
  {
    id: "WIZARD",
    file: "app/actions/video/generate-script.ts",
    needs: ["buildComplianceSystemBlocks", "precheckBriefForFairHousing", "postcheckScript"],
  },
  {
    id: "VIDEO-GENERATION",
    file: "app/actions/video-generation.ts",
    needs: ["buildComplianceSystemBlocks", "precheckBriefForFairHousing", "postcheckScript"],
  },
  {
    id: "LINK-TO-VIDEO",
    file: "app/actions/link-to-video.ts",
    needs: ["buildComplianceSystemBlocks", "postcheckScript"],
  },
  {
    id: "KERNEL-VIDEO",
    file: "lib/kernel/video.ts",
    needs: ["buildComplianceSystemBlocks", "postcheckScript"],
  },
  {
    // The gate sits in the action, not in the pure generator, because that is
    // where the authenticated actor already resolves.
    id: "CONTENT-ENGINE",
    file: "app/actions/content-generation-engine.ts",
    needs: ["buildComplianceSystemBlocks", "precheckBriefForFairHousing", "postcheckScript"],
  },
]

for (const g of GENERATORS) {
  const src = stripComments(read(g.file))
  for (const fn of g.needs) {
    // `await fn(` — the CALL, not the import specifier and not a mention.
    const called = new RegExp(String.raw`await\s+${fn}\s*\(`).test(src)
    check(`${g.id}-CALLS-${fn}`, called, `${g.file} must await ${fn}(...)`)
  }
}

// The wizard must no longer own a private copy of the rule text — that is the
// drift this whole task was about.
const wizard = stripComments(read("app/actions/video/generate-script.ts"))
check(
  "WIZARD-HAS-NO-PRIVATE-COPY",
  !/ThemFirst communication philosophy/.test(wizard) &&
    !/Fair Housing compliance \(Gate 4/.test(wizard),
  "app/actions/video/generate-script.ts must not re-declare the ThemFirst/Fair Housing block text",
)

// The engine's own header used to say "no publishing/approval/compliance".
// A file that runs a compliance gate must not describe itself as ungated.
const engine = read("app/actions/content-generation-engine.ts")
check(
  "CONTENT-ENGINE-HEADER-HONEST",
  !/Draft-only, no publishing\/approval\/compliance/.test(engine),
  "content-generation-engine.ts header still claims it runs no compliance, but the video lane now does",
)

// ── 3. No evaluateOutbound call passes a non-uuid contact id ─────────────────
// This is the audit-row killer. Any string literal id that is not a uuid
// expression means the compliance_events INSERT will 22P02 and be swallowed.

const CALLERS = [
  "app/actions/social/generate-social-post.ts",
  "app/actions/ai-newsletter.ts",
  "app/actions/blog.ts",
  "app/actions/social-media-automation.ts",
  "lib/video/persona-variant-post-pass.ts",
  "lib/video/script-compliance.ts",
  // app/actions/video/generate-script.ts is deliberately absent: it no longer
  // calls evaluateOutbound directly, it delegates to the shared gate above.
  // Listing it here would assert nothing.
  //
  // app/actions/video/create-video-project.ts left for the SAME reason, and it
  // is worth naming because it was listed here and PASSING while asserting
  // nothing. Its only two `evaluateOutbound` mentions are inside the tombstone
  // comment describing the fail-open call it USED to make; this loop strips
  // comments first, so evaluateOutboundArgs() returned an empty list and the
  // per-caller check was vacuously true. A caller list is only a check while
  // every file on it still calls the thing — a name that stops calling has to
  // come off, or the list quietly turns into decoration.
]

/**
 * Extract each evaluateOutbound(...) argument by brace matching. A whole-file
 * regex is not good enough here: ai-newsletter.ts contains `id: "modern"` for a
 * newsletter TEMPLATE, which has nothing to do with a contact. Only the actual
 * argument to the gate can be judged.
 */
function evaluateOutboundArgs(src: string): string[] {
  const out: string[] = []
  const re = /evaluateOutbound\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length
    let depth = 1
    const start = i
    for (; i < src.length && depth > 0; i++) {
      const c = src[i]
      if (c === "(" || c === "{" || c === "[") depth++
      else if (c === ")" || c === "}" || c === "]") depth--
    }
    out.push(src.slice(start, i))
  }
  return out
}

for (const f of CALLERS) {
  const src = stripComments(read(f))
  // A contact id that is a bare lowercase string literal is always a stub — a
  // real one is an expression (contact.id, row.id, params.contactId).
  const stub = evaluateOutboundArgs(src)
    .map((arg) => /id:\s*["'][a-z_]+["']/.exec(arg))
    .find(Boolean)
  check(
    `NO-STUB-CONTACT-${f.replace(/[^a-z]/gi, "-")}`,
    !stub,
    `${f} passes evaluateOutbound a literal stub ${stub?.[0]} — compliance_events.entity_id is uuid, the audit INSERT will fail with 22P02`,
  )
}

// ── 4. The surfaces show what the gate found ─────────────────────────────────
// A gate whose result never reaches the agent is not wired.

// Each surface must both READ the action's complianceWarnings and DISPLAY them.
// Reading alone is exactly the failure mode this replaces: the wizard action
// computed warnings for months and its own page never rendered one.
const SURFACES: Array<{ id: string; file: string; reads: RegExp; displays: RegExp }> = [
  {
    id: "WIZARD-UI",
    file: "app/dashboard/videos/create/video-create-client.tsx",
    reads: /setScriptComplianceWarnings\(\s*result\.complianceWarnings/,
    displays: /scriptComplianceWarnings\.map\(/,
  },
  {
    id: "VIDEO-ASSISTANT-UI",
    file: "app/video-assistant/page.tsx",
    reads: /\.complianceWarnings\b/,
    displays: /toast\.warning\(/,
  },
  {
    id: "SUPERPOWERS-UI",
    file: "app/dashboard/agent/components/agent-superpowers-panel.tsx",
    reads: /result\.complianceWarnings\b/,
    displays: /Compliance notes/,
  },
  {
    id: "CONTENT-STUDIO-UI",
    file: "app/components/content-studio/LinkToVideoGenerator.tsx",
    reads: /result\.complianceWarnings\b/,
    displays: /toast\.warning\(/,
  },
]

for (const s of SURFACES) {
  const src = stripComments(read(s.file))
  check(
    `${s.id}-SURFACES-WARNINGS`,
    s.reads.test(src) && s.displays.test(src),
    `${s.file} must read the action's complianceWarnings AND render them`,
  )
}

// The two paths that used to swallow a refusal must report its reason.
const assistant = stripComments(read("app/video-assistant/page.tsx"))
check(
  "VIDEO-ASSISTANT-REPORTS-REFUSAL",
  /failure\?\.error/.test(assistant),
  "app/video-assistant/page.tsx must surface the action's error when every variation fails",
)

const superpowers = stripComments(read("app/dashboard/agent/components/agent-superpowers-panel.tsx"))
check(
  "SUPERPOWERS-REPORTS-REFUSAL",
  /result\?\.error/.test(superpowers),
  "agent-superpowers-panel.tsx must show result.error rather than 'Generated script is empty'",
)

// ── 5. link-to-video: a deterministic Fair Housing hit is not overridable ────

const l2v = stripComments(read("app/actions/link-to-video.ts"))
check(
  "LINK-TO-VIDEO-FORCES-REVISION",
  /script_status:\s*["']needs_revision["']/.test(l2v) && /compliance_check_passed:\s*false/.test(l2v),
  "link-to-video must force the queue row back to needs_revision when the kernel gate finds a violation",
)

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\nvideo-script-compliance: ${passes.length} passed, ${failures.length} failed\n`)
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`)
  console.error("\nVIDEO_SCRIPT_COMPLIANCE_FAIL\n")
  process.exit(1)
}
console.log("  All video script generators enforce the shared compliance gate.\n")
