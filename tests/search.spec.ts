/**
 * Comma multi-query search (issue 3): "A,B,C" fans out into every segment,
 * every contiguous join, and the full string, all OR-combined — so one input
 * selects several cards while genuinely comma-bearing texts stay findable.
 */
import { describe, expect, it } from 'vitest'
import { buildSearchTerms, matchesSearch } from '../src/client/board/search.ts'

describe('buildSearchTerms', () => {
  it('returns no terms for a blank query', () => {
    expect(buildSearchTerms('')).toEqual([])
    expect(buildSearchTerms('   ')).toEqual([])
  })

  it('keeps a comma-free query as one lowercased term', () => {
    expect(buildSearchTerms('Fix Login')).toEqual(['fix login'])
  })

  it('expands "A,B,C" into segments, contiguous joins, and the whole', () => {
    const terms = buildSearchTerms('A,B,C')
    expect(new Set(terms)).toEqual(new Set(['a', 'b', 'c', 'a,b', 'b,c', 'a,b,c']))
  })

  it('tolerates spaces and empty segments around commas', () => {
    expect(new Set(buildSearchTerms(' A , ,B ,'))).toEqual(new Set(['a', 'b', 'a,b']))
  })

  it('caps the fan-out for absurd segment counts', () => {
    const terms = buildSearchTerms(Array.from({ length: 100 }, (_, i) => `t${i}`).join(','))
    // 32 segments kept → 32*33/2 contiguous joins, all short.
    expect(terms.length).toBeLessThanOrEqual((32 * 33) / 2)
    expect(terms).toContain('t0')
    expect(terms).toContain('t31')
    expect(terms).not.toContain('t32')
  })
})

describe('matchesSearch', () => {
  it('matches everything on an empty term list', () => {
    expect(matchesSearch([], 'anything', 't-1')).toBe(true)
  })

  it('OR-combines terms: any one selected card matches', () => {
    const terms = buildSearchTerms('支付,导出')
    expect(matchesSearch(terms, '修复导出按钮', 't-1')).toBe(true)
    expect(matchesSearch(terms, '支付超时', 't-2')).toBe(true)
    expect(matchesSearch(terms, '无关任务', 't-3')).toBe(false)
  })

  it('matches literal comma text through the full-join term', () => {
    const terms = buildSearchTerms('A,B,C')
    expect(matchesSearch(terms, '标为 A,B,C 的卡片', 't-1')).toBe(true)
  })

  it('normalizes whitespace around commas on both sides', () => {
    const terms = buildSearchTerms('A,B')
    expect(matchesSearch(terms, 'Fix A, B today', 't-1')).toBe(true)
    expect(matchesSearch(terms, 'nothing here', 't-2')).toBe(false)
  })

  it('searches task ids too', () => {
    const terms = buildSearchTerms('t-42,zzz')
    expect(matchesSearch(terms, '无关标题', 't-42')).toBe(true)
  })
})
