"use server"

/**
 * app/actions/ai-generate.ts — Server Action re-export shim.
 *
 * All implementation lives in lib/ai/generate.ts (canonical location).
 * This file exists only to attach the Next.js "use server" directive so
 * Server Components and API routes can call these functions as Server Actions.
 *
 * UI components should import directly from "@/lib/ai/generate" instead.
 */
export {
  generateAIText,
  generateAIJSON,
  generateAIObject,
  generateChatResponse,
} from "@/lib/ai"
