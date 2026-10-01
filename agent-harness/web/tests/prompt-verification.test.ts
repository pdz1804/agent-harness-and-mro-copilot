import { describe, expect, it } from 'vitest'
import type { PromptVerification } from '../src/lib/api-types'
import { activationLabel, sortIssues, summarizeVerification } from '../src/lib/prompt-verification'
import { autoRefreshLabel, normalizeAutoRefresh } from '../src/lib/dashboard-refresh'
import { formatCell, isDashboardPreview, previewHeadline, widgetSummary } from '../src/lib/approval-preview'

const verification = (status: 'pass' | 'warn' | 'fail', issues: PromptVerification['lint']['issues']): PromptVerification => ({
  lint: { status, issues, checked_at: 't', char_count: 10 },
  llm_review: null,
  verified_at: 't',
})

describe('summarizeVerification', () => {
  it('is activatable with an unverified tone when nothing was persisted', () => {
    expect(summarizeVerification(null)).toMatchObject({ tone: 'none', activatable: true })
  })

  it('blocks activation on a failed lint and counts errors', () => {
    const s = summarizeVerification(verification('fail', [{ rule: 'empty', severity: 'error', message: 'x' }]))
    expect(s).toMatchObject({ tone: 'fail', errors: 1, activatable: false })
    expect(s.label).toBe('Lint failed (1 error)')
  })

  it('treats warnings as activatable', () => {
    const s = summarizeVerification(
      verification('warn', [
        { rule: 'too_long', severity: 'warning', message: 'a' },
        { rule: 'contradiction', severity: 'warning', message: 'b' },
      ]),
    )
    expect(s).toMatchObject({ tone: 'warn', warnings: 2, activatable: true })
    expect(s.label).toBe('Passed with 2 warnings')
  })

  it('counts LLM review issues only when the review succeeded', () => {
    const v = verification('pass', [])
    v.llm_review = {
      status: 'ok',
      summary: '',
      issues: [{ severity: 'warning', message: 'm', suggestion: 's' }],
      model: 'm',
      reviewed_at: 't',
      error: null,
    }
    expect(summarizeVerification(v).llmIssues).toBe(1)
    v.llm_review = { ...v.llm_review, status: 'error' }
    expect(summarizeVerification(v).llmIssues).toBe(0)
  })
})

describe('sortIssues / activationLabel', () => {
  it('orders errors before warnings before info without mutating the input', () => {
    const input = [{ severity: 'info' as const }, { severity: 'error' as const }, { severity: 'warning' as const }]
    expect(sortIssues(input).map((i) => i.severity)).toEqual(['error', 'warning', 'info'])
    expect(input[0].severity).toBe('info')
  })

  it('labels activating an older version as a rollback', () => {
    expect(activationLabel(2, 5)).toBe('Roll back to v2')
    expect(activationLabel(6, 5)).toBe('Activate')
    expect(activationLabel(1, null)).toBe('Activate')
  })
})

describe('dashboard auto-refresh', () => {
  it('labels and normalizes intervals', () => {
    expect(autoRefreshLabel(0)).toBe('Manual')
    expect(autoRefreshLabel(30)).toBe('Every 30s')
    expect(autoRefreshLabel(300)).toBe('Every 5 min')
    expect(normalizeAutoRefresh(45)).toBe(0)
    expect(normalizeAutoRefresh(60)).toBe(60)
    expect(normalizeAutoRefresh(null)).toBe(0)
  })
})

describe('approval preview helpers', () => {
  const widget = {
    kind: 'bar' as const,
    title: 'By severity',
    sql_query: 'SELECT 1',
    config: {},
    col_span: 6,
    columns: ['severity', 'n'],
    row_count: 4,
    sample_rows: [],
    error: null,
  }

  it('recognizes dashboard previews and writes a headline', () => {
    const preview = { kind: 'dashboard' as const, name: 'Incidents', widgets: [widget, widget] }
    expect(isDashboardPreview(preview)).toBe(true)
    expect(isDashboardPreview(null)).toBe(false)
    expect(previewHeadline(preview)).toBe('Create dashboard "Incidents" with 2 widgets')
    expect(previewHeadline({ ...preview, kind: 'widget' })).toBe('Add 1 widget to dashboard "Incidents"')
  })

  it('summarizes widgets and formats cells', () => {
    expect(widgetSummary(widget)).toBe('4 rows · 2 columns')
    expect(widgetSummary({ ...widget, error: 'boom' })).toBe('dry run failed: boom')
    expect(formatCell(null)).toBe('—')
    expect(formatCell(3)).toBe('3')
    expect(formatCell(3.14159)).toBe('3.14')
    expect(formatCell('x')).toBe('x')
  })
})
