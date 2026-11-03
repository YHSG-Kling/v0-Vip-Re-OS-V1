import { notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { EVENT_PRODUCER_REGISTRY, REGISTRATION_QUESTIONS, isEventKind, isOnlineEvent } from "@/lib/open-house/event-registry"
import { EVENT_EVENT_COLUMNS, eventDisplayTitle, type EventRow } from "@/lib/open-house/event-attendance"
import { resolveEventBrand } from "@/lib/open-house/event-marketing"
import { RegistrationForm } from "./registration-form"

/**
 * THE BRANDED REGISTRATION PAGE (C22 + C32) — ONE server view rendered at two addresses:
 *   · INSIDE the tenant's own website, /site/<slug>/events/<eventId> (rulings 11 + 12 — the address the invitation and the QR
 *     carry; the event must belong to THAT site's tenant, else 404 — never another tenant's event under this storefront);
 *   · the platform-origin /open-house/<eventId>/register (a tenant with no site slug; links already sent keep resolving).
 *
 *   · renders ONLY a published event (its AI-drafted copy APPROVED by a permitted approver — approveEventMarketing); an
 *     unpublished, cancelled, completed or kiosk-kind event is a 404;
 *   · BRAND (C32, wave 149 — owner ruling 15): the CREATING tenant's, through THE cascade (resolveEventBrand → resolveBrandContext:
 *     team > brokerage name, logo, colour, website, EHO line). TOMBSTONE: this page used to put `global_settings.app_name` in the
 *     header — a column whose live DEFAULT is 'VIP Real Estate OS' (read 2026-11-03), i.e. the platform's name on any tenant that
 *     never renamed it. The platform's brand appears only on a platform-owned event (brand_owner = 'platform');
 *   · the questions are the kind's OWN closed situation questions (REGISTRATION_QUESTIONS, ruling 16) — no open "anything else?";
 *   · the payload handed to the client is display-only (no ids beyond the event's, no agent e-mail, no brokerage id);
 *   · the consent is the ONE component (C15): its brand is the legal entity resolveConsentBrand reads (the event brand's
 *     `brokerageName`) — the words the person reads are the words the server re-renders and stores.
 */
export async function EventRegistrationView({ eventId, siteBrokerageId }: { eventId: string; siteBrokerageId?: string | null }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) notFound()
  const svc = createServiceClient()
  const { data, error } = await svc.from("open_house_events").select(EVENT_EVENT_COLUMNS).eq("id", eventId).maybeSingle()
  if (error) throw new Error("This event could not be loaded")
  const ev = data as EventRow | null
  if (!ev || !ev.brokerage_id || !isEventKind(ev.event_type) || !ev.is_published) notFound()
  if (siteBrokerageId !== undefined && siteBrokerageId !== ev.brokerage_id) notFound()
  const spec = EVENT_PRODUCER_REGISTRY[ev.event_type]
  if (spec.registration.door?.file !== "app/api/open-house/register/route.ts") notFound()
  if (ev.status === "cancelled" || ev.status === "completed") notFound()
  const assets = (ev.marketing_assets ?? {}) as Record<string, any>
  if (assets.status !== "approved") notFound()
  const copy = (assets.approved ?? {}) as Record<string, unknown>

  const brand = await resolveEventBrand(svc, { id: ev.id, brokerage_id: ev.brokerage_id, agent_id: ev.agent_id, created_by: ev.created_by })
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
        hostName: brand.agentName,
        online,
        promisesReplay: spec.deliverables.includes("replay_recording"),
      }}
      brand={{ name: brand.displayName, logoUrl: brand.logoUrl, primaryColor: brand.primaryColor, website: brand.website, fairHousingLine: brand.fairHousingLine }}
      consentBrandName={brand.brokerageName}
      questions={REGISTRATION_QUESTIONS[ev.event_type].map((q) => ({ key: q.key, prompt: q.prompt, kind: q.kind, options: q.options.map((o) => ({ value: o.value, label: o.label })) }))}
    />
  )
}
