import type { RouteTestResult } from './api-types'

export type RoutingTone = 'picked' | 'dropped' | 'none' | 'forced'

export interface RoutingDescription {
  tone: RoutingTone
  headline: string
  detail: string
}

/** Confidence (0-1) as a clamped whole percent for the meter. */
export function confidencePercent(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100)
}

/** Slugs the router proposed that the threshold then filtered out. */
export function droppedPicks(result: Pick<RouteTestResult, 'raw_picks' | 'selected'>): string[] {
  return result.raw_picks.filter((slug) => !result.selected.includes(slug))
}

/** Router latency for display; slash commands make no model call. */
export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'no model call'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** Plain-language outcome of a routing test. */
export function describeRouting(result: RouteTestResult): RoutingDescription {
  const nameOf = (slug: string) => result.candidates.find((c) => c.slug === slug)?.name ?? slug
  const detail = result.rationale.trim()

  if (result.mode === 'slash') {
    const slug = result.selected[0] ?? ''
    return { tone: 'forced', headline: `Forced by slash command /${slug}`, detail }
  }
  if (result.selected.length > 0) {
    return { tone: 'picked', headline: `Router picks: ${result.selected.map(nameOf).join(', ')}`, detail }
  }
  if (droppedPicks(result).length > 0) {
    return {
      tone: 'dropped',
      headline: `No skill: confidence ${result.confidence.toFixed(2)} is below the ${result.threshold.toFixed(2)} threshold, the agent would use its base tools`,
      detail,
    }
  }
  return { tone: 'none', headline: 'No skill matched: the agent would use its base tools', detail }
}
