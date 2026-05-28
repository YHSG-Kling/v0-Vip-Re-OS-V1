/**
 * AI SDK v6 helper: Extract text content from a message
 * 
 * In AI SDK v6, message.content is no longer a simple string.
 * It can be a string OR an array of parts (for multimodal content).
 * 
 * This helper safely extracts text content from any message format.
 */

export function getMessageText(message: any): string {
  // If content is already a string, return it
  if (typeof message.content === 'string') {
    return message.content
  }

  // If content is an array of parts (multimodal), extract text parts
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text ?? '')
      .join('')
  }

  // If message has parts property (alternative structure)
  if (message.parts && Array.isArray(message.parts)) {
    return message.parts
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text ?? '')
      .join('')
  }

  // Fallback to empty string
  return ''
}
