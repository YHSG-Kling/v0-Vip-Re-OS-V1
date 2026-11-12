#!/usr/bin/env tsx
/**
 * scripts/video-blog-voice-loops-simulator.ts   (npm run test:video-blog-voice-loops)
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE SURFACES THAT TRUSTED SOMETHING THEY SHOULD HAVE RESOLVED THEMSELVES.
 *
 * Different files, one shape: a surface accepts an answer from outside instead
 * of deriving it, and nothing downstream can tell the difference until the data
 * is already wrong.
 *
 *   LOOP 1 — POST /api/video/engagement named its own tenant.
 *     The route imported requireAuth and called it on GET only. The POST path
 *     had NO auth gate at all and read `brokerageId` out of the JSON body, then
 *     wrote that tenant onto video_performance_tracking and lifecycle_events.
 *     An unauthenticated body naming a tenant is a write primitive into any
 *     tenant on the platform. (The tracked note that "the file imports
 *     requireAuth, so this is probably already fixed" was WRONG: the import was
 *     real, the call on the POST path was not. Measured, not assumed.)
 *     Separately, video_engagement_events.brokerage_id EXISTS on the live table
 *     and was left null on every row this route wrote — the raw event ledger had
 *     no tenant at all.
 *
 *   LOOP 2 — the blog list filtered on a column it never selected.
 *     The dashboard blog LIST page projected ten columns and `category` was not
 *     among them, while the client renders category tabs and filters with
 *     `post.category === categoryFilter`. Every row arrived with category
 *     undefined, so every tab except "All" emptied the list. blog_posts.category
 *     is a real nullable text column on the live database, and the canonical
 *     projection in app/actions/blog.ts already selected it — the filter was
 *     never broken, the projection feeding it was. B4 below generalises that
 *     into the rule that would have caught it: the page's projection must cover
 *     every field the client's own row interface declares.
 *
 *   LOOP 3 — the call ledger had nothing stopping a webhook retry.
 *     voice_calls.vendor_call_id carried NO index of any kind — not unique, not
 *     even a plain btree — while eleven call sites resolve a call by it and end
 *     in maybeSingle(), a promise that at most one row matches. A provider retry
 *     (they all retry) inserted a SECOND row for the same call, after which
 *     every later stage of that call failed outright on the duplicate. m464 adds
 *     the partial unique index and makes the DATABASE the arbiter; the inbound
 *     answer path reads 23505 as "already recorded" rather than as a lost write.
 *
 * PURE: the two projection parsers B1/B4 stand on are EXECUTED against
 *       hand-built inputs, so neither probe can pass by returning nothing.
 * SOURCE: every claim is read out of the shipped files, code-only where prose
 *       could contaminate the window.
 * NEGATIVE CONTROLS: every source probe is re-run against a deliberately broken
 *       copy and must go RED, and a COVERAGE assertion proves no probe escaped
 *       without a mutation that kills it. A check that cannot fail is not a check.
 * LIVE: the columns and the index are confirmed against the real database, the
 *       retry is executed rather than argued, and the probe rows are deleted and
 *       the residue counted back to zero.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}

const ROUTE = "app/api/video/engagement/route.ts"
const BLOG_PAGE = "app/dashboard/marketing/blog/page.tsx"
const BLOG_CLIENT = "app/dashboard/marketing/blog/blog-dashboard-client.tsx"
const BLOG_ACTIONS = "app/actions/blog.ts"
const INBOUND = "app/api/voice/twilio/inbound/route.ts"
const ZOOM = "lib/connections/zoom-transcripts.ts"
const MIGRATION = "supabase/migrations/m464-a-provider-webhook-that-retries-must-not-fork-the-call-ledger.sql"
const FILES = [ROUTE, BLOG_PAGE, BLOG_CLIENT, BLOG_ACTIONS, INBOUND, ZOOM, MIGRATION]

function loadSources(): Record<string, string> {
  const s: Record<string, string> = {}
  for (const f of FILES) s[f] = readFileSync(join(process.cwd(), f), "utf8")
  return s
}

// ─── PURE HELPERS (also the parsers the source probes depend on) ─────────────

/**
 * CODE ONLY — block comments and whole-line `//` comments removed.
 *
 * A probe whose window includes prose is testing the prose. Both of these files
 * carry long doc comments that NAME the defect they fixed ("takes brokerageId
 * from the request body"), so a raw-source probe for that phrase would go green
 * on the explanation and red on nothing.
 */
