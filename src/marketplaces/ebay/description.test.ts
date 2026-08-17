import { describe, it, expect } from 'vitest'
import { auditEbayDescription } from './description.js'

/**
 * Active content fails the publish outright ("Disallowed JavaScript/HTML
 * Syntax"), so the audit has to catch it before the API does — and must not
 * flag the plain markup the composer actually emits.
 */

describe('auditEbayDescription', () => {
  it('passes the markup the composer generates', () => {
    const html = '<h3>Dartpfeilhalter</h3><p>Aus <strong>PLA</strong> gedruckt.</p><ul><li>Made to order</li></ul>'
    expect(auditEbayDescription(html)).toHaveLength(0)
  })

  it('blocks script tags, event handlers and javascript: URLs', () => {
    for (const html of [
      '<p>Hi</p><script>alert(1)</script>',
      '<p onclick="steal()">Hi</p>',
      '<a href="javascript:void(0)">Hi</a>',
      '<iframe src="https://example.com"></iframe>',
    ]) {
      const findings = auditEbayDescription(html)
      expect(findings.some((f) => f.severity === 'blocker' && f.code === 'active-content'), html).toBe(true)
    }
  })

  it('blocks links leading away from eBay but leaves eBay-hosted ones alone', () => {
    const external = auditEbayDescription('<a href="https://my-shop.example.com/more">Mehr</a>')
    expect(external.some((f) => f.code === 'external-link' && f.severity === 'blocker')).toBe(true)
    expect(external.find((f) => f.code === 'external-link')?.detail).toContain('my-shop.example.com')

    const internal = auditEbayDescription('<a href="https://www.ebay.de/itm/123">Anderes Angebot</a>')
    expect(internal.some((f) => f.code === 'external-link')).toBe(false)

    const image = auditEbayDescription('<img src="https://i.ebayimg.com/images/g/x/s-l1600.jpg">')
    expect(image.some((f) => f.code === 'external-link')).toBe(false)
  })

  it('does not treat a spelt-out URL in prose as a link', () => {
    // Only anchors navigate; prose mentioning a domain is not a policy issue
    // this audit can judge.
    expect(auditEbayDescription('<p>Design von makerworld.com heruntergeladen.</p>')).toHaveLength(0)
  })

  it('warns about fixed widths and table layouts, without blocking', () => {
    const fixed = auditEbayDescription('<div style="width: 800px">Inhalt</div>')
    expect(fixed).toEqual([expect.objectContaining({ severity: 'warning', code: 'fixed-width' })])

    const table = auditEbayDescription('<table><tr><td>Maß</td></tr></table>')
    expect(table).toEqual([expect.objectContaining({ severity: 'warning', code: 'table-layout' })])
  })

  it('lets small pixel values through — a 2px border width is not a layout', () => {
    expect(auditEbayDescription('<div style="width: 90%">Inhalt</div>')).toHaveLength(0)
  })
})
