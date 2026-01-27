"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"

/**
 * Platform Sync Service
 * Consolidates integrations with external platforms:
 * - Dotloop (document management)
 * - GoHighLevel (CRM/Marketing)
 * - QuickBooks (accounting)
 * - Google Calendar
 * - ShowingTime
 * - MLS/IDX
 */

// ============================================================================
// DOTLOOP INTEGRATION
// ============================================================================

export async function syncDotloopLoop(params: {
  agentId: string
  loopId: string
  transactionId?: string
}): Promise<{ success: boolean; data?: any; error?: string }> {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
    const supabase = createServiceClient()

    // Get agent's Dotloop credentials
    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("platform", "dotloop")
      .single()

    if (!credentials?.access_token) {
      return { success: false, error: "Dotloop not connected" }
    }

    // Fetch loop details from Dotloop API
    const response = await fetch(
      `https://api-gateway.dotloop.com/public/v2/loop/${params.loopId}`,
      {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
          "Content-Type": "application/json",
        },
      }
    )

    if (!response.ok) {
      throw new Error(`Dotloop API error: ${response.status}`)
    }

    const loopData = await response.json()

    // Store sync record
    await supabase.from("platform_sync_logs").insert({
      agent_id: params.agentId,
      platform: "dotloop",
      sync_type: "loop_fetch",
      external_id: params.loopId,
      sync_data: loopData,
      status: "success",
    })

    // Link to transaction if provided
    if (params.transactionId && isValidUUID(params.transactionId)) {
      await supabase
        .from("transactions")
        .update({
          dotloop_loop_id: params.loopId,
          dotloop_sync_data: loopData,
          updated_at: new Date().toISOString(),
        })
        .eq("id", params.transactionId)
    }

    return { success: true, data: loopData }
  } catch (error) {
    console.error("[v0] Dotloop sync error:", error)
    return handleError(error, "syncDotloopLoop")
  }
}

export async function createDotloopLoop(params: {
  agentId: string
  transactionId: string
  loopName: string
  transactionType: "listing" | "purchase"
  propertyAddress: string
}): Promise<{ success: boolean; loopId?: string; error?: string }> {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid IDs" }
  }

  try {
    const supabase = createServiceClient()

    // Get Dotloop credentials
    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("platform", "dotloop")
      .single()

    if (!credentials?.access_token) {
      return { success: false, error: "Dotloop not connected" }
    }

    // Create loop in Dotloop
    const response = await fetch(
      "https://api-gateway.dotloop.com/public/v2/loop",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: params.loopName,
          transactionType: params.transactionType === "listing" ? "LISTING_FOR_SALE" : "PURCHASE_OFFER",
          status: "PRIVATE",
          loopDetails: {
            propertyAddress: {
              streetName: params.propertyAddress,
            },
          },
        }),
      }
    )

    if (!response.ok) {
      throw new Error(`Dotloop API error: ${response.status}`)
    }

    const loopData = await response.json()
    const loopId = loopData.data?.id

    // Update transaction with loop ID
    await supabase
      .from("transactions")
      .update({
        dotloop_loop_id: loopId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.transactionId)

    return { success: true, loopId }
  } catch (error) {
    console.error("[v0] Create Dotloop loop error:", error)
    return handleError(error, "createDotloopLoop")
  }
}

export async function getDotloopDocuments(params: {
  agentId: string
  loopId: string
}): Promise<{ success: boolean; documents?: any[]; error?: string }> {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
    const supabase = createServiceClient()

    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("platform", "dotloop")
      .single()

    if (!credentials?.access_token) {
      return { success: false, error: "Dotloop not connected" }
    }

    const response = await fetch(
      `https://api-gateway.dotloop.com/public/v2/loop/${params.loopId}/document`,
      {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
        },
      }
    )

    if (!response.ok) {
      throw new Error(`Dotloop API error: ${response.status}`)
    }

    const data = await response.json()
    return { success: true, documents: data.data || [] }
  } catch (error) {
    console.error("[v0] Get Dotloop documents error:", error)
    return handleError(error, "getDotloopDocuments")
  }
}

// ============================================================================
// GOHIGHLEVEL INTEGRATION
// ============================================================================

