import { describe, it, expect } from 'vitest'
import { isChallenge, parseModelHtml, parseModelUrl } from './fetcher.js'

/**
 * Fixtures mirror MakerWorld's real shape: a Pages-Router `__NEXT_DATA__`
 * script whose model sits at `props.pageProps.design`, with `license` as a
 * bare string. No network access — these pin the parse contract.
 */

function pageWith(design: Record<string, unknown>, extraHead = ''): string {
  const payload = {
    props: { pageProps: { design } },
    page: '/models/[designId]',
    query: { designId: '1029890-flexi-funny-octopus' },
    buildId: 'gbZP9c8P6nxLmHPHAr2Qv',
  }
  return `<!doctype html><html><head>${extraHead}</head><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>
</body></html>`
}

const FULL_DESIGN = {
  id: 1029890,
  designId: 1029890,
  title: 'Flexi Funny Octopus',
  summary: 'A print-in-place articulated octopus. No supports needed.',
  license: 'BY-NC',
  designCreator: { name: 'TinkerFox' },
  tags: [{ name: 'octopus' }, { name: 'flexi' }, 'articulated'],
  covers: [
    { url: 'https://makerworld.bblmw.com/cover/1029890/a.png' },
    { url: 'https://makerworld.bblmw.com/cover/1029890/b.png' },
    // Same asset at a different CDN size — must be deduped.
    { url: 'https://makerworld.bblmw.com/cover/1029890/a.png?x-oss-process=resize' },
  ],
}

describe('parseModelUrl', () => {
  it('accepts the usual shapes and pulls out the design id', () => {
    for (const url of [
      'https://makerworld.com/en/models/1029890-flexi-funny-octopus',
      'https://makerworld.com/models/1029890',
      'https://www.makerworld.com/de/models/1029890-flexi#profileId-77',
    ]) {
      expect(parseModelUrl(url).designId, url).toBe('1029890')
    }
  })

  it('rejects anything that is not a model URL', () => {
    expect(() => parseModelUrl('https://makerworld.com/en/@TinkerFox')).toThrow()
    expect(() => parseModelUrl('https://printables.com/model/1029890')).toThrow()
    expect(() => parseModelUrl('not a url')).toThrow()
  })
})

