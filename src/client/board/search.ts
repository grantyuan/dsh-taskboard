/**
 * Multi-term search for the board's free-text query.
 *
 * A comma in the query means "several cards at once": "A,B,C" fans out into
 * every segment (A, B, C), every contiguous join (A,B / B,C) and the full
 * string (A,B,C). A task matches when ANY candidate term occurs in its
 * (comma-normalized) title or id — so genuinely comma-bearing texts stay
 * findable while multi-select needs only one input.
 *
 * @module dsh-taskboard/client/board/search
 */

/** Lowercase + collapse whitespace around commas, the matching form. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s*,\s*/g, ',').trim()
}

/** Cap comma segments before the contiguous-join expansion gets silly. */
const MAX_SEGMENTS = 32

/**
 * Build candidate terms for a raw query (already OR-combined by
 * {@link matchesSearch}). A comma-free query yields exactly one term.
 * @param query - raw user search text.
 * @returns deduplicated lowercased terms; empty for a blank query.
 */
export function buildSearchTerms(query: string): string[] {
  const raw = query.trim()
  if (raw.length === 0) return []
  if (!raw.includes(',')) return [normalize(raw)]
  const segments = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .slice(0, MAX_SEGMENTS)
    .map(normalize)
  const terms = new Set<string>()
  for (let i = 0; i < segments.length; i++) {
    let joined = ''
    for (let j = i; j < segments.length; j++) {
      joined = j === i ? segments[j]! : `${joined},${segments[j]}`
      if (joined.length > 0) terms.add(joined)
    }
  }
  return [...terms]
}

/**
 * Whether a task matches the search terms (any-of). Empty terms = match all.
 * @param terms - output of {@link buildSearchTerms}.
 * @param title - task title.
 * @param id - task id.
 */
export function matchesSearch(terms: string[], title: string, id: string): boolean {
  if (terms.length === 0) return true
  const hayTitle = normalize(title)
  const hayId = normalize(id)
  return terms.some(term => hayTitle.includes(term) || hayId.includes(term))
}
