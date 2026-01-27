"use server"

import { createClient } from "@/lib/supabase/server"

// Lookup demo contact ID by persona type
export async function getDemoContactByPersona(
  persona: string,
): Promise<{ contactId: string | null; error: string | null }> {
  try {
    const supabase = await createClient()

    // First try to get from demo_persona_contacts lookup table
    const { data: lookupData } = await supabase
      .from("demo_persona_contacts")
      .select("contact_id")
      .eq("persona", persona)
      .maybeSingle()

    if (lookupData?.contact_id) {
      return { contactId: lookupData.contact_id, error: null }
    }

    // Fallback: Query contacts table directly by contact_persona
    const { data: contactData } = await supabase
      .from("contacts")
      .select("id")
      .eq("contact_persona", persona)
      .eq("source", "demo")
      .limit(1)
      .maybeSingle()

    if (contactData?.id) {
      return { contactId: contactData.id, error: null }
    }

    // Second fallback: Try without source filter (in case demo contacts don't have source='demo')
    const { data: anyContactData } = await supabase
      .from("contacts")
      .select("id")
      .eq("contact_persona", persona)
      .limit(1)
      .maybeSingle()

    if (anyContactData?.id) {
      return { contactId: anyContactData.id, error: null }
    }

    // If no demo contact exists, return null (will use legacy dashboard)
    return { contactId: null, error: null }
  } catch (error) {
    console.error("Error looking up demo contact:", error)
    return { contactId: null, error: "Failed to lookup demo contact" }
  }
}

// Get all demo contacts for the personas tab
export async function getAllDemoContacts(): Promise<{
  contacts: Array<{ persona: string; contactId: string; name: string }>
  error: string | null
}> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase.from("demo_persona_contacts").select(`
        persona,
        contact_id,
        contacts (
          first_name,
          last_name
        )
      `)

    if (error) {
      // Fallback to direct contacts query
      const { data: contactsData, error: contactsError } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, contact_persona")
        .eq("source", "demo")

      if (contactsError || !contactsData) {
        return { contacts: [], error: "No demo contacts found" }
      }

      return {
        contacts: contactsData.map((c) => ({
          persona: c.contact_persona || "unknown",
          contactId: c.id,
          name: `${c.first_name} ${c.last_name}`,
        })),
        error: null,
      }
    }

    return {
      contacts: (data || []).map((d) => ({
        persona: d.persona,
        contactId: d.contact_id,
        name: d.contacts ? `${(d.contacts as any).first_name} ${(d.contacts as any).last_name}` : "Demo Contact",
      })),
      error: null,
    }
  } catch (error) {
    console.error("Error fetching demo contacts:", error)
    return { contacts: [], error: "Failed to fetch demo contacts" }
  }
}