describe('parseModelHtml', () => {
  const url = 'https://makerworld.com/en/models/1029890-flexi-funny-octopus'

  it('reads the model out of props.pageProps.design', () => {
    const model = parseModelHtml(pageWith(FULL_DESIGN), url)
    expect(model.title).toBe('Flexi Funny Octopus')
    expect(model.designer).toBe('TinkerFox')
    expect(model.description).toContain('articulated octopus')
    expect(model.designId).toBe('1029890')
  })

  it('resolves the bare licence string through the gate', () => {
    const model = parseModelHtml(pageWith(FULL_DESIGN), url)
    expect(model.license.code).toBe('CC-BY-NC-4.0')
    expect(model.license.commercialUse).toBe('no')
  })

  it('handles tags given as objects or plain strings', () => {
    const model = parseModelHtml(pageWith(FULL_DESIGN), url)
    expect(model.tags).toEqual(['octopus', 'flexi', 'articulated'])
  })

  it('reads pictures from designExtension.design_pictures, the real location', () => {
    // Shape taken from a live page: designExtension is an OBJECT holding
    // design_pictures, so iterating designExtension itself finds nothing.
    const html = pageWith({
      designId: 1069737,
      title: 'Dartshalter - schlank',
      license: 'Standard Digital File License',
      designCreator: { name: 'OMMO' },
      designExtension: {
        design_pictures: [
          { url: 'https://makerworld.bblmw.com/m/design/2025-02-03_a.png' },
          { url: 'https://makerworld.bblmw.com/m/design/2025-02-03_b.png' },
        ],
        model_files: [],
      },
    })
    const model = parseModelHtml(html, 'https://makerworld.com/de/models/1069737-darts-holder-slim')
    expect(model.images.map((i) => i.url)).toEqual([
      'https://makerworld.bblmw.com/m/design/2025-02-03_a.png',
      'https://makerworld.bblmw.com/m/design/2025-02-03_b.png',
    ])
    expect(model.license.code).toBe('BAMBU-SDFL')
    expect(model.license.commercialUse).toBe('no')
  })

  it('dedupes CDN variants of the same image and re-ranks from zero', () => {
    const model = parseModelHtml(pageWith(FULL_DESIGN), url)
    expect(model.images).toHaveLength(2)
    expect(model.images.map((i) => i.rank)).toEqual([0, 1])
  })

  it('falls back to OpenGraph tags when the design object is missing', () => {
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="Desk Cable Clip">
      <meta property="og:description" content="A small cable clip.">
      <meta property="og:image" content="https://makerworld.bblmw.com/cover/1/og.png">
    </head><body></body></html>`
    const model = parseModelHtml(html, url)
    expect(model.title).toBe('Desk Cable Clip')
    expect(model.images).toHaveLength(1)
    // No licence anywhere means unknown, which the gate treats as blocked.
    expect(model.license.commercialUse).toBe('unknown')
  })

  it('recovers the licence from page text when the JSON omits it', () => {
    const { license, ...withoutLicense } = FULL_DESIGN
    void license
    const html = pageWith(withoutLicense).replace(
      '</body>',
      '<div class="license">Standard Digital File License</div></body>',
    )
    expect(parseModelHtml(html, url).license.code).toBe('BAMBU-SDFL')
  })

  it('refuses a Cloudflare challenge page rather than parsing garbage', () => {
    const challenge = '<!doctype html><html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>'
    expect(() => parseModelHtml(challenge, url)).toThrow(/Cloudflare challenge/i)
  })

  it('parses a page that merely passed through Cloudflare, script and all', () => {
    // The regression this exists for, and it broke the one route the README
    // calls dependable. Cloudflare injects its passive JavaScript-detection
    // probe into pages it serves *successfully*, so a real saved MakerWorld
    // page carries a `/cdn-cgi/challenge-platform/` script near the end. The
    // old detector matched that substring and rejected every genuine page —
    // invisibly, because the fixtures above are synthetic and carry no
    // Cloudflare script at all. Taken verbatim from the user's saved page.
    const jsd =
      `<script>var a=document.createElement('script');` +
      `a.nonce='ODRhOTQ0MmUtMjMzNS00NGExLTk5YjYtODdmYTQ4OTU4M2Yw';` +
      `a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';` +
      `document.getElementsByTagName('head')[0].appendChild(a);</script>`

    const model = parseModelHtml(pageWith(FULL_DESIGN).replace('</body>', `${jsd}</body>`), url)
    expect(model.title).toBe('Flexi Funny Octopus')
    expect(model.designer).toBe('TinkerFox')
  })

  it('does not let a challenge marker veto a page whose model data is readable', () => {
    // Belt to the braces above: even the unambiguous interstitial wording must
    // not discard a page that parses. The check now only chooses which error to
    // raise once the parse has already failed.
    const html = pageWith(FULL_DESIGN).replace('</body>', '<noscript>Just a moment...</noscript></body>')
    expect(parseModelHtml(html, url).title).toBe('Flexi Funny Octopus')
  })

  it('fails loudly when there is no title to be found', () => {
    expect(() => parseModelHtml('<!doctype html><html><body>nothing</body></html>', url)).toThrow(
      /Could not read the model title/i,
    )
  })
})

describe('isChallenge', () => {
  it('says no to the script Cloudflare adds to pages it serves normally', () => {
    expect(isChallenge("a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';")).toBe(false)
  })

  it('says yes to the interstitial that stands in place of the content', () => {
    for (const marker of [
      '<html><head><title>Just a moment...</title>',
      'window._cf_chl_opt={cvId:"3"}',
      "src='/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1'",
      '<div>Enable JavaScript and cookies to continue</div>',
      '<p>Checking if the site connection is secure</p>',
      '<div id="cf-browser-verification">',
    ]) {
      expect(isChallenge(marker), marker).toBe(true)
    }
  })
})
