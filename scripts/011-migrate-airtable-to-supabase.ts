// Migration script to move contacts from Airtable to Supabase
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function migrateContacts() {
  console.log("Starting Airtable to Supabase migration...")

  // Fetch contacts from Airtable
  const airtableResponse = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Contacts`, {
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
    },
  })

  if (!airtableResponse.ok) {
    throw new Error("Failed to fetch from Airtable")
  }

  const airtableData = await airtableResponse.json()
  const records = airtableData.records || []

  console.log(`Found ${records.length} contacts in Airtable`)

  // Map and insert contacts into Supabase
  for (const record of records) {
    const fields = record.fields

    const contact = {
      ghl_contact_id: fields.GHL_Contact_ID || fields.id,
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

    const { data, error } = await supabase.from("contacts").insert(contact).select()

    if (error) {
      console.error(`Failed to migrate contact ${fields.first_name} ${fields.last_name}:`, error)
    } else {
      console.log(`✓ Migrated contact: ${fields.first_name} ${fields.last_name}`)
    }
  }

  console.log("Migration complete!")
}

migrateContacts().catch(console.error)
