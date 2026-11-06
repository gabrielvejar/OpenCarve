import type { PathNode, Point } from '../model'

export type PenNode = PathNode

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])
const midpoint = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

function lineDistance(p: Point, a: Point, b: Point) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length = Math.hypot(dx, dy)
  return length ? Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / length : dist(p, a)
}

function flattenCubic(a: Point, b: Point, c: Point, d: Point, tolerance: number, points: Point[], depth = 0) {
  if (depth === 12 || Math.max(lineDistance(b, a, d), lineDistance(c, a, d)) <= tolerance) {
    points.push(d)
    return
  }
  const ab = midpoint(a, b)
  const bc = midpoint(b, c)
  const cd = midpoint(c, d)
  const abc = midpoint(ab, bc)
  const bcd = midpoint(bc, cd)
  const centre = midpoint(abc, bcd)
  // ponytail: 12 subdivisions cap a pathological segment at 4096 points; raise it if sub-micron CAM is supported.
  flattenCubic(a, ab, abc, centre, tolerance, points, depth + 1)
  flattenCubic(centre, bcd, cd, d, tolerance, points, depth + 1)
}

export function penPoints(nodes: PenNode[], closed: boolean, tolerance = 0.02): Point[] {
  if (!nodes.length) return []
  const points: Point[] = [nodes[0].point]
  const segment = (a: PenNode, b: PenNode) => {
    const c1 = a.out ?? a.point
    const c2 = b.in ?? b.point
    if (c1 === a.point && c2 === b.point) points.push(b.point)
    else flattenCubic(a.point, c1, c2, b.point, tolerance, points)
  }
  for (let i = 1; i < nodes.length; i++) segment(nodes[i - 1], nodes[i])
  if (closed && nodes.length > 1) {
    segment(nodes.at(-1)!, nodes[0])
    points.pop() // closed polylines don't repeat their first point
  }
  return points
}

export const pathNodes = (points: Point[], nodes?: PenNode[]): PenNode[] => nodes ?? points.map((point) => ({ point }))

export function draggedPenNode(point: Point, handle: Point): PenNode {
  return { point, in: [2 * point[0] - handle[0], 2 * point[1] - handle[1]], out: handle }
}
