import { expect, test } from 'vitest'
import { draggedPenNode, penPoints, type PenNode } from './pen'

test('click-only pen nodes remain straight segments', () => {
  expect(penPoints([{ point: [0, 0] }, { point: [10, 0] }, { point: [10, 10] }], false)).toEqual([[0, 0], [10, 0], [10, 10]])
})

test('dragged handles flatten a cubic curve within the requested tolerance', () => {
  const nodes: PenNode[] = [draggedPenNode([0, 0], [0, 10]), draggedPenNode([10, 0], [10, -10])]
  const points = penPoints(nodes, false, 0.01)
  expect(points.length).toBeGreaterThan(10)
  expect(points[0]).toEqual([0, 0])
  expect(points.at(-1)).toEqual([10, 0])
  expect(Math.max(...points.map((p) => p[1]))).toBeGreaterThan(7)
})

test('closed curves include the last segment without repeating the first point', () => {
  const nodes: PenNode[] = [{ point: [0, 0], in: [-5, 0] }, { point: [10, 0] }, { point: [10, 10], out: [5, 10] }]
  const points = penPoints(nodes, true)
  expect(points.length).toBeGreaterThan(3)
  expect(points[0]).toEqual([0, 0])
  expect(points.at(-1)).not.toEqual(points[0])
})
