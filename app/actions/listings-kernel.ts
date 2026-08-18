"use server"
/**
 * app/actions/listings-kernel.ts
 * Thin "use server" wrappers over lib/kernel/listings.ts.
 *
 * Pattern:
 *   1. Auth — get session user
 *   2. Resolve context — brokerage_id, agent_id (agents.id FK, not users.id)
 *   3. Validate caller scope (same brokerage)
 *   4. Delegate to kernel command
 *   5. revalidatePath on mutation
 *
 * NEVER implement business logic here. All logic lives in lib/kernel/listings.ts.
 */

import { revalidatePath } from "next/cache"
import {
  verifyMlsSyndication,
  type MlsVerification,
  type MlsFeedObservation,
  type MlsFeedSource,
} from "@/lib/listings/mls-verification"
import { createClient } from "@/lib/supabase/server"
import { LISTING_STATUSES, isListingStatus } from "@/lib/constants"
import {
  createListingRecord,
  createOrAttachSellerContact,
  loadListingWorkspace,
  saveListingDraft,
  validateListingLaunchReadiness,
  launchListing,
  updateListingStage,
  generateListingDescription,
  closeListingLifecycle,
  prefillListingFormFromRecord,
  type CreateListingInput,
  type SellerContactInput,
  type ListingUpdate,
  type ListingStage,
} from "@/lib/kernel/listings"

// ─── Auth context helper ──────────────────────────────────────────────────────

async function resolveCallerContext() {
  const supabase = await createClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError) return { error: `Not authenticated: ${authError.message}` as const }
  if (!user) return { error: "Not authenticated" as const }

  // Resolve brokerage_id and the real agents.id (FK, not users.id)
  const [userRow, agentRow] = await Promise.all([
    supabase
      .from("users")
      .select("brokerage_id, user_type, team_id")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("agents")
      .select("id, brokerage_id")
      .eq("user_id", user.id)
      .maybeSingle(),
  ])

  // A REFUSED IDENTITY READ IS NOT AN ABSENT IDENTITY. Both of these resolve on
  // failure, so an RLS refusal or a dropped connection used to arrive here as
  // "no brokerage found for this user" — which reads as a provisioning problem
  // and sends the agent to fix an account that is fine. Name the real failure.
  if (userRow.error && agentRow.error) {
    return { error: `Could not resolve your identity: ${userRow.error.message}` as const }
  }

  const brokerageId = agentRow.data?.brokerage_id ?? userRow.data?.brokerage_id
  if (!brokerageId) {
    if (userRow.error) return { error: `Could not read your profile: ${userRow.error.message}` as const }
    if (agentRow.error) return { error: `Could not read your agent record: ${agentRow.error.message}` as const }
    return { error: "No brokerage found for this user" as const }
  }

  return {
    userId:      user.id,
    agentId:     agentRow.data?.id ?? null,   // agents.id (NOT users.id); null for broker/admin without an agent profile
    brokerageId,
    /**
     * teams.id — the TEAM rung of the connection ownership cascade
     * (agent → team → brokerage → platform) that
     * `IDXBrokerClient.forBrokerage` walks. Selected here rather than in a
     * second read because this resolver was already reading `users`; without it
     * the IDX feed below skipped the rung entirely and a team that connected
     * its own IDX Broker account lost to the brokerage's (wave 17).
     *
     * A third id space — not agents.id, not users.id. Never substituted.
     */
    teamId:      (userRow.data?.team_id ?? null) as string | null,
    userType:    userRow.data?.user_type ?? "agent",
  }
}

// ─── Action: resolveListingIdByMls ───────────────────────────────────────────

/**
 * Resolve an MLS number typed by an agent to one of THIS brokerage's listing ids.
 *
 * The offer wizard collects an MLS number and used to drop that string straight
 * into `offers.listing_id`, which is a uuid FK — so any agent who actually filled
 * the field in got a failed insert, and any agent who left it blank got an offer
 * with no listing attached. This is the missing translation step.
 *
 * Returns `{ listingId: null }` when nothing matches: an offer on a property this
 * brokerage does not list is completely normal, and it must not block the offer.
 */
export async function resolveListingIdByMlsAction(mlsNumber: string): Promise<{
  success: boolean
  listingId: string | null
  error?: string
}> {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, listingId: null, error: ctx.error }

  const trimmed = mlsNumber?.trim()
  if (!trimmed) return { success: true, listingId: null }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("listings")
    .select("id")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("mls_number", trimmed)
    .maybeSingle()

  if (error) return { success: false, listingId: null, error: error.message }
  return { success: true, listingId: data?.id ?? null }
}

