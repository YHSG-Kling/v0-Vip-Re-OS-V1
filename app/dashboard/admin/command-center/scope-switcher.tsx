"use client"

// Scope switcher — lets a brokerage-wide viewer (broker / broker_admin / admin / superadmin) drill the
// Command Center down to one office, team, or agent and back. The egress scope plumbing already filters
// the data server-side; this just drives the ?view= param the page reads. A narrower viewer (a location
// admin, team lead, or agent) sees only the static scope label (no switcher) — they can't widen scope.

import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { useTransition } from "react"

export interface ScopeOption {
  /** "all" | "location:<id>" | "team:<id>" | "agent:<userId>" */
  value: string
  label: string
}

export function ScopeSwitcher({
  label,
  canSwitch,
  options,
  current,
}: {
  label: string
  canSwitch: boolean
  options: ScopeOption[]
  current: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [isPending, startTransition] = useTransition()

  function onChange(value: string) {
    const next = new URLSearchParams(Array.from(params.entries()))
    if (value === "all") next.delete("view")
    else next.set("view", value)
    startTransition(() => router.push(`${pathname}${next.toString() ? `?${next}` : ""}`))
  }

  if (!canSwitch) {
    return (
      <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
        {label}
      </span>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Viewing</span>
      <select
        aria-label="Command Center scope"
        className="rounded-md border bg-background px-2 py-1 text-sm"
        value={current}
        disabled={isPending}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}