export async function syncGHLContact(params: {
  agentId: string
  contactId: string
  direction: "push" | "pull"
}): Promise<{ success: boolean; data?: any; error?: string }> {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid IDs" }
  }

  try {
    const supabase = createServiceClient()

    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("platform", "gohighlevel")
      .single()

    if (!credentials?.access_token) {
      return { success: false, error: "GoHighLevel not connected" }
    }

    if (params.direction === "push") {
      // Get contact from our DB
      const { data: contact } = await supabase
        .from("contacts")
        .select("*")
        .eq("id", params.contactId)
        .single()

      if (!contact) {
        return { success: false, error: "Contact not found" }
      }

      // Push to GHL
      const response = await fetch(
        `${credentials.api_url}/contacts/`,
        {
          method: contact.ghl_contact_id ? "PUT" : "POST",
          headers: {
            Authorization: `Bearer ${credentials.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            firstName: contact.first_name,
            lastName: contact.last_name,
            email: contact.email,
            phone: contact.phone,
            tags: [contact.contact_type, contact.status].filter(Boolean),
            customFields: {
              source: contact.source,
              timeline: contact.timeline,
            },
          }),
        }
      )

      const ghlData = await response.json()

      // Update contact with GHL ID
      if (ghlData.contact?.id) {
        await supabase
          .from("contacts")
          .update({ ghl_contact_id: ghlData.contact.id })
          .eq("id", params.contactId)
      }

      return { success: true, data: ghlData }
    } else {
      // Pull from GHL
      const { data: contact } = await supabase
        .from("contacts")
        .select("ghl_contact_id")
        .eq("id", params.contactId)
        .single()

      if (!contact?.ghl_contact_id) {
        return { success: false, error: "No GHL contact linked" }
      }

      const response = await fetch(
        `${credentials.api_url}/contacts/${contact.ghl_contact_id}`,
        {
          headers: {
            Authorization: `Bearer ${credentials.access_token}`,
          },
        }
      )

      const ghlData = await response.json()
      return { success: true, data: ghlData }
    }
  } catch (error) {
    console.error("[v0] GHL sync error:", error)
    return handleError(error, "syncGHLContact")
  }
}

export async function triggerGHLWorkflow(params: {
  agentId: string
  contactId: string
  workflowId: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid IDs" }
  }

  try {
    const supabase = createServiceClient()

    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("platform", "gohighlevel")
      .single()

    if (!credentials?.access_token) {
      return { success: false, error: "GoHighLevel not connected" }
    }

    const { data: contact } = await supabase
      .from("contacts")
      .select("ghl_contact_id")
      .eq("id", params.contactId)
      .single()

    if (!contact?.ghl_contact_id) {
      return { success: false, error: "Contact not synced to GHL" }
    }

    await fetch(
      `${credentials.api_url}/contacts/${contact.ghl_contact_id}/workflow/${params.workflowId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
        },
      }
    )

    return { success: true }
  } catch (error) {
    console.error("[v0] GHL workflow trigger error:", error)
    return handleError(error, "triggerGHLWorkflow")
  }
}

// ============================================================================
// QUICKBOOKS INTEGRATION
// ============================================================================

export async function syncQuickBooksExpense(params: {
  agentId: string
  expenseId: string
}): Promise<{ success: boolean; qbId?: string; error?: string }> {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.expenseId)) {
    return { success: false, error: "Invalid IDs" }
  }

  try {
    const supabase = createServiceClient()

    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("platform", "quickbooks")
      .single()

    if (!credentials?.access_token) {
      return { success: false, error: "QuickBooks not connected" }
    }

    const { data: expense } = await supabase
      .from("expenses")
      .select("*")
      .eq("id", params.expenseId)
      .single()

    if (!expense) {
      return { success: false, error: "Expense not found" }
    }

    // Create expense in QuickBooks
    const response = await fetch(
      `${credentials.api_url}/v3/company/${credentials.realm_id}/purchase`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          PaymentType: "Cash",
          TotalAmt: expense.amount,
          TxnDate: expense.expense_date,
          Line: [
            {
              DetailType: "AccountBasedExpenseLineDetail",
              Amount: expense.amount,
              AccountBasedExpenseLineDetail: {
                AccountRef: {
                  name: expense.category,
                },
              },
              Description: expense.description,
            },
          ],
        }),
      }
    )

    const qbData = await response.json()

    // Update expense with QB ID
    if (qbData.Purchase?.Id) {
      await supabase
        .from("expenses")
        .update({ quickbooks_id: qbData.Purchase.Id })
        .eq("id", params.expenseId)
    }

    return { success: true, qbId: qbData.Purchase?.Id }
  } catch (error) {
    console.error("[v0] QuickBooks sync error:", error)
    return handleError(error, "syncQuickBooksExpense")
  }
}

