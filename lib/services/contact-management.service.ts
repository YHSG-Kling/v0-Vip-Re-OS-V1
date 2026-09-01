

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID, validateEmail, validatePhone, validateContact } from "@/lib/validations"
// `LEAD_SOURCES` was imported here and NEVER USED — a dead import that made the
// vocabulary look enforced at this write seam while `source: params.source ||
// "manual"` below let any string through. It is now genuinely used, via
// normalizeLeadSource: the same fold the other contacts.source writer uses
// (app/actions/contacts.ts createContact), so the two writers cannot disagree.
import { LEAD_SOURCES, normalizeLeadSource } from "@/lib/constants"
import { handleError, ValidationError, NotFoundError, DatabaseError } from "@/lib/errors"
import { calculateLeadScore } from "./lead-management.service"
import { statusForNewContact } from "@/lib/contact-promotion/qualification"
import {
  threeSidedContactTransactionFilter,
  deriveTransactionRollup,
} from "@/lib/contacts/transaction-rollup"
// NOTE: `queueContactEnrichment` is imported DYNAMICALLY at its call site below,
// not statically at module scope. lib/enrichment/contact-enrichment-core.ts is
// `server-only` (it holds the service client and the paid PeopleData/OSINT
// clients), and a static import here would pull that into every module graph
// that reaches this file — including the plain `tsx` guard simulators, which are
// not a server component and crash on `server-only` at load. lib/kernel/crm.ts
// already used the dynamic form for exactly this reason; these call sites were
// the inconsistency. The queue call is best-effort and already awaited/voided,
// so deferring the import costs nothing.

// ============================================
// UNIFIED CONTACT MANAGEMENT SERVICE
// Consolidates all contact CRUD operations
// Replaces duplicates in: crm.ts, portal-settings.ts, credit-copilot.ts
// ============================================

export interface CreateContactParams {
  agentId: string
  firstName: string
  lastName?: string
  email: string
  phone?: string
  source?: string
  status?: string
  budgetMin?: number
  budgetMax?: number
  preferredCities?: string[]
  notes?: string
  tags?: string[]
}

export interface UpdateContactParams {
  contactId: string
  agentId: string
  updates: Partial<CreateContactParams>
}

/**
 * Create a new contact
 */
