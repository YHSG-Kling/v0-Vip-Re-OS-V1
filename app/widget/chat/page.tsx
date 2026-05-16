// app/widget/chat/page.tsx
// Embeddable chat widget page — rendered inside an iframe by widget-loader.js.
// Receives: ?agent=AGENT_ID&brokerage=BROKERAGE_ID&position=right|left
// No auth required. Initializes a widget session, then streams AI responses.

import { Suspense } from "react"
import WidgetChatClient from "./widget-chat-client"

export const metadata = {
  title: "Chat Widget",
  robots: { index: false },
}

export default function WidgetChatPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full text-sm text-gray-400">Loading...</div>}>
      <WidgetChatClient />
    </Suspense>
  )
}
