// app/components/status/status-badge.tsx
// ─────────────────────────────────────────────────────────────────────────────
// "If a status is offered the UI has to show it" (owner ruling 14, wave 148 lane 148I). One badge for every registered
// status vocabulary (lib/kernel/status-override.ts STATUS_ENTITIES): the label comes from the registry's typed label map,
// so a value the database admits can never render as blank, as another value, or collapse into a neighbour. An
// unregistered value is shown as itself — never hidden.

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { statusLabel, type StatusEntity } from "@/lib/kernel/status-override"

export function StatusBadge({ entity, value, className }: { entity: StatusEntity; value: string | null | undefined; className?: string }) {
  return (
    <Badge variant="outline" className={cn("text-xs", className)} data-status-entity={entity} data-status-value={value ?? ""}>
      {statusLabel(entity, value)}
    </Badge>
  )
}
