"use server"

// app/actions/superadmin/tenant-message.ts
// ─────────────────────────────────────────────────────────────────────────────
// DIRECT STAFF→TENANT-ADMIN MESSAGE — the proactive rail support was missing.
// Until now the only staff→tenant email lanes were sentinel approvals, dunning,
// status notices, and reactive ticket replies; support could not simply write to
// a specific tenant admin ("your import finished", "heads-up before we call").
//
// This is the platform emailing ITS OWN customer (B2B transactional — the same
// class as dunning and the sentinel approve&send), never consumer marketing:
//   · gate: requirePlatformCapability('support', { requireWrite: true })
//   · target must be a broker/admin-class user IN that brokerage
//   · platform suppression list checked BEFORE the send (hard legal boundary,
//     the prospect-followup idiom)
//   · canonical sendEmail (lib/providers/messaging) — SendGrid-gated, fails
//     loudly; 'sent' is only claimed on provider acceptance
//   · audited to superadmin_audit_log as 'tenant_admin.message_sent' with the
//     subject + target — NEVER the body (privacy)
//   · an in-app notifications row (type 'platform_message') mirrors the message
//     inside the OS so it exists beyond the recipient's inbox
//
// FAILURE HONESTY: suppressed / no-email / provider-refusal each come back as a
// DISTINCT reason so the composer can say exactly what happened — no fake sends.
//
// AI ASSIST: draftTenantAdminMessageAction composes from a stated purpose plus
// REAL tenant facts (name, tier, recent support/sentinel context) in the
// PLATFORM's voice (loadProductBrand — not tenant brand), with a deterministic
// fallback floor. It only ever returns a draft for staff to edit — no auto-send.

import { headers } from "next/headers"
import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { isEmailOnSuppressionList } from "@/lib/platform/suppression-list"
import { loadProductBrand, type ProductBrand } from "@/lib/platform/product-brand"

/** User types staff may message directly — the tenant's admin bench (the same
 *  set the dunning ladder and sentinel approve&send address). */
const MESSAGEABLE_USER_TYPES = ["broker", "broker_admin", "admin"] as const

const SUBJECT_MAX = 200
const BODY_MAX = 5000

// ── Audit (support-console conventions: best-effort, never blocks) ───────────

async function audit(actorUserId: string, action: string, targetId: string, details: Record<string, unknown>): Promise<void> {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    const { data: actor } = await svc.from("users").select("email").eq("id", actorUserId).maybeSingle()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId,
      actor_email: (actor as any)?.email ?? null,
      action,
      target_type: "user",
      target_id: targetId,
      details,
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error("[tenant-message audit] write failed:", err)
  }
}

// ── Recipient picker ─────────────────────────────────────────────────────────

export interface MessageableAdmin {
  id: string
  email: string | null
  name: string
  userType: string
  status: string | null
}

/** The tenant's messageable admins (broker/admin bench) for the compose picker. */
export async function listMessageableAdminsAction(brokerageId: string): Promise<
  { ok: true; admins: MessageableAdmin[] } | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("support")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!brokerageId) return { ok: false, error: "brokerageId is required" }
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("users")
    .select("id, email, first_name, last_name, user_type, status")
    .eq("brokerage_id", brokerageId)
    .in("user_type", MESSAGEABLE_USER_TYPES as unknown as string[])
    .is("deleted_at", null)
    .limit(50)
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    admins: ((data ?? []) as any[]).map((u) => ({
      id: u.id,
      email: u.email ?? null,
      name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || "(no name)",
      userType: u.user_type,
      status: u.status ?? null,
    })),
  }
}

// ── AI-assisted draft (staff edits before send — never auto-sent) ────────────

export interface TenantMessageDraft {
  subject: string
  body: string
  /** 'ai' when the gateway composed it; 'fallback' = deterministic template. */
  source: "ai" | "fallback"
  /** The real tenant facts the draft was grounded in (shown to staff). */
  facts: string[]
}

/** Deterministic floor: always yields a real, safe draft — even with no AI rail. */
function composeFallbackDraft(params: { purpose: string; targetFirstName: string | null; brand: ProductBrand }): { subject: string; body: string } {
  const greeting = params.targetFirstName ? `Hi ${params.targetFirstName},` : "Hello,"
  return {
    subject: `A note from the ${params.brand.name} team`,
    body: [
      greeting,
      "",
      params.purpose.trim(),
      "",
      "If you have any questions, just reply to this email and it will reach us.",
      "",
      `— The ${params.brand.name} team`,
    ].join("\n"),
  }
}

