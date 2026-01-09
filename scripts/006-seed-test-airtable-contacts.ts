// This script demonstrates the contact structure in Airtable
// Note: Run this if you have Airtable API configured; otherwise, manually create records

import { airtableService } from "../services/airtable"

async function seedTestContacts() {
  const testContacts = [
    {
      first_name: "John",
      last_name: "Buyer",
      email: "john.buyer@test.com",
      phone: "512-555-0101",
      contact_type: "buyer",
      contact_persona: "first_time_buyer",
      source: "zillow",
      timeline: "0-30_days",
      status: "active",
      location: "Austin, TX 78704",
      notes: "Interested in homes under $500k. First time homebuyer. Pre-approved for $450k.",
      agent_email: "agent1@nexus.com",
      has_login: false,
      created_at: new Date().toISOString(),
    },
    {
      first_name: "Jane",
      last_name: "Investor",
      email: "jane.investor@test.com",
      phone: "512-555-0102",
      contact_type: "investor",
      contact_persona: "investor",
      source: "referral",
      timeline: "ongoing",
      status: "qualified",
      location: "Austin, TX 78745",
      notes: "Looking for 2-3 rental properties. Cash buyer. Interested in multi-unit properties.",
      agent_email: "agent1@nexus.com",
      has_login: false,
      created_at: new Date().toISOString(),
      buyer_prequalification: "cash",
      investment_strategy: "long_term_rental",
    },
    {
      first_name: "Robert",
      last_name: "Seller",
      email: "robert.seller@test.com",
      phone: "512-555-0103",
      contact_type: "seller",
      contact_persona: "motivated_seller",
      source: "expired_listing",
      timeline: "30-60_days",
      status: "active",
      location: "Austin, TX 78723",
      notes: "Expired listing. Motivated to sell. Property has some deferred maintenance. Open to discussion.",
      agent_email: "agent2@nexus.com",
      has_login: false,
      created_at: new Date().toISOString(),
      property_address: "123 Main St, Austin TX 78723",
      property_bedrooms: 3,
      property_bathrooms: 2,
      property_sqft: 1850,
      selling_reason: "relocation",
    },
    {
      first_name: "Amanda",
      last_name: "Relocating",
      email: "amanda.relocate@test.com",
      phone: "512-555-0104",
      contact_type: "buyer",
      contact_persona: "relocating",
      source: "google_ads",
      timeline: "60-90_days",
      status: "active",
      location: "Austin, TX 78702",
      notes: "Relocating to Austin from California for job. Needs to sell current home first. Timeline flexible.",
      agent_email: "agent1@nexus.com",
      has_login: false,
      created_at: new Date().toISOString(),
      relocation_company: "TechCorp Inc",
      job_start_date: "2025-03-01",
      current_location: "San Francisco, CA",
    },
    {
      first_name: "Michael",
      last_name: "Luxury",
      email: "michael.luxury@test.com",
      phone: "512-555-0105",
      contact_type: "buyer",
      contact_persona: "luxury_buyer",
      source: "luxury_network",
      timeline: "ongoing",
      status: "hot_lead",
      location: "Austin, TX 78734",
      notes: "High-net-worth individual. Looking for luxury properties in West Lake Hills. Amenities important.",
      agent_email: "agent2@nexus.com",
      has_login: false,
      created_at: new Date().toISOString(),
      buyer_prequalification: "cash",
      buyer_budget_min: 2000000,
      buyer_budget_max: 5000000,
      luxury_preferences: "smart_home, wine_cellar, pool",
    },
    {
      first_name: "Sarah",
      last_name: "FSBO",
      email: "sarah.fsbo@test.com",
      phone: "512-555-0106",
      contact_type: "seller",
      contact_persona: "fsbo",
      source: "social_media",
      timeline: "30-60_days",
      status: "active",
      location: "Austin, TX 78756",
      notes: "Currently selling FSBO. Not getting showings. Interested in agent representation discussion.",
      agent_email: "agent1@nexus.com",
      has_login: false,
      created_at: new Date().toISOString(),
      property_address: "456 Oak Ave, Austin TX 78756",
      property_bedrooms: 4,
      property_bathrooms: 3,
      property_sqft: 2400,
      fsbo_duration_weeks: 8,
    },
  ]

  for (const contact of testContacts) {
    try {
      const result = await airtableService.createRecord("Leads", contact)
      console.log(`Created contact: ${contact.first_name} ${contact.last_name}`, result?.id || "Mock ID")
    } catch (error) {
      console.error(`Failed to create contact ${contact.first_name} ${contact.last_name}:`, error)
    }
  }
}

// Run if this is the main module
if (require.main === module) {
  seedTestContacts().then(() => {
    console.log("Test contact seeding complete")
    process.exit(0)
  })
}

export default seedTestContacts