export async function createContact(params: CreateContactParams) {
  try {


    // Validate inputs.
    //
    // PRESENCE first, then FORMAT through the shared validator. validateContact
    // (lib/validations/index.ts:133) runs the same three checks this function
    // used to inline one by one — uuid on agent_id, format on email, format on
    // phone — but it collects EVERY failure instead of throwing on the first, so
    // a caller who got both the email and the phone wrong is told both times
    // instead of being sent round the loop twice. It was imported here and never
    // called; the inline trio was the second spelling of it (CLAUDE.md §6).
    //
    // The required-email rule is NOT delegated: validateContact treats email as
    // optional (`if (data.email && …)`), so folding the presence check into it
    // would have let a contact through with no email at all — the field this
    // function immediately dedupes on.
    if (!params.email) {
      throw new ValidationError("Email is required")
    }

    const contactCheck = validateContact({
      email: params.email,
      phone: params.phone,
      agent_id: params.agentId,
    })
    if (!contactCheck.valid) {
      throw new ValidationError(contactCheck.errors.join("; "))
    }

    const supabase = await createClient()

    // Check for duplicates
    const { data: existing } = await supabase
      .from("contacts")
      .select("id")
      .eq("agent_id", params.agentId)
      .eq("email", params.email)
      .maybeSingle()

    if (existing) {
      throw new ValidationError("Contact with this email already exists")
    }

    // Resolve the owning brokerage from the agent. contacts has no
    // brokerage_id auto-denorm trigger, so it must be stamped explicitly
    // (business rule: brokerage_id required on every contact row).
    const { data: agentRow } = await supabase
      .from("agents")
      .select("brokerage_id")
      .eq("id", params.agentId)
      .maybeSingle()
    if (!agentRow?.brokerage_id) {
      throw new ValidationError("Agent is not associated with a brokerage")
    }

    // Lead-source vocabulary, enforced at the write rather than by the type.
    // contacts.source carries NO CHECK constraint (measured live 2026-08-25), so
    // an unrecognised value would otherwise persist verbatim and no scorer could
    // match it (§6). "manual" is the canonical default and is IN the vocabulary.
    const source = normalizeLeadSource(params.source ?? "manual")
    if (!source) {
      throw new ValidationError(
        `Unknown lead source "${params.source}". Expected one of: ${LEAD_SOURCES.join(", ")}.`
      )
    }

    // Create contact. NOTE: contacts has no full_name/lead_score/
    // preferred_cities/tags columns — those are intentionally omitted.
    const { data: contact, error } = await supabase
      .from("contacts")
      .insert({
        agent_id: params.agentId,
        brokerage_id: agentRow.brokerage_id,
        first_name: params.firstName,
        last_name: params.lastName,
        email: params.email,
        phone: params.phone,
        source,   // canonical — see the vocabulary gate above
        // OWNER RULING: a contact cannot be BORN qualified — "any other new contacts
        // coming in from forms, lead magnets, other real estate sites, etc. haven't
        // been qualified yet." `params.status` is caller-supplied and this path is
        // reachable from a "use server" export (a public HTTP endpoint, §4), so the
        // refusal has to live here and not in a dropdown. 'qualified' is earned by
        // the lead→contact CONVERSION alone and stamped in exactly one place,
        // lib/portal/portal-invite-core.ts:77 stampQualifiedIfLeadConverted. The
        // fallback below is this path's OWN prior default, so no other status moves.
        status: statusForNewContact(params.status, "active"),
        lead_temperature: "cold",
        budget_min: params.budgetMin,
        budget_max: params.budgetMax,
        notes: params.notes,
        created_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle()

    if (error) {
      throw new DatabaseError("Failed to create contact", error)
    }

    // ENRICH AS SOON AS THE CONTACT COMES IN (owner's ruling). This is the CRM
    // manual-add service and it emits no CONTACT_CREATED, so the event-reactor
    // lane never saw an agent-typed contact. Voided — the add must not fail
    // because of enrichment. Live-deal suppression, the freshness check and the
    // already-pending check are all inside queueContactEnrichment.
    //
    // Queued rather than enriched inline: enrichment makes two paid vendor calls
    // and this runs on the request path. app/api/contacts/create/route.ts used
    // to fire an un-awaited enrichContact() here, which on a serverless runtime
    // is a coin-flip — the response returns, the function freezes, and the work
    // may never finish. A queue row survives that.
    void import("@/lib/enrichment/contact-enrichment-core")
      .then((m) =>
        m.queueContactEnrichment({
          contactId: contact.id,
          brokerageId: agentRow.brokerage_id as string,
          triggerType: "crm_manual_add",
        }),
      )
      .catch(() => {})

    // Calculate initial lead score
    await calculateLeadScore({
      id: contact.id,
      agentId: params.agentId,
    })

    // TOMBSTONE (§1.1): revalidatePath("/dashboard/crm") deleted from this site —
    // /dashboard/crm has no page.tsx and never had one; the survivor is /crm
    // (app/crm/page.tsx), already revalidated on the next line.
    revalidatePath("/crm")

    return { success: true, contact }
  } catch (error) {
    return handleError(error, "createContact")
  }
}

/**
 * Update an existing contact
 */
export async function updateContact(params: UpdateContactParams) {
  try {
    console.log("[v0] Updating contact:", params.contactId)

    if (!isValidUUID(params.contactId)) {
      throw new ValidationError("Invalid contact ID")
    }

    if (!isValidUUID(params.agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    // Validate email if updating
    if (params.updates.email && !validateEmail(params.updates.email)) {
      throw new ValidationError("Invalid email address")
    }

    // Validate phone if updating
    if (params.updates.phone && !validatePhone(params.updates.phone)) {
      throw new ValidationError("Invalid phone number")
    }

    const supabase = await createClient()

    // Verify ownership
    const { data: existing } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", params.contactId)
      .eq("agent_id", params.agentId)
      .single()

    if (!existing) {
      throw new NotFoundError("Contact not found or access denied")
    }

    // Build update object
    const updateData: any = {
      ...params.updates,
      updated_at: new Date().toISOString(),
    }

    // Update full_name if first or last name changed
    if (params.updates.firstName || params.updates.lastName) {
      const { data: current } = await supabase.from("contacts").select("first_name, last_name").eq("id", params.contactId).single()

      updateData.full_name = `${params.updates.firstName || current?.first_name} ${params.updates.lastName || current?.last_name || ""}`.trim()
    }

    // Update contact
    const { data: contact, error } = await supabase
      .from("contacts")
      .update(updateData)
      .eq("id", params.contactId)
      .select()
      .single()

    if (error) {
      throw new DatabaseError("Failed to update contact", error)
    }

    // Recalculate lead score if significant fields changed
    const significantFields = ["budget_min", "budget_max", "status", "preferred_cities"]
    const hasSignificantChanges = significantFields.some((field) => field in params.updates)

    if (hasSignificantChanges) {
      await calculateLeadScore({
        id: params.contactId,
        agentId: params.agentId,
        recalculate: true,
      })
    }

    // TOMBSTONE (§1.1): revalidatePath("/dashboard/crm") deleted from this site —
    // /dashboard/crm has no page.tsx and never had one; the survivor is /crm
    // (app/crm/page.tsx), already revalidated on the next line.
    revalidatePath("/crm")
    revalidatePath(`/crm/contacts/${params.contactId}`)

    return { success: true, contact }
  } catch (error) {
    return handleError(error, "updateContact")
  }
}

/**
 * Delete a contact (soft delete)
 */
export async function deleteContact(contactId: string, agentId: string) {
  try {
    console.log("[v0] Deleting contact:", contactId)

    if (!isValidUUID(contactId)) {
      throw new ValidationError("Invalid contact ID")
    }

    if (!isValidUUID(agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    const supabase = await createClient()

    // Verify ownership
    const { data: existing } = await supabase.from("contacts").select("id").eq("id", contactId).eq("agent_id", agentId).single()

    if (!existing) {
      throw new NotFoundError("Contact not found or access denied")
    }

    // Soft delete
    const { error } = await supabase
      .from("contacts")
      .update({
        status: "deleted",
        deleted_at: new Date().toISOString(),
      })
      .eq("id", contactId)

    if (error) {
      throw new DatabaseError("Failed to delete contact", error)
    }

    // TOMBSTONE (§1.1): revalidatePath("/dashboard/crm") deleted from this site —
    // /dashboard/crm has no page.tsx and never had one; the survivor is /crm
    // (app/crm/page.tsx), already revalidated on the next line.
    revalidatePath("/crm")

    return { success: true }
  } catch (error) {
    return handleError(error, "deleteContact")
  }
}

/**
 * Get a single contact by ID
 */
export async function getContact(contactId: string, agentId: string) {
  try {
    if (!isValidUUID(contactId)) {
      throw new ValidationError("Invalid contact ID")
    }

    if (!isValidUUID(agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    const supabase = await createClient()

    // THIS READ NAMED THREE RELATIONSHIPS POSTGREST CANNOT EMBED. Any ONE of them
    // refuses the WHOLE query, so this has never returned a contact — and the
    // `throw` below rendered that refusal as "Contact not found".
    //   · `buyer_persona(*)` — there is NO public.buyer_persona table and no such
    //     column on contacts. It is a phantom; do not restore it. The per-contact
    //     persona that DOES exist is client_detailed_personas
    //     (client_detailed_personas.contact_id -> contacts.id, one row per contact,
    //     written by lib/contacts/persona-builder.ts). Nothing here consumed the
    //     persona, so it is dropped rather than repointed.
    //   · `lead_intelligence` / `lead_behavioral_data` — both are keyed on `lead_id`
    //     and declare NO foreign key to contacts (pg_constraint carries brokerage_id
    //     only). PostgREST embeds on DECLARED relationships, so each raised PGRST200.
    //     Nothing here read either one; both are dropped. Where they ARE consumed
    //     they must be fetched by their lead_id link, never embedded on contacts —
    //     see lead-management.service.ts and app/actions/ai-chat.ts.
    // `transactions` has THREE foreign keys to contacts (contact_id, buyer_contact_id,
    // seller_contact_id), so the bare `transactions(*)` embed was ambiguous (PGRST201)
    // and would have failed on its own; it is now named by constraint, which picks the
    // side meant here — the deals this contact is the client on.
    // TOMBSTONE (m598 retirement): a nested `property_interactions(…listings(…))`
    // embed stood here and is GONE. The key it produced was consumed by NOTHING —
    // zero readers of `contact.property_interactions` off this function's return —
    // and the table itself has ZERO writers (only a never-fired BEFORE INSERT
    // trigger), so the embed could only ever return []. SURVIVOR for the meaning:
    // `buyer_behavior_log`, which already carries the denormalized property facts
    // (property_address, city, state, list_price, bedrooms…) on each row — a future
    // card wanting the property graph reads it flat by contact_id, no nested embed
    // needed. Columns are named explicitly — never `*` inside an embed, which hides
    // drift from the schema guard (defect #214).
    const { data: contact, error } = await supabase
      .from("contacts")
      .select(`
        *,
        transactions!transactions_contact_id_fkey(
          id,
          deal_name,
          property_address,
          status,
          close_date,
          purchase_price
        )
      `)
      .eq("id", contactId)
      .eq("agent_id", agentId)
      .single()

    if (error) {
      // A refused query and an absent row arrive here identically, and answering a
      // refusal with "not found" is how the broken embeds stayed invisible. Say which.
      console.error("[getContact] contacts read failed:", error.message)
      throw new NotFoundError("Contact not found")
    }

    // ── DERIVED FIELDS — computed at read time, never stored ─────────────────
    // transaction_count / last_closed_at / referral_count / rating /
    // service_areas exist on the Contact type as DERIVED read-only fields (see
    // the tombstones in types/contact.ts and lib/domain/types.ts). Live
    // contacts stores none of them; a stored aggregate with no writer is
    // exactly what the writerless-gate guard exists to refuse.

    // Transactions — THREE-SIDED grain (lib/contacts/transaction-rollup.ts):
    // the constraint-named embed above rides ONE relationship
    // (transactions_contact_id_fkey — the deals this contact is the client on),
    // but "total transactions with us" counts the contact on ANY of the three
    // contact FKs (buyer_contact_id | seller_contact_id | contact_id), the
    // definition seller-lifetime-overview has always used. PostgREST cannot
    // express that union as one embed (an embed rides exactly one named
    // relationship — same PGRST201 fact the header above records), so it is a
    // second query. Tenant scope: same brokerage as the contact row.
    // §4 fail closed: a contact row with NO brokerage_id gives this read no
    // tenant to run under, and dropping the predicate would decay the query to
    // 'every tenant' (the exact shape the conditional-tenant-predicate guard
    // refuses). Such a row never runs the three-sided query at all — it takes
    // the single-sided embed fallback below, which is anchored to the FK and
    // says it may undercount.
    const brokerageId = (contact as Record<string, unknown>).brokerage_id as string | null
    const txQuery = brokerageId
      ? supabase
          .from("transactions")
          .select("id, status, close_date")
          .or(threeSidedContactTransactionFilter(contactId))
          .eq("brokerage_id", brokerageId)
      : Promise.resolve({
          data: null,
          error: { message: "contact row carries no brokerage_id — three-sided read refused (fail closed), using the FK-anchored embed fallback" },
        } as { data: null; error: { message: string } })
    const [txRes, refRes] = await Promise.all([
      txQuery,
      // referral_count — count of referrals rows naming this contact as the
      // REFERRER (referrals.referrer_contact_id, the FK
      // lib/kernel/referral-appreciation.ts walks; derivation precedent
      // app/actions/analytics.ts:308 `referrals?.length || 0`). A head-count
      // avoids the embed entirely: referrals carries TWO FKs to contacts
      // (referrer_contact_id and referred_contact_id), so a bare `referrals(…)`
      // embed here would be the PGRST201 ambiguity the header above warns about.
      supabase
        .from("referrals")
        .select("id", { count: "exact", head: true })
        .eq("referrer_contact_id", contactId),
    ])

    let transaction_count: number | undefined
    let last_closed_at: string | null | undefined
    if (txRes.error) {
      // Degrade to the single-sided embed already on the row — an undercount
      // that says so, NEVER a silent 0 (a refusal rendered as "no deals" is the
      // exact bug class the header above documents).
      console.error(
        "[getContact] three-sided transactions read refused — falling back to the single-sided transactions_contact_id_fkey embed (may undercount buyer/seller-side deals):",
        txRes.error.message,
      )
      const embedded = Array.isArray((contact as Record<string, unknown>).transactions)
        ? ((contact as Record<string, unknown>).transactions as Array<{ status?: string | null; close_date?: string | null }>)
        : []
      const fallback = deriveTransactionRollup(embedded)
      transaction_count = fallback.transaction_count
      last_closed_at = fallback.last_closed_at
    } else {
      const rollup = deriveTransactionRollup(txRes.data ?? [])
      transaction_count = rollup.transaction_count
      last_closed_at = rollup.last_closed_at
    }

    let referral_count: number | undefined
    if (refRes.error) {
      // A refused count is ABSENT, not zero — leave the field undefined so a
      // consumer can tell "could not compute" from "has never referred".
      console.error("[getContact] referrals count refused — referral_count omitted:", refRes.error.message)
    } else {
      referral_count = refRes.count ?? 0
    }

    // Vendor bridge — rating / service_areas (m595, WRITTEN NOT APPLIED — the
    // integrator applies it). contacts.vendor_id does not exist in this
    // environment yet; because the main read selects `*`, the column simply
    // arrives absent until the migration lands, and this block no-ops. Written
    // to be safe BOTH before and after apply: the vendor join is a separate
    // best-effort query with its {error} read, so an unknown-column/refused
    // read degrades to absent fields and can never kill the main contact read.
    let rating: number | null | undefined
    let service_areas:
      | Array<{ state: string; zip_code: string | null; trade_category: string; status: string }>
      | undefined
    const vendorId = (contact as Record<string, unknown>).vendor_id
    if (typeof vendorId === "string" && vendorId) {
      const { data: vendorRow, error: vendorError } = await supabase
        .from("vendors")
        .select("rating, platform_vendor_id")
        .eq("id", vendorId)
        .maybeSingle()
      if (vendorError) {
        console.error("[getContact] vendor bridge read refused — rating/service_areas omitted:", vendorError.message)
      } else if (vendorRow) {
        rating = (vendorRow.rating as number | null) ?? null
        // Coverage hangs off the GLOBAL identity (vendors.platform_vendor_id →
        // vendor_service_areas.platform_vendor_id) — the two-hop
        // lib/vendors/vendor-service-area.ts documents and
        // app/actions/vendor-service-areas.ts:394 implements. A local-only
        // bench row (no platform_vendor_id) has no declared coverage.
        if (vendorRow.platform_vendor_id) {
          const { data: areaRows, error: areaError } = await supabase
            .from("vendor_service_areas")
            .select("state, zip_code, trade_category, status")
            .eq("platform_vendor_id", vendorRow.platform_vendor_id)
          if (areaError) {
            console.error("[getContact] vendor_service_areas read refused — service_areas omitted:", areaError.message)
          } else {
            service_areas = (areaRows ?? []) as Array<{
              state: string
              zip_code: string | null
              trade_category: string
              status: string
            }>
          }
        }
      }
    }

    return {
      success: true,
      contact: {
        ...contact,
        transaction_count,
        last_closed_at,
        referral_count,
        ...(rating !== undefined ? { rating } : {}),
        ...(service_areas !== undefined ? { service_areas } : {}),
      },
    }
  } catch (error) {
    return handleError(error, "getContact")
  }
}

/**
 * Get all contacts for an agent
 */
export async function getContacts(agentId: string, filters?: { status?: string; temperature?: string; search?: string }) {
  try {
    if (!isValidUUID(agentId)) {
      return { success: true, contacts: [] }
    }

    const supabase = await createClient()

    // `buyer_persona(*)` named a relation that DOES NOT EXIST (no public.buyer_persona
    // table, no such column on contacts), and `lead_intelligence` is keyed on lead_id
    // with NO foreign key to contacts. Either one refuses the WHOLE query (PGRST200),
    // so this list has never returned a contact — the caller rendered the refusal as an
    // empty CRM. Nothing read either embed off this result, so both are dropped rather
    // than repointed; the real per-contact persona is client_detailed_personas
    // (contact_id -> contacts.id) and can be embedded if a consumer ever needs it.
    let query = supabase
      .from("contacts")
      .select("*")
      .eq("agent_id", agentId)
      .is("deleted_at", null)

    // Apply filters
    if (filters?.status) {
      query = query.eq("status", filters.status)
    }

    if (filters?.temperature) {
      query = query.eq("lead_temperature", filters.temperature)
    }

    if (filters?.search) {
      // `full_name` is NOT a column on contacts (the live table carries first_name /
      // last_name separately). A bad column in a filter refuses the query exactly the
      // way a bad embed does, so every searched list came back as "no matches". Matched
      // the way crm.ts:searchContacts already does it, against columns that exist.
      const term = filters.search
      query = query.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`)
    }

    const { data: contacts, error } = await query.order("lead_score", { ascending: false })

    if (error) {
      throw new DatabaseError("Failed to fetch contacts", error)
    }

    return { success: true, contacts: contacts || [] }
  } catch (error) {
    return handleError(error, "getContacts")
  }
}

/**
 * Add tags to a contact
 */
export async function addContactTags(contactId: string, agentId: string, tags: string[]) {
  try {
    if (!isValidUUID(contactId)) {
      throw new ValidationError("Invalid contact ID")
    }

    const supabase = await createClient()

    const { data: contact } = await supabase.from("contacts").select("tags").eq("id", contactId).eq("agent_id", agentId).single()

    if (!contact) {
      throw new NotFoundError("Contact not found")
    }

    const existingTags = contact.tags || []
    const newTags = [...new Set([...existingTags, ...tags])]

    const { error } = await supabase.from("contacts").update({ tags: newTags }).eq("id", contactId)

    if (error) {
      throw new DatabaseError("Failed to add tags", error)
    }

    // /dashboard/crm has no page.tsx — this was a no-op. The tag list is rendered
    // by /crm and by the contact detail page, so both are revalidated.
    revalidatePath("/crm")
    revalidatePath(`/crm/contacts/${contactId}`)
    return { success: true, tags: newTags }
  } catch (error) {
    return handleError(error, "addContactTags")
  }
}

/**
 * Remove tags from a contact
 */
export async function removeContactTags(contactId: string, agentId: string, tags: string[]) {
  try {
    if (!isValidUUID(contactId)) {
      throw new ValidationError("Invalid contact ID")
    }

    const supabase = await createClient()

    const { data: contact } = await supabase.from("contacts").select("tags").eq("id", contactId).eq("agent_id", agentId).single()

    if (!contact) {
      throw new NotFoundError("Contact not found")
    }

    const newTags = (contact.tags || []).filter((tag: string) => !tags.includes(tag))

    const { error } = await supabase.from("contacts").update({ tags: newTags }).eq("id", contactId)

    if (error) {
      throw new DatabaseError("Failed to remove tags", error)
    }

    // /dashboard/crm has no page.tsx — this was a no-op. The tag list is rendered
    // by /crm and by the contact detail page, so both are revalidated.
    revalidatePath("/crm")
    revalidatePath(`/crm/contacts/${contactId}`)
    return { success: true, tags: newTags }
  } catch (error) {
    return handleError(error, "removeContactTags")
  }
}

/**
 * Merge duplicate contacts
 */
export async function mergeContacts(params: { primaryContactId: string; duplicateContactId: string; agentId: string }) {
  try {
    if (!isValidUUID(params.primaryContactId) || !isValidUUID(params.duplicateContactId)) {
      throw new ValidationError("Invalid contact IDs")
    }

    const supabase = await createClient()

    // Get both contacts
    const { data: primary } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.primaryContactId)
      .eq("agent_id", params.agentId)
      .single()

    const { data: duplicate } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.duplicateContactId)
      .eq("agent_id", params.agentId)
      .single()

    if (!primary || !duplicate) {
      throw new NotFoundError("One or both contacts not found")
    }

    // Merge data (prefer primary, but take non-null from duplicate).
    //
    // `preferred_cities` USED TO BE MERGED HERE AND IS GONE ON PURPOSE. There is no
    // such column on `contacts` (scripts/schema-snapshot.ts; the same fact is already
    // written down at the insert path above: "contacts has no full_name/lead_score/
    // preferred_cities/tags columns"). Naming it made PostgREST refuse this UPDATE
    // ENTIRELY (PGRST204) — so phone, budgets, tags and the merged notes were never
    // written either. And because the refusal was never destructured, supabase-js
    // RESOLVED it: the merge reported success, the relationship transfers below ran,
    // and the duplicate was then soft-deleted — losing every field this function
    // claims to preserve. Nothing is lost by dropping the key: the column does not
    // exist, so `primary.preferred_cities` was always undefined and the merge of two
    // undefineds was always [].
    const merged = {
      phone: primary.phone || duplicate.phone,
      budget_min: primary.budget_min || duplicate.budget_min,
      budget_max: primary.budget_max || duplicate.budget_max,
      tags: [...new Set([...(primary.tags || []), ...(duplicate.tags || [])])],
      notes: [primary.notes, duplicate.notes].filter(Boolean).join("\n\n---MERGED---\n\n"),
    }

    // Update primary contact. The error is READ: a refused merge must not be followed
    // by transferring relationships off the duplicate and soft-deleting it.
    const { error: mergeError } = await supabase.from("contacts").update(merged).eq("id", params.primaryContactId)
    if (mergeError) {
      throw new DatabaseError("Failed to merge contact fields onto primary", mergeError)
    }

    // Transfer relationships to primary.
    //
    // m598 repoint: this re-keyed `property_interactions` — a zero-writer table
    // whose count here was always 0 — while `buyer_behavior_log`, the live twin
    // that actually carries the per-contact behavior trail (and feeds preference
    // learning, engagement scoring and campaign audiences), was NOT re-keyed: the
    // merge stranded the duplicate's behavior history on a soft-deleted contact.
    // The error is READ and a failure ABORTS before the soft delete below, per
    // this function's own standard on the field merge above — a duplicate whose
    // history didn't move must not be deleted.
    const { error: behaviorRekeyError } = await supabase
      .from("buyer_behavior_log")
      .update({ contact_id: params.primaryContactId })
      .eq("contact_id", params.duplicateContactId)
    if (behaviorRekeyError) {
      throw new DatabaseError("Failed to move the duplicate's behavior log onto the primary", behaviorRekeyError)
    }

    // Same standard as the two writes above, applied to the re-key that had been
    // discarding its error: supabase-js RESOLVES a refusal (§3), so a refused
    // transactions re-key looked identical to a successful one — and the soft
    // delete below then ran anyway, stranding the duplicate's DEALS on a deleted
    // contact. Zero matched rows is NOT a failure here (a duplicate may own no
    // transactions); a refusal is.
    const { error: txRekeyError } = await supabase
      .from("transactions")
      .update({ contact_id: params.primaryContactId })
      .eq("contact_id", params.duplicateContactId)
    if (txRekeyError) {
      throw new DatabaseError("Failed to move the duplicate's transactions onto the primary", txRekeyError)
    }

    // Soft delete duplicate
    await deleteContact(params.duplicateContactId, params.agentId)

    // /dashboard/crm has no page.tsx. The merge changes the roster AND the
    // surviving contact's record, so both live paths are revalidated.
    revalidatePath("/crm")
    revalidatePath(`/crm/contacts/${params.primaryContactId}`)

    return { success: true }
  } catch (error) {
    return handleError(error, "mergeContacts")
  }
}