/**
 * Draft a message from a stated purpose + REAL tenant facts, in the PLATFORM's
 * voice. Falls back to the deterministic template when the gateway is
 * unavailable — the composer always gets a draft, and says which kind honestly.
 */
export async function draftTenantAdminMessageAction(params: {
  brokerageId: string
  targetUserId: string
  purpose: string
}): Promise<{ ok: true; draft: TenantMessageDraft } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("support", { requireWrite: true })
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const purpose = (params.purpose ?? "").trim()
  if (purpose.length < 8) return { ok: false, error: "State the purpose of the message (8+ characters) so the draft has something real to say" }

  const svc = createServiceClient()
  const [brand, { data: brk }, { data: target }, { data: tickets }, { data: sentinels }] = await Promise.all([
    loadProductBrand(svc),
    svc.from("brokerages").select("name, plan_tier, status, created_at").eq("id", params.brokerageId).maybeSingle(),
    svc.from("users").select("first_name, last_name, user_type, brokerage_id").eq("id", params.targetUserId).maybeSingle(),
    // LANE-FILTERED: this brief is what the PLATFORM knows about this tenant, and
    // the platform's knowledge of a tenant's support is its tenant_to_platform
    // tickets. A brokerage's internal agent/vendor tickets are not the platform's
    // to summarise back at it.
    svc.from("support_tickets").select("subject, status").eq("brokerage_id", params.brokerageId).eq("lane", "tenant_to_platform").order("updated_at", { ascending: false }).limit(3),
    svc.from("platform_sentinel_actions").select("title, status").eq("brokerage_id", params.brokerageId).order("created_at", { ascending: false }).limit(3),
  ])
  if (!target || (target as any).brokerage_id !== params.brokerageId) {
    return { ok: false, error: "Recipient not found in that brokerage" }
  }

  const targetName = [(target as any).first_name, (target as any).last_name].filter(Boolean).join(" ") || null
  const facts: string[] = [
    targetName ? `Recipient: ${targetName} (${(target as any).user_type})` : `Recipient role: ${(target as any).user_type}`,
    (brk as any)?.name ? `Brokerage: ${(brk as any).name}` : null,
    (brk as any)?.plan_tier ? `Plan tier: ${(brk as any).plan_tier}` : null,
    (brk as any)?.status ? `Account status: ${(brk as any).status}` : null,
    ...((tickets ?? []) as any[]).map((t) => `Recent support ticket: "${t.subject ?? "(no subject)"}" (${t.status})`),
    ...((sentinels ?? []) as any[]).map((s) => `Recent platform-sentinel item: "${s.title}" (${s.status})`),
  ].filter(Boolean) as string[]

  const fallback = composeFallbackDraft({ purpose, targetFirstName: (target as any).first_name ?? null, brand })

  try {
    const { gatewayChat } = await import("@/lib/ai/gateway-chat")
    const sys = [
      `You write a short, professional email from the ${brand.name} platform team ("${brand.tagline}") to an administrator at one of the platform's own customer brokerages.`,
      "Rules you must NEVER break:",
      "1. This is a B2B service message to our own customer — never marketing hype, never pressure.",
      "2. Use ONLY the purpose and facts provided — invent nothing (no prices, dates, names, or claims not given).",
      "3. Warm, direct, plain language. Under 180 words. Sign off as the platform team.",
      `Return STRICT JSON: {"subject": "<short subject>", "body": "<the email body>"}.`,
    ].join("\n")
    const usr = `Purpose of the message (stated by the support staffer):\n${purpose}\n\nReal facts you may use:\n${facts.map((f) => `- ${f}`).join("\n")}`
    const res = await gatewayChat({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
      maxTokens: 500,
      temperature: 0.6,
    })
    if (res.ok && res.content) {
      const m = res.content.match(/\{[\s\S]*\}/)
      if (m) {
        const j = JSON.parse(m[0]) as { subject?: string; body?: string }
        if (j.subject && j.body) {
          return {
            ok: true,
            draft: { subject: j.subject.slice(0, SUBJECT_MAX), body: j.body.slice(0, BODY_MAX), source: "ai", facts },
          }
        }
      }
    }
  } catch {
    // fall through to the deterministic floor
  }
  return { ok: true, draft: { ...fallback, source: "fallback", facts } }
}

// ── The send ─────────────────────────────────────────────────────────────────

/** Distinct failure lanes so the composer reports exactly what happened. */
export type TenantMessageFailReason = "forbidden" | "invalid" | "not_admin" | "no_email" | "suppressed" | "provider"

export interface SendTenantMessageResult {
  ok: boolean
  error?: string
  reason?: TenantMessageFailReason
  /** On success: what actually happened (recipient + whether the in-app mirror landed). */
  note?: string
  /** True when the notifications mirror row was written (in-app copy exists). */
  mirrored?: boolean
}

