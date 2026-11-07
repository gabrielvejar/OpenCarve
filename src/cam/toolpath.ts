import {
  areaD,
  booleanOpD,
  booleanOpDWithPolyTree,
  ClipType,
  EndType,
  FillRule,
  inflatePathsD,
  JoinType,
  pointInPolygonD,
  PointInPolygonResult,
  PolyTreeD,
  type PathD,
  type PathsD,
  type PolyPathD,
} from 'clipper2-ts'
import { polylineBounds, shapeToPolylines } from '../lib/geometry'
import { effectiveBit, machiningBitRoles, vbitMaxDepth } from '../lib/library'
import { formatLength } from '../lib/units'
import { configuredBitRoles, MAX_STEPOVER, tabsActive, type BitRole, type Cut, type CutSettings, type Point, type Project, type Shape } from '../model'
import { opTimes } from './gcode'
import { medialAxis, SPACING, type MedialPoint } from './vcarve'

export type Pt3 = [number, number, number]
// rapid: G0 at safe Z. plunge: Z move at plunge feed. Otherwise G1 at cutting feed.
export interface Segment {
  points: Pt3[]
  rapid: boolean
  plunge?: boolean
}
export interface Op {
  role: BitRole
  shapeId: string
  shapeIds?: string[] // combined operations; shapeId stays as the primary id for file compatibility
  kind: 'outline' | 'pocket' | 'pocket-edge' | 'pocket-detail' | 'vcarve' | 'vcarve-clear'
  segments: Segment[]
  tabs?: Tab[]
  timeSec?: number // set by planProject
}
// A tab's middle on the tool-centre loop, the loop's direction there (radians from +X) and its raised length.
export type Tab = { x: number; y: number; angle: number; width: number }
export const opShapeIds = (o: Op) => o.shapeIds ?? [o.shapeId]
export const opKey = (o: Op) => `${opShapeIds(o).join(',')}:${o.kind}:${o.role}`

export interface CamResult {
  ops: Op[]
  shapes?: Shape[] // the project's shapes it was planned from (set on the main thread; the worker only sees copies)
  warnings: string[]
  timeSec: Partial<Record<BitRole, number>>
}

const PRECISION = 3 // decimals, 0.001 mm
const ARC_TOLERANCE = 0.01 // mm
const SLIVER = 0.02 // mm; rest-machining leftovers thinner than this are float noise

const fillRule = (s: Shape) => (s.fillRule === 'evenodd' ? FillRule.EvenOdd : FillRule.NonZero)
const boolean = (type: ClipType, a: PathsD, b: PathsD | null) => booleanOpD(type, a, b, FillRule.NonZero, PRECISION)
export const inflate = (paths: PathsD, delta: number) =>
  delta ? inflatePathsD(paths, delta, JoinType.Round, EndType.Polygon, 2, PRECISION, ARC_TOLERANCE) : paths

// Filled area of the closed contours; outers have positive area (CCW, Y up), holes negative.
export function shapeRegion(shape: Shape): PathsD {
  const closed = shapeToPolylines(shape)
    .filter((p) => p.closed && p.points.length > 2)
    .map((p) => p.points.map(([x, y]) => ({ x, y })))
  return booleanOpD(ClipType.Union, closed, null, fillRule(shape), PRECISION)
}

// Each outer contour with its direct holes; islands inside holes become their own entries.
function islands(region: PathsD): PathsD[] {
  const tree = new PolyTreeD()
  booleanOpDWithPolyTree(ClipType.Union, region, null, tree, FillRule.NonZero, PRECISION)
  const out: PathsD[] = []
  const walk = (outer: PolyPathD) => {
    const island = [outer.poly!]
    for (let i = 0; i < outer.count; i++) {
      const hole = outer.child(i)
      island.push(hole.poly!)
      for (let j = 0; j < hole.count; j++) walk(hole.child(j))
    }
    out.push(island)
  }
  for (let i = 0; i < tree.count; i++) walk(tree.child(i))
  return out
}

// Morphological opening: what a disc of radius d can reach.
const opening = (p: PathsD, d: number) => inflate(inflate(p, -d), d)

// A pocket radius is a morphological opening: it rounds convex corners inward without moving straight walls.
export const roundPocket = (region: PathsD, radius: number) => opening(region, radius)

export const outlinePaths = (region: PathsD, side: Cut['side'], r: number) => inflate(region, side === 'on' ? 0 : side === 'outside' ? r : -r)

// Tool-centre rings, innermost first; the last one (offset -r) is the finishing wall.
export function pocketRings(region: PathsD, r: number, step: number): PathsD[] {
  const rings: PathsD[] = []
  for (let d = r; ; d += step) {
    const ring = inflate(region, -d)
    if (!ring.length) break
    rings.push(ring)
  }
  return rings.reverse()
}

// Spindle turns clockwise seen from above, so climb milling keeps the finished wall on the tool's right:
// outside contours (wall inside the path) run CW, inside contours CCW. Conventional is the reverse.
export function orient(path: PathD, outside: boolean, direction: CutSettings['direction']): PathD {
  const cw = outside === (direction === 'climb')
  return areaD(path) < 0 === cw ? path : [...path].reverse()
}

export function zLevels(depth: number, stepdown: number): number[] {
  const n = Math.max(1, Math.ceil(depth / stepdown - 1e-9))
  return Array.from({ length: n }, (_, i) => -Math.min(depth, (i + 1) * stepdown))
}

