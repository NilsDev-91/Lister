import { basename } from 'node:path'
import { CSS, JS } from './assets.js'
import { config } from '../config.js'
import type { ListingRecord, Marketplace } from '../types.js'
import type { Job } from './jobs.js'
import type { Finding } from '../commands/preflight.js'
import { gate } from '../sources/license.js'
import { coverage } from '../seo/coverage.js'
import { changedMarketplaces, diffCopy } from '../proposal.js'
import { aspectRows, type AspectRow } from './aspect-fields.js'
import { formatVariants } from './variant-text.js'
import { assessPrice, isMixed } from '../seo/price.js'
import type { PriceBand } from '../seo/types.js'
import type { StatusGroup } from '../status.js'
import { DEFAULT_SETTINGS, type Settings } from '../settings.js'

/**
 * HTML rendering.
 *
 * Everything interpolated goes through `esc`. The values here are model titles
 * and generated copy — text this tool pulled off a third-party web page — so
 * treating them as untrusted is not paranoia, it is where they came from.
 */

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

interface PageOptions {
  title: string
  context?: string
  body: string
  /** Which sidebar entry to mark as current. */
  nav?: NavKey
  /** Counts shown next to the overview entry. Omitted where they are not known. */
  counts?: { live: number; drafts: number }
}

type NavKey = 'overview' | 'new' | 'settings'

/**
 * The sidebar.
 *
 * Rendered from the page shell rather than per view, so every screen carries
 * the same navigation and no page can quietly lose it. The counts sit next to
 * "Übersicht" because live-versus-draft is the one number a seller checks
 * without wanting to open anything.
 */
function sidebar(current: NavKey | undefined, counts: PageOptions['counts']): string {
  const item = (key: NavKey, href: string, label: string, badge = ''): string =>
    `<a class="nav-item${current === key ? ' current' : ''}" href="${esc(href)}">
       <span>${esc(label)}</span>${badge}
     </a>`

  const badge = counts
    ? `<span class="nav-badge">${counts.live} live · ${counts.drafts} Entwurf</span>`
    : ''

  return `<nav class="side">
    <a class="brand" href="/">list<em>er</em></a>
    <div class="nav-group">
      ${item('overview', '/', 'Übersicht', badge)}
      ${item('new', '/new', 'Neues Inserat')}
    </div>
    <div class="nav-group bottom">
      ${item('settings', '/settings', 'Einstellungen')}
    </div>
  </nav>`
}