// ─── Action: createListingWithSellerContact ───────────────────────────────────

/**
 * Called from ListingCreateSheet and from the New Listing wizard (FormWizard,
 * mode="listing").
 *
 * Creates a seller contact (or attaches existing) then creates the listing record.
 * The listing lands as a DRAFT — see createListingRecord for the rule. It becomes
 * a real listing only when the signed agreement clears the compliance check.
 */
export async function createListingWithSellerContact(params: {
  sellerFirstName: string
  sellerLastName: string
  sellerEmail?: string
  sellerPhone?: string
  address: string
  city: string
  state: string
  zip: string
  listPrice?: number
  bedrooms?: number
  bathrooms?: number
  sqft?: number
  propertyType?: string
  /** Form IDs selected during the listing initiation flow */
  selectedFormIds?: string[]
  /** Field values keyed by form name then field name */
  formFieldValues?: Record<string, Record<string, string>>
}) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  // Step 1: Find or create seller contact
  const sellerResult = await createOrAttachSellerContact({
    brokerageId: ctx.brokerageId,
    agentId:     ctx.agentId,
    firstName:   params.sellerFirstName,
    lastName:    params.sellerLastName,
    email:       params.sellerEmail,
    phone:       params.sellerPhone,
  })
  if (!sellerResult.success) return { success: false, error: sellerResult.error }

  // Step 2: Create listing record
  const listingResult = await createListingRecord({
    agentId:          ctx.agentId,
    sellerContactId:  sellerResult.contactId,
    brokerageId:      ctx.brokerageId,
    address:          params.address,
    city:             params.city,
    state:            params.state,
    zip:              params.zip,
    listPrice:        params.listPrice,
    bedrooms:         params.bedrooms,
    bathrooms:        params.bathrooms,
    sqft:             params.sqft,
    propertyType:     params.propertyType,
  })
  if (!listingResult.success) return { success: false, error: listingResult.error }

  const newListingId = (listingResult.listing as any).id as string

  // Step 3: Persist form field data collected during the initiation flow (non-fatal)
  if (params.selectedFormIds?.length && params.formFieldValues) {
    try {
      const { saveFormDraft } = await import("@/lib/kernel/forms")
      for (const formId of params.selectedFormIds) {
        const fields = params.formFieldValues[formId]
        if (fields && Object.keys(fields).length > 0) {
          await saveFormDraft({
            brokerage_id: ctx.brokerageId,
            agent_id:     ctx.agentId,
            form_name:    formId,
            context_type: "listing",
            context_id:   newListingId,
            field_values: fields,
          }).catch((err: unknown) => {
            console.error("[createListingWithSellerContact] Form draft save failed (non-fatal):", err)
          })
        }
      }
    } catch (err) {
      console.error("[createListingWithSellerContact] Form draft import failed (non-fatal):", err)
    }
  }

  revalidatePath("/dashboard/listings")

  return {
    success:  true,
    listing:  listingResult.listing,
    listingId: newListingId,
    sellerCreated: sellerResult.created,
  }
}

// ─── Action: saveListingDraftAction ──────────────────────────────────────────

/**
 * The trust boundary for editable listing fields.
 *
 * `updates` arrives from a browser. The kernel's saveListingDraft DENY-lists five
 * columns (status, lifecycle_stage, agent_id, brokerage_id, seller_contact_id) —
 * which means every other column on `listings` is writable by anything that can
 * call this action, including mls_number, sold_price, slug and listing_date. A
 * deny-list on a 60-column table is a list of the things someone remembered.
 *
 * This is the allow-list. It is the property/marketing surface an agent edits by
 * hand; lifecycle, tenancy, MLS identity and money-of-record stay with the actions
 * that own them (launchListingAction owns mls_number; updateListingStatus owns
 * status; the stage engine owns lifecycle_stage).
 */
const EDITABLE_LISTING_FIELDS = [
  "address", "city", "state", "zip",
  "list_price", "bedrooms", "bathrooms", "sqft", "property_type",
  "year_built", "lot_size", "hoa_dues", "has_pool", "has_septic", "has_solar",
  "public_remarks", "showing_instructions",
  "expiration_date", "commission_rate", "seller_walkaway_price",
] as const

/**
 * The editable shape, verified column-by-column against information_schema.columns.
 *
 * The kernel's `ListingUpdate` (lib/kernel/listings.ts:57) is NARROWER than the real
 * editable surface and, separately, WIDER where it should not be: it omits
 * public_remarks — the marketing copy the Fair Housing gate reads and nine surfaces
 * render — while admitting mls_number, mls_link, listing_date and marketing_tier_id,
 * which belong to launchListingAction and the tier assigner, not to a hand edit.
 * This type is the honest set; the allow-list above enforces it at runtime.
 */
