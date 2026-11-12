import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import PortalSettingsPage from "@/components/portal/PortalSettingsPage"
// LANGUAGE_OPTIONS is PURE data (§6 — the ONE vocabulary, derived from
// LOCALE_TO_ELEVENLABS_LANGUAGE) — resolved server-side and passed down as a
// prop so the "use client" settings page never imports multilingual-reel.ts
// (and its schema-cache import) into the browser bundle directly.
import { LANGUAGE_OPTIONS } from "@/lib/video/multilingual-reel"
// Accessibility preferences (wave 145, owner ruling 18) — the options and the person's current choices are resolved
// HERE and passed down, for the same reason: the client form never retypes the vocabulary.
import { accessibilityPreferenceOptions, readAccessibilityPreferences } from "@/lib/contacts/accessibility-preferences"

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  const { data: contact, error } = await supabase.from("contacts").select("*").eq("id", contactId).single()

  if (error || !contact) {
    redirect("/")
  }

  // THE reader (contract C3) on the SESSION client (RLS) pinned to the contact's own brokerage. A refused read is shown
  // on the form, never rendered as "nothing stated".
  const accessibility = await readAccessibilityPreferences(supabase, contact.brokerage_id as string, contactId)

  return (
    <PortalSettingsPage
      contact={contact}
      contactId={contactId}
      languageOptions={LANGUAGE_OPTIONS as { code: string; name: string }[]}
      accessibility={{
        initial: accessibility.ok ? accessibility.preferences : {},
        options: accessibilityPreferenceOptions(),
        unavailable: accessibility.ok ? null : accessibility.notApplied
          ? "Accessibility preferences will be available shortly."
          : "Your accessibility preferences could not be loaded right now — please try again later.",
      }}
    />
  )
}
