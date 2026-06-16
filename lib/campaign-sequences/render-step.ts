/**
 * lib/campaign-sequences/render-step.ts
 *
 * Interpolates campaign step bodies and runs them through the kernel
 * pre-send pipeline before they go out. Centralises:
 *
 *   1. Token interpolation — {{first_name}}, {{agent_name}}, {{portal_link}},
 *      {{property_address}}, {{listing_address}}, {{tour_date}}, etc.
 *   2. Brand-voice check — applyBrandVoice across brokerage → team → agent
 *      (most-specific scope wins). Rejects sends with violations.
 *   3. Email assembly — assembleEmail appends the agent's signature, the
 *      unsubscribe block, and the legal disclosures (Equal Housing).
 *
 * Call this from executeSequenceStep before dispatching email/SMS — never
 * raw-send a step body.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { assembleEmail, type AssembledEmail } from "@/lib/kernel/communications/assemble-email"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { generatePersonaCopy, type CopyGenerator } from "@/lib/kernel/ai-copy"

export interface RenderStepInput {
  brokerageId:  string
  contactId:    string
  /** Auth user id of the agent the contact is assigned to (for personal email
   *  send + signature lookup). May be null for system-assigned sequences. */
  agentUserId:  string | null
  step: {
    channel: string
    subject: string | null
    body:    string | null
  }
  /** When set, the body is GENERATED from the contact's persona + Fair-Housing-safe enriched facts
   *  using this as the goal — instead of token-interpolating the static template body. Opt-in
   *  (step.ai_intent); null/absent keeps the legacy template behaviour. */
  personaIntent?: string | null
  /** Injectable copy generator (tests). Defaults to the real AI gateway generator. */
  generator?: CopyGenerator
  /** Channel purpose drives which post-body additions assembleEmail makes
   *  (campaign sends get unsubscribe, transactional skips it). */
  channelPurpose?: "conversation" | "campaign" | "update" | "transactional"
}

export interface RenderedStep {
  /** Final values to actually send. For email, htmlBody includes signature
   *  + unsubscribe + disclosures; textBody is the plain-text counterpart. */
  subject:  string | null
  htmlBody: string
  textBody: string
  /** Brand-voice violations — caller should refuse to dispatch when non-empty. */
  brandVoiceViolations: string[]
  /** Advisory tone notes from brand voice (for logging only). */
  brandVoiceNotes:      string[]
  /** Whether the kernel signature was appended. */
  signatureIncluded:    boolean
  /** Token replacements that fired (for debug + observability). */
  tokensReplaced:       Record<string, string>
}

