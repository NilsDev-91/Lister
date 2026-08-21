import { describe, it, expect } from 'vitest'
import { pickResearchCategory } from './aspects.js'

/**
 * When the research may decide the eBay category on its own.
 *
 * The regression this guards is not hypothetical: the first real run produced
 * a five-way split whose leader held 17 %, and the old rule took the leader
 * silently. On eBay the category sets the fees and the required item
 * specifics — a plurality is not evidence enough to choose it unasked.
 */

const candidate = (share: number, over: Partial<{ id: string; name: string | null }> = {}) => ({
  id: '261636',
  name: 'Figuren',
  share,
  ...over,
})

describe('pickResearchCategory', () => {
  it('takes a category the sample clearly agrees on', () => {
    expect(pickResearchCategory([candidate(0.6)])).toEqual({ id: '261636', name: 'Figuren' })
  })

  it('refuses the 17 % leader that exposed this', () => {
    expect(pickResearchCategory([candidate(0.17), candidate(0.15, { id: '999' })])).toBeNull()
  })

  it('has nothing to say without research', () => {
    expect(pickResearchCategory(undefined)).toBeNull()
    expect(pickResearchCategory([])).toBeNull()
  })

  it('passes a missing name through rather than inventing one', () => {
    // Etsy ids resolve to names after mining; if that lookup failed, the id is
    // still usable and the caller must not print "undefined" next to it.
    expect(pickResearchCategory([candidate(0.8, { name: null })])).toEqual({ id: '261636', name: null })
  })
})
