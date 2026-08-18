# 3d-print-lister — Architektur & Übergabe

> Stand: 2026-08-17, nach der Optimierungs-Sitzung (Recherche-Cache, ToS-Prüfung,
> Review-Fixes, **Git-Repo initialisiert** — Historie ab Baseline `5013a0c`).
> Diese Datei
> ist für eine **frische Sitzung ohne Vorwissen** geschrieben. Sie enthält vor
> allem die Erkenntnisse, die teuer waren — Dinge, die in keiner Dokumentation
> stehen oder dort **falsch** stehen. Die Abschnitte unter „Erkenntnisse" sind
> chronologisch gewachsen; die Nachträge vom 16.08. stehen bei ihren Themen.

## Was das Tool tut

Aus einer MakerWorld-Modellseite wird ein Inserat auf eBay und Etsy:
Seite einlesen → Lizenz prüfen → Claude schreibt die Texte → Bilder aufbereiten
→ Preflight → veröffentlichen. Node/TypeScript, CLI **und** lokale Web-UI.

Nutzer: Einzelverkäufer in Deutschland, druckt selbst, verkauft auf `ebay.de`.

## Status

| Bereich | Stand |
|---|---|
| MakerWorld-Parser | fertig, gegen echte Seite verifiziert |
| Lizenz-Gate | fertig, MakerWorlds Vokabular vollständig |
| Claude-Texte | fertig, generieren → validieren → reparieren |
| eBay OAuth | fertig, Sandbox verbunden (Refresh bis 02/2028) |
| eBay Inventory | fertig, **ein Inserat live in der Sandbox** |
| eBay Bild-Upload | fertig, Trading API, gegen Sandbox verifiziert |
| Etsy | Client fertig, **noch nie verbunden/getestet** |
| Etsy öffentliche Suche | fertig, **gegen die echte API verifiziert** (kein OAuth) |
| eBay Browse (Recherche) | implementiert, **braucht Production-Keyset**, nie live gelaufen |
| Keyword-Recherche | fertig, **live gegen echte Etsy-Daten gelaufen**; eBay-Hälfte ungeprüft |
| eBay-Aspect-Engine | fertig, **live gegen die Sandbox-Taxonomy geprüft** (6 → 8 Merkmale) |
| eBay-Titel-Sanitizer | fertig: Emoji und `?` im Schema, Rest als Preflight-Warnung |
| Etsy-Eignungs-Gate | fertig, Default-Deny; seit 18.08. mit protokolliertem Per-Listing-Override (`etsyDesignRiskAccepted`, Zeitpunkt+Quelle) — Bildregel bleibt ohne Override: Etsy bekommt nur eigene Fotos |
| Preis-Check | fertig, im Preflight und in der UI, live geprüft |
| Titelvarianten | fertig, 5 je Marktplatz, live geprüft |
| Entwurf-Zustand | fertig: entwerfen → ansehen → übernehmen/verwerfen |
| Preflight | fertig |
| Store-Locking | fertig, mit Prozess-Test |
| Web-UI | fertig: Seitenleiste, Übersicht (Live/Entwürfe getrennt), Editor, Bilder, Keywords, Einstellungen, Publish |
| GPSR-Felder | implementiert, nie live geprüft |
| eBay-Beschreibungs-Audit | fertig: aktive Inhalte/JS = Blocker (Policy id=4247), externe Links = Blocker, Fixed-Width/Tabellen = Warnung |
| Etsy-Bilddatei-Checks | fertig: >300 KB (Upload-Timeout), erstes Foto <2000 px bzw. <635×635 (Platzierung), .webp (Etsy nimmt es nicht) — eigener Header-Parser in `util/image-meta.ts`, keine Dependency |
| Etsy Return-Policy | Publish hängt sie an, wenn der Shop eine hat (Ranking-Signal, auch „No returns" zählt); **nie live geprüft** |
| Lizenz-Verkaufsgate | fertig, hart am **Publish** (nicht am Entwurf): SDFL/NC blocken in beiden publishTo* auch mit `--skip-preflight`; Override per Create-Flag oder Rechte-Schalter am Inserat |
| Rechte-Schalter (UI) | fertig: zwei getrennte Behauptungen — Verkaufsrechte und „Lizenz deckt auch die Designer-Bilder" (`sourceImagesLicensed`); Bild-Übernahme-Knopf lädt dann die MakerWorld-Bilder und hostet sie bei eBay — **live geprüft** |
| Anlegen als Hintergrund-Job | fertig: `POST /new` → sofortiger Redirect auf `/progress/<id>`, echte Io-Zeilen per Poll; auch für die Bild-Übernahme — **live geprüft** |
| Revise (Live-Inserate bearbeiten) | fertig: eBay per Item+Offer-Rewrite (nie End+Relist, ID bleibt — **live geprüft**, Marke „WuchsWerk" auf 110590188642), Etsy per `updateListingContent` (4 Textfelder; **ungeprüft**, kein OAuth); `lister revise` + UI-Knopf „Änderungen übertragen" |
| eBay-Farbvarianten | fertig und **komplett live verifiziert** (Kategorie 261636): Item+Offer pro Farbe, Gruppe mit `aspects` (⚠️ siehe Erkenntnis), ein Publish → Listing 110590210428 mit 3 Farben; Draft/Publish/Revise/`show --remote` alle durchgespielt |
| Etsy-Farbvarianten | gebaut (`updateListingVariations`, Custom-Property 513, an Draft UND Revise angehängt), Body-Builder getestet — **gegen die echte API ungeprüft** (kein OAuth) |
| Eigene SKUs | fertig: `--sku` bei create, Feld im Editor, je Variante in der Tabelle; Charset `A-Za-z0-9._-`, ≤50 |
| Varianten-Editor | fertig: Textzeilen `SKU; Farbe; Preis; Menge` (Semikolon wegen Dezimalkomma), Fehler pro Zeile, Roundtrip live geprüft |
| Recherche-Cache | fertig, **live E2E geprüft** (17.08.): Suchergebnisse 24 h auf Platte, `--fresh` umgeht ihn; Wiederholungslauf = 0 Quota, Kennzeichnung „(cache)" + Notiz in der Evidenz |
| Etsy-API-ToS | gelesen und dokumentiert (`docs/research/etsy-api-terms.md`): Recherche ist **Grauzone**, Cache + Aggregat-only sind die Verteidigung |

425 Tests, alle grün (inkl. Hook-Tests unter `scripts/hooks/`).
`npm test && npm run build` läuft sauber.

> `db.concurrency.test.ts` „is unsafe without the lock" ist ein
> **Timing**-Negativtest: Er startet zwei echte Prozesse ohne Sperre und
> erwartet, dass sie sich überschreiben. Auf einer ausgelasteten Maschine
> verzahnen sie gelegentlich doch nicht und der Test schlägt fehl. Isoliert
> nachlaufen lassen, bevor man ihn für einen echten Fehler hält.
> (In dieser Sitzung zweimal genau so passiert und beide Male isoliert grün.)

**Live in der Sandbox:**
- `mw-1069737-683476` „Dartshalter": Einzel-Inserat `110590188642`, Offer
  `11438356010`, Marke per Revise auf „WuchsWerk" — Rechte-Haken gesetzt
  (Nutzer-Behauptung), Lizenzzeile aus den Texten entfernt.
- `mw-99187-44ae7a` „Moosstab": **Varianten-Inserat** `110590210428`, Gruppe
  `WW-MOOS-40`, Offers `11450260010/11450261010/11450262010`
  (Schwarz/Weiss/Waldgruen), Kategorie 261636 — die 4 Bilder sind übernommene
  MakerWorld-Renders (Nutzer hat `sourceImagesLicensed` behauptet).
- `mw-3156005-a1fda3` „Voronoi Wanduhr": nur lokal, vom Nutzer selbst angelegt.

**Etsy-Verbindungsstand:** API-Key in `.env` funktioniert (Ping live: 1,19 Mio.
Treffer, Limits 10/s + 10.000/Tag). **OAuth nie verbunden** — ein
`auth etsy`-Versuch lief am 16.08. in den 5-Minuten-Timeout, weil der Consent
im Browser nicht abgeschlossen wurde. Redirect-URI `http://localhost:3456/callback`
muss an der Etsy-App registriert sein. Etsy hat **keine Sandbox**; Drafts sind
kostenlos, Aktivierung kostet (~0,20 €).

## Aufbau

```
src/
  cli.ts                    Commander-Einstieg: auth whoami create preflight
                            keywords proposal titles aspects publish revise
                            ui list show delete
  config.ts                 .env-Laden, Zugangsdaten, SELLER_* (GPSR,
                            Längen-Limits werden erzwungen)
  types.ts                  zod-Schemas = die Wahrheit über Datenformen;
                            auch EbaySkuSchema + EbayVariantsSchema
  proposal.ts               reiner Text-Diff, den CLI und UI gemeinsam zeigen
                            (inkl. der Kategorie-Hints — mergeCopy wendet sie an)
  settings.ts               App-Vorgaben (~/.3d-print-lister/settings.json)
  status.ts                 was konfiguriert ist — **nie ein Geheimniswert**
  marketplace.ts            nur das Marktplatz-Enum — eigenes Modul, sonst
                            importieren types.ts und seo/types.ts sich im Kreis
  images.ts                 Bild-Staging (eBay=URLs, Etsy=Dateien)

  makerworld/
    fetcher.ts              __NEXT_DATA__-Parser + gespeicherte HTML lesen;
                            Challenge-Erkennung erst NACH dem Parse (⚠️ s.u.)
    license.ts              Lizenz → darf verkauft/wiederverwendet werden?
                            gate() nimmt 3 Argumente (Override, Bilder-Claim)
  ai/composer.ts            Claude-Aufruf, Structured Outputs, Reparaturschleife
  seo/
    types.ts                gemeinsame Form für beide Marktplätze
    mine.ts                 rein: n-Gramme, Tag-Konsens, Chancen-Score
    seed.ts                 Suchbegriffe aus dem Entwurf, je Sprache
    etsy-source.ts          öffentliche Suche + Detail-Nachladen
    ebay-source.ts          Browse-Treffer → gemeinsame Form
    research.ts             zwei Runden, Fehler pro Suche eingedämmt
    coverage.ts             misst, ob der Text die Recherche benutzt hat
    price.ts                Preis im Marktband einordnen
  marketplaces/
    ebay/auth.ts            OAuth (RuName!), User- und App-Token
    ebay/client.ts          Inventory/Account/Taxonomy REST; Offer-Recovery
                            per SKU-Lookup; InventoryItemGroup + Group-Publish
    ebay/aspect-spec.ts     Merkmals-Metadaten, reiner Parser
                            (inkl. aspectEnabledForVariations, Tri-State)
    ebay/aspects.ts         planAspects — die Ranking-Engine, rein
    ebay/aspect-cache.ts    7-Tage-Cache (Disk) + 1h-Memo (Prozess), roh
    ebay/title.ts           Titel-Hygiene (Symbole, Caps, Wiederholungen;
                            PETG/ASA/… sind kein Shouting)
    ebay/description.ts     Beschreibungs-Audit: aktive Inhalte, externe Links
    ebay/browse.ts          Browse API — Käufersuche für die Recherche
    ebay/pictures.ts        Trading API XML — Bild-Upload (Entities dekodiert)
    etsy/auth.ts            OAuth2 + PKCE; Refresh-Race-Recovery
    etsy/client.ts          Listings v3 + öffentliche Suche; Taxonomie wird
                            GEFLATTET (API liefert Baum!); updateListingContent,
                            updateListingVariations, Return-Policies
  commands/                 create publish preflight keywords proposal —
                            die Geschäftslogik; publish enthält Revise- und
                            Varianten-Pfad (publishEbayVariants)
  store/
    db.ts                   listings.json; Backup-Pfad auch bei kaputtem JSON
    file-lock.ts            prozessübergreifender Mutex + Windows-sicheres rename
  oauth/                    Token-Speicher, Callback-Server (Streu-Requests
                            brechen den Flow nicht mehr ab)
  util/
    http.ts                 Retry/Timeout; maxAttempts:1 überall wo Geld/Duplikate
    image-meta.ts           Bild-Maße aus Headern (PNG/GIF/JPEG-SOF/WebP), pur
    io.ts log.ts paths.ts
  web/
    server.ts               Routen; /progress/<id> für Hintergrund-Jobs
    jobs.ts                 In-Memory-Jobregistry (create, Bild-Übernahme)
    views.ts assets.ts      SSR-HTML + CSS/JS (SECURITY_HEADERS: ⚠️ referrer!)
    security.ts             Origin+Token-Gate; SECURITY_HEADERS zentral
    multipart.ts            eigener Parser
    aspect-fields.ts        Merkmale ↔ Formularfelder (eine Box je Merkmal,
                            Komma-Quoting je Wert); löst aspect-text.ts ab
    variant-text.ts         Varianten ↔ Text (SKU; Farbe; Preis; Menge)
```

**Wichtig:** Die Web-UI ruft `createCommand`/`publishCommand`/`auditContent`
auf — sie ist eine zweite Oberfläche, **kein Parallelpfad**. Was die CLI
erzwingt, erzwingt die UI. Ändert man eine Regel, gilt sie sofort für beide.

`util/io.ts` macht das möglich: Die Commands nehmen ein `Io`-Objekt für Prompts
und Fortschritt, Default ist das Terminal, die UI reicht ein sammelndes durch.

---

# Erkenntnisse, die Zeit gekostet haben

## Nachtrag 2026-08-18 (2) — Merkmals-Editor: eine Box je Merkmal

**Die Textarea ist abgelöst.** Die alte Begründung („eine generierte Zeile je
Merkmal kann kein Merkmal HINZUFÜGEN, und genau das braucht ein fehlendes
Pflichtmerkmal") galt — aber sie hat den teureren Fehler gedeckt: In einem
gemeinsamen Textfeld löscht ein Tastendruck einen Wert oder eine ganze Zeile,
und **nichts sagt es**, bis ein Publish zu kurz zurückkommt. Genau derselbe
Text zerfiel außerdem an Anführungszeichen und Doppelpunkten (Nachtrag 1).

`web/aspect-fields.ts` ist jetzt die einzige Wahrheit für beide Richtungen;
`aspect-text.ts` ist gelöscht (die Quoting-Helfer sind mitgezogen, die
Textarea-Funktionen waren danach toter Code). Die Regeln:

- **Ein gefüllter Wert trägt `required`** — der Browser verweigert das
  Absenden eines leergeräumten Felds („Fülle dieses Feld aus.", live geprüft).
  Entfernen geht nur über den Haken „entfernen"; das ist eine Entscheidung,
  kein Ausrutscher. JS nimmt das `required` beim Haken zurück.
- **Ein von eBay verlangtes Merkmal bekommt immer eine Box**, auch ohne Wert
  (`requiredAspectNames` in `server.ts`, aus dem 7-Tage-Spec-Cache, best
  effort). Es ist bewusst **nicht** `required`: Sonst blockierte jede
  Speicherung, bis es gefüllt ist — Preflight und Publish-Gate halten es
  ohnehin auf. Solche Boxen tragen `aspectHint<i>`, damit der Server ein
  leeres Erinnerungsfeld nicht als halb eingetipptes Merkmal ablehnt.
  (Genau diese Falle hat der Test gefunden, bevor sie in die UI kam.)
- **Ein Name ohne Wert ist ein Fehler, nie ein stiller Verlust** — die
  Speicherung wird mit Meldung abgelehnt.
- **Kommt ein POST ganz ohne Merkmalsfelder** (alte Seite, gebauter Request),
  bleiben die gespeicherten Merkmale stehen. Schweigen ist kein Löschbefehl;
  live gegengeprüft, alle 6 Merkmale überlebten.
- Leere Boxen am Ende plus „+ Merkmal" erhalten das, was die Textarea konnte:
  ein Merkmal hinzufügen, das die Kategorie verlangt. Eine leere Box wirft ✕
  wieder weg — rein clientseitig, weil sie nichts enthält; „+ Merkmal" klont
  ein `<template>`, nicht die letzte sichtbare Box, sonst wäre der Knopf tot,
  sobald man alle leeren Boxen entfernt hat.
- **Werte werden mit SEMIKOLON getrennt, nicht mit Komma** — im Livetest
  gefunden: `0,16 mm` wurde beim Tippen still zu `["0", "16 mm"]`. Gespeicherte
  Werte überlebten (sie werden beim Rendern gequotet), frisch getippte nicht —
  die schlimmere Hälfte, weil der Verkäufer zusieht und nichts merkt. Deutsche
  Werte tragen ständig Dezimalkommas; der Varianten-Editor hat denselben
  Konflikt schon mit `;` gelöst, jetzt macht dieser Editor es genauso.
  Gequotet wird nur noch, was ein `;` oder `"` enthält.

## Nachtrag 2026-08-18 — Analyse-Runde (6-Dimensionen-Review + Funktionstest)

Multi-Agent-Review (15/16 Agenten, adversarial verifiziert; die Dimension
web-server brach mit Verbindungsfehler ab und ist offen) plus kompletter
Hands-on-Test. Gefixt in dieser Runde:

- **Guard-Segmentierung, zweimal:** Erst `&&`/`;`/`|`, dann der Review-Fund:
  **Newlines fehlten im Split** — ein `--draft` auf Zeile 1 deckte ein echtes
  publish auf Zeile 2. Regeln laufen jetzt pro Segment inkl. `\n`;
  EBAY_ENV fail-closed über ALLE Quellen (Inline kann .env=production nicht
  weißwaschen).
- **Eigene Fotos via `--image-url` wurden als Quell-Downloads fehlklassiert**
  (Staging-Fallback nannte sie `NN.ext`) — Etsy war dann mit falscher
  Begründung dauerhaft gesperrt. `downloadImages` trägt jetzt ein
  Namenspräfix; Verkäufer-URLs landen als `own-NN.ext`.
  `looksLikeSourceDownload` matcht zudem `\d{2,}` (Bild 100+).
- **Merkmals-Editor-Roundtrip korrumpierte zwei Fälle:** nackte
  Anführungszeichen in Werten (`5" Zoll` → Quote-Toggle, Werte verschmolzen)
  und Doppelpunkte in NAMEN (`Massstab 1:87` zerriss am ersten `:`). Werte
  mit `"` werden jetzt gequotet; geparst wird am ersten `": "` (Fallback
  nackter `:` für handgetippte Zeilen). Tests pinnen beide.
- **Varianten-Preisparser** akzeptierte `Number()`-Syntax (`1e3`→1000,
  `0x10`→16, Sub-Cent) — jetzt striktes Ziffernmuster, Menge nur ganzzahlig.
- **Lost Updates in drei Commands:** `keywords` (2×) und `titles` upserteten
  einen Snapshot, der über minutenlange Recherche-/Claude-Aufrufe gehalten
  wurde — parallele UI-Saves gingen verloren. Vor jedem upsert wird frisch
  gelesen (dasselbe Muster wie der Web-Bild-Upload-Fix vom 16.08.).
- **„No follow-up searches ran"-Notiz verschwand** — nach `mine()` in das
  bereits kopierte Array gepusht (gleiche Falle wie die Cache-Notiz).
- **`publishOffer`-Lost-Response wedged nicht mehr:** Wirft der Publish, wird
  das Offer GELESEN — meldet es sich als published, wird die Listing-ID
  übernommen statt state=failed auf einem live Inserat. Kein zweiter
  Publish-Call in keinem Fall.
- **`createDraftListing` war retrybar** (Default 4 Versuche) — ein Timeout
  nach Commit hätte Duplikat-Drafts geprägt. Jetzt `maxAttempts: 1` wie
  createOffer/Bild-Upload.
- **OAuth-Callback:** eine Ablehnung mit FREMDEM state (veralteter Tab)
  bricht den frischen Flow nicht mehr ab.
- **Recherche-Cache-GC:** Key-Format-Wechsel hinterließ verwaiste Dateien für
  immer (im Live-Test an der marketplaceId-Erweiterung sichtbar geworden) —
  Writes fegen jetzt abgelaufene/unlesbare Einträge.
- **Rechte-Flash** nannte „zurückgenommen" neben „übernommen", wenn die
  Lizenzbox nie gesetzt war — Meldung nennt nur noch echte Änderungen.

**Verifiziert real, bewusst NUR dokumentiert** (Remote-Semantik, größerer
Umbau): wiederverwendeter Etsy-Draft gleicht Bilder nie ab (Teil-Upload
überlebt bis zur Aktivierung — braucht getListingImages-Abgleich).
**Plausibel, unverifiziert:** SKU-Wechsel nach Draft/Publish desynct
Offer↔Item; Draft-Reuse aktiviert Einzel-Inserate zu altem Preis/Menge
(updateListingInventory bewusst nicht angebunden); Gruppen-Abbruch nach
verlorener Group-Publish-Antwort. Die Dimension web-server (Routen, Jobs,
Multipart) fiel dem Abbruch zum Opfer — bei Gelegenheit nachholen.

## Nachtrag 2026-08-17 — Optimierungs-Sitzung (Cache, ToS, Review-Fixes)

- **Der Recherche-Cache sitzt in `runQuery` (`seo/research.ts`)** — der eine
  Punkt, durch den beide Marktplätze und beide Runden laufen. Einträge werden
  beim Lesen gegen `SearchResultSchema` re-validiert (Lehre vom aspect-cache),
  der Key trägt Query, Limit, buyerCountry und die eBay-Marktplatz-ID (der
  Browse-Header ist das Einzige, was dort den Markt wählt — ein Key ohne ihn
  servierte deutsche Zahlen für einen anderen Markt). Suchnotizen (z. B.
  „Detail-Fallback lief") werden mitgecacht und beim Treffer wiederholt, sonst
  überschreibt der Wiederholungslauf die Evidenz mit einer Version, in der die
  verkürzte Stichprobe wie eine vollständige aussieht.
- **Statischer Import friert `DATA_DIR` ein, bevor `beforeAll` greift.** Die
  erste Version von `research-cache.test.ts` importierte `isFresh`/`cacheKey`
  statisch — ESM hoisted das vor jeden Testcode, `LISTER_DATA_DIR` kam zu spät,
  und die Disk-Tests schrieben ein **fabriziertes „dart holder"-Ergebnis in den
  ECHTEN Nutzer-Cache**, wo eine Live-Recherche es 24 h lang als Marktdaten
  serviert hätte. `db.corrupt.test.ts` dokumentiert genau diese Falle. Regel:
  Module, die `DATA_DIR` lesen, in Tests **ausschließlich dynamisch**
  importieren, nach dem Setzen der Env-Variable. (Multi-Agent-Review hat es
  gefunden, inkl. der vergifteten Datei; sie ist gelöscht.)
- **`licenseFromText` erfand Lizenzen aus Seiten-Bytes.** `#cc0000` in einem
  Stylesheet matchte `CC0`, der Identifier `accByUser` matchte `CC-BY`, und ein
  nacktes „Attribution" (jeder Footer-Link) galt als Lizenzname — ein Upgrade
  auf „kommerziell erlaubt" am Verkaufsgate vorbei. Jetzt: Scripts/Styles
  werden vor dem Scan entfernt, alle Muster sind wortbegrenzt, „Attribution"
  zählt nur als Compound oder mit Version. Drei Tests pinnen es.
- **Wiederverwendete Etsy-Drafts bekamen weder Text noch Varianten.** Der
  Reuse-Zweig sprang direkt zur Aktivierung: ein nach `--draft` bearbeiteter
  Text ging nie zu Etsy, und Varianten aus dem Editor wurden still zum
  Einzel-Inserat degradiert — exakt der Fall, für den `variants` authored ist.
  Jetzt läuft `updateListingContent` + der Varianten-PUT (Full-Replace,
  idempotent) auch auf dem Reuse-Pfad. Bilder bewusst weiterhin nur beim
  frischen Draft (Upload hängt an, ersetzt nicht).
- **`expired` ist der NORMALE Endzustand jedes Etsy-Inserats dieses Tools**
  (`should_auto_renew=false`) — und fiel vorher in „neuen Draft anlegen"
  durch: Duplikat, verwaiste Historie, zweite Gebühr. Jetzt harter Stopp mit
  Verweis auf Shop Manager für alles außer `draft`/`active`.
- **Ein `group:<key>`-remoteId ist keine Offer-ID.** Varianten-`--draft`,
  dann Varianten im Editor geleert (der Shape-Lock schützt nur LIVE) →
  der Einzel-Pfad rief `updateOffer('group:…')`, eBay 404, Datensatz für
  immer verkeilt. Jetzt wird das Präfix erkannt und die Gruppe aufgegeben
  (Drafts kosten nichts); `createOffer` recovert ohnehin per SKU.
- **Etsy-API-ToS** (`docs/research/etsy-api-terms.md`): Verwaltung eigener
  Inserate ist der Kernzweck; die Keyword-Recherche berührt zwei Klauseln
  (Sammeln „für Analysen" nur mit schriftlicher Genehmigung; Mindestmengen-
  Gebot). Verteidigbar, solange sie anlassbezogen, aggregat-only und gecacht
  bleibt — der Cache ist damit auch ein Compliance-Feature, TTL nicht
  „sicherheitshalber" hochdrehen. Anzeige-Regel: dargestellte Artikelinhalte
  dürfen max. 6 h alt sein — wir zeigen keine, das muss so bleiben.
- **Subagenten-Limits:** 5 von 13 Review-Agenten fielen dem Sitzungslimit zum
  Opfer (Reset 23:20 Berlin beobachtet). Die Dimension `views-roundtrips`
  (views.ts-Escaping, Roundtrips, images.ts, create.ts) wurde deshalb **nicht
  erneut** tief reviewt — bei Gelegenheit nachholen.
- Kleinbefunde, offen und bewusst nur dokumentiert (unverifiziert): Bild-
  Abgleich bei wiederverwendetem Etsy-Draft (Teil-Upload wird nicht erkannt);
  SKU-Änderung nach Draft/Publish desynct Offer↔Item (eBay-Offer-SKU ist
  unveränderlich); verlorene `publishOffer`-Antwort verkeilt ein real
  gelistetes Einzel-Inserat (Recovery über `getOffer().listing` wäre möglich);
  Publish-Flash meldet Erfolg, wenn der verweigerte Marktplatz keine Zeile
  hat (nur per nachgebautem Formular erreichbar); Fortschrittsseite spricht
  bei Bild-Jobs von „Entwurf erstellt"; `show --remote` refresht das
  eBay-Token doppelt (zwei parallele Erst-Calls, harmlos).

## Nachtrag 2026-08-16 — Bugfix-Runde (komplette Codebasis reviewt)

- **Etsy nimmt 20 Fotos, nicht 10** (verdoppelt ca. 09/2025). `publishToEtsy`
  schnitt bei 10 ab. Ebenso: **Alt-Text-Limit ist 250 Zeichen**, nicht 500 —
  der alte Slice hätte 400er riskiert.
- **`saveUploads` (Web-UI) überschrieb Bilddateien.** Der Dateiname zählte
  `paths.length + 1` hoch; nach dem Entfernen von Bild 1 kollidierte der
  nächste Upload mit einer noch referenzierten Datei. Jetzt sondiert
  `freeImagePath` die Platte statt das Array.
- **`putInventoryItem` hartkodierte `brand: 'Markenlos'`** neben einem
  möglicherweise gesetzten `Marke`-Aspect. `productIdentityFromAspects` liest
  Marke/MPN jetzt aus den Aspects (deutsche und englische Schreibweise),
  Fallback bleibt Markenlos / Nicht zutreffend.
- **Lizenz-Lookup traf Object.prototype.** `MAKERWORLD_LICENSES["constructor"]`
  lieferte eine Funktion statt undefined — der Lizenzstring kommt von einer
  Webseite. Jetzt `Object.hasOwn`-Guard; Test pinnt es.
- **Kaputtes JSON in listings.json umging den Backup-Pfad.** Schema-Fehler
  sicherten die Datei, ein Syntaxfehler warf roh. Beide Wege enden jetzt
  gleich: Original nach `.corrupt-<ts>` verschoben, lauter Fehler, leerer Start.
- **Etsy-Refresh-Race entschärft:** Schlägt der Refresh fehl, wird der Store
  neu gelesen — hat ein paralleler Prozess das Token bereits rotiert, wird das
  gespeicherte benutzt statt eine Re-Consent zu verlangen.
- **eBay-Beschreibung wurde nie auf aktive Inhalte geprüft.** Policy id=4247
  lehnt `<script>`/Handler/`<iframe>` beim Einstellen hart ab, Links weg von
  eBay sind verboten — beides jetzt Preflight-Blocker (`ebay/description.ts`,
  rein, getestet). eBay-eigene Hosts (ebay.*, ebayimg, ebaystatic) sind erlaubt.
- **Etsy-Spec-Checks im Preflight:** Titel >15 Wörter (Etsy-Guidance),
  Single-Word-Tags (Multi-Word matcht exakt *und* broad — ein Einzelwort nur
  broad), Bilddateigröße >300 KB, erstes Foto <2000 px / <635×635, .webp
  gestaged. Bilddimensionen liest `util/image-meta.ts` direkt aus den Headern
  (PNG/GIF/JPEG-SOF-Walk/WebP) — kein Bildpaket als Dependency.
- **`.heic` ist jetzt als lokales Bild erlaubt** (beide Marktplätze nehmen es);
  `.webp` bewusst nicht — eBay ja, Etsy nein, und lokale Dateien sind
  Etsy-Staging.

### Runde 2 (Multi-Agent-Review + Verifikation, gleiche Nacht)

- **Das Lizenz-Verkaufsgate war nur ein Confirm** — und die Web-UI übergibt
  `yes: true`, also gar keiner. SDFL/BY-NC ohne Override ist jetzt ein harter
  Stopp in `create`, ein Preflight-Blocker und wird in `publishTo*` auch mit
  `--skip-preflight` erzwungen (`requireSaleRights`, Muster wie `ownDesign`).
  `unknown` bleibt Confirm — das ist der Fall, in dem der Nutzer mehr wissen
  kann als die Seite.
- **`getSellerTaxonomyNodes` liefert einen BAUM** — 15 Root-Knoten, alles
  Weitere in `children`. Der Client suchte nur die Roots, und das `path`-Feld,
  das der Code las, existiert im Schema gar nicht. Jetzt wird geflattet
  (Pfad beim Abstieg gebaut) und `matchTaxonomy` bevorzugt den tiefsten
  Blatt-Treffer. Vorher scheiterte praktisch jeder spezifische taxonomyHint.
- **`createOffer` wurde bis zu 4× retried** — nicht idempotent, ein Timeout
  nach erfolgreichem Anlegen wedged die SKU („already exists", offerId
  verloren). Jetzt `maxAttempts: 1` plus Recovery: bei Fehlschlag
  `getOffers?sku=…` und das existierende Offer via `updateOffer` übernehmen.
- **`publishToEtsy` legte bei jedem Lauf einen NEUEN Draft an.** Jetzt wird
  eine gespeicherte `remoteId` per `getListing` geprüft und der Draft
  wiederverwendet (Bilder hängen am Draft — kein Re-Upload); `active` wird als
  bereits veröffentlicht übernommen.
- **`processing_min`/`processing_max`** (gegen die API-Doku verifiziert)
  werden jetzt aus `processingDays` gesendet — vorher galt still der
  Shop-Default.
- **Fehlgeschlagener Publish-Versuch legte die Etsy-Zeile an**, deren Fehlen
  „Kanal nicht verfügbar" kodiert — `updateMarketplace` erzeugt fehlende
  Zeilen. Der Fehler wird jetzt nur auf existierenden Zeilen vermerkt.
- **Aspect-Engine:** Fill-from-facts verlangte Listen-Mitgliedschaft auch bei
  FREE_TEXT (wahre Farbe wurde verworfen — jetzt gleiche Regel wie für
  Verkäuferwerte); überschrittenes `requiredByDate` erzeugte GAR keinen Befund
  (jetzt Warnung „wurde bereits Pflicht"); `FROM_FACTS` matchte Substrings
  („Kabellänge" bekam die Artikellänge — jetzt Wortgrenzen); der
  Prozess-Memo über dem 7-Tage-Cache lief nie ab (jetzt 1 h TTL).
- **Merkmals-Editor:** Werte mit Komma („Höhe 1,5 cm") zerfielen im
  Roundtrip — jetzt CSV-artiges Quoting je Wert (die Funktionen hießen damals
  `formatAspects`/`parseAspects`; seit 18.08. `formatValues`/`splitValues` in
  `aspect-fields.ts`).
- **`tagText` (Trading-API):** XML-Entities werden jetzt dekodiert — eine
  escapte `FullURL` mit `&amp;` landete vorher korrupt in `imageUrls`.
- **Web-UI:** Lost-Update behoben (vor jedem `upsert` frisch lesen — der
  Bild-Upload hielt den Snapshot sekundenlang); `serveImage` liest vor
  `writeHead` (gelöschte Datei stürzte sonst via Unhandled Rejection den
  Server); `referrerpolicy` → `referrer-policy`; Bootstrap-Token
  timing-safe verglichen; kaputtes Cookie-%-Encoding ist jetzt 403 statt 500;
  Multipart-`name=`-Regex matchte in `filename=` hinein.
- **SEO:** 2-Buchstaben-Stopwörter überleben die Tokenisierung („made to
  order" fusionierte zu „made order"); `isRedundant` substring-matchte über
  Wortgrenzen („art print" ⊂ „dart printer"); der Views-Fallback-Merge
  überschrieb `converted_price` mit null (Batch/Detail laufen ohne
  `currency`-Parameter — jetzt selektiver Merge nur der Zielfelder).
- **Kleineres:** Etsy-Tag-Regel „kein führender Bindestrich/Apostroph" im
  Schema; PETG/ASA/TPU… nicht mehr als Shouting; `MANUFACTURER_MAX_LENGTHS`
  wird jetzt tatsächlich geprüft; `diffCopy` zeigt auch die Kategorie-Hints
  (mergeCopy wandte sie ungezeigt an; Hint-only-Proposals waren unannehmbar);
  Statusseite meldet „beschädigt" statt „0 Inserate"; tokens.json-Syntaxfehler
  bekommt die Recovery-Meldung; Streu-Request auf den OAuth-Callback bricht
  den Flow nicht mehr ab; `--price 12,99` wird nicht mehr zu 12,00
  (Dezimalkomma-Parser); Etsy-Bild-Upload nicht mehr retried (Doppelbild);
  aufgelöste eBay-Kategorie wird beim Publish persistiert;
  Ausgeschriebenes-CC („Attribution-NonCommercial") wird wieder erkannt;
  Preflight warnt, wenn gestagte Etsy-Bilder wie MakerWorld-Downloads heißen
  (Render-Policy).
- **Bewusst offen gelassen:** TOCTOU-Fenster in `clearIfStale` (bräuchte
  Lock-Identität, die Windows nicht atomar hergibt; das Fenster setzt einen
  Prozess voraus, der >10 s im Mikrosekunden-Abschnitt hängt und dann exakt
  zwischen stat und unlink released — akzeptiertes Restrisiko).

293 Tests. Die Nummern oben („260/279") sind Historie; aktueller Stand: 293.

Diese Liste ist der eigentliche Wert der Datei. Vieles davon widerspricht der
offiziellen Dokumentation.

## eBay

**`redirect_uri` ist keine URL.** Es ist ein „RuName"-Token aus dem Portal;
die echte Callback-URL liegt dahinter. Der RuName muss in *beiden* Schritten
gesendet werden — Authorize und Token-Tausch.

**eBay registriert kein `localhost`.** Deshalb kann die CLI keinen
Loopback-Server nutzen wie bei Etsy. Ablauf: Consent-Seite öffnen, Nutzer fügt
die Redirect-URL ein (`auth ebay --redirect-url "…"`). Der Code lebt **299
Sekunden**.

**`Accept-Language` ist Pflicht — obwohl die Referenz das Gegenteil sagt.**
Ohne den Header antworten `createOrReplaceInventoryItem`, `createOffer` *und*
`publishOffer` mit `25709 Invalid value for header Accept-Language`. Die Doku
listet für publishOffer ausdrücklich „All other standard RESTful request headers
are optional". Das stimmt nicht. Empirisch gegengeprüft: ohne Header 400, mit
204. Auch GET-Aufrufe brauchen ihn.

**`X-EBAY-C-MARKETPLACE-ID` gibt es in der Inventory API nicht.** Der Marktplatz
kommt aus `offer.marketplaceId` im Body. **In der Browse API ist genau dieser
Header dagegen der einzige Weg, den Marktplatz zu wählen.** Gleicher Anbieter,
gegenteilige Regel: Wer die Inventory-Gewohnheit mitnimmt, bekommt US-Treffer
für einen deutschen Shop — und das sieht aus wie funktionierender Code.

**Die Browse API braucht nur einen App-Token.** `getAppToken()` liefert ihn
bereits mit `.../oauth/api_scope`. Damit hängt die eBay-Keyword-Recherche
**nicht** am RuName und nicht an einer Nutzer-Einwilligung — nur an einem
Production-Keyset. Sandbox antwortet 403, und selbst mit Zugang wäre sie
wertlos: kein echter Bestand, also Rauschen statt Marktdaten.

**Existierende Location → 400 mit `errorId 25803`, nicht 409.** Deshalb erst
per GET prüfen, nicht create-and-tolerate.

**`pricingSummary.price.value` ist ein String**, Gewichte und VAT sind Zahlen.
`listingDuration` muss `GTC` sein. Die SKU steht **nur** im Pfad, nicht im Body.

**`offer.availableQuantity` überschreibt** die Menge des Inventory-Items — es
wird nicht das Minimum gebildet.

**Sandbox-Kategorievorschläge sind Zufallsmüll** und liefern **HTTP 200**.
„Dartständer" ergab *eBayana* und *Bücher*. Es gibt keine Exception zum
Abfangen — deshalb verweigert `suggestCategory()` in der Sandbox die Antwort
und verlangt `--category-id`. Der echte Kategoriebaum ist dagegen brauchbar:
`/commerce/taxonomy/v1/category_tree/77` laden und durchsuchen.

**Bild-Upload läuft über die alte Trading API** (`POST /ws/api.dll`, XML,
kein SOAP). Gute Nachricht: **unsere OAuth-Tokens funktionieren** über
`X-EBAY-API-IAF-TOKEN`, kein zweiter Auth-Flow nötig. Fallstricke:
- Fehler kommen mit **HTTP 200** und `<Ack>Failure</Ack>`
- `Ack: Warning` kann trotzdem erfolgreich sein — die **Anwesenheit einer URL**
  entscheidet, nicht der Ack
- Bilddaten müssen ein eigener MIME-Teil sein, nicht ins XML serialisiert
- ein Bild pro Aufruf
- **`node-html-parser` kleinschreibt Tag-Namen**: `querySelector('FullURL')`
  findet nichts, `'fullurl'` schon. Deshalb nutzt `pictures.ts` eine eigene,
  case-unabhängige Extraktion statt eines HTML-Parsers.
- eBay-gehostete Bilder haben ein `UseByDate` (~30 Tage), wenn sie in keinem
  Inserat landen

**Site-ID ≠ Category-Tree-ID.** Deutschland ist bei beiden zufällig **77**.
Zwei verschiedene Nummernräume, nicht zusammenlegen.

## Etsy (Client fertig, ungetestet)

**`x-api-key` ist `keystring:shared_secret`** (Doppelpunkt), `client_id` im
OAuth-Flow dagegen nur der nackte Keystring. Keystring allein → 403.

**`createDraftListing` ist `x-www-form-urlencoded`, kein JSON.** Nur
`updateListingInventory` nimmt JSON (und ist PUT).

**Entwurf ist gratis, `state=active` kostet ~0,20 €.** Deshalb ist der Publish
nie automatisch wiederholbar und `should_auto_renew=false`.

**Das Refresh-Token rotiert bei jeder Nutzung** und lebt 90 Tage. Deshalb das
Store-Locking (siehe unten).

**Regeln, die in keinem Schema stehen** (die Spec hat **kein einziges**
`maxItems`) und erst als 400 auffallen: Titel ≤140 und jedes von `% : & +` nur
**einmal**; Tags ≤13 à 20 Zeichen ohne Komma; Materialien nur Buchstaben,
Ziffern, Leerzeichen — `PLA-Plus` ist ungültig, `PLA Plus` gültig.
`types.ts` erzwingt das vorab.

`rank` beim Bild-Upload ist **1-basiert**. Feldname ist `image`.

**Der 403-Text unterscheidet nicht zwischen falschem und nicht freigeschaltetem
Key.** `{"error":"API key not found or not active, or incorrect shared secret
for API key."}` deckt drei verschiedene Ursachen mit einem Satz ab. Am
2026-08-13 gegen die echte API geprüft: `openapi.etsy.com` und `api.etsy.com`
antworten **identisch**, und `keystring:secret` wie auch der nackte Keystring
ebenfalls. Heißt: Aus dem Fehler lässt sich **nicht** ableiten, ob das
Header-Format falsch ist — man muss die Zugangsdaten unabhängig prüfen. Bei
einem abgelehnten Key kommen auch **keine** Rate-Limit-Header zurück.

**Mehrere Leseendpunkte brauchen gar kein OAuth** — `findAllListingsActive`,
`getListing`, `/listings/batch` und die Taxonomie deklarieren *keinen* Scope und
laufen auf dem API-Key allein. Kein Shop, keine Einwilligung, keine Gebühr.
Deshalb ist `searchActiveListings()` der billigste denkbare erste Live-Test des
ganzen Etsy-Clients: Er prüft Basis-URL, Key-Format, Limiter, Retry und
Fehlerübersetzung mit einem GET ohne Nebenwirkung. (`listTaxonomyNodes` schickte
bis jetzt ein OAuth-Token mit, obwohl der Kommentar daneben schon „public"
sagte — korrigiert.)

**Rate-Limits, live gemessen (2026-08-13):** `x-limit-per-second: 10`,
`x-limit-per-day: 10000`. Der Guide nennt keine feste Zahl mehr — Limits gelten
**pro API-Key** — aber für unseren Key ist es genau das alte 10/s. Der
`RateLimiter(8)` liegt also richtig. Das Tageslimit ist ein **gleitendes**
24-Stunden-Fenster, keine Mitternachts-Zurücksetzung.

**Der Header heißt `x-remaining-this-second`** — mit End-`d`. Der Guide schreibt
ihn als `x-remaining-this-secon`; das ist ein Tippfehler in der Doku. Der Code
liest beide Schreibweisen, die falsche ist schlicht nicht da.

**Bei abgelehntem Key kommen gar keine Rate-Limit-Header.** Nützlich zum
Unterscheiden: Header da = Zugangsdaten in Ordnung.

## eBay-Artikelmerkmale

**Nur `aspectRequired` entscheidet, nie `aspectUsage`.** Die Taxonomy API meldet
faktisch verpflichtende Merkmale teils mit `aspectUsage: "RECOMMENDED"`, während
`aspectRequired` auf true steht. Wer das Feld liest, dessen Name danach klingt,
baut ein Inserat, das eBay ablehnt. `usage` wird nur mitgeführt, um den
Widerspruch zu melden — ein `info`-Befund, der nichts entscheidet.

**Ein fehlendes Merkmal ist kein Ranking-Nachteil, sondern Ausschluss.** Es
entfernt das Inserat aus dem gefilterten Ergebnis, nicht nur aus den oberen
Rängen. Ziel ≥10, Untergrenze 7 — dort liegt eBays gemessener Faktor 2.

**Die Sandbox-Taxonomy ist brauchbar.** Anders als die Kategorievorschläge, die
dort Zufallsmüll mit HTTP 200 liefern: `get_item_aspects_for_category` gibt in
der Sandbox echte Merkmale zurück (Kategorie 59890: 7 definiert, 1 pflichtig).
Das war offen und ist jetzt geprüft.

**eBay benennt dasselbe Feld je Kategorie anders.** Kategorie 59890 nennt die
Herkunft `Ursprungsland`, andere `Herstellungsland und -region`. Eine
Fakten-Tabelle, die nur eine Schreibweise kennt, füllt in der nächsten Kategorie
stillschweigend nichts. Gleiches gilt für `Herstellernummer` als MPN.

**Der Texter erfindet Merkmale.** Live geprüft: Kategorie 59890 kennt gar kein
`Material` — `Material`, `Herstellungsverfahren` und `Befestigung` standen im
Datensatz, ohne dass die Kategorie sie definiert. Sie werden **behalten**, nicht
verworfen: eBay akzeptiert eigene Merkmale, und Verkäuferdaten wegzuwerfen, um
eine Taxonomie zu bedienen, wäre der falsche Tausch.

**Werte werden verworfen, nie gekürzt.** Ein auf `aspectMaxLength` gestutzter
Wert ist unwahr *und* trifft keinen Filter — das Schlechteste aus beidem.

**Facetten füllen nie ein faktisches Merkmal.** Sie liefern Schreibweise,
Stichentscheid bei `SINGLE` und die Rangfolge der Vorschläge. Sagt der Verkäufer
PETG, bleibt es PETG, auch bei 9.999 PLA-Treffern im Markt.

**Der Cache speichert die rohe Antwort, nicht die geparsten Specs.** Damit bleibt
`parseAspectSpecs` die einzige Wahrheit und eine Schemaänderung kann keinen alten
Cache falsch auslegen — der Fehler, der am 14.08. die `listings.json` gekostet
hat. TTL 7 Tage; ist eBay nicht erreichbar, wird ein abgelaufener Eintrag
benutzt und **jeder Blocker zur Warnung herabgestuft**: Ein Metadaten-Ausfall ist
kein Beleg dafür, dass ein Inserat falsch ist.

**„Live" hängt an `liveId`, nicht am `state`.** `state` hält den *letzten
Versuch* fest — ein gescheiterter Republish setzt ihn auf `failed`, obwohl das
Inserat online bleibt, und die Übersicht schob es dadurch zurück zu den
Entwürfen. `liveId` wird nur von einem erfolgreichen Publish gesetzt und nie
gelöscht. Nicht `remoteId`: die vergibt eBay schon für das Angebot, bevor
irgendetwas veröffentlicht ist.

**Aufrufbar sein ist die halbe Miete.** Der Pflichtmerkmals-Blocker existierte
schon, war aber unerreichbar: `checkEbay` bricht ohne `--category-id` vorher ab,
und die Web-UI ruft nur `auditContent` auf. Deshalb ist `auditEbayAspects` eine
eigene exportierte Funktion, die der Webserver aufruft. Die aufgelöste Kategorie
liegt jetzt als `ebayCategoryId` am Datensatz — vorher lösten Preflight und
Publish sie **unabhängig** auf und konnten gegen verschiedene prüfen.

## Wo das Lizenz-Gate sitzt — und wo bewusst nicht

**Entwerfen ist erlaubt, Veröffentlichen nicht.** Ein Entwurf ist lokal, kostet
nichts und legt nichts bei einem Marktplatz an; das Risiko entsteht
ausschließlich beim Live-Gehen. Und die Lizenzfrage wird in der Praxis oft
*danach* geklärt — man baut das Inserat auf und kauft die Commercial License
Membership des Creators, wenn es fertig ist. Ein Abbruch beim Anlegen schützte
darum nichts und verhinderte nur die Arbeit; an den Texten ändert die
Lizenzlage ohnehin kein Wort.

Getragen wird die Regel von `requireSaleRights` in `publish.ts`: greift in
beiden Publish-Pfaden, auch an `--skip-preflight` vorbei, und zusätzlich als
Preflight-Blocker. `create` sagt es nur laut. Ein Test pinnt beide Hälften.

**Deshalb gibt es den Rechte-Schalter am Inserat** (`POST /listing/:id/rights`,
Karte „Herkunft und Rechte"). Ohne ihn wäre ein Entwurf unter restriktiver
Lizenz eine Sackgasse: `licenseOverridden` ließ sich nur beim Anlegen setzen,
also hätte ein später gekaufter Lizenzvertrag ein Neuanlegen erzwungen — samt
Verlust aller Bearbeitungen und einem weiteren Claude-Aufruf. Der Schalter ist
in beide Richtungen bedienbar; eine Rechtebehauptung muss zurücknehmbar sein.

**Die Bilder des Designers sind eine ZWEITE, getrennte Behauptung.** `gate()`
nimmt dafür ein drittes Argument (`sourceImagesLicensed`, am Datensatz als
eigenes authored Feld). Getrennt, weil der Regelfall nur das Erste hergibt:
MakerWorlds Vereinbarung lizenziert „Model Collateral" — Fotos, Renderings,
Beschreibungen — an *MakerWorld*, nicht an Abonnenten. Wer „ich darf verkaufen"
ankreuzt, darf damit nicht stillschweigend auch „ich darf seine Fotos nehmen"
gesagt haben. Die Bild-Behauptung wirkt **nur zusammen** mit der Verkaufs-
Behauptung (Bilder können nicht für einen Verkauf lizenziert sein, der es nicht
ist) und schaltet `mayReuseText` nie frei — das war nicht behauptet.

Steht beides, erscheint am Referenz-Block der Knopf **„Diese N Bilder
übernehmen"**: lädt sie von MakerWorld, legt sie als Etsy-Dateien ab und
schiebt sie — wenn eBay verbunden ist — gleich auf eBays Bildserver. Ein Job
mit Fortschrittsanzeige, weil der Upload dauert. Die eBay-Hälfte ist
best-effort: ein fehlendes Token ist bei einem Entwurf normal und darf den
schon erfolgten Download nicht wegwerfen. Live durchgespielt: 4 Bilder → 4
lokale Dateien → 4 `i.sandbox.ebayimg.com`-URLs, beide Bild-Blocker weg.

Die Route wird serverseitig erneut gegen `gate()` geprüft, nicht nur im Markup:
Der Knopf erscheint zwar erst mit der Behauptung, aber ein Formular lässt sich
wiederholen, und dieses kopiert fremde Fotos in ein Inserat.

⚠️ **Der Schalter löst eine zweite Prüfung aus, und das ist Absicht:** Ohne
Override nennt der Texter die Lizenz im Credit (`requiresAttribution`). Wird
danach auf „lizenziert" gestellt, meldet Preflight `Listing text names a
licence` — denn die Lizenz der Seite ist dann *nicht* die, unter der verkauft
wird, und sie im Inserat abzudrucken wäre die Bekanntgabe eines Verstoßes, der
gar nicht stattfindet. Live gegengeprüft: Blocker verschwindet, Blocker
erscheint.

## Live-Inserate werden revidiert, nie neu eingestellt

**`publish` auf einem Inserat mit `liveId` ist automatisch ein Revise**, und
`lister revise <id>` ist der ausdrückliche Name dafür (verweigert sich, wenn
nichts live ist — er wird nicht still zum Erst-Publish). In der UI trägt
derselbe Knopf dann „Änderungen übertragen", mit eigenem Bestätigungstext —
Veröffentlichen kostet Gebühren, Revidieren nicht, und die Frage muss sagen,
welche von beiden gestellt wird.

- **eBay:** `createOrReplaceInventoryItem` + `updateOffer` auf dem bestehenden
  Offer. Kein `publishOffer` — das Offer *ist* veröffentlicht, und beide Writes
  wirken sofort aufs Live-Inserat. Item-ID, Watcher, Verkaufshistorie und die
  „SEO authority" (Temkin-Zitat) bleiben; genau deshalb nie End+Relist.
  **Folge 1:** Die Bestätigung kommt VOR dem ersten Write — schon
  `putInventoryItem` ändert das Live-Inserat, danach fragen hieße über die
  Vergangenheit abstimmen. **Folge 2:** `--draft` wird bei einem Live-Inserat
  verweigert statt uminterpretiert — eine Entwurfsstufe existiert im Revise
  nicht (UI blendet „Nur Entwurf anlegen" dann aus, der Server lehnt trotzdem ab).
- **Etsy:** `updateListingContent` — PATCH auf die vier Suchfelder (Titel,
  Beschreibung, Tags, Materialien; gegen die API-Doku verifiziert). **Preis und
  Menge bewusst nicht**: die liegen auf `updateListingInventory` (JSON-PUT) und
  sind nicht angebunden. Bearbeiten löst keinen Recency-Boost aus — ein Revise
  verbessert die Relevanzbasis, nicht das Momentum. Der Lookup-`catch` deckt
  nur `getListing`: Ein fehlgeschlagener Revise, der in „neuen Draft anlegen"
  durchfiele, würde aus einem kaputten Update ein Duplikat machen.

Alle Gates gelten unverändert: Preflight vor dem Revise, `requireSaleRights`
und `requireOwnDesign` auch mit `--skip-preflight`.

## Farbvarianten (eBay) und eigene SKUs

**Datenmodell:** `ListingRecord.sku` (eigene SKU fürs Einzel-Inserat, null =
lokale ID — beide durch `EbaySkuSchema`: ≤50 Zeichen, nur `A-Za-z0-9._-`, eBay
verträgt keine Leerzeichen) und `ListingRecord.variants`
(`EbayVariantsSchema`: je SKU, Farbe, Preis, Menge, optionale eigene Bilder;
Duplikat-SKUs und -Farben lehnt das Schema ab). Beide **authored** — eine
SKU-Liste, die still zu null degradiert, würde ein Einzel-Inserat
veröffentlichen, wo fünf Varianten gemeint waren.

**eBay-Modell — drei Bausteine:** ein Inventory-Item **pro Farbe** (eigene
SKU, eigene Aspects mit `Farbe=<Wert>`, eigene Bilder, max. **12** statt 24),
ein Offer pro SKU (eigener Preis/Menge), eine **Inventory-Item-Group** als
gemeinsame Hülle (`variesBy.specifications` rendert das Dropdown,
`aspectsImageVariesBy` lässt die Galerie beim Farbwechsel umspringen), und
**ein** `publish_by_inventory_item_group` für alles — Ergebnis ist EINE
Listing-ID. Auf einer live Gruppe ist derselbe Aufruf der **Revise** (ID
bleibt). Wiederholbar by construction: Items/Gruppe sind Full-Replace-PUTs,
`createOffer` recovert Bereits-existiert pro SKU.

**Drei Regeln, die Ärger sparen:**
1. `aspectEnabledForVariations` wird jetzt geparst (Tri-State). Explizites
   `false` → `UserError` vor dem Publish mit Begründung statt eBays
   Fehlercode. **Die Dart-Kategorie 59890 steht auf false** — Farbvarianten
   brauchen dort eine andere Kategorie.
2. **Formwechsel auf einem Live-Inserat ist verweigert** (Einzel↔Gruppe in
   beide Richtungen): das ginge nur per End+Relist. Welche Form live ging,
   kodiert `remoteId` (`group:<key>`-Präfix).
3. Der Farb-Aspect wird in **eBays Schreibweise der Kategorie** gesendet
   (Farbe/Colour/Color aus den Specs), nicht hartkodiert.

**Editor:** Textzeilen `SKU; Farbe; Preis; Menge` (`web/variant-text.ts`,
beide Richtungen, getestet). **Semikolons**, weil deutsche Preise Kommas
tragen — ein Komma-Format zerschnitte „19,90" in der Mitte. Fehler werden pro
Zeile gemeldet und verweigern den Save; Varianten-Bilder überleben den
Roundtrip per SKU-Match. `--sku` gibt es auch an `create`.

**Live gegen die Sandbox verifiziert** (Kategorie 261636 „Saisonales & Feste >
Figuren", eine der wenigen Sandbox-Kategorien mit `Farbe=enabledForVariations`;
gefunden per Baum-Sonde im Scratchpad): Draft-Lauf, Publish, Revise (gleiche
Listing-ID 110590210428), `show --remote` pro SKU. Dabei der teuerste Fund:

⚠️ **Gemeinsame Merkmale gehören bei Varianten-Inseraten an die GRUPPE.**
`Produktart` stand auf jedem der drei Items, und der Gruppen-Publish scheiterte
trotzdem mit „Das Artikelmerkmal Produktart fehlt". eBay liest die
Listing-Ebene-Merkmale eines Varianten-Inserats aus dem `aspects`-Feld der
Inventory-Item-Group — die Items steuern nur den variierenden Aspect bei
(je ein Wert pro Variante). Der Publish-Pfad sendet deshalb `plan.aspects`
minus Farb-Aspect an die Gruppe. Items tragen ihn zusätzlich; das stört nicht.

Nebenbefund desselben Laufs: Die `createOffer`-Recovery („already holds offer …
— reusing it") hat live funktioniert, dreimal — der Wiederholungslauf nach dem
fehlgeschlagenen Publish erzeugte keine Duplikate.

`show --remote` versteht das `group:`-Präfix und listet pro SKU Item, Farbe,
Offer und Bildzahl statt an `getOffer(group:…)` zu scheitern.

**Etsy-Varianten** laufen über `updateListingInventory` (der eine JSON-PUT):
ein `products[]`-Eintrag pro Farbe mit SKU und Offering (Preis als nackter
Float, kein Money-Objekt), Farbe als **Custom-Property 513** — freie Namen wie
„Waldgruen", keine Taxonomie-`value_ids` nötig. Die Falle des Endpunkts:
`price_on_property`/`quantity_on_property`/`sku_on_property` müssen die
Property nennen, nach der die Produkte sich unterscheiden, sonst 400 —
`buildVariationInventory` (pur, getestet) baut alle drei konsistent. Anders
als eBay erlaubt Etsy den Formwechsel Einzel↔Varianten jederzeit; der
Inventory-PUT ist ein Full-Replace. Eingehängt in Draft-Erstellung UND Revise.
**Gegen die echte API ungeprüft** — braucht das erste `lister auth etsy`
(Etsy hat keine Sandbox; Drafts sind kostenlos) und ein Eigendesign-Inserat,
denn das ownDesign-Gate gilt unverändert.

## Etsy ist für Fremddesigns geschlossen — Default-Deny mit protokolliertem Override

**Seit dem 10.06.2025 verlangen Etsys Creativity Standards Urheberschaft am
Entwurf** — „produced based on a seller's original design". Eine kommerzielle
Lizenz des Designers heilt das **nicht**: Etsy fragt nach Urheberschaft, nicht
nach Nutzungsrechten. Das sind zwei verschiedene Dinge, und es ist der Grund,
warum `--i-have-commercial-rights` hier nichts ausrichtet.

Umgesetzt als `ownDesign` am Datensatz (authored, kein `.catch()`, Default
`false`): Ohne das Flag bekommt ein Inserat **gar keine** Etsy-Zeile in
`marketplaces[]`, Preflight blockiert, `publishToEtsy` verweigert auch mit
`--skip-preflight`, und die UI sperrt die Etsy-Karte mit Begründung.

**Seit 18.08. gibt es einen bewussten Override:** `etsyDesignRiskAccepted`
(Objekt `{ at, sourceUrl }`, authored, Default `null`), gesetzt per
`--i-accept-etsy-design-risk` beim Anlegen oder über den Schalter unter
„Herkunft und Rechte" — pro Inserat, nie global, nie aus einer Konfiguration,
mit eigener Bestätigung. Der Grund für diese Bauform, festgehalten für später:

- **Die Lizenz beantwortet Etsys Frage nicht.** Wer das Plattformrisiko
  trotzdem tragen will, trifft eine eigene Entscheidung — die gehört als
  solche erfasst, nicht als stilles Konfig-Bit.
- **Das Risiko ist bewusst übernommen**, nicht wegdefiniert: Preflight zeigt
  bei gesetztem Override dauerhaft eine Warnung („Behauptung, keine geprüfte
  Bedingung"), `show` und die UI markieren es mit Datum.
- **Die Protokollierung (Zeitpunkt + Quell-URL) existiert, damit im
  Streitfall belegbar ist, auf welcher Grundlage ein Listing online ging.**
  Deshalb behält ein erneutes Speichern des Formulars den ursprünglichen
  Zeitpunkt, und der Override übersteht Revise.
- Der Override schaltet **ausschließlich** das Eigendesign-Gate frei
  (`requireOwnDesign` akzeptiert ihn als zweite Bedingung). Lizenz-Gate,
  Medien-Reuse und alle Geld-Invarianten kennen das Feld nicht. Umgekehrt
  schaltet keine andere Behauptung dieses Gate frei.
- Zurücknehmbar: Der Schalter entfernt die Etsy-Zeile nur, solange remote
  nichts existiert; danach blockt das Gate den nächsten Publish/Revise.

**Die Bildregel hat KEIN Override.** Etsy verlangt eigenes Originalmaterial
des fertigen Produkts — Designer-Renders und generierte Produktbilder sind
raus, unabhängig von Lizenz und Override (eigene Fotos nachbearbeiten ist in
Ordnung). Durchgesetzt doppelt: `requireOwnEtsyImages` im Publish-Pfad (auch
mit `--skip-preflight`; gefiltert wird per `looksLikeSourceDownload` in
`images.ts` — Downloads heißen `NN.ext`) und als Preflight-Blocker statt der
früheren Warnung. Etsy lädt nur die eigenen Dateien hoch; eBay bleibt
unverändert (eigene Gates, eigener Bildweg über URLs). Die bekannte Grenze
bleibt: Die Heuristik erkennt Namen, nicht Bildinhalte — eine umbenannte
Datei sieht sie nicht.

eBay kennt diese Einschränkung nicht. Dort trägt der MakerWorld-Fall.

## Keyword-Recherche

**Die Konkurrenzzahl gehört zur Suchanfrage, nicht zur Phrase.** `count` bei
Etsy und `total` bei eBay beziehen sich auf die gestellte Query. Eine Phrase,
die nur in Titeln auftauchte, hat deshalb **keine** Konkurrenzzahl — und `null`
heißt hier „nicht gemessen", nicht „keine Konkurrenz". Genau dafür gibt es die
zweite Recherche-Runde: Sie macht die stärksten Kandidaten zu Suchanfragen.

**Darum wird „ungemessen" schlechter bewertet als „gemessen und unumkämpft".**
Wäre unbekannte Konkurrenz mit dem Bestfall gleichgesetzt, wäre Nichtmessen die
gewinnende Strategie und die zweite Runde würde die Ergebnisse verschlechtern.

**Konkurrenz muss quadratisch gedämpft werden, sonst kippt der Score.** Mit
einfachem Logarithmus auf beiden Seiten gewinnt der gesättigte Massenbegriff
gegen die unumkämpfte Nische — das Gegenteil dessen, wofür der Score da ist.
Ein Test hält das fest (`mine.test.ts`); er hat den Fehler auch gefunden.

**Die Suche liefert fremde Produkte mit, und die vergiften die Auswertung.**
Eine Suche nach „dart" bringt T-Shirts über einen Footballspieler namens
*Jaxson Dart*. Im ersten echten Lauf standen „cam skattebo", „graphic tee" und
„vintage 90s" in den Top 10. Drei Regeln räumen das auf, alle drei erst durch
den Live-Lauf sichtbar geworden:

1. **Einzelwörter dürfen nicht den neutralen Konkurrenzwert bekommen.** Ein
   Wort ist per Konstruktion die breiteste Form jeder Anfrage, in der es
   vorkommt — und hat damit automatisch den höchsten Nutzeranteil. Es wird nie
   als Suchanfrage gestellt, behält also den moderaten Standardwert. Doppelt
   geschmeichelt. Gemessen: „3d printed" hat 1.196.038 Treffer, „dart holder"
   1.611. Unmaß gemessene Einzelwörter werden deshalb wie ~100.000 behandelt.
2. **„Nicht gemessen" darf auch bei der Nachfrage nicht besser sein als
   „gemessen und schwach".** Derselbe Fehler wie bei der Konkurrenz, eine Ebene
   tiefer. Wo Etsy Views liefert, heißt eine fehlende Nachfragezahl *zu wenige
   Inserate*, nicht *unbekannt* — und wird bestraft. Bei eBay, das gar keine
   Views kennt, bleibt sie neutral.
3. **Die Belegschwelle muss mit der Stichprobe wachsen.** Zwei Inserate von
   fünfzig sind ein Muster, zwei von dreihundert ein Zufall. Eine feste
   Untergrenze wird mit wachsender Stichprobe *schlechter*, weil eine breitere
   Suche mehr Fremdprodukte einsammelt, nicht weniger.

Wirkung am echten Inserat: 949 Kandidaten → 205, und die Top 10 wechselten von
„dart / holder / gift / cam skattebo" zu „dart holder, dart display, dart stand,
dart storage, darts gift".

**Zahlen in n-Grammen sind Müll.** „personalised 9" sah aus wie eine Phrase und
war ein Fragment. Verworfen wird jetzt jedes n-Gramm mit einem rein numerischen
Token — der Verlust echter Fälle wie „9 dart finish" ist der billigere Fehler.

**Der Entwurf ist ein Zustand, keine Nebenwirkung.** `keywords --rewrite` legt
ihn unter `listing.proposal` ab und fasst den Live-Text nicht an; `proposal`
zeigt, übernimmt oder verwirft ihn. Der Grund ist nicht Bequemlichkeit: Würde
das Übernehmen neu generieren, bekäme man **anderen** Text als den geprüften —
derselbe Prompt liefert nicht zweimal dieselben Wörter. Übernommen wird genau
das, was im Vergleich stand.

**Übernehmen geht pro Marktplatz.** Der Fall dafür ist real: Etsy-Recherche
existiert, eBay-Recherche nicht, also ruht die Hälfte des Entwurfs auf Belegen
und die andere auf dem Urteil des Modells. `--accept -M etsy` nimmt die belegte
Hälfte und lässt die andere stehen.

**Merkmale und Tags werden inhaltlich verglichen, nicht der Reihenfolge nach.**
`aspects` ist eine Map — `Object.entries` folgt der Einfügereihenfolge, also
läse eine reine Umsortierung sich als Änderung und der Verkäufer bekäme eine
Entscheidung vorgelegt, in der nichts zu entscheiden ist. Bei Etsy-Tags ist die
Reihenfolge für die Suche ohnehin bedeutungslos. Beides wird sortiert
verglichen; ein Test hält es fest.

**Digitale Downloads verseuchen alles.** Eine Suche nach „dart holder" liefert
zu einem Fünftel STL-Dateien. Die kosten 0,56 € statt 14 €, ranken mit „stl
bundle" und „digital download", und wer Objekte druckt, darf genau diese Wörter
nicht benutzen. `listing_type` trennt sie sauber; sie werden **ganz** aus der
Stichprobe entfernt, nicht nur geringer gewichtet. Wirkung am echten Inserat:
Median 11,90 € → 13,99 €, Kategorie-Konsens 37 % → 46 %, „stl bundle"
verschwunden. `both` bleibt drin — wer beides verkauft, ist ein echter
Wettbewerber.

**Die Preis-Extreme sind trotzdem andere Produkte.** Nach dem Filter reicht die
Spanne immer noch von 0,56 € bis 744,94 € — beides als `physical` markiert, weil
eine Stichwortsuche einen Dartpfeil-Flight nicht von einem Dartschrank
unterscheiden kann. Dagegen hilft kein Filter, nur Darstellung: Median und
mittlere Hälfte führen, die Extreme kommen hinterher, und wenn `max` mehr als
das Zehnfache des Medians ist, sagt der Text es ausdrücklich. Die Skala in der
UI zeichnet nur die mittlere Hälfte plus den eigenen Preis — auf die volle
Spanne gezeichnet wäre jedes vergleichbare Inserat ein Pixel am linken Rand.

**Ein Median über zwei Inserate ist kein Median.** Eine Phrase mit 1 % Anteil
behauptete 28,8 Views/Tag — ein einziges glückliches Inserat, präsentiert mit
derselben Autorität wie eine Zahl aus vierzig. Unter drei Messwerten gilt die
Nachfrage als unbekannt.

**Die Suche liefert `views`, `tags` und `original_creation_timestamp` — obwohl
das Schema keines davon aufführt.** Live geprüft am 2026-08-13: 25 von 25
Treffern. Das dokumentierte Schema für `findAllListingsActive` nennt sie nicht;
die echte Antwort enthält sie. Damit ist die Recherche **ein** Aufruf pro Suche
statt zwei — bei 10.000 Aufrufen/Tag der Unterschied zwischen 5.000 und 10.000
Suchen. `views` kommt auch für **fremde** Inserate. Der Batch-Endpunkt liefert
es ebenfalls (20/20), wird aber nur noch als Rückfallebene gebraucht.

**`price` ist die Shop-Währung, nicht die angefragte.** In einer 25er-Stichprobe
waren nur 2 in EUR — der Rest USD, AUD, MAD, GBP. Was `currency=EUR` füllt, ist
`converted_price`, und das war bei allen 25 da. Wer nur `price` liest, wirft die
Stichprobe weg und beschreibt am Ende die paar Shops, die zufällig in Euro
auszeichnen. Ohne den `currency`-Parameter ist `converted_price` **null**.

**Inserate unter sieben Tagen fließen nicht in die Nachfrage ein.** Etsy zählt
Views einmal täglich. Ein zwei Tage altes Inserat mit 0 sagt nichts, eines mit
40 impliziert 20/Tag — eine Rate, die kein etabliertes Inserat hält. Beide
Richtungen sind Rauschen.

**Seeds kommen aus dem Entwurfstext, nicht von MakerWorld.** MakerWorld-Titel
sind englisch, eBay-Texte deutsch. Von der Quellseite aus zu starten hieße, den
deutschen Marktplatz mit englischen Wörtern zu durchsuchen.

**eBay-Facetten schlagen jede Titel-Analyse.** `ASPECT_REFINEMENTS` liefert die
Item-Specifics **mit Trefferzahlen** — eBays eigener Index statt unserer
Vermutung. Die exakte Schreibweise zählt: Ein Wert, der nicht zum Filter passt,
ist für den Filter unsichtbar. (Antwortform laut Doku, **noch nicht live
verifiziert**.)

## MakerWorld

**Cloudflare blockiert direkte Abrufe** — 403 mit Challenge, auch vom eigenen
Rechner. Verlässlicher Weg: Seite im Browser speichern, `--from-html <datei>`.
Nebeneffekt: gar kein automatisierter Zugriff, was auch die ToS-Frage erledigt.

**Daten liegen in `__NEXT_DATA__` → `props.pageProps.design`** (Pages Router,
kein `self.__next_f`).

**Cloudflare injiziert sein Erkennungsskript auch in ERFOLGREICHE Seiten.**
Jede echte MakerWorld-Seite trägt gegen Ende ein
`<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js">`. Die alte
Challenge-Erkennung suchte den Teilstring `challenge-platform` — und lehnte
damit **jede echte gespeicherte Seite** ab, also ausgerechnet den Weg, den das
README als den verlässlichen bezeichnet. Unsichtbar geblieben ist das, weil die
Test-Fixtures synthetisch sind und gar kein Cloudflare-Skript enthalten.
Zwei Konsequenzen, beide umgesetzt:

1. Die Marker-Liste enthält nur noch, was ausschließlich auf einer echten
   Sperrseite steht: `_cf_chl_opt`, `cf-browser-verification`, der
   Orchestrate-Pfad `/cdn-cgi/challenge-platform/h/` (**nicht** `/scripts/jsd/`),
   und die Wortlaute der Interstitials.
2. Wichtiger: **Erst parsen, dann fragen.** Enthält die Seite MakerWorlds
   Modell-Payload, ist sie per Definition keine Sperrseite — egal welche
   Skripte sie mitbringt. Die Marker-Frage entscheidet nur noch, *welche*
   Fehlermeldung kommt, wenn der Payload fehlt. Dort verdient sie sich ihren
   Platz weiterhin: sonst würde der `<title>` einer Sperrseite als Modellname
   durchgehen und ein Inserat „Just a moment…" erzeugen.

**Fehlende eigene Fotos sind beim Anlegen eine Warnung, kein Abbruch.** Der
harte Wurf schützte nichts — Publishing ohne Bilder ist an vier Stellen
gesperrt (beide Preflight-Blocker, beide Publish-Pfade) — kostete aber genau
den Ablauf, der ihn braucht: Das Web-Formular hat **kein Bildfeld** (Fotos
kommen im Editor dazu, wo man sie sehen und sortieren kann) und übergibt immer
leere Listen. Damit war jedes Inserat unter einer nicht-permissiven Lizenz im
Browser **grundsätzlich nicht anlegbar** — inklusive jedes Falls mit
`--i-have-commercial-rights`. Ein Entwurf ohne Fotos ist ein legitimer
Zwischenstand; ein *Inserat* ohne Fotos nicht, und den bewachen die Gates.

**Lizenzwerte sind nackt:** `BY-NC`, nicht `CC BY-NC`. Dazu `CC0`, `BY`,
`BY-SA`, `BY-ND`, `Standard Digital File License` (+ Community-Use und
Platform-Print-Only) und `MakerWorld Exclusive License`. Eine CC-verankerte
Regex verfehlt **alle** davon.

**Bilder liegen unter `designExtension.design_pictures`** — `designExtension`
ist ein Objekt, kein Array.

**`isSubscribedCreator` in `pageProps`** sagt (eingeloggt), ob das kommerzielle
Abo diesen Creator abdeckt. Lizenzen gelten **pro Creator**, nicht plattformweit.

## Rechtliches — direkt aus der Mitgliedschaftsvereinbarung gelesen

**Die Bildprüfung erkennt nur den Host, nicht das Bild.** `isMakerWorldAsset`
prüft die URL. Wird ein Designer-Render erst lokal gespeichert und dann zu eBay
hochgeladen, liegt es unter `i.ebayimg.com` und die Prüfung ist blind. Das ist
eine bekannte Grenze, kein Fehler — sie zu schließen bräuchte einen Bildvergleich
gegen die Quellbilder.

**§6.5.1/6.5.2: Die kommerzielle Lizenz deckt das Modell, nicht die Bilder.**
„Model Collateral" (Fotos, Renderings, Beschreibungen) wird **an MakerWorld**
lizenziert, nicht an Abonnenten; der Creator behält alle Rechte daran.
Deshalb schaltet `--i-have-commercial-rights` die Designer-Bilder **nicht** frei
— fremde Produktbilder sind ein klassischer VeRO-Auslöser, und VeRO trifft das
Konto, nicht nur das Inserat.

**§5.3.4: Die Lizenz endet mit dem Abrechnungszeitraum.** Ein GTC-Inserat läuft
unbegrenzt weiter — nach einer Kündigung verkauft man ohne Lizenz.

**§2.7:** Mitgliedschaftsstufen können Umsatz-/Stückzahlgrenzen haben.

**GPSR:** Wer selbst druckt und unter eigenem Namen verkauft, **ist Hersteller**
(Art. 3) und als EU-Ansässiger sein eigener verantwortlicher Wirtschaftsakteur.
Also `regulatory.manufacturer` füllen und `responsiblePersons` **weglassen** —
das Array ist für Hersteller außerhalb der EU.
Der `regulatory`-Block sitzt an der **Wurzel des Offer-Objekts**; es gibt kein
`product.regulatory`. Enum-Wert wäre `EUResponsiblePerson` (PascalCase), nicht
`EU_RESPONSIBLE_PERSON` — das ist nur der Java-Konstantenname.
Pflicht ist es **pro Kategorie**, abfragbar über `getRegulatoryPolicies`.

**VAT:** `applyTax` ist der US-Sales-Tax-Schalter, **kein** VAT-Schalter. Für
die Kleinunternehmerregelung den `tax`-Block **ganz weglassen**.

**Das größte Kontorisiko ist nicht die Lizenz, sondern der Verkäuferstatus.**
Selbstgefertigte Neuware mit Gewinnabsicht ist gewerblich, unabhängig von der
Stückzahl. Als Privatverkäufer gelistet → Abmahn- und Sperrrisiko.

## Persistenz und Schema-Änderungen

**Abgeleitete Felder degradieren, verfasste Felder scheitern laut.** Das ist
keine Stilfrage, sondern die Lehre aus einem echten Vorfall am 2026-08-14:
`priceBandEur` bekam drei **Pflichtfelder** dazu, ein gespeicherter Datensatz
trug noch die alte Form — und `read()` in `db.ts` schob die komplette
`listings.json` beiseite. Wegen einer Statistik, die ein Befehl in zehn Sekunden
neu berechnet, war der Zugriff auf Inserat, Texte, sieben Bilder und den
Live-Zustand bei eBay weg.

Deshalb tragen `seo`, `proposal` und `titleOptions` jetzt `.catch(null)`: Passt
die Form nicht, wird das Feld `null` und der Rest lebt weiter. `copy`, `product`
und `source` tragen es **nicht** — dort wäre stilles Verwerfen ein Datenverlust,
der sich nicht wiederherstellen lässt. `resilience.test.ts` hält beide Hälften
fest.

Der Schutzmechanismus in `db.ts` war übrigens richtig: Er hat die Datei
gesichert statt sie zu überschreiben, und die Sicherung ließ sich vollständig
zurückspielen. Falsch war das Schema, nicht der Wächter.

## Nebenläufigkeit

`store/db.ts` und `oauth/tokens.ts` machen Read-Modify-Write über ganze Dateien.
Ohne Sperre verlieren zwei Prozesse gegenseitig Updates — bei den Tokens
katastrophal, weil Etsys rotierendes Refresh-Token dann verbrannt ist.
Gelöst über `withFileLock()`; kritische Abschnitte sind rein synchron, das Lock
wird nur Mikrosekunden gehalten.

**Windows:** `rename()` über eine offene Datei wirft `EPERM` — POSIX ersetzt
still, Windows verweigert. Ein *lesender* Prozess genügt. Deshalb
`replaceFile()` mit kurzem Retry und PID-behaftete Temp-Namen.

**Test-Hinweis:** `db.concurrency.test.ts` startet zwei echte Prozesse — im
selben Prozess würden zwei async-Tasks nie verzahnen, weil im kritischen
Abschnitt kein `await` steht. Der Test prüft **beide** Richtungen: Ohne Lock
*muss* er scheitern, sonst beweist der gesperrte Lauf nichts. Die Verzögerung
sitzt bewusst zwischen Lesen und Schreiben — dort entsteht der Lost Update;
liegt sie außerhalb, besteht der ungesicherte Lauf gelegentlich zufällig.
Der Worker nutzt dasselbe `replaceFile()` wie der Produktivcode.

## Web-UI

Design „Werkstatt": warm, dicht, oranger Akzent (`docs/ui-directions.html` zeigt
die drei Entwürfe, A wurde gewählt). `node:http` + serverseitiges HTML + wenig
Vanilla-JS, kein Bundler, kein Framework, keine neue Abhängigkeit.

**Sicherheit — nicht optional.** Der Server hält gültige Tokens und kann Geld
auslösen. „Nur localhost" ist keine Grenze: Jede besuchte Webseite kann an
`127.0.0.1:4321` posten. Deshalb Bindung nur an 127.0.0.1, Origin-Prüfung auf
jedem POST **und** ein Sitzungs-Token (Cookie, `SameSite=Strict`). Beide Wege
sind live gegengeprüft, beide antworten mit 403. 14 Tests decken das ab.

Preflight-Blocker gelten auch serverseitig — der Knopf ist gesperrt, *und* die
Route lehnt einen wiederholten Formular-POST ab.

**`localhost` und `127.0.0.1` sind dieselbe Maschine, aber nicht dieselbe
Origin.** Wer die UI unter `localhost:4321` öffnet, bekam jede Seite normal
angezeigt und bei **jedem** Knopf einen 403 — die Origin-Prüfung verglich exakt
gegen `127.0.0.1:<port>`. Beide Schreibweisen plus `[::1]` werden jetzt
akzeptiert, **bei identischem Port**. Das lockert nichts: Eine feindliche Domain,
die auf 127.0.0.1 auflöst, sendet ihren eigenen Namen als Origin und fliegt
weiterhin raus, und das Sitzungs-Token ist ohnehin die eigentliche Sperre.

**`Referrer-Policy: no-referrer` zerstört die Origin-Prüfung.** Der Header hieß
lange `referrerpolicy` — das ist die Schreibweise des HTML-*Attributs* und als
Header-Name wirkungslos. Die Korrektur auf `referrer-policy` schaltete die
Policy scharf, und damit brach **jeder POST in der UI**: Nach dem Fetch-Standard
(„Append a request Origin header") sendet der Browser unter `no-referrer` auch
bei **gleichorigen Formular-POSTs** `Origin: null`. `checkOrigin` lehnt das
korrekt ab → 403 auf jeden Knopf, während alle Seiten normal rendern. Das exakt
gleiche Fehlerbild wie beim `localhost`-vs-`127.0.0.1`-Fall weiter oben, aber
mit ganz anderer Ursache. Richtig ist `same-origin`: Der eigene Origin bleibt
erhalten, nach außen (eBay, Etsy, MakerWorld) geht weiterhin kein Referrer. Die
Header liegen jetzt als `SECURITY_HEADERS` in `security.ts`, mit Test.
**Nur im Browser gefunden** — kein Unit-Test hätte das je gezeigt.

**Das Anlegen läuft als Hintergrund-Job, nicht im Request.** `POST /new`
startet einen Job und antwortet sofort mit einem Redirect auf
`/new/progress/<id>`; die Seite pollt `…/state` im Sekundentakt. Der Grund ist
nicht Eleganz, sondern dass der Lauf eine halbe Minute dauert (Seite parsen,
Lizenz-Gate, zwei Sprachen Text von Claude, Bilder stagen) und eine offene POST
dem Nutzer ein leeres Fenster zeigt, in dem sich ein langsames Modell nicht von
einem hängenden Prozess unterscheiden lässt. Der angezeigte Fortschritt ist
**echt**: Die Commands melden ihre Schritte längst über `Io`, `jobs.ts` sammelt
genau diese Zeilen. Der Balken ist bewusst unbestimmt — es gibt keine ehrliche
Prozentzahl für „wartet auf ein Sprachmodell". Jobs liegen nur im Speicher (10
Min. Nachlauf); das Inserat selbst persistiert der Command, nicht der Job.

**Die Statusseite zeigt nie einen Zugangsdatenwert.** `status.ts` liest
ausschließlich Vorhandensein, Ablaufdaten und Scope-Anzahl — die Geheimnisse
betreten das Modul gar nicht erst, es gibt also keinen Schwärzungsschritt, den
man vergessen könnte. Ein Test setzt Platzhalter in alle Variablen und prüft,
dass keiner davon in der Ausgabe auftaucht.

**Ein Diagnosewerkzeug muss überleben, was es diagnostiziert.** `storedTokens()`
löst den Kontonamen über `config.ebay.env` auf, und das wirft bei einem Tippfehler
in `EBAY_ENV`. Damit riss ausgerechnet die Seite ab, die den Tippfehler anzeigen
sollte. Die Token-Abfragen laufen jetzt in einem `try`.

---

## Wie man es startet

```bash
cd C:\Users\Nilsg\projects\3d-print-lister
npm test && npm run build

npx tsx src/cli.ts ui              # Web-UI
npx tsx src/cli.ts list            # CLI-Übersicht
npx tsx src/cli.ts show <id> --remote   # gegen eBay gegenprüfen
npx tsx src/cli.ts preflight <id> --marketplace ebay --category-id 59890

npx tsx src/cli.ts keywords <id> -M etsy            # recherchieren (nutzt den 24h-Cache)
npx tsx src/cli.ts keywords <id> -M etsy --fresh    # Cache umgehen, live suchen
npx tsx src/cli.ts keywords <id> -M etsy --rewrite  # + Entwurf erzeugen
npx tsx src/cli.ts keywords <id> --reuse-research --rewrite  # neuer Entwurf,
                                                    #   ohne erneut zu suchen
npx tsx src/cli.ts aspects <id> --category-id 59890  # Merkmale planen
npx tsx src/cli.ts titles <id>                      # 5 Titelvarianten je Markt
npx tsx src/cli.ts titles <id> --use 3 -M etsy      # Variante 3 übernehmen
npx tsx src/cli.ts proposal <id>                    # Vorher/Nachher ansehen
npx tsx src/cli.ts proposal <id> --accept           # übernehmen
npx tsx src/cli.ts proposal <id> --accept -M etsy   # nur eine Hälfte
npx tsx src/cli.ts proposal <id> --discard          # verwerfen

npx tsx src/cli.ts revise <id> -M ebay --yes        # Live-Inserat aktualisieren
                                                    #   (verweigert, wenn nichts live)
npx tsx src/cli.ts create … --sku WW-XYZ-01         # eigene SKU beim Anlegen
# Varianten: im Web-Editor als Zeilen "SKU; Farbe; Preis; Menge" —
# publish erkennt sie und veröffentlicht EIN Inserat mit Farb-Dropdown.
# Sandbox-Test lief in Kategorie 261636 (Farbe dort variation-enabled).
```

`.env` (gitignored) enthält die Zugangsdaten; `.env.example` ist die Vorlage.
Zustand liegt in `~/.3d-print-lister/` (Tokens, listings.json, settings.json,
Bilder) — bewusst außerhalb des Repos.

**Zwei getrennte Arten von Konfiguration, und die Trennung ist die Regel:**
Geheimnisse stehen in `.env` und werden von der UI **nie** gerendert, nur auf
Vorhandensein geprüft. Vorgaben (Standardmaterial, Bearbeitungszeit,
Stichprobengröße) stehen in `settings.json` und sind über die Einstellungsseite
editierbar. Weil in `settings.json` nichts Geheimes liegen kann, braucht die
Seite keine Schwärzungsregel, die man falsch machen könnte.

Recherche zu allen APIs: `docs/research/` (8 Dateien, adversarial verifiziert).

## Was als Nächstes ansteht

1. **Etsy-OAuth verbinden** — der eine Schritt, an dem alles Etsy-Schreibende
   hängt. `npx tsx src/cli.ts auth etsy` öffnet den Browser; der Nutzer muss
   **Grant access** klicken. Das Fenster ist seit 17.08. **15 Minuten** (der
   Versuch am 16.08. lief in den alten 5-Minuten-Timeout), die Fehlermeldung
   erklärt jetzt den Retry. Voraussetzung: `http://localhost:3456/callback`
   als Redirect an der Etsy-App. Danach sofort testbar: `getIdentity`,
   Versandprofile, Return-Policies (alles read-only) — dann Etsy-Varianten-Draft.
2. **Etsy-Varianten-Drafttest** (kostenlos, Etsy hat keine Sandbox!). Braucht
   zusätzlich ein Inserat mit `ownDesign` — das Gate steht auch im Test, und
   die Behauptung kann nur der Nutzer machen. Kein aktuelles Inserat
   qualifiziert. Beim Test auch den neuen Reuse-Pfad prüfen (Text + Varianten
   auf wiederverwendetem Draft — 17.08. gebaut, nie gegen die echte API
   gelaufen).
3. **GPSR live prüfen** — `SELLER_*` füllen und einen Publish in einer
   Kategorie testen, die die Daten verlangt (Längen-Limits werden seit 16.08.
   beim Laden erzwungen). Die Einstellungsseite zeigt den Status („nicht
   gepflegt").
4. **Produktion vorbereiten:** gewerbliches Konto, Impressum,
   Widerrufsbelehrung, AGB; Production-Keyset + eigener RuName;
   Account-Deletion-Notification. Das Keyset schaltet nebenbei die
   eBay-Keyword-Recherche frei — die hängt nur daran, nicht am RuName.
   Für echte Farbvarianten: Kategorie mit `aspectEnabledForVariations` für
   Farbe wählen (Dart 59890 kann es nicht; Deko-/Figuren-Kategorien meist ja).
5. **Etsy-App-Zweck prüfen/ergänzen** (Entwicklerkonto): muss Inserats-
   verwaltung UND Keyword-Recherche fürs eigene Inserat nennen — Details und
   Begründung in `docs/research/etsy-api-terms.md`. Optional developer@etsy.com
   um schriftliche Bestätigung bitten.
6. **Review-Dimension `views-roundtrips` nachholen** (fiel dem Subagenten-
   Limit zum Opfer) und die dokumentierten Kleinbefunde aus dem Nachtrag
   17.08. bei Gelegenheit abarbeiten.

Erledigt am 17.08.: Recherche-Cache (Punkt 4 alt), ToS-Lektüre (Punkt 3 alt),
`git init` (Punkt 8 alt; Baseline `5013a0c`). Das offene Dartshalter-Proposal
(Punkt 7 alt) existiert nicht mehr — `lister proposal` meldet sauber „no
pending rewrite".

## Arbeitsweise, die sich bewährt hat

Bei jeder API-Behauptung: **gegen den echten Endpunkt prüfen.** Fast jeder Fehler
in dieser Liste kam durch einen echten Aufruf ans Licht, nicht durch Lesen — und
mehrere widersprechen der offiziellen Dokumentation direkt. Ein Test, der nur
den Erfolgsfall abdeckt, hätte keinen davon gefunden.
