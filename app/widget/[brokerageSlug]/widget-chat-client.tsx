'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'

// ── Types ────────────────────────────────────────────────────────────────────

interface WidgetConfig {
  assistantName: string
  assistantAvatar: string | null
  brokerageName: string
  accentColor: string
  welcomeMessage: string
}

interface CaptureFormData {
  name: string
  email: string
  phone: string
}

type CaptureState = 'none' | 'prompted' | 'captured'

// ── Lead capture trigger: after 3 user messages, offer the form ──────────────
const CAPTURE_TRIGGER_AFTER = 3

// ── Component ────────────────────────────────────────────────────────────────

export function WidgetChatClient({
  brokerageSlug,
  config,
  sessionToken,
}: {
  brokerageSlug: string
  config: WidgetConfig
  sessionToken: string
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [captureState, setCaptureState] = useState<CaptureState>('none')
  const [captureForm, setCaptureForm] = useState<CaptureFormData>({ name: '', email: '', phone: '' })
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [captureLoading, setCaptureLoading] = useState(false)
  const [input, setInput] = useState('')

  const accentStyle = { '--widget-accent': config.accentColor } as React.CSSProperties

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/widget/message',
      prepareSendMessagesRequest: ({ messages }) => ({
        body: {
          messages,
          // Server reads snake_case: session_token
          session_token: sessionToken,
          brokerageSlug,
        },
      }),
    }),
  })

  // Count user messages to trigger lead capture
  const userMessageCount = messages.filter(m => m.role === 'user').length

  useEffect(() => {
    if (captureState === 'none' && userMessageCount >= CAPTURE_TRIGGER_AFTER) {
      setCaptureState('prompted')
    }
  }, [userMessageCount, captureState])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || status === 'streaming' || status === 'submitted') return
    sendMessage({ text })
    setInput('')
  }, [input, status, sendMessage])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleCapture = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!captureForm.name.trim() || !captureForm.email.trim()) {
      setCaptureError('Name and email are required.')
      return
    }
    setCaptureLoading(true)
    setCaptureError(null)
    try {
      const res = await fetch('/api/widget/capture-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Server reads snake_case: session_token
          session_token: sessionToken,
          brokerageSlug,
          // Split name into first/last for captureContact viability check
          first_name: captureForm.name.trim().split(' ').slice(0, -1).join(' ') || captureForm.name.trim(),
          last_name: captureForm.name.trim().split(' ').slice(-1).join(' ') !== captureForm.name.trim()
            ? captureForm.name.trim().split(' ').slice(-1).join(' ')
            : null,
          email: captureForm.email.trim(),
          phone: captureForm.phone.trim() || null,
          tcpa_consent: !!captureForm.phone.trim(), // phone provided = TCPA consent
          intent_type: 'unknown',
          conversationMessages: messages.map(m => ({
            role: m.role,
            content: m.parts
              ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map(p => p.text)
              .join('') ?? '',
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to save.')
      setCaptureState('captured')
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setCaptureLoading(false)
    }
  }

  const isStreaming = status === 'streaming' || status === 'submitted'

  return (
    <div
      className="widget-root"
      style={accentStyle}
    >
      {/* Header */}
      <header className="widget-header">
        <div className="widget-avatar">
          {config.assistantAvatar ? (
            <img src={config.assistantAvatar} alt={config.assistantName} />
          ) : (
            <span className="widget-avatar-initials">
              {config.assistantName.charAt(0).toUpperCase()}
            </span>
          )}
          <span className="widget-online-dot" aria-hidden="true" />
        </div>
        <div className="widget-header-text">
          <span className="widget-assistant-name">{config.assistantName}</span>
          <span className="widget-brokerage-name">{config.brokerageName}</span>
        </div>
      </header>

      {/* Messages */}
      <main className="widget-messages" aria-live="polite" aria-label="Chat messages">
        {/* Welcome bubble */}
        {messages.length === 0 && (
          <div className="widget-bubble widget-bubble--ai">
            <p>{config.welcomeMessage}</p>
          </div>
        )}

        {messages.map(msg => {
          const text = msg.parts
            ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map(p => p.text)
            .join('') ?? ''

          if (!text) return null

          return (
            <div
              key={msg.id}
              className={`widget-bubble ${msg.role === 'user' ? 'widget-bubble--user' : 'widget-bubble--ai'}`}
            >
              <p>{text}</p>
            </div>
          )
        })}

        {/* Typing indicator */}
        {isStreaming && (
          <div className="widget-bubble widget-bubble--ai widget-bubble--typing" aria-label="Assistant is typing">
            <span /><span /><span />
          </div>
        )}

        <div ref={messagesEndRef} />
      </main>

      {/* Lead capture prompt */}
      {captureState === 'prompted' && (
        <div className="widget-capture">
          <p className="widget-capture-headline">
            Want us to follow up with personalized listings?
          </p>
          <form onSubmit={handleCapture} noValidate>
            <input
              className="widget-capture-input"
              type="text"
              placeholder="Your name"
              value={captureForm.name}
              onChange={e => setCaptureForm(p => ({ ...p, name: e.target.value }))}
              required
              aria-label="Your name"
            />
            <input
              className="widget-capture-input"
              type="email"
              placeholder="Email address"
              value={captureForm.email}
              onChange={e => setCaptureForm(p => ({ ...p, email: e.target.value }))}
              required
              aria-label="Email address"
            />
            <input
              className="widget-capture-input"
              type="tel"
              placeholder="Phone (optional)"
              value={captureForm.phone}
              onChange={e => setCaptureForm(p => ({ ...p, phone: e.target.value }))}
              aria-label="Phone number"
            />
            {captureError && (
              <p className="widget-capture-error" role="alert">{captureError}</p>
            )}
            <div className="widget-capture-actions">
              <button
                type="submit"
                className="widget-capture-submit"
                disabled={captureLoading}
              >
                {captureLoading ? 'Saving...' : 'Send my info'}
              </button>
              <button
                type="button"
                className="widget-capture-skip"
                onClick={() => setCaptureState('captured')}
              >
                Skip
              </button>
            </div>
          </form>
        </div>
      )}

      {captureState === 'captured' && (
        <div className="widget-capture-success" role="status">
          Got it! We&apos;ll be in touch soon.
        </div>
      )}

      {/* Input bar */}
      <footer className="widget-input-bar">
        <input
          ref={inputRef}
          className="widget-input"
          type="text"
          placeholder="Ask about homes, pricing, neighborhoods..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          aria-label="Chat message"
          autoComplete="off"
        />
        <button
          className="widget-send-btn"
          onClick={handleSend}
          disabled={isStreaming || !input.trim()}
          aria-label="Send message"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </footer>

      {/* Powered-by */}
      <div className="widget-powered-by" aria-label="Powered by VIP Re OS">
        Powered by VIP Re OS
      </div>

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .widget-root {
          display: flex;
          flex-direction: column;
          height: 100vh;
          width: 100%;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px;
          background: #ffffff;
          color: #111827;
        }

        /* Header */
        .widget-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 16px;
          background: var(--widget-accent, #1d4ed8);
          color: #ffffff;
          flex-shrink: 0;
        }
        .widget-avatar {
          position: relative;
          width: 38px;
          height: 38px;
          border-radius: 50%;
          overflow: visible;
          flex-shrink: 0;
        }
        .widget-avatar img {
          width: 38px;
          height: 38px;
          border-radius: 50%;
          object-fit: cover;
        }
        .widget-avatar-initials {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 38px;
          height: 38px;
          border-radius: 50%;
          background: rgba(255,255,255,0.25);
          font-size: 16px;
          font-weight: 600;
          color: #ffffff;
        }
        .widget-online-dot {
          position: absolute;
          bottom: 1px;
          right: 1px;
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: #22c55e;
          border: 2px solid var(--widget-accent, #1d4ed8);
        }
        .widget-header-text {
          display: flex;
          flex-direction: column;
          gap: 1px;
          min-width: 0;
        }
        .widget-assistant-name {
          font-size: 14px;
          font-weight: 600;
          color: #ffffff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .widget-brokerage-name {
          font-size: 11px;
          color: rgba(255,255,255,0.75);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* Messages */
        .widget-messages {
          flex: 1;
          overflow-y: auto;
          padding: 16px 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .widget-bubble {
          max-width: 82%;
          padding: 9px 13px;
          border-radius: 16px;
          line-height: 1.5;
          word-break: break-word;
        }
        .widget-bubble--ai {
          align-self: flex-start;
          background: #f3f4f6;
          color: #111827;
          border-bottom-left-radius: 4px;
        }
        .widget-bubble--user {
          align-self: flex-end;
          background: var(--widget-accent, #1d4ed8);
          color: #ffffff;
          border-bottom-right-radius: 4px;
        }

        /* Typing indicator */
        .widget-bubble--typing {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 12px 14px;
        }
        .widget-bubble--typing span {
          display: inline-block;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #9ca3af;
          animation: bounce 1.2s infinite ease-in-out;
        }
        .widget-bubble--typing span:nth-child(2) { animation-delay: 0.2s; }
        .widget-bubble--typing span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30%            { transform: translateY(-5px); }
        }

        /* Lead capture */
        .widget-capture {
          background: #f9fafb;
          border-top: 1px solid #e5e7eb;
          padding: 14px 12px 10px;
          flex-shrink: 0;
        }
        .widget-capture-headline {
          font-size: 13px;
          font-weight: 600;
          color: #111827;
          margin-bottom: 10px;
        }
        .widget-capture-input {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          font-size: 13px;
          margin-bottom: 6px;
          background: #ffffff;
          color: #111827;
          outline: none;
          min-height: 44px;
        }
        .widget-capture-input:focus {
          border-color: var(--widget-accent, #1d4ed8);
          box-shadow: 0 0 0 2px rgba(29,78,216,0.15);
        }
        .widget-capture-error {
          font-size: 12px;
          color: #dc2626;
          margin-bottom: 6px;
        }
        .widget-capture-actions {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .widget-capture-submit {
          flex: 1;
          padding: 9px 0;
          background: var(--widget-accent, #1d4ed8);
          color: #ffffff;
          border: none;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          min-height: 44px;
        }
        .widget-capture-submit:disabled { opacity: 0.6; cursor: not-allowed; }
        .widget-capture-skip {
          padding: 9px 12px;
          background: transparent;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          font-size: 13px;
          color: #6b7280;
          cursor: pointer;
          min-height: 44px;
        }
        .widget-capture-success {
          padding: 10px 12px;
          background: #f0fdf4;
          border-top: 1px solid #bbf7d0;
          font-size: 13px;
          font-weight: 600;
          color: #15803d;
          text-align: center;
          flex-shrink: 0;
        }

        /* Input bar */
        .widget-input-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          border-top: 1px solid #e5e7eb;
          background: #ffffff;
          flex-shrink: 0;
        }
        .widget-input {
          flex: 1;
          padding: 9px 12px;
          border: 1px solid #d1d5db;
          border-radius: 20px;
          font-size: 13px;
          background: #f9fafb;
          color: #111827;
          outline: none;
          min-height: 44px;
        }
        .widget-input:focus {
          border-color: var(--widget-accent, #1d4ed8);
          background: #ffffff;
        }
        .widget-input:disabled { opacity: 0.5; }
        .widget-send-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          min-width: 40px;
          border-radius: 50%;
          background: var(--widget-accent, #1d4ed8);
          color: #ffffff;
          border: none;
          cursor: pointer;
          flex-shrink: 0;
        }
        .widget-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        /* Powered-by */
        .widget-powered-by {
          text-align: center;
          font-size: 10px;
          color: #9ca3af;
          padding: 4px 0 6px;
          flex-shrink: 0;
        }
      `}</style>
    </div>
  )
}
