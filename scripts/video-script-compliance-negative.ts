#!/usr/bin/env tsx
/**
 * Negative test for scripts/video-script-compliance-guard.ts.
 *
 * An assertion that cannot fail proves nothing. For each of the guard's
 * assertions this mutates the real source so that assertion SHOULD trip, runs
 * the guard, and requires that specific assertion id to appear in the failure
 * output. Every file is restored and the restore is verified by sha256 against
 * the digest taken before the mutation.
 *
 * This mutates tracked source files. Never run it concurrently with the guard
 * chain or with another copy of itself.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { join } from "node:path"

const root = process.cwd()
const sha = (s: string) => createHash("sha256").update(s).digest("hex")

interface Mutation {
  id: string
  file: string
  /** Applied to the file text; return null if the anchor is gone (UNTESTABLE). */
  apply: (src: string) => string | null
}

const sub = (find: string, replace: string) => (src: string) =>
  src.includes(find) ? src.replace(find, replace) : null

const CALLER_FILES = [
  "app/actions/social/generate-social-post.ts",
  "app/actions/ai-newsletter.ts",
  "app/actions/blog.ts",
  // create-video-project.ts is off this list: it no longer calls evaluateOutbound
  // (only the tombstone comment mentions it), so the NO-STUB-CONTACT mutation had
  // no anchor to substitute and the case could never have proved anything.
  "app/actions/social-media-automation.ts",
  "lib/video/persona-variant-post-pass.ts",
  "lib/video/script-compliance.ts",
]

const mutations: Mutation[] = [
  {
    id: "GATE-EXPORTS-THREE",
    file: "lib/video/script-compliance.ts",
    apply: sub("export async function postcheckScript(", "export async function postcheckScriptRENAMED("),
  },
  {
    id: "GATE-CARRIES-ALL-THREE-BLOCKS",
    file: "lib/video/script-compliance.ts",
    // Repoint the table. A substring-presence check survives this; asserting
    // the .from() construct does not.
    apply: sub('.from("brand_voice_profile")', '.from("brand_voice_profile_GUTTED")'),
  },
  {
    id: "GATE-BRAND-VOICE-CHECKS-ERROR",
    file: "lib/video/script-compliance.ts",
    apply: sub("const { data: bvp, error } = await supabase", "const { data: bvp } = await supabase"),
  },
  {
    id: "GATE-PRECHECK-FAIR-HOUSING-ONLY",
    file: "lib/video/script-compliance.ts",
    apply: sub('v.startsWith("FairHousing:")', "v.length > 0"),
  },

  // Each generator must actually CALL each gate piece.
  ...(
    [
      ["WIZARD", "app/actions/video/generate-script.ts", ["buildComplianceSystemBlocks", "precheckBriefForFairHousing", "postcheckScript"]],
      ["VIDEO-GENERATION", "app/actions/video-generation.ts", ["buildComplianceSystemBlocks", "precheckBriefForFairHousing", "postcheckScript"]],
      ["LINK-TO-VIDEO", "app/actions/link-to-video.ts", ["buildComplianceSystemBlocks", "postcheckScript"]],
      ["KERNEL-VIDEO", "lib/kernel/video.ts", ["buildComplianceSystemBlocks", "postcheckScript"]],
      ["CONTENT-ENGINE", "app/actions/content-generation-engine.ts", ["buildComplianceSystemBlocks", "precheckBriefForFairHousing", "postcheckScript"]],
      // The sixth generator (2026-08-28). Both its doors share ONE fused
      // gate+store helper, so each `await <fn>(` appears exactly once and the
      // first-occurrence substitution below guts the only call.
      ["WORKFLOWS", "app/actions/workflows.ts", ["buildComplianceSystemBlocks", "precheckBriefForFairHousing", "postcheckScript"]],
    ] as Array<[string, string, string[]]>
  ).flatMap(([id, file, fns]) =>
    fns.map((fn) => ({
      id: `${id}-CALLS-${fn}`,
      file,
      // Gut the CALL, keeping the import — this is precisely what a bare
      // token-presence check would fail to catch.
      apply: sub(`await ${fn}(`, `await NOT_${fn}(`),
    })),
  ),

  {
    id: "CONTENT-ENGINE-HEADER-HONEST",
    file: "app/actions/content-generation-engine.ts",
    apply: sub("// Draft-only, no publishing/approval.", "// Draft-only, no publishing/approval/compliance"),
  },
  {
    id: "WIZARD-HAS-NO-PRIVATE-COPY",
    file: "app/actions/video/generate-script.ts",
    apply: (src) =>
      src.includes('import {')
        ? src.replace('import {', 'const REGRESSION = "ThemFirst communication philosophy"\nimport {')
        : null,
  },

  ...CALLER_FILES.map((file) => ({
    id: `NO-STUB-CONTACT-${file.replace(/[^a-z]/gi, "-")}`,
    file,
    apply: sub("evaluateOutbound({", 'evaluateOutbound({ contact: { id: "stubtest" },'),
  })),

  {
    id: "WIZARD-UI-SURFACES-WARNINGS",
    file: "app/dashboard/videos/create/video-create-client.tsx",
    apply: sub("scriptComplianceWarnings.map(", "[].map("),
  },
  {
    id: "VIDEO-ASSISTANT-UI-SURFACES-WARNINGS",
    file: "app/video-assistant/page.tsx",
    apply: sub("toast.warning(", "console.warn("),
  },
  {
    id: "SUPERPOWERS-UI-SURFACES-WARNINGS",
    file: "app/dashboard/agent/components/agent-superpowers-panel.tsx",
    apply: sub("Compliance notes", "Notes"),
  },
  {
    id: "CONTENT-STUDIO-UI-SURFACES-WARNINGS",
    file: "app/components/content-studio/LinkToVideoGenerator.tsx",
    apply: sub("toast.warning(", "console.warn("),
  },

  {
    id: "VIDEO-ASSISTANT-REPORTS-REFUSAL",
    file: "app/video-assistant/page.tsx",
    apply: sub("failure?.error ??", "undefined ??"),
  },
  {
    id: "SUPERPOWERS-REPORTS-REFUSAL",
    file: "app/dashboard/agent/components/agent-superpowers-panel.tsx",
    apply: sub("result?.error ??", "undefined ??"),
  },
  {
    id: "WORKFLOWS-RED-FLAG-REFUSES-STORE",
    file: "app/actions/workflows.ts",
    apply: sub("if (redFlags.length > 0) {", "if (false) {"),
  },
  {
    id: "LINK-TO-VIDEO-FORCES-REVISION",
    file: "app/actions/link-to-video.ts",
    apply: sub(
      '{ compliance_check_passed: false, script_status: "needs_revision" }',
      "{ compliance_check_passed: false }",
    ),
  },
]

