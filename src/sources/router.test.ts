import { describe, it, expect } from 'vitest'
import { parseModelUrl, platformForUrl, readModelFromFile, needsSavedPage } from './router.js'

describe('the URL router', () => {
  it('dispatches by hostname', () => {
    const mw = parseModelUrl('https://makerworld.com/en/models/1029890-flexi-funny-octopus')
    expect(mw.platform).toBe('MAKERWORLD')
    expect(mw.externalId).toBe('1029890')

    const cults = parseModelUrl('https://cults3d.com/de/modell-3d/gadget/flexi-turtle')
    expect(cults.platform).toBe('CULTS3D')
    expect(cults.externalId).toBe('flexi-turtle')
  })

  it('accepts subdomains but not lookalike hosts', () => {
    expect(parseModelUrl('https://www.makerworld.com/en/models/1029890').platform).toBe('MAKERWORLD')
    // A hostname merely *containing* the platform name is someone else's site.
    expect(() => parseModelUrl('https://makerworld.com.evil.example/en/models/1')).toThrow(/No adapter/)
    expect(() => parseModelUrl('https://notcults3d.com/en/3d-model/a/b')).toThrow(/No adapter/)
  })

  it('names the supported platforms when the host is unknown', () => {
    // The hint travels on the UserError's own field, not in the message.
    let thrown: unknown
    try {
      parseModelUrl('https://www.printables.com/model/3161-3d-benchy')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/No adapter for www\.printables\.com/)
    expect((thrown as { hint?: string }).hint).toMatch(/MakerWorld, Cults3D/)
  })

  it('is a loud error for a non-URL, not a fallback', () => {
    expect(() => parseModelUrl('flexi-turtle')).toThrow(/is not a URL/)
  })

  it('lets the platform reject its own malformed paths', () => {
    // Right host, wrong path: the platform adapter's rules apply, with the
    // platform's own message.
    expect(() => parseModelUrl('https://makerworld.com/en/@TinkerFox')).toThrow(/MakerWorld model URL/)
    expect(() => parseModelUrl('https://cults3d.com/en/users/kendofuji/creations')).toThrow(/Cults3D model URL/)
  })

  it('refuses a saved page for platforms read through an API', async () => {
    // A file the user attached on purpose is either used or named as the
    // mistake it is — never silently ignored.
    await expect(readModelFromFile('/tmp/page.html', 'https://cults3d.com/en/3d-model/gadget/flexi-turtle'))
      .rejects.toThrow(/only for MakerWorld/)
  })

  it('reports which platforms want the saved-page route', () => {
    expect(needsSavedPage('MAKERWORLD')).toBe(true)
    expect(needsSavedPage('CULTS3D')).toBe(false)
    expect(needsSavedPage('PRINTABLES')).toBe(false)
  })

  it('answers platformForUrl without throwing, for UI hints', () => {
    expect(platformForUrl('https://cults3d.com/en/3d-model/gadget/x')).toBe('CULTS3D')
    expect(platformForUrl('https://example.com/x')).toBeNull()
    expect(platformForUrl('garbage')).toBeNull()
  })
})