type ListingDraftUpdate = {
  address?: string
  city?: string
  state?: string
  zip?: string
  list_price?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  sqft?: number | null
  property_type?: string | null
  year_built?: number | null
  lot_size?: number | null
  hoa_dues?: number | null
  has_pool?: boolean | null
  has_septic?: boolean | null
  has_solar?: boolean | null
  public_remarks?: string | null
  showing_instructions?: string | null
  expiration_date?: string | null
  commission_rate?: number | null
  seller_walkaway_price?: number | null
}

export async function saveListingDraftAction(params: {
  listingId: string
  updates: ListingDraftUpdate
}) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const incoming = (params.updates ?? {}) as Record<string, unknown>
  const allowed: Record<string, unknown> = {}
  const rejected: string[] = []
  for (const key of Object.keys(incoming)) {
    if ((EDITABLE_LISTING_FIELDS as readonly string[]).includes(key)) {
      allowed[key] = incoming[key]
    } else {
      rejected.push(key)
    }
  }

  if (Object.keys(allowed).length === 0) {
    return {
      success: false,
      error: rejected.length
        ? `None of these fields can be edited here: ${rejected.join(", ")}`
        : "No updates provided",
    }
  }

  // TENANT ANCHOR. The kernel's update is `.eq("id", listingId)` with no brokerage
  // filter — it relies entirely on RLS. Confirm the row is ours FIRST, with the
  // error destructured, so a cross-tenant id gets a clear refusal instead of an
  // RLS no-op that reports success with zero rows touched.
  const supabase = await createClient()
  const { data: owned, error: ownedError } = await supabase
    .from("listings")
    .select("id")
    .eq("id", params.listingId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (ownedError) return { success: false, error: `Could not verify the listing: ${ownedError.message}` }
  if (!owned)     return { success: false, error: "Listing not found in your brokerage" }

  const result = await saveListingDraft({
    listingId:    params.listingId,
    updates:      allowed as Partial<ListingUpdate>,
    actorUserId:  ctx.userId,
  })

  if (result.success) {
    revalidatePath(`/dashboard/listings/${params.listingId}`)
    revalidatePath(`/dashboard/listings/${params.listingId}/lifecycle`)
  }

  return rejected.length ? { ...result, ignoredFields: rejected } : result
}

// ─── Action: validateLaunchReadinessAction ────────────────────────────────────

export async function validateLaunchReadinessAction(listingId: string) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }
  return validateListingLaunchReadiness({ listingId })
}

// ─── Action: verifyMlsSyndicationAction ──────────────────────────────────────

/**
 * OWNER RULING: "the admin needs to add the actual listing that is in house
 * manually to the mls or state mls but verification that it is actually live on
 * the mls can be checked in rentcast or the tenants(subscriber) idxbroker."
 *
 * So this does NOT fetch a number for the agent to paste. The agent already has
 * the number — they typed it into the MLS themselves. This asks the opposite
 * question, which nothing in the OS ever asked before:
 *
 *   The OS says this listing is live on the MLS. Is it?
 *
 * The feeds the brokerage already pays for are the only outside parties that can
 * answer. See lib/listings/mls-verification.ts for the four honest verdicts and
 * why "no feed connected" must never render as "not on the MLS".
 */
