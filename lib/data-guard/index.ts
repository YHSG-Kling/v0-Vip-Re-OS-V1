// lib/data-guard/index.ts
//
// THE DATA GUARD — sensitive-data classification + redaction at the MODEL boundary.
//
// The Egress Guard is the final checkpoint before anything leaves the app to a person; this is its
// twin one layer in: the final checkpoint before anything reaches an LLM. Real-estate files carry
// secrets the AI managers never need to do their job — a buyer's SSN/ITIN, a tax EIN, a credit-card
// PAN, a bank account/routing number. Those must never sit in a model prompt (prompt logs, provider
// retention, accidental echo). The Data Guard classifies and REDACTS exactly those high-confidence
// secrets before any system/prompt is sent to the model, replacing each with a typed placeholder
// like [REDACTED:SSN] so the surrounding meaning is preserved.
//
// Deliberately CONSERVATIVE: it redacts only high-confidence secrets the AI never needs. It does NOT
// touch names, addresses, prices, sqft, or phone numbers — normal real-estate working data the
// managers DO need — so there is zero functional loss, only leak prevention. Pure (no I/O), so it's
// unit-tested directly and safe to call on the hot path.

export type SensitivityKind = "ssn" | "ein" | "card" | "bank"

export interface SensitiveFinding {
  kind: SensitivityKind
  /** The matched span (for audit/tests — never logged with the value in production). */
  match: string
}

/** The redaction placeholder for a kind. */
export function placeholderFor(kind: SensitivityKind): string {
  return `[REDACTED:${kind.toUpperCase()}]`
}

// High-confidence patterns only. Order matters: card (16/15 digits) before the shorter SSN/EIN so a
// card run is never partially eaten by a narrower pattern.
const WHOLE_MATCH_PATTERNS: Array<{ kind: SensitivityKind; re: RegExp }> = [
  // Credit/debit card PAN — 16-digit (Visa/MC/Disc) and 15-digit (Amex), optional space/dash groups.
  { kind: "card", re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g },
  { kind: "card", re: /\b\d{4}[ -]?\d{6}[ -]?\d{5}\b/g },
  // SSN / ITIN — dashed form (avoids eating 9 random digits like a zip+phone concatenation).
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // EIN — federal employer id.
  { kind: "ein", re: /\b\d{2}-\d{7}\b/g },
]

// Labeled bank account / routing numbers — keep the label, redact the digits (so context survives).
const LABELED_BANK = /\b(account|acct|routing|aba|iban)\b([^\d\n]{0,14}?)(\d{6,17})\b/gi

/** PURE: every high-confidence sensitive span in the text (for classification/tests). */
export function classifySensitive(text: string): SensitiveFinding[] {
  if (!text) return []
  const findings: SensitiveFinding[] = []
  for (const { kind, re } of WHOLE_MATCH_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) findings.push({ kind, match: m[0] })
  }
  LABELED_BANK.lastIndex = 0
  let b: RegExpExecArray | null
  while ((b = LABELED_BANK.exec(text))) findings.push({ kind: "bank", match: b[3] })
  return findings
}

/** PURE: does the text carry any high-confidence secret the AI should never see? */
export function hasSensitive(text: string): boolean {
  return classifySensitive(text).length > 0
}

/**
 * PURE: redact every high-confidence secret, replacing each with a typed placeholder. Returns the
 * scrubbed text + how many spans were redacted (for the Data Guard's audit counter). Idempotent —
 * running it on already-redacted text is a no-op (placeholders contain no matchable digits).
 */
export function redactSensitive(text: string | undefined | null): { text: string; redactedCount: number } {
  if (!text) return { text: text ?? "", redactedCount: 0 }
  let out = text
  let count = 0
  for (const { kind, re } of WHOLE_MATCH_PATTERNS) {
    out = out.replace(re, () => { count += 1; return placeholderFor(kind) })
  }
  out = out.replace(LABELED_BANK, (_m, label: string, sep: string) => { count += 1; return `${label}${sep}${placeholderFor("bank")}` })
  return { text: out, redactedCount: count }
}
