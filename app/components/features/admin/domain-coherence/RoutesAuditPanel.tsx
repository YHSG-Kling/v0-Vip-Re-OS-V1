'use client'

import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { RouteEntry, RouteClassification } from '@/lib/kernel/routes'

interface Props {
  routes: RouteEntry[]
}

const CLASSIFICATION_BADGE: Record<RouteClassification, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  canonical:        { label: 'Canonical',  variant: 'default' },
  redirect_to:      { label: 'Redirect',   variant: 'secondary' },
  remove:           { label: 'Remove',     variant: 'destructive' },
  supporting_child: { label: 'Child',      variant: 'outline' },
}

const ACCESS_BADGE_COLOR: Record<string, string> = {
  public:        'bg-muted text-muted-foreground',
  authenticated: 'bg-blue-100 text-blue-800',
  agent:         'bg-green-100 text-green-800',
  broker:        'bg-amber-100 text-amber-800',
  superadmin:    'bg-red-100 text-red-800',
}

export function RoutesAuditPanel({ routes }: Props) {
  const byDomain: Record<string, number> = {}
  for (const r of routes) {
    byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {Object.entries(byDomain).map(([domain, count]) => (
          <span key={domain} className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            {domain}
            <span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] font-semibold">{count}</span>
          </span>
        ))}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Path</TableHead>
              <TableHead>Domain</TableHead>
              <TableHead>Classification</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Kernel Owner</TableHead>
              <TableHead>Verified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {routes.map((r) => {
              const badge = CLASSIFICATION_BADGE[r.classification]
              return (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.path}</TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">{r.domain}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${ACCESS_BADGE_COLOR[r.accessLevel] ?? ''}`}>
                      {r.accessLevel}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.kernelOwner}</TableCell>
                  <TableCell>
                    {r.verified
                      ? <span className="text-xs text-green-600 font-medium">Yes</span>
                      : <span className="text-xs text-amber-600 font-medium">No</span>
                    }
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