export async function verifyMlsSyndicationAction(listingId: string): Promise<{
  success: boolean
  verification?: MlsVerification
  error?: string
}> {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const supabase = await createClient()
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, address, city, state, zip, brokerage_id, mls_number, listing_date, updated_at")
    .eq("id", listingId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (listingError) return { success: false, error: listingError.message }
  if (!listing) return { success: false, error: "Listing not found in your brokerage" }

  const target = normalizeStreet(listing.address as string | null)
  if (!target) return { success: false, error: "This listing has no street address to match on" }

  const observations: MlsFeedObservation[] = []
  const consulted: MlsFeedSource[] = []

  // ── Feed 1: RentCast's for-sale index, narrowed to this listing's zip/city.
  const { searchRentcastSaleListings } = await import("@/lib/property/rentcast")
  const rc = await searchRentcastSaleListings({
    brokerageId: ctx.brokerageId,
    filters: {
      zipCode: (listing.zip as string | null) ?? undefined,
      city: (listing.zip ? undefined : (listing.city as string | null)) ?? undefined,
      state: (listing.state as string | null) ?? undefined,
      limit: 50,
    },
  })
  // A FAILED search is NOT an empty search. Only a feed we actually reached
  // counts as consulted — otherwise a 401 from RentCast would silently become
  // "your listing is not on the MLS", which is the worst possible lie here.
  if (rc.success) {
    consulted.push("rentcast")
    for (const l of rc.listings) {
      if (normalizeStreet(l.address) !== target) continue
      observations.push({
        source: "rentcast",
        mlsNumber: l.mlsNumber,
        mlsName: l.mlsName,
        address: l.address,
        status: l.status,
      })
    }
  }

  // ── Feed 2: the brokerage's own IDX connection, when they have one.
  try {
    const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
    const idx = await IDXBrokerClient.forBrokerage(ctx.brokerageId, {
      agentUserId: ctx.userId,
      // The team rung — previously skipped, so a team's own IDX connection lost
      // to the brokerage's.
      teamId: ctx.teamId,
    })
    if (idx.isConfigured()) {
      consulted.push("idx")
      const rows = await idx.searchActiveListings({
        city: (listing.city as string | null) ?? undefined,
        state: (listing.state as string | null) ?? undefined,
        zipCode: (listing.zip as string | null) ?? undefined,
      })
      for (const l of rows) {
        if (normalizeStreet(l.address) !== target) continue
        observations.push({
          source: "idx",
          mlsNumber: l.mlsNumber,
          mlsName: null,
          // searchActiveListings only ever returns ACTIVE rows — that is the
          // method's contract and its name. Saying so beats leaving status null,
          // which isActiveOnFeed would (correctly) refuse to treat as live.
          address: l.address,
          status: "active",
        })
      }
    }
  } catch {
    // Unreachable IDX is not a finding about the listing. It stays out of
    // `consulted`, so the verdict degrades to unverifiable rather than lying.
  }

  const verification = verifyMlsSyndication(
    {
      storedMlsNumber: (listing.mls_number as string | null) ?? null,
      liveSince: ((listing.listing_date as string | null) ?? (listing.updated_at as string | null)) ?? null,
    },
    observations,
    consulted,
  )

  return { success: true, verification }
}

/**
 * Street-line comparison key. Deliberately CONSERVATIVE: it only strips the
 * things that are pure formatting (case, punctuation, whitespace runs) and
 * normalises the handful of suffixes that every feed spells differently. It does
 * NOT try to be clever about unit numbers or directionals — a near-match this
 * calls "different" costs a `pending` verdict the agent can dismiss, while a
 * near-match it wrongly calls "same" would compare our listing against SOMEONE
 * ELSE'S MLS number and could raise a false contradiction against a correct row.
 */
function normalizeStreet(raw: string | null | undefined): string | null {
  if (!raw) return null
  const first = raw.split(",")[0] ?? raw
  const s = first
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!s) return null
  const SUFFIX: Record<string, string> = {
    street: "st", avenue: "ave", av: "ave", boulevard: "blvd", drive: "dr",
    road: "rd", lane: "ln", court: "ct", circle: "cir", place: "pl",
    terrace: "ter", parkway: "pkwy", highway: "hwy", trail: "trl", way: "way",
    north: "n", south: "s", east: "e", west: "w",
    northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  }
  return s.split(" ").map((w) => SUFFIX[w] ?? w).join(" ")
}

// ─── Action: launchListingAction ─────────────────────────────────────────────

