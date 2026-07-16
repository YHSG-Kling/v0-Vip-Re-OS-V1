"use server"

// app/actions/creative-playbooks.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE-CLICK PLAYBOOK INSTALL. Instantiates a creative playbook (see
// lib/marketing/creative-playbooks) through the EXISTING governed rails:
// lead magnet → tracked QR → compliance-gated channel + direct-mail presets →
// campaign bundle. Copy placeholders resolve here ({{magnet_url}}); QR target
// is the magnet's public /lm/[slug] page. Nothing sends — the shelves get
// stocked and dispatch stays behind the existing approval chokepoints.

import { getAgentContext } from "@/lib/identity/get-agent-context"
import { getPlaybook, CREATIVE_PLAYBOOKS } from "@/lib/marketing/creative-playbooks"
import { revalidatePath } from "next/cache"

export async function listCreativePlaybooks() {
  // Catalog metadata for the picker (code-versioned; no DB read needed).
  return CREATIVE_PLAYBOOKS.map((p) => ({
    key: p.key, title: p.title, hook: p.hook, whyItWorks: p.whyItWorks, ridesOn: p.ridesOn,
    channels: p.steps.map((s) => s.kind).filter((k) => k !== "bundle"),
  }))
}

export interface InstallPlaybookResult {
  success: boolean
  error?: string
  installed?: {
    magnetUrl?: string | null
    qrImageUrl?: string | null
    bundleId?: string | null
    presets: Array<{ kind: string; presetId: string; name: string }>
    notes: string[]
  }
}

