// lib/providers/content-safety.ts
// ─────────────────────────────────────────────────────────────────────────────
// FAIR-HOUSING CONTENT BACKSTOP at the PHYSICAL DISPATCH CHOKEPOINT.
//
// The dispatch layer already enforces CONSENT/suppression (evaluateOutboundCompliance)
// and the autonomy posture. But Fair-Housing CONTENT was only scanned at COMPOSE time,
// inside each generator, BY CONVENTION — so an autonomous manager that assembled a body
// which skipped compose-gating (or a future raw-string sender) could put a discriminatory
// message on the wire unscanned. For a real-estate OS that is an existential legal risk.
//
// This is the hard backstop every send must pass: it re-scans the FINAL assembled content
// with the CANONICAL Fair-Housing pattern set (single source of truth — no drift) and:
//   • AUTONOMOUS send (a governed manager, not human-approved) + a violation → BLOCK.
//   • Human-approved send + a violation → FLAG (record) but allow (a human took responsibility).
// Either way it records a compliance_events row so the catch is auditable.

import { evaluateContentSafety } from "@/lib/compliance/content-safety-checks"
import { createServiceClient } from "@/lib/supabase/service"

export interface ContentSafetyInput {
  brokerageId: string
  channel: "email" | "sms" | "direct_mail" | "voicemail"
  /** Every text fragment about to be sent (subject, body text, assembled html, etc.). */
  parts: Array<string | null | undefined>
  /** True when a governed manager is sending unattended (managerKey set AND not human-approved). */
  isAutonomous: boolean
  contactId?: string | null
  actorUserId?: string | null
  systemSource?: string | null
}

export interface ContentSafetyResult {
  blocked: boolean
  reason?: string
  violations: string[]
}

/** Strip HTML tags so markup can't hide a pattern and tags don't create false positives. */
function stripHtml(s?: string | null): string {
  return (s ?? "").replace(/<[^>]+>/g, " ")
}

export async function contentSafetyBackstop(input: ContentSafetyInput): Promise<ContentSafetyResult> {
  const text = input.parts.map(stripHtml).join("\n").trim()
  if (!text) return { blocked: false, violations: [] }

  // SYNCHRONOUS PRE-ACTION EVAL — every release-blocking category (fair housing, unsubstantiated
  // guarantee, PII leak, prompt-injection echo), not just Fair Housing.
  const hits = evaluateContentSafety(text)
  if (hits.length === 0) return { blocked: false, violations: [] }

  const phrases = hits.map((h) => h.phrase)
  const categories = Array.from(new Set(hits.map((h) => h.category)))
  const severity = hits.some((h) => h.severity === "high") ? "high" : hits.some((h) => h.severity === "medium") ? "medium" : "low"
  const blocked = input.isAutonomous
  const reason = `content-safety violation [${categories.join(", ")}] in ${input.channel}: ${phrases.join(", ")}`

  // Auditable record of the catch (best-effort — never let logging break the gate decision).
  try {
    const svc = createServiceClient()
    await svc.from("compliance_events").insert({
      brokerage_id: input.brokerageId,
      actor_user_id: input.actorUserId ?? null,
      actor_role: input.isAutonomous ? "ai_manager" : "system",
      entity_type: `outbound_${input.channel}`,
      entity_id: input.contactId ?? null,
      gate_name: "content_safety_dispatch_backstop",
      allowed: !blocked,
      violations: hits.map((h) => ({ category: h.category, phrase: h.phrase, severity: h.severity, reference: h.reference })),
      blocked_reason: blocked ? reason : null,
      severity,
      details: { system_source: input.systemSource ?? null, autonomous: input.isAutonomous, disposition: blocked ? "blocked" : "flagged", categories },
    })
  } catch (err) {
    console.warn("[content-safety] compliance_events insert failed:", (err as any)?.message)
  }

  return { blocked, reason: blocked ? reason : undefined, violations: phrases }
}