export function page({ title, context, body, nav, counts }: PageOptions): string {
  const env = config.ebay.env
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · lister</title>
<style>${CSS}</style>
</head>
<body>
${sidebar(nav, counts)}
<div class="shell">
<header class="bar">
  ${context ? `<span class="ctx">${esc(context)}</span>` : `<span class="ctx">${esc(title)}</span>`}
  <span class="env ${env === 'production' ? 'prod' : ''}">${esc(env)}</span>
</header>
<main>${body}</main>
</div>
<script>${JS}</script>
</body>
</html>`
}

/**
 * A listing counts as live once a marketplace has given it a live id.
 *
 * Keyed on `liveId` rather than on `state === 'published'`, and the difference
 * is not academic: `state` records the *last attempt*, so a failed re-publish
 * flips a listing that is still online back to "draft" in the overview. `liveId`
 * is only ever set by a successful publish and is never cleared — it is the
 * marketplace's own handle on a live listing.
 *
 * Deliberately not `remoteId`, which eBay assigns to the offer before anything
 * is published: a draft that reached the marketplace is still a draft.
 */
export function isLive(listing: ListingRecord): boolean {
  return listing.marketplaces.some((m) => m.liveId !== null)
}

export function splitListings(listings: ListingRecord[]): { live: ListingRecord[]; drafts: ListingRecord[] } {
  return {
    live: listings.filter(isLive),
    drafts: listings.filter((l) => !isLive(l)),
  }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function listingRows(listings: ListingRecord[]): string {
  return listings
    .map((l) => {
      const cells = l.marketplaces
        .map((m) => `<span class="pill ${esc(m.state)}">${esc(m.marketplace)}: ${esc(m.state)}</span>`)
        .join(' ')
      const live = l.marketplaces.find((m) => m.url)
      const pending = l.proposal ? '<span class="pill pending">Entwurfstext offen</span>' : ''
      return `<tr>
        <td>
          <a href="/listing/${esc(l.id)}">${esc(l.source.title)}</a>
          <div class="note">${esc(l.id)} · ${esc(l.source.designer)}</div>
        </td>
        <td>${esc(l.product.priceEur.toFixed(2))} €</td>
        <td>${cells} ${pending}</td>
        <td>${live ? `<a href="${esc(live.url)}" target="_blank" rel="noreferrer">ansehen</a>` : '<span class="note">—</span>'}</td>
      </tr>`
    })
    .join('')
}

function listingTable(title: string, listings: ListingRecord[], emptyNote: string): string {
  return `<h2 class="section">${esc(title)} <span class="count">${listings.length}</span></h2>
    ${
      listings.length
        ? `<div class="card">
             <table class="list">
               <thead><tr><th>Modell</th><th>Preis</th><th>Status</th><th>Live</th></tr></thead>
               <tbody>${listingRows(listings)}</tbody>
             </table>
           </div>`
        : `<div class="card"><p class="note">${esc(emptyNote)}</p></div>`
    }`
}

export function overview(listings: ListingRecord[], flash?: { kind: string; text: string }): string {
  const { live, drafts } = splitListings(listings)

  if (!listings.length) {
    return page({
      title: 'Übersicht',
      nav: 'overview',
      counts: { live: 0, drafts: 0 },
      body: `
      ${flash ? banner(flash) : ''}
      <div class="card empty">
        <p>Noch keine Inserate.</p>
        <a class="btn" href="/new">Erstes Inserat anlegen</a>
      </div>`,
    })
  }

  return page({
    title: 'Übersicht',
    nav: 'overview',
    counts: { live: live.length, drafts: drafts.length },
    body: `
    ${flash ? banner(flash) : ''}
    <div class="actions" style="margin-bottom:1.1rem">
      <a class="btn" href="/new">Neues Inserat</a>
      <span class="note">${listings.length} gespeichert</span>
    </div>
    ${listingTable('Live', live, 'Noch nichts veröffentlicht.')}
    ${listingTable('Entwürfe', drafts, 'Alles veröffentlicht.')}`,
  })
}

function banner(flash: { kind: string; text: string }): string {
  return `<div class="banner ${esc(flash.kind)}">${esc(flash.text)}</div>`
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsData {
  groups: StatusGroup[]
  settings: Settings
  counts: { live: number; drafts: number }
  flash?: { kind: string; text: string }
}

/**
 * Preferences on the left, diagnosis on the right.
 *
 * The status half is read-only on purpose. Credentials live in `.env` and this
 * page never receives their values — it is told only whether each one is set —
 * so there is nothing here to leak and no edit form that could write a secret
 * into a browser history or a server log.
 */
export function settingsPage({ groups, settings, counts, flash }: SettingsData): string {
  const statusHtml = groups
    .map(
      (group) => `<div class="card">
        <h3>${esc(group.title)}</h3>
        <table class="status">
          ${group.rows
            .map(
              (row) => `<tr>
                <td class="st-mark ${row.ok === null ? 'info' : row.ok ? 'ok' : 'bad'}">${
                  row.ok === null ? '·' : row.ok ? '✓' : '✗'
                }</td>
                <td class="st-label">${esc(row.label)}</td>
                <td class="st-value">${esc(row.value)}${
                  row.hint ? `<small>${esc(row.hint)}</small>` : ''
                }</td>
              </tr>`,
            )
            .join('')}
        </table>
      </div>`,
    )
    .join('')

  return page({
    title: 'Einstellungen',
    nav: 'settings',
    counts,
    body: `
    ${flash ? banner(flash) : ''}
    <div class="split">
      <div>
        <form method="post" action="/settings">
          <div class="card">
            <h3>Vorgaben für neue Inserate</h3>
            <label for="defaultMaterial">Material</label>
            <input class="field" id="defaultMaterial" name="defaultMaterial" value="${esc(settings.defaultMaterial)}">
            <div class="gap"></div>
            <label for="defaultQuantity">Menge</label>
            <input class="field" id="defaultQuantity" name="defaultQuantity" type="number" min="1"
                   value="${esc(settings.defaultQuantity)}">
            <div class="gap"></div>
            <label for="defaultProcessingDays">Bearbeitungszeit in Werktagen</label>
            <input class="field" id="defaultProcessingDays" name="defaultProcessingDays" type="number" min="1"
                   value="${esc(settings.defaultProcessingDays)}">
            <div class="gap"></div>
            <label class="check-line">
              <input type="checkbox" name="defaultCredit" value="1" ${settings.defaultCredit ? 'checked' : ''}>
              Designer-Credit standardmäßig anhängen
            </label>
            <p class="note">Kein Marktplatz verlangt ihn, manche Lizenzen schon. Kostet nichts.</p>
          </div>

          <div class="card">
            <h3>Keyword-Recherche</h3>
            <label for="researchSampleSize">Inserate je Suche (10–100)</label>
            <input class="field" id="researchSampleSize" name="researchSampleSize" type="number" min="10" max="100"
                   value="${esc(settings.researchSampleSize)}">
            <p class="note">Größere Stichprobe heißt bessere Zahlen und mehr Kontingent — Etsy erlaubt 10.000 Aufrufe pro Tag.</p>
            <div class="gap"></div>
            <label for="etsyBuyerCountry">Etsy: nur Shops, die hierhin liefern</label>
            <input class="field" id="etsyBuyerCountry" name="etsyBuyerCountry" maxlength="2" placeholder="leer = weltweit"
                   value="${esc(settings.etsyBuyerCountry)}">
            <p class="note">Zwei Buchstaben, z. B. DE. Leer lassen, solange die Etsy-Texte englisch und international sind.</p>
          </div>

          <div class="actions"><button class="btn" type="submit">Einstellungen speichern</button></div>
        </form>
      </div>

      <div>
        <div class="card">
          <h3>Zugangsdaten und Verbindungen</h3>
          <p class="note">Nur Vorhandensein und Ablaufdaten. Kein Schlüssel wird hier je angezeigt —
            geändert werden sie in der <code>.env</code>, Verbindungen über die CLI.</p>
        </div>
        ${statusHtml}
      </div>
    </div>`,
  })
}

// ---------------------------------------------------------------------------
// New listing form
// ---------------------------------------------------------------------------

export function newListingForm(error?: string, settings: Settings = DEFAULT_SETTINGS): string {
  return page({
    title: 'Neues Inserat',
    nav: 'new',
    body: `
    ${error ? banner({ kind: 'bad', text: error }) : ''}
    <h1>Neues Inserat</h1>
    <form method="post" action="/new" enctype="multipart/form-data" data-busy="Wird angelegt…">
      <div class="split">
        <div>
          <div class="card">
            <h3>Modell</h3>
            <label for="url">MakerWorld-URL</label>
            <input class="field" id="url" name="url" required
                   placeholder="https://makerworld.com/de/models/…">
            <div class="gap"></div>
            <label for="page">Gespeicherte Seite (HTML)</label>
            <input class="field" id="page" name="page" type="file" accept=".html,.htm">
            <p class="note">MakerWorld blockiert direkte Abrufe über Cloudflare.
               Seite im Browser mit Strg+S sichern und hier hochladen — das ist der verlässliche Weg.</p>
          </div>

          <div class="card">
            <h3>Der Artikel</h3>
            <div class="row">
              <div><label for="price">Preis (EUR)</label>
                   <input class="field" id="price" name="price" type="number" step="0.01" min="0.01" required value="20.99"></div>
              <div><label for="material">Material</label>
                   <input class="field" id="material" name="material" required value="${esc(settings.defaultMaterial)}"></div>
              <div><label for="colour">Farbe</label>
                   <input class="field" id="colour" name="colour" placeholder="Schwarz"></div>
              <div><label for="quantity">Stückzahl</label>
                   <input class="field" id="quantity" name="quantity" type="number" min="1" value="${esc(settings.defaultQuantity)}"></div>
            </div>
            <div class="gap"></div>
            <div class="row">
              <div><label for="dimensions">Maße (mm, LxBxH)</label>
                   <input class="field" id="dimensions" name="dimensions" placeholder="220x60x30"></div>
              <div><label for="weight">Gewicht (g)</label>
                   <input class="field" id="weight" name="weight" type="number" step="1" min="1"></div>
              <div><label for="processingDays">Bearbeitung (Werktage)</label>
                   <input class="field" id="processingDays" name="processingDays" type="number" min="1"
                          value="${esc(settings.defaultProcessingDays)}"></div>
            </div>
            <div class="gap"></div>
            <label for="notes">Hinweise für die Texterstellung</label>
            <textarea id="notes" name="notes" style="min-height:5rem"
                      placeholder="z. B. Schichthöhe 0,16 mm, mit Gewindeeinsätzen"></textarea>
          </div>
        </div>

        <div>
          <div class="card">
            <h3>Rechte</h3>
            <label style="display:flex; gap:.5rem; align-items:flex-start; color:var(--ink)">
              <input type="checkbox" name="commercialRights" value="1" style="margin-top:.25rem">
              <span>Ich habe eine kommerzielle Lizenz, die die Seite nicht zeigt</span>
            </label>
            <p class="note">Deckt das Modell — nicht die Fotos des Designers.
               Die bleiben dessen Eigentum, deshalb brauchst du eigene Bilder.</p>
            <div class="gap"></div>
            <label style="display:flex; gap:.5rem; align-items:flex-start; color:var(--ink)">
              <input type="checkbox" name="credit" value="1" ${settings.defaultCredit ? 'checked' : ''} style="margin-top:.25rem">
              <span>Designer im Text nennen</span>
            </label>
            <p class="note">Kein Marktplatz verlangt das — manche Lizenzen schon.</p>
            <div class="gap"></div>
            <label style="display:flex; gap:.5rem; align-items:flex-start; color:var(--ink)">
              <input type="checkbox" name="ownDesign" value="1" style="margin-top:.25rem">
              <span>Das ist mein eigener Entwurf</span>
            </label>
            <p class="note">Schaltet Etsy frei. Etsy verlangt seit dem 10.06.2025 Urheberschaft am Entwurf —
              eine Lizenz vom Designer reicht dort nicht. Für eBay ist das ohne Belang.</p>
            <div class="gap"></div>
            <label style="display:flex; gap:.5rem; align-items:flex-start; color:var(--ink)">
              <input type="checkbox" name="etsyDesignRisk" value="1" style="margin-top:.25rem">
              <span>Fremddesign, aber ich übernehme das Etsy-Eigendesign-Risiko</span>
            </label>
            <p class="note">Schaltet Etsy trotz Fremddesign frei. Etsy kann das Inserat unter den
              Creativity Standards entfernen; Gebühren bleiben fällig. Die Entscheidung wird mit
              Zeitpunkt und Quell-URL protokolliert und schaltet nur dieses eine Gate frei —
              Lizenzpflicht und die Regel „nur eigene Fotos für Etsy" bleiben bestehen.</p>
          </div>

          <div class="card">
            <h3>Anlegen</h3>
            <p class="note">Claude schreibt die Texte für beide Marktplätze.
               Dauert etwa eine halbe Minute — du siehst auf der nächsten Seite,
               woran gerade gearbeitet wird. Es wird nichts veröffentlicht.</p>
            <div class="actions"><button class="btn" type="submit">Entwurf erstellen</button>
            <a class="btn ghost" href="/">Abbrechen</a></div>
          </div>
        </div>
      </div>
    </form>`,
  })
}

// ---------------------------------------------------------------------------
// Creation progress
// ---------------------------------------------------------------------------

/** One collected progress line, rendered by its level. */
export function progressLine(line: { level: string; message: string }): string {
  return `<div class="pl ${esc(line.level)}">${esc(line.message)}</div>`
}

/**
 * The page shown while a listing is being built.
 *
 * The lines are rendered server-side as well as polled, so a reload — or a
 * browser that ran into trouble with the script — still shows how far the work
 * got rather than an empty box.
 *
 * The bar is deliberately indeterminate. The run has no measurable total: it
 * waits on a language model whose duration is not knowable in advance, and a
 * percentage invented to look reassuring is the kind of progress indicator that
 * teaches people to distrust progress indicators.
 */
export function creatingPage(job: Job): string {
  const failed = job.state === 'failed'

  return page({
    title: job.label,
    nav: 'new',
    body: `
    <h1>${failed ? 'Fehlgeschlagen' : esc(job.label)}</h1>
    <div class="card" id="job" data-job="${esc(job.id)}" data-state="${esc(job.state)}"
         data-hint="${esc(job.hint)}">
      <div class="bar-track ${failed ? 'failed' : ''}" id="job-bar"><div class="bar-fill"></div></div>
      <p class="note" id="job-status">${failed ? 'Abgebrochen.' : `Läuft… ${esc(job.hint)}`}</p>
      <div class="plines" id="job-lines">${job.lines.map(progressLine).join('')}</div>
      <div id="job-error">${
        job.error
          ? `<div class="banner bad"><strong>${esc(job.error.message)}</strong>${
              job.error.hint ? `<br>${esc(job.error.hint)}` : ''
            }</div>`
          : ''
      }</div>
      <div class="actions" id="job-actions">
        ${
          failed
            ? '<a class="btn ghost" href="/new">Zurück zum Formular</a>'
            : // Not "Abbrechen": leaving this page stops nothing, and a button
              // that claims otherwise is worse than no button. The work runs on
              // the server and finishes whether or not the tab is open.
              '<a class="btn ghost" href="/">Übersicht öffnen — läuft im Hintergrund weiter</a>'
        }
      </div>
      <p class="note">${
        failed ? '' : 'Wegnavigieren bricht nichts ab. Das Ergebnis steht danach am Inserat.'
      }</p>
    </div>`,
  })
}

// ---------------------------------------------------------------------------
// Listing detail
// ---------------------------------------------------------------------------

export interface DetailData {
  listing: ListingRecord
  findings: Finding[]
  passed: string[]
  flash?: { kind: string; text: string }
  /** Shown in the sidebar; the detail view does not compute them itself. */
  counts?: { live: number; drafts: number }
  /**
   * Blockers per marketplace, for the publish button.
   *
   * The list above is the union across both, which is right for reading and
   * wrong for deciding: an Etsy-only blocker used to disable publishing to
   * eBay, a marketplace with nothing wrong with it. The server has always
   * checked the selected marketplace on its own; this is what lets the button
   * agree with it.
   */
  blockersPerMarketplace?: Record<Marketplace, number>
  /**
   * Aspect names eBay marks required for the resolved category.
   *
   * Best effort: absent when no category is resolved yet or the taxonomy call
   * failed. Used only to label and to offer an empty box for one that is
   * missing — a required aspect nobody can see is one that gets forgotten.
   */
  requiredAspects?: string[]
}

/**
 * Alternative titles, as buttons that load into the field.
 *
 * They fill the input rather than saving: the point of offering options is that
 * the seller judges them, and judging usually ends in an edit. Saving on click
 * would take the field away mid-thought.
 */
function titleChoices(listing: ListingRecord, marketplace: Marketplace, inputId: string, limit: number): string {
  const options = listing.titleOptions?.[marketplace] ?? []
  if (!options.length) return ''

  const buttons = options
    .map(
      (title) =>
        `<button type="button" class="opt" data-fills="${esc(inputId)}" data-title="${esc(title)}">` +
        `<span class="len">${title.length}/${limit}</span>${esc(title)}</button>`,
    )
    .join('')

  return `<div class="opts">${buttons}</div>
    <p class="note">Anklicken lädt den Titel ins Feld — gespeichert wird erst mit „Änderungen speichern".</p>`
}

