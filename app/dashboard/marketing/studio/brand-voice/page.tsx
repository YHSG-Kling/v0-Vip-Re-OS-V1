import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { loadBrandVoiceProfileAction } from "@/app/actions/brand-voice"
import { BrandVoiceEditor } from "./brand-voice-editor"

export const dynamic = "force-dynamic"

export default async function BrandVoicePage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")

  const { profile } = await loadBrandVoiceProfileAction()

  return (
    <div className="container max-w-3xl mx-auto py-8 px-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">BrandVoice Profile</h1>
        <p className="text-muted-foreground mt-1">
          Define your communication style. The AI uses this profile to match your tone,
          avoid prohibited terms, and enforce Fair Housing compliance across all generated content.
        </p>
      </div>
      <BrandVoiceEditor initialProfile={profile ?? null} />
    </div>
  )
}
