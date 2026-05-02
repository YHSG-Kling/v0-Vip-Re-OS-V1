import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

/**
 * Public, embeddable podcast player.
 * Returns an HTML page (not JSON) so it can be loaded inside an <iframe>.
 *
 * Query params:
 *   - episodeId: string  (renders that specific episode)
 *   - agentId:   string  (renders the latest published episode for that agent)
 *   - theme:     "light" | "dark"
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const episodeId = url.searchParams.get("episodeId")
  const agentId = url.searchParams.get("agentId")
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light"

  if (!episodeId && !agentId) {
    return NextResponse.json({ error: "episodeId or agentId required" }, { status: 400 })
  }

  const supabase = createServiceClient()

  let row: any = null
  if (episodeId) {
    const { data } = await supabase
      .from("podcast_episodes")
      .select("id, title, audio_url, status, agent_id")
      .eq("id", episodeId)
      .maybeSingle()
    row = data
  } else if (agentId) {
    const { data } = await supabase
      .from("podcast_episodes")
      .select("id, title, audio_url, status, agent_id")
      .eq("agent_id", agentId)
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    row = data
  }

  if (!row || !row.audio_url) {
    return new NextResponse(playerNotFoundHtml(theme), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  }

  return new NextResponse(playerHtml({ title: row.title, audioUrl: row.audio_url, theme }), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Frame-Options": "ALLOWALL",
      "Content-Security-Policy": "frame-ancestors *",
    },
  })
}

function playerHtml(params: { title: string; audioUrl: string; theme: "light" | "dark" }) {
  const bg = params.theme === "dark" ? "#0b1220" : "#ffffff"
  const fg = params.theme === "dark" ? "#e5e7eb" : "#0b1220"
  const sub = params.theme === "dark" ? "#9ca3af" : "#6b7280"
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(params.title)}</title>
<style>
  html, body { margin: 0; padding: 0; background: ${bg}; color: ${fg}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { padding: 14px 18px; display: flex; flex-direction: column; gap: 8px; }
  .title { font-size: 14px; font-weight: 600; line-height: 1.3; }
  .sub { font-size: 11px; color: ${sub}; }
  audio { width: 100%; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="title">${escapeHtml(params.title)}</div>
    <audio controls preload="metadata" src="${escapeAttr(params.audioUrl)}"></audio>
    <div class="sub">Podcast player</div>
  </div>
</body>
</html>`
}

function playerNotFoundHtml(theme: "light" | "dark") {
  const bg = theme === "dark" ? "#0b1220" : "#ffffff"
  const fg = theme === "dark" ? "#e5e7eb" : "#0b1220"
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Podcast not available</title>
<style>
  html, body { margin: 0; padding: 0; background: ${bg}; color: ${fg}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { padding: 18px; font-size: 13px; }
</style>
</head>
<body>
  <div class="wrap">No published episode is available yet.</div>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;")
}
