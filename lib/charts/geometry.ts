/**
 * lib/charts/geometry.ts
 *
 * Wave 39 — pure SVG chart geometry for the Remotion chart layer. Deterministic
 * math (no React, no Remotion, no AI) so the whole charting core is
 * unit-testable in the simulator. The Remotion components in remotion/charts/*
 * are thin SVG wrappers that animate these shapes with interpolate().
 *
 * Charts the real-estate OS needs that text stat-cards can't convey:
 *   · PriceTrendLine     — median sale price over N months (line + area)
 *   · CompsBar           — subject vs comparable sales (horizontal bars)
 *   · DaysOnMarketBars   — DOM trend (vertical bars)
 *   · AffordabilityDonut — monthly payment split (P&I / tax / insurance / HOA)
 */

export interface Point { x: number; y: number }

/** Linear remap of v from [inMin,inMax] to [outMin,outMax]. Guards a zero
 *  input span (returns outMin) so flat series don't divide by zero. */
export function mapRange(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin
  return outMin + ((v - inMin) * (outMax - outMin)) / (inMax - inMin)
}

/** A human-friendly axis scale: rounds the domain out to "nice" bounds and
 *  returns evenly spaced ticks. Always returns at least 2 ticks. */
export function niceScale(min: number, max: number, tickCount = 4): { min: number; max: number; step: number; ticks: number[] } {
  if (max < min) [min, max] = [max, min]
  const span = max - min || Math.abs(max) || 1
  const rawStep = span / Math.max(1, tickCount)
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const norm = rawStep / mag
  const niceNorm = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10
  const step = niceNorm * mag
  const niceMin = Math.floor(min / step) * step
  // Flat domain (min===max) rounds to a single value; expand one step up so
  // the axis always has a real span and ≥2 ticks.
  const niceMax = Math.max(Math.ceil(max / step) * step, niceMin + step)
  const ticks: number[] = []
  for (let t = niceMin; t <= niceMax + step / 1000; t += step) ticks.push(Number(t.toFixed(6)))
  return { min: niceMin, max: niceMax, step, ticks }
}

/** Map a numeric series to (x,y) points inside a box. y is flipped so larger
 *  values sit higher (SVG y grows downward). */
export function seriesToPoints(
  values: number[],
  box: { width: number; height: number; padX?: number; padY?: number },
  domain?: { min: number; max: number },
): Point[] {
  const padX = box.padX ?? 0
  const padY = box.padY ?? 0
  const lo = domain?.min ?? Math.min(...values)
  const hi = domain?.max ?? Math.max(...values)
  const innerW = box.width - padX * 2
  const innerH = box.height - padY * 2
  const n = values.length
  return values.map((v, i) => ({
    x: padX + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1)),
    y: padY + innerH - mapRange(v, lo, hi, 0, innerH),
  }))
}

/** SVG path "M x y L x y …" through the points. */
export function linePath(points: Point[]): string {
  if (points.length === 0) return ""
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${round(p.x)} ${round(p.y)}`).join(" ")
}

/** Closed area path: the line, dropped to a baseline, closed. */
export function areaPath(points: Point[], baselineY: number): string {
  if (points.length === 0) return ""
  const top = linePath(points)
  const last = points[points.length - 1]
  const first = points[0]
  return `${top} L ${round(last.x)} ${round(baselineY)} L ${round(first.x)} ${round(baselineY)} Z`
}

export interface Bar { x: number; y: number; w: number; h: number; value: number; index: number }

/** Vertical-bar layout inside a box. Bars share the width with a gap fraction
 *  (0–1) of each slot. Heights map [0|domainMin .. domainMax] → innerH. */
export function verticalBars(
  values: number[],
  box: { width: number; height: number; padX?: number; padY?: number; gap?: number },
  domain?: { min: number; max: number },
): Bar[] {
  const padX = box.padX ?? 0
  const padY = box.padY ?? 0
  const gap = clamp(box.gap ?? 0.3, 0, 0.9)
  const lo = domain?.min ?? 0
  const hi = domain?.max ?? Math.max(...values, 0)
  const innerW = box.width - padX * 2
  const innerH = box.height - padY * 2
  const slot = values.length > 0 ? innerW / values.length : innerW
  const w = slot * (1 - gap)
  return values.map((v, i) => {
    const h = Math.max(0, mapRange(v, lo, hi, 0, innerH))
    return { x: padX + slot * i + (slot - w) / 2, y: padY + innerH - h, w, h, value: v, index: i }
  })
}

/** Horizontal-bar layout (for comps comparisons). Bar length maps value→innerW;
 *  the highest value (or domain.max) fills the track. */
export function horizontalBars(
  values: number[],
  box: { width: number; height: number; padY?: number; gap?: number },
  domain?: { min: number; max: number },
): Bar[] {
  const padY = box.padY ?? 0
  const gap = clamp(box.gap ?? 0.35, 0, 0.9)
  const lo = domain?.min ?? 0
  const hi = domain?.max ?? Math.max(...values, 0)
  const innerH = box.height - padY * 2
  const slot = values.length > 0 ? innerH / values.length : innerH
  const h = slot * (1 - gap)
  return values.map((v, i) => {
    const w = Math.max(0, mapRange(v, lo, hi, 0, box.width))
    return { x: 0, y: padY + slot * i + (slot - h) / 2, w, h, value: v, index: i }
  })
}

export interface DonutArc { d: string; fraction: number; startAngle: number; endAngle: number; index: number }

/** Donut segments for parts-of-a-whole (monthly-payment split). Angles in
 *  degrees, clockwise from 12 o'clock. Zero-total guard returns []. */
export function donutArcs(values: number[], opts: { cx: number; cy: number; radius: number; thickness: number }): DonutArc[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0)
  if (total <= 0) return []
  const inner = Math.max(0, opts.radius - opts.thickness)
  let angle = 0
  return values.map((v, i) => {
    const fraction = Math.max(0, v) / total
    const start = angle
    const end = angle + fraction * 360
    angle = end
    return { d: annulusSegment(opts.cx, opts.cy, opts.radius, inner, start, end), fraction, startAngle: start, endAngle: end, index: i }
  })
}

export function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): Point {
  const a = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
}

/** Filled annulus (donut) segment between outer radius rOuter and inner rInner. */
export function annulusSegment(cx: number, cy: number, rOuter: number, rInner: number, startAngle: number, endAngle: number): string {
  const large = endAngle - startAngle > 180 ? 1 : 0
  const oStart = polarToCartesian(cx, cy, rOuter, startAngle)
  const oEnd = polarToCartesian(cx, cy, rOuter, endAngle)
  const iEnd = polarToCartesian(cx, cy, rInner, endAngle)
  const iStart = polarToCartesian(cx, cy, rInner, startAngle)
  return [
    `M ${round(oStart.x)} ${round(oStart.y)}`,
    `A ${round(rOuter)} ${round(rOuter)} 0 ${large} 1 ${round(oEnd.x)} ${round(oEnd.y)}`,
    `L ${round(iEnd.x)} ${round(iEnd.y)}`,
    `A ${round(rInner)} ${round(rInner)} 0 ${large} 0 ${round(iStart.x)} ${round(iStart.y)}`,
    "Z",
  ].join(" ")
}

function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)) }
function round(n: number): number { return Math.round(n * 100) / 100 }
