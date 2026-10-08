"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { revertPolicy } from "@/app/actions/admin/tenant-policy"

/** Revert one policy to an earlier version — the server writes a NEW version (wave 101, m696). */
export function RevertPolicyButton({ policyKey, version }: { policyKey: string; version: number }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const router = useRouter()
  return (
    <div className="text-right">
      <button
        type="button"
        disabled={pending}
        className="rounded border px-2 py-1 text-xs disabled:opacity-50"
        onClick={() => start(async () => {
          const r = await revertPolicy(policyKey, version)
          if (!r.ok) setMsg(r.error)
          else setMsg(r.unchanged ? "Already at that value — no new version." : `Reverted — now v${r.newVersion ?? "?"}.`)
          router.refresh()
        })}
      >
        {pending ? "Reverting…" : `Revert to v${version}`}
      </button>
      {msg && <div className="mt-1 text-xs">{msg}</div>}
    </div>
  )
}