export async function launchListingAction(params: {
  listingId: string
  mlsNumber: string
  mlsLink?: string
}) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const result = await launchListing({
    listingId:   params.listingId,
    mlsNumber:   params.mlsNumber,
    mlsLink:     params.mlsLink,
    actorUserId: ctx.userId,
  })

  if (result.success) {
    revalidatePath(`/dashboard/listings/${params.listingId}`)
    revalidatePath(`/dashboard/listings/${params.listingId}/lifecycle`)
    revalidatePath("/dashboard/listings")

    // Auto-generate QR code for listing inquiry — non-fatal
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const svc = createServiceClient()
      // SERVICE ROLE BYPASSES RLS — every read below carries an explicit
      // brokerage filter, and every one destructures `error`. Without the filter
      // this block would happily read (and, for qr_codes, write against) a
      // listing belonging to another brokerage if it were ever handed a foreign id.
      const { data: listing, error: listingReadError } = await svc
        .from("listings")
        .select("id, address, brokerage_id, agent_id")
        .eq("id", params.listingId)
        .eq("brokerage_id", ctx.brokerageId)
        .maybeSingle()

      if (listingReadError) {
        console.error("[launchListing] post-launch enrichment skipped — listing read failed:", listingReadError.message)
      }

      if (listing) {
        // THE PACKET THE WHOLE MODULE IS NAMED FOR. app/actions/ai-listing-packet.ts
        // opens with "GENERATES COMPREHENSIVE PROPERTY PACKETS FOR DISPLAY AFTER
        // LISTING GOES LIVE ON MLS" and ends with autoGeneratePacketOnLive — which
        // nothing called, so the packet only ever existed if an agent found the
        // panel on the lifecycle page and asked for it by hand. This is the "goes
        // live" moment: launchListing has just stamped the MLS number and taken the
        // listing to ACTIVE, which is also what generateListingPacket's own
        // MLS-live gate requires.
        //
        // Guarded by an existing-job check so a re-launch does not re-spend six
        // GPT-4o generations, and DISPATCHED rather than awaited (same pattern as
        // the promo-video / lifecycle-mail reactors below) because the agent must
        // not wait on document generation to learn their listing went live.
        try {
          const { data: existingPacket, error: packetReadError } = await svc
            .from("listing_packet_jobs")
            .select("id")
            .eq("listing_id", params.listingId)
            .eq("brokerage_id", ctx.brokerageId)
            .eq("job_type", "full_packet")
            .limit(1)
            .maybeSingle()
          // A FAILED existence check is not "no packet exists". Treating it as
          // absent would re-spend six GPT-4o generations on every re-launch.
          if (packetReadError) {
            console.error("[launchListing] packet existence check failed — not generating:", packetReadError.message)
          } else if (!existingPacket) {
            const { autoGeneratePacketOnLive } = await import("@/app/actions/ai-listing-packet")
            void autoGeneratePacketOnLive(params.listingId, ctx.userId).then((r) => {
              if (!r?.success) {
                console.error("[launchListing] listing packet NOT generated:", r?.error)
              }
            })
          }
        } catch (err) {
          console.error("[launchListing] listing packet dispatch failed:", err)
        }

        // CONSENSUS MEMORY — launching a listing is a STRATEGIC play: raise a pre-launch huddle to the
        // Shopping Agent for a read on live buyer appetite at this price (listing_launch → shopping_agent).
        // The outcome resolves it later — a deal closing on this listing proves the read right, the listing
        // expiring proves it wrong (consult-outcome-resolver) — so the pre-launch pricing read builds a
        // track record over time. Best-effort; never blocks the launch.
        try {
          const { requestSecondOpinion } = await import("@/lib/kernel/second-opinion-runner")
          await requestSecondOpinion({
            brokerageId: (listing as any).brokerage_id, fromManager: "listing_concierge",
            playType: "listing_launch", entityType: "listing", entityId: params.listingId,
            context: "pre-launch read on buyer appetite at this price",
          }, svc)
        } catch {
          // Non-fatal — the huddle is an enhancement, the launch proceeds.
        }

        // MERGED-THEN-DELETED: this used to be its own `qr_codes` insert deduping on
        // (listing_id, brokerage_id, purpose). lib/orchestrator/internal.ts:handleListingLive
        // minted for the SAME listing deduping on (brokerage_id, target_url) — two different
        // keys, so neither path could ever see the other's row and a listing that both launched
        // and fired listing.live ended up with TWO tracked codes splitting its scans. Both now
        // call the one minter with the SAME key: `listing:<listingId>`.
        //
        // What this path contributed and kept: the "a failed lookup must not read as no-code-yet"
        // rule (now enforced inside mintTrackedQr for every caller) and the purpose 'listing' fact
        // (the CHECK has no 'listing_inquiry' for a launch). What it gave up: the address-bearing
        // label text — `qr_codes` has one text column and it now holds the key. The address is not
        // lost, it is READ from listing_id, which every row minted here carries.
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL
        if (!baseUrl) {
          // Base URL not configured — skip QR generation but continue action
        } else {
          const { mintTrackedQr, listingQrLabel } = await import("@/lib/marketing/tracked-qr")
          const minted = await mintTrackedQr({
            brokerageId:     listing.brokerage_id,
            agentId:         listing.agent_id,
            label:           listingQrLabel(params.listingId),
            destinationType: "listing_detail",
            targetUrl:       `${baseUrl}/listings/${listing.id}`,
            listingId:       params.listingId,
            purpose:         "listing",
            origin:          baseUrl,
          }, svc)
          if (!minted) {
            console.error("[launchListing] QR code was NOT created — the mint was refused.")
          }
        } // end else (baseUrl exists)
      }
    } catch (err) {
      // Non-fatal — QR generation is a best-effort enhancement. It is still
      // LOGGED: a silent catch here is how a launch reports success while every
      // post-launch enrichment quietly failed.
      console.error("[launchListing] post-launch enrichment threw:", err)
    }
  }

  return result
}

