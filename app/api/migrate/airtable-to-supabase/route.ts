import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function POST() {
  try {
    console.log("[v0] Starting Airtable to Supabase migration...")

    // Fetch contacts from Airtable
    const airtableResponse = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Contacts`, {
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      },
    })

    if (!airtableResponse.ok) {
      const errorText = await airtableResponse.text()
      throw new Error(`Failed to fetch from Airtable: ${errorText}`)
    }

    const airtableData = await airtableResponse.json()
    const records = airtableData.records || []

    console.log(`[v0] Found ${records.length} contacts in Airtable`)

    const results = []

    // Map and insert contacts into Supabase
    for (const record of records) {
      const fields = record.fields

      const contact = {
        ghl_contact_id: fields.GHL_Contact_ID || record.id,
        first_name: fields.first_name || "",
        last_name: fields.last_name || "",
        email: fields.email,
        phone: fields.phone,
        contact_type: fields.contact_type,
        contact_persona: fields.contact_persona,
        status: fields.status || "new",
        timeline: fields.timeline,
        source: fields.source,
        notes: fields.notes,
        engagement_score: 0,
        intent_score: 0,
      }

      const { data, error } = await supabase.from("contacts").upsert(contact, { onConflict: "ghl_contact_id" }).select()

      if (error) {
        console.error(`[v0] Failed to migrate contact ${fields.first_name} ${fields.last_name}:`, error)
        results.push({
          name: `${fields.first_name} ${fields.last_name}`,
          success: false,
          error: error.message,
        })
      } else {
        console.log(`[v0] Migrated contact: ${fields.first_name} ${fields.last_name}`)
        results.push({
          name: `${fields.first_name} ${fields.last_name}`,
          success: true,
          id: data[0].id,
        })
      }
    }

    const successCount = results.filter((r) => r.success).length
    const failCount = results.filter((r) => !r.success).length

    console.log(`[v0] Migration complete! Success: ${successCount}, Failed: ${failCount}`)

    return NextResponse.json({
      success: true,
      message: `Migrated ${successCount} contacts, ${failCount} failed`,
      results,
    })
  } catch (error: any) {
    console.error("[v0] Migration error:", error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
