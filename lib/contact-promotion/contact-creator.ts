/**
 * Creates a contact record from a promoted lead — THE canonical lead→contact
 * converter (Data Steward owned). Canonical business process: leads are AI-ISA +
 * brokerage owned while unconsented; the moment the ISA qualifies, the lead is
 * CONVERTED to a contact with the agent resolved by the contact-assignment
 * settings (agent → team lead → team-lead/brokerage admin → platform).
 *
 * Critical Rules:
 * - LOSSLESS: identity + physical/mailing address + secondary phone + enrichment
 *   profile + ISA qualification carry all move upward (nothing dropped at the hop).
 * - agentId MUST be agents.id (contacts.agent_id FK semantics per migration 111 —
 *   a users.id here makes the contact INVISIBLE to the agent's CRM via RLS).
 * - Do NOT copy internal pipeline fields (enrichment_status etc.).
 */

import { peopleDataProfileToContactColumns } from '@/lib/lead-pipeline/enrichment-column-map'
import { ENUM_VOCABULARIES, normalizeEnumValue } from '@/lib/data-steward/value-normalizer'
import { canonicalContactType, isStorableContactType } from "@/lib/contact-types"
import { normalizeContactPersona } from "@/lib/campaigns/contact-sources"
// NOTE: `queueContactEnrichment` is imported DYNAMICALLY at its call site below,
// not statically at module scope. lib/enrichment/contact-enrichment-core.ts is
// `server-only` (it holds the service client and the paid PeopleData/OSINT
// clients), and a static import here would pull that into every module graph
// that reaches this file — including the plain `tsx` guard simulators, which are
// not a server component and crash on `server-only` at load. lib/kernel/crm.ts
// already used the dynamic form for exactly this reason; these call sites were
// the inconsistency. The queue call is best-effort and already awaited/voided,
// so deferring the import costs nothing.

export interface ContactCreationData {
  leadId: string
  lead: any
  /** agents.id of the assigned agent (NOT users.id). */
  agentId: string
  brokerageId: string
}

/**
 * The ISA qualified the lead by intent; that intent IS the contact type going
 * forward (canonical contact_type vocabulary): buyer/seller; 'both' maps to
 * buyer. 'investor' maps to BUYER too — owner ruling 2026-08-31, verbatim:
 * "investor is a persona and not a contact type" — the investing lands on
 * contact_persona='investor' (m589) via resolveContactPersona below, and m593
 * (APPLIED 2026-08-31) retired 'investor' from contacts_contact_type_check.
 */
export function motivationToContactType(m: string | null | undefined): string | null {
  if (!m) return null
  const lower = m.toLowerCase()
  // 'investor_landlord' is the scraped rental-listing motivation — a LANDLORD
  // is an owner the pipeline sourced as a potential SELLER of their rental
  // (lib/lead-pipeline/source-intent-map.ts: "landlord/investor SELLER
  // signal"). The old 'investor' contact_type flattened that side away; now the
  // side is seller and the investing rides contact_persona.
  if (lower.includes('landlord')) return 'seller'
  if (lower.includes('investor')) return 'buyer'
  if (lower.includes('seller')) return 'seller'
  if (lower.includes('both')) return 'buyer'
  if (lower.includes('buyer')) return 'buyer'
  return null
}

// Canonical contact_type vocabulary — the SINGLE source is the Data Steward's
// ENUM_VOCABULARIES (which mirrors the contacts_contact_type_check CHECK constraint).
// Any value NOT in this set is rejected by the database, so a contact insert with a
// non-canonical contact_type fails and the lead is never promoted (a silent drop).
export const CONTACT_TYPES = ENUM_VOCABULARIES.contact_type.canonical
export type ContactType = (typeof CONTACT_TYPES)[number]

/**
 * resolveContactType — the lead→contact type decision, guaranteed to return a
 * CANONICAL contact_type. motivation_type wins (qualified intent), then lead_type;
 * the final fallback runs lead_type through the Data Steward normalizer (exact +
 * synonym, e.g. 'fsbo'→'seller') and defaults to 'prospect' when nothing resolves —
 * a raw lead_type of 'unknown' (a real pipeline value) becomes 'prospect', never the
 * literal 'unknown' the CHECK constraint would reject. Without this clamp, every
 * unknown-intent scraped lead failed to convert.
 */
