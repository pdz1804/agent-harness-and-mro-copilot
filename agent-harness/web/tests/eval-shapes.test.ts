import { describe, expect, it } from 'vitest'
import {
  distinctMetrics,
  formatMetricValue,
  isDeltaGood,
  pivotSeriesByDate,
  progressPercent,
  sortMetricsForAttention,
} from '../src/lib/eval-shapes'
import type { EvalMetricOverviewRow, EvalSeriesPoint } from '../src/lib/api-types'

describe('formatMetricValue', () => {
  it('renders a 0..1 rubric metric as a rounded percentage', () => {
    expect(formatMetricValue('task_success', 0.756)).toBe('76%')
  })

  it('renders a raw-value metric as a plain number, not a percentage', () => {
    expect(formatMetricValue('latency_ms', 1234.5)).toBe('1,234.5')
    expect(formatMetricValue('tool_errors', 2)).toBe('2')
  })

  it('renders null as an em dash, never a fabricated 0', () => {
    expect(formatMetricValue('task_success', null)).toBe('—')
  })
})

describe('isDeltaGood', () => {
  it('treats an increase as good for a 0..1 quality rubric metric', () => {
    expect(isDeltaGood('task_success', 0.1)).toBe(true)
    expect(isDeltaGood('task_success', -0.1)).toBe(false)
  })

  it('treats a decrease as good for a raw cost/error metric', () => {
    expect(isDeltaGood('tool_errors', -1)).toBe(true)
    expect(isDeltaGood('latency_ms', 50)).toBe(false)
  })

  it('returns null (neither good nor bad) when there is no prior period', () => {
    expect(isDeltaGood('task_success', null)).toBeNull()
  })
})

describe('pivotSeriesByDate', () => {
  const series: EvalSeriesPoint[] = [
    { date: '2026-09-01', metric: 'task_success', mean: 0.8, n: 3 },
    { date: '2026-09-01', metric: 'safety', mean: 1.0, n: 3 },
    { date: '2026-09-02', metric: 'task_success', mean: 0.9, n: 2 },
  ]

  it('produces one row per date with each metric as its own column', () => {
    const data = pivotSeriesByDate(series)
    expect(data).toEqual([
      { date: '2026-09-01', task_success: 0.8, safety: 1.0 },
      { date: '2026-09-02', task_success: 0.9 },
    ])
  })

  it('returns an empty array for an empty series', () => {
    expect(pivotSeriesByDate([])).toEqual([])
  })
})

describe('distinctMetrics', () => {
  it('returns sorted unique metric names', () => {
    const series: EvalSeriesPoint[] = [
      { date: '2026-09-01', metric: 'safety', mean: 1, n: 1 },
      { date: '2026-09-01', metric: 'task_success', mean: 1, n: 1 },
      { date: '2026-09-02', metric: 'safety', mean: 1, n: 1 },
    ]
    expect(distinctMetrics(series)).toEqual(['safety', 'task_success'])
  })
})

describe('progressPercent', () => {
  it('computes a rounded percentage', () => {
    expect(progressPercent(1, 4)).toBe(25)
  })

  it('treats a zero total as fully complete, not NaN/0', () => {
    expect(progressPercent(0, 0)).toBe(100)
  })

  it('clamps to [0, 100]', () => {
    expect(progressPercent(5, 4)).toBe(100)
  })
})

describe('sortMetricsForAttention', () => {
  it('sorts rubric metrics ascending by latest_mean and keeps raw-value metrics after', () => {
    const rows: EvalMetricOverviewRow[] = [
      { metric: 'task_success', latest_mean: 0.9, prev_mean: null, delta: null, n: 3 },
      { metric: 'safety', latest_mean: 0.4, prev_mean: null, delta: null, n: 3 },
      { metric: 'latency_ms', latest_mean: 500, prev_mean: null, delta: null, n: 3 },
      { metric: 'groundedness', latest_mean: null, prev_mean: null, delta: null, n: 0 },
    ]
    const sorted = sortMetricsForAttention(rows)
    expect(sorted.map((r) => r.metric)).toEqual(['safety', 'task_success', 'latency_ms', 'groundedness'])
  })
})
