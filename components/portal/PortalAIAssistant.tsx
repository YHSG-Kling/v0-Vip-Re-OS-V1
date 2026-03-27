'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { MessageSquare, X, Send, Minimize2, ChevronDown, AlertCircle } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

interface Contact {
  id: string
  first_name?: string | null
  brokerage_id?: string | null
  agent_id?: string | null
  contact_persona?: string | null
}

interface PortalAIAssistantProps {
  contact: Contact
  contactId: string
  isBuyer: boolean
  isSeller: boolean
  persona: string
}

// ── Suggested questions per portal view ──────────────────────────────────────

const SUGGESTED_QUESTIONS: Record<'buyer' | 'seller' | 'lifetime', string[]> = {
  buyer:    ['What happens next?', 'What is earnest money?', 'When do I get keys?'],
  seller:   ['How is my listing doing?', 'When will I get paid?', 'What does under contract mean?'],
  lifetime: ['What is my home worth now?', 'When should I sell?', 'How are my neighbors doing?'],
}

// SESSION_KEY prefix for sessionStorage persistence
const SESSION_KEY_PREFIX = 'portal_ai_session_'
const MESSAGES_KEY_PREFIX = 'portal_ai_messages_'
const UNREAD_KEY_PREFIX   = 'portal_ai_unread_'

// ── Helper to get text from UIMessage parts ──────────────────────────────────

function getMessageText(msg: { parts?: { type: string; text?: string }[] }): string {
  if (!msg.parts?.length) return ''
  return msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('')
}

// ── Component ────────────────────────────────────────────────────────────────