export async function syncQuickBooksCommission(params: {
  agentId: string
  commissionId: string
}): Promise<{ success: boolean; qbId?: string; error?: string }> {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.commissionId)) {
    return { success: false, error: "Invalid IDs" }
  }

  try {
    const supabase = createServiceClient()

    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("platform", "quickbooks")
      .single()

    if (!credentials?.access_token) {
      return { success: false, error: "QuickBooks not connected" }
    }

    const { data: commission } = await supabase
      .from("commission_records")
      .select("*, transactions(*)")
      .eq("id", params.commissionId)
      .single()

    if (!commission) {
      return { success: false, error: "Commission not found" }
    }

    // Create income in QuickBooks
    const response = await fetch(
      `${credentials.api_url}/v3/company/${credentials.realm_id}/salesreceipt`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          TotalAmt: commission.net_amount,
          TxnDate: commission.paid_date || commission.created_at,
          Line: [
            {
              DetailType: "SalesItemLineDetail",
              Amount: commission.net_amount,
              SalesItemLineDetail: {
                ItemRef: {
                  name: "Commission Income",
                },
              },
              Description: `Commission - ${commission.transactions?.property_address || "Transaction"}`,
            },
          ],
        }),
      }
    )

    const qbData = await response.json()

    if (qbData.SalesReceipt?.Id) {
      await supabase
        .from("commission_records")
        .update({ quickbooks_id: qbData.SalesReceipt.Id })
        .eq("id", params.commissionId)
    }

    return { success: true, qbId: qbData.SalesReceipt?.Id }
  } catch (error) {
    console.error("[v0] QuickBooks commission sync error:", error)
    return handleError(error, "syncQuickBooksCommission")
  }
}

// ============================================================================
// GOOGLE CALENDAR INTEGRATION
// ============================================================================

