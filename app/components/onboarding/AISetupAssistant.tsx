'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Bot, Send, X, MessageCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AISetupAssistantProps {
  brokerageId?: string
  agentId?: string
}

export function AISetupAssistant({ brokerageId, agentId }: AISetupAssistantProps) {
  const [isOpen, setIsOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/onboarding/assistant',
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { messages, brokerageId, agentId },
      }),
    }),
  })

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      const maxHeight = 20 * 3 + 16
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, maxHeight)}px`
    }
  }, [input])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input?.trim() || isLoading) return
    handleSubmit(e)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit(e)
    }
  }

  return (
    <>
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            onClick={() => setIsOpen(true)}
            className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-[#1e3a5f] text-white px-4 py-3 shadow-lg hover:bg-[#2a4a73] transition-colors"
          >
            <Bot className="w-5 h-5" />
            <span className="text-sm font-medium">Setup Help</span>
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ y: 600, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 600, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed bottom-6 right-6 z-50 w-[380px] h-[520px] flex flex-col bg-background border border-border rounded-2xl shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-[#1e3a5f] text-white">
              <div className="flex items-center gap-2">
                <Bot className="w-5 h-5" />
                <span className="font-semibold text-sm">Setup Assistant</span>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 rounded-full hover:bg-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <ScrollArea className="flex-1 p-4" ref={scrollRef}>
              <div className="space-y-4">
                {messages.length === 0 && (
                  <div className="text-center py-8 px-4">
                    <div className="w-12 h-12 rounded-full bg-[#1e3a5f]/10 flex items-center justify-center mx-auto mb-3">
                      <MessageCircle className="w-6 h-6 text-[#1e3a5f]" />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Hi! I&apos;m here to help you get set up. Ask me anything about the platform.
                    </p>
                  </div>
                )}

                {messages.map((message, i) => (
                  <div
                    key={message.id || i}
                    className={cn(
                      'flex',
                      message.role === 'user' ? 'justify-end' : 'justify-start'
                    )}
                  >
                    {message.role === 'assistant' && (
                      <div className="w-7 h-7 rounded-full bg-[#1e3a5f] flex items-center justify-center mr-2 flex-shrink-0 mt-0.5">
                        <Bot className="w-4 h-4 text-white" />
                      </div>
                    )}
                    <div
                      className={cn(
                        'max-w-[75%] px-3 py-2 rounded-2xl text-sm',
                        message.role === 'user'
                          ? 'bg-[#1e3a5f] text-white rounded-br-md'
                          : 'bg-white border border-border text-foreground rounded-bl-md shadow-sm'
                      )}
                    >
                      {message.content}
                    </div>
                  </div>
                ))}

                {isLoading && (
                  <div className="flex justify-start">
                    <div className="w-7 h-7 rounded-full bg-[#1e3a5f] flex items-center justify-center mr-2 flex-shrink-0">
                      <Bot className="w-4 h-4 text-white" />
                    </div>
                    <div className="bg-white border border-border px-4 py-3 rounded-2xl rounded-bl-md shadow-sm">
                      <div className="flex gap-1">
                        <div className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-pulse" style={{ animationDelay: '0ms' }} />
                        <div className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-pulse" style={{ animationDelay: '150ms' }} />
                        <div className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-pulse" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>

            <div className="px-4 py-3 border-t border-border bg-muted/30">
              <form onSubmit={onSubmit} className="flex gap-2 items-end">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask a question..."
                  disabled={isLoading}
                  rows={1}
                  className="flex-1 resize-none rounded-xl border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ minHeight: '36px', maxHeight: '76px' }}
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={isLoading || !input?.trim()}
                  className="h-9 w-9 rounded-xl bg-[#1e3a5f] hover:bg-[#2a4a73] flex-shrink-0"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </form>
            </div>

            <div className="px-4 py-2 border-t border-border bg-muted/50">
              <p className="text-[10px] text-muted-foreground text-center leading-tight">
                This is AI assistance — verify important decisions with your broker
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