export function resolveContactType(
  motivationType: string | null | undefined,
  leadType: string | null | undefined,
): ContactType {
  const fromMotivation = motivationToContactType(motivationType)
  if (fromMotivation) return fromMotivation as ContactType
  const fromLeadType = motivationToContactType(leadType)
  if (fromLeadType) return fromLeadType as ContactType

  // A RETIRED SPELLING IS MAPPED FORWARD, NOT CLAMPED TO THE DEFAULT.
  // `leads.lead_type` is free text and routinely arrives from an import or a partner
  // feed carrying `past_client` — a spelling m539 retired from contacts.contact_type.
  // Without this line the normalizer finds no canonical match and the clamp below
  // files a known past client as a fresh `prospect`, which is not a silent DROP but
  // is a silent DEMOTION: they lose the lifetime lane, the sphere roster and the
  // referral radar. canonicalContactType is the one place a retired spelling is
  // resolved (lib/contact-types.ts).
  const carriedForward = canonicalContactType(leadType)
  if (carriedForward) return carriedForward as ContactType

  const normalized = normalizeEnumValue('contact_type', leadType).value as ContactType | null
  // FINAL CLAMP. The normalizer is the SAME vocabulary the CHECK enforces, but it is
  // reached through a synonym table that a future edit could widen, so the result is
  // re-tested against what the database will actually store before it is returned —
  // a value outside the CHECK is refused entirely (23514) and the lead is never
  // promoted at all.
  if (normalized && isStorableContactType(normalized)) return normalized
  return 'prospect'
}