// ─── Action: updateListingStageAction ────────────────────────────────────────

/**
 * DELIBERATELY NOT WIRED TO THE STAGE PIPELINE — DO NOT DELETE.
 *
 * SECOND-WRITER HAZARD. listings.lifecycle_stage already has a UI writer:
 *
 *   app/components/dashboard/listings/lifecycle/stage-pipeline.tsx
 *     → app/actions/listing-lifecycle.ts:advanceListingStage
 *       → lib/application/listing-lifecycle.ts:advanceListingStageService   (line 147)
 *
 * That path UPDATEs listings.lifecycle_stage + stage_entered_at, maintains the
 * listing_stage_history table (exit timestamps + duration_days), and fires
 * fireStageAutomations. This action's path —
 *
 *   updateListingStage → executeListingTransition → logStageTransition
 *     → transitionLifecycle → UPDATE listings.lifecycle_stage + lifecycle_events
 *
 * — writes the SAME COLUMN from an independent path, keeps NO listing_stage_history,
 * and fires the kernel-event fanout the other path does not. Wiring both would give
 * one row two owners that disagree about where its audit trail lives.
 *
 * THE GOVERNANCE GAP IS NOW CLOSED ON BOTH PATHS. advanceListingStageService used
 * to perform NO validation at all — no readiness checks, no role authority, no
 * stage-machine check — so the only gate on a normal advance was the client-side
 * check in StageAdvanceModal, which any caller can skip. It now runs
 * requireListingStageAdvance (lib/application/listing-lifecycle.ts), which reads the
 * listing's own lifecycle_stage and hands the target's declared allowedFrom /
 * readinessChecks / requiredRoles — straight out of LISTING_LIFECYCLE_STAGES — to the
 * same validateStageTransition executeListingTransition uses. Both paths now refuse
 * the same transitions for the same reasons, from the same table.
 *
 * What remains is the SECOND-WRITER hazard above, which is a different problem: two
 * paths writing one column with audit trails in two places. The correct resolution is
 * still a CONSOLIDATION — advanceListingStage delegating to executeListingTransition
 * and keeping the listing_stage_history write — and it is still out of scope here.
 * Until then this action stays exported, correct and unwired: two writers is the one
 * outcome worse than one.
 *
 * Proof of the gate: scripts/lifecycle-lib-defects-simulator.ts (defect d1).
 */
export async function updateListingStageAction(params: {
  listingId: string
  targetStage: ListingStage
  notes?: string
  overrideReason?: string
}) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const result = await updateListingStage({
    listingId:      params.listingId,
    targetStage:    params.targetStage,
    actorUserId:    ctx.userId,
    notes:          params.notes,
    overrideReason: params.overrideReason,
  })

  if (result.success) {
    revalidatePath(`/dashboard/listings/${params.listingId}/lifecycle`)
    revalidatePath("/dashboard/listings")
  }

  return result
}

// attachMediaAction was REMOVED as a duplicate (merge-then-delete, owner-sanctioned).
// SURVIVOR: app/actions/listing-media.ts:uploadListingMedia — wired from
// app/dashboard/listings/[id]/media/components/media-grid.tsx — which does the same
// job strictly more completely: usage_intent + the MLS branding rule (a legal
// requirement), the attribution flags, thumbnail/alt_text/tags/approval_required,
// checkBrandCompliance(), and the image.generated hero-photo fan-out. This wrapper
// (and lib/kernel/listings.ts:attachMediaToListing beneath it) wrote a bare
// listing_media row expressing only four of the eight admitted media types.
// Nothing it did is missing on the survivor. Do not reintroduce a second writer.

// ─── Action: generateListingDescriptionAction ────────────────────────────────

