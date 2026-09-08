#!/usr/bin/env tsx
/**
 * scripts/readerless-write-census.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE "WRITE-ONLY COLUMN" CENSUS — the column-grained sibling of the two table-
 * grained sweeps that already exist:
 *
 *   · scripts/writerless-read-sweep.ts  — a table the code READS but never WRITES.
 *   · scripts/orphan-write-sweep.ts     — a TABLE the code WRITES but never READS.
 *
 * Both stop at the table boundary. A table can have a real, wired reader (a
 * dashboard card, a scorer) and STILL carry columns nobody has ever looked at —
 * `.from("agents").select("id, name")` reads `agents` and satisfies both sweeps
 * above while `agents.tier_updated_at` sits written and unread forever. That is
 * the class this census exists to find: a WRITTEN COLUMN WITH NO READER, on a
 * table that otherwise looks perfectly healthy.
 *
 * ── CORPUS ────────────────────────────────────────────────────────────────────
 * Every live table+column in scripts/schema-snapshot.ts (the code-referenced ∩
 * live-schema cache — see that file's header for what "live" means here) is
 * checked against:
 *   1. every runtime .ts/.tsx file (scripts/runtime-roots.ts `runtimeFiles()` —
 *      ALL directories that ship TypeScript, not just app/ + lib/, because a
 *      column's real reader is as likely to be a dashboard component under
 *      app/dashboard component files or a services/ file as an action);
 *   2. every migration in supabase/migrations/*.sql — INSERT/UPDATE backfills,
 *      inline and ALTER-TABLE CHECK constraints, CREATE POLICY (RLS) bodies,
 *      CREATE VIEW bodies, and trigger functions' NEW./OLD. touches. CLAUDE.md
 *      §3 traps: "a column written only by a migration backfill, an .rpc(), or a
 *      DB trigger reads as writerless without being writerless" — this is that
 *      check, built.
 *
 * ── WHY THIS REUSES scripts/schema-drift-guard.ts'S PARSER, NOT A NEW ONE ─────
 * schema-drift-guard.ts already solved "what columns does THIS .insert(…) /
 * .select(…) / .eq(…) actually name" — object literals, array-of-object
 * literals, `.insert(VAR)` resolved back to VAR's nearest definition, computed
 * `[CONST]: v` keys, conditional spreads, embedded-select resolution. Re-writing
 * that logic here would be a second, divergent copy of the exact class of parser
 * CLAUDE.md §2 warns is easy to get wrong (block-first stripping, brittle
 * windows) — and §6 rules two spellings of the same idea a defect. So this
 * script IMPORTS collectSelectArg / parseSelectColumns / resolveEmbeddedSelects /
 * matchBrace / matchParen / parseObjectTopLevelKeysDetailed /
 * resolveVariableInsertKeys / moduleStringConsts / loopStringSets /
 * contiguousChain / splitTopLevel from schema-drift-guard.ts and drives them
 * with a WRITE/READ sink instead of a drift Violation array. The TS-side write
 * detector below is therefore the same shape as schema-drift-guard's scanFile()
 * main loop by construction, not by care taken to match it.
 *
 * The SQL-side scanner (migrations) is new — schema-drift-guard never reads
 * .sql. SQL's `--` line comments have no TypeScript equivalent, so `sqlMask()`
 * strips those with a plain, non-flagged regex FIRST — before anything else
 * sees the text, so a `/*` sitting inside a `--` comment cannot survive to open
 * a phantom block comment later (the exact bug class CLAUDE.md §2 documents).
 * The `/* *\/` block-comment pass that follows is NOT a second hand-rolled
 * regex: it calls blankComments() from strip-comments.ts itself — the same
 * scanner every TS-side pass in this file uses — because that scanner's
 * quote-tracking already gives `/*`-inside-a-string the correct treatment, and
 * `npm run test:comment-strip-discipline` measured that a bespoke SQL block-
 * comment regex is the exact defect class it exists to ban, language-blind: a
 * self-authored `/\/\*[\s\S]*?\*\//g` failed that guard on THIS file before the
 * fix, and it was right to. See sqlMask()'s own header for the ordering
 * argument and its stated blind spot, and `runSelfTests()` for the controls.
 *
 * ── WHAT "WRITTEN" AND "READ" MEAN HERE ───────────────────────────────────────
 * WRITTEN: the column appears as a top-level object key inside `.insert(`,
 *   `.upsert(`, or `.update(` (literal object, array-of-objects, or a variable
 *   resolved to its nearest definition) chained off a `.from(table)`; OR as the
 *   left side of a top-level assignment in a migration's `INSERT INTO table
 *   (cols)` or `UPDATE table SET col = …`; OR as a `NEW.col := / =` assignment
 *   inside a trigger function bound to the table via `CREATE TRIGGER … ON table
 *   … EXECUTE FUNCTION fn`.
 * READ: the column appears in a `.select("…")` list (a bare `*` marks the WHOLE
 *   table read — every column of it, including columns reached only via
 *   destructuring/`row.col` after such a select, which this census does not
 *   verify field-by-field because select(*) already clears every column
 *   conservatively); as an embedded-select column on the EMBEDDED table
 *   (`alias:fk_column(col1, col2)`); as the first string argument to
 *   `.eq/.neq/.gt/.gte/.lt/.lte/.like/.ilike/.in/.is/.contains/.containedBy/
 *   .order/.not/.filter(`; as a column token inside `.or("col.op.val,…")`; as a
 *   bare-word match inside a migration's CHECK constraint expression, RLS
 *   policy body, or CREATE VIEW body; or as a `NEW.col`/`OLD.col` mention
 *   anywhere in a trigger function body bound to the table.
 *
 * A column read ONLY via CHECK/RLS/trigger (no app-level select/filter, no
 * migration SELECT/view) is NOT an offender — the database is a legitimate
 * reader — but it is reported SEPARATELY as "read only by the database" per
 * CLAUDE.md §3's instruction to check DB-only readers before calling a column
 * one-sided, and per this task's instruction to NAME that exemption class
 * rather than silently folding it into ordinary reads.
 *
 * ── EXEMPTIONS ────────────────────────────────────────────────────────────────
 *   · Bookkeeping columns: id / created_at / updated_at / brokerage_id, and the
 *     same "-style" shape (created_by, updated_by, deleted_at, deleted_by,
 *     is_deleted) — a foreign key or timestamp is not a feature waiting for a
 *     reader, it is plumbing every table carries.
 *   · SCRAPING_TABLES — the scraper-pipeline mechanics tables (lead_scraping_*,
 *     scraper_*, raw_scraped_leads, batchdata_motivated_sellers_raw,
 *     lead_deduplication_log, lead_enrichment_queue). Named below, listed in the
 *     summary, and skipped: their writers live in lib/kernel/scraping.ts,
 *     lib/external/*, app/actions/lead-intelligence.ts — files this lane is
 *     explicitly not allowed to touch (they belong to other lanes), so a finding
 *     here would be unactionable noise. This is NOT the whole lead-intelligence
 *     surface (lead_osint_data, google_search_activity, etc. are NOT scraping-
 *     pipeline mechanics and are left in scope) — narrowly the scraper/dedup/
 *     enrichment-queue infrastructure itself.
 *
 * ── STATED BLIND SPOTS (CLAUDE.md §2: publish them beside the number) ─────────
 *   · Dynamic column names — `.update({ [expr]: v })` where `expr` is not a
 *     module-level string const this file's moduleStringConsts()/loopStringSets()
 *     can resolve — are counted as unresolved by schema-drift-guard's own
 *     parser and therefore invisible to this census too. Neither WRITTEN nor
 *     READ is recorded for them; a column touched only this way can misreport
 *     as readerless (or as having no writer at all).
 *   · JSON/jsonb payload sub-fields are not modelled as separate columns. A
 *     jsonb column that is SELECTED but whose only USED key is never actually
 *     read by any consumer still counts as READ — the census cannot see inside
 *     the payload.
 *   · DB triggers/functions that exist only in the LIVE database and were never
 *     committed as a migration file are invisible (CLAUDE.md §3: "files are not
 *     the database" cuts both ways here — a live-only function is not visible
 *     to a file-based scan either).
 *   · CREATE VIEW attribution is bare-word column matching inside the view body
 *     bounded to the FROM/JOIN tables found in it — not a real SQL parse. It can
 *     over-count (a column name that also appears as an unrelated identifier in
 *     the same view) or under-count (a column reached through a join alias this
 *     scan does not resolve).
 *   · `.or("col.op.val")` DSL parsing takes the first dot-segment of each term
 *     as the column name — correct for a direct column, wrong for an EMBEDDED
 *     relation's filter (`"listing.status.eq.active"`), which is instead
 *     misattributed to a same-named column on the base table if one exists, or
 *     silently dropped if not. schema-drift-guard's full filter-DSL parser
 *     (classifyEmbedRelation etc.) was not pulled in for this — a bounded,
 *     documented approximation, not a claim of full DSL coverage.
 *   · Trigger/function-body scanning bounds `CREATE TRIGGER` to a 300-char
 *     lookahead window between `ON table` and `EXECUTE FUNCTION fn` (mirrors the
 *     documented 120/160/400-char window convention in the sibling sweeps) — an
 *     unusually long trigger definition could fall outside it.
 *
 * Run:      npx tsx scripts/readerless-write-census.ts --list
 * Baseline: READERLESS_WRITE_BASELINE=1 npx tsx scripts/readerless-write-census.ts
 * Enforce:  npx tsx scripts/readerless-write-census.ts   (exits 1 only when a
 *           committed baseline exists AND a finding outside it appears; with no
 *           baseline file present this is report-only, exit 0)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { runtimeFiles } from "./runtime-roots"
import { blankComments } from "./strip-comments"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import type { ComputedKeyResolver } from "./schema-drift-guard"

// schema-drift-guard.ts's own entry point runs its ENTIRE guard (a second
// report, printed self-tests, a mid-import process.exit on any failure) as a
// side effect of a plain `import` — its own header names the fix: set
// SCHEMA_DRIFT_AS_LIBRARY="1" BEFORE a dynamic import, exactly as
// scripts/opposite-missing-census.ts:99-100 does. A static top-level import is
// hoisted ahead of this assignment and would run the guard anyway, which is
// why this is a dynamic import rather than the usual `import { … } from`.
process.env.SCHEMA_DRIFT_AS_LIBRARY = "1"
const {
  collectSelectArg,
  parseSelectColumns,
  resolveEmbeddedSelects,
  matchBrace,
  matchParen,
  parseObjectTopLevelKeysDetailed,
  resolveVariableInsertKeys,
  moduleStringConsts,
  loopStringSets,
  contiguousChain,
} = await import("./schema-drift-guard")

const BASELINE = join(process.cwd(), "scripts/readerless-write-baseline.json")
const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations")

/** Bookkeeping columns every table carries — not a feature waiting for a reader. */
const BOOKKEEPING_EXACT = new Set(["id", "created_at", "updated_at", "brokerage_id"])
function isBookkeeping(col: string): boolean {
  return BOOKKEEPING_EXACT.has(col) || /^(created_by|updated_by|deleted_at|deleted_by|is_deleted)$/.test(col)
}

