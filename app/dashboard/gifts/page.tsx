/**
 * app/dashboard/gifts/page.tsx — THE GIFT STUDIO. The AI knows the
 * customer AND the deal: recent ungifted closings queue on the left,
 * deal-personalized gift selections (engraving line already written from
 * the closed home's address) order in-window on the right. One command
 * center — the buy click is the only external hop.
 */
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getGiftStudioAction } from "@/app/actions/gift-studio"
import { GiftStudioClient } from "./gift-studio-client"

export const dynamic = "force-dynamic"

export default async function GiftStudioPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const studio = await getGiftStudioAction()
  if (!studio.ok) redirect("/dashboard")

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Gift Studio</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        The team already knows the client, the home, and the closing date — every pick arrives personalized. Nothing ships without you.
      </p>
      <div className="mt-6">
        <GiftStudioClient
          initialClosings={studio.closings}
          initialSelections={studio.selections}
          initialSelectedId={studio.selectedContactId}
        />
      </div>
    </div>
  )
}