const closedPts = (path: PathD): Point[] => [...path, path[0]].map((p): Point => [p.x, p.y])

function arcLengths(pts: Point[]) {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  return cum
}

const lerpPt = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

const CORNER = (20 * Math.PI) / 180 // turning within a tab width around a point that makes it a corner

// Point and direction at arc length c along pts.
function pointAt(pts: Point[], cum: number[], c: number) {
  const j = Math.max(1, cum.findIndex((a) => a >= c))
  const [a, b] = [pts[j - 1], pts[j]]
  return { j, p: lerpPt(a, b, cum[j] > cum[j - 1] ? (c - cum[j - 1]) / (cum[j] - cum[j - 1]) : 0), angle: Math.atan2(b[1] - a[1], b[0] - a[0]) }
}

// Tabs on one closed tool-centre loop: the shape's tabCount on its longest loop (longest), proportionally fewer on
// shorter ones but at least one, evenly spaced by arc length starting half a spacing in. At most half the loop is
// tab; a loop under 2 tab widths gets one tab of up to half its length, one under a tab width none.
// A tab on a corner leaves a sliver, so each tab whose span meets a corner (turning over a tab width around a point
// above CORNER; offset corners are arcs of many small segments, hence the window) moves to the nearest corner-free
// span within half a spacing, clear of the other tabs; failing that it stays put, so circles keep even spacing.
// If a tab then covers the loop's start, the loop restarts in the widest gap so the plunge never lands on one.
export function loopTabs(pts: Point[], count: number, longest: number, width: number) {
  let cum = arcLengths(pts)
  const total = cum.at(-1)!
  if (total < width) return { pts, centres: [], width, tabs: [] }
  const w = Math.min(width, total / 2)
  const n = Math.max(1, Math.min(Math.round((count * total) / longest), Math.floor(total / 2 / w)))
  const spacing = total / n
  // Corner flags on a grid of step h: each vertex's turning counts for every grid point within w/2 of it.
  const m = Math.max(1, Math.ceil(total / Math.min(w / 8, 0.25)))
  const h = total / m
  const turn = new Float64Array(m)
  let prev = -1
  for (let i = pts.length - 2; i >= 0 && prev < 0; i--) if (cum[i + 1] > cum[i]) prev = i
  for (let i = 0; i < pts.length - 1; i++) {
    if (cum[i + 1] <= cum[i]) continue
    const d = (i: number) => Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0])
    const a = Math.abs(((d(i) - d(prev) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
    prev = i
    for (let k = Math.ceil((cum[i] - w / 2) / h); k <= Math.floor((cum[i] + w / 2) / h); k++) turn[((k % m) + m) % m] += a
  }
  // prefix[k]: corner grid points before k, over two laps so spans can wrap.
  const prefix = [0]
  for (let k = 0; k < 2 * m; k++) prefix.push(prefix[k] + (turn[k % m] > CORNER ? 1 : 0))
  const free = (c: number) => {
    const start = (((c - w / 2) % total) + total) % total
    return prefix[Math.floor((start + w) / h) + 1] === prefix[Math.ceil(start / h)]
  }
  const gap = (a: number, b: number) => Math.min(Math.abs(a - b), total - Math.abs(a - b))
  const clear = (c: number, placed: number[]) => placed.every((q) => gap(c, q) >= w)
  let centres: number[] = []
  for (let i = 0; i < n; i++) {
    const c = (i + 0.5) * spacing
    let best = free(c) && clear(c, centres) ? c : null
    for (let d = h; best === null && d <= spacing / 2; d += h)
      for (const e of [(c + d) % total, (c - d + total) % total]) if (best === null && free(e) && clear(e, centres)) best = e
    best ??= clear(c, centres) ? c : null
    if (best !== null) centres.push(best)
  }
  centres.sort((a, b) => a - b)
  if (centres.some((c) => gap(c, 0) < w / 2)) {
    let s0 = 0
    let widest = -1
    centres.forEach((a, i) => {
      const b = i + 1 < centres.length ? centres[i + 1] : centres[0] + total
      if (b - a > widest) [widest, s0] = [b - a, (a + (b - a) / 2) % total]
    })
    const { j, p } = pointAt(pts, cum, s0)
    pts = [p, ...pts.slice(j, -1), ...pts.slice(0, j), p]
    cum = arcLengths(pts)
    centres = centres.map((c) => (c - s0 + total) % total).sort((a, b) => a - b)
  }
  const tabs = centres.map((c): Tab => {
    const { p, angle } = pointAt(pts, cum, c)
    return { x: p[0], y: p[1], angle, width: w }
  })
  return { pts, centres, width: w, tabs }
}

// Raises Z to tabZ over width around each centre (arc length along the closed loop pts).
export function withTabs(pts: Point[], z: number, tabZ: number, centres: number[], width: number): Pt3[] {
  const cum = arcLengths(pts)
  const total = cum.at(-1)!
  const events = centres
    .flatMap((c): [number, number][] => [
      [Math.max(0, c - width / 2), 1],
      [Math.min(total, c + width / 2), -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let up = 0
  let i = 1
  const zNow = () => (up > 0 ? tabZ : z)
  const out: Pt3[] = [[...pts[0], z]]
  for (const [s, step] of events) {
    for (; i < pts.length - 1 && cum[i] < s; i++) out.push([...pts[i], zNow()])
    const seg = cum[i] - cum[i - 1]
    const p = lerpPt(pts[i - 1], pts[i], seg ? (s - cum[i - 1]) / seg : 0)
    out.push([...p, zNow()])
    up += step
    out.push([...p, zNow()])
  }
  for (; i < pts.length; i++) out.push([...pts[i], zNow()])
  return out
}

// A feed move at depth is safe if it stays inside the tool-centre region (the finishing wall).
function inside([x, y]: Point, paths: PathsD) {
  let w = 0
  for (const path of paths) {
    const r = pointInPolygonD({ x, y }, path, PRECISION)
    const outer = areaD(path) > 0
    if (r === PointInPolygonResult.IsInside || (r === PointInPolygonResult.IsOn && outer)) w += outer ? 1 : -1
  }
  return w > 0
}

const safeLink = (a: Point, b: Point, wall: PathsD) => !crosses(a, b, wall) && inside(lerpPt(a, b, 0.5), wall)

// True if segment ab properly crosses any edge of paths (touching at a or b doesn't count).
function crosses(a: Point, b: Point, paths: PathsD): boolean {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const p = path[i]
      const q = path[(i + 1) % path.length]
      const ex = q.x - p.x
      const ey = q.y - p.y
      const d = dx * ey - dy * ex
      if (Math.abs(d) < 1e-12) continue
      const t = ((p.x - a[0]) * ey - (p.y - a[1]) * ex) / d
      const u = ((p.x - a[0]) * dy - (p.y - a[1]) * dx) / d
      if (t > 1e-6 && t < 1 - 1e-6 && u >= 0 && u <= 1) return true
    }
  }
  return false
}

function linker(safeZ: number) {
  const segments: Segment[] = []
  let cur: Pt3 | null = null
  return {
    segments,
    get cur() {
      return cur
    },
    // direct: feed straight across at the current depth (only through cleared area) instead of retracting.
    moveTo(p: Pt3, direct: boolean) {
      let z = safeZ
      if (cur && direct) {
        z = cur[2]
        if (cur[0] !== p[0] || cur[1] !== p[1]) segments.push({ rapid: false, points: [[p[0], p[1], z]] })
      } else segments.push({ rapid: true, points: [...(cur ? [[cur[0], cur[1], safeZ] as Pt3] : []), [p[0], p[1], safeZ]] })
      if (z !== p[2]) segments.push({ rapid: false, plunge: true, points: [p] })
      cur = p
    },
    cut(points: Pt3[]) {
      if (!points.length) return
      segments.push({ rapid: false, points })
      cur = points.at(-1)!
    },
    finish() {
      if (cur) segments.push({ rapid: true, points: [[cur[0], cur[1], safeZ]] })
      return segments
    },
  }
}

function pocketSegments(region: PathsD, r: number, s: CutSettings, depth: number) {
  const plan = pocketPlan(region, r, s)
  const L = linker(s.safeZ)
  for (const z of zLevels(depth, s.stepdown)) cutPocketLevel(plan, L, z)
  return L.finish()
}

function pocketPlan(region: PathsD, r: number, s: CutSettings) {
  return islands(region)
    .map((island) => {
      const rings = pocketRings(island, r, Math.min(MAX_STEPOVER, s.stepover) * 2 * r)
      return { wall: rings.at(-1) ?? [], rings: rings.map((level) => level.map((p) => closedPts(orient(p, areaD(p) < 0, s.direction)))) }
    })
    .filter((isl) => isl.rings.length)
}

function cutPocketLevel(plan: ReturnType<typeof pocketPlan>, L: ReturnType<typeof linker>, z: number) {
  let prev: (typeof plan)[number] | null = null
  for (const isl of plan) {
    for (const ring of isl.rings.flat()) {
      const c = L.cur
      L.moveTo([...ring[0], z], prev === isl && !!c && safeLink([c[0], c[1]], ring[0], isl.wall))
      L.cut(ring.slice(1).map((p): Pt3 => [...p, z]))
      prev = isl
    }
  }
}

const rotatePoint = (p: { x: number; y: number }, angle: number) => {
  const [c, s] = [Math.cos(angle), Math.sin(angle)]
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

function rasterPaths(island: PathsD, step: number, angle: number) {
  const rotated = island.map((path) => path.map((p) => rotatePoint(p, -angle)))
  const ys = rotated.flat().map((p) => p.y)
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)]
  const count = Math.max(1, Math.ceil((maxY - minY) / step))
  const spacing = (maxY - minY) / count
  const paths: Point[][] = []
  for (let row = 0; row < count; row++) {
    const y = minY + (row + 0.5) * spacing
    const xs: number[] = []
    for (const path of rotated) {
      for (let i = 0; i < path.length; i++) {
        const [a, b] = [path[i], path[(i + 1) % path.length]]
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y))
      }
    }
    xs.sort((a, b) => a - b)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const line = [rotatePoint({ x: xs[i], y }, angle), rotatePoint({ x: xs[i + 1], y }, angle)].map((p): Point => [p.x, p.y])
      paths.push((row + i / 2) % 2 ? line.reverse() : line)
    }
  }
  return paths
}

