# Plan: Keyword-Recherche für organisches Ranking

> Stand: 2026-08-13. Ergänzt `ARCHITECTURE.md`. Ziel: Der Text-Generator soll
> nicht mehr frei erfinden, welche Wörter Käufer suchen, sondern es aus echten
> Marktplatzdaten ableiten — und Titel, Tags und Item-Specifics danach bauen.

## Kurzfassung

Die Recherche zu diesem Plan hat einen Endpunkt zutage gefördert, der die
Reihenfolge im Projekt ändert:

**`findAllListingsActive` (`GET /v3/application/listings/active`) braucht kein
OAuth, keinen Shop und kein Geld — nur den API-Key.** Er nimmt `keywords`,
sortiert auf Wunsch nach `score` (Etsys eigener Relevanz-Rang) und liefert pro
Treffer **Titel, Tags, Materialien, Preis, `num_favorers` und `taxonomy_id`**
zurück. Dazu einen `count` — die Zahl aller aktiven Inserate zum Suchbegriff.

Damit ist Keyword-Recherche auf Etsy **heute** baubar, obwohl der Shop noch
nicht verbunden ist. Und mehr: Dieser Aufruf ist der billigste denkbare erste
Live-Test des Etsy-Clients (Risiko Nr. 1 in `ARCHITECTURE.md`) — ein GET ohne
Nebenwirkung, das trotzdem Basis-URL, `x-api-key`-Format, Rate-Limiter, Retry
und `explain()` gegen die echte API prüft.

## Umsetzungsstand (2026-08-13)

| Phase | Stand |
|---|---|
| 0 — erster Live-Kontakt | **erledigt**, gegen die echte Etsy-API |
| 1 — Recherche-Modul | fertig: `src/seo/`, beide Quellen, zwei Runden, Fehler pro Suche eingedämmt |
| 2 — Text-Generator | fertig: Evidenz-Block im Prompt, Keyword-Regeln, `seo` am Datensatz |
| 3 — CLI + UI | fertig: `lister keywords <id> [--apply]`, Panel im Web-Editor |
| 4 — eBay | Client fertig (`ebay/browse.ts`), blockiert auf einem Production-Keyset |
| 5 — Rückkopplung | offen, braucht live geschaltete Inserate |

51 neue Tests. Der Live-Lauf hat drei Bewertungsfehler aufgedeckt, die gegen
Fixtures unsichtbar waren — siehe „Keyword-Recherche" in `ARCHITECTURE.md`. Ein
Fixture-Test hatte vorher schon einen vierten gefunden: Die erste Score-Formel
dämpfte Konkurrenz zu schwach und hätte gesättigte Massenbegriffe empfohlen.

**Gemessene Kosten:** ~7 Aufrufe pro Marktplatz und Inserat (4 Seed-Suchen +
3 Konkurrenzmessungen), bei 10.000 Aufrufen pro Tag. Der Cache aus Phase 1 ist
weiterhin offen — jetzt aber auslegbar statt geraten.

---

## Was das Etsy-MCP ist — und was nicht

Das installierte MCP (`learn_etsy_api`, `list_endpoints`, `get_endpoint`,
`get_schema`, `list_guides`, `get_guide`, `search_etsy_api`) ist ein
**Dokumentationsserver**: die OpenAPI-Spec und die Developer-Guides, abfragbar.
Es hat **keinen Zugang zu Shop-Daten** und ersetzt keinen API-Key.

Was es trotzdem wert ist:

- **Es hat einen Bestandsfehler bestätigt und einen neuen gefunden.** Die
  Behauptung aus `ARCHITECTURE.md`, `x-api-key` sei `keystring:shared_secret`,
  steht so wörtlich in der aktuellen Auth-Übersicht. Bestätigt.
- **Der Rate-Limit-Guide nennt keine feste Obergrenze mehr.** `etsy/client.ts`
  hat `RateLimiter(8)` mit dem Kommentar „Etsys documented ceiling ist
  10 requests/second". Diese Zahl steht in der heutigen Doku nicht mehr. Statt
  dessen: Limits gelten **pro API-Key**, stehen im Developer-Portal und in
  **jeder Antwort** als Header. Der Kommentar ist also inzwischen falsch.
- Es liefert vollständige Response-Schemas, ohne 900 KB Spec herunterzuladen.