/**
 * Send a direct message to a tenant admin. Provider acceptance is the ONLY
 * thing that counts as sent; suppression, missing email, and provider refusal
 * each come back distinctly. Audited (subject + target — never the body).
 */
export async function sendTenantAdminMessageAction(params: {
  brokerageId: string
  targetUserId: string
  subject: string
  body: string
}): Promise<SendTenantMessageResult> {
  const gate = await requirePlatformCapability("support", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden", reason: "forbidden" }

  const subject = (params.subject ?? "").trim()
  const body = (params.body ?? "").trim()
  if (!params.brokerageId || !params.targetUserId) return { ok: false, error: "brokerageId and targetUserId are required", reason: "invalid" }
  if (subject.length < 3) return { ok: false, error: "Subject must be at least 3 characters", reason: "invalid" }
  if (subject.length > SUBJECT_MAX) return { ok: false, error: `Subject must be ${SUBJECT_MAX} characters or fewer`, reason: "invalid" }
  if (body.length < 10) return { ok: false, error: "Message body must be at least 10 characters", reason: "invalid" }
  if (body.length > BODY_MAX) return { ok: false, error: `Message body must be ${BODY_MAX} characters or fewer`, reason: "invalid" }

  const svc = createServiceClient()

  // The target must be an admin-class user IN this brokerage (never a consumer,
  // never another tenant's user).
  const { data: target, error: targetErr } = await svc
    .from("users")
    .select("id, email, first_name, last_name, user_type, brokerage_id, deleted_at")
    .eq("id", params.targetUserId)
    .maybeSingle()
  if (targetErr) return { ok: false, error: targetErr.message, reason: "invalid" }
  if (!target || (target as any).deleted_at || (target as any).brokerage_id !== params.brokerageId) {
    return { ok: false, error: "Recipient not found in that brokerage", reason: "not_admin" }
  }
  if (!(MESSAGEABLE_USER_TYPES as readonly string[]).includes((target as any).user_type)) {
    return { ok: false, error: `Recipient is a '${(target as any).user_type}' — direct platform messages go to the tenant's broker/admin bench only`, reason: "not_admin" }
  }

  const to = (target as any).email as string | null
  if (!to) {
    return { ok: false, error: "This admin has no email on file — reach them another way", reason: "no_email" }
  }

  // Suppression is a hard legal boundary — checked BEFORE any send attempt.
  if (await isEmailOnSuppressionList(to)) {
    return { ok: false, error: `${to} is on the platform suppression list — it must not be emailed`, reason: "suppressed" }
  }

  // Canonical platform email rail (the same sender dunning + sentinel use).
  let provider: string | null = null
  try {
    const { sendEmail } = await import("@/lib/providers/messaging")
    const sent = await sendEmail({
      to,
      subject,
      html: `<p>${body.replace(/\n/g, "<br>")}</p>`,
      text: body,
    })
    if (!sent.success) {
      return { ok: false, error: `The provider refused the send: ${sent.error ?? "rejected the message"}. Nothing was delivered.`, reason: "provider" }
    }
    provider = sent.provider ?? null
  } catch (e) {
    return { ok: false, error: `The send errored: ${e instanceof Error ? e.message : "unknown error"}. Nothing was delivered.`, reason: "provider" }
  }

  // In-app mirror: the message exists inside the OS, not just in email.
  // Best-effort AFTER provider acceptance — a mirror failure is reported
  // honestly but never un-sends the email.
  let mirrored = false
  try {
    const { error: noteErr } = await svc.from("notifications").insert({
      user_id: (target as any).id,
      brokerage_id: params.brokerageId,
      type: "platform_message",
      title: subject,
      body: body.slice(0, 500),
      entity_type: "brokerage",
      entity_id: params.brokerageId,
      priority: "medium",
      is_read: false,
    })
    mirrored = !noteErr
    if (noteErr) console.error("[tenant-message] notifications mirror failed:", noteErr.message)
  } catch (err) {
    console.error("[tenant-message] notifications mirror failed:", err)
  }

  // Audit: subject + target — NEVER the body (privacy).
  await audit(gate.userId, "tenant_admin.message_sent", (target as any).id, {
    brokerage_id: params.brokerageId,
    to,
    subject,
    body_length: body.length,
    provider,
    mirrored,
  })

  return {
    ok: true,
    mirrored,
    note: mirrored
      ? `Email sent to ${to} and mirrored to their in-app notifications.`
      : `Email sent to ${to}, but the in-app notification mirror failed — the message only exists in email.`,
  }
}
