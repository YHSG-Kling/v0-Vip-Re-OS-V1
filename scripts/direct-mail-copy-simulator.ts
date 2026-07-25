#!/usr/bin/env tsx
/**
 * scripts/direct-mail-copy-simulator.ts  (npm run test:direct-mail-copy)
 * ─────────────────────────────────────────────────────────────────────────────
 * POSTCARD COPY NO LONGER THROWS "INVALID SCHEMA", AND THE PREVIEW REFLECTS IT.
 * OpenAI strict structured-output (used by generateObject through the gateway)
 * rejects string length constraints (.max → maxLength) and optional properties
 * (.optional). The postcard-copy schema carried five .max() and two .optional()
 * → "invalid schema". Fix: length is guidance in .describe(), optionals became
 * .nullable(). Also: the design suggestion's colors now flow into the preview,
 * and generated copy populates copyText (so the preview stops showing the empty
 * placeholder once copy is generated).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the postcard-copy schema is strict-output safe ──")
{
  const act = src("app/actions/ai-direct-mail.ts")
  // Isolate the aiWritePostcardCopy generateObject schema block, stripping
  // comment lines (the explanatory note mentions .max/.optional on purpose).
  const block = act
    .slice(act.indexOf("const { object: copy }"), act.indexOf("prompt: `Write compelling postcard"))
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")
  check("no .max() length constraints in the copy schema", !/\.max\(/.test(block))
  check("no .optional() properties in the copy schema", !/\.optional\(/.test(block))
  check("optional fields are expressed as .nullable() instead", /\.nullable\(\)/.test(block))
  check("headline/body/cta are still present", block.includes("headline:") && block.includes("bodyText:") && block.includes("callToAction:"))
}

console.log("\n── the design colors reach the preview ──")
{
  const preview = src("app/dashboard/campaigns/mail/components/mail-piece-preview.tsx")
  check("MailPiecePreview accepts a colors palette", preview.includes("colors?: MailPreviewColors") || preview.includes("colors,"))
  check("the postcard applies the palette (background/primary/text)",
    preview.includes("colors?.background") && preview.includes("colors?.primary") && preview.includes("colors?.text"))

  const dialog = src("app/dashboard/campaigns/mail/components/create-campaign-dialog.tsx")
  check("the dialog passes the AI design colorScheme into the preview",
    dialog.includes("colors={aiDesignSuggestion?.colorScheme}"))
  check("generated copy is written into copyText (so the preview shows it)",
    /setFormData\(\(f\)\s*=>\s*\(\{\s*\.\.\.f,\s*copyText:/.test(dialog))
}

console.log("\n── the print preview shows the REAL Lob-bound image (not just CSS) ──")
{
  const act = src("app/actions/direct-mail-preview.ts")
  check("the preview action renders via the same renderer Lob is sent",
    act.includes("renderPostcardBothSides4x6") && act.includes("frontUrl") && act.includes("backUrl"))
  check("it is auth-gated + brokerage-scoped", act.includes("getAgentContext") && act.includes("brokerageId"))

  const dialog = src("app/dashboard/campaigns/mail/components/create-campaign-dialog.tsx")
  check("the dialog has a Generate-print-preview action wired to the render",
    dialog.includes("handleGeneratePrintPreview") && dialog.includes("renderPostcardPreviewAction"))
  check("it displays the rendered front (and back) images",
    dialog.includes("printPreview?.frontUrl") && /alt="Postcard front"/.test(dialog))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ DIRECT_MAIL_COPY_FAIL"); process.exit(1) }
console.log(" ✅ DIRECT_MAIL_COPY_PASS — copy schema is strict-safe; the preview reflects generated copy + suggested colors")
