import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listNotifications, countUnreadNotifications } from "@/lib/kernel"
import { markOneRead, markAllRead } from "@/app/actions/notification-actions"

const PAGE_SIZE = 20

interface PageProps {
  searchParams: Promise<{ tab?: string; page?: string }>
}

export default async function NotificationsPage({ searchParams }: PageProps) {
  const params = await searchParams
  const tab = params.tab === "unread" ? "unread" : "all"
  const page = Math.max(1, parseInt(params.page ?? "1", 10))
  const offset = (page - 1) * PAGE_SIZE

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.id) {
    redirect("/login")
  }

  const [{ rows }, unreadCount] = await Promise.all([
    listNotifications({
      userId: user.id,
      limit: PAGE_SIZE,
      offset,
      unreadOnly: tab === "unread",
    }),
    countUnreadNotifications({ userId: user.id }),
  ])

  const hasNextPage = rows.length === PAGE_SIZE
  const hasPrevPage = page > 1

  function buildHref(newTab: string, newPage: number) {
    const p = new URLSearchParams()
    if (newTab === "unread") p.set("tab", "unread")
    if (newPage > 1) p.set("page", String(newPage))
    const qs = p.toString()
    return `/notifications${qs ? `?${qs}` : ""}`
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-8 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-foreground">Notifications</h1>
          {unreadCount > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium px-2 py-0.5 min-w-[1.5rem]">
              {unreadCount}
            </span>
          )}
        </div>

        {unreadCount > 0 && (
          <form action={markAllRead}>
            <button
              type="submit"
              className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors"
            >
              Mark all as read
            </button>
          </form>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border">
        <a
          href={buildHref("all", 1)}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "all"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          All
        </a>
        <a
          href={buildHref("unread", 1)}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "unread"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Unread
          {unreadCount > 0 && (
            <span className="ml-1.5 text-xs text-muted-foreground">({unreadCount})</span>
          )}
        </a>
      </div>

      {/* List */}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-16">
          {tab === "unread" ? "No unread notifications." : "No notifications yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((n) => (
            <li
              key={n.id}
              className={`flex items-start justify-between gap-4 rounded-lg border px-4 py-3 transition-colors ${
                n.is_read
                  ? "border-border bg-background"
                  : "border-border bg-muted/40"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  {!n.is_read && (
                    <span className="shrink-0 w-2 h-2 rounded-full bg-primary" aria-label="Unread" />
                  )}
                  <span className="text-sm font-medium text-foreground leading-snug">
                    {n.title}
                  </span>
                </div>
                {n.body && (
                  <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2 pl-4">
                    {n.body}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-1 pl-4">
                  {new Date(n.created_at).toLocaleString()}
                </p>
              </div>

              {!n.is_read && (
                <form
                  action={async () => {
                    "use server"
                    await markOneRead(n.id)
                  }}
                  className="shrink-0"
                >
                  <button
                    type="submit"
                    className="text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2 py-1 transition-colors hover:bg-muted"
                  >
                    Mark as read
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Pagination */}
      {(hasPrevPage || hasNextPage) && (
        <div className="flex items-center justify-between mt-8">
          {hasPrevPage ? (
            <a
              href={buildHref(tab, page - 1)}
              className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors"
            >
              Previous
            </a>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted-foreground">Page {page}</span>
          {hasNextPage ? (
            <a
              href={buildHref(tab, page + 1)}
              className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors"
            >
              Next
            </a>
          ) : (
            <span />
          )}
        </div>
      )}
    </main>
  )
}
