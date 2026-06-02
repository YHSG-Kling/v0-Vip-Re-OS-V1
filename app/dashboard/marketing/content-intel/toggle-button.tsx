"use client"

import { useTransition } from "react"
import { toggleContentSource } from "@/app/actions/content-intel/sources"

export function ToggleButton({ id, isActive }: { id: string; isActive: boolean }) {
  const [pending, startTransition] = useTransition()
  return (
    <button
      onClick={() => startTransition(async () => { await toggleContentSource(id, !isActive) })}
      disabled={pending}
      className="text-xs px-2 py-1 border rounded hover:bg-gray-100 disabled:opacity-50"
    >
      {isActive ? "Pause" : "Resume"}
    </button>
  )
}
