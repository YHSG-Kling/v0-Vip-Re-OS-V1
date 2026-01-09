import fetch from "node-fetch"

const AIRTABLE_API_TOKEN = process.env.AIRTABLE_API_TOKEN
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID

if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
  console.error("[v0] Missing Airtable environment variables. Check your .env file.")
  process.exit(1)
}

const API_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`

interface AirtableContact {
  fields: {
    Name: string
    Email: string
    Phone: string
    "Contact Type": string
    Persona: string
    Source: string
    Status: string
    Timeline: string
    "Agent ID"?: string
    Notes?: string
  }
}

const TEST_CONTACTS: AirtableContact[] = [
  {
    fields: {
      Name: "James Wilson",
      Email: "james.wilson@email.com",
      Phone: "+1-512-555-0101",
      "Contact Type": "buyer",
      Persona: "first_time_buyer",
      Source: "zillow",
      Status: "new",
      Timeline: "0-3 months",
      Notes: "Very interested in East Austin condos, pre-approved for $450k",
    },
  },
  {
    fields: {
      Name: "Patricia Garcia",
      Email: "patricia.garcia@email.com",
      Phone: "+1-512-555-0102",
      "Contact Type": "seller",
      Persona: "motivated_seller",
      Source: "referral",
      Status: "active",
      Timeline: "1-2 weeks",
      Notes: "Needs to sell before job relocation, flexible on price",
    },
  },
  {
    fields: {
      Name: "Robert Martinez",
      Email: "robert.martinez@email.com",
      Phone: "+1-512-555-0103",
      "Contact Type": "buyer",
      Persona: "investor",
      Source: "direct_mail",
      Status: "qualified",
      Timeline: "Ongoing",
      Notes: "Looking for 3-4 plex properties in 78704 ZIP code",
    },
  },
  {
    fields: {
      Name: "Linda Thompson",
      Email: "linda.thompson@email.com",
      Phone: "+1-512-555-0104",
      "Contact Type": "buyer",
      Persona: "relocating_buyer",
      Source: "website",
      Status: "active",
      Timeline: "6-8 weeks",
      Notes: "Relocating from California, need walkable neighborhood with good schools",
    },
  },
  {
    fields: {
      Name: "David Anderson",
      Email: "david.anderson@email.com",
      Phone: "+1-512-555-0105",
      "Contact Type": "buyer",
      Persona: "luxury_buyer",
      Source: "email_campaign",
      Status: "new",
      Timeline: "3-6 months",
      Notes: "Interested in luxury homes $1M+, requires smart home features",
    },
  },
  {
    fields: {
      Name: "Nancy White",
      Email: "nancy.white@email.com",
      Phone: "+1-512-555-0106",
      "Contact Type": "seller",
      Persona: "fsbo",
      Source: "fsbo_outreach",
      Status: "active",
      Timeline: "2-3 months",
      Notes: "Previously listed FSBO, now ready for professional representation",
    },
  },
]

async function seedContacts() {
  console.log("[v0] Starting test contact seeding to Airtable...")

  const headers = {
    Authorization: `Bearer ${AIRTABLE_API_TOKEN}`,
    "Content-Type": "application/json",
  }

  for (const contact of TEST_CONTACTS) {
    try {
      const response = await fetch(`${API_URL}/Contacts`, {
        method: "POST",
        headers,
        body: JSON.stringify(contact),
      })

      if (!response.ok) {
        const error = await response.json()
        console.error(`[v0] Error creating contact ${contact.fields.Name}:`, error)
      } else {
        const data = await response.json()
        console.log(`[v0] Created test contact: ${contact.fields.Name}`)
      }
    } catch (err) {
      console.error(`[v0] Failed to seed contact ${contact.fields.Name}:`, err)
    }
  }

  console.log("[v0] Test contact seeding complete!")
}

seedContacts()
