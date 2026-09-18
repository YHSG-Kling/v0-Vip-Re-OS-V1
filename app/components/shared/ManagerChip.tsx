"use client"

import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { agoFloorOrEmpty } from "@/lib/format/dates"

// Same-body census, round 4 (2026-09-09, lane FC). Survivor for the
// byte-identical private `ManagerChip` (+ its `accentFor`/`domainFor`/
// `initials` helpers) in
// app/dashboard/admin/command-center/manager-activity-feed.tsx:61 and
// .../manager-talk-feed.tsx:64 — both built on the canonical MANAGERS
// registry (lib/kernel/manager-registry.ts), so this shared chip stays on
// that single source of truth rather than re-deriving manager identity.
// Its "ago" timestamp reuses `agoFloorOrEmpty` (lib/format/dates.ts) — the
// same private `relTime` ladder both files pasted, consolidated there.

export function accentFor(key: string): string {
  return key in MANAGERS ? MANAGERS[key as ManagerKey].accent : "bg-slate-100 text-slate-700"
}

export function domainFor(key: string): string {
  return key in MANAGERS ? MANAGERS[key as ManagerKey].domain : ""
}

export function initials(label: string): string {
  return label.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
}

/** Re-exported so callers that used the local `relTime` name can import one
 *  symbol from this module instead of two. */
export const relTime = agoFloorOrEmpty

export function ManagerChip({ mkey, label }: { mkey: string; label: string }) {
  return (
    <span
      title={domainFor(mkey)}
      className={`inline-flex items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 text-[11px] font-medium ${accentFor(mkey)}`}
    >
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-white/70 text-[9px] font-bold">
        {initials(label)}
      </span>
      {label}
    </span>
  )
}
