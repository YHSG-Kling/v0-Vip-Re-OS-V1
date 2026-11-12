"use client"

// GLOBAL error boundary — the one place a throw in the ROOT LAYOUT itself lands (wave 149Z, lane 149J Outside-lane K,
// 143H-SO-03 / OL-07). app/error.tsx (the survivor for the copy and the retry shape) catches every segment BELOW the root
// layout, but an error in app/layout.tsx replaces the whole document, so Next renders this file instead — with its own
// <html> and <body>, because the layout that would have provided them is the thing that failed. Plain markup only: no
// providers, no design-system imports (they live in the layout that just threw). It never bounces to /login, and it shows
// the digest (Next's server-side error id, safe to show) so support can find the log line — never the message or stack.

import { useEffect } from "react"

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[GlobalError] root layout failed:", error)
  }, [error])

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#ffffff", color: "#0f172a" }}>
        <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}>
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>Something went wrong</h1>
            <p style={{ fontSize: 14, color: "#475569", margin: "0 0 16px" }}>
              The page could not load. Try again, and if it keeps happening, contact support
              {error.digest ? <> with reference <code>{error.digest}</code></> : null}.
            </p>
            <button
              type="button"
              onClick={() => reset()}
              style={{ fontSize: 14, padding: "8px 16px", borderRadius: 6, border: "1px solid #cbd5e1", background: "#0f172a", color: "#ffffff", cursor: "pointer" }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  )
}
