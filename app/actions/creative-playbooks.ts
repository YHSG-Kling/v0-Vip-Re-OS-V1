"use server"

// app/actions/creative-playbooks.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE-CLICK PLAYBOOK INSTALL — ZERO HARDCODED CONTENT (owner rule). The catalog
// (lib/marketing/creative-playbooks) carries only strategy briefs; every
// consumer-facing word is AI-AUTHORED here through the charter path:
// brand-voice grounded (resolveBrandContext), quality-chartered
// (withScriptStandards), routed (generateTextRouted), and compliance-gated by
// the preset writers at save. Authoring failure = the step is SKIPPED with a
// note — never fallback prose (the client-story-drafts honest-absence rule).
//
// THE VIDEO IS CREATED AUTOMATICALLY (owner differentiator): the playbook's
// video brief becomes an AI-written avatar script, gated by evaluateOutbound
// BEFORE any render dollars, then rendered through the platform-locked
// D-ID + ElevenLabs pipeline (the agent's own avatar + cloned voice) and
// attached to the capture page when the poll cron completes it.

import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"
import { getPlaybook, type PlaybookStep } from "@/lib/marketing/creative-playbooks"
import { revalidatePath } from "next/cache"

// ─── listCreativePlaybooks — DELETED (orphan burn-down lane C) ────────────────
//
// FUNCTIONALITY ALREADY ELSEWHERE. The catalog is a CODE-VERSIONED constant,
// not a query: lib/marketing/creative-playbooks.ts:44 exports CREATIVE_PLAYBOOKS
// and the only surface that lists plays — app/settings/campaign-bundles/client.tsx:257
// — imports that constant DIRECTLY and maps over it. This wrapper added a network
// round-trip (and a public HTTP endpoint, since this file is "use server") to hand
// back data the client already had at build time.
//
// NOTHING TO MERGE, and the derived field was the WEAKER of the two: this filtered
// only `bundle` out of the channel list, so it advertised `lead_magnet`, `qr` and
// `video` as "channels". The client filters all four
// (client.tsx:284) and is the version that ships.

// ── The ONE author: brief → charter-governed copy JSON ───────────────────────
async function authorPlaybookCopy(args: {
  brokerageId: string
  kind: string
  brief: string
  playbookTitle: string
  brandLine: string
  /** JSON keys the channel needs, with per-key guidance. */
  shape: Record<string, string>
}): Promise<Record<string, string> | null> {
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { withScriptStandards } = await import("@/lib/ai/script-standards")
    const keys = Object.entries(args.shape).map(([k, hint]) => `"${k}": ${hint}`).join(", ")
    const { text } = await generateTextRouted({
      feature: "client_message",
      brokerageId: args.brokerageId,
      system: withScriptStandards(
        `You write real-estate marketing copy for ${args.brandLine}. Fair-Housing safe: never reference protected classes, family status, or steer. Write like a sharp human, never like a template.`,
      ),
      prompt:
        `Campaign: "${args.playbookTitle}". Channel: ${args.kind}.\n` +
        `Strategy brief (write copy that accomplishes exactly this):\n${args.brief}\n\n` +
        `Return ONLY a JSON object: { ${keys} }`,
      temperature: 0.7,
      maxTokens: 700,
    })
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const k of Object.keys(args.shape)) {
      if (typeof parsed[k] !== "string" || !(parsed[k] as string).trim()) return null
      out[k] = (parsed[k] as string).trim()
    }
    return out
  } catch {
    return null // honest absence — the caller records a skip note
  }
}

export interface InstallPlaybookResult {
  success: boolean
  error?: string
  installed?: {
    magnetUrl?: string | null
    qrImageUrl?: string | null
    bundleId?: string | null
    videoProjectId?: string | null
    presets: Array<{ kind: string; presetId: string; name: string }>
    notes: string[]
  }
}