/**
 * The competitor price band, as a scale with your price marked on it.
 *
 * The whole line is min-to-max, the shaded part is the middle half of the
 * market, and the two marks are the median and your price. A number pair does
 * not show whether you are just outside the pack or nowhere near it; a position
 * does.
 */
function priceScale(priceEur: number, band: PriceBand): string {
  const verdict = assessPrice(priceEur, band)

  // The axis spans the middle half plus the seller's own price, not the whole
  // sample. A keyword search for "dart" returns dart flights at EUR 0.56 and
  // dartboard cabinets at EUR 744.94; drawing to those ends squashes every
  // comparable listing into a few pixels at the left and shows nothing. The
  // true extremes are given as text underneath instead.
  const lowEnd = Math.min(band.p25, priceEur)
  const highEnd = Math.max(band.p75, priceEur)
  const pad = (highEnd - lowEnd) * 0.15 || 1
  const low = Math.max(0, lowEnd - pad)
  const high = highEnd + pad
  const span = high - low || 1
  const at = (value: number) => `${(((value - low) / span) * 100).toFixed(1)}%`
  const width = (from: number, to: number) => `${(((to - from) / span) * 100).toFixed(1)}%`

  const eur = (v: number) => `${v.toFixed(2)} €`

  return `<div class="price">
    <h4>Preis im Markt <span class="note">${band.count} Inserate</span></h4>
    <div class="scale">
      <div class="mid" style="left:${at(band.p25)};width:${width(band.p25, band.p75)}"></div>
      <div class="tick median" style="left:${at(band.median)}" title="Median ${esc(eur(band.median))}"></div>
      <div class="tick you ${verdict.notable ? 'off' : ''}" style="left:${at(priceEur)}" title="dein Preis ${esc(eur(priceEur))}"></div>
    </div>
    <div class="scale-ends"><span>${esc(eur(low))}</span><span>${esc(eur(high))}</span></div>
    <p class="note">Median ${esc(eur(band.median))} · mittlere Hälfte ${esc(eur(band.p25))}–${esc(eur(band.p75))} ·
      dein Preis <strong>${esc(eur(priceEur))}</strong>${
        verdict.notable ? ` (${verdict.vsMedian.toFixed(1)}× Median)` : ''
      }<br>Gesamtspanne ${esc(eur(band.min))}–${esc(eur(band.max))}${
        isMixed(band) ? ' — die Ränder sind andere Produktarten, nicht dieselbe Ware' : ''
      }</p>
  </div>`
}