**Rate-Limit-Header, die wir auslesen sollten:**

| Header | Bedeutung |
|---|---|
| `x-limit-per-second` | QPS-Limit dieses Keys |
| `x-remaining-this-secon` | Rest in dieser Sekunde — **so** in der Doku, ohne `d`. Vermutlich Tippfehler im Guide; echten Namen empirisch prüfen |
| `x-limit-per-day` | QPD-Limit, gleitendes 24-h-Fenster (keine Mitternachts-Zurücksetzung) |
| `x-remaining-today` | Rest im gleitenden Fenster |
| `retry-after` | Sekunden bis zum Wiederversuch, nur bei 429 |

Das Tageslimit ist ein **Sliding Window** über Buckets: verbrauchtes Kontingent
wird laufend wieder frei, nicht schlagartig um Mitternacht. Für einen
Recherche-Batch heißt das: Ein einzelner Ausreißer sperrt nicht den ganzen Tag.

---

## Der Fund im Detail

### `findAllListingsActive` — Suche wie ein Käufer

`GET /v3/application/listings/active`, **OAuth-Scopes: keine.**

Relevante Parameter:

| Parameter | Wofür |
|---|---|
| `keywords` | Suchbegriff, muss in allen Treffern vorkommen |
| `sort_on=score` | Etsys Relevanzrang. **Immer absteigend**, `sort_order` wird dabei ignoriert |
| `taxonomy_id` | Auf eine Kategorie einschränken |
| `buyer_country` | z. B. `DE` — nur Inserate, die nach Deutschland liefern |
| `currency` | z. B. `EUR` — Preise umgerechnet |
| `min_price` / `max_price` | Preisband |
| `limit` / `offset` | Blättern |

`sort_on` wirkt **nur zusammen mit einer Suchoption** — ohne `keywords` ist die
Sortierung wirkungslos. Das ist ein leiser Fallstrick: ohne `keywords` bekommt
man neueste-zuerst und hält es für ein Ranking.

Aus der Antwort verwertbar: `count` (= Wettbewerb), und pro Treffer `title`,
`tags`, `materials`, `price`, `num_favorers`, `taxonomy_id`,
`original_creation_timestamp`.

### `getListing` — die Nachfrage-Zahl

`GET /v3/application/listings/{listing_id}`, ebenfalls **ohne OAuth-Scope**,
liefert zusätzlich:

- **`views`** — „tabulated once per day and only for active listings". Das Feld
  ist **nicht** als eigentümergebunden markiert (anders als `skus` und
  `suggested_title`, wo die Doku das ausdrücklich sagt). Wenn das stimmt, ist
  `views` für *fremde* Inserate lesbar — und damit die Kennzahl, aus der
  Werkzeuge wie eRank ihre Nachfrageschätzung bauen.
- `views` steht **nicht** im Schema von `findAllListingsActive`. Der Weg ist
  also zweistufig: suchen → IDs → Details nachladen.

**Zu verifizieren, bevor darauf gebaut wird:** (a) kommt `views` wirklich für
fremde Inserate, (b) liefert der Batch-Endpunkt `getListingsByListingIds`
(100 IDs pro Aufruf, ebenfalls ohne Scope) `views` mit — wenn ja, kostet ein
50-Treffer-Batch 2 statt 50 Aufrufe.

### Später, sobald der Shop verbunden ist

`getListing(..., allow_suggested_title=true)` gibt **Etsys eigenen
Titelvorschlag** zurück — nur für eigene Inserate und nur bei englischer
Shop-Sprache. Unsere Etsy-Texte sind ohnehin englisch. Das ist ein
Gratis-Ranking-Signal direkt von Etsy und gehört in Phase 5.

---

## Was daraus messbar wird

Aus rein öffentlichen Daten, pro Suchbegriff:

| Kennzahl | Quelle | Aussage |
|---|---|---|
| **Wettbewerb** | `count` der Suche | Wie viele aktive Inserate konkurrieren |
| **Nachfrage** | Median `views / Tag seit Erstellung` der Top-Treffer | Wie viel Traffic der Begriff trägt |
| **Tag-Konsens** | Häufigkeit jedes Tags über die Top-N | Welche Tags ranken tatsächlich |
| **Titel-n-Gramme** | Bi-/Trigramme aus Top-Titeln | Wie Ranker formulieren |
| **Kategorie-Konsens** | Modus der `taxonomy_id` | Die richtige Etsy-Kategorie, empirisch statt geraten |
| **Preisband** | Perzentile der `price` | Nebenprodukt: ob unser Preis im Markt liegt |
| **Chance** | Nachfrage ÷ log(Wettbewerb) | Long-Tail-Begriffe, wo ein neuer Shop Sichtbarkeit hat |