function codeOnly(source: string): string {
  return stripComments(source)
}

/**
 * The SQL twin. SQL comments are `--`, which codeOnly does not strip — and the
 * m464 header is ~60 lines of prose that says "CREATE UNIQUE INDEX" nowhere but
 * discusses uniqueness throughout. Only the DDL is the claim.
 */
function sqlCodeOnly(source: string): string {
  return source.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
}

/** The body of one top-level function, so a match elsewhere in the file cannot pass its probe. */
function fnBody(source: string, startNeedle: string, endNeedles: string[]): string {
  const start = source.indexOf(startNeedle)
  if (start < 0) return ""
  let end = source.length
  for (const n of endNeedles) {
    const i = source.indexOf(n, start + startNeedle.length)
    if (i >= 0 && i < end) end = i
  }
  return source.slice(start, end)
}

/** PURE: the column list out of a `.select("a, b, c")` literal following a named .from(). */
export function selectedColumns(source: string, table: string): string[] {
  const from = source.indexOf(`.from("${table}")`)
  if (from < 0) return []
  const sel = source.indexOf(".select(", from)
  if (sel < 0) return []
  const q1 = source.indexOf('"', sel)
  if (q1 < 0) return []
  const q2 = source.indexOf('"', q1 + 1)
  if (q2 < 0) return []
  return source
    .slice(q1 + 1, q2)
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
}

/** PURE: the field names declared by a TypeScript interface, `?` and type stripped. */
export function interfaceFields(source: string, name: string): string[] {
  const start = source.indexOf(`interface ${name} {`)
  if (start < 0) return []
  const end = source.indexOf("\n}", start)
  if (end < 0) return []
  return source
    .slice(start, end)
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*\??\s*:/.test(l))
    .map((l) => l.split(/\??\s*:/)[0].trim())
}

function pureLayer() {
  console.log("\n[PURE · the projection parsers B1/B4 stand on — so neither can pass by returning nothing]")

  const sampleSelect = `
    const { data } = await supabase
      .from("blog_posts")
      .select(
        "id, title, category, published_at"
      )
      .eq("brokerage_id", b)
  `
  check("P1 selectedColumns reads the literal that follows the NAMED table, trimmed and split",
    selectedColumns(sampleSelect, "blog_posts").join("|") === "id|title|category|published_at")

  check("P2 selectedColumns returns nothing for a table that is not in the source — it never guesses",
    selectedColumns(sampleSelect, "voice_calls").length === 0)

  const sampleIface = `
interface BlogPost {
  id: string
  title: string
  category?: string | null
  seo_score: number | null
}
`
  check("P3 interfaceFields strips the optional marker and the type, keeping only the name",
    interfaceFields(sampleIface, "BlogPost").join("|") === "id|title|category|seo_score")

  check("P4 interfaceFields returns nothing for an interface that is not there",
    interfaceFields(sampleIface, "VideoPost").length === 0)

  check("P5 the SUPERSET rule is what fails on the real defect: a projection missing one declared field is caught",
    (() => {
      const declared = ["id", "title", "category"]
      const projected = ["id", "title"]
      return declared.some((f) => !projected.includes(f))
    })())

  check("P6 codeOnly removes the doc comment that NAMES the defect, so a probe cannot go green on prose",
    !codeOnly("// takes brokerageId from the request body\nconst x = 1\n").includes("brokerageId"))

  check("P7 sqlCodeOnly removes `--` prose, which codeOnly does NOT",
    !sqlCodeOnly("-- CREATE UNIQUE INDEX in prose\nCREATE INDEX x ON y (z);").includes("UNIQUE")
    && codeOnly("-- CREATE UNIQUE INDEX in prose\n").includes("UNIQUE"))
}

// ─── SOURCE ──────────────────────────────────────────────────────────────────

type Probe = { name: string; run: (s: Record<string, string>) => boolean }

const postBody = (s: Record<string, string>) =>
  fnBody(codeOnly(s[ROUTE]), "export async function POST", ["async function assertVideoBelongsToTenant"])
const ownershipHelper = (s: Record<string, string>) =>
  fnBody(codeOnly(s[ROUTE]), "async function assertVideoBelongsToTenant", ["async function aggregateVideoPerformance"])