function clipSegment(a: Point, b: Point, wall: PathsD): Point[][] {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const ts = [0, 1]
  for (const path of wall) {
    for (let i = 0; i < path.length; i++) {
      const [p, q] = [path[i], path[(i + 1) % path.length]]
      const [ex, ey] = [q.x - p.x, q.y - p.y]
      const den = dx * ey - dy * ex
      if (Math.abs(den) < 1e-12) continue
      const t = ((p.x - a[0]) * ey - (p.y - a[1]) * ex) / den
      const u = ((p.x - a[0]) * dy - (p.y - a[1]) * dx) / den
      if (t > 1e-9 && t < 1 - 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t)
    }
  }
  ts.sort((a, b) => a - b)
  const unique = ts.filter((t, i) => !i || t - ts[i - 1] > 1e-9)
  const at = (t: number): Point => [a[0] + t * dx, a[1] + t * dy]
  return unique.slice(1).flatMap((hi, i) => (inside(at((unique[i] + hi) / 2), wall) ? [[at(unique[i]), at(hi)]] : []))
}

function radialPaths(island: PathsD, step: number, angle: number) {
  const pts = island.flat()
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const centre: Point = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
  const radius = Math.max(...pts.map((p) => Math.hypot(p.x - centre[0], p.y - centre[1]))) + step
  const count = Math.max(1, Math.ceil((Math.PI * radius) / step))
  return Array.from({ length: count }, (_, i) => angle + (i * Math.PI) / count).flatMap((a, i) => {
    const [dx, dy] = [Math.cos(a) * radius, Math.sin(a) * radius]
    const pieces = clipSegment([centre[0] - dx, centre[1] - dy], [centre[0] + dx, centre[1] + dy], island)
    return i % 2 ? pieces.map((p) => p.reverse()) : pieces
  })
}

