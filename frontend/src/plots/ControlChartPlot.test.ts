import { describe, expect, it } from 'vitest'
import type { ControlPoint } from '../api/types'
import { pointPositions, stepLine, zoneValues } from './ControlChartPlot'

const point = (center: number | null, lcl: number | null, ucl: number | null, label = ''): ControlPoint => ({
  label,
  value: 0,
  center,
  lcl,
  ucl,
  indices: [],
  tests: [],
})

describe('control chart geometry', () => {
  it('pads step lines half a point at both ends', () => {
    expect(stepLine([3, 4, null], [1, 2, 3])).toEqual({ x: [0.5, 1, 2, 3, 3.5], y: [3, 3, 4, null, null] })
    expect(stepLine([], [])).toEqual({ x: [], y: [] })
  })

  it('places numbered points at their numbers so charts line up', () => {
    const labelled = (...labels: string[]) => labels.map((l) => point(0, -1, 1, l))
    expect(pointPositions(labelled('2', '3', '7'))).toEqual({ xs: [2, 3, 7], numbered: true })
    expect(pointPositions(labelled('B', 'A'))).toEqual({ xs: [1, 2], numbered: false })
    expect(pointPositions(labelled('3', '2'))).toEqual({ xs: [1, 2], numbered: false })
  })

  it('places zones from the upper limit so clipped lower limits do not skew them', () => {
    const pts = [point(10, 4, 16), point(1, 0, 4), point(null, null, null)]
    expect(zoneValues(pts, 1)).toEqual([12, 2, null])
    expect(zoneValues(pts, -2)).toEqual([6, -1, null])
  })
})