Der letzte Punkt ist die eigentliche Strategie. Ein Shop ohne Verkaufshistorie
gewinnt „3d printed dragon" nie. Er gewinnt „articulated dragon desk toy". Die
Aufgabe des Scorings ist, genau solche Begriffe zu finden — nicht die mit dem
meisten Traffic.

**Kategorie-Konsens ist ein stiller Zusatzgewinn:** `taxonomyHint` wird heute
von Claude geraten und irgendwo aufgelöst. Der Modus der `taxonomy_id` über die
Top-Treffer ist eine gemessene Antwort auf dieselbe Frage.

---

## Architektur-Entscheidung

**Die Recherche läuft deterministisch *vor* dem LLM-Aufruf, nicht als Tool-Use
*im* LLM-Aufruf.**

Begründung:

- Das Zählen von Tags und n-Grammen ist mechanisch. Ein Modell dafür laufen zu
  lassen macht es teurer, langsamer und nicht reproduzierbar.
- Die Hausordnung dieses Projekts ist „an der Naht validieren". Eine reine
  Funktion `mine(listings) → Evidence` ist gegen Fixtures testbar; eine
  Agentenschleife ist es nicht.
- Die Evidenz lässt sich **persistieren**. Damit ist nachvollziehbar, *warum*
  ein Tag im Inserat steht — und ein erneuter Textlauf braucht keinen zweiten
  API-Zugriff.

Claude bekommt also einen Beweis-Block als Kontext und die Aufgabe, daraus
13 Tags und einen Titel zu bauen — nicht das Werkzeug, selbst zu suchen.

Neues Modul, parallel zu `makerworld/` und `marketplaces/`:

```
src/seo/
  types.ts          zod: KeywordCandidate, Evidence, SeoReport
  etsy-source.ts    findAllListingsActive + Detail-Nachladen + Cache
  ebay-source.ts    Browse API item_summary/search        (Phase 4)
  mine.ts           reine Aggregation: Tags, n-Gramme, Scores
  seed.ts           Suchbegriffe aus MakerWorld-Titel/Tags ableiten
  cache.ts          ~/.3d-print-lister/seo-cache/, TTL, withFileLock
```

`mine.ts` und `seed.ts` fassen kein Netzwerk an. Das ist der testbare Kern.

---

## Phasen

### Phase 0 — Erster Live-Kontakt mit Etsy (heute möglich, kostenlos)

1. App unter `etsy.com/developers/register` anlegen → Keystring und Shared
   Secret nach `.env` (`ETSY_KEYSTRING`, `ETSY_SHARED_SECRET`).
2. `lister etsy ping` (oder Erweiterung von `whoami`): ein einziger Aufruf
   `/listings/active?keywords=3d+printed&limit=1`.
3. Die Rate-Limit-Header loggen und den Kommentar in `client.ts` korrigieren.
   Den `RateLimiter` aus `x-limit-per-second` speisen statt ihn zu raten.

Was das rettet: Der Etsy-Client war nie gegen die echte API gelaufen. Dieser
Schritt prüft Basis-URL, Key-Format, Limiter, Retry und Fehlerübersetzung —
**ohne OAuth, ohne Shop, ohne die 0,20 € Aktivierungsgebühr**. Damit fällt der
größte Teil von Restrisiko Nr. 1 weg, bevor überhaupt ein Shop existiert.

**Ohne Key trotzdem baubar:** Eine gespeicherte JSON-Antwort als Fixture, wie
`--from-html` bei MakerWorld. Die Unit-Tests laufen dann sowieso offline.

### Phase 1 — Recherche-Modul

- Seeds aus MakerWorld-Titel und -Tags plus Produktfakten (Material, Farbe).
- Pro Seed: suchen (`sort_on=score`, `limit` 50, `buyer_country=DE`), Top-IDs
  einsammeln, Details nachladen, aggregieren.
