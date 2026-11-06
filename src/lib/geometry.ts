import { defaultCut, isOpen, type CompoundShape, type Point, type Polyline, type Shape, type ShapeBase, type TextShape } from '../model'
import { textGlyphs } from './fonts'
import { penPoints } from './pen'
import type { Units } from './units'

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number }
type Placement = Pick<ShapeBase, 'x' | 'y' | 'rotation'>

const TOLERANCE = 0.02 // mm
const rad = (deg: number) => (deg * Math.PI) / 180

export function toWorld({ x, y, rotation }: Placement, [px, py]: Point): Point {
  const c = Math.cos(rad(rotation))
  const s = Math.sin(rad(rotation))
  return [x + px * c - py * s, y + px * s + py * c]
}

export function toLocal({ x, y, rotation }: Placement, [px, py]: Point): Point {
  const c = Math.cos(rad(rotation))
  const s = Math.sin(rad(rotation))
  const dx = px - x
  const dy = py - y
  return [dx * c + dy * s, -dx * s + dy * c]
}

export function polylineBounds(polys: Polyline[]): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const { points } of polys) {
    for (const [x, y] of points) {
      b.minX = Math.min(b.minX, x)
      b.minY = Math.min(b.minY, y)
      b.maxX = Math.max(b.maxX, x)
      b.maxY = Math.max(b.maxY, y)
    }
  }
  return b
}

const polygonArea = (points: Point[]) => points.reduce((area, point, i) => area + point[0] * points[(i + 1) % points.length][1] - point[1] * points[(i + 1) % points.length][0], 0) / 2

function containsEvenOdd(polys: Polyline[], [x, y]: Point) {
  let inside = false
  for (const { points } of polys) {
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i]
      const [xj, yj] = points[j]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

// Turns an outer closed shape plus contained closed shapes into a pocket with protected islands. Even-odd filling
// means the operation is independent of contour winding, which is important for imported SVGs.
export function positiveReliefShape(shapes: Shape[], id: string, thickness: number): CompoundShape | null {
  if (shapes.length < 2 || shapes.some(isOpen)) return null
  const polylines = shapes.map(shapeToPolylines)
  if (polylines.some((paths) => !paths.length || paths.some((path) => !path.closed || path.points.length < 3))) return null
  const outerIndex = polylines.reduce((best, paths, i) => {
    const area = Math.max(...paths.map((path) => Math.abs(polygonArea(path.points))))
    const bestArea = Math.max(...polylines[best].map((path) => Math.abs(polygonArea(path.points))))
    return area > bestArea ? i : best
  }, 0)
  const outer = polylines[outerIndex]
  if (polylines.some((paths, i) => i !== outerIndex && paths.some((path) => path.points.some((point) => !containsEvenOdd(outer, point))))) return null
  const bounds = polylineBounds(outer)
  const [x, y] = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2]
  const cut = { ...(shapes[outerIndex].cut ?? defaultCut(thickness)), type: 'pocket' as const, tabs: false }
  return {
    id,
    type: 'compound',
    name: 'Positive relief',
    x,
    y,
    rotation: 0,
    fillRule: 'evenodd',
    paths: polylines.flatMap((paths) => paths.map((path) => ({ closed: true, points: path.points.map(([px, py]): Point => [px - x, py - y]) }))),
    cut,
  }
}

export function localPolylines(shape: Shape): Polyline[] {
  switch (shape.type) {
    case 'rect': {
      const x = shape.w / 2
      const y = shape.h / 2
      return [{ closed: true, points: [[-x, -y], [x, -y], [x, y], [-x, y]] }]
    }
    case 'ellipse': {
      const n = Math.max(8, Math.ceil(Math.PI / Math.acos(1 - TOLERANCE / Math.max(shape.w / 2, shape.h / 2))) || 8)
      return [
        {
          closed: true,
          points: Array.from({ length: n }, (_, i) => {
            const a = (i / n) * 2 * Math.PI
            return [(Math.cos(a) * shape.w) / 2, (Math.sin(a) * shape.h) / 2]
          }),
        },
      ]
    }
    case 'polygon': {
      const unit = Array.from({ length: shape.sides }, (_, i): Point => {
        const a = Math.PI / 2 + (i / shape.sides) * 2 * Math.PI
        return [Math.cos(a), Math.sin(a)]
      })
      const b = polylineBounds([{ points: unit, closed: true }])
      const sx = shape.w / (b.maxX - b.minX)
      const sy = shape.h / (b.maxY - b.minY)
      const cx = (b.minX + b.maxX) / 2
      const cy = (b.minY + b.maxY) / 2
      return [{ closed: true, points: unit.map(([x, y]) => [(x - cx) * sx, (y - cy) * sy]) }]
    }
    case 'path':
      return [{ closed: shape.closed, points: shape.nodes ? penPoints(shape.nodes, shape.closed) : shape.points }]
    case 'compound':
      return shape.paths
    case 'text': {
      const polys = textGlyphs(shape) ?? []
      const b = polylineBounds(polys)
      const cx = (b.minX + b.maxX) / 2
      const cy = (b.minY + b.maxY) / 2
      return polys.map(({ closed, points }) => ({ closed, points: points.map(([x, y]) => [x - cx, y - cy]) }))
    }
  }
}