/**
 * The pending-rewrite panel.
 *
 * Sits above the editor because it is a question, not a reference: as long as a
 * proposal exists, editing the fields underneath it is work that accepting the
 * proposal would overwrite. Showing it here makes that ordering obvious.
 */
function proposalPanel(listing: ListingRecord): string {
  const proposal = listing.proposal
  if (!proposal) return ''

  const fields = diffCopy(listing.copy, proposal.copy)
  const touched = changedMarketplaces(fields)

  const rows = fields
    .filter((f) => f.changed)
    .map((f) => {
      const counts = f.limit ? ` <span class="note">${f.before.length} → ${f.after.length} von ${f.limit}</span>` : ''
      return `<div class="diff">
        <h4>${esc(f.label)}${counts}</h4>
        <div class="diff-old">${esc(f.before)}</div>
        <div class="diff-new">${esc(f.after)}</div>
      </div>`
    })
    .join('')

  if (!touched.length) {
    return `<div class="card warnbox">
      <h3>Vorgeschlagene Textänderung</h3>
      <p class="note">Der Entwurf ist mit dem aktuellen Text identisch.</p>
      <form method="post" action="/listing/${esc(listing.id)}/proposal/discard">
        <div class="actions"><button class="btn ghost" type="submit">Verwerfen</button></div>
      </form>
    </div>`
  }

  const basis = proposal.basedOn.length
    ? `Geschrieben gegen ${proposal.basedOn.join('- und ')}-Recherche.`
    : 'Ohne jede Recherche geschrieben — nur aus den Produktangaben.'

  // A per-marketplace button for each side the rewrite actually touches. The
  // case this is for: Etsy research exists, eBay research does not, so half the
  // rewrite is evidenced and half is guesswork.
  const partial =
    touched.length > 1
      ? touched
          .map(
            (m) =>
              `<button class="btn ghost" type="submit" name="marketplace" value="${esc(m)}">nur ${esc(m)}</button>`,
          )
          .join('')
      : ''

  return `<div class="card warnbox">
    <h3>Vorgeschlagene Textänderung</h3>
    <p class="note">${esc(basis)} Noch nichts übernommen — dein Inserat ist unverändert.</p>
    ${rows}
    <form method="post" action="/listing/${esc(listing.id)}/proposal/accept">
      <div class="actions">
        <button class="btn" type="submit" name="marketplace" value="both">Übernehmen</button>
        ${partial}
      </div>
    </form>
    <form method="post" action="/listing/${esc(listing.id)}/proposal/discard">
      <div class="actions"><button class="btn ghost" type="submit">Verwerfen</button></div>
    </form>
  </div>`
}

/**
 * The keyword research panel.
 *
 * Shows the evidence rather than just the verdict: a seller who can see that a
 * phrase has 300 competing listings and two views a day can overrule the
 * ranking, and should be able to. Numbers that were never measured print as
 * "?" — telling "uncrowded" apart from "unchecked" is the whole point.
 */