/** Scraper-PIPELINE MECHANICS tables — see header. Writers live in files this lane
 *  does not touch (lib/kernel/scraping.ts, lib/external/*, app/actions/lead-
 *  intelligence.ts), so a finding here would be unactionable. Narrowly the
 *  scraper/dedup/enrichment-queue infra, NOT the broader lead-intelligence
 *  provenance tables (lead_osint_data etc.), which stay in scope. */
const SCRAPING_TABLES = new Set([
  "lead_scraping_jobs", "lead_scraping_keywords", "lead_scraping_markets",
  "lead_scraping_motivated_params", "lead_scraping_property_params",
  "raw_scraped_leads", "scraper_actor_health", "scraper_executions",
  "lead_deduplication_log", "lead_enrichment_queue", "batchdata_motivated_sellers_raw",
])

/**
 * DB-ONLY-READ EXEMPTIONS, curated (CLAUDE.md §3: "a column written only by a
 * migration backfill, an .rpc(), or a DB trigger reads as writerless without
 * being writerless" — extended here to the SIBLING blind spot this scanner's
 * automatic dbOnlyReads bucket cannot see structurally: a UNIQUE INDEX
 * expression (no CHECK/RLS/trigger keyword the scanner looks for), or an RLS
 * POLICY defined ON A DIFFERENT TABLE that subqueries this column (the
 * CREATE-POLICY pass at scanSqlFileInto only tests the policy's OWN table's
 * columns against the body — a column named only inside a cross-table
 * subquery is invisible to it, by construction, not by omission).
 *
 * Each entry names the EXACT object VERIFIED present on disk — grep the cited
 * file:line before trusting an entry; a name that no longer matches on disk
 * is a stale exemption hiding a real regression, which is exactly what §2
 * warns a guard that cannot see its own subject looks like ("reports zero and
 * reads as a clean bill of health").
 *
 * Classified identically to the automatic dbOnlyReads bucket: NOT an offender,
 * reported separately.
 */
const DB_ONLY_READ_EXEMPTIONS: Record<string, string> = {
  "agent_intro_videos.trigger_year":
    "UNIQUE INDEX uq_agent_intro_videos_per_trigger (contact_id, agent_id, trigger, coalesce(trigger_year, 0)) — " +
    "supabase/migrations/m121-agent-intro-videos.sql:24 — the mechanism behind \"one anniversary video per " +
    "contact per YEAR\" (the 23505 branch lib/video/intro-video-reactor.ts:400+ depends on). Also documented " +
    "in-line at lib/video/intro-video-reactor.ts:387.",
  "ai_subscription_tier.admin_user_id":
    "RLS POLICY ai_usage_monthly_view ON public.ai_usage_monthly — supabase/migrations/" +
    "042-platform-role-superadmin-rename-fix.sql:30 — subqueries ai_subscription_tier.admin_user_id in all " +
    "three of its brokerage_id/team_id/agent_id arms (`... IN (SELECT ... FROM ai_subscription_tier WHERE " +
    "admin_user_id = auth.uid() AND is_active)`). scanSqlFileInto's CREATE POLICY pass only tests the policy's " +
    "OWN table (ai_usage_monthly) against its body; a column named only inside a cross-table subquery is " +
    "structurally invisible to it. Also documented at lib/security/authorization.ts:75-107.",
  "usage_counters.period_end":
    "UNIQUE(brokerage_id, period_start, period_end, metric) — scripts/120-create-usage-tracking-billing.sql:51 " +
    "— plus idx_usage_counters_lookup (same file:58) and the v_brokerage_ai_quota view's join predicate " +
    "`uc.period_end = (SELECT period_end FROM period)` — scripts/1054-ai-fair-use-quotas.sql:117-118. NOTE: " +
    "both founding files live under scripts/, not supabase/migrations/ — this census's SQL corpus " +
    "(MIGRATIONS_DIR) only reads supabase/migrations/*.sql, so this table's DDL sits structurally outside the " +
    "scan root. Recorded here rather than widening the scan root, which would change the corpus (and every " +
    "other table's count) for reasons unrelated to this column.",
}

