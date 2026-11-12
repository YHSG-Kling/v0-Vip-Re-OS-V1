// app/dashboard/transactions/[id]/notification-delivery-section.tsx
//
// CLIENT NOTIFICATION DELIVERY — reads `notification_log` for this transaction
// (readerless-write-census: delivery_channel/status/response were written on
// every send attempt by lib/transactions/notification-service.ts::logNotification
// and never read anywhere). Server component: fetches its own data, tenant-
// scoped to the caller's brokerage, explicit columns only (§4).
//
// The autonomous half of this same reconciliation is the deal_coordinator cron
// (app/api/cron/notification-delivery-escalation/route.ts), which escalates a
// channel that keeps failing for this deal to the agent; this section is the
// human-visible half — what was sent, on which channel, and whether it landed.

import { NotificationService } from "@/lib/transactions/notification-service"

const STATUS_STYLE: Record<string, string> = {
  sent:   "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-red-50 text-red-800 border-red-200",
}

export async function NotificationDeliverySection({
  transactionId,
  brokerageId,
}: {
  transactionId: string
  brokerageId: string
}) {
  const rows = await new NotificationService().getDeliveryLogForTransaction(transactionId, brokerageId)
  if (rows.length === 0) return null

  const failedCount = rows.filter((r) => r.status === "failed").length

  return (
    <section className="border-b bg-background px-4 py-3 sm:px-6" data-testid="notification-delivery-log">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Client Notification Delivery</h2>
        {failedCount > 0 && (
          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-red-50 text-red-800 border-red-200">
            {failedCount} failed
          </span>
        )}
      </div>
      <div className="mt-2 space-y-1">
        {rows.slice(0, 10).map((r) => (
          <div key={r.id} className="flex items-center gap-2 text-xs">
            <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] ${STATUS_STYLE[r.status] ?? "bg-muted text-muted-foreground"}`}>
              {r.status}
            </span>
            <span className="font-medium">{r.delivery_channel}</span>
            <span className="text-muted-foreground truncate">
              {(r.response as Record<string, any> | null)?.title ?? (r.response as Record<string, any> | null)?.event_type ?? ""}
            </span>
            <span className="text-muted-foreground ml-auto shrink-0">
              {new Date(r.created_at).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
