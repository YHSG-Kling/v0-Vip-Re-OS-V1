// TOMBSTONE (wave 155, lane 155R20; CLAUDE.md §1 case 1 — a DUPLICATE). markAllRead and markOneRead DELETED → survivors
// app/actions/notifications.ts:115 markAllRead and app/actions/notifications.ts:84 markNotificationRead.
// This "use server" module published both as public doors that re-implemented the survivors on the cookie client WITHOUT the
// act-as write seam (a read_only impersonation grant was not refused) and with a zero-row mark reading as success. Their one
// caller, app/notifications/page.tsx, now calls the survivors; the survivors already held everything these had, so nothing was
// merged. The kernel helpers they wrapped (lib/kernel/notification-center.ts markNotificationRead / markAllNotificationsRead)
// are retired with them.
export {}
