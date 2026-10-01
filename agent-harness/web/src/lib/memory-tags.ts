export const MAX_TAGS = 8
export const MAX_TAG_LENGTH = 32
export const MIN_FACT_LENGTH = 3
export const MAX_FACT_LENGTH = 1000

/** Parses a comma-separated tag input: lower-cased, whitespace collapsed,
 * empties and duplicates dropped, each tag capped at 32 chars, 8 tags max. */
export function parseTags(input: string): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const raw of input.split(',')) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH).trim()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

export function formatTags(tags: string[]): string {
  return tags.join(', ')
}

/** Returns an error message, or null when the fact is acceptable. */
export function validateFact(fact: string): string | null {
  const length = fact.trim().length
  if (length < MIN_FACT_LENGTH) return `Write at least ${MIN_FACT_LENGTH} characters.`
  if (length > MAX_FACT_LENGTH) return `Keep it under ${MAX_FACT_LENGTH} characters (currently ${length}).`
  return null
}
