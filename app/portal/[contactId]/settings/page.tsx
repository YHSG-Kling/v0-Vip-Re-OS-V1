import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import PortalSettingsPage from "@/components/portal/PortalSettingsPage"
// LANGUAGE_OPTIONS is PURE data (§6 — the ONE vocabulary, derived from
// LOCALE_TO_ELEVENLABS_LANGUAGE) — resolved server-side and passed down as a
// prop so the "use client" settings page never imports multilingual-reel.ts
// (and its schema-cache import) into the browser bundle directly.
import { LANGUAGE_OPTIONS } from "@/lib/video/multilingual-reel"

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

  return <PortalSettingsPage contact={contact} contactId={contactId} languageOptions={LANGUAGE_OPTIONS as { code: string; name: string }[]} />
}
