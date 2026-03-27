// GET /api/widget/loader?brokerage_id=...&agent_id=...&theme=...
// Returns a self-contained JS snippet that injects the chat iframe into the host page.
// Cache-Control: public, max-age=300 (5 min) so brokerages can embed without latency.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const brokerageId = searchParams.get('brokerage_id')
  const agentId = searchParams.get('agent_id') ?? ''
  const theme = searchParams.get('theme') ?? 'light'
  const position = searchParams.get('position') ?? 'bottom-right'

  if (!brokerageId) {
    return new NextResponse('// Error: brokerage_id is required', {
      status: 400,
      headers: { 'Content-Type': 'application/javascript' },
    })
  }

  // Verify brokerage exists and widget is enabled
  const supabase = createServiceClient()
  const { data: brokerage } = await supabase
    .from('brokerages')
    .select('id, name, widget_enabled')
    .eq('id', brokerageId)
    .maybeSingle()

  if (!brokerage || brokerage.widget_enabled === false) {
    return new NextResponse('// Widget not enabled for this brokerage', {
      status: 403,
      headers: { 'Content-Type': 'application/javascript' },
    })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.example.com'
  const params = new URLSearchParams({
    brokerage_id: brokerageId,
    ...(agentId ? { agent_id: agentId } : {}),
    theme,
    position,
  })
  const widgetUrl = `${appUrl}/widget?${params.toString()}`

  // Snippet: injects a floating iframe into the host page
  const snippet = `
(function() {
  if (window.__KernelWidgetLoaded) return;
  window.__KernelWidgetLoaded = true;

  var WIDGET_URL = '${widgetUrl}';
  var pos = '${position}';

  // Create iframe
  var iframe = document.createElement('iframe');
  iframe.id = 'kernel-chat-widget';
  iframe.src = WIDGET_URL;
  iframe.allow = 'microphone';
  iframe.style.cssText = [
    'position:fixed',
    pos === 'bottom-left' ? 'left:24px' : 'right:24px',
    'bottom:24px',
    'width:380px',
    'height:560px',
    'border:none',
    'border-radius:16px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.18)',
    'z-index:2147483647',
    'transition:opacity 0.25s ease, transform 0.25s ease',
    'opacity:0',
    'transform:translateY(16px)',
    'background:transparent',
  ].join(';');
  document.body.appendChild(iframe);

  // Create launcher button
  var btn = document.createElement('button');
  btn.id = 'kernel-chat-launcher';
  btn.setAttribute('aria-label', 'Chat with us');
  btn.style.cssText = [
    'position:fixed',
    pos === 'bottom-left' ? 'left:24px' : 'right:24px',
    'bottom:24px',
    'width:56px',
    'height:56px',
    'border-radius:50%',
    'background:#1a56db',
    'border:none',
    'cursor:pointer',
    'box-shadow:0 4px 16px rgba(26,86,219,0.4)',
    'z-index:2147483647',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'color:#fff',
    'font-size:24px',
    'transition:transform 0.2s ease',
  ].join(';');
  btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  document.body.appendChild(btn);

  var open = false;
  function toggle() {
    open = !open;
    iframe.style.opacity = open ? '1' : '0';
    iframe.style.transform = open ? 'translateY(0)' : 'translateY(16px)';
    iframe.style.pointerEvents = open ? 'all' : 'none';
    btn.style.transform = open ? 'rotate(45deg)' : 'none';
    if (open) {
      btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    } else {
      btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    }
  }
  btn.addEventListener('click', toggle);

  // Listen for close message from iframe
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'kernel-widget-close') toggle();
  });
})();
`.trim()

  return new NextResponse(snippet, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