/**
 * MIGRATION-ONLY-WRITE EXEMPTIONS — a column whose ONLY writer left in the
 * tree is a migration's own SELF-VERIFYING PROBE (an insert made, asserted
 * against, then deleted again within the SAME migration transaction — never a
 * production write path), where the application-level writer was DELETED on
 * purpose as a duplicate (orphan doctrine §1.1) and the tombstone recording
 * that is cited below. Distinct from DB_ONLY_READ_EXEMPTIONS: this is not "the
 * database reads it", it is "nothing outside this one migration file writes it
 * either, and that is the intended end state" — reported separately so the
 * count is not silently folded into ordinary readerless-write offenders OR
 * into DB-only reads, either of which would misname what actually happened.
 */
const MIGRATION_ONLY_WRITE_EXEMPTIONS: Record<string, string> = {
  "mail_response_tracking.response_metadata":
    "The application-level writer was REMOVED on purpose — TOMBSTONE at app/actions/direct-mail.ts:653 " +
    "(2026-09-07): \"response_metadata is NO LONGER WRITTEN HERE... It was a DUPLICATE (orphan doctrine §1.1). " +
    "SURVIVOR: direct_mail_responses.response_metadata\", because mail_response_tracking's only consumers " +
    "(app/api/cron/bundle-attribution-rollup/route.ts:166, lib/campaigns/roi-calculator.ts:316,812) read a " +
    "COUNT or id/type/contact/lead columns, never metadata — the twin write at app/api/qr/scan/route.ts was " +
    "dropped in the same edit. The ONLY remaining writer is supabase/migrations/" +
    "m491-a-lead-can-be-mailed-but-there-is-no-column-that-can-say-who-answered.sql:399-402, a SELF-VERIFYING " +
    "PROBE row inserted, asserted against, then explicitly deleted at line 454 within the same migration — " +
    "never a production write. The column is genuinely dead going forward; this is recorded rather than " +
    "reported as a live readerless write.",
}

// ─── EVIDENCE SINK ───────────────────────────────────────────────────────────
interface Evidence { tag: string; file: string }
type ColMap = Map<string, Map<string, Evidence[]>>

interface Sink {
  addWrite(table: string, col: string, tag: string, file: string): void
  addRead(table: string, col: string, tag: string, file: string): void
  addWholeRead(table: string, tag: string, file: string): void
}

function makeSink(writers: ColMap, readers: ColMap, wholeReads: Map<string, Evidence[]>): Sink {
  const push = (map: ColMap, table: string, col: string, tag: string, file: string) => {
    // Only real, live columns count — this is a census of the schema cache, not
    // a free-text scan; a mis-parsed key or a jsonb payload field that happens
    // to share a name with something else must not pollute the report.
    if (!SCHEMA_SNAPSHOT[table]?.includes(col)) return
    const byCol = map.get(table) ?? new Map<string, Evidence[]>()
    const arr = byCol.get(col) ?? []
    arr.push({ tag, file })
    byCol.set(col, arr)
    map.set(table, byCol)
  }
  return {
    addWrite: (t, c, tag, f) => push(writers, t, c, tag, f),
    addRead: (t, c, tag, f) => push(readers, t, c, tag, f),
    addWholeRead: (t, tag, f) => {
      const arr = wholeReads.get(t) ?? []
      arr.push({ tag, file: f })
      wholeReads.set(t, arr)
    },
  }
}

/** Nearest `const NAME = "…"` / `let NAME = "…"` string literal defined before
 *  `beforeIdx` — any case, any indentation (a LOCAL, function-scoped const),
 *  unlike moduleStringConsts() which only recognizes an ALL-CAPS top-level one.
 *  Same "nearest definition wins" discipline as resolveVariableInsertKeys(). */
function resolveNearestStringConst(src: string, name: string, beforeIdx: number): string | null {
  const re = new RegExp(`(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\$]|\\\\.)*\`)`, "g")
  let best: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m.index >= beforeIdx) break
    best = m[1].slice(1, -1)
  }
  return best
}

