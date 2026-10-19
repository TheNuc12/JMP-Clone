import { describe, expect, it } from 'vitest'
import type { Column } from '../../state/store'
import { acceptsY, buildChartParams, chartNeeds, EMPTY_LIMITS, limitParams, limitsToText, parseLimits, type ChartSettings } from './settings'

const numeric: Column = { id: 'n', name: 'yield', dataType: 'numeric', modelingType: 'continuous', values: [], props: {} }
const passFail: Column = { id: 'd', name: 'defect', dataType: 'character', modelingType: 'nominal', values: [], props: {} }

const settings = (over: Partial<ChartSettings>): ChartSettings => ({
  chartType: 'imr',
  subgroupSize: '5',
  sampleSize: '',
  defectLevel: '',
  limits: EMPTY_LIMITS,
  ...over,
})

describe('chart rules', () => {
  it('accepts categorical Y only for P and NP charts', () => {
    expect(acceptsY('imr', numeric)).toBe(true)
    expect(acceptsY('imr', passFail)).toBe(false)
    expect(acceptsY('p', passFail)).toBe(true)
    expect(acceptsY('c', passFail)).toBe(false)
  })

  it('asks for the settings each chart needs', () => {
    expect(chartNeeds('imr', numeric, false, false)).toEqual({ subgroupSize: false, sampleSize: false, defectLevel: false, specLimits: true })
    expect(chartNeeds('xbar_r', numeric, false, false).subgroupSize).toBe(true)
    expect(chartNeeds('xbar_r', numeric, true, false).subgroupSize).toBe(false)
    expect(chartNeeds('p', numeric, false, false)).toMatchObject({ sampleSize: true, defectLevel: false, specLimits: false })
    expect(chartNeeds('p', numeric, false, true).sampleSize).toBe(false)
    expect(chartNeeds('np', passFail, false, false)).toMatchObject({ subgroupSize: true, sampleSize: false, defectLevel: true })
    expect(chartNeeds('c', numeric, false, false).sampleSize).toBe(false)
    expect(chartNeeds('u', numeric, false, false).sampleSize).toBe(true)
  })
})

describe('buildChartParams', () => {
  it('builds params and leaves out blank limits', () => {
    const s = settings({ limits: { lsl: '75', target: '', usl: '90' } })
    expect(buildChartParams(s, chartNeeds('imr', numeric, false, false), [numeric])).toEqual({
      params: { chart_type: 'imr', lsl: 75, usl: 90 },
      error: null,
    })
  })

  it('validates subgroup size, sample size, Y type and limits', () => {
    expect(buildChartParams(settings({ chartType: 'xbar_r', subgroupSize: '1' }), chartNeeds('xbar_r', numeric, false, false), [numeric]).error).toMatch(/at least 2/)
    expect(buildChartParams(settings({ chartType: 'p' }), chartNeeds('p', numeric, false, false), [numeric]).error).toMatch(/sample size/)
    expect(buildChartParams(settings({ chartType: 'imr' }), chartNeeds('imr', passFail, false, false), [passFail]).error).toMatch(/categorical/)
    expect(buildChartParams(settings({ limits: { lsl: '9', target: '', usl: '1' } }), chartNeeds('imr', numeric, false, false), [numeric]).error).toMatch(/below/)
  })

  it('includes subgroup size and defect level for a categorical P chart', () => {
    const s = settings({ chartType: 'p', subgroupSize: '10', defectLevel: 'Fail' })
    expect(buildChartParams(s, chartNeeds('p', passFail, false, false), [passFail]).params).toEqual({
      chart_type: 'p',
      subgroup_size: 10,
      defect_level: 'Fail',
    })
  })
})

describe('spec limits', () => {
  it('parses, validates and round-trips limits', () => {
    expect(parseLimits({ lsl: ' 1.5 ', target: '', usl: '3' })).toEqual({ limits: { lsl: 1.5, target: null, usl: 3 }, error: null })
    expect(parseLimits({ lsl: 'x', target: '', usl: '' }).error).toMatch(/numbers/)
    expect(limitsToText({ lsl: 1, usl: null })).toEqual({ lsl: '1', target: '', usl: '' })
    expect(limitParams({ lsl: null, target: 2, usl: 4 })).toEqual({ target: 2, usl: 4 })
  })
})