function spiralPaths(island: PathsD, step: number, angle: number, direction: CutSettings['direction']) {
  const pts = island.flat()
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const centre: Point = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
  const radius = Math.max(...pts.map((p) => Math.hypot(p.x - centre[0], p.y - centre[1]))) + step
  const thetaMax = (2 * Math.PI * radius) / step
  const sign = direction === 'climb' ? 1 : -1
  const raw: Point[] = [centre]
  let theta = 0
  while (theta < thetaMax) {
    const r = (step * theta) / (2 * Math.PI)
    const segment = Math.max(0.25, Math.min(1, step))
    theta = Math.min(thetaMax, theta + Math.min(0.25, segment / Math.max(r, step / (2 * Math.PI))))
    const nextR = (step * theta) / (2 * Math.PI)
    const a = angle + sign * theta
    raw.push([centre[0] + nextR * Math.cos(a), centre[1] + nextR * Math.sin(a)])
  }
  const paths: Point[][] = []
  for (let i = 1; i < raw.length; i++) {
    for (const piece of clipSegment(raw[i - 1], raw[i], island)) {
      const last = paths.at(-1)
      if (last && Math.hypot(last.at(-1)![0] - piece[0][0], last.at(-1)![1] - piece[0][1]) < 1e-6) last.push(piece[1])
      else paths.push(piece)
    }
  }
  return paths
}

function patternedPocketPlan(region: PathsD, r: number, s: CutSettings, pattern: Cut['pocketPattern'], degrees: number) {
  const angle = (degrees * Math.PI) / 180
  const step = Math.min(MAX_STEPOVER, s.stepover) * 2 * r
  return islands(inflate(region, -r)).map((island) => {
    const paths =
      pattern === 'raster'
        ? rasterPaths(island, step, angle)
        : pattern === 'crosshatch'
          ? [...rasterPaths(island, step, angle), ...rasterPaths(island, step, angle + Math.PI / 2)]
          : pattern === 'radial'
            ? radialPaths(island, step, angle)
            : spiralPaths(island, step, angle, s.direction)
    // Finish on the exact tool-centre wall after the pattern has cleared the interior.
    paths.push(...island.map((p) => closedPts(orient(p, areaD(p) < 0, s.direction))))
    return { wall: island, paths }
  })
}

function cutPatternLevel(plan: ReturnType<typeof patternedPocketPlan>, L: ReturnType<typeof linker>, z: number) {
  for (const island of plan) {
    let previous = false
    for (const path of island.paths) {
      const c = L.cur
      L.moveTo([...path[0], z], previous && !!c && safeLink([c[0], c[1]], path[0], island.wall))
      L.cut(path.slice(1).map((p): Pt3 => [...p, z]))
      previous = true
    }
  }
}

type ProfiledPocket = {
  region: PathsD
  profileRegion: PathsD
  depth: number
  fillet: Cut['pocketFillet']
  filletRadius: number
  filletStepdown: number
}

// Horizontal inset of the pocket boundary at a positive depth from the stock top. Concave is tangent to the
// vertical wall and floor; Convex is the agreed machinable opposite-curvature ramp rather than an undercut.
export function pocketFilletInset(mode: Cut['pocketFillet'], radius: number, pocketDepth: number, depth: number) {
  const r = Math.min(Math.max(0, radius), pocketDepth)
  if (mode === 'none' || !r || depth <= pocketDepth - r) return 0
  const t = Math.min(1, Math.max(0, (depth - (pocketDepth - r)) / r))
  return mode === 'concave' ? r * (1 - Math.sqrt(Math.max(0, 1 - t * t))) : r * Math.sqrt(Math.max(0, 1 - (1 - t) ** 2))
}

const profiledRegion = (pocket: ProfiledPocket, depth: number) => {
  const inset = pocketFilletInset(pocket.fillet, pocket.filletRadius, pocket.depth, depth)
  return inset ? boolean(ClipType.Intersection, pocket.region, inflate(pocket.profileRegion, -inset)) : pocket.region
}

