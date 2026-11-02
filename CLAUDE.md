# Nápady – kontext pro Claude Code

Komunikuj s uživatelem **česky**. Appka má české UI.

## Cíl projektu
Osobní appka na iPhone pro uživatele (jen pro něj samotného), kterého nahodile napadají nápady a má krátkou paměť. Musí být **maximálně jednoduchá a rychlá na zápis**: otevřít, napsat nebo nadiktovat, hotovo. AI (Gemini) nápad přečte, vyčistí, shrne a sama ho přiřadí k projektu, který uživatel zrovna řeší. Uživatel se pak může zeptat, kde u projektu skončil.

## Zadání a omezení (důležité)
- Musí být **zdarma**, žádný vývojářský účet Apple, žádný Mac/Xcode.
- Proto **PWA**: uživatel ji v Safari přidá na plochu (Sdílet → Přidat na plochu).
- **Žádný backend, žádné účty.** Data jen v telefonu (`localStorage`). Cizí data se neukládají, takže GDPR neřešíme.
- **Žádný build krok, žádné npm.** Čisté HTML, CSS a JavaScript, aby to šlo nahrát přímo na GitHub Pages.
- AI přes **Gemini API** (bezplatný klíč z aistudio.google.com/apikey). Klíč zadává uživatel v Nastavení a je jen v jeho telefonu. Uživatel má sice i Claude Code a Gemini CLI, ale ty se hodí jen na vývoj, ne na běh appky.
- Free tarif Gemini může vstupy používat k vylepšování modelů, takže appka nemá sloužit pro citlivá zdravotní data.
- Uživatel je netechnický až středně technický. Rozhodnutí vysvětluj stručně a jednoduše.

## Soubory
- `index.html` – kostra stránky, všechen CSS, spodní navigace (Zapsat, Projekty, Zeptat se, Nastavení).
- `app.js` – veškerá logika. Dá se číst shora dolů: stav a ukládání, Gemini, zápis a nahrávání, vykreslování (`views`), akce (`actions`), události, start.
- `sw.js` – service worker (síť první, při výpadku cache). Cizí domény, tedy volání Gemini, se necachují.
- `manifest.webmanifest`, `icon-180/192/512.png` – instalace na plochu.

## Datový model (`localStorage`, klíč `napady.v1`)
```
{ key, model, projects:[{id,name,desc}],
  ideas:[{id,text,projectId,summary,created,status,err,suggest}] }
```
- `status`: `pending` | `transcribing` | `done` | `error` | `nokey`
- `projectId: ''` znamená Nezařazeno. `suggest` je název nového projektu navržený AI.
- Rozepsaný text je zvlášť v klíči `napady.draft`.
- Nahrávky se **neukládají** (jen v paměti `audioStore` do doby přepisu).

## Jak to funguje
- `submit()` nápad nejdřív **uloží** a až pak volá `enrich()`. Nápad se nesmí ztratit, ani když AI selže nebo není internet.
- `enrich()` posílá Gemini text nebo audio (`inline_data`, base64) + seznam projektů s popisy a třemi posledními nápady každého. Odpověď je JSON podle `SORT_SCHEMA`: `transcript, clean, project, newProject, summary`. Projekt se páruje podle přesného názvu (bez ohledu na velikost písmen).
- „Kde jsem skončil?" (`actions.where`) a záložka Zeptat se (`actions.doask`) posílají zápisky jako text a dostanou prosté české shrnutí.
- Při startu se nápady zaseknuté ve stavu `pending` nebo `transcribing` označí jako `error`, aby šly zkusit znovu.

## Stav a co NENÍ ověřeno
Kód prošel jen kontrolou syntaxe (`node --check`). **Na skutečném iPhonu zatím nezkoušeno.** Rizika:
1. **Formát nahrávky:** iOS Safari nahrává `audio/mp4`. Není jisté, že ho Gemini API přijme. Když ne, zkusit jiný `mime_type` (např. `audio/aac`), nebo audio převést (např. na WAV přes Web Audio API) před odesláním.
2. **Název modelu:** výchozí je `gemini-flash-latest` (v Nastavení jde změnit). Při chybě modelu ověřit aktuální názvy v dokumentaci Gemini API.
3. `MediaRecorder` a mikrofon v PWA z plochy na iOS: ověřit, že se zobrazí žádost o povolení.
4. Uživatelské chybové hlášky zobrazují surovou zprávu z API. Můžou chtít přívětivější české texty.

## Nasazení
GitHub Pages ze složky s těmito soubory (větev `main`, kořen). Výsledná adresa tvaru `https://<jmeno>.github.io/<repo>/`. Všechny cesty jsou **relativní**, aby appka fungovala i v podadresáři.

## Pravidla při úpravách
- Po každé změně souborů, které se cachují, **zvýšit `CACHE` v `sw.js`** (`napady-v1` → `napady-v2` …), jinak uživatel uvidí starou verzi.
- Držet jednoduchost: velká tlačítka, málo kroků, žádná složitá menu. Nové funkce nesmí zdržovat rychlý zápis.
- Nepřidávat závislosti ani build nástroje, pokud o to uživatel nepožádá.
- Změny testovat lokálně: `python3 -m http.server 8000` ve složce projektu a otevřít `http://localhost:8000`. Mikrofon a service worker fungují na `localhost`.
- Nikdy neposílat ani nelogovat API klíč mimo hlavičku požadavku na Gemini.

## Nápady na další kroky (zeptat se uživatele, co chce)
- Připomínky (např. „co jsi řešil včera u projektu X“) nebo týdenní přehled.
- Vyhledávání a filtry v nápadech.
- Zvětšit písmo / režim ještě jednodušší obrazovky.
- Převod audia na WAV, pokud mp4 nepůjde.
- Doladění vzhledu a ikony.
