// lib/kernel/deal-room-reel.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE DEAL ROOM — under-contract clients get their deal narrated ON CAMERA.
// The white space in client comms: LISTED sellers get the weekly seller-update
// video, SHOPPING buyers get the buyer pulse — but a client UNDER CONTRACT
// (the highest-anxiety stretch in real estate) got text at best. Weekly, each
// active transaction becomes a short branded video: where the deal stands,
// what cleared this week (contingencies from the REAL timestamps), what's
// next (the deadlines ledger), days to close — fronted and narrated by the
// AGENT (contact-facing rule) in their cloned voice.
//
// GOVERNED CLIENT EGRESS: the finished video is NEVER auto-sent. The deliver
// pass proposes ONE gated client message per transaction per ISO week
// ([DEAL_ROOM] dedupe, deal_coordinator's rail) carrying the watch link — a
// human approves, the client gets "my team never sleeps." KEEP-ONE: reuses
// the PartnersMeetingReel composition, the shared brand resolver, identity
// resolver, and voiceover pipeline.

import type { PartnersMeetingReelProps, ReelCard } from "@/lib/intelligence/partners-meeting-reel-props"
import { geometryFor } from "@/lib/remotion/composition-geometry"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"

export const DEAL_ROOM_REEL_ENTITY = "deal_room_reel"

/**
 * The composition this reel rides, named ONCE (§6).
 *
 * It was written out twice — the caption plan's timeline and the queued render's
 * composition_id — and only the render's copy was load-bearing, so the caption
 * half could have come to describe a different video with nothing to notice.
 */
const DEAL_ROOM_COMPOSITION = "PartnersMeetingReel"

export interface DealRoomFacts {
  address: string
  stage: string | null
  daysToClose: number | null
  clearedThisWeek: string[]   // e.g. ["Financing contingency", "Appraisal contingency"]
  nextDeadline: { label: string; date: string } | null
  activityCount7d: number
}

/** PURE: deal facts → cards + narration. Earned/known facts only — an unknown
 *  close date or a quiet week says so honestly, never invents momentum. */
export function buildDealRoomReelProps(
  p: { facts: DealRoomFacts; clientFirstName: string | null; agentName: string; agentPhotoUrl: string | null; brand: { primaryColor: string; accentColor: string; brokerageName: string; logoUrl: string | null; showEhoMark: boolean } },
): PartnersMeetingReelProps {
  const f = p.facts
  const cards: ReelCard[] = []
  if (f.daysToClose != null && f.daysToClose >= 0) {
    cards.push({ value: String(f.daysToClose), label: "DAYS TO CLOSING", sub: f.stage ? `currently in ${f.stage.replace(/_/g, " ").toLowerCase()}` : "on track", kind: "team" })
  }
  for (const cleared of f.clearedThisWeek.slice(0, 2)) {
    cards.push({ value: "CLEARED", label: cleared.toUpperCase(), sub: "one more hurdle behind you", kind: "finance" })
  }
  if (f.activityCount7d > 0) {
    cards.push({ value: String(f.activityCount7d), label: "ACTIONS ON YOUR DEAL THIS WEEK", sub: "your team worked it every day", kind: "team" })
  }
  if (f.nextDeadline) {
    cards.push({ value: f.nextDeadline.date, label: `NEXT: ${f.nextDeadline.label.toUpperCase()}`, sub: "we're already on it", kind: "compliance" })
  }

  const spoken: string[] = [
    `Hi${p.clientFirstName ? ` ${p.clientFirstName}` : ""}, ${p.agentName} here with your weekly update on ${f.address}.`,
  ]
  if (f.clearedThisWeek.length > 0) spoken.push(`Great news this week — ${f.clearedThisWeek.join(" and ")} cleared.`)
  if (f.daysToClose != null && f.daysToClose >= 0) spoken.push(`We're ${f.daysToClose} day${f.daysToClose === 1 ? "" : "s"} from closing${f.stage ? `, currently in ${f.stage.replace(/_/g, " ").toLowerCase()}` : ""}.`)
  if (f.activityCount7d > 0) spoken.push(`The team logged ${f.activityCount7d} action${f.activityCount7d === 1 ? "" : "s"} on your deal this week.`)
  if (f.nextDeadline) spoken.push(`Next up is the ${f.nextDeadline.label.toLowerCase()} on ${f.nextDeadline.date} — we're already on it.`)
  spoken.push(`Questions? Just reply — I'm here.`)

  return {
    weekLabel: f.address,
    cards,
    oneAsk: "Questions? Just reply — your team is on it",
    narration: spoken.join(" "),
    agentName: p.agentName,
    avatarVideoUrl: null,
    agentPhotoUrl: p.agentPhotoUrl,
    brand: p.brand,
  }
}

