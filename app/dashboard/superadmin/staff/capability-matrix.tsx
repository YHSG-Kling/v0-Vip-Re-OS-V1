'use client'

// Capability matrix editor — roles × capabilities. Each cell is a TRI-STATE
// against the PURE code map (the DEFAULT, shown faintly): default / granted /
// revoked, plus a read/write toggle when an override grants access. Changes go
// through setCapabilityOverrideAction (superadmin-only, audited, before/after);
// choosing "default" DELETES the override row. superadmin has no column — it is
// '*' and never overridable.

import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Grid3x3, Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import {
  PLATFORM_CAPABILITIES, OVERRIDABLE_PLATFORM_ROLES, platformStaffCan,
  type CapabilityOverride, type PlatformCapability, type OverridablePlatformRole,
} from '@/lib/platform/platform-staff-roster'
import { setCapabilityOverrideAction, listCapabilityOverridesAction } from '@/app/actions/superadmin/platform-staff'

type CellState = 'default' | 'granted' | 'revoked'

function cellState(o: CapabilityOverride | undefined): CellState {
  if (!o) return 'default'
  return o.allowed ? 'granted' : 'revoked'
}

export function CapabilityMatrix({ initialOverrides }: { initialOverrides: CapabilityOverride[] }) {
  const [overrides, setOverrides] = useState<CapabilityOverride[]>(initialOverrides)
  const [pendingCell, setPendingCell] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const { toast } = useToast()

  const find = (role: string, cap: string) => overrides.find((o) => o.role === role && o.capability === cap)

  function apply(role: OverridablePlatformRole, capability: PlatformCapability, override: { allowed: boolean; access: 'read' | 'write' } | null) {
    const key = `${role}:${capability}`
    setPendingCell(key)
    startTransition(async () => {
      const r = await setCapabilityOverrideAction({ role, capability, override })
      if (!r.ok) toast({ title: 'Error', description: r.error, variant: 'destructive' })
      const list = await listCapabilityOverridesAction()
      if (list.ok) setOverrides(list.overrides)
      setPendingCell(null)
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2"><Grid3x3 className="h-4 w-4" />Capability matrix</CardTitle>
        <p className="text-xs text-muted-foreground font-normal">
          The code map is the default (shown faintly). Grant, revoke, or downgrade write→read per role — every change is
          audited. Choosing “default” deletes the override. superadmin is never overridable, so it has no column.
        </p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/10 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2">Capability</th>
              {OVERRIDABLE_PLATFORM_ROLES.map((r) => <th key={r} className="px-3 py-2 capitalize">{r}</th>)}
            </tr>
          </thead>
          <tbody>
            {PLATFORM_CAPABILITIES.map((cap) => (
              <tr key={cap} className="border-b last:border-0">
                <td className="px-4 py-2 font-mono text-xs">{cap}</td>
                {OVERRIDABLE_PLATFORM_ROLES.map((role) => {
                  const defaultAllowed = platformStaffCan(role, cap)
                  const o = find(role, cap)
                  const state = cellState(o)
                  const key = `${role}:${cap}`
                  const busy = pendingCell === key
                  return (
                    <td key={role} className="px-3 py-1.5 align-middle">
                      <div className="flex items-center gap-1.5">
                        <select
                          className={'rounded border p-1 text-xs ' + (state === 'default' ? 'text-muted-foreground' : state === 'granted' ? 'text-emerald-700 border-emerald-300' : 'text-red-700 border-red-300')}
                          value={state}
                          disabled={busy}
                          onChange={(e) => {
                            const next = e.target.value as CellState
                            if (next === 'default') apply(role, cap, null)
                            else if (next === 'granted') apply(role, cap, { allowed: true, access: o?.allowed ? o.access : 'write' })
                            else apply(role, cap, { allowed: false, access: 'write' })
                          }}
                        >
                          <option value="default">{defaultAllowed ? 'default (✓ write)' : 'default (—)'}</option>
                          <option value="granted">granted</option>
                          <option value="revoked">revoked</option>
                        </select>
                        {state === 'granted' && (
                          <select
                            className="rounded border p-1 text-xs"
                            value={o?.access ?? 'write'}
                            disabled={busy}
                            title="Access level for this grant"
                            onChange={(e) => apply(role, cap, { allowed: true, access: e.target.value as 'read' | 'write' })}
                          >
                            <option value="write">write</option>
                            <option value="read">read</option>
                          </select>
                        )}
                        {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                      </div>
                      {/* The code-map default, faint, so the superadmin sees what an override overrides */}
                      <div className="mt-0.5 text-[10px] text-muted-foreground/60">code map: {defaultAllowed ? '✓ write' : 'no access'}</div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}