function keywordPanel(listing: ListingRecord): string {
  const research = listing.seo
  const has = Boolean(research?.ebay || research?.etsy)

  const blocks = (['ebay', 'etsy'] as const)
    .map((marketplace) => {
      const evidence = research?.[marketplace]
      if (!evidence) return ''

      const rows = evidence.candidates
        .slice(0, 8)
        .map((c) => {
          const competition = c.competition === null ? '?' : c.competition.toLocaleString('de-DE')
          const demand = c.demandPerDay === null ? '?' : c.demandPerDay.toFixed(1)
          const dim = c.usableAsTag ? '' : ' style="opacity:.55"'
          return `<tr${dim}><td>${esc(c.phrase)}</td><td>${Math.round(c.rankerShare * 100)} %</td>` +
            `<td>${esc(competition)}</td><td>${esc(demand)}</td></tr>`
        })
        .join('')

      const isEtsy = marketplace === 'etsy'
      const result = coverage({
        title: isEtsy ? listing.copy.etsy.title : listing.copy.ebay.title,
        tags: isEtsy ? listing.copy.etsy.tags : [],
        evidence,
      })

      const missed = result.missed.length
        ? `<p class="note">Nicht verwendet: ${esc(result.missed.slice(0, 5).join(', '))}</p>`
        : ''

      const notes = evidence.notes.length
        ? `<p class="note">Grenzen dieser Recherche: ${esc(evidence.notes.join(' '))}</p>`
        : ''

      // A scale rather than a sentence: where the price sits in the market is a
      // spatial question, and a marker on a line answers it faster than numbers.
      const price = evidence.priceBandEur ? priceScale(listing.product.priceEur, evidence.priceBandEur) : ''

      return `<h4 style="margin:.9rem 0 .35rem">${marketplace === 'ebay' ? 'eBay · Deutsch' : 'Etsy · Deutsch'}</h4>
        <p class="note">${evidence.sampleSize} Inserate aus ${evidence.queries.length} Suchen · ${
          result.used.length
        } Empfehlung(en) im Text</p>
        <table class="kw"><thead><tr><th>Phrase</th><th>Nutzen</th><th>Konkurrenz</th><th>Views/Tag</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">Keine Kandidaten</td></tr>'}</tbody></table>
        ${price}${missed}${notes}`
    })
    .join('')

  return `<div class="card">
    <h3>Keyword-Recherche</h3>
    ${
      has
        ? blocks
        : '<p class="note">Noch keine Recherche. Sucht echte Inserate auf beiden Marktplätzen und misst, ' +
          'welche Phrasen ranken, wie stark sie umkämpft sind und wie viel Traffic sie tragen.</p>'
    }
    <form method="post" action="/listing/${esc(listing.id)}/keywords">
      <div class="actions">
        <button class="btn ghost" type="submit" name="marketplace" value="both">Recherche starten</button>
        <button class="btn ghost" type="submit" name="marketplace" value="ebay">nur eBay</button>
        <button class="btn ghost" type="submit" name="marketplace" value="etsy">nur Etsy</button>
      </div>
    </form>
    <form method="post" action="/listing/${esc(listing.id)}/keywords/rewrite">
      <div class="actions">
        <button class="btn" type="submit" ${has ? '' : 'disabled'}>Neuen Text entwerfen</button>
        <span class="note">Zum Vergleichen — ändert noch nichts.</span>
      </div>
    </form>
  </div>`
}

/**
 * The designer's own photos, shown as reference and never as listing images.
 *
 * They were previously invisible, which read as "this model has no pictures"
 * when the record holds four of them. The absence has a reason and the reason
 * is worth stating where the gap is, rather than leaving the seller to wonder
 * whether something failed.
 *
 * Displayed, not staged. A commercial licence bought from a creator covers the
 * *model*: MakerWorld's membership agreement licenses "Model Collateral" —
 * photos, renders, descriptions — to MakerWorld itself, not to subscribers, and
 * the creator keeps every right to it. On eBay a third-party product photo is a
 * standard VeRO trigger, and VeRO strikes the account rather than the listing;
 * on Etsy a render is a policy breach outright. So these stay a visual
 * reference for the seller photographing their own print.
 */
function sourceImageReference(listing: ListingRecord): string {
  const images = listing.source.images
  if (!images.length) return ''

  const mayUse = gate(listing.source.license, listing.licenseOverridden, listing.sourceImagesLicensed).mayReuseImages

  // `data-src`, swapped in on open. Not lazy-loading: these sit on MakerWorld's
  // CDN at over a megabyte apiece, and fetching four of them on every view of
  // every listing page would have this tool quietly hammering someone else's
  // servers for pictures the seller may never look at. One user action, one
  // request — the same rule the page fetcher follows.
  const tiles = images
    .slice(0, 8)
    .map(
      (image, i) =>
        `<div class="img ref"><span class="n">${i + 1}</span>
           <img data-src="${esc(image.url)}" alt="Bild ${i + 1} der Modellseite"></div>`,
    )
    .join('')

  const footer = mayUse
    ? `<p class="note">Du hast angegeben, dass deine Lizenz auch die Bilder des Designers abdeckt.
         Übernehmen lädt sie herunter und schiebt sie — wenn eBay verbunden ist — gleich auf eBays
         Bildserver. <strong>Für eBay:</strong> Etsy nimmt grundsätzlich nur deine eigenen Fotos,
         Downloads gehen dort nie mit hoch.</p>
       <form method="post" action="/listing/${esc(listing.id)}/images/source"
             data-confirm="Die Bilder des Designers ins Inserat übernehmen? Das setzt voraus, dass deine Lizenz sie ausdrücklich einschließt — die übliche Commercial License Membership tut das nicht.">
         <div class="actions">
           <button class="btn ghost" type="submit">Diese ${images.length} Bilder übernehmen</button>
           <span class="note">Ersetzt vorhandene Fotos nicht, sondern kommt dazu.</span>
         </div>
       </form>`
    : `<p class="note">Das sind die Fotos von ${esc(listing.source.designer)}, und sie bleiben es.
         Eine gekaufte kommerzielle Lizenz deckt üblicherweise das <em>Modell</em>, nicht die Bilder des
         Designers. Fremde Produktfotos sind bei eBay ein typischer VeRO-Auslöser — der trifft das Konto,
         nicht nur das Inserat — und bei Etsy sind Renderings ohnehin verboten. Deckt deine Lizenz die
         Bilder wirklich mit ab, sag es unter „Herkunft und Rechte"; dann lassen sie sich hier übernehmen.</p>`

  return `<details class="refbox">
    <summary>Bilder der Modellseite ${mayUse ? 'übernehmen' : 'ansehen'} (${images.length})</summary>
    <div class="imgs" style="margin-top:.6rem">${tiles}</div>
    ${footer}
  </details>`
}

/**
 * Where the model came from, and — when it matters — the rights switch.
 *
 * The switch is deliberately here rather than only on the create form. The
 * licence question is often settled *after* drafting: a seller works up the
 * copy first and buys the creator's commercial membership when the listing is
 * ready to go live. Without a way to record that on an existing draft, a
 * listing under a restrictive licence could never be published at all, and the
 * draft would be a dead end.
 *
 * It is shown only where it changes something — a licence that already permits
 * the sale needs no assertion, and offering one would invite a claim nobody
 * has to make.
 */
