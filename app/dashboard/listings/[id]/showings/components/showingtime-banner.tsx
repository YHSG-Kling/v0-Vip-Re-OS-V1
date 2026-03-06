import { Badge } from "@/components/ui/badge"
import { CheckCircle2 } from "lucide-react"

export default function ShowingTimeBanner() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
      <div className="flex flex-1 items-center gap-2">
        <span className="text-sm font-medium text-foreground">Powered by ShowingTime</span>
        <Badge variant="secondary" className="text-xs">Connected</Badge>
      </div>
      <span className="text-xs text-muted-foreground">Syncing automatically</span>
    </div>
  )
}
