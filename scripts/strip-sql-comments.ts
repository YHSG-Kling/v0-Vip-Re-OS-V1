/**
 * scripts/strip-sql-comments.ts — the ONE correct way to remove comments from SQL here.
 * ─────────────────────────────────────────────────────────────────────────────
 * The SQL sibling of scripts/strip-comments.ts, and it exists for the same reason:
 * a comment scanner that loses sync does not go quiet, it goes CONFIDENTLY WRONG.
 *
 * WAS `.replace(/^[ \t]*--.*$/gm, "")` — anchored to the START of a line, so a
 * TRAILING comment survived:
 *
 *     'solo_agent'::text,   -- solo tier: the tenant's one agent
 *
 * The apostrophe in "tenant's" then acted as a string delimiter for the ARRAY
 * parser, which extracted `::text -- team cascade, s one agent` as a VALUE and
 * reported a migration/snapshot disagreement that did not exist. The guard's own
 * self-test used a trailing comment with NO apostrophe, so it passed and gave
 * false confidence.
 *
 * Whether `--` opens a comment depends on whether you are inside a string, and
 * whether a quote opens a string depends on whether you are inside a comment. No
 * pair of regexes can decide that, so this is one left-to-right scan that tracks
 * the state, including the `$$` dollar quoting every `do $$ … $$` migration block
 * in this repo uses.
 *
 * IT LIVES IN ITS OWN FILE so callers can have the scanner WITHOUT the guard.
 * It used to be exported from scripts/vocabulary-snapshot-guard.ts, which is a
 * SCRIPT: importing it ran that guard's whole main() and printed its output into
 * the importer's report. Two RLS guards that wanted the scanner got the other
 * guard's 24 lines of results stapled to the top of their own.
 */

export function stripSqlComments(sql: string): string {
  let out = ""
  let i = 0
  const n = sql.length
  while (i < n) {
    // Dollar-quoted body: $tag$ … $tag$ — copied verbatim, comments inside are data.
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i))
    if (dollar) {
      const tag = dollar[0]
      const end = sql.indexOf(tag, i + tag.length)
      const stop = end === -1 ? n : end + tag.length
      out += sql.slice(i, stop)
      i = stop
      continue
    }
    if (sql[i] === "\'") {
      out += "\'"
      i++
      while (i < n) {
        if (sql[i] === "\'" && sql[i + 1] === "\'") { out += "\'\'"; i += 2; continue } // escaped quote
        if (sql[i] === "\'") { out += "\'"; i++; break }
        out += sql[i]
        i++
      }
      continue
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++          // to end of line, wherever it started
      continue
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2)
      const stop = end === -1 ? n : end + 2
      for (let k = i; k < stop; k++) if (sql[k] === "\n") out += "\n"  // keep line numbers
      i = stop
      continue
    }
    out += sql[i]
    i++
  }
  return out
}
