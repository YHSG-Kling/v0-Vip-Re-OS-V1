import { NextResponse } from "next/server"

const API_KEY = process.env.AIRTABLE_API_KEY || ""
const BASE_ID = process.env.AIRTABLE_BASE_ID || ""
const BASE_URL = `https://api.airtable.com/v0/${BASE_ID}`

export async function POST() {
  if (!API_KEY) {
    return NextResponse.json({ error: "Missing AIRTABLE_API_KEY environment variable" }, { status: 500 })
  }

  if (!BASE_ID) {
    return NextResponse.json({ error: "Missing AIRTABLE_BASE_ID environment variable" }, { status: 500 })
  }

  const agentId = "sarah.agent@nexus.local"

  const TEST_CONTACTS = [
    {
      fields: {
        GHL_Contact_ID: "ghl_001_james_wilson",
        first_name: "James",
        last_name: "Wilson",
        email: "james.wilson@testmail.com",
        phone: "512-555-0101",
        contact_type: "buyer",
        contact_persona: "first_time_buyer",
        source: "zillow",
        status: "new",
        timeline: "0-3_months",
        agent_id: agentId,
        notes: "Pre-approved for $450k, interested in East Austin condos",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
    {
      fields: {
        GHL_Contact_ID: "ghl_002_patricia_garcia",
        first_name: "Patricia",
        last_name: "Garcia",
        email: "patricia.garcia@testmail.com",
        phone: "512-555-0102",
        contact_type: "seller",
        contact_persona: "motivated_seller",
        source: "referral",
        status: "contacted",
        timeline: "0-3_months",
        agent_id: agentId,
        notes: "Relocating for work, needs to sell within 60 days",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
    {
      fields: {
        GHL_Contact_ID: "ghl_003_robert_martinez",
        first_name: "Robert",
        last_name: "Martinez",
        email: "robert.martinez@testmail.com",
        phone: "512-555-0103",
        contact_type: "investor",
        contact_persona: "investor",
        source: "website",
        status: "qualified",
        timeline: "3-6_months",
        agent_id: agentId,
        notes: "Looking for multi-family properties in 78704, cash buyer",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
    {
      fields: {
        GHL_Contact_ID: "ghl_004_linda_thompson",
        first_name: "Linda",
        last_name: "Thompson",
        email: "linda.thompson@testmail.com",
        phone: "512-555-0104",
        contact_type: "buyer",
        contact_persona: "relocating",
        source: "realtor.com",
        status: "appointment_booked",
        timeline: "0-3_months",
        agent_id: agentId,
        notes: "Moving from California, budget $600-800k, needs good schools",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
    {
      fields: {
        GHL_Contact_ID: "ghl_005_david_anderson",
        first_name: "David",
        last_name: "Anderson",
        email: "david.anderson@testmail.com",
        phone: "512-555-0105",
        contact_type: "buyer",
        contact_persona: "luxury_buyer",
        source: "referral",
        status: "new",
        timeline: "6-12_months",
        agent_id: agentId,
        notes: "Looking for $1.5M+ homes, wants smart home features and pool",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
    {
      fields: {
        GHL_Contact_ID: "ghl_006_nancy_white",
        first_name: "Nancy",
        last_name: "White",
        email: "nancy.white@testmail.com",
        phone: "512-555-0106",
        contact_type: "seller",
        contact_persona: "fsbo",
        source: "cold_call",
        status: "contacted",
        timeline: "3-6_months",
        agent_id: agentId,
        notes: "FSBO for 3 months, now ready for professional help",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
  ]

  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  }

  const results: { name: string; success: boolean; error?: string; id?: string }[] = []

  for (const contact of TEST_CONTACTS) {
    try {
      console.log("[v0] Seeding contact:", contact.fields.first_name, contact.fields.last_name)

      const response = await fetch(`${BASE_URL}/Contacts`, {
        method: "POST",
        headers,
        body: JSON.stringify(contact),
      })

      const responseText = await response.text()
      console.log("[v0] Airtable response status:", response.status)
      console.log("[v0] Airtable response body:", responseText)

      if (!response.ok) {
        let errorData
        try {
          errorData = JSON.parse(responseText)
        } catch {
          errorData = { error: responseText }
        }

        if (response.status === 404) {
          return NextResponse.json(
            {
              error: "Airtable 'Contacts' table not found",
              tableNotFound: true,
              message: "You need to create a 'Contacts' table in your Airtable base first.",
            },
            { status: 404 },
          )
        }

        results.push({
          name: `${contact.fields.first_name} ${contact.fields.last_name}`,
          success: false,
          error: errorData.error?.message || errorData.error || "Unknown error",
        })
      } else {
        const data = JSON.parse(responseText)
        console.log("[v0] Successfully created contact with ID:", data.id)
        results.push({
          name: `${contact.fields.first_name} ${contact.fields.last_name}`,
          success: true,
          id: data.id,
        })
      }
    } catch (err) {
      console.error("[v0] Seed error for contact:", contact.fields.first_name, err)
      results.push({
        name: `${contact.fields.first_name} ${contact.fields.last_name}`,
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      })
    }
  }

  const successCount = results.filter((r) => r.success).length
  return NextResponse.json({
    message: `Seeded ${successCount}/${TEST_CONTACTS.length} test contacts`,
    results,
  })
}