// ─── TS SIDE — reuses schema-drift-guard.ts's parser, driven into a sink ────
function scanTsSourceInto(rawSrc: string, file: string, sink: Sink) {
  // blankComments, not stripComments: every position below is computed from a
  // match index (collectSelectArg / matchBrace / matchParen all walk forward
  // from an offset), so the replacement must preserve character offsets. Same
  // discipline as schema-drift-guard.ts's scanFile() and CLAUDE.md §2's ruling
  // on the match-index case. A tombstone comment naming a retired query text
  // (e.g. lib/listing-health/health-scorer.ts's JSDoc block) is thereby blanked
  // to spaces before any regex runs over it — see runSelfTests() for the control.
  const src = blankComments(rawSrc)
  const fileConsts: ComputedKeyResolver = new Map<string, string | string[]>(moduleStringConsts(src))
  for (const [k, v] of loopStringSets(src)) if (!fileConsts.has(k)) fileConsts.set(k, v)

  const fromRe = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = fromRe.exec(src))) {
    const table = m[1]
    if (!(table in SCHEMA_SNAPSHOT)) continue

    // Contiguous chain hanging off THIS from(), before the next from() — the
    // same boundary schema-drift-guard.ts uses for insert/upsert/update.
    const after = src.slice(m.index)
    const nextFrom = after.slice(1).search(/\.from\(/)
    const chain = nextFrom >= 0 ? after.slice(0, nextFrom + 1) : after

    // ── SELECT (reads) ──────────────────────────────────────────────────────
    const sel = collectSelectArg(src, m.index)
    if (sel) {
      // A bare "*" segment marks the WHOLE table read. parseSelectColumns()
      // deliberately drops "*" (it is not a column name), so it is checked here
      // on the raw captured literal before that happens.
      if (/(^|,)\s*\*\s*(,|$)/.test(sel)) sink.addWholeRead(table, "select *", file)
      for (const c of parseSelectColumns(sel)) sink.addRead(table, c, "select", file)
      const emb = resolveEmbeddedSelects(sel, table)
      for (const e of emb.refs) {
        if (e.column === "count") continue // PostgREST related-row aggregate, not a column
        sink.addRead(e.table, e.column, "select(embed)", file)
      }
      for (const j of emb.joinRefs) sink.addRead(j.table, j.column, "select(join)", file)
    } else if (/\.select\(\s*\)/.test(chain)) {
      // `.select()` with NO ARGUMENT — PostgREST/supabase-js's own default is
      // `*` (the common `.insert({…}).select().single()` idiom to get the row
      // back), so this is a WHOLE-TABLE READ exactly like `.select("*")`.
      // MEASURED: app/actions/podcast-generation.ts's `.insert({…}).select()
      // .single()` reads the full row it just inserted (published_at,
      // external_episode_id, provider_response, error_message included) and
      // was invisible before this — `collectSelectArg` returns "" for empty
      // parens exactly as it does for a bare identifier, and empty string is
      // falsy in the `if (sel)` above.
      sink.addWholeRead(table, "select()", file)
    } else {
      // `.select(COLUMNS)` — a MODULE-LEVEL STRING CONST column list, not a
      // literal. Neither collectSelectArg() (schema-drift-guard.ts) nor this
      // census resolved this shape before: collectSelectArg only extracts
      // quoted literal PIECES from inside the parens, so a bare identifier
      // yields "". MEASURED: app/actions/custom-domains.ts declares
      // `const ROW_COLUMNS = "id, …, verification, error_detail, verified_at,
      // last_checked_at"` and every read goes through `.select(ROW_COLUMNS)` —
      // a real, wired reader that both this census and schema-drift-guard.ts's
      // OWN column-existence check were blind to before this. Only a BARE
      // identifier is resolved (no `foo + BAR`, no computed selector) — a
      // deliberately narrow, auditable extension of the same fileConsts map
      // already used for computed insert/update keys.
      const varSelM = chain.match(/\.select\(\s*([A-Za-z_$][\w$]*)\s*\)/)
      if (varSelM) {
        const resolved = fileConsts.get(varSelM[1])
        const resolvedText = Array.isArray(resolved)
          ? resolved.join(",")
          // moduleStringConsts only recognizes an ALL-CAPS, MODULE-LEVEL const —
          // `actionSelect` in lib/kernel/manager-activity.ts is a LOCAL, lowercase
          // `const actionSelect = "id, …, approved_at, executed_at"` reused across
          // three `.from(table).select(actionSelect)` calls in the same function,
          // invisible to that map for BOTH reasons. Resolved the same way
          // resolveVariableInsertKeys() resolves a `.insert(VAR)` shape: the
          // NEAREST same-named string const defined before THIS call site — scope-
          // safe against two functions reusing the same local name differently.
          : resolved ?? resolveNearestStringConst(src, varSelM[1], m.index)
        if (resolvedText) {
          if (/(^|,)\s*\*\s*(,|$)/.test(resolvedText)) sink.addWholeRead(table, "select *", file)
          for (const c of parseSelectColumns(resolvedText)) sink.addRead(table, c, "select(var)", file)
        }
      }
    }

    // ── INSERT/UPSERT/UPDATE literal object (writes) ────────────────────────
    const opM = chain.match(/\.(insert|upsert|update)\(\s*\{/)
    if (opM && opM.index != null) {
      const braceOpen = m.index + (opM.index + opM[0].length - 1)
      const braceClose = matchBrace(src, braceOpen)
      if (braceClose > braceOpen) {
        const obj = src.slice(braceOpen, braceClose + 1)
        const parsed = parseObjectTopLevelKeysDetailed(obj, fileConsts)
        for (const k of parsed.keys) sink.addWrite(table, k, opM[1], file)
      }
    }

    // ── INSERT/UPSERT array-of-objects literal (writes) ─────────────────────
    const arrM = chain.match(/\.(insert|upsert)\(\s*\[/)
    if (arrM && arrM.index != null) {
      const bracketOpen = m.index + (arrM.index + arrM[0].length - 1)
      let d = 0
      for (let i = bracketOpen; i < src.length; i++) {
        const ch = src[i]
        if (ch === "[") d++
        else if (ch === "]") { d--; if (d === 0) break }
        else if (ch === "{" && d === 1) {
          const bc = matchBrace(src, i)
          if (bc > i) {
            const rowParsed = parseObjectTopLevelKeysDetailed(src.slice(i, bc + 1), fileConsts)
            for (const k of rowParsed.keys) sink.addWrite(table, k, arrM[1], file)
            i = bc
          }
        }
      }
    }

    // ── INSERT/UPSERT/UPDATE(VARIABLE) (writes) ─────────────────────────────
    const varM = chain.match(/\.(insert|upsert|update)\(\s*([a-zA-Z_$][\w$]*)\s*\)/)
    if (varM && varM.index != null && !["true", "false", "null"].includes(varM[2])) {
      for (const k of resolveVariableInsertKeys(src, varM[2], m.index + varM.index)) {
        sink.addWrite(table, k, `${varM[1]}(var)`, file)
      }
    }

    // ── FILTER/ORDER column args (reads) ─────────────────────────────────────
    const chainStart = m.index + m[0].length
    const filterChain = contiguousChain(src, chainStart)
    for (const fm of filterChain.matchAll(
      /\.(eq|neq|gt|gte|lt|lte|like|ilike|in|is|contains|containedBy|order|not)\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_.]*)["'`]/g,
    )) {
      const col = fm[2]
      if (col.includes(".")) continue // embed path — not a column on THIS table
      sink.addRead(table, col, fm[1], file)
    }
    // `.eq(CONST, val)` etc. — an IDENTIFIER first arg, resolved through the
    // SAME module-string-const map the write side already uses (fileConsts,
    // built above from moduleStringConsts()/loopStringSets()). Mirrors the
    // `.select(CONST)` resolution a few lines up: a shared const naming a
    // column (the `contact_suppression_list.mailing_address_key` shape —
    // `export const ADDRESS_SUPPRESSION_COLUMN = "mailing_address_key" as
    // const`, written via `[ADDRESS_SUPPRESSION_COLUMN]: …` and read via
    // `.eq(ADDRESS_SUPPRESSION_COLUMN, …)`) was previously invisible on the
    // READ side only, so a column both written and read through the same
    // const misreported as write-only. Resolved ONLY to a single string —
    // a name loopStringSets() bound to an ARRAY names a column per loop
    // iteration and stays the write side's business, not guessed here as a
    // filter value. `true`/`false`/`null`/`undefined` are excluded because
    // they are never in fileConsts anyway, named for clarity at the call site.
    for (const fm of filterChain.matchAll(
      /\.(eq|neq|gt|gte|lt|lte|like|ilike|in|is|contains|containedBy|order|not)\(\s*([a-zA-Z_$][\w$]*)\s*[,)]/g,
    )) {
      const ident = fm[2]
      if (["true", "false", "null", "undefined"].includes(ident)) continue
      const resolved = fileConsts.get(ident)
      if (typeof resolved === "string") sink.addRead(table, resolved, `${fm[1]}(const)`, file)
    }
    for (const fm of filterChain.matchAll(/\.filter\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]/g)) {
      sink.addRead(table, fm[1], "filter", file)
    }
    // `.or("col.op.val,col2.op.val2")` — first dot-segment of each comma term.
    // See STATED BLIND SPOTS: wrong for an embedded relation's filter term.
    for (const fm of filterChain.matchAll(/\.or\(\s*["'`]([^"'`]+)["'`]/g)) {
      for (const term of fm[1].split(",")) {
        const col = term.trim().split(".")[0]
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) sink.addRead(table, col, "or", file)
      }
    }
  }
}

// ─── SQL SIDE — migrations. `--` line comments PLUS strip-comments.ts's own
// block-comment scanner — NOT a second hand-rolled masker. ─────────────────
//
// The first version of sqlMask() here hand-rolled BOTH a `/\/\*[\s\S]*?\*\//g`
// block-comment regex AND a `/'(?:[^'\\]|\\.|'')*'/gs` quote-pairing regex to
// mask string literals first. `npm run test:comment-strip-discipline` caught
// both on this file, correctly: CLAUDE.md §2's rule ("Never hand-roll a
// comment stripper... Use blankComments") does not carve out an exception for
// "but it's SQL, not TypeScript" — a self-authored block-comment regex is the
// exact defect class the guard exists to ban, in any language, because the
// same failure shape applies: a `/*` sitting inside a string is not supposed
// to open a comment, and a hand-written regex is exactly the thing that gets
// this wrong under adversarial or merely unlucky input.
//
// blankComments() genuinely does not know SQL's `--` line comments (only `//`)
// or its doubled `''` string-escape convention — so it cannot replace this
// function outright. What it DOES do, correctly, or the TWO-delimiter case
// (`/*`/`*/`) is track quotes while hunting for a comment opener, so a `/*`
// inside a quoted string is not mistaken for one — the exact protection the
// retired hand-rolled block regex existed to approximate, now delegated to the
// one audited scanner instead of re-proven here. `{ jsx: false }` because this
// text is SQL, not TSX — a bare `<` must never be read as opening an element.
//
// `--` line comments are stripped FIRST, before that call — not because this
// shape was itself flagged (the guard's line-comment rule is keyed to `//`,
// which SQL does not use), but for the same reason CLAUDE.md §2 orders every
// other pass here: a `/*` sitting inside a `--` comment must be blanked away
// BEFORE the block-comment scan ever sees it, or it would open a phantom block
// comment that swallows real code below. See runSelfTests() for the control.
//
// STATED BLIND SPOT: blankComments() tracks SQL's doubled `''` string escape
// as two adjacent single-quoted strings (JS has no doubled-quote escape), so an
// apostrophe-heavy string literal could in rare cases desynchronize its quote
// tracking. Not a hand-rolled masker's failure mode — inherited from feeding a
// TS-shaped scanner text it was not built for, and no more dangerous than
// leaving `/* */` unrecognized inside a string entirely.
function sqlMask(text: string): string {
  const masked = text.replace(/--[^\n]*/g, (s) => " ".repeat(s.length))
  return blankComments(masked, { jsx: false })
}

/** Top-level comma split, quote- (') and paren-depth aware — splitTopLevel() in
 *  schema-drift-guard.ts only tracks `"`, which is not SQL's string delimiter. */
function splitSqlTopLevel(s: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let q: string | null = null
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) { if (ch === q && s[i - 1] !== "\\") q = null; continue }
    if (ch === "'" || ch === '"') { q = ch; continue }
    if (ch === "(") depth++
    else if (ch === ")") depth--
    else if (ch === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1 }
  }
  parts.push(s.slice(start))
  return parts
}

function scanChecksInto(body: string, table: string, file: string, tag: string, sink: Sink) {
  const checkRe = /\bCHECK\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = checkRe.exec(body))) {
    const open = m.index + m[0].length - 1
    const close = matchParen(body, open)
    if (close < 0) continue
    const expr = body.slice(open + 1, close)
    for (const col of SCHEMA_SNAPSHOT[table] ?? []) {
      if (new RegExp(`\\b${col}\\b`).test(expr)) sink.addRead(table, col, tag, file)
    }
  }
}

/** `masked` must already be sqlMask()'d — callers pass the same masked text they
 *  build once per migration file so it is not re-masked per scanner. */
function scanSqlFileInto(masked: string, file: string, sink: Sink) {
  // INSERT INTO table (cols) — migration seed/backfill data.
  const insRe = /INSERT\s+INTO\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = insRe.exec(masked))) {
    const table = m[1]
    if (!(table in SCHEMA_SNAPSHOT)) continue
    const open = m.index + m[0].length - 1
    const close = matchParen(masked, open)
    if (close < 0) continue
    for (const raw of masked.slice(open + 1, close).split(",")) {
      const col = raw.trim().replace(/^"|"$/g, "")
      if (/^[a-z_][a-z0-9_]*$/.test(col)) sink.addWrite(table, col, "sql:insert", file)
    }
  }

  // UPDATE table SET col = … — migration backfill.
  const updRe = /UPDATE\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+SET\s+/gi
  while ((m = updRe.exec(masked))) {
    const table = m[1]
    if (!(table in SCHEMA_SNAPSHOT)) continue
    const start = m.index + m[0].length
    const window = masked.slice(start, Math.min(masked.length, start + 4000))
    const endMatch = window.search(/\bWHERE\b|\bRETURNING\b|;/i)
    const setText = endMatch >= 0 ? window.slice(0, endMatch) : window
    for (const seg of splitSqlTopLevel(setText, ",")) {
      const cm = seg.match(/^\s*"?([a-z_][a-z0-9_]*)"?\s*=(?!=)/i)
      if (cm) sink.addWrite(table, cm[1], "sql:update", file)
    }
  }

  // CREATE TABLE (...) — inline column CHECK(...) constraints (DB reads).
  const ctRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi
  while ((m = ctRe.exec(masked))) {
    const table = m[1]
    if (!(table in SCHEMA_SNAPSHOT)) continue
    const open = m.index + m[0].length - 1
    const close = matchParen(masked, open)
    if (close < 0) continue
    scanChecksInto(masked.slice(open + 1, close), table, file, "sql:check", sink)
  }

  // ALTER TABLE table ADD CONSTRAINT name CHECK (...) (DB reads).
  const alterCheckRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+ADD\s+CONSTRAINT\s+"?[a-z0-9_]*"?\s+CHECK\s*\(/gi
  while ((m = alterCheckRe.exec(masked))) {
    const table = m[1]
    if (!(table in SCHEMA_SNAPSHOT)) continue
    const open = m.index + m[0].length - 1
    const close = matchParen(masked, open)
    if (close < 0) continue
    const expr = masked.slice(open + 1, close)
    for (const col of SCHEMA_SNAPSHOT[table]) if (new RegExp(`\\b${col}\\b`).test(expr)) sink.addRead(table, col, "sql:check", file)
  }

  // CREATE POLICY … ON table … USING (…) / WITH CHECK (…) (RLS — DB reads).
  const polRe = /CREATE\s+POLICY\s+"?[^"\n]*"?\s+ON\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+/gi
  while ((m = polRe.exec(masked))) {
    const table = m[1]
    if (!(table in SCHEMA_SNAPSHOT)) continue
    const start = m.index + m[0].length
    const window = masked.slice(start, Math.min(masked.length, start + 4000))
    const semi = window.indexOf(";")
    const policyText = semi >= 0 ? window.slice(0, semi) : window
    for (const col of SCHEMA_SNAPSHOT[table]) if (new RegExp(`\\b${col}\\b`).test(policyText)) sink.addRead(table, col, "sql:rls", file)
  }

  // CREATE VIEW name AS SELECT … FROM/JOIN table … — best-effort (see blind spots).
  const viewRe = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?"?[a-z_][a-z0-9_]*"?\s+AS\s+/gi
  while ((m = viewRe.exec(masked))) {
    const start = m.index + m[0].length
    const window = masked.slice(start, Math.min(masked.length, start + 6000))
    const semi = window.search(/;\s*(?:\n|$)/)
    const body = semi >= 0 ? window.slice(0, semi) : window
    const fromTables = new Set<string>()
    for (const fm of body.matchAll(/\b(?:FROM|JOIN)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      if (fm[1] in SCHEMA_SNAPSHOT) fromTables.add(fm[1])
    }
    for (const table of fromTables) {
      for (const col of SCHEMA_SNAPSHOT[table]) if (new RegExp(`\\b${col}\\b`).test(body)) sink.addRead(table, col, "sql:view", file)
    }
  }
}

interface FnBody { file: string; body: string }

/** `CREATE [OR REPLACE] FUNCTION name(args) … AS $tag$ body $tag$` across every
 *  migration — the same function may be redefined across migrations; the FIRST
 *  definition found wins (files are read in directory order, which for this
 *  repo's `mNNN-*.sql` naming is chronological). */
function buildFunctionBodies(files: Array<{ file: string; masked: string }>): Map<string, FnBody> {
  const map = new Map<string, FnBody>()
  const fnRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi
  for (const { file, masked } of files) {
    let m: RegExpExecArray | null
    while ((m = fnRe.exec(masked))) {
      const name = m[1]
      if (map.has(name)) continue
      const argOpen = m.index + m[0].length - 1
      const argClose = matchParen(masked, argOpen)
      const searchFrom = argClose > argOpen ? argClose + 1 : m.index + m[0].length
      const rest = masked.slice(searchFrom)
      const dq = rest.match(/\$([a-zA-Z_]*)\$/)
      if (!dq || dq.index == null) continue
      const openIdx = searchFrom + dq.index + dq[0].length
      const closeRel = masked.slice(openIdx).indexOf(dq[0])
      if (closeRel < 0) continue
      map.set(name, { file, body: masked.slice(openIdx, openIdx + closeRel) })
    }
  }
  return map
}

/** `CREATE TRIGGER name … ON table … EXECUTE FUNCTION fn(` — bounded 300-char
 *  lookahead windows on both gaps (see STATED BLIND SPOTS). */
function findTriggers(files: Array<{ file: string; masked: string }>): Array<{ table: string; fn: string; file: string }> {
  const out: Array<{ table: string; fn: string; file: string }> = []
  const trigRe =
    /CREATE\s+TRIGGER\s+"?[a-z0-9_]*"?\s+[\s\S]{0,300}?\bON\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+[\s\S]{0,300}?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi
  for (const { file, masked } of files) {
    let m: RegExpExecArray | null
    while ((m = trigRe.exec(masked))) out.push({ table: m[1], fn: m[2], file })
  }
  return out
}

function scanTriggersInto(
  triggers: Array<{ table: string; fn: string; file: string }>,
  fnBodies: Map<string, FnBody>,
  sink: Sink,
) {
  for (const { table, fn } of triggers) {
    if (!(table in SCHEMA_SNAPSHOT)) continue
    const fb = fnBodies.get(fn)
    if (!fb) continue
    for (const col of SCHEMA_SNAPSHOT[table]) {
      if (new RegExp(`\\bNEW\\.${col}\\b\\s*:?=(?!=)`, "i").test(fb.body)) {
        sink.addWrite(table, col, `sql:trigger-write(${fn})`, fb.file)
      }
      if (new RegExp(`\\b(NEW|OLD)\\.${col}\\b`, "i").test(fb.body)) {
        sink.addRead(table, col, `sql:trigger-read(${fn})`, fb.file)
      }
    }
  }
}

/**
 * `.rpc("fn", …)` calls the TS side makes, resolved back to `fn`'s SQL body (a
 * Postgres FUNCTION, unlike a trigger, is not bound to one table by its
 * CREATE statement — a table it touches is found the same way CREATE VIEW
 * attribution finds one: FROM/JOIN/UPDATE/INTO followed by a known table name).
 *
 * WHY THIS EXISTS: CLAUDE.md §3's own trap list names it — "a column written
 * only by a migration backfill, an .rpc(), or a DB trigger reads as writerless
 * without being writerless." `contact_memory` is exactly this shape:
 * lib/agents/contact-memory.ts writes it directly via `.insert()` and reads it
 * ONLY through `.rpc("contact_memory_recall", …)`, whose body (a `SELECT …
 * FROM contact_memory m WHERE …`) is plain SQL text once resolved — this
 * function is what makes that SELECT count as a read instead of leaving five
 * real columns reported as write-only. Bare-word matching, same caveat as
 * scanChecksInto/CREATE VIEW: a real reference, not a full SQL parse — a
 * column name that also collides with an unrelated identifier in the same
 * function body would over-count. Stated in BLIND SPOTS below.
 */
function scanRpcFunctionsInto(rpcNames: Set<string>, fnBodies: Map<string, FnBody>, sink: Sink) {
  for (const name of rpcNames) {
    const fb = fnBodies.get(name)
    if (!fb) continue
    const tables = new Set<string>()
    for (const fm of fb.body.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      if (fm[1] in SCHEMA_SNAPSHOT) tables.add(fm[1])
    }
    for (const table of tables) {
      for (const col of SCHEMA_SNAPSHOT[table]) {
        if (new RegExp(`\\b${col}\\b`).test(fb.body)) sink.addRead(table, col, `sql:rpc(${name})`, fb.file)
      }
    }
  }
}

// ─── SELF-TEST — POSITIVE and NEGATIVE controls (CLAUDE.md §2: "every absence
// assertion needs a positive control"; a broken detector and a clean tree both
// report zero). Run BEFORE the real scan; a failure here means the census
// cannot be trusted and it exits 1 without ever looking at the tree. ─────────
function runSelfTests(): string[] {
  const fails: string[] = []
  const check = (name: string, cond: boolean) => { if (!cond) fails.push(name) }

  // POSITIVE — a planted written-only column (real table `agents`, real column
  // `career_tier`, which nothing in this snippet reads) is FOUND.
  {
    const writers: ColMap = new Map(), readers: ColMap = new Map(), whole = new Map<string, Evidence[]>()
    const sink = makeSink(writers, readers, whole)
    scanTsSourceInto('await supabase.from("agents").insert({ career_tier: "gold", agent_id: a })', "spec.ts", sink)
    check("TS positive: planted write-only column is found", (writers.get("agents")?.get("career_tier")?.length ?? 0) > 0)
    check("TS positive: no phantom read recorded for it", !readers.get("agents")?.has("career_tier"))
  }

  // NEGATIVE — a column read via `select("*")` is NOT accused: the whole table
  // is marked read, which must clear every column of it.
  {
    const writers: ColMap = new Map(), readers: ColMap = new Map(), whole = new Map<string, Evidence[]>()
    const sink = makeSink(writers, readers, whole)
    scanTsSourceInto('await supabase.from("agents").select("*")', "spec.ts", sink)
    check("TS negative: select(*) marks the whole table read", (whole.get("agents")?.length ?? 0) > 0)
  }

  // NEGATIVE — a TOMBSTONE comment quoting an old query is NOT a live reader
  // (the exact class CLAUDE.md §2 documents: five guards failed on this shape
  // on 2026-08-23 by reading raw source instead of blankComments()'d text).
  {
    const writers: ColMap = new Map(), readers: ColMap = new Map(), whole = new Map<string, Evidence[]>()
    const sink = makeSink(writers, readers, whole)
    scanTsSourceInto(
      '// old: .from("agents").select("career_tier") — moved to agent_pl_snapshot, see scripts/readerless-write-census.ts:1\nconst x = 1',
      "spec.ts",
      sink,
    )
    check("TS negative: a tombstone comment is not a reader", !readers.get("agents")?.has("career_tier"))
  }

  // POSITIVE — `.select(CONST)` where CONST is a module-level string const
  // (the ROW_COLUMNS shape in app/actions/custom-domains.ts) is a READ, not a
  // silent miss.
  {
    const writers: ColMap = new Map(), readers: ColMap = new Map(), whole = new Map<string, Evidence[]>()
    const sink = makeSink(writers, readers, whole)
    scanTsSourceInto(
      'const ROW_COLUMNS = "id, career_tier"\nawait supabase.from("agents").select(ROW_COLUMNS)',
      "spec.ts",
      sink,
    )
    check("TS positive: .select(CONST) resolves the module-level string const", (readers.get("agents")?.get("career_tier")?.length ?? 0) > 0)
  }

  // POSITIVE — `.insert({…}).select()` with EMPTY parens is the PostgREST
  // default (`*`) and marks the whole table read, same as `.select("*")`.
  {
    const writers: ColMap = new Map(), readers: ColMap = new Map(), whole = new Map<string, Evidence[]>()
    const sink = makeSink(writers, readers, whole)
    scanTsSourceInto('await supabase.from("agents").insert({ career_tier: "gold" }).select().single()', "spec.ts", sink)
    check("TS positive: .select() with no args is a whole-table read", (whole.get("agents")?.length ?? 0) > 0)
  }

  // POSITIVE — `.select(localVar)` where localVar is a LOCAL (indented,
  // lowercase) string const, reused across two `.from()` calls, resolves via
  // the nearest-definition-before-this-call rule (the manager-activity.ts
  // `actionSelect` shape).
  {
    const writers: ColMap = new Map(), readers: ColMap = new Map(), whole = new Map<string, Evidence[]>()
    const sink = makeSink(writers, readers, whole)
    scanTsSourceInto(
      'function f() {\n  const rowSelect = "id, career_tier"\n  supabase.from("agents").select(rowSelect)\n}',
      "spec.ts",
      sink,
    )
    check("TS positive: .select(localVar) resolves the nearest local string const", (readers.get("agents")?.get("career_tier")?.length ?? 0) > 0)
  }

  // POSITIVE — `.eq(CONST, val)` where CONST is a module-level string const
  // resolves the filter column (the contact_suppression_list.mailing_address_key
  // shape — a shared const spelling the SAME column name on both the write
  // and the read side must not read as write-only just because the read
  // side's identifier is not a quoted literal).
  {
    const writers: ColMap = new Map(), readers: ColMap = new Map(), whole = new Map<string, Evidence[]>()
    const sink = makeSink(writers, readers, whole)
    scanTsSourceInto(
      'export const ADDRESS_SUPPRESSION_COLUMN = "career_tier" as const\n' +
        'await supabase.from("agents").insert({ [ADDRESS_SUPPRESSION_COLUMN]: key })\n' +
        'await supabase.from("agents").select("id").eq(ADDRESS_SUPPRESSION_COLUMN, key)',
      "spec.ts",
      sink,
    )
    check(
      "TS positive: .eq(CONST, …) resolves the module-level string const to a read",
      (readers.get("agents")?.get("career_tier")?.length ?? 0) > 0,
    )
  }

  // NEGATIVE — an identifier `.eq()` arg that is NOT a resolvable module
  // string const (an ordinary local variable, e.g. a loop index or a value
  // being filtered FOR) must not be misread as a column named after that
  // variable — proves the resolver only fires on an actual fileConsts hit,
  // never on the bare identifier text itself.
  {
    const writers: ColMap = new Map(), readers: ColMap = new Map(), whole = new Map<string, Evidence[]>()
    const sink = makeSink(writers, readers, whole)
    scanTsSourceInto(
      'const someAgentId = "a1"\nawait supabase.from("agents").select("id").eq(someAgentId, true)',
      "spec.ts",
      sink,
    )
    check(
      "TS negative: an unresolvable identifier .eq() arg invents no column named after itself",
      !readers.get("agents")?.has("someAgentId"),
    )
  }

  // POSITIVE — a migration backfill `UPDATE … SET col = …` is a WRITE.
  {
    const writers: ColMap = new Map(), readers: ColMap = new Map(), whole = new Map<string, Evidence[]>()
    const sink = makeSink(writers, readers, whole)
    scanSqlFileInto(sqlMask("UPDATE agents SET career_tier = 'gold' WHERE id = '00000000-0000-0000-0000-000000000000';"), "spec.sql", sink)
    check("SQL positive: a migration backfill UPDATE is a write", (writers.get("agents")?.get("career_tier")?.length ?? 0) > 0)
  }

  // POSITIVE — a CHECK constraint referencing the column is a DB READ.
  {
    const writers: ColMap = new Map(), readers: ColMap = new Map(), whole = new Map<string, Evidence[]>()
    const sink = makeSink(writers, readers, whole)
    scanSqlFileInto(
      sqlMask("ALTER TABLE agents ADD CONSTRAINT agents_career_tier_check CHECK (career_tier IN ('bronze', 'gold'));"),
      "spec.sql",
      sink,
    )
    check("SQL positive: a CHECK constraint is a DB read", (readers.get("agents")?.get("career_tier")?.length ?? 0) > 0)
  }

  // NEGATIVE — a `--` line comment containing what LOOKS like an UPDATE is not
  // scanned as code (proves sqlMask()'s `--` pass runs before blankComments()
  // sees the text, so commented-out SQL never counts as a write).
  {
    const writers: ColMap = new Map(), readers: ColMap = new Map(), whole = new Map<string, Evidence[]>()
    const sink = makeSink(writers, readers, whole)
    scanSqlFileInto(sqlMask("-- UPDATE agents SET career_tier = 'gold';\nSELECT 1;"), "spec.sql", sink)
    check("SQL negative: a commented-out UPDATE is not a write", !writers.get("agents")?.has("career_tier"))
  }

  // NEGATIVE — a `/* */` block comment containing a fake UPDATE is not scanned,
  // and a string literal containing `/*` does not open a phantom block comment
  // that swallows the REAL statement after it (the block-first bug class).
  {
    const writers: ColMap = new Map(), readers: ColMap = new Map(), whole = new Map<string, Evidence[]>()
    const sink = makeSink(writers, readers, whole)
    scanSqlFileInto(
      sqlMask("UPDATE agents SET bio = 'note: /* not a real comment */' WHERE id = '00000000-0000-0000-0000-000000000000';\n/* UPDATE agents SET career_tier = 'gold'; */"),
      "spec.sql",
      sink,
    )
    check("SQL negative: block comment is not a write", !writers.get("agents")?.has("career_tier"))
    check("SQL positive: a string containing /* does not swallow the real UPDATE it sits inside", (writers.get("agents")?.get("bio")?.length ?? 0) > 0)
  }

  // POSITIVE — every curated exemption key names a table.column that ACTUALLY
  // EXISTS in the live schema cache. A stale exemption (a renamed or dropped
  // column) would silently exempt nothing while still reading as "handled" —
  // exactly the "reports zero and reads as a clean bill of health" failure
  // CLAUDE.md §2 names. This is that check for the two curated maps.
  for (const key of [...Object.keys(DB_ONLY_READ_EXEMPTIONS), ...Object.keys(MIGRATION_ONLY_WRITE_EXEMPTIONS)]) {
    const dot = key.indexOf(".")
    const table = key.slice(0, dot)
    const col = key.slice(dot + 1)
    check(`curated exemption "${key}" names a live schema column`, !!SCHEMA_SNAPSHOT[table]?.includes(col))
  }

  return fails
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
interface Finding { column: string; evidence: Evidence[] }

function main() {
  const listMode = process.argv.includes("--list")

  const selfTestFailures = runSelfTests()
  if (selfTestFailures.length > 0) {
    console.log("══════════════════════════════════════════════════")
    console.log(" ✗ SELF-TEST FAILURE — the detector cannot be trusted; the tree was not scanned")
    console.log("══════════════════════════════════════════════════")
    for (const f of selfTestFailures) console.log(`  · ${f}`)
    process.exit(1)
  }

  const writers: ColMap = new Map()
  const readers: ColMap = new Map()
  const wholeReads = new Map<string, Evidence[]>()
  const sink = makeSink(writers, readers, wholeReads)

  // ── TS corpus — every directory that ships TypeScript, not just app/+lib/. ──
  const tsFiles = runtimeFiles(process.cwd())
  const rpcNames = new Set<string>()
  for (const f of tsFiles) {
    let raw: string
    try { raw = readFileSync(f, "utf8") } catch { continue }
    scanTsSourceInto(raw, f.replace(process.cwd() + "/", ""), sink)
    for (const rm of blankComments(raw).matchAll(/\.rpc\(\s*["'`](\w+)["'`]/g)) rpcNames.add(rm[1])
  }

  // ── SQL corpus — supabase/migrations/*.sql. ──────────────────────────────
  let migFiles: string[] = []
  try {
    migFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => join(MIGRATIONS_DIR, f))
  } catch { /* no migrations directory — SQL corpus is empty, not fatal */ }
  const masked: Array<{ file: string; masked: string }> = []
  for (const f of migFiles) {
    let raw: string
    try { raw = readFileSync(f, "utf8") } catch { continue }
    const rel = f.replace(process.cwd() + "/", "")
    const m = sqlMask(raw)
    masked.push({ file: rel, masked: m })
    scanSqlFileInto(m, rel, sink)
  }
  const fnBodies = buildFunctionBodies(masked)
  const triggers = findTriggers(masked)
  scanTriggersInto(triggers, fnBodies, sink)
  scanRpcFunctionsInto(rpcNames, fnBodies, sink)

  // ── Classify every live table+column ─────────────────────────────────────
  const tables = Object.keys(SCHEMA_SNAPSHOT).sort()
  let totalCols = 0
  let scrapingSkipped = 0
  let bookkeepingExempt = 0
  let totalWritten = 0
  let totalRead = 0
  const dbOnlyReads: Array<{ table: string; column: string; tags: string[] }> = []
  const migrationOnlyWrites: Array<{ table: string; column: string; reason: string }> = []
  const findingsByTable = new Map<string, Finding[]>()

  for (const table of tables) {
    const isScraping = SCRAPING_TABLES.has(table)
    for (const col of SCHEMA_SNAPSHOT[table]) {
      totalCols++
      if (isScraping) { scrapingSkipped++; continue }
      if (isBookkeeping(col)) { bookkeepingExempt++; continue }

      const key = `${table}.${col}`

      const wEv = writers.get(table)?.get(col) ?? []
      const rEvDirect = readers.get(table)?.get(col) ?? []
      const rEvWhole = wholeReads.get(table) ?? []
      const isWritten = wEv.length > 0
      const isRead = rEvDirect.length > 0 || rEvWhole.length > 0
      if (isWritten) totalWritten++
      if (isRead) totalRead++

      // Curated exemptions run BEFORE the offender bucket — each is a case the
      // scanner cannot see structurally (a cross-table RLS subquery, a UNIQUE
      // INDEX expression, or a founding DDL file outside the scan root), not a
      // free pass on a column the scanner simply missed by bug. See the two
      // maps' own headers for what distinguishes them from each other and from
      // the automatic dbOnlyReads bucket below.
      if (key in DB_ONLY_READ_EXEMPTIONS) {
        dbOnlyReads.push({ table, column: col, tags: ["curated-exemption"] })
        continue
      }
      if (key in MIGRATION_ONLY_WRITE_EXEMPTIONS) {
        migrationOnlyWrites.push({ table, column: col, reason: MIGRATION_ONLY_WRITE_EXEMPTIONS[key] })
        continue
      }

      if (isWritten && !isRead) {
        const arr = findingsByTable.get(table) ?? []
        arr.push({ column: col, evidence: wEv })
        findingsByTable.set(table, arr)
      } else if (isWritten && isRead) {
        const dbTags = rEvDirect.filter((e) => /^sql:(check|rls|trigger-read)/.test(e.tag)).map((e) => e.tag)
        const appTags = rEvDirect.filter((e) => !/^sql:(check|rls|trigger-read)/.test(e.tag))
        if (dbTags.length > 0 && appTags.length === 0 && rEvWhole.length === 0) {
          dbOnlyReads.push({ table, column: col, tags: [...new Set(dbTags)] })
        }
      }
    }
  }

  // Densest table first — the report burns down biggest offenders first.
  const sortedTables = [...findingsByTable.entries()]
    .map(([t, arr]) => [t, arr.sort((a, b) => a.column.localeCompare(b.column))] as const)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))

  const offenderKeys: string[] = []
  for (const [table, arr] of sortedTables) for (const f of arr) offenderKeys.push(`${table}.${f.column}`)

  if (process.env.READERLESS_WRITE_BASELINE === "1") {
    writeFileSync(BASELINE, JSON.stringify(offenderKeys, null, 2) + "\n")
    console.log(`⚙ wrote baseline: ${offenderKeys.length} readerless-write columns`)
  }

  console.log("══════════════════════════════════════════════════")
  console.log(" READERLESS-WRITE CENSUS — columns written, never read")
  console.log("══════════════════════════════════════════════════")
  console.log(` ${tables.length} tables in schema-snapshot · ${totalCols} columns scanned`)
  console.log(` ${scrapingSkipped} columns skipped — SCRAPING_TABLES (${[...SCRAPING_TABLES].sort().join(", ")})`)
  console.log(` ${bookkeepingExempt} columns exempt — bookkeeping (id/created_at/updated_at/brokerage_id-style)`)
  console.log(` ${totalWritten} columns written · ${totalRead} columns read`)
  console.log(` ${dbOnlyReads.length} columns read ONLY by the database (CHECK/RLS/trigger, no app-level reader):`)
  for (const d of dbOnlyReads.slice(0, 60)) console.log(`   · ${d.table}.${d.column}  [${d.tags.join(", ")}]`)
  if (dbOnlyReads.length > 60) console.log(`   … and ${dbOnlyReads.length - 60} more`)
  console.log(` ${migrationOnlyWrites.length} columns written ONLY by a migration self-verifying probe (no production writer, no reader — see MIGRATION_ONLY_WRITE_EXEMPTIONS):`)
  for (const d of migrationOnlyWrites) console.log(`   · ${d.table}.${d.column}`)
  console.log(` readerless writes: ${offenderKeys.length} (densest table first)`)
  for (const [table, arr] of sortedTables) {
    console.log(`  ${table} (${arr.length}):`)
    for (const f of arr) {
      const ev = f.evidence[0]
      console.log(`    ✗ ${ev?.file ?? "?"}::${table}.${f.column}  [${ev?.tag ?? "?"}]`)
    }
  }
  console.log(" BLIND SPOTS (see file header for full detail):")
  console.log("  · dynamic column names ( .update({ [expr]: v }) with an unresolved expr ) are invisible to both sides")
  console.log("  · jsonb payload sub-fields are not modelled — a selected jsonb column reads as read even if a key inside it is never consumed")
  console.log("  · DB triggers/functions that exist only live and were never committed as a migration are invisible")
  console.log("  · CREATE VIEW attribution is bare-word matching within the view body, not a real SQL parse")
  console.log("  · .or(\"col.op.val\") DSL parsing takes the first dot-segment — wrong for an embedded relation's filter term")
  console.log("  · RPC function-body reads (sql:rpc tag) are bare-word matching within the resolved body, same caveat as CHECK/RLS/view — not a real SQL parse")
  console.log("  · .select() / .select(\"*\") mark the WHOLE table read even when the caller discards the returned row (e.g. .insert({…}).select() with the result never used) — conservative by design, matches this census's own select(*) convention")

  if (listMode) {
    console.log(" (--list mode: exit 0)")
    process.exit(0)
  }

  if (!existsSync(BASELINE)) {
    console.log(" no committed baseline — report-only, exit 0 (run with READERLESS_WRITE_BASELINE=1 to create one)")
    process.exit(0)
  }
  const baseline = new Set<string>(JSON.parse(readFileSync(BASELINE, "utf8")))
  const fresh = offenderKeys.filter((k) => !baseline.has(k))
  const fixed = [...baseline].filter((k) => !offenderKeys.includes(k))
  if (fixed.length > 0) console.log(` ↘ ${fixed.length} baseline entries now have readers — tighten with READERLESS_WRITE_BASELINE=1`)
  if (fresh.length > 0) {
    console.log(` ✗ ${fresh.length} NEW readerless-write column(s): ${fresh.join(", ")}`)
    console.log("   Give each a verdict: wire the reader, merge onto the read sibling, or mark unresolved with a reason.")
    process.exit(1)
  }
  console.log(" ✅ no NEW readerless-write columns")
}

main()