export async function createContactFromLead(
  supabase: any,
  data: ContactCreationData
): Promise<{ contactId?: string; error?: string }> {
  
  try {
    // The contact belongs to the assigned agent's OFFICE + TEAM, so resolve them from the agent and
    // stamp them on the contact. Without this every converted contact landed with location_id/team_id
    // = null, so any location/team-scoped contacts query (the command center, a location admin's CRM,
    // scoped reporting) silently excluded it even though its agent sits in that office. Best-effort —
    // a missing agent row just leaves them null (same as before).
    let agentLocationId: string | null = null
    let agentTeamId: string | null = null
    {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("location_id, team_id")
        .eq("id", data.agentId)
        .maybeSingle()
      agentLocationId = agentRow?.location_id ?? null
      agentTeamId = agentRow?.team_id ?? null
    }

    // Map lead data to contact schema.
    //
    // POLICY (owner's ruling: "all the same fields so data can be duplicated to the
    // new contact record without losing any history"): the DEFAULT IS COPY. Every
    // column that exists on BOTH `leads` and `contacts` is carried unless there is a
    // named reason not to. The four deliberate exceptions, each verified against
    // scripts/schema-snapshot.ts:
    //
    //   id             — the leads PK. Obviously not the contact's.
    //   contact_id     — `leads.contact_id` is an FK to contacts.id (migration 039
    //                    joins `l.contact_id = c.id`). `contacts.contact_id` is a
    //                    DIFFERENT column: the contact's own secondary uuid, never
    //                    equal to its `id`. Copying one into the other writes a
    //                    foreign PK into the new contact's secondary identity — the
    //                    exact two-uuid confusion that broke the unsubscribe endpoint.
    //   phone_digits   — trigger/generated on BOTH tables (m488 live-verified 428C9
    //                    "cannot insert a non-DEFAULT value into column phone_digits"
    //                    on leads; scripts/add-lead-id-to-copilot-plans.sql documents
    //                    the contacts one as trigger-controlled: "Inserts must NOT
    //                    include it directly"). Naming it would refuse the WHOLE
    //                    insert and kill the conversion.
    //   lifecycle_state— same column NAME, two different vocabularies. leads has a
    //                    CHECK of raw|unconsented|consented|isa_qualifying|assigned|
    //                    appointment|representation|long_term_nurture
    //                    (lib/lead-pipeline/lead-lifecycle.ts, read off the live DB);
    //                    contacts is written/filtered with new|nurturing|qualified|
    //                    lifetime_customer (app/actions/agent-public-profile.ts:72,
    //                    app/actions/ai-lead-scoring.ts:293). A raw copy poisons every
    //                    contact-side lifecycle filter. MAPPED to 'new' below instead —
    //                    left NULL, the contact was invisible to AI lead scoring.
    const contactData = {
      // Basic identity
      first_name: data.lead.first_name,
      last_name: data.lead.last_name,
      email: data.lead.email,
      phone: data.lead.phone,
      // Carry the secondary phone upward (leads -> contacts). Independently gateable so a
      // DNC/opt-out on one line never silently drops the other reachable number.
      phone_secondary: data.lead.phone_secondary ?? null,

      // Attribution — full source provenance moves upward, INCLUDING the first-touch
      // pair and the paid-acquisition ledger. Before this the contact kept only the
      // last-touch source triple, so "which campaign bought this client, and what did
      // the record cost" (lib/lead-pipeline/source-conversion-runner.ts's ROI question)
      // could only ever be answered from the lead side.
      source: data.lead.source || 'lead_promotion',
      source_family: data.lead.source_family ?? null,
      source_channel: data.lead.source_channel ?? null,
      source_subtype: data.lead.source_subtype ?? null,
      campaign_attribution_id: data.lead.campaign_attribution_id ?? null,
      cost_per_record:         data.lead.cost_per_record ?? null,
      first_touch_channel:     data.lead.first_touch_channel ?? null,
      first_touched_at:        data.lead.first_touched_at ?? null,

      // Relationship context (agentId is agents.id — see ContactCreationData)
      agent_id: data.agentId,
      brokerage_id: data.brokerageId,
      // Office + team inherited from the assigned agent so the contact rolls up to the right
      // location/team in scoped reporting and the command center.
      location_id: agentLocationId,
      team_id: agentTeamId,

      // Contact type and persona — the ISA's qualified intent IS the contact type.
      // resolveContactType guarantees a CANONICAL value (the CHECK constraint rejects
      // anything else, which would silently fail the whole insert).
      contact_type: resolveContactType(data.lead.motivation_type, data.lead.lead_type),
      // The persona must be CANONICAL too — contacts_contact_persona_check (14
      // values since m589) refuses anything else and kills the WHOLE insert
      // (23514, §3). This used to write 'both' (a contact_type, never a persona)
      // and raw lead spellings ('motivated_seller', 'first_time_buyer') straight
      // through, every one a refused row. normalizeContactPersona maps drifted
      // spellings forward and answers NULL for a value that names no situation —
      // 'motivated_seller' included, deliberately: the persona says the
      // SITUATION (probate/divorce/foreclosure/expired/fsbo/senior name the
      // why), lead_temperature says the urgency, and the scraped signal record
      // keeps the fact. An 'investor'-intent lead gets the investor persona
      // (owner ruling — see motivationToContactType above).
      contact_persona:
        (data.lead.motivation_type ?? '').toLowerCase().includes('investor')
        || (data.lead.lead_type ?? '').toLowerCase() === 'investor'
          ? 'investor'
          : normalizeContactPersona(data.lead.contact_persona ?? data.lead.persona ?? null),

      // Intent indicators (if available). NOTE: `leads` has NO intent_score column
      // (verified against scripts/schema-snapshot.ts) — this read is always undefined
      // and the key is dropped before it reaches PostgREST. Left as-is rather than
      // silently aliasing lead_score into it: intent and qualification are different
      // scores and fabricating one from the other is worse than leaving it null.
      timeline: data.lead.timeline,
      intent_score: data.lead.intent_score,

      // Engagement history — the contact does NOT start blank. The last conversation,
      // the promised next touch and the temperature the ISA earned all move upward.
      // Dropping next_followup_at silently broke a commitment the ISA had already made.
      last_contacted_at:    data.lead.last_contacted_at ?? null,
      next_followup_at:     data.lead.next_followup_at ?? null,
      next_followup_reason: data.lead.next_followup_reason ?? null,
      lead_score:           data.lead.lead_score ?? null,
      // Same 3-band CHECK on BOTH tables (migration 058: hot|warm|cold), but a raw
      // copy of a stray 4-band value ('cool') is rejected and would refuse the whole
      // insert — so it goes through the Data Steward normalizer, which collapses it.
      lead_temperature:     normalizeEnumValue('lead_temperature', data.lead.lead_temperature).value,
      preferred_channel:    normalizeEnumValue('preferred_channel', data.lead.preferred_channel).value,
      tags:                 data.lead.tags ?? null,
      // MAPPED, not copied — see the exceptions block above.
      lifecycle_state:      'new',

      // ISA qualification carry — the agent sees the FULL picture the moment the
      // contact lands in their CRM (budget, motivation, urgency, financing, the
      // handoff brief and the qualification score).
      budget_min: data.lead.budget_min ?? null,
      budget_max: data.lead.budget_max ?? null,
      motivation_type: data.lead.motivation_type ?? null,
      motivation_confidence: data.lead.motivation_confidence ?? null,
      urgency_level: data.lead.urgency_level ?? null,
      lender_status: data.lead.lender_status ?? null,
      qualification_summary: data.lead.qualification_summary ?? null,
      isa_handoff_brief: data.lead.isa_handoff_brief ?? null,
      isa_handoff_at: data.lead.isa_handoff_brief ? new Date().toISOString() : null,
      isa_qualification_score: data.lead.lead_score ?? null,

      // Address — carry BOTH the physical address and the MAILING address upward, faithfully.
      // A contact can own a property but not live there, so the mailing breakdown is kept
      // distinct from the physical address (raw/leads/contacts now share the same field set).
      address:                  data.lead.address ?? null,
      city:                     data.lead.city ?? null,
      state:                    data.lead.state ?? null,
      zip_code:                 data.lead.zip_code ?? data.lead.property_zip_code ?? null,
      mailing_address:          data.lead.mailing_address ?? null,
      mailing_address_source:   data.lead.mailing_address_source ?? null,
      mailing_address_verified: data.lead.mailing_address_verified ?? null,
      // CARRY THE WHEN, NOT JUST THE WHETHER. m511 added this column for the
      // reason its own title gives — a lead address could be verified forever
      // with no record of when. The flag above was already carried and this was
      // not, so a converted contact inherited `verified: true` with a NULL
      // timestamp: a claim that cannot be aged out, re-checked, or falsified.
      // That matters here specifically, because a verified mailing address is
      // one of the facts the conversion gate accepts as qualifying — inheriting
      // the verdict while dropping its date is how a stale verification becomes
      // permanent.
      mailing_address_verified_at: data.lead.mailing_address_verified_at ?? null,
      mailing_city:             data.lead.mailing_city ?? null,
      mailing_state:            data.lead.mailing_state ?? null,
      mailing_zip:              data.lead.mailing_zip ?? null,

      // Consent provenance — carry over what was captured during the lead phase. Faithful (no
      // fabricated consent) — converted contacts inherit exactly the consent state on the lead.
      // web_form / qr_scan sources captured explicit consent at submission (documented business
      // rule, same as the kernel handler used), so those count as consented even when the lead
      // row's flag wasn't stamped.
      tcpa_consent:
        data.lead.tcpa_consent === true ||
        ['web_form', 'qr_scan'].includes(data.lead.source ?? ''),
      tcpa_consent_date:   data.lead.tcpa_consent_at ?? null,
      tcpa_consent_at:     data.lead.tcpa_consent_at ?? null,
      tcpa_consent_ip:     data.lead.tcpa_consent_ip ?? null,
      tcpa_consent_source: data.lead.tcpa_consent_source ?? null,
      tcpa_consent_text:   data.lead.tcpa_consent_text ?? null,

      // Suppression flags also carry forward so the contact never "loses" an opt-out at conversion.
      email_opt_out:        data.lead.email_opt_out        ?? false,
      sms_opt_out:          data.lead.sms_opt_out          ?? false,
      phone_opt_out:        data.lead.phone_opt_out        ?? false,
      direct_mail_opt_out:  data.lead.direct_mail_opt_out  ?? false,
      opted_out_at:         data.lead.opted_out_at         ?? null,
      // …and so do the REST of the suppression carriers. lib/lead-pipeline/lead-lifecycle.ts
      // names dnc_status and call_stop_flag as THE two suppression flags ("suppression is a
      // flag, not a state") — `dnc_status` was hardcoded `false` below and `call_stop_flag`
      // was not copied at all, so a lead who had said "do not call" became a contact the
      // dialer would happily call. The opt-out PROVENANCE moves too: which channels, why,
      // and who recorded it, otherwise the contact carries a suppression it cannot justify.
      dnc_status:           data.lead.dnc_status           ?? false,
      call_stop_flag:       data.lead.call_stop_flag       ?? false,
      ai_outreach_paused:   data.lead.ai_outreach_paused   ?? false,
      opt_out_channels:     data.lead.opt_out_channels     ?? null,
      opt_out_reason:       data.lead.opt_out_reason       ?? null,
      opt_out_source:       data.lead.opt_out_source       ?? null,

      // Enrichment — conserve everything PeopleData gave the lead so promotion is LOSSLESS.
      // The full payload travels as enrichment_profile (jsonb), and the demographic / financial /
      // social fields are ALSO promoted into the contacts first-class columns (age_range,
      // household_income, home_owner_status, occupation, education_level, social URLs, life_events,
      // peopledata_id, enriched_at, enrichment_source) so they're queryable on the contact, not
      // stranded in jsonb. Without this, an enriched lead lost its whole profile at promotion.
      //
      // The two columns leads ALSO carries first-class (m233 promotes only these two onto
      // leads) are seeded FIRST so the richer enrichment payload wins where it has a value
      // and the lead's own column fills the gap where it does not. Reversing the order
      // would let a stale lead column clobber a fresh PeopleData answer.
      home_owner_status: data.lead.home_owner_status ?? null,
      life_events:       data.lead.life_events ?? null,
      ...peopleDataProfileToContactColumns(data.lead.enrichment_profile, {
        enrichedAt: data.lead.last_enriched_at ?? undefined,
      }),
      enrichment_profile:    data.lead.enrichment_profile ?? null,
      enrichment_confidence: data.lead.enrichment_confidence ?? null,
      last_enriched_at:      data.lead.last_enriched_at ?? null,
      equity_estimate:       data.lead.equity_estimate ?? null,
      email_verified:        data.lead.email_verified ?? null,

      // LOSSLESS SPECS — carry the property facts forward (raw → lead → contact); the scraped value
      // lands in the contact's canonical home_value_estimate column. Additive, never fabricated.
      beds:                data.lead.beds ?? null,
      baths:               data.lead.baths ?? null,
      sqft:                data.lead.sqft ?? null,
      property_type:       data.lead.property_type ?? null,
      home_value_estimate: data.lead.estimated_value ?? null,

      // Status. `contacts.status` is NOT a copy of `leads.status` — the two share a name
      // and nothing else (leads.status is the acquisition pipeline's own token set). A
      // freshly converted contact is by definition 'active', so it is set, not carried.
      status: 'active',
      isa_reengage_allowed: true,
      // dnc_status: carried from the lead — see the suppression block above.

      // Metadata. The lead's own notes are the human history on the record; overwriting
      // them with the promotion marker DELETED every note the ISA or an agent had left.
      // Marker stays FIRST (lib/analytics/intent-phrase-rollup.ts parses it, and the
      // promotion idempotency probe matches on it), lead notes follow. Same shape
      // lib/contact-pipeline/contact-capture.ts:208 already uses.
      notes: [`Promoted from lead ${data.leadId}`, (data.lead.notes ?? '').trim() || null]
        .filter(Boolean).join('\n'),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    // tenant anchor (scope burn-down): pin the insert to the promoting lead's
    // brokerage at the call site (contactData carries the same value).
    const { data: contact, error } = await supabase
      .from("contacts")
      .insert({ ...contactData, brokerage_id: data.brokerageId })
      .select()
      .single()

    if (error) {
      throw new Error(`Failed to create contact: ${error.message}`)
    }

    // ENRICH AS SOON AS THE CONTACT COMES IN (owner's ruling). This is THE
    // lead->contact converter and it emits no CONTACT_CREATED, so a promoted
    // lead reached no enrichment lane at all. The lead already carries an
    // enrichment profile, which is why this queues rather than forces: the
    // freshness check inside queueContactEnrichment consults BOTH enrichment
    // stamps and will skip a contact the lead pipeline enriched recently, so a
    // promotion does not re-buy a record we just paid for. Voided — a promotion
    // must never fail because of enrichment.
    void import("@/lib/enrichment/contact-enrichment-core")
      .then((m) =>
        m.queueContactEnrichment({
          contactId: contact.id,
          brokerageId: data.brokerageId,
          triggerType: "lead_promotion",
        }),
      )
      .catch(() => {})

    return { contactId: contact.id }

  } catch (error: any) {
    console.error("[createContactFromLead] Error:", error)
    return {
      error: error.message || "Failed to create contact"
    }
  }
}
