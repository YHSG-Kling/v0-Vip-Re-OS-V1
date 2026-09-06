// lib/education/dedup-guard.ts
// ─────────────────────────────────────────────────────────────────────────────
// CROSS-PATH EDUCATION DEDUP GUARD (owner: "no duplicates or noise"). Every
// auto-authoring path already dedups WITHIN itself by its own gap_tag namespace
// (question: / objection: / compliance: / client: / onboarding: / program: /
// regulation:). The gap: DIFFERENT subsystems author the SAME topic under
// DIFFERENT tags (e.g. the chatter path's "question:pre_approval" vs the tier
// syllabus's "onboarding:*:financing_letter_strength" — both agent-facing lessons
// on pre-approval), so the per-tag guard can't see the collision. This pure guard
// catches near-duplicates by TITLE across paths, so a topic already covered by a
// pending/published module isn't authored a second time.
//
// Pure + deterministic (no LLM, no embeddings — the same honest, testable posture
// as the rest of lib/education). Token Jaccard over normalized titles.

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "your",
  "you", "how", "what", "why", "when", "guide", "course", "lesson", "module",
  "ai", "understanding", "mastering", "intro", "introduction", "basics",
])

/** PURE: normalize a title into a stable set of significant tokens. */
export function titleTokens(title: string): Set<string> {
  const toks = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t))
  return new Set(toks)
}

/** PURE: Jaccard similarity of two titles' significant-token sets (0..1). */
export function titleSimilarity(a: string, b: string): number {
  const sa = titleTokens(a)
  const sb = titleTokens(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * PURE: is `candidate` a near-duplicate of any title in `existing`? Default
 * threshold 0.5 (Jaccard over significant tokens) — reliably catches OBVIOUS
 * near-duplicate titles ("Getting Your Mortgage Pre-Approval Letter" vs "Get Your
 * Pre-Approval Letter") without suppressing genuinely distinct lessons. It is the
 * automated layer; the human pending_review gate (Curriculum Board) remains the
 * backstop for differently-phrased same-topic modules.
 */
export function isNearDuplicateTitle(candidate: string, existing: string[], threshold = 0.5): boolean {
  return existing.some((e) => titleSimilarity(candidate, e) >= threshold)
}

type Svc = { from: (t: string) => any }

/**
 * DB-backed cross-path check: does the brokerage already have a pending or
 * published module with a near-duplicate title for an OVERLAPPING audience? Used
 * before authoring so the same topic isn't produced twice under different tags.
 * Fails OPEN (returns false) on any read error — a broken dedup read must never
 * block legitimate authoring; the per-tag guard still applies underneath.
 */
export async function hasNearDuplicateModule(
  svc: Svc,
  brokerageId: string,
  candidateTitle: string,
  audienceRoles: string[] | null,
  threshold = 0.5,
): Promise<boolean> {
  try {
    // Consider platform defaults (brokerage_id null) + this brokerage's own modules,
    // that are live (pending_review or published) — the shelf a learner could see.
    const { data } = await svc
      .from("learning_modules")
      .select("title, audience_roles")
      .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
      .in("status", ["pending_review", "published"])
      .limit(1000)
    const rows = (data ?? []) as Array<{ title: string | null; audience_roles: string[] | null }>
    const want = audienceRoles ?? []
    const relevant = rows.filter((r) => {
      // No audience on either side ⇒ universal ⇒ always comparable; else require overlap.
      const have = r.audience_roles ?? []
      if (want.length === 0 || have.length === 0) return true
      return have.some((a) => want.includes(a))
    })
    return isNearDuplicateTitle(candidateTitle, relevant.map((r) => r.title ?? ""), threshold)
  } catch {
    return false
  }
}

/**
 * Like hasNearDuplicateModule but returns the EXISTING near-duplicate module's id
 * + title (or null). The manual authoring commands use this to return the existing
 * module instead of creating a second one — idempotent, no duplicate row. Fails
 * OPEN (null) on read error so a broken dedup read never blocks authoring.
 */
export async function findNearDuplicateModule(
  svc: Svc,
  brokerageId: string,
  candidateTitle: string,
  audienceRoles: string[] | null,
  threshold = 0.5,
): Promise<{ id: string; title: string } | null> {
  try {
    const { data } = await svc
      .from("learning_modules")
      .select("id, title, audience_roles")
      .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
      .in("status", ["pending_review", "published"])
      .limit(1000)
    const rows = (data ?? []) as Array<{ id: string; title: string | null; audience_roles: string[] | null }>
    const want = audienceRoles ?? []
    for (const r of rows) {
      const have = r.audience_roles ?? []
      const audienceComparable = want.length === 0 || have.length === 0 || have.some((a) => want.includes(a))
      if (audienceComparable && titleSimilarity(candidateTitle, r.title ?? "") >= threshold) {
        return { id: r.id, title: r.title ?? "" }
      }
    }
    return null
  } catch {
    return null
  }
}