- Zweite Runde: die stärksten gefundenen Begriffe erneut suchen. Zwei Runden
  reichen — mehr ist Quotenverbrennung ohne Erkenntnisgewinn.
- Cache mit TTL (7 Tage) in `~/.3d-print-lister/seo-cache/`, Schreibzugriff über
  das vorhandene `withFileLock()`.
- **Kein stilles Kürzen:** Wenn die Quote den Batch beschneidet, muss der
  Report das sagen. Sonst liest sich eine halbe Recherche wie eine ganze.

### Phase 2 — Einhängen in den Text-Generator

`ai/composer.ts`:

- Neuer Block im User-Prompt: die Top-Kandidaten mit ihren Kennzahlen, die
  Tag-Häufigkeiten der Ranker, das Preisband.
- Neue Regeln im System-Prompt:
  - Ein Keyword darf nur rein, wenn es **auf den Gegenstand zutrifft**. Die
    bestehende Regel „erfinde keine Spezifikation" wird damit auf Keywords
    ausgeweitet — „wasserdicht" ist kein Tag, nur weil es rankt.
  - Beschreibende Keywords (was das Ding ist) und Anlass-Keywords (wem man es
    schenkt) getrennt behandeln: erstere müssen wahr sein, letztere plausibel.
  - Titel-Frontloading: das stärkste Keyword nach vorn.
  - Keine Wortstamm-Dopplung über die 13 Tags — verbrannter Platz.
- `types.ts`: die neuen Regeln als Validierung, damit die vorhandene
  Reparaturschleife sie einfängt. Wichtig: **Warnungen, keine Blocker.** Ein
  doppelter Wortstamm ist Verschwendung, kein 400.
- `ListingRecordSchema` bekommt ein optionales `seo`-Feld mit `.default(null)`,
  wie `imageUrls` und `licenseOverridden` — alte `listings.json` müssen weiter
  parsen.

### Phase 3 — Sichtbar machen

- `lister keywords <id>` — Report anzeigen, nichts ändern.
- `lister keywords <id> --apply` — Claude schreibt Titel und Tags neu, Diff
  anzeigen, bestätigen lassen. Über `Io`, damit die UI denselben Weg nimmt.
- Web-UI: Panel „Keyword-Recherche" im Editor, Knopf „Vorschläge holen",
  Diff-Ansicht mit Übernehmen/Verwerfen pro Feld.
- Die Recherche ist lesend, die UI-Route ist trotzdem POST — damit greifen
  Origin-Prüfung und Sitzungs-Token automatisch. Kein Sonderweg.

### Phase 4 — eBay

Hier liegt der eigentliche Umsatz (`ebay.de`), und die Auth steht schon:
`getAppToken()` in `ebay/auth.ts` holt bereits ein Client-Credentials-Token mit
`https://api.ebay.com/oauth/api_scope` — genau das, was die Browse API will.

**Das entkoppelt eBay-Recherche von Roadmap-Punkt 4:** Ein App-Token braucht
**keinen RuName und keine Nutzer-Einwilligung**. Nötig ist nur ein
Production-Keyset, nicht die komplette gewerbliche Verkaufseinrichtung.

Geplant: `/buy/browse/v1/item_summary/search`, Best-Match-Sortierung als
Ranking-Proxy, `X-EBAY-C-MARKETPLACE-ID: EBAY_DE`.

Zwei Dinge **vor** dem Bauen empirisch prüfen:

1. Laut Doku liefert `fieldgroups=ASPECT_REFINEMENTS` die tatsächlich
   verwendeten Item-Specifics mit Häufigkeiten. Das wäre die direkte Quelle für
   `copy.ebay.aspects` — geraten wird sie heute. Ungeprüft.
2. `X-EBAY-C-MARKETPLACE-ID` ist in der Inventory API wirkungslos (siehe
   `ARCHITECTURE.md`), in Browse dagegen der einzige Weg, den Marktplatz zu
   wählen. Zwei APIs, gegenteilige Regel — nicht verwechseln.

**Sandbox ist hier wertlos.** Sie enthält keinen echten Bestand; gemeinte
Recherchedaten wären Rauschen — dasselbe Muster wie bei den
Kategorievorschlägen, die dort Zufallsmüll mit HTTP 200 liefern.

### Phase 5 — Rückkopplung

