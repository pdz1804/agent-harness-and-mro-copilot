import { describe, expect, it } from 'vitest'
import { boolToRating, formatJudgeScore, judgeAgreement, nextVote, ratingToBool } from '../src/lib/feedback'

describe('judgeAgreement', () => {
  it('agrees when judge and human match', () => {
    expect(judgeAgreement(true, 'up')).toBe('agree')
    expect(judgeAgreement(false, 'down')).toBe('agree')
  })
  it('disagrees when they differ', () => {
    expect(judgeAgreement(true, 'down')).toBe('disagree')
    expect(judgeAgreement(false, 'up')).toBe('disagree')
  })
  it('is unknown when either side is missing', () => {
    expect(judgeAgreement(null, 'up')).toBe('unknown')
    expect(judgeAgreement(true, null)).toBe('unknown')
  })
})

describe('helpers', () => {
  it('converts rating and bool', () => {
    expect(ratingToBool('up')).toBe(true)
    expect(ratingToBool('down')).toBe(false)
    expect(boolToRating(true)).toBe('up')
    expect(boolToRating(false)).toBe('down')
  })
  it('formats score', () => {
    expect(formatJudgeScore(0.857)).toBe('86%')
    expect(formatJudgeScore(null)).toBe('Not scored')
  })
  it('toggles votes', () => {
    expect(nextVote('up', 'up')).toBeNull()
    expect(nextVote('up', 'down')).toBe('down')
    expect(nextVote(null, 'up')).toBe('up')
  })
})
