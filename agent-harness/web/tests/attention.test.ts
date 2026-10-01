import { describe, expect, it } from 'vitest'
import { attentionChips, firstName } from '../src/lib/attention'

describe('attentionChips', () => {
  it('lists down before degraded, then the open incident count', () => {
    const chips = attentionChips(
      [
        { name: 'payments-api', status: 'degraded' },
        { name: 'auth-service', status: 'operational' },
        { name: 'search-index', status: 'down' },
      ],
      [{ id: 'INC-1' }, { id: 'INC-2' }],
    )
    expect(chips.map((c) => c.label)).toEqual(['search-index down', 'payments-api degraded', '2 open incidents'])
    expect(chips[0]).toMatchObject({ tone: 'danger', to: '/services?open=search-index' })
    expect(chips[2].to).toBe('/incidents?status=open')
  })

  it('uses the singular for one incident', () => {
    expect(attentionChips([], [{ id: 'INC-1' }])[0].label).toBe('1 open incident')
  })

  it('says all operational when nothing is wrong, and nothing when there is no data', () => {
    expect(attentionChips([{ name: 'a', status: 'operational' }], [])).toEqual([
      { key: 'ok', label: 'All services operational', tone: 'ok', to: '/services' },
    ])
    expect(attentionChips([], [])).toEqual([])
  })
})

describe('firstName', () => {
  it('takes the first word of the display name', () => {
    expect(firstName('Alice Admin')).toBe('Alice')
    expect(firstName('  Vic  ')).toBe('Vic')
    expect(firstName(null)).toBe('')
  })
})
