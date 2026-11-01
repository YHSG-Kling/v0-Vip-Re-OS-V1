import { notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { EVENT_PRODUCER_REGISTRY, EVENT_INTENTS, EVENT_TIMELINE_BUCKETS, isEventKind, isOnlineEvent } from "@/lib/open-house/event-registry"
import { EVENT_EVENT_COLUMNS, eventDisplayTitle, type EventRow } from "@/lib/open-house/event-attendance"
import { resolveConsentBrand } from "@/lib/contact-pipeline/contact-capture"
import { RegistrationForm } from "./registration-form"

/**
 * THE BRANDED REGISTRATION PAGE (C22 — wave 148, lane 148H; owner: "automatic: event + branded registration page"). One page for
 * every kind the registry routes to registration (virtual open house, webinar, education session).
 *
 *   · renders ONLY a published event (its AI-drafted copy APPROVED by a permitted approver — app/actions/open-house.ts
 *     approveEventMarketing); an unpublished, cancelled, completed or kiosk-kind event is a 404;
 *   · the copy is the APPROVED copy; the facts (date, time, host, address) come from the event row;
 *   · branding is the EVENT's brokerage's (global_settings by brokerage_id — never another tenant's logo);
 *   · the payload handed to the client is display-only (no ids beyond the event's, no agent e-mail, no brokerage id);
 *   · the consent is the ONE component (C15, wave 148Z): the page resolves the brand through THE one brand rule
 *     (resolveConsentBrand) and the server re-renders the same words from it — what the person reads is what the C8 record stores.
 */
export default async function EventRegistrationPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) notFound()
  const svc = createServiceClient()
  const { data, error } = await svc.from("open_house_events").select(EVENT_EVENT_COLUMNS).eq("id", eventId).maybeSingle()
  if (error) throw new Error("This event could not be loaded")
  const ev = data as EventRow | null
  if (!ev || !ev.brokerage_id || !isEventKind(ev.event_type) || !ev.is_published) notFound()
  const spec = EVENT_PRODUCER_REGISTRY[ev.event_type]
  if (spec.registration.door?.file !== "app/api/open-house/register/route.ts") notFound()
  if (ev.status === "cancelled" || ev.status === "completed") notFound()
  const assets = (ev.marketing_assets ?? {}) as Record<string, any>
  if (assets.status !== "approved") notFound()
  const copy = (assets.approved ?? {}) as Record<string, unknown>

  const [{ data: brk }, { data: settings }] = await Promise.all([
    svc.from("brokerages").select("name").eq("id", ev.brokerage_id).maybeSingle(),
    svc.from("global_settings").select("app_name, app_logo_url, primary_color").eq("brokerage_id", ev.brokerage_id).maybeSingle(),
  ])
  let hostName: string | null = null
  if (ev.agent_id) {
    const { data: a } = await svc.from("agents").select("user_id").eq("id", ev.agent_id).eq("brokerage_id", ev.brokerage_id).maybeSingle()
    if (a?.user_id) {
      const { data: u } = await svc.from("users").select("first_name, last_name").eq("id", a.user_id).maybeSingle()
      hostName = [u?.first_name, u?.last_name].filter(Boolean).join(" ") || null
    }
  }
  const brokerageName = ((brk as { name?: string | null } | null)?.name ?? "").trim()
  const title = eventDisplayTitle(ev)
  const online = isOnlineEvent(ev.event_type, ev.virtual_provider)

  return (
    <RegistrationForm
      event={{
        id: ev.id,
        kindLabel: spec.label,
        title,
        headline: typeof copy.headline === "string" ? copy.headline : title,
        intro: typeof copy.registration_intro === "string" ? copy.registration_intro : null,
        bullets: Array.isArray(copy.what_you_will_learn) ? (copy.what_you_will_learn as unknown[]).filter((b): b is string => typeof b === "string").slice(0, 5) : [],
        dateLabel: ev.event_date ? new Date(`${String(ev.event_date).slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : null,
        timeLabel: ev.start_time ? `${String(ev.start_time).slice(0, 5)}${ev.end_time ? ` – ${String(ev.end_time).slice(0, 5)}` : ""}${ev.timezone ? ` (${ev.timezone})` : ""}` : null,
        where: online ? (ev.virtual_provider === "zoom" ? "Online — your personal Zoom link arrives when you register" : ev.virtual_provider === "youtube" ? "Online — streamed live; your watch link arrives when you register" : "Online — your join link arrives when you register") : (ev.property_address ?? "In person"),
        hostName,
        online,
        promisesReplay: spec.deliverables.includes("replay_recording"),
      }}
      brand={{ name: (settings as { app_name?: string | null } | null)?.app_name ?? (brokerageName || null), logoUrl: (settings as { app_logo_url?: string | null } | null)?.app_logo_url ?? null, primaryColor: (settings as { primary_color?: string | null } | null)?.primary_color ?? null }}
      consentBrandName={await resolveConsentBrand(svc as never, { brokerageId: ev.brokerage_id, agentId: ev.agent_id ?? null })}
      intents={[...EVENT_INTENTS]}
      timelines={[...EVENT_TIMELINE_BUCKETS]}
    />
  )
}
