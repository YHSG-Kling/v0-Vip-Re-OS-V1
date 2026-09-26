/**
 * lib/security/export-credential-scan.ts
 *
 * THE ONE ANSWER TO "IS THERE A CREDENTIAL IN THIS EXPORT?"
 *
 * OWNER RULING (finding #294), verbatim:
 *
 *   "294 no credentials should be listed in csv."
 *
 * Ruled on the business-expense CSV, where `receipt_url` was a 365-day signed URL
 * into a private bucket — a BEARER CREDENTIAL, so the exported file was not a
 * reference to the receipt, it WAS the key to it, and it outlived every gate the
 * export had passed. The ruling is general: an export is a file that leaves the
 * building, and nothing in it may be usable by whoever happens to be holding it.
 *
 * ONE VOCABULARY (CLAUDE.md §6). Two exports must not be able to disagree about
 * what a credential is, so the patterns live here once and every export that
 * needs them imports them. Today: lib/finance/expense-csv.ts (asserted by
 * scripts/expense-export-scope-simulator.ts) and
 * app/api/admin/audit-events/route.ts (which dumps an unbounded
 * `lifecycle_events.metadata` blob into a CSV column).
 *
 * WHAT COUNTS. Only shapes that are usable BY POSSESSION. A uuid, an expense id,
 * a brokerage id, an in-app route and a person's own published website are NOT on
 * this list — they authorize nothing on their own, and an over-broad matcher that
 * eats them makes exports useless while proving nothing.
 */

export interface CredentialPattern {
  name: string
  /** Deliberately non-global: `.test`/`.replace` here must carry no lastIndex state. */
  re: RegExp
  why: string
}

export const CSV_CREDENTIAL_PATTERNS: CredentialPattern[] = [
  { name: "supabase_signed_object", re: /\/object\/sign\//, why: "Supabase storage signed-URL path — the token that follows fetches the private object" },
  { name: "query_token", re: /[?&](token|access_token|signature|sig|key)=/i, why: "a credential carried as a query parameter" },
  { name: "aws_sigv4", re: /X-Amz-(Signature|Credential|Security-Token)/i, why: "S3/R2 presigned-URL signature material" },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, why: "a JWT — Supabase signs storage URLs with one" },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._-]{16,}/i, why: "an Authorization bearer token" },
  { name: "vos_token", re: /\bvos_[A-Za-z0-9]{16,}/, why: "a platform API token (see app/actions/tenant-webhooks.ts)" },
  { name: "webhook_secret", re: /\bwhsec_[A-Za-z0-9]{16,}/, why: "a webhook signing secret" },
  { name: "stripe_secret", re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/, why: "a Stripe secret key" },
  { name: "storage_object_url", re: /https?:\/\/[^\s",]*\/storage\/v1\/object\//i, why: "a direct storage-object URL — public or signed, it bypasses the app's gate" },
  // Vercel Blob is served from a guess-resistant PUBLIC host: the URL is the whole
  // authorization. lib/kernel/reporting.ts#exportReportPdf writes one into
  // lifecycle_events.metadata, which the audit CSV dumps verbatim.
  { name: "vercel_blob_url", re: /https?:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i, why: "a Vercel Blob public URL — unauthenticated and permanent; the URL is the capability" },
]

export interface CredentialFinding {
  pattern: string
  why: string
  /** The offending line, truncated — never the whole credential in a log. */
  sample: string
}

/**
 * PURE: every credential-shaped string in a built export.
 *
 * Returns findings rather than a boolean so a failure says WHAT leaked. An empty
 * array means nothing only next to a positive control — see
 * scripts/expense-export-scope-simulator.ts, which proves this finder still goes
 * red on the exact column the ruling removed, and that no pattern here is dead.
 */
export function findCredentialsInCsv(text: string): CredentialFinding[] {
  const out: CredentialFinding[] = []
  for (const line of text.split("\n")) {
    for (const p of CSV_CREDENTIAL_PATTERNS) {
      if (p.re.test(line)) out.push({ pattern: p.name, why: p.why, sample: line.slice(0, 120) })
    }
  }
  return out
}

/** What replaces a credential in an export: a NAMED hole, never a silent one. */
export const CREDENTIAL_REDACTED = "[redacted:credential]"

/**
 * PURE: the same text with every credential-shaped RUN replaced by a marker.
 *
 * For sinks that carry an unbounded blob written by someone else — the audit CSV's
 * `metadata_json` is the case this exists for — where an allowlist is impossible
 * because the writer set is open. A named marker, not deletion: a reader must be
 * able to tell "a credential was here and was withheld" from "this field was
 * empty", the same way this codebase refuses to let a refused read look like a
 * genuine zero.
 */
export function redactCredentials(text: string): string {
  // A credential is a contiguous non-delimiter run. Split on whitespace, commas
  // and quotes so one bad URL does not blank the whole surrounding cell.
  return text.replace(/[^\s",]+/g, (tok) =>
    CSV_CREDENTIAL_PATTERNS.some((p) => p.re.test(tok)) ? CREDENTIAL_REDACTED : tok,
  )
}