function originCard(listing: ListingRecord): string {
  const licence = listing.source.license
  const permits = licence.commercialUse === 'yes'

  // Two claims, two boxes. Bundling them into one would be the easy thing and
  // the wrong one: the ordinary commercial membership covers the model and not
  // the creator's photographs, so a seller who ticks "I may sell this" must not
  // silently also be saying "and I may use their pictures".
  const licenceBoxes = permits
    ? ''
    : `<label class="check-line" style="align-items:flex-start; gap:.5rem">
           <input type="checkbox" name="overridden" value="1" ${listing.licenseOverridden ? 'checked' : ''}
                  style="margin-top:.25rem">
           <span>Ich halte eine kommerzielle Lizenz für dieses Modell</span>
         </label>
         <p class="note">Die Seite zeigt <strong>${esc(licence.raw || 'keine Lizenz')}</strong>, was den Verkauf
            nicht deckt. Ohne diese Angabe bleibt das Inserat ein Entwurf — veröffentlichen ist gesperrt.
            Die Lizenz gilt pro Creator und endet mit dem Abrechnungszeitraum; ein eBay-Inserat läuft länger.</p>
         <div class="gap"></div>
         <label class="check-line" style="align-items:flex-start; gap:.5rem">
           <input type="checkbox" name="imagesLicensed" value="1" ${listing.sourceImagesLicensed ? 'checked' : ''}
                  style="margin-top:.25rem">
           <span>… und sie deckt auch die Bilder des Designers ab</span>
         </label>
         <p class="note">Getrennt zu bestätigen, weil es selten zutrifft: MakerWorlds
            Mitgliedschaftsvereinbarung lizenziert Fotos und Renderings an <em>MakerWorld</em>, nicht an
            Abonnenten. Nur ankreuzen, wenn deine Vereinbarung die Bilder ausdrücklich einschließt —
            fremde Produktfotos sind der klassische VeRO-Fall, und der trifft das Konto.
            Wirkt nur zusammen mit der Angabe darüber. Für eBay-Bilder — Etsy nimmt grundsätzlich
            nur deine eigenen Fotos.</p>
         <div class="gap"></div>`

  // A third, again separate claim: Etsy's authorship rule. A licence answers
  // whether the designer permits the sale; Etsy asks who designed it. The
  // seller can decide to carry that platform risk — per listing, recorded.
  const etsyRisk = listing.ownDesign
    ? ''
    : `<label class="check-line" style="align-items:flex-start; gap:.5rem">
           <input type="checkbox" name="etsyDesignRisk" value="1" ${listing.etsyDesignRiskAccepted ? 'checked' : ''}
                  style="margin-top:.25rem">
           <span>Ich übernehme das Etsy-Eigendesign-Risiko für dieses Inserat</span>
         </label>
         <p class="note">Etsys Creativity Standards verlangen seit dem 10.06.2025 ein eigenes Design —
            eine Lizenz des Designers beantwortet diese Frage nicht. Mit dem Haken trägst du das
            Plattformrisiko bewusst selbst: Etsy kann das Inserat entfernen, Gebühren bleiben fällig.
            Die Entscheidung wird mit Zeitpunkt und Quell-URL am Inserat protokolliert.
            Sie schaltet nur das Eigendesign-Gate frei — Lizenzpflicht und Bildregeln bleiben.</p>`

  const form =
    licenceBoxes || etsyRisk
      ? `<form method="post" action="/listing/${esc(listing.id)}/rights">
           ${licenceBoxes}
           ${etsyRisk}
           <div class="actions"><button class="btn ghost" type="submit">Rechte-Angabe speichern</button></div>
         </form>`
      : ''

  return `<div class="card">
    <h3>Herkunft und Rechte</h3>
    <p class="note">
      <a href="${esc(listing.sourceUrl)}" target="_blank" rel="noreferrer">${esc(listing.source.title)}</a>
      von ${esc(listing.source.designer)}<br>
      Lizenz: ${esc(licence.raw || 'keine gefunden')}${
        permits ? ' — Verkauf gedeckt' : ''
      }${listing.licenseOverridden ? '<br><strong>Eigene Rechte geltend gemacht</strong>' : ''}${
        listing.etsyDesignRiskAccepted
          ? `<br><strong>Etsy-Eigendesign-Risiko übernommen</strong> am ${esc(
              listing.etsyDesignRiskAccepted.at.slice(0, 10),
            )} — Behauptung, keine geprüfte Bedingung`
          : ''
      }
    </p>
    ${form}
  </div>`
}

/**
 * The publish card, which is also the revise card.
 *
 * One button, two meanings, and the label tells them apart: a marketplace with
 * a live id gets "Änderungen übertragen" — the same edited copy, pushed onto
 * the existing listing in place. On eBay that is a revise (same item ID,
 * watchers and history kept; ending and relisting would destroy both), on Etsy
 * an in-place update of the four text fields. The confirm text switches with
 * it, because the two actions cost different things: publishing charges fees,
 * revising does not.
 *
 * "Nur Entwurf anlegen" is offered only while eBay is not live — on a
 * published offer the first write already goes live, so a draft stage does not
 * exist and the server refuses the combination.
 */
function publishCard(listing: ListingRecord, perMarket: Record<Marketplace, number>): string {
  const liveFor = (m: Marketplace) => listing.marketplaces.some((row) => row.marketplace === m && row.liveId !== null)
  const ebayLive = liveFor('ebay')
  const etsyLive = liveFor('etsy')

  const confirmPublish = `Das erstellt ein Live-Inserat für ${esc(listing.product.priceEur.toFixed(2))} € mit den Gebühren des Marktplatzes. Fortfahren?`
  const confirmRevise = 'Das überträgt deine Änderungen sofort auf das laufende Inserat. Kostet nichts; Artikelnummer und Historie bleiben. Fortfahren?'

  return `<div class="card">
    <h3>${ebayLive || etsyLive ? 'Veröffentlichen / Aktualisieren' : 'Veröffentlichen'}</h3>
    <form method="post" action="/listing/${esc(listing.id)}/publish"
          data-confirm="${ebayLive ? confirmRevise : confirmPublish}"
          data-confirm-publish="${confirmPublish}"
          data-confirm-revise="${confirmRevise}">
      <div class="stack">
        <select name="marketplace" id="publish-market">
          <option value="ebay" data-blockers="${perMarket.ebay}" data-live="${ebayLive ? 1 : 0}">eBay${ebayLive ? ' — live' : ''}</option>
          <option value="etsy" data-blockers="${perMarket.etsy}" data-live="${etsyLive ? 1 : 0}">Etsy${etsyLive ? ' — live' : ''}</option>
        </select>
        <input class="field" name="categoryId" placeholder="eBay-Kategorie-ID (Sandbox: Pflicht)">
        <button class="btn" type="submit" id="publish-btn" ${perMarket.ebay ? 'disabled' : ''}>${
          ebayLive ? 'Änderungen übertragen' : 'Live schalten'
        }</button>
        <span class="note" id="publish-note">${
          perMarket.ebay
            ? `Gesperrt: ${perMarket.ebay} Blocker für eBay offen — <a href="#preflight">zum Preflight</a>`
            : 'Preflight für eBay ist sauber.'
        }</span>
      </div>
    </form>
    ${
      ebayLive
        ? ''
        : `<form method="post" action="/listing/${esc(listing.id)}/publish">
             <input type="hidden" name="draftOnly" value="1">
             <input type="hidden" name="marketplace" value="ebay">
             <div class="actions"><button class="btn ghost" type="submit">Nur Entwurf anlegen</button></div>
           </form>`
    }
  </div>`
}

/**
 * One labelled box per item specific, instead of one textarea for all of them.
 *
 * The rules the markup enforces — see `aspect-fields.ts` for why:
 *  - a box that has a value carries `required`, so it cannot be emptied by a
 *    stray keystroke; removing it takes the explicit tick,
 *  - an aspect eBay requires is always shown, even with no value yet, so it
 *    cannot be forgotten,
 *  - blank boxes at the end keep the one thing a generated form usually loses:
 *    the ability to ADD an aspect the category demands.
 */