const pocketLevels = (pocket: ProfiledPocket, stepdown: number) => {
  const levels = zLevels(pocket.depth, stepdown).map((z) => -z)
  const r = Math.min(pocket.filletRadius, pocket.depth)
  if (pocket.fillet === 'none' || !r) return levels
  const step = pocket.filletStepdown > 0 ? Math.min(stepdown, pocket.filletStepdown) : stepdown
  if (step >= stepdown - 1e-9) return levels
  for (let depth = pocket.depth - r + step; depth < pocket.depth - 1e-9; depth += step) levels.push(depth)
  return levels
}

// Plans overlapping pockets as one depth field. At each Z level the active region is the union of every pocket
// whose requested depth reaches that level, so shared material is cleared once instead of once per shape.
function layeredPocketSegments(pockets: ProfiledPocket[], r: number, s: CutSettings, pattern: Cut['pocketPattern'] = 'concentric', angle = 0) {
  const raw = pockets.flatMap((p) => pocketLevels(p, s.stepdown)).sort((a, b) => a - b)
  const levels = raw.filter((d, i) => !i || d - raw[i - 1] > 1e-9)
  const L = linker(s.safeZ)
  for (const depth of levels) {
    const active = pockets.filter((p) => p.depth + 1e-9 >= depth).flatMap((p) => profiledRegion(p, depth))
    const region = boolean(ClipType.Union, active, null)
    if (pattern !== 'concentric') cutPatternLevel(patternedPocketPlan(region, r, s, pattern, angle), L, -depth)
    else cutPocketLevel(pocketPlan(region, r, s), L, -depth)
  }
  return L.finish()
}

// Scores every current pocket wall, including hole/island boundaries, before a wider bit reaches it.
function pocketEdgeSegments(pockets: ProfiledPocket[], r: number, s: CutSettings) {
  const raw = pockets.flatMap((p) => pocketLevels(p, s.stepdown)).sort((a, b) => a - b)
  const levels = raw.filter((d, i) => !i || d - raw[i - 1] > 1e-9)
  const L = linker(s.safeZ)
  for (const depth of levels) {
    const active = pockets.filter((p) => p.depth + 1e-9 >= depth).flatMap((p) => profiledRegion(p, depth))
    for (const path of inflate(boolean(ClipType.Union, active, null), -r)) {
      const points = closedPts(orient(path, areaD(path) < 0, s.direction))
      L.moveTo([...points[0], -depth], false)
      L.cut(points.slice(1).map((p): Pt3 => [...p, -depth]))
    }
  }
  return L.finish()
}

// Parts of a medial chain with lo < clearance <= hi (clearance is linear along each segment).
function clipBand(pts: MedialPoint[], lo: number, hi: number): MedialPoint[][] {
  const out: MedialPoint[][] = []
  let cur: MedialPoint[] | null = null
  const at = (a: MedialPoint, b: MedialPoint, t: number): MedialPoint => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
  const inBand = (c: number) => c > lo && c <= hi
  if (inBand(pts[0][2])) out.push((cur = [pts[0]]))
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]]
    const dc = b[2] - a[2]
    let [t0, t1] = [0, 1]
    if (dc) {
      const [u, v] = [(lo - a[2]) / dc, (hi - a[2]) / dc]
      t0 = Math.max(0, Math.min(u, v))
      t1 = Math.min(1, Math.max(u, v))
    } else if (!inBand(a[2])) t1 = -1
    if (t1 <= t0) {
      cur = null
      continue
    }
    if (!cur || t0 > 0) out.push((cur = [at(a, b, t0)]))
    cur.push(at(a, b, t1))
    if (t1 < 1) cur = null
  }
  return out.filter((p) => p.length > 1)
}