export async function installCreativePlaybook(playbookKey: string): Promise<InstallPlaybookResult> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  const playbook = getPlaybook(playbookKey)
  if (!playbook) return { success: false, error: "unknown_playbook" }

  const notes: string[] = []
  const presets: Array<{ kind: string; presetId: string; name: string }> = []
  let magnetUrl: string | null = null
  let qrImageUrl: string | null = null

  // ── 1. Lead magnet (the QR/link destination) ──────────────────────────────
  const magnetStep = playbook.steps.find((s) => s.kind === "lead_magnet")
  if (magnetStep) {
    if (!ctx.agentId) return { success: false, error: "no_agent_context_for_lead_magnet" }
    const { createLeadMagnet } = await import("@/lib/kernel/lead-magnets")
    const r = await createLeadMagnet({
      title: magnetStep.fields.name,
      magnetType: magnetStep.fields.magnet_type as any,
      brokerageId: ctx.brokerageId,
      agentId: ctx.agentId,
      createdBy: ctx.agentId,
      description: magnetStep.fields.description ?? "",
      thankYouMessage: magnetStep.fields.thank_you,
    })
    if (!r.success || !r.slug) return { success: false, error: r.error ?? "lead_magnet_failed" }
    const base = process.env.NEXT_PUBLIC_APP_URL ?? ""
    magnetUrl = `${base}/lm/${r.slug}`
    if (magnetStep.fields.video_slot_note) notes.push(magnetStep.fields.video_slot_note)
  }

  // ── 2. Tracked QR pointing at the magnet ──────────────────────────────────
  const qrStep = playbook.steps.find((s) => s.kind === "qr")
  if (qrStep && magnetUrl && ctx.agentId) {
    const { createQrCodeAction } = await import("@/app/actions/marketing-studio")
    const qr = await createQrCodeAction({
      brokerageId: ctx.brokerageId,
      agentId: ctx.agentId,
      label: qrStep.fields.label,
      targetUrl: magnetUrl,
      purpose: (qrStep.fields.purpose as any) ?? "lead_capture",
    })
    if ((qr as any)?.success) qrImageUrl = (qr as any).qrCode?.image_url ?? (qr as any).imageUrl ?? null
    else notes.push("QR creation deferred — create one from Marketing Studio pointing at the magnet URL.")
  }

  const fill = (text: string) => text.replace(/\{\{magnet_url\}\}/g, magnetUrl ?? "[your home-value page link]")
    .replace(/\{\{zestimate_hint\}\}/g, "a number") // mail merge personalizes per recipient at dispatch

  // ── 3. Channel presets (compliance-gated at save by their writers) ───────
  const bundleItems: Array<{ channel: string; preset_id: string; order_index: number; send_after_minutes: number }> = []
  let order = 0
  for (const step of playbook.steps) {
    if (["lead_magnet", "qr", "bundle"].includes(step.kind)) continue
    if (step.kind === "direct_mail_postcard" || step.kind === "direct_mail_letter") {
      const { upsertDirectMailPreset } = await import("@/app/actions/direct-mail-presets")
      const isPostcard = step.kind === "direct_mail_postcard"
      const r = await upsertDirectMailPreset({
        name: step.fields.name,
        piece_type: isPostcard ? "postcard" : "letter",
        postcard_size: isPostcard ? "6x9" : null,
        locked_headline: isPostcard ? fill(step.fields.headline ?? "") : null,
        locked_body: isPostcard ? fill(step.fields.body ?? "") : null,
        locked_cta: isPostcard ? (step.fields.cta ?? null) : null,
        property_photo_url: qrImageUrl, // the QR IS the art focus on these plays
        locked_letter_greeting: !isPostcard ? (step.fields.greeting ?? null) : null,
        locked_letter_body: !isPostcard ? fill(step.fields.body ?? "") : null,
        locked_letter_signoff: !isPostcard ? (step.fields.signoff ?? null) : null,
      })
      if (r.success && r.presetId) {
        presets.push({ kind: step.kind, presetId: r.presetId, name: step.fields.name })
        bundleItems.push({ channel: step.kind, preset_id: r.presetId, order_index: order++, send_after_minutes: step.sendAfterMinutes ?? 0 })
      } else {
        notes.push(`${step.fields.name}: ${r.error ?? (r.violations?.length ? "blocked by compliance gate — revise copy in Direct Mail settings" : "skipped")}`)
      }
      continue
    }
    // email / sms / voicedrop / social_post ride the canonical preset writer.
    const { upsertCampaignPreset } = await import("@/app/actions/campaign-presets")
    const fieldMap: Record<string, Record<string, unknown>> = {
      email: { subject: step.fields.subject, body_text: fill(step.fields.body_text ?? "") },
      sms: { body: fill(step.fields.body ?? "") },
      voicedrop: { tts_script: fill(step.fields.tts_script ?? "") },
      social_post: { caption: fill(step.fields.caption ?? "") },
    }
    const r = await upsertCampaignPreset({
      channel: step.kind as any,
      name: step.fields.name,
      fields: fieldMap[step.kind] ?? {},
    })
    if (r.success && r.presetId) {
      presets.push({ kind: step.kind, presetId: r.presetId, name: step.fields.name })
      bundleItems.push({ channel: step.kind, preset_id: r.presetId, order_index: order++, send_after_minutes: step.sendAfterMinutes ?? 0 })
    } else {
      notes.push(`${step.fields.name}: ${r.error ?? "skipped"}`)
    }
  }

  // ── 4. The bundle that fires them in order ────────────────────────────────
  let bundleId: string | null = null
  const bundleStep = playbook.steps.find((s) => s.kind === "bundle")
  if (bundleStep && bundleItems.length > 0) {
    const { upsertCampaignBundle } = await import("@/app/actions/campaign-bundles")
    const r = await upsertCampaignBundle({
      name: bundleStep.fields.name,
      description: `${playbook.hook} — installed from the ${playbook.title} playbook.`,
      items: bundleItems as any,
    })
    if (r.success && r.bundleId) bundleId = r.bundleId
    else notes.push(`Bundle: ${r.error ?? "not created — compose it from the installed presets"}`)
  }

  revalidatePath("/settings/campaign-bundles")
  return { success: true, installed: { magnetUrl, qrImageUrl, bundleId, presets, notes } }
}
