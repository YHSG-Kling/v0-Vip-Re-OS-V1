/**
 * scripts/session-tokens.ts — THE spelling list of "this code reads the caller's
 * session", shared by the two "use server" censuses (lane 86E, §6: one
 * vocabulary per function).
 *
 *   · scripts/lib-use-server-census.ts asks: does a lib/ "use server" FILE touch
 *     the session at all? (none → an ungated public door)
 *   · scripts/sessionless-use-server-census.ts asks: does a "use server" EXPORT
 *     that a cron / webhook / voice path imports read the session? (yes → that
 *     caller reads nothing, or is refused)
 *
 * Moved here verbatim from lib-use-server-census.ts (which restated it once);
 * that file now imports it. `on` says which view of the source the regex runs
 * against: "identifiers" = blankStrings() output (a token inside a log string is
 * prose, not a gate); "specifiers" = stripComments() output (an import path IS a
 * string, so blanking strings would hide it).
 */
export interface SessionToken { name: string; re: RegExp; on: "identifiers" | "specifiers" }

export const SESSION_TOKENS: ReadonlyArray<SessionToken> = [
  { name: "auth.getUser",                            re: /\bauth\.getUser\b/,                              on: "identifiers" },
  { name: 'createClient() from "@/lib/supabase/server"', re: /from\s*["']@\/lib\/supabase\/server["']/,      on: "specifiers" },
  { name: "requireCaller",                           re: /\brequireCaller\b/,                              on: "identifiers" },
  { name: "requireActor",                            re: /\brequireActor\b/,                               on: "identifiers" },
  { name: "getSession",                              re: /\bgetSession\b/,                                 on: "identifiers" },
  { name: "cookies()",                               re: /\bcookies\(\)/,                                  on: "identifiers" },
  { name: "headers()",                               re: /\bheaders\(\)/,                                  on: "identifiers" },
  { name: "createServerClient",                      re: /\bcreateServerClient\b/,                         on: "identifiers" },
  { name: "getCurrentUser",                          re: /\bgetCurrentUser\b/,                             on: "identifiers" },
  { name: "requireUser",                             re: /\brequireUser\b/,                                on: "identifiers" },
  { name: "getAuthenticatedUser",                    re: /\bgetAuthenticatedUser\b/,                       on: "identifiers" },
  { name: "resolveActor",                            re: /\bresolveActor\b/,                               on: "identifiers" },
  { name: "requireAdmin",                            re: /\brequireAdmin\b/,                               on: "identifiers" },
  { name: "requirePlatform*",                        re: /\brequirePlatform\w*\b/,                         on: "identifiers" },
  { name: "getAgentContext",                         re: /\bgetAgentContext\b/,                            on: "identifiers" },
]

/**
 * Top-level "use server" by the rule Next applies: the first non-empty line of
 * the COMMENT-STRIPPED source, either quote style, optional semicolon. A
 * tombstone that says `this file was "use server"` is prose, not a directive.
 */
export function hasUseServerDirective(stripped: string): boolean {
  const first = stripped.split("\n").find((l) => l.trim().length > 0) ?? ""
  return /^\s*["']use server["']\s*;?\s*$/.test(first)
}
