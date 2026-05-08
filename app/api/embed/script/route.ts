/**
 * GET /api/embed/script?id=<publicId>
 *
 * Tiny JS bootstrapper that the customer pastes into their site:
 *
 *   <script src="https://app.vipagentos.com/api/embed/script?id=abc123" defer></script>
 *
 * The script:
 *   1. Reads the embed_widgets row to fetch style + welcome_message
 *   2. Injects a floating bubble button
 *   3. On click, slides in an iframe pointing at /embed/[publicId]
 *   4. Posts visitor_id (cookie/localStorage) so the iframe knows the session
 *
 * Served as application/javascript with permissive CORS — meant to be loaded
 * cross-origin. Cached at the edge for 5 minutes since the script's logic
 * doesn't change per-request (the iframe pulls live config).
 */

import { type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const publicId = request.nextUrl.searchParams.get("id")
  if (!publicId) {
    return new NextResponse("/* missing id */", {
      status: 400,
      headers: { "Content-Type": "application/javascript" },
    })
  }

  const supabase = createServiceClient()
  const { data: widget } = await supabase
    .from("embed_widgets")
    .select("public_id, label, welcome_message, enabled_modes, style, allowed_domains, is_active")
    .eq("public_id", publicId)
    .maybeSingle()

  if (!widget || !widget.is_active) {
    return new NextResponse("/* embed not found or disabled */", {
      status: 404,
      headers: { "Content-Type": "application/javascript" },
    })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const style = widget.style as any

  // Origin enforcement: when allowed_domains is non-empty, the loader checks
  // window.location.origin against the list and bails silently if no match.
  // This protects the brokerage from someone embedding the script on an
  // unapproved site.
  const allowedDomainsJson = JSON.stringify(widget.allowed_domains ?? [])

  const js = `(function(){
  // ─── Origin check ───────────────────────────────────────────────────────
  var ALLOWED = ${allowedDomainsJson};
  if (ALLOWED.length > 0 && ALLOWED.indexOf(window.location.origin) === -1) {
    console.warn("[VipAgent twin] this domain is not authorized for embed " + ${JSON.stringify(publicId)});
    return;
  }
  if (window.__vipagent_twin_loaded__) return;
  window.__vipagent_twin_loaded__ = true;

  // ─── Visitor id (anon, persists per-browser) ────────────────────────────
  var VISITOR_KEY = "vipagent_twin_visitor";
  var visitorId = null;
  try {
    visitorId = window.localStorage.getItem(VISITOR_KEY);
    if (!visitorId) {
      visitorId = ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, function(c){
        return (c ^ (window.crypto.getRandomValues(new Uint8Array(1))[0] & 15) >> (c/4)).toString(16);
      });
      window.localStorage.setItem(VISITOR_KEY, visitorId);
    }
  } catch(e) {
    // localStorage unavailable (private mode, etc) — fall back to per-tab id
    visitorId = "tab-" + Math.random().toString(36).slice(2, 14);
  }

  // ─── Style config ───────────────────────────────────────────────────────
  var bubbleColor = ${JSON.stringify(style?.bubble_color ?? "#0066ff")};
  var textColor   = ${JSON.stringify(style?.text_color   ?? "#ffffff")};
  var position    = ${JSON.stringify(style?.position     ?? "bottom-right")};
  var buttonText  = ${JSON.stringify(style?.button_text  ?? "Chat with me")};
  var label       = ${JSON.stringify(widget.label ?? "Chat")};
  var publicId    = ${JSON.stringify(publicId)};
  var iframeSrc   = ${JSON.stringify(appUrl + "/embed/" + publicId)};

  // ─── Build bubble + iframe ──────────────────────────────────────────────
  var pos = position === "bottom-left"
    ? "left:24px;bottom:24px;"
    : "right:24px;bottom:24px;";

  var bubble = document.createElement("div");
  bubble.setAttribute("aria-label", "Open chat with " + label);
  bubble.setAttribute("role", "button");
  bubble.style.cssText =
    "position:fixed;" + pos +
    "z-index:2147483646;" +
    "background:" + bubbleColor + ";color:" + textColor + ";" +
    "padding:14px 20px;border-radius:9999px;" +
    "font-family:system-ui,-apple-system,sans-serif;font-size:14px;font-weight:500;" +
    "box-shadow:0 4px 24px rgba(0,0,0,0.15);" +
    "cursor:pointer;display:flex;align-items:center;gap:8px;" +
    "transition:transform .15s;";
  bubble.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
    '</svg><span>' + buttonText + '</span>';
  bubble.onmouseenter = function(){ bubble.style.transform = "scale(1.04)"; };
  bubble.onmouseleave = function(){ bubble.style.transform = ""; };

  var iframe = document.createElement("iframe");
  iframe.title = "Chat with " + label;
  iframe.style.cssText =
    "position:fixed;" + pos +
    "z-index:2147483647;" +
    "width:380px;height:600px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);" +
    "border:0;border-radius:16px;" +
    "box-shadow:0 12px 48px rgba(0,0,0,0.25);" +
    "background:#fff;display:none;";
  iframe.allow = "microphone; camera";

  // Pass visitor + origin + full page URL to the iframe via query string.
  // The iframe's server route validates and creates the session row.
  var iframeUrl = iframeSrc +
    "?v=" + encodeURIComponent(visitorId) +
    "&origin=" + encodeURIComponent(window.location.origin) +
    "&ref=" + encodeURIComponent(document.referrer || "") +
    "&page=" + encodeURIComponent(window.location.href);
  iframe.src = iframeUrl;

  bubble.onclick = function(){
    iframe.style.display = iframe.style.display === "block" ? "none" : "block";
  };

  // Listen for "close" message from the iframe so the user can dismiss from inside.
  window.addEventListener("message", function(e){
    if (e.origin !== ${JSON.stringify(appUrl)}) return;
    if (e.data && e.data.type === "vipagent.close") iframe.style.display = "none";
  });

  function inject(){
    document.body.appendChild(bubble);
    document.body.appendChild(iframe);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();`

  return new NextResponse(js, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "Access-Control-Allow-Origin": "*",
    },
  })
}