/** The contingency-cleared labels from the transaction's REAL timestamps. */
export function clearedContingencies(t: { financing_contingency_removed_at?: string | null; appraisal_contingency_removed_at?: string | null }, sinceIso: string): string[] {
  const out: string[] = []
  if (t.financing_contingency_removed_at && t.financing_contingency_removed_at >= sinceIso) out.push("Financing contingency")
  if (t.appraisal_contingency_removed_at && t.appraisal_contingency_removed_at >= sinceIso) out.push("Appraisal contingency")
  return out
}

export interface DealRoomRunResult { transactions: number; queued: number; proposed: number; errors: number }

/** Weekly queue pass (rides the client-pulse cron): one Deal Room video per
 *  active under-contract transaction per ISO week. */
export async function queueDealRoomReels(svc: any, now: Date = new Date()): Promise<DealRoomRunResult> {
  const r: DealRoomRunResult = { transactions: 0, queued: 0, proposed: 0, errors: 0 }
  const since7 = new Date(now.getTime() - 7 * 86_400_000).toISOString()
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(2000)
  for (const b of ((brokerages ?? []) as any[])) {
    try {
      const { data: deals } = await svc.from("transactions")
        .select("id, property_address, deal_name, stage, status, estimated_close_date, contact_id, buyer_contact_id, agent_id, financing_contingency_removed_at, appraisal_contingency_removed_at")
        .eq("brokerage_id", b.id).in("status", [...TRANSACTION_STATUSES_OPEN]).is("deleted_at", null).limit(200)
      for (const t of ((deals ?? []) as any[])) {
        r.transactions += 1
        const contactId = t.contact_id ?? t.buyer_contact_id
        if (!contactId) continue
        const { data: existing } = await svc.from("remotion_composition_renders").select("id")
          .eq("brokerage_id", b.id).eq("entity_type", DEAL_ROOM_REEL_ENTITY).eq("entity_id", t.id)
          .gte("created_at", since7).limit(1).maybeSingle()
        if (existing) continue

        const address = t.property_address ?? t.deal_name ?? "your transaction"
        const [{ data: contact }, { count: acts }, { data: nextDl }, agentUserId] = await Promise.all([
          svc.from("contacts").select("first_name").eq("id", contactId).maybeSingle(),
          svc.from("activities").select("id", { count: "exact", head: true })
            .eq("brokerage_id", b.id).eq("transaction_id", t.id).gte("created_at", since7),
          svc.from("transaction_deadlines").select("deadline_type, deadline_date")
            .eq("brokerage_id", b.id).eq("transaction_id", t.id).eq("status", "pending")
            .gte("deadline_date", now.toISOString().slice(0, 10))
            .order("deadline_date", { ascending: true }).limit(1).maybeSingle(),
          (async () => {
            if (!t.agent_id) return null
            const { data: a } = await svc.from("agents").select("user_id").eq("id", t.agent_id).maybeSingle()
            return (a as any)?.user_id ?? null
          })(),
        ])
        const daysToClose = t.estimated_close_date
          ? Math.max(0, Math.ceil((new Date(t.estimated_close_date).getTime() - now.getTime()) / 86_400_000))
          : null
        const facts: DealRoomFacts = {
          address, stage: t.stage ?? null, daysToClose,
          clearedThisWeek: clearedContingencies(t, since7),
          nextDeadline: nextDl ? { label: String((nextDl as any).deadline_type ?? "deadline").replace(/_/g, " "), date: String((nextDl as any).deadline_date) } : null,
          activityCount7d: (acts as number | null) ?? 0,
        }
        // A totally quiet, dateless deal renders nothing — never a padded video.
        if (facts.daysToClose == null && facts.clearedThisWeek.length === 0 && facts.activityCount7d === 0 && !facts.nextDeadline) continue

        const [{ resolveReelBrand }, { resolveVideoIdentity }] = await Promise.all([
          import("@/lib/video/reel-brand"), import("@/lib/video/video-identity"),
        ])
        const [brand, identity] = await Promise.all([
          resolveReelBrand(svc, b.id),
          resolveVideoIdentity(svc, { brokerageId: b.id, agentUserId, purpose: "contact_facing" }),
        ])
        const props = buildDealRoomReelProps({
          facts, clientFirstName: (contact as any)?.first_name ?? null,
          agentName: identity.speakerName, agentPhotoUrl: identity.avatarPhotoUrl,
          brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, brokerageName: brand.brokerageName, logoUrl: brand.logoUrl, showEhoMark: true },
        }) as unknown as Record<string, unknown>
        const { prepareReelVoiceover } = await import("@/lib/video/reel-voiceover")
        const vo = await prepareReelVoiceover({
          brokerageId: b.id, narration: (props as any).narration, voiceId: identity.voiceId,
          renderKey: `dealroom-${String(t.id).slice(0, 8)}`,
        })
        if (vo) {
          props.voiceover_url = vo.url
          // WORD-SYNCED CAPTIONS (client-facing per the finish spec), TIMED
          // AGAINST THE COMPOSITION'S OWN GEOMETRY.
          //
          // WAS `900, 30` — PartnersMeetingReel's frame count and fps typed out
          // by hand. Both were correct on the day they were written, which is
          // exactly the §2 waypoint pin: durationInFrames is a legal thing to
          // change in lib/remotion/composition-geometry.ts (and every guard
          // permits it), and the captions would then have stopped dead at
          // second 30 of a longer video with nothing anywhere going red. The
          // numbers now come from the registry, so they move when it moves.
          const { buildCaptionPlan } = await import("@/lib/video/caption-plan")
          const geo = geometryFor(DEAL_ROOM_COMPOSITION)
          if (!geo) {
            // REFUSE, do not guess. A composition that is not in the registry
            // has no known timeline, and cueing against a remembered 900/30
            // would place captions on a video whose real length nobody knows.
            console.error(
              `[deal-room-reel] ${DEAL_ROOM_COMPOSITION} is not in the composition registry — `
              + `captions REFUSED rather than timed against a hardcoded frame count. The video still ships.`,
            )
          } else {
            const plan = buildCaptionPlan(
              vo.alignment ?? (props as any).narration,
              geo.duration_frames, geo.fps,
              { tailPaddingFrames: 45 },
            )
            if (plan.cues.length > 0) props.captionsCues = plan.cues
          }
        }
        // Finish-spec: the Deal Room is CLIENT-FACING → tracked outro QR.
        try {
          if (agentUserId) {
            const { mintVideoQr } = await import("@/lib/video/video-qr")
            const minted = await mintVideoQr({ brokerageId: b.id, agentUserId, kind: "explainer", contactId }, svc)
            if (minted) { props.qrCodeDataUrl = minted.qrCodeDataUrl; props.qrCaption = "Scan to reach your team" }
          }
        } catch { /* QR is additive */ }
        props.thumbnail_props = {
          kind: "presentation", title: address, subtitle: "Your deal this week", eyebrow: "DEAL ROOM",
          agentName: identity.speakerName, agentPhotoUrl: identity.avatarPhotoUrl,
          brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, brokerageName: brand.brokerageName, showEhoMark: true, ...(brand.logoUrl ? { logoUrl: brand.logoUrl } : {}) },
        }
        const { recordRenderQueued } = await import("@/lib/remotion/registry")
        const q = await recordRenderQueued({
          brokerageId: b.id, compositionId: DEAL_ROOM_COMPOSITION, agentUserId,
          entityType: DEAL_ROOM_REEL_ENTITY, entityId: t.id,
          inputProps: props, scopeType: "brokerage", scopeId: b.id, requestedVia: "cron",
        })
        if (q.ok) r.queued += 1
      }
    } catch { r.errors += 1 }
  }
  return r
}