function runGuard(): { ok: boolean; output: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/video-script-compliance-guard.ts"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { ok: true, output: out }
  } catch (e: any) {
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

// Baseline must be green, or every result below is meaningless.
const baseline = runGuard()
if (!baseline.ok) {
  console.error("BASELINE IS RED — fix the guard before negative-testing it.\n" + baseline.output)
  process.exit(1)
}

const caught: string[] = []
const missed: string[] = []
const untestable: string[] = []

for (const m of mutations) {
  const path = join(root, m.file)
  const original = readFileSync(path, "utf8")
  const digest = sha(original)

  const mutated = m.apply(original)
  if (mutated === null || mutated === original) {
    untestable.push(`${m.id} (anchor not found in ${m.file})`)
    continue
  }

  writeFileSync(path, mutated)
  let result: { ok: boolean; output: string }
  try {
    result = runGuard()
  } finally {
    writeFileSync(path, original)
    const restored = sha(readFileSync(path, "utf8"))
    if (restored !== digest) {
      console.error(`\nRESTORE FAILED for ${m.file} — sha256 ${restored} != ${digest}`)
      process.exit(1)
    }
  }

  if (!result.ok && result.output.includes(m.id)) caught.push(m.id)
  else if (!result.ok) missed.push(`${m.id} (guard failed, but not on this assertion)`)
  else missed.push(`${m.id} (guard stayed GREEN under mutation)`)
}

console.log(`\nnegative test: ${caught.length} caught, ${missed.length} missed, ${untestable.length} untestable`)
for (const u of untestable) console.log(`  UNTESTABLE  ${u}`)
for (const x of missed) console.error(`  MISSED      ${x}`)

// Informational only. Restore is already guaranteed per-mutation by the sha256
// comparison above (a mismatch exits 1 immediately). This line reports whether
// the touched files have OTHER uncommitted edits — which is normal while the
// feature itself is still being worked on, and is NOT a restore failure.
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...new Set(mutations.map((m) => m.file))], {
  cwd: root,
  encoding: "utf8",
})

if (missed.length || untestable.length) {
  console.error("\nVIDEO_SCRIPT_COMPLIANCE_NEGATIVE_FAIL\n")
  process.exit(1)
}
console.log(
  `  Every assertion is falsifiable. All mutations restored (sha256-verified).\n` +
    `  Other uncommitted edits in the touched files: ${dirty.trim() ? "yes (expected while the feature is in progress)" : "none"}\n`,
)
