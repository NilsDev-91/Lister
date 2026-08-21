import { describe, it, expect } from 'vitest'
import { followUpQueries } from './seed.js'

/**
 * What the second research round is allowed to spend a call on.
 *
 * The regression this pins cost real quota and produced a false market: round
 * one for a dart holder came back full of halter-neck dress patterns ("dart"
 * is a sewing term), round two mined "sewing pattern" and "sleeveless dress"
 * out of them and searched exactly those — fetching a hundred dresses that
 * then *were* the sample. A phrase mined from a sample that may already be
 * off-topic cannot be trusted to pick the next query on its own.
 */

const ANCHORS = ['dart', 'dartshalter', 'halter', 'pla', '3d', 'druck']

function candidate(phrase: string, over: Partial<{ usableAsTag: boolean; competition: number | null }> = {}) {
  return { phrase, usableAsTag: true, competition: null, ...over }
}

describe('followUpQueries', () => {
  it('refuses a mined phrase with no word in common with the item', () => {
    const out = followUpQueries(
      [candidate('sewing pattern'), candidate('sleeveless dress'), candidate('dart display')],
      ['dart halter'],
      ANCHORS,
    )
    expect(out).toEqual(['dart display'])
  })

  it('still measures competition for phrases that belong to the item', () => {
    const out = followUpQueries(
      [candidate('dart stand'), candidate('dartpfeil halter'), candidate('dart storage')],
      ['dart halter'],
      ANCHORS,
    )
    expect(out).toEqual(['dart stand', 'dartpfeil halter', 'dart storage'])
  })

  it('skips what was already searched or already measured', () => {
    const out = followUpQueries(
      [candidate('dart halter'), candidate('dart stand', { competition: 400 }), candidate('dart rack')],
      ['dart halter'],
      ANCHORS,
    )
    expect(out).toEqual(['dart rack'])
  })

  it('filters nothing when there are no anchors to filter against', () => {
    // Backwards-compatible by construction: an item with no usable vocabulary
    // must not silently lose its second round.
    const out = followUpQueries([candidate('sewing pattern')], ['dart halter'], [])
    expect(out).toEqual(['sewing pattern'])
  })
})