/** Deliver pass: finished Deal Room videos → ONE GATED client message per
 *  transaction per ISO week ([DEAL_ROOM] dedupe) — a human approves the send. */
export async function proposeDealRoomReels(svc: any, now: Date = new Date()): Promise<{ completed: number; proposed: number }> {
  const out = { completed: 0, proposed: 0 }
  const since7 = new Date(now.getTime() - 7 * 86_400_000).toISOString()
  const isoWeek = `${now.toISOString().slice(0, 7)}-W${Math.ceil(((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)}`
  const { data: renders } = await svc.from("remotion_composition_renders")
    .select("id, brokerage_id, entity_id, output_url, input_props")
    .eq("entity_type", DEAL_ROOM_REEL_ENTITY)
    .eq("render_status", "succeeded").not("output_url", "is", null)
    .gte("created_at", since7).limit(200)
  for (const ren of ((renders ?? []) as any[])) {
    out.completed += 1
    const tag = `[DEAL_ROOM] [${ren.entity_id}] [${isoWeek}]`
    const { data: dup } = await svc.from("agent_client_messages").select("id")
      .eq("brokerage_id", ren.brokerage_id).ilike("rationale", `${tag}%`).limit(1).maybeSingle()
    if (dup) continue
    const { data: t } = await svc.from("transactions").select("id, contact_id, buyer_contact_id, deal_type")
      .eq("id", ren.entity_id).maybeSingle()
    const contactId = (t as any)?.contact_id ?? (t as any)?.buyer_contact_id
    if (!contactId) continue
    const address = (ren.input_props as any)?.weekLabel ?? "your transaction"
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: ren.brokerage_id, agentKind: "deal_coordinator",
      entityType: "transaction", entityId: ren.entity_id,
      recipientContactId: contactId,
      audience: (t as any)?.deal_type === "listing" ? "seller" : "buyer",
      subject: `Your deal this week — ${address}`,
      body: `Your team put together this week's video update on ${address} — where things stand, what cleared, and what's next: ${ren.output_url}`,
      rationale: `${tag} — the Deal Room: under-contract clients see their deal narrated on camera (facts from the transaction ledgers; approved by a human before it sends).`,
      channel: "portal",
    }, svc)
    if ((res as any)?.ok !== false) out.proposed += 1
  }
  return out
}
