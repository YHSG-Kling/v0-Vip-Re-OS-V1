/**
 * Type declarations for qrcode
 * Used for QR code generation throughout the app
 */

declare module 'qrcode' {
  interface QRCodeToDataURLOptions {
    type?: 'image/png' | 'image/jpeg' | 'image/webp'
    quality?: number
    margin?: number
    width?: number
    color?: {
      dark?: string
      light?: string
    }
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }

  interface QRCodeToStringOptions {
    type?: 'svg' | 'terminal' | 'utf8'
    margin?: number
    width?: number
    color?: {
      dark?: string
      light?: string
    }
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }

  interface QRCodeToCanvasOptions {
    margin?: number
    width?: number
    color?: {
      dark?: string
      light?: string
    }
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }

  function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>
  function toString(text: string, options?: QRCodeToStringOptions): Promise<string>
  function toCanvas(canvas: HTMLCanvasElement, text: string, options?: QRCodeToCanvasOptions): Promise<void>
  function toCanvas(text: string, options?: QRCodeToCanvasOptions): Promise<HTMLCanvasElement>
  /** The symbol without rendering it — wave 155 (155E) reads `modules.size` (modules per side, quiet zone excluded) to
   *  hold a placement to its minimum module size (lib/marketing/tracked-qr.ts qrModuleCount). */
  function create(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): { modules: { size: number }; version: number }

  export { toDataURL, toString, toCanvas, create }
  export type { QRCodeToDataURLOptions, QRCodeToStringOptions, QRCodeToCanvasOptions }
}
