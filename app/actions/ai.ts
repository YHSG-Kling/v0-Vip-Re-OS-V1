"use server"

import { generateText } from "ai"

export async function generatePlaybookResponse(contactId: string, question: string): Promise<string> {
  try {
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `A real estate client (ID: ${contactId}) is asking: "${question}". 
          Provide a helpful, expert, yet concise answer based on general real estate knowledge and the context of a home buying/selling journey. 
          Tone: Professional and encouraging. Limit to 3 sentences.`,
    })

    return text || "I'm processing your request. Please hold."
  } catch (e) {
    console.error("Error calling AI:", e)
    return "My connection to the intelligence cluster is briefly interrupted. Please try again or text your agent directly."
  }
}
