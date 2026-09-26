#!/usr/bin/env tsx
/**
 * scripts/lead-magnet-embed-guard.ts  (npm run test:lead-magnet-embed) — pure, no DB, no network.
 *
 * LANE 85E — census 6d burn-down by BUILDING the missing halves (CLAUDE.md §1.2),
 * never by a ruling:
 *   · POST /api/lead-magnets/submissions said it existed "for embeds OUTSIDE this
 *     app" and nothing handed a tenant an embed — and it answered no CORS
 *     preflight, so an embed on another origin could never have read its result.
 *     Built: lib/lead-magnets/embed-snippet.ts + the library's "Embed on your
 *     site" control + the route's OPTIONS/CORS.
 *   · GET /api/lead-magnets/qr/[magnetId]'s session-gated RECORD arm had no
 *     reader. Built: QRCodeGenerator reads it for a magnet that already has a code.
 * Every rule runs the real pure builder; source checks read COMMENT-BLANKED code.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { blankComments } from "./strip-comments"
import {
  LEAD_MAGNET_EMBED_CORS_HEADERS, LEAD_MAGNET_EMBED_ENDPOINT, buildLeadMagnetEmbedSnippet, leadMagnetEmbedEndpoint,
} from "../lib/lead-magnets/embed-snippet"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const code = (rel: string) => blankComments(readFileSync(join(root, rel), "utf8"))
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

console.log("\n── §snippet · the embed posts the kernel's own input contract ──")
const base = { origin: "https://app.example.com/", formId: "11111111-2222-4333-8444-555555555555", brokerageId: "99999999-8888-4777-8666-555555555555", magnetName: "Free home value", magnetType: "home_valuation" }
const snippet = buildLeadMagnetEmbedSnippet(base)
check("the snippet posts to the route this module is the other half of (no double slash)",
  snippet.includes(`"https://app.example.com${LEAD_MAGNET_EMBED_ENDPOINT}"`) && leadMagnetEmbedEndpoint("https://a.b//") === `https://a.b${LEAD_MAGNET_EMBED_ENDPOINT}`)
check("the route path is real", LEAD_MAGNET_EMBED_ENDPOINT === "/api/lead-magnets/submissions")
check("the body is CaptureFormSubmissionInput (formId, brokerageId, submissionData, tcpaConsentGiven, source)",
  /formId:"11111111/.test(snippet) && /brokerageId:"99999999/.test(snippet) && /submissionData:d/.test(snippet) && /tcpaConsentGiven:!!f\.tcpa\.checked/.test(snippet) && /source:"embed"/.test(snippet))
check("a valuation magnet carries the address field and a REQUIRED consent box (the kernel refuses consent-less valuations)",
  snippet.includes('name="property_address"') && /name="tcpa" required/.test(snippet))
const guide = buildLeadMagnetEmbedSnippet({ ...base, magnetType: "buyer_guide" })
check("a non-valuation magnet has no address field and an optional consent box", !guide.includes("property_address") && !/name="tcpa" required/.test(guide))
check("success is shown ONLY on the route's 201 — a refusal shows the route's own error", /r\.status===201&&j\.success/.test(snippet) && /j\.error/.test(snippet))
const hostile = buildLeadMagnetEmbedSnippet({ ...base, magnetName: `</script><script>alert(1)</script>"`, formId: `x"</script>` })
check("CONTROL: a hostile magnet name / form id cannot close the script or the attribute",
  !hostile.includes("</script><script>alert") && hostile.includes("&lt;/script&gt;") && !/"x"<\/script>/.test(hostile))

console.log("\n── §route · the preflight an embed triggers is answered ──")
const route = code("app/api/lead-magnets/submissions/route.ts")
check("the route exports OPTIONS answering 204 with the embed CORS headers", /export function OPTIONS\(\)/.test(route) && /status: 204, headers: LEAD_MAGNET_EMBED_CORS_HEADERS/.test(route))
check("every POST response carries the same headers (withCors over the one handler)", /return withCors\(await handleSubmission\(req\)\)/.test(route))
check("the CORS policy admits POST/OPTIONS + JSON only and never credentials",
  LEAD_MAGNET_EMBED_CORS_HEADERS["Access-Control-Allow-Methods"] === "POST, OPTIONS" && LEAD_MAGNET_EMBED_CORS_HEADERS["Access-Control-Allow-Headers"] === "Content-Type"
  && !("Access-Control-Allow-Credentials" in LEAD_MAGNET_EMBED_CORS_HEADERS))
check("the door still calls the ONE kernel command (captureFormSubmission) — no second intake", /captureFormSubmission\(/.test(route))

console.log("\n── §wiring · the halves are reachable from a page ──")
const lib = code("app/components/features/lead-magnets/MagnetLibrary.tsx")
check("the lead-magnet library builds the snippet from the magnet's formId and the session brokerage",
  /buildLeadMagnetEmbedSnippet\(\{/.test(lib) && /formId: magnet\.formId/.test(lib) && /navigator\.clipboard\.writeText\(snippet\)/.test(lib))
const qr = code("app/components/features/lead-magnets/QRCodeGenerator.tsx")
check("the QR card reads the session-gated record arm for an existing code (tracked slug + scans), never a guess on refusal",
  /fetch\(`\/api\/lead-magnets\/qr\/\$\{encodeURIComponent\(magnetId\)\}\?brokerageId=/.test(qr) && /setRecordNote\(/.test(qr))
check("CONTROL: a lead-magnet library WITHOUT the control is recognised", !/buildLeadMagnetEmbedSnippet\(\{/.test(`export function MagnetLibrary() { return null }`))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ LEAD_MAGNET_EMBED_PASS — the public intake door has the embed it was built for, and the QR record arm has its reader")