function aspectBoxes(listing: ListingRecord, requiredAspects: string[] | undefined): string {
  const rows = aspectRows(listing.copy.ebay.aspects, requiredAspects ?? [])

  const boxes = rows.map((row, index) => (row.name ? namedBox(row, index) : blankBox(index))).join('')

  // The template is what "+ Merkmal" clones. Cloning the last visible blank box
  // instead — as this first did — breaks the moment the seller removes them
  // all: there would be nothing left to copy.
  return `<div class="aspects" id="aspects">${boxes}</div>
    <template id="aspect-blank">${blankBox(0)}</template>
    <div class="actions"><button class="btn ghost" type="button" id="aspect-add">+ Merkmal</button></div>
    <p class="note">Jedes gefüllte Feld muss gefüllt bleiben — leeren geht nicht, entfernen nur über den
      Haken. Eine neue, noch leere Box wirfst du mit ✕ wieder weg. Mehrere Werte trennst du mit
      <strong>Semikolon</strong> (<code>PLA; PETG</code>) — Kommas bleiben Kommas, damit
      <code>0,16 mm</code> ein Wert bleibt.</p>`
}

/** A box for an aspect that already has its name: eBay's, or one saved earlier. */
function namedBox(row: AspectRow, index: number): string {
  const id = `aspect-v-${index}`
  const badge = row.requiredByEbay ? '<span class="req-tag">Pflicht bei eBay</span>' : ''
  // `aspectHint` says "we labelled this box and left it empty" — the reminder
  // for a required aspect. Without it the server would read an untouched
  // reminder as a half-entered aspect and refuse every save.
  const hint = row.locked ? '' : `<input type="hidden" name="aspectHint${index}" value="1">`
  // Removing a saved value goes through the checkbox and the server: it is
  // stored data, so the act has to be deliberate and reviewable. A blank box
  // is neither, which is why ✕ there is a plain client-side discard.
  const remove = row.locked
    ? `<label class="aspect-rm"><input type="checkbox" name="aspectDrop${index}" value="1"> entfernen</label>`
    : ''
  return `<div class="aspect${row.requiredByEbay ? ' req' : ''}">
    <div class="aspect-top"><label for="${id}">${esc(row.name)}</label>${badge}</div>
    <input type="hidden" name="aspectName${index}" value="${esc(row.name)}">${hint}
    <input class="field" id="${id}" name="aspectValue${index}" value="${esc(row.value)}"
           placeholder="Wert" autocomplete="off"${row.locked ? ' required' : ''}>
    ${remove}
  </div>`
}

/**
 * An empty box for an aspect the seller names themselves.
 *
 * Also the body of the `<template>`, so the box the button adds and the boxes
 * rendered here cannot drift apart. The index is rewritten on clone.
 */
function blankBox(index: number): string {
  const id = `aspect-v-${index}`
  return `<div class="aspect blank">
    <div class="aspect-top">
      <label for="${id}">Neues Merkmal</label>
      <button class="aspect-x" type="button" title="Diese leere Box entfernen"
              aria-label="Diese leere Box entfernen">✕</button>
    </div>
    <input class="field aspect-name" name="aspectName${index}" value=""
           placeholder="Name, z. B. Material" autocomplete="off">
    <input class="field" id="${id}" name="aspectValue${index}" value=""
           placeholder="Wert, z. B. 0,16 mm" autocomplete="off">
  </div>`
}