export async function generateListingDescriptionAction(params: {
  listingId: string
  style?: "luxury" | "family" | "investment" | "standard"
}) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  // TENANT ANCHOR. generateListingDescription reads the listing by id alone; the
  // brokerage check belongs at this boundary so a foreign id is refused by name
  // rather than producing marketing copy for someone else's property.
  const supabase = await createClient()
  const { data: owned, error: ownedError } = await supabase
    .from("listings")
    .select("id")
    .eq("id", params.listingId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (ownedError) return { success: false, error: `Could not verify the listing: ${ownedError.message}` }
  if (!owned)     return { success: false, error: "Listing not found in your brokerage" }

  // IDENTITY CLASS. ctx.agentId is an agents.id (or null for a broker/admin with no
  // agent profile). It is fed to guardContent as the brand-voice key — NEVER
  // substitute ctx.userId here, which is a users.id from a different id space. With
  // no agent record the guardian falls back to brokerage-level voice, which is the
  // honest result for a caller who has no agent identity.
  return generateListingDescription({
    listingId: params.listingId,
    agentId:   ctx.agentId ?? "",
    style:     params.style,
  })
}

// createTransactionFromOfferAction was REMOVED as a duplicate (merge-then-delete,
// owner-sanctioned). SURVIVOR: lib/transactions/offer-bridge.ts:createTransactionFromOffer
// — the documented "single source of truth for transaction creation", reached from
// three live paths: app/actions/seller-offers.ts (acceptOffer), buyer-offer/
// convert-to-transaction.ts and buyer-offer/submit-to-compliance.ts. The deleted
// shell (and lib/kernel/listings.ts:createTransactionShellFromAcceptedOffer beneath
// it) omitted the assertOfferReadyForTransaction gate, contract_date /
// compliance_passed_at, earnest_money, milestone seeding, the offers.transaction_id
// back-link and the cost breakdown — and stamped buyer_contact_id unconditionally,
// a defect the bridge already fixed. Nothing it did is missing on the survivor.
// Do not reintroduce a second transactions writer on the offer-accepted trigger.

// ─── Action: closeListingAction ───────────────────────────────────────────────

/**
 * DELIBERATELY NOT WIRED — DO NOT DELETE.
 *
 * Inherits the second-writer hazard documented on updateListingStageAction above:
 * closeListingLifecycle is updateListingStage(CLOSED), so it writes
 * listings.lifecycle_stage down the kernel path while the stage pipeline writes the
 * same column down the advanceListingStageService path. A "Close listing" button
 * calling this would be the second writer.
 *
 * CLOSED is reachable today from the stage pipeline like any other stage, and the
 * CLOSED side effect this action exists for — handleSellerToLifetimeTransition,
 * which converts the seller to a lifetime customer — lives in
 * executeListingTransition and fires on that path, not this one. So nothing is
 * currently unreachable because this is unwired.
 *
 * Wire it once the stage-writer consolidation lands; it is then the natural home for
 * an explicit "Close this listing" control.
 */
export async function closeListingAction(listingId: string) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const result = await closeListingLifecycle({
    listingId,
    actorUserId: ctx.userId,
  })

  if (result.success) {
    revalidatePath(`/dashboard/listings/${listingId}/lifecycle`)
    revalidatePath("/dashboard/listings")
  }

  return result
}

// ─── Action: prefillListingFormAction ────────────────────────────────────────

/**
 * WIRED: app/components/dashboard/listings/lifecycle/listing-forms-panel.tsx
 *
 * Note the DIVISION with forms-kernel's prefillFormAction, which is the writer-side
 * prefill and stays that way: prefillFormWithContext(context_type="listing") fills
 * the form FIELD MAP that saveFormDraft persists, and it resolves listing + seller
 * only. This one additionally resolves the agent's licence number/state and the
 * brokerage's name/address/phone/licence — the block a listing agreement needs and
 * which prefillFormWithContext does not carry. It is used READ-ONLY, to warn before
 * a defective form is sent. Two readers, one writer.
 */
export async function prefillListingFormAction(listingId: string) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  // TENANT ANCHOR. prefillListingFormFromRecord reads by id alone, so the brokerage
  // check belongs here — this payload contains a seller's name, email and phone.
  const supabase = await createClient()
  const { data: owned, error: ownedError } = await supabase
    .from("listings")
    .select("id")
    .eq("id", listingId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (ownedError) return { success: false, error: `Could not verify the listing: ${ownedError.message}` }
  if (!owned)     return { success: false, error: "Listing not found in your brokerage" }

  return prefillListingFormFromRecord({ listingId })
}

// ─── Action: loadListingWorkspaceAction ──────────────────────────────────────