export default function PortalAIAssistant({
  contact,
  contactId,
  isBuyer,
  isSeller,
}: PortalAIAssistantProps) {
  const portalView: 'buyer' | 'seller' | 'lifetime' = isSeller
    ? 'seller'
    : isBuyer
    ? 'buyer'
    : 'lifetime'

  const suggestedQuestions = SUGGESTED_QUESTIONS[portalView]

  // ── Local state ────────────────────────────────────────────────────────────
  const [isOpen,      setIsOpen]      = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [input,       setInput]       = useState('')
  const [sessionId,   setSessionId]   = useState<string | null>(null)
  const [hasOpened,   setHasOpened]   = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef       = useRef<HTMLInputElement>(null)

  const sessionStorageKey  = SESSION_KEY_PREFIX + contactId
  const messagesStorageKey = MESSAGES_KEY_PREFIX + contactId
  const unreadStorageKey   = UNREAD_KEY_PREFIX  + contactId

  // ── Restore session from sessionStorage on mount ───────────────────────────
  useEffect(() => {
    try {
      const savedSession = sessionStorage.getItem(sessionStorageKey)
      if (savedSession) setSessionId(savedSession)
      const savedUnread = sessionStorage.getItem(unreadStorageKey)
      if (savedUnread) setUnreadCount(parseInt(savedUnread, 10) || 0)
    } catch {
      // sessionStorage unavailable (e.g. private mode) — silent fail
    }
  }, [sessionStorageKey, unreadStorageKey])

  // ── useChat via AI SDK 6 ───────────────────────────────────────────────────
  const { messages, sendMessage, status, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/portal/ai-chat',
      prepareSendMessagesRequest: ({ messages: msgs }) => ({
        body: {
          messages:  msgs,
          contactId,
          sessionId,
        },
      }),
    }),
    onResponse: (response) => {
      // Capture sessionId from response header for persistence
      const sid = response.headers.get('x-portal-session-id')
      if (sid && !sessionId) {
        setSessionId(sid)
        try { sessionStorage.setItem(sessionStorageKey, sid) } catch { /* noop */ }
      }
    },
    onFinish: () => {
      // Increment unread badge when widget is closed/minimized
      if (!isOpen || isMinimized) {
        setUnreadCount(prev => {
          const next = prev + 1
          try { sessionStorage.setItem(unreadStorageKey, String(next)) } catch { /* noop */ }
          return next
        })
      }
    },
    onError: () => {
      setError('Something went wrong. Please try again.')
    },
  })

  // ── Restore messages from sessionStorage ──────────────────────────────────
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(messagesStorageKey)
      if (saved && messages.length === 0) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed)
        }
      }
    } catch { /* noop */ }
  // Only run on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesStorageKey])

  // Persist messages to sessionStorage whenever they change
  useEffect(() => {
    if (messages.length > 0) {
      try {
        sessionStorage.setItem(messagesStorageKey, JSON.stringify(messages))
      } catch { /* noop */ }
    }
  }, [messages, messagesStorageKey])

  // ── Scroll to bottom on new messages ──────────────────────────────────────
  useEffect(() => {
    if (isOpen && !isMinimized) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isOpen, isMinimized])

  // ── Clear unread when opened ───────────────────────────────────────────────
  const handleOpen = useCallback(() => {
    setIsOpen(true)
    setIsMinimized(false)
    setHasOpened(true)
    setUnreadCount(0)
    setError(null)
    try { sessionStorage.removeItem(unreadStorageKey) } catch { /* noop */ }
    setTimeout(() => inputRef.current?.focus(), 150)
  }, [unreadStorageKey])

  const handleClose = useCallback(() => {
    setIsOpen(false)
    setIsMinimized(false)
  }, [])

  const handleMinimize = useCallback(() => {
    setIsMinimized(true)
  }, [])

  // ── Send message ──────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || status === 'streaming' || status === 'submitted') return
    setError(null)
    sendMessage({ text })
    setInput('')
  }, [input, status, sendMessage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleSuggestedQuestion = useCallback((q: string) => {
    if (status === 'streaming' || status === 'submitted') return
    setError(null)
    sendMessage({ text: q })
  }, [status, sendMessage])

  const isLoading = status === 'streaming' || status === 'submitted'

  // ── First-time greeting message (injected visually, not via API) ───────────
  const greetingName = contact.first_name || 'there'
  const greetingText = portalView === 'seller'
    ? `Hi ${greetingName}! I can help you understand your listing status, what's happening next, and any real estate terms. What can I help you with?`
    : portalView === 'lifetime'
    ? `Hi ${greetingName}! I can help you understand your home's status, market trends, and what homeownership milestones look like. What would you like to know?`
    : `Hi ${greetingName}! I can help you understand what's happening in your home purchase, explain real estate terms, and tell you what to expect next. What can I help you with?`

  const showGreeting = isOpen && !isMinimized && messages.length === 0

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">

      {/* Chat window */}
      {isOpen && !isMinimized && (
        <div
          className="flex flex-col bg-background border border-border rounded-2xl shadow-2xl overflow-hidden"
          style={{ width: 'min(380px, calc(100vw - 32px))', height: 'min(540px, calc(100vh - 120px))' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-foreground text-background">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-background/20 flex items-center justify-center">
                <MessageSquare className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-tight">Your Agent Assistant</p>
                <p className="text-xs text-background/60 leading-tight">Ask me anything about your {portalView === 'lifetime' ? 'home' : portalView === 'seller' ? 'listing' : 'transaction'}</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={handleMinimize}
                className="p-1.5 rounded-lg hover:bg-background/10 transition-colors"
                aria-label="Minimize"
              >
                <Minimize2 className="h-4 w-4" />
              </button>
              <button
                onClick={handleClose}
                className="p-1.5 rounded-lg hover:bg-background/10 transition-colors"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {/* Greeting */}
            {showGreeting && (
              <div className="flex gap-2">
                <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0 mt-0.5">
                  <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="bg-muted rounded-2xl rounded-tl-none px-3 py-2.5 max-w-[82%]">
                  <p className="text-sm text-foreground leading-relaxed">{greetingText}</p>
                </div>
              </div>
            )}

            {/* Conversation */}
            {messages.map((msg) => {
              const text = getMessageText(msg)
              if (!text) return null
              return (
                <div
                  key={msg.id}
                  className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {msg.role === 'assistant' && (
                    <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0 mt-0.5">
                      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  )}
                  <div
                    className={`rounded-2xl px-3 py-2.5 max-w-[82%] text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-foreground text-background rounded-tr-none'
                        : 'bg-muted text-foreground rounded-tl-none'
                    }`}
                  >
                    {text}
                  </div>
                </div>
              )
            })}

            {/* Typing indicator */}
            {isLoading && (
              <div className="flex gap-2">
                <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                  <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="bg-muted rounded-2xl rounded-tl-none px-3 py-2.5">
                  <div className="flex gap-1 items-center h-4">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="flex gap-2 items-start">
                <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                <p className="text-xs text-destructive">{error}</p>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Suggested questions — shown after greeting, before any messages */}
          {showGreeting && !isLoading && (
            <div className="px-4 pb-3 flex flex-wrap gap-1.5">
              {suggestedQuestions.map((q) => (
                <button
                  key={q}
                  onClick={() => handleSuggestedQuestion(q)}
                  className="text-xs border border-border rounded-full px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors text-left"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="px-4 pb-4 pt-2 border-t border-border">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask a question..."
                disabled={isLoading}
                className="flex-1 text-sm bg-muted border-0 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-foreground/20 placeholder:text-muted-foreground disabled:opacity-50"
              />
              <button
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
                className="w-9 h-9 rounded-xl bg-foreground text-background flex items-center justify-center flex-shrink-0 hover:bg-foreground/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
              AI can make mistakes — your agent has the final word.
            </p>
          </div>
        </div>
      )}

      {/* Minimized bar */}
      {isOpen && isMinimized && (
        <button
          onClick={() => setIsMinimized(false)}
          className="flex items-center gap-2 bg-foreground text-background rounded-full px-4 py-2.5 shadow-lg hover:bg-foreground/90 transition-colors"
        >
          <MessageSquare className="h-4 w-4" />
          <span className="text-sm font-medium">Your Agent Assistant</span>
          <ChevronDown className="h-3.5 w-3.5 ml-1" />
        </button>
      )}

      {/* FAB — closed state */}
      {!isOpen && (
        <button
          onClick={handleOpen}
          className="relative w-14 h-14 rounded-full bg-foreground text-background shadow-lg hover:bg-foreground/90 active:scale-95 transition-all flex items-center justify-center"
          aria-label="Open AI assistant"
        >
          <MessageSquare className="h-6 w-6" />
          {/* Unread badge — draws attention on first visit */}
          {(unreadCount > 0 || !hasOpened) && (
            <span className="absolute -top-1 -right-1 min-w-[20px] h-5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center px-1 ring-2 ring-background">
              {unreadCount > 0 ? (unreadCount > 9 ? '9+' : unreadCount) : '1'}
            </span>
          )}
        </button>
      )}
    </div>
  )
}