export function listingDetail({
  listing,
  findings,
  passed,
  flash,
  counts,
  blockersPerMarketplace,
  requiredAspects,
}: DetailData): string {
  const blockers = findings.filter((f) => f.severity === 'blocker')
  const warnings = findings.filter((f) => f.severity === 'warning')
  // Falls back to the combined count, which keeps the old behaviour for any
  // caller that does not supply the split.
  const perMarket: Record<Marketplace, number> = blockersPerMarketplace ?? {
    ebay: blockers.length,
    etsy: blockers.length,
  }

  const checks = [
    ...passed.map((p) => `<div class="check ok"><span class="dot">✓</span><div>${esc(p)}</div></div>`),
    ...warnings.map(
      (w) =>
        `<div class="check warn"><span class="dot">!</span><div>${esc(w.title)}<small>${esc(w.detail)}</small></div></div>`,
    ),
    ...blockers.map(
      (b) =>
        `<div class="check bad"><span class="dot">✗</span><div>${esc(b.title)}<small>${esc(b.detail)}${
          b.fix ? `<br>→ ${esc(b.fix)}` : ''
        }</small></div></div>`,
    ),
  ].join('')

  const images = listing.imagePaths
    .map(
      (p, i) => `<div class="img ${i === 0 ? 'primary' : ''}">
        <span class="n">${i + 1}</span>
        <img src="/listing/${esc(listing.id)}/image/${i}" alt="${esc(basename(p))}">
        <form method="post" action="/listing/${esc(listing.id)}/images/${i}/remove" style="display:contents">
          <button class="rm" type="submit" title="Entfernen">✕</button>
        </form>
      </div>`,
    )
    .join('')

  // The two marketplaces want images in opposite forms, and the button below is
  // the bridge — so the empty state names the next click rather than only the
  // problem.
  const ebayImages = listing.imageUrls.length
    ? `<p class="note">${listing.imageUrls.length} Bild(er) bei eBay gehostet.</p>`
    : listing.imagePaths.length
      ? `<p class="note">Noch keine HTTPS-URLs. eBay holt Bilder selbst und kann keine lokale Datei lesen —
           „Zu eBay hochladen" legt deine Fotos auf eBays Bildserver und trägt die URLs hier ein.</p>`
      : `<p class="note">Noch keine Fotos. Etsy nimmt die Dateien direkt, eBay braucht HTTPS-URLs —
           beides erledigt sich, wenn du hier Fotos ablegst und dann „Zu eBay hochladen" drückst.</p>`

  const publishBlocked = blockers.length > 0

  return page({
    title: listing.source.title,
    context: `${listing.source.title} · ${listing.source.designer}`,
    nav: 'overview',
    ...(counts ? { counts } : {}),
    body: `
    ${flash ? banner(flash) : ''}
    <div class="split">
      <div>
        ${proposalPanel(listing)}
        <form method="post" action="/listing/${esc(listing.id)}">
          <div class="card">
            <h3>eBay · Deutsch</h3>
            <label for="ebayTitle">Titel <span class="counter" id="c-ebay"></span></label>
            <input class="field" id="ebayTitle" name="ebayTitle" data-limit="80" data-counter="c-ebay"
                   value="${esc(listing.copy.ebay.title)}">
            ${titleChoices(listing, 'ebay', 'ebayTitle', 80)}
            <div class="gap"></div>
            <label for="ebayDesc">Beschreibung (HTML)</label>
            <textarea id="ebayDesc" name="ebayDesc">${esc(listing.copy.ebay.descriptionHtml)}</textarea>
            <div class="gap"></div>
            <label>Merkmale</label>
            ${aspectBoxes(listing, requiredAspects)}
            <p class="note">Der stärkste Ranking-Hebel bei eBay: Ein fehlendes Merkmal wirft dich komplett aus dem
              Filter, nicht nur weiter nach hinten. Ziel sind 10. Welche diese Kategorie kennt, zeigt
              <code>lister aspects ${esc(listing.id)}</code>.</p>
            <div class="gap"></div>
            <label for="ebaySku">Eigene SKU <span class="note">(leer = lokale ID ${esc(listing.id)})</span></label>
            <input class="field" id="ebaySku" name="ebaySku" value="${esc(listing.sku ?? '')}"
                   placeholder="z. B. WW-DART-001" maxlength="50">
            <div class="gap"></div>
            <label for="ebayVariants">Farbvarianten — je Zeile <code>SKU; Farbe; Preis; Menge</code></label>
            <textarea id="ebayVariants" name="ebayVariants" style="min-height:5rem"
                      placeholder="WW-DART-SW; Schwarz; 19,90; 3&#10;WW-DART-PT; Petrol; 21,90; 2">${esc(
                        formatVariants(listing.variants ?? []),
                      )}</textarea>
            <p class="note">Leer = ein einzelnes Inserat. Mit Varianten wird EIN Inserat mit Farb-Auswahl
              veröffentlicht — jede Zeile bekommt eigene SKU, eigenen Preis und eigene Menge; Verkäufe zahlen
              auf eine gemeinsame Artikelnummer ein. Nicht jede Kategorie erlaubt Farbvarianten; das prüft
              der Publish. Ein bereits einzeln veröffentlichtes Inserat kann nicht nachträglich Varianten
              bekommen — dafür bräuchte es Beenden+Neueinstellen, und das macht dieses Tool nicht.</p>
          </div>

          <div class="card${listing.ownDesign || listing.etsyDesignRiskAccepted ? '' : ' locked'}">
            <h3>Etsy · Deutsch</h3>
            ${
              listing.ownDesign
                ? ''
                : listing.etsyDesignRiskAccepted
                  ? `<p class="lockbar">Läuft auf deiner protokollierten Risiko-Übernahme vom
                       ${esc(listing.etsyDesignRiskAccepted.at.slice(0, 10))} — einer Behauptung, keiner geprüften
                       Bedingung. Etsy kann das Inserat unter den Creativity Standards entfernen; Gebühren bleiben.
                       Zurücknehmen unter „Herkunft und Rechte".</p>`
                  : `<p class="lockbar">Für dieses Inserat gesperrt. Etsy verlangt seit dem 10.06.2025, dass Artikel
                     nach einem <strong>eigenen Entwurf</strong> gefertigt sind — dieses Modell stammt von
                     ${esc(listing.source.designer)}. Eine kommerzielle Lizenz ändert daran nichts: Etsy fragt nach
                     Urheberschaft, nicht nach Nutzungsrechten. Der Text lässt sich bearbeiten, veröffentlichen
                     nicht. eBay kennt diese Einschränkung nicht. Wer das Plattformrisiko bewusst tragen will:
                     Schalter unter „Herkunft und Rechte".</p>`
            }
            <label for="etsyTitle">Titel <span class="counter" id="c-etsy"></span></label>
            <input class="field" id="etsyTitle" name="etsyTitle" data-limit="140" data-counter="c-etsy"
                   value="${esc(listing.copy.etsy.title)}">
            ${titleChoices(listing, 'etsy', 'etsyTitle', 140)}
            <div class="gap"></div>
            <label for="etsyDesc">Beschreibung</label>
            <textarea id="etsyDesc" name="etsyDesc">${esc(listing.copy.etsy.description)}</textarea>
            <div class="gap"></div>
            <label for="etsyTags">Tags (Komma-getrennt, max. 13 à 20 Zeichen)</label>
            <input class="field" id="etsyTags" name="etsyTags" value="${esc(listing.copy.etsy.tags.join(', '))}">
            <div class="gap"></div>
            <label for="etsyMaterials">Materialien (nur Buchstaben, Ziffern, Leerzeichen)</label>
            <input class="field" id="etsyMaterials" name="etsyMaterials"
                   value="${esc(listing.copy.etsy.materials.join(', '))}">
          </div>

          <div class="actions"><button class="btn" type="submit">Änderungen speichern</button></div>
        </form>

        <form method="post" action="/listing/${esc(listing.id)}/titles">
          <div class="actions">
            <button class="btn ghost" type="submit">Titelvorschläge holen</button>
            <span class="note">Mehrere Varianten je Marktplatz, zum Anklicken.${
              listing.titleOptions ? ' Ersetzt die aktuellen Vorschläge.' : ''
            }</span>
          </div>
        </form>

        <div class="card" style="margin-top:1.1rem">
          <h3>Bilder</h3>
          <form method="post" action="/listing/${esc(listing.id)}/images" enctype="multipart/form-data">
            <div class="imgs">
              ${images}
              <div class="drop">Fotos hierher ziehen<br>oder klicken</div>
            </div>
            <input id="image-input" name="images" type="file" accept="image/*" multiple hidden>
          </form>
          ${ebayImages}
          <form method="post" action="/listing/${esc(listing.id)}/images/ebay">
            <div class="actions">
              <button class="btn ghost" type="submit" ${listing.imagePaths.length ? '' : 'disabled'}>
                Zu eBay hochladen
              </button>
              <span class="note">${listing.imagePaths.length} lokal · ${listing.imageUrls.length} als HTTPS-URL</span>
            </div>
          </form>
          ${sourceImageReference(listing)}
        </div>
      </div>

      <div>
        <div class="card" id="preflight">
          <h3>Preflight</h3>
          ${checks || '<p class="note">Keine Prüfungen ausgeführt.</p>'}
          <form method="post" action="/listing/${esc(listing.id)}/preflight">
            <div class="actions"><button class="btn ghost" type="submit">Erneut prüfen</button></div>
          </form>
        </div>

        ${keywordPanel(listing)}

        ${publishCard(listing, perMarket)}

        ${originCard(listing)}
      </div>
    </div>`,
  })
}

export function errorPage(message: string, hint?: string): string {
  return page({
    title: 'Fehler',
    body: `<div class="banner bad"><strong>${esc(message)}</strong>${hint ? `<br>${esc(hint)}` : ''}</div>
           <a class="btn ghost" href="/">Zurück</a>`,
  })
}