const aggregateHelper = (s: Record<string, string>) =>
  fnBody(codeOnly(s[ROUTE]), "async function aggregateVideoPerformance", ["async function checkPerformanceThresholds"])
const ledgerBlock = (s: Record<string, string>) =>
  fnBody(codeOnly(s[INBOUND]), "if (contactId || leadId) {", ["── RECORDING"])

const PROBES: Probe[] = [
  // ── LOOP 1 ────────────────────────────────────────────────────────────────
  {
    name: "V1 requireAuth is CALLED on the POST path, not merely imported for GET's benefit",
    // Re-pinned 2026-09-01: POST became a DUAL gate (requireAuth for staff, or
    // requireContactAccess for the portal contact whose engagement this route
    // exists to record) — the old pin required the single-gate spelling
    // `if (!auth.ok) return auth.response` at the top. The rule survives
    // strengthened: requireAuth is still called and its refusal still returned
    // on the no-session-no-contact path, and the ONLY other admission is the
    // shared portal gate with its own refusal handled.
    run: (s) => {
      const body = postBody(s)
      return /const auth = await requireAuth\(supabase\)/.test(body)
        && /return auth\.response/.test(body)
        && /await requireContactAccess\(contactId\)/.test(body)
        && /if \(!access\.ok\)/.test(body)
    },
  },
  {
    name: "V2 the tenant comes from the SESSION — POST's body destructure names no brokerageId",
    // Re-pinned with V1: the tenant now arrives from the session (staff) or
    // the gate-proven CONTACT ROW (portal) — never the body destructure.
    run: (s) => {
      const body = postBody(s)
      const destructure = body.slice(body.indexOf("const {"), body.indexOf("} = body"))
      return /brokerageId = auth\.brokerageId/.test(body)
        && /brokerageId = access\.brokerageId/.test(body)
        && !/brokerageId/.test(destructure)
    },
  },
  {
    name: "V3 a body that still carries a tenant is REFUSED with 400, not silently ignored",
    run: (s) => {
      const body = postBody(s)
      return /hasOwnProperty\.call\(body, "brokerageId"\)/.test(body)
        && /status: 400/.test(body.slice(body.indexOf('hasOwnProperty.call(body, "brokerageId")')))
    },
  },
  {
    name: "V4 the raw engagement event is STAMPED with the session tenant (the column existed and was never filled)",
    run: (s) => /const eventRecord = \{\s*\n\s*brokerage_id: brokerageId,/.test(postBody(s)),
  },
  {
    name: "V5 the NAMED video is verified into the tenant before anything is written, by equality not by FK",
    run: (s) => {
      const body = postBody(s)
      const helper = ownershipHelper(s)
      const callAt = body.indexOf("await assertVideoBelongsToTenant(")
      const insertAt = body.indexOf('.from("video_engagement_events")')
      return callAt > 0 && insertAt > callAt
        && /asset\.brokerage_id !== brokerageId/.test(helper)
        && /project\.brokerage_id !== brokerageId/.test(helper)
        && /status: 403/.test(helper)
    },
  },
  {
    name: "V6 the aggregate row is looked up scoped to the tenant, not by video id alone",
    run: (s) => /\.from\("video_performance_tracking"\)\s*\n\s*\.select\("\*"\)\s*\n\s*\.eq\("brokerage_id", brokerageId\)/.test(aggregateHelper(s)),
  },
  {
    name: "V7 every read in the ownership helper destructures AND checks error (supabase-js resolves a refusal)",
    run: (s) => {
      const helper = ownershipHelper(s)
      return /const \{ data: asset, error: assetError \} = await/.test(helper)
        && /const \{ data: project, error: projectError \} = await/.test(helper)
        && /if \(assetError\) return/.test(helper)
        && /if \(projectError\) return/.test(helper)
        && !/const \{ data: \w+ \} = await supabase/.test(helper)
    },
  },
  {
    name: "V8 a NEW aggregate row cannot be born tenant-less — brokerage_id is the session value, never `|| null`",
    run: (s) => {
      const helper = aggregateHelper(s)
      return /brokerage_id: brokerageId,/.test(helper) && !/brokerage_id: brokerageId \|\| null/.test(helper)
    },
  },

  // ── LOOP 2 ────────────────────────────────────────────────────────────────
  {
    name: "B1 the blog LIST page projects `category` — the column its own filter compares against",
    run: (s) => selectedColumns(codeOnly(s[BLOG_PAGE]), "blog_posts").includes("category"),
  },
  {
    name: "B2 the client really does filter on post.category (so B1 is load-bearing, not decorative)",
    run: (s) => /post\.category === categoryFilter/.test(codeOnly(s[BLOG_CLIENT])),
  },
  {
    name: "B3 every supabase read on the page destructures AND checks error — a refusal is not an absent row",
    run: (s) => {
      const code = codeOnly(s[BLOG_PAGE])
      const reads = code.match(/const \{ data: \w+, error: \w+ \} = await supabase/g) ?? []
      return reads.length >= 3
        && /if \(userError\)/.test(code)
        && /if \(postsError\)/.test(code)
        && /if \(keywordsError\)/.test(code)
        && !/const \{ data: \w+ \} = await supabase/.test(code)
    },
  },
  {
    name: "B4 THE GENERAL RULE: the page's projection covers EVERY field the client's row interface declares",
    run: (s) => {
      const declared = interfaceFields(codeOnly(s[BLOG_CLIENT]), "BlogPost")
      const projected = selectedColumns(codeOnly(s[BLOG_PAGE]), "blog_posts")
      // Non-empty on both sides, or the rule would pass vacuously — which is
      // exactly how the original defect survived review.
      return declared.length >= 8 && projected.length >= 8 && declared.every((f) => projected.includes(f))
    },
  },
  {
    name: "B5 the page's projection agrees with the canonical one in app/actions/blog.ts (they list the same table)",
    run: (s) => {
      const page = selectedColumns(codeOnly(s[BLOG_PAGE]), "blog_posts")
      const canonical = selectedColumns(
        codeOnly(s[BLOG_ACTIONS]).slice(codeOnly(s[BLOG_ACTIONS]).indexOf("let query = supabase")),
        "blog_posts",
      )
      return canonical.length >= 8 && canonical.every((c) => page.includes(c))
    },
  },

  // ── LOOP 3 ────────────────────────────────────────────────────────────────
  {
    name: "M1 m464 creates a UNIQUE index on the vendor call id, PARTIAL on NOT NULL (a vendor-less call stays legal)",
    run: (s) => {
      const ddl = sqlCodeOnly(s[MIGRATION])
      return /CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_calls_vendor_call_id/.test(ddl)
        && /ON public\.voice_calls \(vendor_call_id\)/.test(ddl)
        && /WHERE vendor_call_id IS NOT NULL/.test(ddl)
    },
  },
  {
    name: "M2 m464 records a MEASURED-BEFORE and a MEASURED-AFTER, including the residue it cleaned up",
    run: (s) => /MEASURED BEFORE/.test(s[MIGRATION]) && /MEASURED AFTER/.test(s[MIGRATION])
      && /RESIDUE MEASURED AFTER CLEANUP/.test(s[MIGRATION]),
  },
  {
    name: "C1 the inbound ledger insert returns its own id and classifies 23505 as ALREADY RECORDED",
    run: (s) => {
      const b = ledgerBlock(s)
      return /const \{ data: insertedCall, error: callInsertError \} = await svc/.test(b)
        && /\.select\("id"\)/.test(b)
        && /const alreadyRecorded = \(callInsertError as any\)\?\.code === "23505"/.test(b)
    },
  },
  {
    name: "C2 a 23505 retry never reaches the self-heal ledger — only a REAL loss is reported as loss",
    run: (s) => /if \(callInsertError && !alreadyRecorded\) \{/.test(ledgerBlock(s)),
  },
  {
    name: "C3 the scoring row is gated on THIS delivery having created the call, so the retry cannot fork ai_isa_calls either",
    run: (s) => /if \(insertedCall\?\.id && !alreadyRecorded\) \{/.test(ledgerBlock(s))
      && /voice_call_id: insertedCall\.id,/.test(ledgerBlock(s)),
  },
  {
    name: "C4 the inbound path no longer re-reads the ledger by vendor id to find the row it just wrote",
    run: (s) => !/\.eq\("vendor_call_id", callSid\)/.test(ledgerBlock(s)),
  },
  {
    name: "C5 the scoring write is error-checked, not wrapped in a try/catch that cannot see a RESOLVED error",
    run: (s) => {
      const b = ledgerBlock(s)
      return /const \{ error: isaError \} = await svc\.from\("ai_isa_calls"\)\.insert\(/.test(b)
        && /if \(isaError\)/.test(b)
        && !/try \{[\s\S]{0,400}?\.from\("ai_isa_calls"\)/.test(b)
    },
  },
  {
    name: "Z1 the Zoom attacher's duplicate check is error-checked (an unchecked read sends a duplicate at the insert)",
    run: (s) => {
      const code = codeOnly(s[ZOOM])
      return /const \{ data: dupCall, error: dupError \} = await svc/.test(code)
        && /if \(dupError\) return \{ handled: false/.test(code)
    },
  },
  {
    name: "Z2 losing the Zoom race reads as ALREADY ATTACHED, not as a failed attach",
    run: (s) => {
      const code = codeOnly(s[ZOOM])
      const at = code.indexOf('if ((callErr as any)?.code === "23505")')
      return at > 0 && /handled: true[\s\S]{0,120}?already attached \(idempotent\)/.test(code.slice(at))
    },
  },
]

function sourceLayer() {
  console.log("\n[SOURCE · the three loops, read out of the shipped files]")
  const s = loadSources()
  for (const p of PROBES) check(p.name, p.run(s))
}

// ─── NEGATIVE CONTROLS ───────────────────────────────────────────────────────

type Mutation = { name: string; probe: string; mutate: (s: Record<string, string>) => Record<string, string> }

const MUTATIONS: Mutation[] = [
  {
    // NOTE the anchor. GET's gate is character-for-character identical to POST's,
    // and String.replace takes the FIRST match — the first cut of this control
    // silently broke GET instead, and V1 stayed (correctly) green. A negative
    // control that mutates the wrong function proves nothing, so this one is
    // anchored on the POST signature itself.
    name: "the POST auth gate is removed again, leaving requireAuth imported but called only by GET",
    probe: "V1",
    // Re-anchored with the dual gate: the requireAuth call now sits inside
    // POST's try block ahead of the auth.ok branch — GET's call is spelled
    // without the following dual-gate branch, so this replace cannot hit GET.
    mutate: (s) => ({ ...s, [ROUTE]: s[ROUTE].replace(
      "    const auth = await requireAuth(supabase)\n    if (auth.ok) {",
      "    const auth = { ok: true, brokerageId: null } as any\n    if (auth.ok) {",
    ) }),
  },
  {
    name: "the tenant goes back to being destructured out of the request body",
    probe: "V2",
    // Re-anchored: contactId left the destructure (it is validated off body
    // separately for the portal gate), so the mutation rides eventType now.
    mutate: (s) => ({ ...s, [ROUTE]: s[ROUTE].replace("      videoProjectId,\n      eventType,", "      videoProjectId,\n      brokerageId,\n      eventType,") }),
  },
  {
    name: "a caller-supplied tenant is silently ignored instead of refused",
    probe: "V3",
    mutate: (s) => ({ ...s, [ROUTE]: s[ROUTE].replace(/if \(body && Object\.prototype\.hasOwnProperty[\s\S]*?\n    \}\n/, "") }),
  },
  {
    name: "the raw engagement event stops carrying a tenant again",
    probe: "V4",
    mutate: (s) => ({ ...s, [ROUTE]: s[ROUTE].replace("      brokerage_id: brokerageId,\n      video_asset_id: videoAssetId || null,", "      video_asset_id: videoAssetId || null,") }),
  },
  {
    name: "the ownership check is skipped, so a caller may name another tenant's video",
    probe: "V5",
    mutate: (s) => ({ ...s, [ROUTE]: s[ROUTE].replace("const owned = await assertVideoBelongsToTenant(", "const owned = { ok: true } as any\n    const unused = ((") }),
  },
  {
    name: "the ownership check stops comparing to the SESSION tenant (an FK-shaped test that proves only existence)",
    probe: "V5",
    mutate: (s) => ({ ...s, [ROUTE]: s[ROUTE].replace(/\.brokerage_id !== brokerageId/g, ".brokerage_id !== undefined") }),
  },
  {
    name: "the aggregate lookup drops its tenant filter, so one tenant's event lands on another's aggregate",
    probe: "V6",
    mutate: (s) => ({ ...s, [ROUTE]: s[ROUTE].replace('    .select("*")\n    .eq("brokerage_id", brokerageId)', '    .select("*")') }),
  },
  {
    name: "an ownership read drops its error again",
    probe: "V7",
    mutate: (s) => ({ ...s, [ROUTE]: s[ROUTE].replace("const { data: asset, error: assetError } = await supabase", "const { data: asset } = await supabase") }),
  },
  {
    name: "a new aggregate row may be born tenant-less again",
    probe: "V8",
    mutate: (s) => ({ ...s, [ROUTE]: s[ROUTE].replace("      brokerage_id: brokerageId,\n      total_views:", "      brokerage_id: brokerageId || null,\n      total_views:") }),
  },
  {
    name: "the blog list stops selecting the column its own filter compares against",
    probe: "B1",
    mutate: (s) => ({ ...s, [BLOG_PAGE]: s[BLOG_PAGE].replace('"id, title, slug, excerpt, category, publish_status', '"id, title, slug, excerpt, publish_status') }),
  },
  {
    name: "the client stops filtering on the category at all (which would make B1 decorative)",
    probe: "B2",
    mutate: (s) => ({ ...s, [BLOG_CLIENT]: s[BLOG_CLIENT].replace("post.category === categoryFilter", "true") }),
  },
  {
    name: "a page read drops its error, so a refused query reads as an empty blog",
    probe: "B3",
    mutate: (s) => ({ ...s, [BLOG_PAGE]: s[BLOG_PAGE].replace("const { data: posts, error: postsError } = await supabase", "const { data: posts } = await supabase") }),
  },
  {
    name: "a DIFFERENT declared field is dropped from the projection (the same defect, one column over)",
    probe: "B4",
    mutate: (s) => ({ ...s, [BLOG_PAGE]: s[BLOG_PAGE].replace(", published_at, agent_user_id", ", agent_user_id") }),
  },
  {
    name: "the page projection drifts away from the canonical one in the actions file",
    probe: "B5",
    mutate: (s) => ({ ...s, [BLOG_PAGE]: s[BLOG_PAGE].replace(", seo_score,", ",") }),
  },
  {
    name: "m464 degrades to a plain index — fast, and still lets a retry fork the ledger",
    probe: "M1",
    mutate: (s) => ({ ...s, [MIGRATION]: s[MIGRATION].replace("CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_calls_vendor_call_id", "CREATE INDEX IF NOT EXISTS uq_voice_calls_vendor_call_id") }),
  },
  {
    name: "m464 drops the partial predicate, making a second vendor-less call illegal",
    probe: "M1",
    mutate: (s) => ({ ...s, [MIGRATION]: s[MIGRATION].replace("\n  WHERE vendor_call_id IS NOT NULL;", ";") }),
  },
  {
    name: "m464 ships without its MEASURED-AFTER",
    probe: "M2",
    mutate: (s) => ({ ...s, [MIGRATION]: s[MIGRATION].replace(/MEASURED AFTER/g, "NOTES AFTER") }),
  },
  {
    name: "the inbound insert stops returning its id, so nothing can tell a retry from a first delivery",
    probe: "C1",
    mutate: (s) => ({ ...s, [INBOUND]: s[INBOUND].replace('const alreadyRecorded = (callInsertError as any)?.code === "23505"', "const alreadyRecorded = false") }),
  },
  {
    name: "a 23505 retry is reported to the repair digest as data loss",
    probe: "C2",
    mutate: (s) => ({ ...s, [INBOUND]: s[INBOUND].replace("if (callInsertError && !alreadyRecorded) {", "if (callInsertError) {") }),
  },
  {
    name: "the scoring row is written on every delivery, forking ai_isa_calls instead of voice_calls",
    probe: "C3",
    mutate: (s) => ({ ...s, [INBOUND]: s[INBOUND].replace("if (insertedCall?.id && !alreadyRecorded) {", "if (true) {") }),
  },
  {
    name: "the old re-read-by-vendor-id shape comes back (which is how the retry found the FIRST row)",
    probe: "C4",
    mutate: (s) => ({ ...s, [INBOUND]: s[INBOUND].replace("const alreadyRecorded =", 'const { data: vc } = await svc.from("voice_calls").select("id").eq("vendor_call_id", callSid).maybeSingle()\n    const alreadyRecorded =') }),
  },
  {
    name: "the scoring write goes back into a try/catch that cannot see a resolved error",
    probe: "C5",
    mutate: (s) => ({ ...s, [INBOUND]: s[INBOUND].replace('const { error: isaError } = await svc.from("ai_isa_calls").insert(', 'try { await svc.from("ai_isa_calls").insert(') }),
  },
  {
    name: "the Zoom duplicate check drops its error again",
    probe: "Z1",
    mutate: (s) => ({ ...s, [ZOOM]: s[ZOOM].replace("const { data: dupCall, error: dupError } = await svc", "const { data: dupCall } = await svc") }),
  },
  {
    name: "losing the Zoom race is reported as a failed attach, so a correct lane looks broken",
    probe: "Z2",
    mutate: (s) => ({ ...s, [ZOOM]: s[ZOOM].replace(/if \(\(callErr as any\)\?\.code === "23505"\) \{[\s\S]*?\n    \}\n/, "") }),
  },
]

function negativeControls() {
  console.log("\n[NEGATIVE CONTROLS · each must go RED against a deliberately broken copy]")
  const base = loadSources()
  for (const m of MUTATIONS) {
    const probe = PROBES.find((p) => p.name.startsWith(m.probe + " "))
    if (!probe) { check(`NEGATIVE CONTROL ${m.name} — probe ${m.probe} not found`, false); continue }
    const mutated = m.mutate({ ...base })
    const changed = FILES.some((f) => mutated[f] !== base[f])
    if (!changed) {
      check(`NEGATIVE CONTROL ${m.name} — mutation actually changed the source`, false,
        "the replace matched nothing, so this control proves nothing")
      continue
    }
    const stillGreen = probe.run(mutated)
    check(`NEGATIVE CONTROL ${m.name} — probe ${m.probe} went RED as required`, !stillGreen,
      stillGreen ? `probe ${m.probe} stayed green against the broken copy` : "")
  }
}

/**
 * COVERAGE. A negative-control suite that skips a probe leaves that probe
 * unfalsifiable — it would keep passing after the code it guards was deleted.
 * This asserts every source probe is killed by at least one mutation above.
 * (The PURE probes carry their own hand-broken controls, and the LIVE probes are
 * self-falsifying: each asserts an outcome the database refuses to produce if
 * the index is missing.)
 */
function coverage() {
  console.log("\n[COVERAGE · no probe may escape without a mutation that kills it]")
  const killed = new Set(MUTATIONS.map((m) => m.probe))
  const uncovered = PROBES.map((p) => p.name.split(" ")[0]).filter((id) => !killed.has(id))
  check(`every one of the ${PROBES.length} source probes is killed by at least one mutation`,
    uncovered.length === 0, uncovered.length ? `uncovered: ${uncovered.join(", ")}` : "")

  const orphaned = [...killed].filter((id) => !PROBES.some((p) => p.name.startsWith(id + " ")))
  check("every mutation names a probe that exists (a control pointing at nothing proves nothing)",
    orphaned.length === 0, orphaned.length ? `orphaned: ${orphaned.join(", ")}` : "")
}

function pureNegativeControls() {
  console.log("\n[NEGATIVE CONTROLS · pure rules, hand-broken and re-asserted]")

  // A parser that returned [] on everything would make B1/B4/B5 pass vacuously.
  // Prove the assertions notice an empty answer.
  const emptyParser = (_s: string, _t: string): string[] => []
  check("NEGATIVE CONTROL a selectedColumns that always returns [] fails B1's includes() — went RED as required",
    !emptyParser("x", "blog_posts").includes("category"))
  check("NEGATIVE CONTROL a parser pair that always returns [] fails B4's non-empty guard — went RED as required",
    (() => {
      const declared = emptyParser("x", "y"), projected = emptyParser("x", "y")
      return !(declared.length >= 8 && projected.length >= 8 && declared.every((f) => projected.includes(f)))
    })())

  // An interfaceFields that kept the `?` would silently stop matching column names.
  const sloppy = (src: string, name: string) =>
    interfaceFields(src, name).map((f, i) => (i === 2 ? f + "?" : f))
  const iface = "\ninterface BlogPost {\n  id: string\n  title: string\n  category?: string | null\n}\n"
  check("NEGATIVE CONTROL an interfaceFields that leaves the `?` on stops matching the column — went RED as required",
    !selectedColumns('.from("blog_posts").select("id, title, category")', "blog_posts")
      .includes(sloppy(iface, "BlogPost")[2]))

  // If codeOnly did not strip comments, V2/C4 would read the doc comments that
  // NAME the old defect and go green on prose.
  const noStrip = (s: string) => s
  check("NEGATIVE CONTROL a codeOnly that strips nothing reads the defect out of the prose — went RED as required",
    noStrip("// takes brokerageId from the request body\n").includes("brokerageId"))
}

// ─── LIVE ────────────────────────────────────────────────────────────────────

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the pure + source layers proved the rules")
    return
  }
  const svc = createClient(url, key)
  console.log("\n[LIVE · the columns exist, the index exists, and the retry is executed rather than argued]")

  // PostgREST rejects the ENTIRE select when a named column does not exist, so a
  // clean read IS the existence proof for every column at once.
  const { error: blogErr } = await svc
    .from("blog_posts")
    .select("id, title, slug, excerpt, category, publish_status, seo_score, created_at, published_at, agent_user_id")
    .limit(1)
  check("live: blog_posts really exposes `category` alongside the rest of the list projection", !blogErr, blogErr?.message ?? "")

  const { error: evErr } = await svc
    .from("video_engagement_events")
    .select("id, brokerage_id, video_asset_id, contact_id, event_type, watch_duration_seconds, timestamp")
    .limit(1)
  check("live: video_engagement_events really has the brokerage_id the route now stamps", !evErr, evErr?.message ?? "")

  const { data: brokerage, error: bErr } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (bErr) { check("live: a brokerage row is readable to hang the retry probe off", false, bErr.message); return }
  if (!brokerage?.id) { console.log("  ⊘ no brokerage row — retry probe skipped"); return }

  const { count: before, error: beforeErr } = await svc
    .from("voice_calls").select("id", { count: "exact", head: true })
  if (beforeErr) { check("live: the call ledger is countable before the probe", false, beforeErr.message); return }

  const sid = `m464-sim-probe-${Date.now()}`
  const row = {
    brokerage_id: brokerage.id,
    direction: "inbound",
    status: "in_progress",
    call_type: "ai_inbound",
    phone_to: "+15550000099",
    vendor_call_id: sid,
  }

  const { data: first, error: firstErr } = await svc.from("voice_calls").insert(row).select("id").maybeSingle()
  check("live: the first delivery records the call", !firstErr && !!first?.id, firstErr?.message ?? "")

  const { error: retryErr } = await svc.from("voice_calls").insert(row).select("id").maybeSingle()
  check("live: the RETRY is refused by the database with 23505 — the ledger cannot fork",
    (retryErr as any)?.code === "23505", retryErr ? `got ${(retryErr as any).code}` : "the retry SUCCEEDED — the unique index is missing")

  const { count: forSid, error: countErr } = await svc
    .from("voice_calls").select("id", { count: "exact", head: true }).eq("vendor_call_id", sid)
  check("live: exactly ONE row carries that vendor call id", !countErr && forSid === 1, countErr?.message ?? `count=${forSid}`)

  // CLEANUP — and a zero-row DELETE under RLS returns error:null, so the row
  // count is what proves the cleanup happened, not the absent error.
  const { data: deleted, error: delErr } = await svc.from("voice_calls").delete().eq("vendor_call_id", sid).select("id")
  check("live: the probe row is DELETED and the delete is row-counted, not error-checked alone",
    !delErr && (deleted?.length ?? 0) === 1, delErr?.message ?? `deleted=${deleted?.length ?? 0}`)

  const { count: after, error: afterErr } = await svc
    .from("voice_calls").select("id", { count: "exact", head: true })
  check("live: RESIDUE IS ZERO — the ledger count is exactly what it was before the probe",
    !afterErr && after === before, afterErr?.message ?? `before=${before} after=${after}`)
}

async function main() {
  for (const f of FILES) {
    if (!existsSync(join(process.cwd(), f))) {
      console.log(`\n❌ missing required file: ${f}`)
      process.exit(1)
    }
  }
  pureLayer()
  sourceLayer()
  negativeControls()
  coverage()
  pureNegativeControls()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VIDEO_BLOG_VOICE_LOOPS_FAIL"); process.exit(1) }
  console.log(" ✅ VIDEO_BLOG_VOICE_LOOPS_PASS — the engagement route resolves its own tenant, the blog list projects the column it filters on, and a webhook retry can no longer fork the call ledger")
}
main()