export async function installCreativePlaybook(playbookKey: string): Promise<InstallPlaybookResult> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  const playbook = getPlaybook(playbookKey)
  if (!playbook) return { success: false, error: "unknown_playbook" }

  const svc = createServiceClient()
  const notes: string[] = []
  const presets: Array<{ kind: string; presetId: string; name: string }> = []
  let magnetUrl: string | null = null
  let magnetId: string | null = null
  let qrImageUrl: string | null = null
  let qrCodeId: string | null = null
  let videoProjectId: string | null = null

  // Brand voice grounding — THE single brand source of truth (tier cascade).
  let brandLine = "the agent's brokerage"
  try {
    const { resolveBrandContext } = await import("@/lib/branding/resolve-brand-context")
    const brand = await resolveBrandContext({ brokerageId: ctx.brokerageId, agentUserId: ctx.userId })
    brandLine = [brand.displayName, (brand as any).tagline].filter(Boolean).join(" — ") || brandLine
  } catch { /* brand grounding is best-effort; the charter still governs */ }

  const author = (kind: string, brief: string, shape: Record<string, string>) =>
    authorPlaybookCopy({ brokerageId: ctx.brokerageId!, kind, brief, playbookTitle: playbook.title, brandLine, shape })

  // ── 1. Lead magnet (AI-authored name/description + landing copy) ──────────
  const magnetStep = playbook.steps.find((s) => s.kind === "lead_magnet")
  if (magnetStep) {
    if (!ctx.agentId) return { success: false, error: "no_agent_context_for_lead_magnet" }
    const copy = await author("lead_magnet", magnetStep.brief, {
      name: "a short compelling page title (max 60 chars)",
      description: "2-3 sentences of landing intro copy",
      thank_you: "one warm sentence shown after form submit",
      headline: "the landing hero headline",
      subhead: "one supporting subheadline",
      bullet_1: "benefit bullet one", bullet_2: "benefit bullet two", bullet_3: "benefit bullet three",
    })
    if (!copy) {
      notes.push(`${magnetStep.label}: copy authoring unavailable — install again in a moment (nothing was created with template prose).`)
    } else {
      const { createLeadMagnet } = await import("@/lib/kernel/lead-magnets")
      const r = await createLeadMagnet({
        title: copy.name,
        magnetType: "home_valuation" as any,
        brokerageId: ctx.brokerageId,
        agentId: ctx.agentId,
        createdBy: ctx.agentId,
        description: copy.description,
        thankYouMessage: copy.thank_you,
      })
      if (!r.success || !r.slug || !r.magnetId) return { success: false, error: r.error ?? "lead_magnet_failed" }
      magnetId = r.magnetId
      magnetUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/lm/${r.slug}`
      // Landing copy — same authored fields, saved through the canonical writer.
      const { saveMagnetLandingContentAction } = await import("@/app/actions/lead-magnets-actions")
      await saveMagnetLandingContentAction(r.magnetId, {
        headline: copy.headline,
        subhead: copy.subhead,
        bullets: [copy.bullet_1, copy.bullet_2, copy.bullet_3],
        cta: copy.thank_you,
        generatedAt: new Date().toISOString(),
      } as any)
    }
  }

  // ── 2. THE AUTO-RENDERED VIDEO (the differentiator) ───────────────────────
  const videoStep = playbook.steps.find((s) => s.kind === "video")
  if (videoStep) {
    if (!ctx.agentId) {
      // The project row is stamped with the agents id; without an agent profile
      // there is nothing to attribute the video to, and the step says so.
      notes.push(`${videoStep.label}: no agent profile on your account yet — finish agent setup and reinstall to get the video.`)
    } else {
      videoProjectId = await createPlaybookVideo({
        svc, brokerageId: ctx.brokerageId, agentUserId: ctx.userId, agentRecordId: ctx.agentId,
        playbook, videoStep, brandLine, magnetId, notes, author,
      })
    }
  }

  // ── 3. Tracked QR pointing at the magnet ──────────────────────────────────
  const qrStep = playbook.steps.find((s) => s.kind === "qr")
  if (qrStep && magnetUrl && ctx.agentId) {
    const { createQrCodeAction } = await import("@/app/actions/marketing-studio")
    const qr = await createQrCodeAction({
      brokerageId: ctx.brokerageId,
      agentId: ctx.agentId,
      label: qrStep.label,
      targetUrl: magnetUrl,
      // purpose is a CHECK-constrained vocabulary — the step BRIEF is prose,
      // never a purpose value (live-fire catch: it made every insert fail).
      purpose: "lead_capture",
    })
    if ((qr as any)?.success) {
      qrImageUrl = (qr as any).qrCode?.image_url ?? (qr as any).imageUrl ?? null
      qrCodeId = (qr as any).qrCode?.id ?? null
    } else {
      notes.push("QR creation deferred — create one from Marketing Studio pointing at the magnet URL.")
    }
  }

  const fill = (text: string) => text.replace(/\{\{magnet_url\}\}/g, magnetUrl ?? "[your home-value page link]")

  // ── 4. Channel presets — every word AI-authored, gated at save ────────────
  const bundleItems: Array<{ channel: string; preset_id: string; order_index: number; send_after_minutes: number }> = []
  let order = 0
  const CHANNEL_SHAPES: Record<string, Record<string, string>> = {
    email: { subject: "the email subject line", body_text: "the plain-text email body (may include {{magnet_url}})" },
    sms: { body: "the SMS text under 160 chars (may include {{magnet_url}})" },
    voicedrop: { tts_script: "the 20-30 second spoken voicemail script" },
    social_post: { caption: "the social caption" },
    direct_mail_postcard: { headline: "the postcard headline (max 9 words)", body: "the postcard body (max 40 words)", cta: "the scan CTA (max 6 words)" },
    direct_mail_letter: { greeting: "the letter opening line", body: "the letter body (120-180 words)", signoff: "the closing line before the signature" },
  }

  for (const step of playbook.steps) {
    if (["lead_magnet", "qr", "bundle", "video"].includes(step.kind)) continue
    const shape = CHANNEL_SHAPES[step.kind]
    const copy = shape ? await author(step.kind, step.brief, shape) : null
    if (!copy) {
      notes.push(`${step.label}: skipped — copy authoring unavailable (no template prose was substituted).`)
      continue
    }
    if (step.kind === "direct_mail_postcard" || step.kind === "direct_mail_letter") {
      const { upsertDirectMailPreset } = await import("@/app/actions/direct-mail-presets")
      const isPostcard = step.kind === "direct_mail_postcard"
      const r = await upsertDirectMailPreset({
        name: step.label,
        piece_type: isPostcard ? "postcard" : "letter",
        postcard_size: isPostcard ? "6x9" : null,
        locked_headline: isPostcard ? fill(copy.headline) : null,
        locked_body: isPostcard ? fill(copy.body) : null,
        locked_cta: isPostcard ? copy.cta : null,
        property_photo_url: qrImageUrl, // the QR IS the art focus on these plays
        locked_letter_greeting: !isPostcard ? copy.greeting : null,
        locked_letter_body: !isPostcard ? fill(copy.body) : null,
        locked_letter_signoff: !isPostcard ? copy.signoff : null,
      })
      if (r.success && r.presetId) {
        presets.push({ kind: step.kind, presetId: r.presetId, name: step.label })
        bundleItems.push({ channel: step.kind, preset_id: r.presetId, order_index: order++, send_after_minutes: step.sendAfterMinutes ?? 0 })
      } else {
        notes.push(`${step.label}: ${r.error ?? (r.violations?.length ? "blocked by compliance gate — regenerate from the playbook" : "skipped")}`)
      }
      continue
    }
    const { upsertCampaignPreset } = await import("@/app/actions/campaign-presets")
    const fieldMap: Record<string, Record<string, unknown>> = {
      email: { subject: copy.subject, body_text: fill(copy.body_text ?? "") },
      sms: { body: fill(copy.body ?? "") },
      voicedrop: { tts_script: fill(copy.tts_script ?? "") },
      social_post: { caption: fill(copy.caption ?? "") },
    }
    const r = await upsertCampaignPreset({
      channel: step.kind as any,
      name: step.label,
      fields: fieldMap[step.kind] ?? {},
    })
    if (r.success && r.presetId) {
      presets.push({ kind: step.kind, presetId: r.presetId, name: step.label })
      bundleItems.push({ channel: step.kind, preset_id: r.presetId, order_index: order++, send_after_minutes: step.sendAfterMinutes ?? 0 })
    } else {
      notes.push(`${step.label}: ${r.error ?? "skipped"}`)
    }
  }

  // ── 5. The bundle that fires them in order ────────────────────────────────
  let bundleId: string | null = null
  const bundleStep = playbook.steps.find((s) => s.kind === "bundle")
  if (bundleStep && bundleItems.length > 0) {
    const { upsertCampaignBundle } = await import("@/app/actions/campaign-bundles")
    const r = await upsertCampaignBundle({
      name: bundleStep.label,
      description: `${playbook.strategy} — installed from the ${playbook.title} playbook.`,
      items: bundleItems as any,
    })
    if (r.success && r.bundleId) bundleId = r.bundleId
    else notes.push(`Bundle: ${r.error ?? "not created — compose it from the installed presets"}`)
  }

  // OUTCOME LINKAGE (the scoreboard's anchor): the magnet's landing_content
  // carries the playbook key + the ids of every asset whose LEDGERS score it
  // (qr_codes scan/lead counts, ai_video_projects render state, the bundle).
  if (magnetId) {
    const { data: magnetRow } = await svc
      .from("lead_capture_forms").select("landing_content").eq("id", magnetId).maybeSingle()
    await svc.from("lead_capture_forms").update({
      landing_content: {
        ...(((magnetRow as any)?.landing_content as Record<string, unknown>) ?? {}),
        playbookKey: playbook.key,
        qrCodeId,
        bundleId,
        videoProjectId,
        installedAt: new Date().toISOString(),
      },
    }).eq("id", magnetId)
  }

  revalidatePath("/settings/campaign-bundles")
  return { success: true, installed: { magnetUrl, qrImageUrl, bundleId, videoProjectId, presets, notes } }
}

// ── THE PLAYBOOK SCOREBOARD (outcome learning) ───────────────────────────────
// Every number comes from a ledger that already exists: qr_codes.scan_count /
// lead_count (the tracked QR), lead_capture_forms.submission_count (the
// capture page), ai_video_projects.status (the auto-render). Nothing modeled,
// nothing estimated — "Zestimate Challenge: 214 scans, 31 valuations" is read
// straight off the tables the flows write.

export interface PlaybookScore {
  playbookKey: string
  installs: number
  qrScans: number
  qrLeads: number
  submissions: number
  videoStatus: string | null
  lastInstalledAt: string | null
}

export async function loadPlaybookScoreboard(): Promise<PlaybookScore[]> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return []
  const svc = createServiceClient()

  const { data: magnets } = await svc
    .from("lead_capture_forms")
    .select("id, submission_count, landing_content")
    .eq("brokerage_id", ctx.brokerageId)
    .not("landing_content->>playbookKey", "is", null)
    .limit(200)
  const rows = (magnets ?? []) as Array<{ id: string; submission_count: number | null; landing_content: any }>
  if (rows.length === 0) return []

  const qrIds = rows.map((r) => r.landing_content?.qrCodeId).filter(Boolean) as string[]
  const videoIds = rows.map((r) => r.landing_content?.videoProjectId).filter(Boolean) as string[]
  const [{ data: qrs }, { data: videos }] = await Promise.all([
    qrIds.length ? svc.from("qr_codes").select("id, scan_count, lead_count").in("id", qrIds) : Promise.resolve({ data: [] }),
    videoIds.length ? svc.from("ai_video_projects").select("id, status").in("id", videoIds) : Promise.resolve({ data: [] }),
  ])
  const qrById = new Map(((qrs ?? []) as any[]).map((q) => [q.id, q]))
  const videoById = new Map(((videos ?? []) as any[]).map((v) => [v.id, v]))

  const byKey = new Map<string, PlaybookScore>()
  for (const r of rows) {
    const key = r.landing_content?.playbookKey as string
    const s = byKey.get(key) ?? { playbookKey: key, installs: 0, qrScans: 0, qrLeads: 0, submissions: 0, videoStatus: null, lastInstalledAt: null }
    s.installs++
    s.submissions += r.submission_count ?? 0
    const qr = qrById.get(r.landing_content?.qrCodeId)
    if (qr) { s.qrScans += qr.scan_count ?? 0; s.qrLeads += qr.lead_count ?? 0 }
    const video = videoById.get(r.landing_content?.videoProjectId)
    if (video) s.videoStatus = video.status
    const at = r.landing_content?.installedAt as string | undefined
    if (at && (!s.lastInstalledAt || at > s.lastInstalledAt)) s.lastInstalledAt = at
    byKey.set(key, s)
  }
  return [...byKey.values()]
}

// ── The auto-video: AI script → compliance gate → D-ID render pipeline ───────
async function createPlaybookVideo(args: {
  svc: ReturnType<typeof createServiceClient>
  brokerageId: string
  agentUserId: string
  agentRecordId: string
  playbook: { key: string; title: string }
  videoStep: PlaybookStep
  brandLine: string
  magnetId: string | null
  notes: string[]
  author: (kind: string, brief: string, shape: Record<string, string>) => Promise<Record<string, string> | null>
}): Promise<string | null> {
  const { svc, notes } = args

  // Avatar + clone must exist BEFORE any spend (the dispatch would fail anyway;
  // failing early gives the agent an actionable note instead of a dead project).
  const { data: voiceProfile } = await svc
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id, did_photo_url, did_video_url")
    .eq("agent_id", args.agentRecordId)
    .maybeSingle()
  if (!voiceProfile?.elevenlabs_voice_id || !(voiceProfile.did_photo_url || voiceProfile.did_video_url)) {
    notes.push("Video: set up your avatar + voice clone (Settings → Voice & Avatar), then reinstall — the presentation video renders automatically.")
    return null
  }

  const copy = await args.author("video_script", args.videoStep.brief, {
    title: "a short internal video title",
    script: "the full 60-90 second spoken script, first person, natural pauses, no stage directions",
  })
  if (!copy) {
    notes.push(`${args.videoStep.label}: script authoring unavailable — reinstall to retry (no template script was used).`)
    return null
  }

  // Compliance gate BEFORE render dollars (the intro-reactor discipline).
  try {
    const { evaluateOutbound } = await import("@/lib/kernel/compliance")
    const gate = await evaluateOutbound({
      actorContext: { brokerageId: args.brokerageId, role: "agent", userId: args.agentUserId },
      messageType: "social",
      journeyType: "seller",
      persona: "other",
      content: copy.script,
    } as any)
    if (gate && (gate as any).allowed === false) {
      notes.push(`${args.videoStep.label}: script blocked by the compliance gate — reinstall to regenerate.`)
      return null
    }
  } catch { /* gate unavailable → proceed; the send-side gates still stand */ }

  // agentRecordId is the agents id already resolved by the caller's context —
  // the same one the voice-profile gate above keys on. agentUserId stays for
  // the compliance/dispatch calls, which are users-class.
  const { data: project, error: projErr } = await svc
    .from("ai_video_projects")
    .insert({
      brokerage_id: args.brokerageId,
      agent_id: args.agentRecordId,
      title: copy.title,
      script_content: copy.script,
      video_type: "education",
      status: "queued",
      usage_intent: "public_marketing",
      audience_type: "customer_facing",
      duration_seconds: 75,
      compliance_status: "passed",
      compliance_evaluated_at: new Date().toISOString(),
      is_ai_generated: true,
      video_metadata: { playbook_key: args.playbook.key, lead_magnet_id: args.magnetId },
    })
    .select("id")
    .single()
  if (projErr || !project) {
    notes.push(`${args.videoStep.label}: video project failed (${projErr?.message ?? "unknown"}).`)
    return null
  }

  // Submit the render through the platform-locked D-ID + ElevenLabs egress.
  const { dispatchVideo } = await import("@/lib/providers/dispatch")
  const submission = await dispatchVideo({
    brokerageId: args.brokerageId,
    userId: args.agentUserId,
    templateId: copy.script,
    recipientEmail: "", // marketing explainer — no per-contact recipient
    systemSource: `creative_playbook.${args.playbook.key}`,
    metadata: { ai_video_project_id: (project as any).id, lead_magnet_id: args.magnetId },
  })
  if (!submission.success || !submission.messageId) {
    await svc.from("ai_video_projects")
      .update({ status: "failed", error_message: submission.error ?? "dispatch failed" })
      .eq("id", (project as any).id)
    notes.push(`${args.videoStep.label}: render submit failed — ${submission.error ?? "provider error"}.`)
    return null
  }

  // Link the D-ID job so poll-did-videos completes it (eligibility: status
  // 'generating' + provider_job_id + provider_metadata.provider='did').
  await svc.from("ai_video_projects").update({
    status: "generating",
    provider_job_id: submission.messageId,
    provider_status: "processing",
    video_provider: "did",
    provider_metadata: {
      provider: "did",
      mode: voiceProfile.did_video_url ? "clip" : "talk",
      lead_magnet_id: args.magnetId,
      playbook_key: args.playbook.key,
    },
  }).eq("id", (project as any).id)

  notes.push("Video: rendering now with your avatar + voice — it attaches to the capture page automatically when done.")
  return (project as any).id as string
}
