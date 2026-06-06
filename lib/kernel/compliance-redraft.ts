/**
 * lib/kernel/compliance-redraft.ts
 *
 * Canonical pre-flight compliance loop. Every content producer that
 * generates a script (intro video, listing promo, podcast, newsletter
 * video, marketing-plan asset, etc.) needs to:
 *
 *   1. Draft via the AI Gateway.
 *   2. Run evaluateOutbound (or similar gate) against the result.
 *   3. On violations, re-prompt ONCE feeding the specific violations
 *      back so the model can self-correct (cheap re-prompt vs.
 *      ~$0.30 D-ID or ~$0.05 Remotion render that would otherwise be
 *      wasted on a non-compliant draft).
 *   4. If the redraft also fails, surface the violations to the caller
 *      so the asset is marked 'failed' without spending render dollars.
 *
 * Before this helper, 5 producers each implemented this loop inline
 * (intro-video-reactor, listing-promo-reactor, podcast/auto-producer,
 * render-just-listed, render-newsletter-video). Each new producer added
 * one more copy; the code-review caught the drift risk.
 *
 * This helper is parameterized by the draft function and the gate
 * function so each producer keeps its own prompt + persona/journey
 * choices but they all share one retry policy.
 */
import "server-only"

export type ComplianceGateFn = (script: string) => Promise<{
  allowed:    boolean
  violations: string[]
}>

export type ComplianceDraftFn = (args: { violations: string[] }) => Promise<string>

export interface RunComplianceResult {
  ok:         boolean
  script:     string
  /** When ok=false, the final attempt's violation list (the redraft also failed). */
  violations: string[]
}

/**
 * Run the canonical draft → gate → redraft → gate loop.
 *
 * draft({ violations: [] })       — initial draft (no feedback yet)
 * gate(script)                    — Brand voice + Fair Housing + Them-First etc.
 * draft({ violations: [...] })    — redraft fed the prior violations
 * gate(script)                    — second pass
 *
 * Returns { ok: true, script } on success (either pass).
 * Returns { ok: false, script, violations } when the redraft still fails.
 */
export async function runWithComplianceRedraft(args: {
  draft: ComplianceDraftFn
  gate:  ComplianceGateFn
}): Promise<RunComplianceResult> {
  // First draft.
  let script = await args.draft({ violations: [] })
  const first = await args.gate(script)
  if (first.allowed) return { ok: true, script, violations: [] }

  // Redraft with the specific violations fed back.
  script = await args.draft({ violations: first.violations })
  const second = await args.gate(script)
  if (second.allowed) return { ok: true, script, violations: [] }

  // Both attempts failed.
  return { ok: false, script, violations: second.violations }
}