/**
 * DELIBERATELY NOT WIRED — DO NOT DELETE. This is a complete capability held back
 * for a named reason, not an abandoned one.
 *
 * It loads listing + media + tasks + timeline + currentStage for a listing. The one
 * screen that needs that bundle — app/dashboard/listings/[id]/lifecycle/page.tsx —
 * already loads every part of it server-side and MORE COMPLETELY:
 *
 *   listing   page.tsx:67-88   (with the agent/team/broker auth scope this lacks)
 *   media     page.tsx:206     app/actions/listing-media.ts:getListingMedia
 *   tasks     page.tsx:110-115 (filtered to auto_generated, which this does not do)
 *   timeline  page.tsx:102-107 (entity_type='listing_stage_machine' — see below)
 *
 * Calling this from a component on that page would re-read all four over the wire
 * for no new information. It is a read, so there is no second-writer hazard; the
 * objection is purely duplication.
 *
 * THE LATENT DEFECT IT CARRIED IS FIXED. loadListingWorkspace read lifecycle_events
 * with entity_type "listing" only, while the stage machine writes
 * "listing_stage_machine" (ENTITY_MAP in lib/kernel/lifecycle.ts, via
 * lib/listing-lifecycle/lifecycle-logger.ts:56) — so its `timeline` was always empty
 * of stage transitions. BOTH entity types are written, by different producers, so it
 * now reads BOTH (LISTING_TIMELINE_ENTITY_TYPES in lib/kernel/listings.ts); swapping
 * one for the other would have dropped the create, the launch and the override audit
 * row instead. All four of its reads are error-checked, so a refused read is no
 * longer an empty list. Proof: scripts/lifecycle-lib-defects-simulator.ts (defect d2).
 *
 * Wire this when a listing surface exists that is NOT the lifecycle page — a mobile
 * workspace or an embedded panel.
 */
export async function loadListingWorkspaceAction(listingId: string) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const supabase = await createClient()
  const { data: owned, error: ownedError } = await supabase
    .from("listings")
    .select("id")
    .eq("id", listingId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (ownedError) return { success: false, error: `Could not verify the listing: ${ownedError.message}` }
  if (!owned)     return { success: false, error: "Listing not found in your brokerage" }

  return loadListingWorkspace({ listingId, userId: ctx.userId })
}

// ─── Action: updateListingStatus (migrated from listings.ts) ─────────────────

export async function updateListingStatus(listingId: string, status: string) {
  const supabase = await createClient()
  try {
    // VOCABULARY GATE. `status` arrives as free text from a client picker, and
    // listings.status is CHECK-constrained — so an unadmitted value reached the
    // database and came back as a raw constraint error that names no valid
    // phases. The picker offered "under_contract" (a TRANSACTION status) for
    // exactly this reason: nothing here disagreed with it. Validated against the
    // one canonical list the picker now renders from, so the two cannot drift.
    if (!isListingStatus(status)) {
      return {
        success: false,
        error: `'${status}' is not a listing phase. Valid: ${LISTING_STATUSES.join(", ")}`,
      }
    }

    // Auth + ownership check — was previously open IDOR.
    // Every read destructures `error`: an authorisation gate that reads "clean"
    // because the query FAILED is the worst possible way to lose a gate. Here a
    // failed read must produce a refusal, not a fall-through.
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { success: false, error: "Unauthorized" }

    const { data: callerRow, error: callerError } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .maybeSingle()
    if (callerError) return { success: false, error: `Could not verify your account: ${callerError.message}` }
    if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }

    const { data: listingRow, error: listingRowError } = await supabase
      .from("listings")
      .select("brokerage_id")
      .eq("id", listingId)
      .maybeSingle()
    if (listingRowError) return { success: false, error: `Could not verify the listing: ${listingRowError.message}` }
    if (!listingRow) return { success: false, error: "Listing not found" }
    if (listingRow.brokerage_id !== callerRow.brokerage_id) {
      return { success: false, error: "Forbidden" }
    }

    // current_stage was renamed to lifecycle_stage (migration 1014) and the
    // CHECK requires the uppercase enum (CLOSED / LISTING_CANCELLED), so the
    // old { current_stage: "closed" | "cancelled" } update threw on both the
    // column and the value.
    const { data, error } = await supabase
      .from("listings")
      .update({
        status,
        lifecycle_stage:
          status === "sold" ? "CLOSED" : status === "withdrawn" ? "LISTING_CANCELLED" : undefined,
        updated_at: new Date().toISOString(),
      })
      .eq("id", listingId)
      // tenant anchor (scope burn-down)
      .eq("brokerage_id", callerRow.brokerage_id)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard/listings")
    revalidatePath(`/dashboard/listings/${listingId}`)
    revalidatePath(`/dashboard/listings/${listingId}/lifecycle`)
    return { success: true, listing: data }
  } catch (error) {
    console.error("updateListingStatus error:", error)
    return { success: false, error: "Failed to update listing status" }
  }
}