export async function renderSequenceStep(input: RenderStepInput): Promise<RenderedStep> {
  const supabase = createServiceClient()

  // ── Load the contact + agent + brokerage details for token replacement ──
  const [{ data: contact }, agentInfo, { data: brokerage }] = await Promise.all([
    supabase.from("contacts")
      .select("id, first_name, last_name, email, phone, contact_persona, contact_type, buyer_stage, home_owner_status, last_contacted_at, brokerage_id")
      .eq("id", input.contactId)
      .maybeSingle(),
    input.agentUserId
      ? supabase.from("users")
          .select("id, first_name, last_name, email, phone, team_id")
          .eq("id", input.agentUserId)
          .maybeSingle().then(r => r.data)
      : Promise.resolve(null),
    supabase.from("brokerages")
      .select("name, primary_color, logo_url")
      .eq("id", input.brokerageId)
      .maybeSingle(),
  ])

  const portalBase = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const tokens: Record<string, string> = {
    first_name:        contact?.first_name ?? "there",
    last_name:         contact?.last_name ?? "",
    full_name:         [contact?.first_name, contact?.last_name].filter(Boolean).join(" ") || "there",
    email:             contact?.email ?? "",
    phone:             contact?.phone ?? "",
    agent_first_name:  (agentInfo as any)?.first_name ?? "",
    agent_last_name:   (agentInfo as any)?.last_name ?? "",
    agent_name:        [(agentInfo as any)?.first_name, (agentInfo as any)?.last_name]
                          .filter(Boolean).join(" ") || "your agent",
    agent_email:       (agentInfo as any)?.email ?? "",
    agent_phone:       (agentInfo as any)?.phone ?? "",
    brokerage_name:    brokerage?.name ?? "",
    portal_link:       portalBase ? `${portalBase}/portal/${input.contactId}` : `/portal/${input.contactId}`,
    portal_invite_link: portalBase ? `${portalBase}/portal/${input.contactId}` : `/portal/${input.contactId}`,
    buyers_guide_link: portalBase ? `${portalBase}/portal/${input.contactId}/learn` : `/portal/${input.contactId}/learn`,
    week_count:        "",  // computed by caller if available
    today:             new Date().toLocaleDateString(),
  }

  // PERSONA+ENRICHMENT generation (opt-in via step.ai_intent): write to THIS person from their
  // Fair-Housing-safe enriched facts instead of token-interpolating a static template body.
  let subjectTemplate = input.step.subject ?? ""
  let bodyTemplate    = input.step.body ?? ""
  if (input.personaIntent && input.personaIntent.trim()) {
    const { buildPersonaContext } = await import("./persona-render")
    const personaCtx = buildPersonaContext((contact ?? {}) as any, "contact")
    const draft = await generatePersonaCopy(
      {
        goal: input.personaIntent,
        facts: personaCtx.facts,
        channel: input.step.channel,
        persona: personaCtx.persona,
        words: input.step.channel === "sms" ? 40 : 80,
      },
      { subject: input.step.subject ?? undefined, body: input.step.body ?? "" },
      { generator: input.generator },
    )
    bodyTemplate = draft.body
    if (draft.subject) subjectTemplate = draft.subject
  }

  const replaced: Record<string, string> = {}
  const subject = interpolate(subjectTemplate, tokens, replaced)
  const body    = interpolate(bodyTemplate, tokens, replaced)

  // ── Brand-voice check (advisory + hard-block on violations) ──────────────
  // Resolution order: brokerage → team → agent (most-specific wins).
  const voice = await applyBrandVoice({
    brokerageId:  input.brokerageId,
    teamId:       (agentInfo as any)?.team_id ?? undefined,
    actorUserId:  input.agentUserId ?? undefined,
    actorRole:    "agent",
    journeyType:  contact?.contact_type === "seller" ? "seller" : "buyer",
    persona:      contact?.contact_persona ?? "other",
    messageType:  input.step.channel === "sms" ? "sms" : "email",
    content:      body,
  })

  // ── For email: assemble signature + unsubscribe + legal ──────────────────
  if (input.step.channel === "email") {
    if (!input.agentUserId) {
      // No assigned agent — skip kernel assembly (no signature available)
      return {
        subject,
        htmlBody:             plainToHtml(body),
        textBody:             body,
        brandVoiceViolations: voice.violations,
        brandVoiceNotes:      voice.notes,
        signatureIncluded:    false,
        tokensReplaced:       replaced,
      }
    }
    const assembled: AssembledEmail = await assembleEmail({
      bodyHtml:       plainToHtml(body),
      bodyText:       body,
      userId:         input.agentUserId,
      brokerageId:    input.brokerageId,
      contactId:      input.contactId,
      channelPurpose: input.channelPurpose ?? "campaign",
    })
    return {
      subject,
      htmlBody:             assembled.html,
      textBody:             assembled.text,
      brandVoiceViolations: voice.violations,
      brandVoiceNotes:      voice.notes,
      signatureIncluded:    assembled.signatureIncluded,
      tokensReplaced:       replaced,
    }
  }

  // SMS / other channels — return interpolated body without HTML wrap
  return {
    subject,
    htmlBody:             body,
    textBody:             body,
    brandVoiceViolations: voice.violations,
    brandVoiceNotes:      voice.notes,
    signatureIncluded:    false,
    tokensReplaced:       replaced,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TOKEN_RE = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi

function interpolate(
  template: string,
  tokens:   Record<string, string>,
  replaced: Record<string, string>,
): string {
  return template.replace(TOKEN_RE, (full, key) => {
    const k = String(key).toLowerCase()
    if (k in tokens) {
      replaced[k] = tokens[k]
      return tokens[k]
    }
    // Unknown token — leave in place but record so observability can flag
    // missing tokens in templates.
    replaced[`__missing__${k}`] = ""
    return full
  })
}

function plainToHtml(text: string): string {
  return `<div>${text
    .split("\n")
    .map(l => l.length === 0 ? "<br>" : escapeHtml(l))
    .join("<br>")}</div>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
