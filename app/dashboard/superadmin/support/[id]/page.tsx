import Link from "next/link"
import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { getTicketThreadAction } from "@/app/actions/superadmin/support-console"
import { SupportReplyBox } from "./reply-box"

export const dynamic = "force-dynamic"

export default async function SuperadminTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformCapability("support")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: platform support only</div>

  const { id } = await params
  const res = await getTicketThreadAction(id)
  if (!res.ok) return <div className="p-6 text-red-600">Failed: {res.error}</div>
  const t = res.thread

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <Link href="/dashboard/superadmin/support" className="text-sm text-indigo-600">← All tickets</Link>
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-xl font-bold">{t.subject ?? "(no subject)"}</h1>
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{t.status.replace("_", " ")}</span>
          {t.priority && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{t.priority}</span>}
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {t.brokerageName ?? "Unknown tenant"}{t.requesterName ? ` · ${t.requesterName}` : ""}{t.category ? ` · ${t.category}` : ""}
        </p>
      </div>

      {/* Original request */}
      {t.description && (
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="text-xs font-medium text-muted-foreground mb-1">Original request</p>
          <p className="text-sm whitespace-pre-wrap">{t.description}</p>
        </div>
      )}

      {/* Thread */}
      <div className="space-y-3">
        {t.messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No replies yet — be the first to respond.</p>
        ) : t.messages.map((m) => (
          <div key={m.id} className={"rounded-lg border p-3 " + (m.authorKind === "staff" ? "bg-indigo-50/60 border-indigo-200 ml-6" : "bg-white mr-6")}>
            <p className="text-[11px] font-medium text-muted-foreground mb-1">{m.authorKind === "staff" ? "Support" : t.requesterName ?? "Tenant"} · {new Date(m.createdAt).toLocaleString()}</p>
            <p className="text-sm whitespace-pre-wrap">{m.body}</p>
          </div>
        ))}
      </div>

      <SupportReplyBox ticketId={t.id} status={t.status} />
    </div>
  )
}
