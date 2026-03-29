;(function () {
  'use strict'

  // Read data attributes from the <script> tag
  var scripts = document.querySelectorAll('script[data-vip-brokerage]')
  var scriptTag = scripts[scripts.length - 1]

  if (!scriptTag) {
    console.warn('[VIP Widget] script tag not found — ensure data-vip-brokerage is set.')
    return
  }

  var agentId    = scriptTag.getAttribute('data-vip-agent')    || ''
  var brokerageId = scriptTag.getAttribute('data-vip-brokerage') || ''
  var appUrl     = (scriptTag.getAttribute('data-vip-url')     || '').replace(/\/$/, '')
  var position   = scriptTag.getAttribute('data-vip-position') || 'right'

  if (!brokerageId || !appUrl) {
    console.warn('[VIP Widget] data-vip-brokerage and data-vip-url are required.')
    return
  }

  var isRight  = position !== 'left'
  var isOpen   = false
  var iframeReady = false

  var BOTTOM    = '24px'
  var SIDE      = '24px'
  var BTN_SIZE  = '56px'
  var IFRAME_W  = '380px'
  var IFRAME_H  = '600px'
  var Z         = '2147483647'
  var SIDE_PROP = isRight ? 'right' : 'left'

  // ── Launcher button ──────────────────────────────────────────────────────────
  var btn = document.createElement('button')
  btn.setAttribute('aria-label', 'Open chat')
  btn.style.cssText = [
    'position:fixed',
    'bottom:' + BOTTOM,
    SIDE_PROP + ':' + SIDE,
    'z-index:' + Z,
    'width:' + BTN_SIZE,
    'height:' + BTN_SIZE,
    'border-radius:50%',
    'background:#1d4ed8',
    'border:none',
    'cursor:pointer',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'box-shadow:0 4px 14px rgba(0,0,0,0.22)',
    'transition:transform 0.15s,background 0.15s',
    'outline:none',
  ].join(';')

  var CHAT_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  var CLOSE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

  btn.innerHTML = CHAT_ICON
  btn.addEventListener('mouseenter', function () { btn.style.background = '#1e40af' })
  btn.addEventListener('mouseleave', function () { btn.style.background = '#1d4ed8' })

  // Unread indicator dot (hidden after first open)
  var dot = document.createElement('span')
  dot.style.cssText = [
    'position:absolute',
    'top:2px',
    isRight ? 'right:2px' : 'left:2px',
    'width:12px',
    'height:12px',
    'background:#ef4444',
    'border-radius:50%',
    'border:2px solid white',
    'pointer-events:none',
  ].join(';')
  btn.style.position = 'fixed'
  btn.appendChild(dot)

  // ── Widget container ─────────────────────────────────────────────────────────
  var container = document.createElement('div')
  container.style.cssText = [
    'position:fixed',
    'bottom:calc(' + BOTTOM + ' + ' + BTN_SIZE + ' + 8px)',
    SIDE_PROP + ':' + SIDE,
    'z-index:' + Z,
    'width:' + IFRAME_W,
    'height:' + IFRAME_H,
    'border-radius:16px',
    'overflow:hidden',
    'box-shadow:0 8px 32px rgba(0,0,0,0.18)',
    'display:none',
    'opacity:0',
    'transform:translateY(12px) scale(0.97)',
    'transform-origin:' + (isRight ? 'bottom right' : 'bottom left'),
    'transition:opacity 0.2s,transform 0.2s',
  ].join(';')

  var iframe = null

  function buildSrc() {
    var q = 'brokerage=' + encodeURIComponent(brokerageId) + '&position=' + encodeURIComponent(position)
    if (agentId) q += '&agent=' + encodeURIComponent(agentId)
    return appUrl + '/widget/chat?' + q
  }

  function mountIframe() {
    if (iframeReady) return
    iframeReady = true
    iframe = document.createElement('iframe')
    iframe.src = buildSrc()
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;'
    iframe.setAttribute('title', 'Chat Widget')
    iframe.setAttribute('allow', 'microphone')
    container.appendChild(iframe)
  }

  function openWidget() {
    isOpen = true
    mountIframe()
    dot.style.display = 'none'
    container.style.display = 'block'
    requestAnimationFrame(function () {
      container.style.opacity  = '1'
      container.style.transform = 'translateY(0) scale(1)'
    })
    btn.setAttribute('aria-label', 'Close chat')
    btn.innerHTML = CLOSE_ICON
  }

  function closeWidget() {
    isOpen = false
    container.style.opacity  = '0'
    container.style.transform = 'translateY(12px) scale(0.97)'
    btn.setAttribute('aria-label', 'Open chat')
    btn.innerHTML = CHAT_ICON
    setTimeout(function () {
      if (!isOpen) container.style.display = 'none'
    }, 220)
  }

  btn.addEventListener('click', function () {
    if (isOpen) closeWidget()
    else openWidget()
  })

  // Close from inside the iframe
  window.addEventListener('message', function (evt) {
    if (evt.data && evt.data.type === 'VIP_WIDGET_CLOSE') closeWidget()
  })

  // ESC closes
  document.addEventListener('keydown', function (evt) {
    if (evt.key === 'Escape' && isOpen) closeWidget()
  })

  document.body.appendChild(container)
  document.body.appendChild(btn)
})()
