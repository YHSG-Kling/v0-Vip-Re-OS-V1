import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Home, Megaphone, Video, Users, Handshake, Sparkles } from "lucide-react"

// "Your AI Team" — surfaces the named managers working the seller's listing, with what each actually
// did (grounded by buildSellerTeamActivity). Pure display; renders nothing if the team list is empty.

interface TeamMember {
  manager?: string
  role?: string
  did?: string
  icon?: "home" | "megaphone" | "video" | "users" | "handshake"
}

interface TimelineLine {
  when: string
  manager: string
  line: string
}

const ICONS: Record<string, React.ReactNode> = {
  home: <Home className="h-4 w-4 text-emerald-600" />,
  megaphone: <Megaphone className="h-4 w-4 text-blue-600" />,
  video: <Video className="h-4 w-4 text-purple-600" />,
  users: <Users className="h-4 w-4 text-amber-600" />,
  handshake: <Handshake className="h-4 w-4 text-rose-600" />,
}

export function SellerTeamActivityCard({ team, timeline = [] }: { team: TeamMember[] | null; timeline?: TimelineLine[] }) {
  if (!team || team.length === 0) return null
  return (
    <Card className="shadow-lg border-0">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-emerald-600" />
          Your AI Team
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          A full team is working your sale — here's who's on it and what they're doing right now.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {team.map((m, i) => (
          <div key={`${m.manager}-${i}`} className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0 h-8 w-8 rounded-full bg-muted/50 border flex items-center justify-center">
              {ICONS[m.icon ?? "home"] ?? <Home className="h-4 w-4" />}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground leading-tight">
                {m.manager}
                {m.role && <span className="text-xs font-normal text-muted-foreground"> · {m.role}</span>}
              </p>
              {m.did && <p className="text-xs text-muted-foreground leading-snug mt-0.5">{m.did}</p>}
            </div>
          </div>
        ))}

        {/* This-week timeline — whitelist-narrated manager handoffs (client-safe
            copy is fixed in lib/listings/seller-team-activity.ts, never raw bus text). */}
        {timeline.length > 0 && (
          <div className="border-t pt-3 space-y-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recently, on your home</p>
            {timeline.map((t, i) => (
              <p key={i} className="text-xs text-muted-foreground leading-snug">
                <span className="font-medium text-foreground">{t.manager}</span> {t.line}
                <span className="text-[10px]"> · {new Date(t.when).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
