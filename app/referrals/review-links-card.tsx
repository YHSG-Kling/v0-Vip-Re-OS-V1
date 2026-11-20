"use client"

// Wave 143 (lane 143E) — WHERE a review request points, and whether the agent approves each one.
// brokerage_settings.settings.reputation_profiles is read by the ONE review-ask engine
// (lib/reputation/review-ask.ts): a request is sent only with a REAL, platform-hosted review link
// (a placeholder, a non-https URL or another site's host is refused at save AND at read), on the first
// platform in the tenant's order that has one. No link = no request is sent and the broker is told
// once — this card is where that alert points. Tenant admins only: /referrals renders it only when
// getReputationProfilesAction passed its gate, and the save re-runs that gate server-side.
import { useState, useTransition } from "react"
import { Check, Link2, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { saveReputationProfilesAction } from "@/app/actions/settings/brokerage-column-settings"

const PLATFORMS = [
  { key: "google", label: "Google Business profile review link" },
  { key: "zillow", label: "Zillow reviews link" },
  { key: "realtor_com", label: "Realtor.com reviews link" },
  { key: "facebook", label: "Facebook reviews link" },
  { key: "yelp", label: "Yelp review link" },
] as const

export interface ReviewLinksInitial {
  canEdit: boolean
  /** The validated brokerage-wide links, by platform. */
  links: Partial<Record<(typeof PLATFORMS)[number]["key"], string>>
  approval: "auto" | "agent_approves"
  /** What the reader refused (placeholder text, wrong host …) — shown, never hidden. */
  rejected: Array<{ where: string; reason: string }>
}

export function ReviewLinksCard({ initial }: { initial: ReviewLinksInitial }) {
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(PLATFORMS.map((p) => [p.key, initial.links[p.key] ?? ""])))
  const [approval, setApproval] = useState(initial.approval)
  const [pending, startTransition] = useTransition()

  const save = () =>
    startTransition(async () => {
      const profiles: Record<string, unknown> = { approval }
      for (const p of PLATFORMS) if (draft[p.key]?.trim()) profiles[p.key] = { url: draft[p.key].trim() }
      const r = await saveReputationProfilesAction(profiles)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      toast.success("Review links saved — the next closing's request will use them")
    })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Link2 className="h-4 w-4 text-primary" />
          Where review requests point
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Paste the real review link for each site you use. A request goes out only when a real link is set — the first site
          listed here that has one is used, and each client is asked once per closing.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {PLATFORMS.map((p) => (
          <div key={p.key} className="space-y-1">
            <Label htmlFor={`review-link-${p.key}`} className="text-xs">{p.label}</Label>
            <Input
              id={`review-link-${p.key}`}
              className="h-8 text-xs"
              type="url"
              inputMode="url"
              placeholder="https://…"
              value={draft[p.key] ?? ""}
              disabled={!initial.canEdit || pending}
              onChange={(e) => setDraft((d) => ({ ...d, [p.key]: e.target.value }))}
            />
          </div>
        ))}
        <div className="space-y-1">
          <Label htmlFor="review-approval" className="text-xs">Who sends each request</Label>
          <select
            id="review-approval"
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            value={approval}
            disabled={!initial.canEdit || pending}
            onChange={(e) => setApproval(e.target.value === "agent_approves" ? "agent_approves" : "auto")}
          >
            <option value="auto">Send automatically after the closing delay</option>
            <option value="agent_approves">Hold a draft for the agent to approve</option>
          </select>
        </div>
        {initial.rejected.length > 0 && (
          <p className="text-xs text-destructive">
            Not usable as saved: {initial.rejected.map((r) => `${r.where.replace("reputation_profiles.", "")} (${r.reason})`).join("; ")}.
          </p>
        )}
        <Button size="sm" disabled={!initial.canEdit || pending} onClick={save}>
          {pending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
          Save links
        </Button>
        {!initial.canEdit && (
          <p className="text-xs text-muted-foreground">Read-only access — switch to full access to change this.</p>
        )}
      </CardContent>
    </Card>
  )
}