export const shapeToPolylines = (shape: Shape): Polyline[] =>
  localPolylines(shape).map(({ points, closed }) => ({ closed, points: points.map((p) => toWorld(shape, p)) }))

// A text shape whose font hasn't loaded yet has no polylines; its stored w × h box stands in.
export function shapeBounds(shape: Shape) {
  const polys = shapeToPolylines(shape)
  return polylineBounds(polys.length || shape.type !== 'text' ? polys : shapeToPolylines({ ...shape, type: 'rect' }))
}

export const localBounds = (shape: Shape): Bounds =>
  shape.type === 'text'
    ? { minX: -shape.w / 2, minY: -shape.h / 2, maxX: shape.w / 2, maxY: shape.h / 2 }
    : polylineBounds(localPolylines(shape))

// Call only once the font is loaded (see loadFont).
export function fitText(shape: TextShape): TextShape {
  const b = polylineBounds(localPolylines(shape))
  return b.minX > b.maxX ? { ...shape, w: 0, h: 0 } : { ...shape, w: b.maxX - b.minX, h: b.maxY - b.minY }
}

// Letter spacing scales with the size; the clamp absorbs rounding so it never drops below -size/2 (the loader's limit).
export const textAtSize = (t: TextShape, size: number): TextShape => ({ ...t, size, letterSpacing: Math.max(-size / 2, (t.letterSpacing * size) / t.size) })

export const dominantScale = (sx: number, sy: number) =>
  Math.abs(Math.log(Math.abs(sx))) >= Math.abs(Math.log(Math.abs(sy))) ? Math.abs(sx) : Math.abs(sy)

export function scaleShape(shape: Shape, sx: number, sy: number): Shape {
  const scale = (points: Point[]) => points.map(([x, y]): Point => [x * sx, y * sy])
  switch (shape.type) {
    case 'path':
      return {
        ...shape,
        points: scale(shape.points),
        ...(shape.nodes && { nodes: shape.nodes.map((node) => ({ point: scale([node.point])[0], ...(node.in && { in: scale([node.in])[0] }), ...(node.out && { out: scale([node.out])[0] }) })) }),
      }
    case 'compound':
      return { ...shape, paths: shape.paths.map((p) => ({ ...p, points: scale(p.points) })) }
    case 'text': {
      const f = dominantScale(sx, sy)
      return { ...textAtSize(shape, shape.size * f), w: shape.w * f, h: shape.h * f }
    }
    default:
      return { ...shape, w: shape.w * Math.abs(sx), h: shape.h * Math.abs(sy) }
  }
}

// Grid lines every `step` mm strictly inside a w × h stock, limited to the visible area plus one step, so the
// line count is bounded by the viewport rather than the stock.
export function gridPath(w: number, h: number, step: number, area: Bounds) {
  const d: string[] = []
  const [x0, x1] = [Math.max(0, area.minX - step), Math.min(w, area.maxX + step)]
  const [y0, y1] = [Math.max(0, area.minY - step), Math.min(h, area.maxY + step)]
  if (x0 >= x1 || y0 >= y1) return ''
  for (let i = Math.max(1, Math.ceil(x0 / step)); i * step <= x1 && i * step < w; i++) d.push(`M${i * step} ${y0}V${y1}`)
  for (let i = Math.max(1, Math.ceil(y0 / step)); i * step <= y1 && i * step < h; i++) d.push(`M${x0} ${i * step}H${x1}`)
  return d.join('')
}

const GRID_SERIES: Record<Units, number[]> = {
  mm: [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500],
  in: [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 5, 10].map((v) => v * 25.4),
}
const isMultiple = (v: number, of: number) => Math.abs(v / of - Math.round(v / of)) < 1e-9

export const gridLabel = (mm: number, units: Units) => {
  if (units === 'mm') return `${mm} mm`
  const inches = mm / 25.4
  return inches < 1 ? `1/${Math.round(1 / inches)}″` : `${+inches.toFixed(3)}″`
}

// Grid steps (mm) for a zoom in px per mm. The minor step is the snap size (snap in mm, 0 = off) while its lines
// are at least 6 px apart (the label names it when they aren't), otherwise the smallest series value at least 12 px apart; the major step is the next
// series value of at least 5 minor steps and 60 px (a multiple of the snap size while snapping), else 10 minor steps.
export function gridSteps(zoom: number, units: Units, snap: number) {
  const series = GRID_SERIES[units]
  const snapping = snap > 0 && snap * zoom >= 6
  const minor = snapping ? snap : (series.find((v) => v * zoom >= 12) ?? series.at(-1)!)
  const major =
    series.find((v) => v >= 5 * minor - 1e-9 && v * zoom >= 60 && (!snapping || isMultiple(v, minor))) ??
    [10, 20, 50, 100, 200, 500, 1000].map((k) => k * minor).find((v) => v * zoom >= 60)!
  const label = gridLabel(minor, units) + (snap > 0 && !snapping ? ` · snap ${gridLabel(snap, units)}` : '')
  return { minor, major, label }
}
