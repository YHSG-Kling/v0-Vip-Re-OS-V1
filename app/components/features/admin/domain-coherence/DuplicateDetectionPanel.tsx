'use client'

import { Badge } from '@/components/ui/badge'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import type { DuplicateSet } from '@/lib/kernel/routes'

interface Props {
  duplicateSets: DuplicateSet[]
  cleanDomains: string[]
}

export function DuplicateDetectionPanel({ duplicateSets, cleanDomains }: Props) {
  if (duplicateSets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-green-200 bg-green-50 py-12">
        <CheckCircle2 className="h-8 w-8 text-green-600" />
        <p className="text-sm font-medium text-green-700">No duplicate manager surfaces detected.</p>
        <p className="text-xs text-green-600">{cleanDomains.length} domains are clean.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
        <p className="text-sm text-amber-700">
          <span className="font-semibold">{duplicateSets.length}</span> domain{duplicateSets.length > 1 ? 's have' : ' has'} multiple canonical routes. Review and reclassify duplicates.
        </p>
      </div>

      <div className="space-y-3">
        {duplicateSets.map((set) => (
          <div key={set.domain} className="rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <span className="font-medium text-sm capitalize">{set.domain}</span>
              <Badge variant="destructive">{set.duplicates.length + 1} surfaces</Badge>
            </div>
            <div className="divide-y">
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="font-mono text-xs">{set.canonical.path}</span>
                <Badge variant="default">Canonical</Badge>
              </div>
              {set.duplicates.map((dup) => (
                <div key={dup.id} className="flex items-center justify-between px-4 py-2.5 bg-muted/30">
                  <span className="font-mono text-xs text-muted-foreground">{dup.path}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{dup.kernelOwner}</span>
                    <Badge variant="secondary">Duplicate</Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {cleanDomains.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Clean domains ({cleanDomains.length})</p>
          <div className="flex flex-wrap gap-1.5">
            {cleanDomains.map((d) => (
              <span key={d} className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
                <CheckCircle2 className="h-3 w-3" />
                {d}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