Erst wenn Inserate live sind:

- `allow_suggested_title=true` auf eigene Inserate — Etsys eigener Vorschlag.
- Eigene `views` und `num_favorers` über die Zeit mitschreiben. Ohne diese
  Schleife ist jede SEO-Behauptung unbelegt.

---

## Tests

Nach dem Muster von `fetcher.test.ts` (gespeicherte Seite statt Netzwerk):

- Gespeicherte Suchantworten als Fixtures → `mine.ts` vollständig offline.
- Scoring gegen konstruierte Fälle: viel Wettbewerb/wenig Nachfrage muss
  **verlieren**, auch wenn absolut mehr Views daran hängen.
- Die neuen `types.ts`-Regeln beidseitig testen: Verletzung muss auffallen,
  gültige Eingabe darf nicht durchfallen. Ein Test, der nur den Erfolgsfall
  abdeckt, hätte in diesem Projekt noch nie einen Fehler gefunden.
- Cache: abgelaufener Eintrag löst neuen Abruf aus, frischer nicht.

---

## Risiken und offene Punkte

| Punkt | Stand |
|---|---|
| **Etsy API Terms of Use** | Ob systematische Auswertung fremder Inserate gedeckt ist, habe ich **nicht geprüft**. Vor Phase 1 lesen (`etsy.com/legal/api`). Für den eigenen Shop ist das der Normalfall — behaupten will ich es ungelesen nicht. |
| `views` bei fremden Inseraten | Doku markiert es nicht als eigentümergebunden. Empirisch prüfen. |
| `views` im Batch-Endpunkt | Entscheidet 2 vs. 50 Aufrufe pro Suche. Prüfen. |
| Rate-Limit-Budget | Erst nach App-Registrierung sichtbar. Cache und Header-Auswertung sind Pflicht, nicht Kür. |
| Header-Name `x-remaining-this-secon` | Fehlt ein `d`. Echten Namen aus einer echten Antwort nehmen. |
| Keyword-Stuffing | Etsy und eBay bestrafen es. Die Regel „muss auf den Gegenstand zutreffen" ist kein Stilwunsch, sondern der Schutz davor. |
| eBay-Production-Keyset | Blockiert Phase 4. Aber nur das Keyset, nicht der RuName. |
| Sprachtrennung | Etsy-Recherche englisch, eBay-Recherche deutsch. Nicht dieselbe Kandidatenliste über beide legen. |

---

## Werkzeuge, die dabei helfen

| Werkzeug | Wofür, in welcher Phase |
|---|---|
| **Etsy-MCP** (installiert) | Endpunkt- und Schema-Details in Phase 0–3, ohne Spec-Download. Kennt `taxonomy`- und `seo`-Kontext. |
| **`claude-api`-Skill** | Phase 2. `composer.ts` nutzt `messages.parse` mit `zodOutputFormat`; der Skill ist die Referenz für Structured Outputs, Prompt-Caching (der Evidenz-Block wiederholt sich über Reparaturrunden — Caching lohnt) und Modell-IDs. |
| **Context7-MCP** | Aktuelle Doku zu `zod`/SDK-Versionen, falls Phase 2 an Schema-Grenzen stößt. |
| **`security-review`-Skill** | Phase 3, sobald neue POST-Routen dazukommen. |
| **`code-review` / `simplify`** | Nach jeder Phase auf dem Diff. |
| **`verification-before-completion`** | Vor jedem „fertig" — in diesem Projekt hat sich das bisher jedes Mal gelohnt. |

Nicht passend, obwohl der Name es nahelegt: der `marketing:seo-audit`-Skill
zielt auf Website-SEO (Google, Onpage, technische Prüfung), nicht auf
Marktplatz-Ranking. Anderes Spiel, andere Signale.

---

## Empfohlene Reihenfolge

**Phase 0 zuerst**, unabhängig davon, welcher Marktplatz wichtiger ist. Sie
kostet eine App-Registrierung und einen GET, und sie räumt nebenbei das größte
offene Risiko des Projekts ab.

Danach ist Etsy der schnellere Weg (öffentliche API, kein Keyset-Antrag),
eBay der wertvollere (dort wird verkauft). Beide teilen sich `mine.ts` und den
Prompt-Umbau in Phase 2 — die Arbeit ist also nicht doppelt.
