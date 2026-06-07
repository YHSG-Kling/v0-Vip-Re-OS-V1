#!/usr/bin/env tsx
/**
 * scripts/chart-geometry-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — chart geometry harness. The Remotion chart components render only
 * with Chromium (Vercel), but their SVG geometry (lib/charts/geometry.ts) is
 * pure math — fully testable here. Proves the price-trend / comps / DOM /
 * affordability chart shapes are correct before a frame is rendered.
 *
 * Run:  npx tsx scripts/chart-geometry-simulator.ts   (npm run test:charts)
 */
import {
  mapRange, niceScale, seriesToPoints, linePath, areaPath,
  verticalBars, horizontalBars, donutArcs, polarToCartesian, annulusSegment,
} from "../lib/charts/geometry"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const approx = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps

function testMapAndScale() {
  console.log("\n[mapRange + niceScale]")
  check("mapRange midpoint", mapRange(5, 0, 10, 0, 100) === 50)
  check("mapRange flat span → outMin (no div0)", mapRange(5, 5, 5, 0, 100) === 0)
  const s = niceScale(412000, 689000, 4)
  check("niceScale rounds min down", s.min <= 412000)
  check("niceScale rounds max up", s.max >= 689000)
  check("niceScale ticks ascending + ≥2", s.ticks.length >= 2 && s.ticks[1] > s.ticks[0])
  check("niceScale step divides ticks evenly", approx(s.ticks[1] - s.ticks[0], s.step))
  const flat = niceScale(100, 100)
  check("niceScale flat domain still valid", flat.ticks.length >= 2 && flat.max > flat.min)
}

function testLine() {
  console.log("\n[PriceTrendLine — seriesToPoints + paths]")
  const vals = [420000, 435000, 428000, 451000, 470000, 489000]
  const pts = seriesToPoints(vals, { width: 600, height: 200, padX: 10, padY: 10 })
  check("point count matches series", pts.length === vals.length)
  check("first x at left pad, last x at right pad", approx(pts[0].x, 10) && approx(pts[pts.length - 1].x, 590))
  check("highest value → smallest y (flipped)", pts[5].y < pts[0].y)
  check("max value sits at top inner edge", approx(Math.min(...pts.map((p) => p.y)), 10))
  const single = seriesToPoints([100], { width: 600, height: 200, padX: 10 })
  check("single point is centered", approx(single[0].x, 300))
  const lp = linePath(pts)
  check("linePath starts with M then L", lp.startsWith("M ") && lp.includes(" L "))
  const ap = areaPath(pts, 190)
  check("areaPath closes with Z", ap.endsWith("Z"))
  check("areaPath drops to baseline", ap.includes(" 190"))
}

function testBars() {
  console.log("\n[CompsBar + DaysOnMarketBars]")
  const vbars = verticalBars([12, 18, 9, 21], { width: 400, height: 200, gap: 0.3 })
  check("vertical bar count", vbars.length === 4)
  check("tallest bar = max value", vbars[3].h >= vbars[0].h && vbars[3].h >= vbars[2].h)
  check("bars don't exceed inner height", vbars.every((b) => b.h <= 200.01))
  check("gap leaves space between bars", vbars[0].w < 400 / 4)
  check("zero value → zero height", verticalBars([0, 10], { width: 100, height: 100 })[0].h === 0)
  const hbars = horizontalBars([625000, 640000, 598000], { width: 500, height: 180, gap: 0.35 })
  check("horizontal: longest bar = max value", hbars[1].w >= hbars[0].w && hbars[1].w >= hbars[2].w)
  check("horizontal: max fills track width", approx(Math.max(...hbars.map((b) => b.w)), 500))
  check("horizontal: bars stacked vertically (y increases)", hbars[0].y < hbars[1].y && hbars[1].y < hbars[2].y)
}

function testDonut() {
  console.log("\n[AffordabilityDonut — donutArcs]")
  const arcs = donutArcs([1800, 420, 180, 100], { cx: 150, cy: 150, radius: 120, thickness: 36 })
  check("one arc per segment", arcs.length === 4)
  check("fractions sum to 1", approx(arcs.reduce((s, a) => s + a.fraction, 0), 1))
  check("biggest segment = biggest input (P&I)", arcs[0].fraction === Math.max(...arcs.map((a) => a.fraction)))
  check("angles run 0 → 360 contiguously", approx(arcs[0].startAngle, 0) && approx(arcs[3].endAngle, 360))
  check("each arc path is an annulus (2 arcs + close)", arcs.every((a) => (a.d.match(/A /g) ?? []).length === 2 && a.d.endsWith("Z")))
  check("zero total → no arcs (guard)", donutArcs([0, 0], { cx: 1, cy: 1, radius: 1, thickness: 1 }).length === 0)
  const top = polarToCartesian(100, 100, 50, 0)
  check("polar 0° = 12 o'clock (straight up)", approx(top.x, 100) && approx(top.y, 50))
  const seg = annulusSegment(100, 100, 50, 30, 0, 90)
  check("annulusSegment is a valid path", seg.startsWith("M ") && seg.includes("A "))
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Chart geometry simulator (Remotion chart layer)")
  console.log("══════════════════════════════════════════════════")
  testMapAndScale(); testLine(); testBars(); testDonut()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ All chart geometry checks passed")
}
main()
