import type { FeedbackRating } from './api-types'

export type JudgeAgreement = 'agree' | 'disagree' | 'unknown'

export const NOTE_MAX = 1000

export function ratingToBool(rating: FeedbackRating): boolean {
  return rating === 'up'
}

export function boolToRating(value: boolean): FeedbackRating {
  return value ? 'up' : 'down'
}

/** Judge pass + thumbs-up, or judge fail + thumbs-down, agree; otherwise
 * disagree. Unknown until both the judge and a human have spoken. */
export function judgeAgreement(judgePassed: boolean | null, rating: FeedbackRating | null): JudgeAgreement {
  if (judgePassed === null || rating === null) return 'unknown'
  return judgePassed === ratingToBool(rating) ? 'agree' : 'disagree'
}

/** Judge score (0..1) as a whole percent; "Not scored" when absent. */
export function formatJudgeScore(score: number | null): string {
  if (score === null || Number.isNaN(score)) return 'Not scored'
  return `${Math.round(score * 100)}%`
}

/** Clicking the thumb you already chose clears the vote; otherwise it sets it. */
export function nextVote(current: FeedbackRating | null, clicked: FeedbackRating): FeedbackRating | null {
  return current === clicked ? null : clicked
}
