/**
 * Type declarations for canvas-confetti
 * Used by onboarding and celebration components
 */

declare module 'canvas-confetti' {
  interface Options {
    particleCount?: number
    angle?: number
    spread?: number
    startVelocity?: number
    decay?: number
    gravity?: number
    drift?: number
    ticks?: number
    origin?: {
      x?: number
      y?: number
    }
    colors?: string[]
    shapes?: Array<'square' | 'circle' | 'star'>
    scalar?: number
    zIndex?: number
    disableForReducedMotion?: boolean
  }

  interface ConfettiFunction {
    (options?: Options): Promise<null>
    reset(): void
    create(canvas: HTMLCanvasElement | null, options?: { resize?: boolean; useWorker?: boolean }): ConfettiFunction
  }

  const confetti: ConfettiFunction
  export = confetti
}