// Nearest-neighbour order; open paths may be reversed, closed loops (first = last) restarted at any vertex.
function nearestOrder(open: Pt3[][], loops: Pt3[][], from: Pt3 | null): Pt3[][] {
  const pool = [...open.map((p) => ({ p, loop: false })), ...loops.map((p) => ({ p, loop: true }))]
  const d2 = (a: Pt3, b: Pt3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
  const out: Pt3[][] = []
  let here = from ?? pool[0]?.p[0]
  while (pool.length) {
    let [best, bd, rev] = [0, Infinity, false]
    pool.forEach(({ p, loop }, i) => {
      if (d2(here, p[0]) < bd) [best, bd, rev] = [i, d2(here, p[0]), false]
      if (!loop && d2(here, p.at(-1)!) < bd) [best, bd, rev] = [i, d2(here, p.at(-1)!), true]
    })
    const { loop } = pool[best]
    let { p } = pool[best]
    pool[best] = pool.at(-1)!
    pool.pop()
    if (rev) p = [...p].reverse()
    if (loop) {
      let j = 0
      p.forEach((q, i) => d2(here, q) < d2(here, p[j]) && (j = i))
      p = [...p.slice(j, -1), ...p.slice(0, j), p[j]]
    }
    out.push(p)
    here = p.at(-1)!
  }
  return out
}

// V-bit with tan(half angle) k and tip flat radius f: at depth |z| it reaches f + |z|·k sideways. Pass i cuts the
// medial axis where its depth (c − f)/k falls in (z_{i-1}, z_i], and the contour of the region shrunk by f + |z_i|·k
// at z_i; the last contour outlines the flat floor at dmax. Medial parts narrower than the flat (c < f) are skipped.
function vcarveSegments(region: PathsD, chains: MedialPoint[][], k: number, f: number, dmax: number, s: CutSettings) {
  const L = linker(s.safeZ)
  zLevels(dmax, s.stepdown).forEach((z, i, zs) => {
    const hi = f - z * k
    const lo = i ? f - zs[i - 1] * k : f || -1
    const open = chains.flatMap((c) => clipBand(c, lo, hi)).map((c) => c.map(([x, y, cl]): Pt3 => [x, y, -Math.max(0, cl - f) / k]))
    const loops = inflate(region, -hi).map((p) => closedPts(orient(p, areaD(p) < 0, s.direction)).map((q): Pt3 => [...q, z]))
    for (const path of nearestOrder(open, loops, L.cur)) {
      const c = L.cur
      L.moveTo(path[0], !!c && Math.hypot(c[0] - path[0][0], c[1] - path[0][1]) < 0.05)
      L.cut(path.slice(1))
    }
  })
  return L.finish()
}

// Every corner's medial branch dips below the flat within f/sin(θ/2) of the corner; a longer stretch is a real
// feature narrower than the flat. ponytail: length heuristic, misses narrow features shorter than 4·f.
const narrowerThanFlat = (chains: MedialPoint[][], f: number) =>
  f > 0 && chains.some((c) => clipBand(c, -1, f).some((piece) => piece.reduce((a, q, i) => a + (i ? Math.hypot(q[0] - piece[i - 1][0], q[1] - piece[i - 1][1]) : 0), 0) > 4 * f))

export function planProject(project: Project): CamResult {
  const { stock, cutSettings, machine } = project
  const t = stock.thickness
  const ops: Op[] = []
  const last: Op[] = [] // through outlines not cut inside, run after everything else so parts aren't freed early
  const freedRoles = new Set<BitRole>() // roles with a held-back outline that has no tabs
  const warnings: string[] = []
  if (stock.w > machine.w || stock.h > machine.h) {
    const size = (w: number, h: number) => `${+formatLength(w, project.units)}×${+formatLength(h, project.units)} ${project.units}`
    warnings.push(`Stock (${size(stock.w, stock.h)}) is larger than the machine work area (${size(machine.w, machine.h)})`)
  }
  const carved = project.shapes.filter((s) => s.cut)
  const roles = configuredBitRoles(project)
  const tools = roles.map((role) => ({ role, bit: effectiveBit(project, role), settings: cutSettings[role]! }))
  const toolByRole = new Map(tools.map((tool) => [tool.role, tool]))
  const machiningRoles = machiningBitRoles(project)
  const machiningTools = machiningRoles.map((role) => toolByRole.get(role)!)
  const flatTools = machiningTools.filter((tool) => tool.bit.type !== 'vbit')
  const automaticPocketTools = flatTools.length ? flatTools : machiningTools
  const automaticOutlineTool = automaticPocketTools[0] ?? tools[0]
  const vTool = [...tools].reverse().find((tool) => tool.bit.type === 'vbit') ?? null
  const pocketShapes = carved
    .filter((s) => s.cut!.type === 'pocket')
    .map((shape) => {
      const source = shapeRegion(shape)
      const region = roundPocket(source, shape.cut!.pocketRadius)
      const depth = Math.min(shape.cut!.depth, t)
      const filletRadius = Math.min(shape.cut!.pocketFilletRadius, depth)
      if (source.length && !region.length) warnings.push(`Corner radius too large for ${shape.name}`)
      if (region.length && shape.cut!.pocketFillet !== 'none' && filletRadius && !inflate(region, -filletRadius).length)
        warnings.push(`Bottom fillet radius too large for ${shape.name}`)
      return { shape, region, profileRegion: region, depth, fillet: shape.cut!.pocketFillet, filletRadius, filletStepdown: shape.cut!.pocketFilletStepdown }
    })
  const pocketRegions = new Map(pocketShapes.map((p) => [p.shape.id, p.region]))
  const pockets = pocketShapes.filter((p) => p.region.length)
  const precutPockets = pockets.filter((p) => p.shape.cut!.pocketPrecut && p.shape.cut!.bit === 'auto')
  const edgeTool = flatTools.length > 1 && flatTools[0].bit.diameter > flatTools.at(-1)!.bit.diameter + 1e-9 ? flatTools.at(-1)! : null
  type PocketJob = (typeof pockets)[number] & { full: boolean }
  const pocketJobs = new Map<BitRole, PocketJob[]>()
  const addPocket = (role: BitRole, job: PocketJob) => pocketJobs.set(role, [...(pocketJobs.get(role) ?? []), job])
  for (const pocket of pockets) {
    const selected = pocket.shape.cut!.bit === 'auto' ? automaticPocketTools : [toolByRole.get(pocket.shape.cut!.bit)!].filter(Boolean)
    let previousRadius: number | null = null
    selected.forEach((tool) => {
      const radius = tool.bit.diameter / 2
      if (previousRadius !== null && radius >= previousRadius - 1e-9) return
      let region = pocket.region
      const full = previousRadius === null || pocket.shape.cut!.bit !== 'auto'
      if (!full) {
        const rest = opening(boolean(ClipType.Difference, pocket.region, opening(pocket.region, previousRadius!)), SLIVER)
        region = boolean(ClipType.Intersection, pocket.region, inflate(rest, 2 * radius))
      }
      if (inflate(region, -radius).length) {
        addPocket(tool.role, { ...pocket, region, full })
        previousRadius = radius
      }
    })
  }
  const pocketGroups = (jobs: PocketJob[]) => {
    const groups = new Map<string, { jobs: PocketJob[]; pattern: Cut['pocketPattern']; angle: number }>()
    for (const job of jobs) {
      const pattern = job.shape.cut!.pocketPattern
      const angle = pattern === 'raster' || pattern === 'crosshatch' || pattern === 'radial' ? job.shape.cut!.pocketAngle : 0
      const key = `${pattern}:${angle.toFixed(6)}`
      const group = groups.get(key) ?? { jobs: [], pattern, angle }
      group.jobs.push(job)
      groups.set(key, group)
    }
    return [...groups.values()]
  }
  let pocketsPlanned = false
  if (edgeTool && precutPockets.length) {
    const segments = pocketEdgeSegments(precutPockets, edgeTool.bit.diameter / 2, edgeTool.settings)
    if (segments.length) ops.push({ role: edgeTool.role, shapeId: precutPockets[0].shape.id, shapeIds: precutPockets.map((p) => p.shape.id), kind: 'pocket-edge', segments })
  }

  for (const shape of carved) {
    const cut = shape.cut!
    const selectedTool = cut.bit === 'auto' ? vTool : toolByRole.get(cut.bit) ?? null
    const selectedVRole = selectedTool?.role ?? null
    const selectedVBit = selectedTool?.bit ?? null
    if (cut.bit !== 'auto' && !selectedTool) {
      warnings.push(`${shape.name} needs its selected bit`)
      continue
    }
    if (cut.type === 'vcarve' && (!selectedVRole || selectedVBit?.type !== 'vbit')) {
      warnings.push(cut.bit === 'auto' ? 'V-carve needs a V-bit' : `${shape.name} needs a V-bit as the ${cut.bit} bit`)
      continue
    }
    if (cut.type !== 'vcarve' && cut.depth > t + 1e-9) warnings.push(`${shape.name} is deeper than the stock`)
    const depth = Math.min(cut.depth, t)
    const polys = shapeToPolylines(shape)
    if (!polys.length) {
      warnings.push(`Font still loading for ${shape.name}`)
      continue
    }
    const b = polylineBounds(polys)
    if (b.minX < 0 || b.minY < 0 || b.maxX > stock.w || b.maxY > stock.h) warnings.push(`${shape.name} is partly outside the stock`)
    const region = pocketRegions.get(shape.id) ?? shapeRegion(shape)
    const tooLarge = `Bit too large for ${shape.name}`
    const push = (list: Op[], role: BitRole, kind: Op['kind'], segments: Segment[], tabs: Tab[] = [], shapeIds: string[] = [shape.id]) =>
      segments.length && list.push({ role, shapeId: shapeIds[0], ...(shapeIds.length > 1 && { shapeIds }), kind, segments, ...(tabs.length && { tabs }) })

    if (cut.type === 'pocket' && cut.pocketPrecut && (cut.bit !== 'auto' || !edgeTool))
      warnings.push(`Edge pre-cut for ${shape.name} needs Automatic bit usage and two different-sized non-V bits`)

    if (cut.type === 'vcarve') {
      const vs = cutSettings[selectedVRole!]!
      const vBit = selectedVBit!
      const k = Math.tan((vBit.angle! * Math.PI) / 360)
      const f = (vBit.flat ?? 0) / 2 // Bit.flat is a diameter
      const coneDepth = vbitMaxDepth(vBit) // the UI clamps to this; files and bit edits can still exceed it
      const dmax = Math.min(cut.depth, t - 0.5, coneDepth) // never through
      if (coneDepth < Math.min(cut.depth, t - 0.5))
        warnings.push(`${shape.name}: max depth limited to ${+formatLength(coneDepth, project.units)} ${project.units} by the V-bit's diameter`)
      // The flat floor at dmax ends where the V-bit's wall meets it (inset dmax·k); the V-bit's centre stays a further f in.
      const floor = inflate(region, -dmax * k)
      if (floor.length) {
        // Flat floor: the other bit if it's a flat-ish cutter that fits, then the V-bit over what it can't reach
        // (corners, necks). V-bit rings (radius f + 0.4·tan(α/2), stepover ½): for a sharp tip, ridges of about 0.2 mm,
        // up to ~0.35 mm at corners; a flat tip only makes them lower.
        const vRings = (area: PathsD) => pocketSegments(area, f + 2 * 0.2 * k, { ...vs, stepover: MAX_STEPOVER }, dmax)
        const clearingTool = cut.bit === 'auto' ? flatTools.find((tool) => inflate(floor, -tool.bit.diameter / 2).length) ?? null : null
        const oRole = clearingTool?.role
        const or = clearingTool ? clearingTool.bit.diameter / 2 : 0
        if (or && inflate(floor, -or).length) {
          push(ops, oRole!, 'vcarve-clear', pocketSegments(floor, or, clearingTool!.settings, dmax))
          const rest = opening(boolean(ClipType.Difference, floor, opening(floor, or)), SLIVER)
          if (rest.length) push(ops, selectedVRole!, 'vcarve-clear', vRings(boolean(ClipType.Intersection, floor, inflate(rest, 2 * (f + 0.4 * k)))))
        } else {
          if (cut.bit === 'auto') warnings.push(flatTools.length ? `The endmill is too large for the floor of ${shape.name}; the V-bit clears it` : 'Add a flat endmill for a smoother V-carve floor')
          push(ops, selectedVRole!, 'vcarve-clear', vRings(floor))
        }
      }
      const { chains, spacing } = medialAxis(region)
      if (spacing > SPACING) warnings.push(`${shape.name} is very large; its V-carve is less detailed`)
      if (narrowerThanFlat(chains, f)) warnings.push(`Some details of ${shape.name} are narrower than the V-bit's flat tip`)
      push(ops, selectedVRole!, 'vcarve', vcarveSegments(region, chains, k, f, dmax, vs))
      continue
    }

    if (cut.type === 'outline') {
      const outlineTool = cut.bit === 'auto' ? automaticOutlineTool : toolByRole.get(cut.bit)!
      const { role, bit: roleBit, settings } = outlineTool
      const radius = roleBit.diameter / 2
      const paths = outlinePaths(region, cut.side, radius)
      const inside = cut.side === 'inside'
      if (inside && region.length && !paths.length) warnings.push(tooLarge)
      else if (inside && paths.length < region.length) warnings.push(`Bit too large for parts of ${shape.name}`)
      const tabZ = tabsActive(cut, t) ? -(t - cut.tabHeight) : null
      const zs = zLevels(depth, settings.stepdown)
      const loops = paths.map((path) => closedPts(orient(path, areaD(path) > 0 !== inside, settings.direction)))
      const longest = Math.max(...loops.map((l) => arcLengths(l).at(-1)!))
      const tabs: Tab[] = []
      const L = linker(settings.safeZ)
      loops.forEach((pts, k) => {
        const lt = tabZ === null ? null : loopTabs(pts, cut.tabCount, longest, cut.tabWidth)
        if (lt && !lt.centres.length)
          warnings.push(cut.side === 'outside' && areaD(paths[k]) > 0 ? `A piece of ${shape.name} is too small for a tab and will come loose` : `Loop too small for a tab in ${shape.name}`)
        tabs.push(...(lt?.tabs ?? []))
        const loop = lt?.pts ?? pts
        zs.forEach((z, i) => {
          const pass = lt?.centres.length && z < tabZ! ? withTabs(loop, z, tabZ!, lt.centres, lt.width) : loop.map((p): Pt3 => [...p, z])
          L.moveTo(pass[0], i > 0)
          L.cut(pass.slice(1))
        })
      })
      // Open paths retract between passes: going back to the start at depth would cut through stock.
      for (const { points } of cut.side === 'on' ? polys.filter((p) => !p.closed) : []) {
        for (const z of zs) {
          L.moveTo([...points[0], z], false)
          L.cut(points.slice(1).map((p): Pt3 => [...p, z]))
        }
      }
      const holdBack = cut.side !== 'inside' && cut.depth >= t
      if (holdBack && tabZ === null) freedRoles.add(role)
      push(holdBack ? last : ops, role, 'outline', L.finish(), tabs)
      continue
    }

    if (!pocketsPlanned) {
      pocketsPlanned = true
      const pocketRoleOrder = [...automaticPocketTools.map((tool) => tool.role), ...roles.filter((role) => !automaticPocketTools.some((tool) => tool.role === role))]
      for (const role of pocketRoleOrder) {
        const tool = toolByRole.get(role)!
        for (const group of pocketGroups(pocketJobs.get(role) ?? [])) {
          const kind = group.jobs.some((p) => p.full) ? 'pocket' : 'pocket-detail'
          push(ops, role, kind, layeredPocketSegments(group.jobs, tool.bit.diameter / 2, tool.settings, group.pattern, group.angle), [], group.jobs.map((p) => p.shape.id))
        }
      }
    }
    const chain = cut.bit === 'auto' ? automaticPocketTools : [toolByRole.get(cut.bit)!]
    const selectedRadius = Math.min(...chain.map((tool) => tool.bit.diameter / 2))
    const fits = !!inflate(region, -selectedRadius).length
    const rest = opening(boolean(ClipType.Difference, region, opening(region, selectedRadius)), SLIVER)
    // ponytail: leftovers under about half a radius are treated as harmless corner slivers.
    if (fits && inflate(rest, -0.25 * selectedRadius).length) warnings.push(`The smallest selected bit can't reach all of ${shape.name}`)
    const planned = [...pocketJobs.values()].some((jobs) => jobs.some((job) => job.shape.id === shape.id))
    if (region.length && !fits && !planned) warnings.push(tooLarge)
  }
  ops.push(...last)
  const edgeRoles = [...new Set(ops.filter((op) => op.kind === 'pocket-edge').map((op) => op.role))]
  const runRoles = [...edgeRoles, ...machiningRoles.filter((role) => !edgeRoles.includes(role))]
  ops.splice(0, ops.length, ...runRoles.flatMap((role) => ops.filter((op) => op.role === role)))
  const lastUsedRole = Math.max(...ops.map((op) => runRoles.indexOf(op.role)), -1)
  if ([...freedRoles].some((role) => runRoles.indexOf(role) < lastUsedRole)) warnings.push('Parts are cut free before later bit passes; keep tabs on')

  const time = (role: BitRole) => {
    const s = cutSettings[role]
    const mine = ops.filter((o) => o.role === role)
    if (!s) return 0
    const secs = opTimes(mine, s)
    mine.forEach((o, i) => (o.timeSec = secs[i]))
    return secs.reduce((a, b) => a + b, 0)
  }
  return { ops, warnings: [...new Set(warnings)], timeSec: Object.fromEntries(roles.map((role) => [role, time(role)])) }
}