export async function syncGoogleCalendarEvent(params: {
  agentId: string
  appointmentId: string
  direction: "push" | "pull"
}): Promise<{ success: boolean; eventId?: string; error?: string }> {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.appointmentId)) {
    return { success: false, error: "Invalid IDs" }
  }

  try {
    const supabase = createServiceClient()

    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("platform", "google_calendar")
      .single()

    if (!credentials?.access_token) {
      return { success: false, error: "Google Calendar not connected" }
    }

    const { data: appointment } = await supabase
      .from("appointments")
      .select("*, contacts(*)")
      .eq("id", params.appointmentId)
      .single()

    if (!appointment) {
      return { success: false, error: "Appointment not found" }
    }

    if (params.direction === "push") {
      const eventBody = {
        summary: appointment.title,
        description: appointment.notes,
        start: {
          dateTime: appointment.start_time,
          timeZone: "America/New_York",
        },
        end: {
          dateTime: appointment.end_time,
          timeZone: "America/New_York",
        },
        location: appointment.location,
        attendees: appointment.contacts?.email
          ? [{ email: appointment.contacts.email }]
          : [],
      }

      const url = appointment.google_event_id
        ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${appointment.google_event_id}`
        : "https://www.googleapis.com/calendar/v3/calendars/primary/events"

      const response = await fetch(url, {
        method: appointment.google_event_id ? "PUT" : "POST",
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(eventBody),
      })

      const eventData = await response.json()

      if (eventData.id) {
        await supabase
          .from("appointments")
          .update({ google_event_id: eventData.id })
          .eq("id", params.appointmentId)
      }

      return { success: true, eventId: eventData.id }
    }

    return { success: true }
  } catch (error) {
    console.error("[v0] Google Calendar sync error:", error)
    return handleError(error, "syncGoogleCalendarEvent")
  }
}

// ============================================================================
// SHOWINGTIME INTEGRATION
// ============================================================================

export async function syncShowingTimeAppointments(params: {
  agentId: string
  listingId?: string
}): Promise<{ success: boolean; showings?: any[]; error?: string }> {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
    const supabase = createServiceClient()

    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("platform", "showingtime")
      .single()

    if (!credentials?.access_token) {
      return { success: false, error: "ShowingTime not connected" }
    }

    // Fetch showings from ShowingTime API
    let url = `${credentials.api_url}/showings`
    if (params.listingId) {
      const { data: listing } = await supabase
        .from("listings")
        .select("mls_number")
        .eq("id", params.listingId)
        .single()
      if (listing?.mls_number) {
        url += `?mlsNumber=${listing.mls_number}`
      }
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
      },
    })

    const showingsData = await response.json()

    // Sync to our database
    for (const showing of showingsData.showings || []) {
      await supabase.from("showings").upsert({
        agent_id: params.agentId,
        listing_id: params.listingId,
        showingtime_id: showing.id,
        scheduled_date: showing.date,
        scheduled_time: showing.time,
        buyer_agent_name: showing.buyerAgentName,
        buyer_agent_phone: showing.buyerAgentPhone,
        status: showing.status,
        feedback: showing.feedback,
        synced_at: new Date().toISOString(),
      }, {
        onConflict: "showingtime_id",
      })
    }

    return { success: true, showings: showingsData.showings }
  } catch (error) {
    console.error("[v0] ShowingTime sync error:", error)
    return handleError(error, "syncShowingTimeAppointments")
  }
}

// ============================================================================
// MLS/IDX INTEGRATION
// ============================================================================

export async function syncMLSListings(params: {
  agentId: string
  mlsId?: string
}): Promise<{ success: boolean; count?: number; error?: string }> {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
    const supabase = createServiceClient()

    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("platform", "mls")
      .single()

    if (!credentials?.access_token) {
      return { success: false, error: "MLS not connected" }
    }

    // Get agent's MLS ID
    const { data: agent } = await supabase
      .from("users")
      .select("mls_id")
      .eq("id", params.agentId)
      .single()

    const mlsAgentId = params.mlsId || agent?.mls_id

    if (!mlsAgentId) {
      return { success: false, error: "No MLS ID configured" }
    }

    // Fetch listings from MLS (RESO Web API format)
    const response = await fetch(
      `${credentials.api_url}/Property?$filter=ListAgentMlsId eq '${mlsAgentId}'&$top=100`,
      {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
          Accept: "application/json",
        },
      }
    )

    const mlsData = await response.json()
    let syncCount = 0

    for (const property of mlsData.value || []) {
      await supabase.from("listings").upsert({
        agent_id: params.agentId,
        mls_number: property.ListingId,
        address: property.UnparsedAddress,
        city: property.City,
        state: property.StateOrProvince,
        zip_code: property.PostalCode,
        property_type: property.PropertyType,
        bedrooms: property.BedroomsTotal,
        bathrooms: property.BathroomsTotalInteger,
        square_feet: property.LivingArea,
        lot_size: property.LotSizeAcres,
        year_built: property.YearBuilt,
        list_price: property.ListPrice,
        status: property.StandardStatus,
        description: property.PublicRemarks,
        photos: property.Media?.map((m: any) => m.MediaURL) || [],
        mls_sync_data: property,
        mls_synced_at: new Date().toISOString(),
      }, {
        onConflict: "mls_number",
      })
      syncCount++
    }

    return { success: true, count: syncCount }
  } catch (error) {
    console.error("[v0] MLS sync error:", error)
    return handleError(error, "syncMLSListings")
  }
}

// ============================================================================
// PLATFORM CREDENTIAL MANAGEMENT
// ============================================================================

export async function savePlatformCredentials(params: {
  agentId: string
  platform: string
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  apiUrl?: string
  realmId?: string
  additionalData?: Record<string, any>
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
    const supabase = createServiceClient()

    await supabase.from("platform_credentials").upsert({
      agent_id: params.agentId,
      platform: params.platform,
      access_token: params.accessToken,
      refresh_token: params.refreshToken,
      expires_at: params.expiresAt,
      api_url: params.apiUrl,
      realm_id: params.realmId,
      additional_data: params.additionalData,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: "agent_id,platform",
    })

    return { success: true }
  } catch (error) {
    console.error("[v0] Save credentials error:", error)
    return handleError(error, "savePlatformCredentials")
  }
}

export async function getPlatformStatus(params: {
  agentId: string
}): Promise<{ success: boolean; platforms?: Record<string, boolean>; error?: string }> {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
    const supabase = createServiceClient()

    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("platform, expires_at")
      .eq("agent_id", params.agentId)

    const platforms: Record<string, boolean> = {
      dotloop: false,
      gohighlevel: false,
      quickbooks: false,
      google_calendar: false,
      showingtime: false,
      mls: false,
    }

    for (const cred of credentials || []) {
      const isExpired = cred.expires_at && new Date(cred.expires_at) < new Date()
      platforms[cred.platform] = !isExpired
    }

    return { success: true, platforms }
  } catch (error) {
    console.error("[v0] Get platform status error:", error)
    return handleError(error, "getPlatformStatus")
  }
}
