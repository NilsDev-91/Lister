import { describe, it, expect } from 'vitest'
import { parseUploadResponse, buildUploadXml } from './pictures.js'

/**
 * Fixtures are real Trading API responses captured from the eBay sandbox.
 * Every trap pinned here cost a round trip to find.
 */

const SUCCESS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<UploadSiteHostedPicturesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
    <Timestamp>2026-08-13T20:20:32.051Z</Timestamp>
    <Ack>Success</Ack>
    <Version>0</Version>
    <SiteHostedPictureDetails>
        <PictureName>lister-upload-test</PictureName>
        <PictureFormat>PNG</PictureFormat>
        <FullURL>https://i.sandbox.ebayimg.com/00/s/MTYwMFgxNjAw/z/M2MAAe/$_12.PNG?set_id=880000500F</FullURL>
        <BaseURL>https://i.sandbox.ebayimg.com/00/s/MTYwMFgxNjAw/z/M2MAAe/$_</BaseURL>
        <PictureSetMember>
            <MemberURL>https://i.sandbox.ebayimg.com/00/s/MTYwMFgxNjAw/z/M2MAAe/$_14.PNG</MemberURL>
            <PictureHeight>64</PictureHeight>
        </PictureSetMember>
        <UseByDate>2026-09-12T20:20:32.051Z</UseByDate>
    </SiteHostedPictureDetails>
</UploadSiteHostedPicturesResponse>`

/** Real response for an undersized image: HTTP 200, Ack Warning, and no URL. */
const WARNING_NO_URL = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<UploadSiteHostedPicturesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
    <Ack>Warning</Ack>
    <Errors>
        <ShortMessage>Das von Ihnen hochgeladene Bild ist zu klein.</ShortMessage>
        <LongMessage>Um sicher zu gehen, dass Bilder gut erkennbar dargestellt werden koennen, empfehlen wir groessere Bilder.</LongMessage>
        <ErrorCode>21917182</ErrorCode>
    </Errors>
</UploadSiteHostedPicturesResponse>`

const FAILURE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<UploadSiteHostedPicturesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
    <Ack>Failure</Ack>
    <Errors>
        <ShortMessage>Invalid token.</ShortMessage>
        <LongMessage>The authentication token is invalid or has expired.</LongMessage>
        <ErrorCode>931</ErrorCode>
    </Errors>
</UploadSiteHostedPicturesResponse>`

describe('parseUploadResponse', () => {
  it('decodes XML entities in the extracted URL', () => {
    // A well-formed response escapes & in text content; the stored URL must
    // carry the real character, or eBay's crawler fetches a broken query.
    const escaped = SUCCESS.replace(
      /<FullURL>[^<]+<\/FullURL>/,
      '<FullURL>https://i.sandbox.ebayimg.com/$_12.PNG?set_id=880000500F&amp;x=1</FullURL>',
    )
    expect(parseUploadResponse(escaped).url).toBe('https://i.sandbox.ebayimg.com/$_12.PNG?set_id=880000500F&x=1')
  })

  it('reads the full URL out of a success response', () => {
    const result = parseUploadResponse(SUCCESS)
    expect(result.url).toBe(
      'https://i.sandbox.ebayimg.com/00/s/MTYwMFgxNjAw/z/M2MAAe/$_12.PNG?set_id=880000500F',
    )
  })

  it('finds tags despite their mixed case', () => {
    // The reason this parser exists: an HTML parser lowercases tag names, so a
    // `FullURL` selector silently matches nothing and the upload looks broken
    // even though eBay returned a perfectly good URL.
    expect(parseUploadResponse(SUCCESS).url).toContain('ebayimg.com')
    expect(parseUploadResponse(SUCCESS.toLowerCase()).url).toContain('ebayimg.com')
  })

  it('picks FullURL, not one of the thumbnail MemberURLs', () => {
    expect(parseUploadResponse(SUCCESS).url).toContain('$_12.PNG')
    expect(parseUploadResponse(SUCCESS).url).not.toContain('$_14.PNG')
  })

  it('treats an HTTP 200 failure as a failure', () => {
    // The whole trap: the Trading API reports errors with a 200 status.
    expect(() => parseUploadResponse(FAILURE)).toThrow(/did not accept/i)
    expect(() => parseUploadResponse(FAILURE)).toThrow(/931|authentication token/i)
  })

  it('rejects a warning that carried no URL', () => {
    expect(() => parseUploadResponse(WARNING_NO_URL)).toThrow(/did not accept/i)
    expect(() => parseUploadResponse(WARNING_NO_URL)).toThrow(/zu klein/)
  })

  it('accepts a warning that still produced a URL', () => {
    // Warning does not mean rejection — the presence of a URL is what decides.
    const warned = SUCCESS.replace('<Ack>Success</Ack>', '<Ack>Warning</Ack>')
    expect(parseUploadResponse(warned).url).toContain('ebayimg.com')
  })

  it('does not mistake an empty body for success', () => {
    expect(() => parseUploadResponse('')).toThrow()
    expect(() => parseUploadResponse('<html>gateway error</html>')).toThrow()
  })
})

describe('buildUploadXml', () => {
  it('escapes characters that would break the payload', () => {
    const xml = buildUploadXml('Halter & Ständer <test>')
    expect(xml).toContain('Halter &amp; St')
    expect(xml).toContain('&lt;test&gt;')
    expect(xml).not.toMatch(/<test>/)
  })

  it('asks for the supersize picture set', () => {
    expect(buildUploadXml('x')).toContain('<PictureSet>Supersize</PictureSet>')
  })
})
