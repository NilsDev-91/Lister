/**
 * eBay description hygiene — the rules that get a listing refused outright and
 * the ones that quietly cost mobile buyers.
 *
 * eBay's active-content policy (id=4247) rejects any description carrying
 * JavaScript or the elements that host it: the listing fails to submit with
 * "Disallowed JavaScript/HTML Syntax", and on existing listings the content is
 * stripped. Links leading away from eBay are forbidden by the same policy
 * family. Both are worth catching before the publish call, where the error is
 * opaque and the fix means regenerating.
 *
 * Pure, like `title.ts`: string in, findings out, so the wording can be pinned
 * without a listing or a network call.
 */

export type DescriptionFindingCode =
  | 'active-content'
  | 'external-link'
  | 'fixed-width'
  | 'table-layout'

export interface DescriptionFinding {
  severity: 'blocker' | 'warning'
  code: DescriptionFindingCode
  title: string
  detail: string
}

/**
 * Elements and attributes eBay's active-content policy names, each of which
 * fails the submit rather than merely ranking worse.
 */
const ACTIVE_CONTENT: { pattern: RegExp; what: string }[] = [
  { pattern: /<script\b/i, what: '<script>' },
  { pattern: /<iframe\b/i, what: '<iframe>' },
  { pattern: /<object\b/i, what: '<object>' },
  { pattern: /<embed\b/i, what: '<embed>' },
  { pattern: /<form\b/i, what: '<form>' },
  { pattern: /\bon(?:click|load|error|mouse\w+|focus|blur|change|submit|input|key\w+)\s*=/i, what: 'an on…= event handler' },
  { pattern: /javascript\s*:/i, what: 'a javascript: URL' },
]

/** Hosts a description link may point at without leading away from eBay. */
const EBAY_LINK_HOSTS = /(^|\.)ebay(desc)?\.(com|de|at|ch|co\.uk|fr|it|es|nl|ie|pl|com\.au)$|(^|\.)ebayimg\.com$|(^|\.)ebaystatic\.com$/i

function externalLinkHosts(html: string): string[] {
  const hosts = new Set<string>()
  const pattern = /<a\b[^>]*\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    try {
      const host = new URL(match[1]!).hostname
      if (!EBAY_LINK_HOSTS.test(host)) hosts.add(host)
    } catch {
      // An unparseable href cannot be judged; the marketplace will.
    }
  }
  return [...hosts]
}

/** A fixed pixel width wide enough to break a phone screen. */
const FIXED_WIDTH = /(?:\bwidth\s*=\s*["']?(\d{3,})|width\s*:\s*(\d{3,})\s*px)/i

export function auditEbayDescription(html: string): DescriptionFinding[] {
  const findings: DescriptionFinding[] = []

  const active = ACTIVE_CONTENT.filter((c) => c.pattern.test(html)).map((c) => c.what)
  if (active.length) {
    findings.push({
      severity: 'blocker',
      code: 'active-content',
      title: 'eBay description contains active content',
      detail:
        `Found ${active.join(', ')}. eBay's active-content policy (id=4247) refuses the listing outright — ` +
        `the publish fails with "Disallowed JavaScript/HTML Syntax".`,
    })
  }

  const hosts = externalLinkHosts(html)
  if (hosts.length) {
    findings.push({
      severity: 'blocker',
      code: 'external-link',
      title: 'eBay description links away from eBay',
      detail:
        `Links to ${hosts.slice(0, 3).join(', ')}. eBay forbids links that lead off the marketplace; ` +
        'the sanction ranges from a failed submit to listing removal.',
    })
  }

  const width = FIXED_WIDTH.exec(html)
  if (width) {
    const px = width[1] ?? width[2]
    findings.push({
      severity: 'warning',
      code: 'fixed-width',
      title: 'eBay description uses a fixed width',
      detail:
        `A ${px}px width breaks the mobile rendering. eBay's mobile guidelines ask for relative sizes only — ` +
        'most buyers see the listing on a phone.',
    })
  }

  if (/<table\b/i.test(html)) {
    findings.push({
      severity: 'warning',
      code: 'table-layout',
      title: 'eBay description uses a table',
      detail:
        "Tables do not reflow on phones; eBay's mobile guidelines advise against table layouts. " +
        'Lists and paragraphs carry the same facts and stay readable.',
    })
  }

  return findings
}
