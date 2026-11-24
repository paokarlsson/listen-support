# Talmoln 🎙️☁️

Ett levande ordmoln av det du pratar om. Du pratar, telefonen lyssnar. Ämnen som återkommer växer i molnet, och det som inte nämns på ett tag krymper.

Talmoln är tänkt som ett **stöd för människor med nedsatt kognitiv förmåga**: det visar med korta meningar på lättläst svenska vad samtalet handlar om just nu, så att det blir lättare att hänga med.

Allt körs **i webbläsaren**. Whisper transkriberar talet lokalt på telefonen, och transkriberad **text** (aldrig ljud) skickas till Claude, som avgör vad samtalet handlar om. Ingen server behövs: sidan ligger på GitHub Pages.

---

## Kom igång

1. **Slå på GitHub Pages (en gång):** på GitHub, gå till repot → **Settings** → **Pages**. Under *Build and deployment*, välj *Source* **GitHub Actions**. Sedan publicerar workflowen `.github/workflows/pages.yml` mappen `docs/` vid varje push till `main`, efter att testerna gått igenom. Sidan ligger på **https://paokarlsson.github.io/listen-support/**. Har en publicering misslyckats innan Pages slogs på: kör om den under **Actions** → *Publicera till GitHub Pages* → **Run workflow**.
2. **Öppna sidan i Chrome på telefonen**, tryck på **Inställningar** och klistra in din Anthropic API-nyckel. Tryck **Testa** för att kontrollera den. Nyckeln skapar du på console.anthropic.com under *API Keys*.
3. **Tryck på Starta** och tillåt mikrofonen. Första gången laddas Whisper-modellen ner, med en förloppsindikator. Sedan finns den kvar i webbläsaren.

---

## Vad det gör

- **Live-transkribering** av svenska med Whisper, i webbläsaren.
- **Just nu**: en mening överst på lättläst svenska om vad samtalet handlar om just nu, till exempel "Ni pratar om var ni ska åka på semester i sommar." Den visar också hur gammal den är.
- **Ämnen med förklaring**: varje ämne får ett kort namn och en mening om vad som sägs, till exempel *Kontorsflytten – Flytten till nya kontoret blir i mars.*
- **Ordmoln**: ämnesnamnen, i samma färg som i listan. Storleken motsvarar hur mycket det pratas om ämnet just nu. Ämnenas nyckelord kan visas runt omkring (av som standard, för att hålla det lugnt).
- **Tidsavklingning**: gamla ämnen tonar ut så att molnet visar det som pågår nu.

Inte i scope: talaridentifiering, konton eller delning, analys av retorik.

---

## Tillgänglighet

Gränssnittet följer **WCAG 2.2 nivå AA**, och nivå AAA där det går:

- **Kontrast:** all text har minst 4,5:1 mot bakgrunden, och det mesta över 7:1. Kanter på knappar och fält har minst 3:1.
- **Lättläst:** typsnittet Atkinson Hyperlegible, framtaget av Braille Institute för läsbarhet. Meningarna från Claude är på lättläst svenska. Knapparna har text, inte bara ikoner.
- **Anpassningsbart** under Inställningar → Utseende: ljust eller mörkt tema (eller som telefonen), tre textstorlekar och *Minska rörelser*. Telefonens inställning för minskade rörelser följs också automatiskt.
- **Stora pekytor:** minst 48 × 48 px.
- **Tangentbord och skärmläsare:**
  - En länk för att hoppa direkt till Just nu, och tydliga fokusmarkeringar.
  - Rubriker och landmärken.
  - "Just nu" läses upp när den ändras.
  - Ordmolnet har en textbeskrivning, och samma innehåll finns som lista.
  - Inställningarna öppnas i en dialog som stängs med Escape.
- **Ombrytning:** fungerar på 320 px bred skärm med extra stor text, utan vågrät scroll.

Kontrollerat automatiskt med axe-core (WCAG 2.0–2.2 A/AA) i ljust och mörkt tema, med normal och extra stor text: inga fel. Automatiska kontroller hittar bara en del av alla problem. Testa gärna med TalkBack och med personer i målgruppen.

---

## Arkitektur

```
┌──────────────────────── Chrome på telefonen ────────────────────────┐
│                                                                     │
│  Mikrofon → AudioWorklet (16 kHz mono) → chunkning vid tystnad      │
│                                              ↓ (~6 s)               │
│                                  Web Worker: Whisper (transformers.js,
│                                  WebGPU eller WebAssembly)          │
│                                              ↓ text                 │
│  Ordmoln + transkript  ◄──────  ämneslager ──┼──────────────────────┼──► Claude API
│                                              │                      │   (text, var ~20 s)
└─────────────────────────────────────────────────────────────────────┘
```

**Ljudvägen**

1. `AudioContext({sampleRate: 16000})`: Chrome omsamplar mikrofonen. Om det inte går omsamplar `pcm-worklet.js` själv (linjär interpolation).
2. Workleten skickar block om 100 ms som float32.
3. `chunker.js` samlar ljudet. Efter ~4 s väntar den på första tysta ram och klipper där, så att ord inte klipps mitt i. Kommer ingen paus klipps biten 3 s senare i den tystaste punkten. Hinner telefonen inte med görs bitarna längre (upp till 8 s), och kortare igen när den hinner (ner till 3 s).
4. Bitar utan tal (energibaserad VAD) hoppas över.
5. Whisper körs i en Web Worker så att sidan inte hackar. Ligger den efter släpps de äldsta bitarna när fler än 3 väntar.
6. Kända Whisper-hallucinationer ur tystnad ("Textning.nu", "Tack för att ni tittade" …) filtreras bort.

> ⚠️ Vi använder inte `MediaRecorder` med timeslice. Bara den första webm-biten har header, så de följande går inte att avkoda var för sig.

---

## Taligenkänningen

**Modell:** standard är **KB-Whisper base** (`KBLab/kb-whisper-base`), Kungliga bibliotekets svenska finjustering av Whisper. Den ger klart bättre svenska än OpenAI:s modeller i samma storlek. Om den inte går att ladda i webbläsaren, till exempel för att KBLab inte publicerat den i ONNX-format, byter appen automatiskt till OpenAI:s Whisper base och säger det. I inställningarna kan du välja KB-Whisper tiny eller OpenAI:s modeller.

**Hastighet:** med WebGPU (finns i Chrome på många nyare Android-telefoner) körs Whisper på grafikprocessorn. Annars används WebAssembly på processorn. GitHub Pages kan inte skicka de headers som krävs för flertrådad WebAssembly, så då körs den i en tråd, vilket är långsammare. Fördröjningen visas nere till höger, och "kö N" om transkriberingen ligger efter. Välj då KB-Whisper tiny.

Biblioteket är [transformers.js](https://github.com/huggingface/transformers.js) 4.3.2, som hämtas från jsDelivr låst till exakt den versionen. Det ligger inte i repot: GitHubs push-skydd tar modellnamnet `Mistral3ForConditionalGeneration` i biblioteket för en Mistral-nyckel och stoppar pushen.

---

## Ämneslagret (Claude)

**När:** så fort minst 8 ord har transkriberats, sedan som tätast var 10:e sekund (inställbart 5–60 s) och bara om minst 8 nya ord har kommit sedan förra anropet. Tystnad ger alltså inga anrop.

**Indata:** de senaste 2 minuternas transkript (högst 8000 tecken) och föregående ämneslista, så att Claude kan **återanvända samma ämnesnamn** i stället för att hitta på nya varje gång.

**Utdata:** strukturerad JSON via verktyget `report_topics` med `strict: true`. Modellen är `claude-haiku-5-5`, som tillåter ett tvingat verktygsanrop, så svaret är alltid ett anrop som följer schemat:

```json
{
  "now": "Ni pratar om flytten till nya kontoret.",
  "topics": [
    { "label": "Kontorsflytten", "summary": "Flytten till nya kontoret blir i mars.", "weight": 0.9, "keywords": ["flytten", "nya kontoret"] },
    { "label": "Budget", "summary": "Pengarna till kontoret räcker nästan inte.", "weight": 0.6, "keywords": ["budgeten", "tight"] }
  ]
}
```

Systemprompten (`docs/topics.js`) säger att texten är till för en person med nedsatt kognitiv förmåga och ber om lättläst svenska: högst 15 ord per mening, vanliga och konkreta ord, inga förkortningar, och vad som faktiskt sägs (vem, vad, när) i stället för abstrakta beskrivningar.

**Molnet:**
- Ämnesnamnen är de stora orden. Med *Visa nyckelord i molnet* påslaget visas ämnenas ord runt omkring i samma färg, i 45 % av ämnets storlek.
- Vikterna avklingar mellan anropen: `vikt(t) = vikt(t0) · exp(-ln2 · (t - t0) / halveringstid)`, standard 120 s. Ett nytt svar blandas 50/50 med den avklingade gamla vikten, så molnet ändras mjukt.
- **Ämnesstabilitet:** om Claude döper om ett ämne men orden i stort sett är desamma (Jaccard ≥ 0,5) behålls det gamla namnet.

**Felhantering:** timeout på 15 s. Vid fel behålls senaste ämnen och de avklingar, och ett nytt försök görs vid nästa intervall. Indikatorn i sidhuvudet visar `offline` (inget nät, timeout) eller `fel` (HTTP-fel, avböjd förfrågan, svar utan verktygsanrop).

**Kostnad:** som mest ett anrop per ~10 s med några tusen tokens in och ett par hundra ut. Med Haiku blir en timmes samtal billigt. Inställningarna visar tokens för sessionen.

**Integritet:** i inställningarna slås Claude av och på. När det slås av försvinner Claudes ämnen ur molnet direkt, och ett svar som kommer under tiden slängs.

### API-nyckeln

- Anges i inställningarna och sparas bara i den här webbläsaren (eller bara tills fliken stängs, om du bockar ur *Kom ihåg*). Knappen **Glöm** tar bort den.
- Skickas bara till `api.anthropic.com`, aldrig till GitHub, och finns aldrig i koden.
- En nyckel i en webbläsare kan i princip läsas av skript på sidan. Skapa därför en egen nyckel med en låg utgiftsgräns i Anthropic Console.
- Anropen görs med headern `anthropic-dangerous-direct-browser-access: true`, som Anthropic kräver för anrop direkt från en webbsida.

---

## Vad som går över nätet

| Vad | Till | När |
|---|---|---|
| Sidan själv | GitHub Pages | Vid varje besök |
| transformers.js 4.3.2 och ONNX Runtime | jsDelivr (`cdn.jsdelivr.net`), låst version | Första gången, sedan från cache |
| Whisper-modellen | Hugging Face (`huggingface.co`) | Första gången, sedan från cache |
| Transkriberad text (aldrig ljud) | Anthropic (`api.anthropic.com`) | Ungefär var 20:e sekund medan du pratar |

`tests/network.test.mjs` kontrollerar att vår egen kod inte anropar något annat än Anthropic och jsDelivr.

---

## Projektstruktur

```
.
├── README.md
├── package.json              # npm test
├── .github/workflows/
│   ├── pages.yml             # push till main: tester → publicera docs/ till GitHub Pages
│   └── test.yml              # tester på andra grenar och pull requests
├── docs/                     # webbappen (GitHub Pages)
│   ├── index.html, style.css
│   ├── app.js                # mic → worklet → chunkning → Whisper-worker → Claude → moln
│   ├── asr-worker.js         # Whisper i en Web Worker (transformers.js)
│   ├── chunker.js            # chunkning vid tystnad, VAD, hallucinationsfilter
│   ├── topics.js             # ämneslagret: anropar Claude, tolkar svaret, bygger molnet
│   ├── cloud.js              # ordmolnet (egen layout, mjuka animationer)
│   ├── fonts/                # Atkinson Hyperlegible (SIL Open Font License)
│   └── pcm-worklet.js        # AudioWorkletProcessor: mikrofon → float32 @16 kHz
└── tests/                    # node --test
    ├── chunker.test.mjs
    ├── topics.test.mjs       # med låtsas-API
    └── network.test.mjs      # inget utom Anthropic och jsDelivr anropas
```

**Varför en egen ordmolnsritare och inte `wordcloud2.js`?** Den lägger ut hela molnet från noll vid varje anrop, så alla ord hoppar runt. `cloud.js` låter ord som redan finns stanna kvar och animerar storlek, position och opacitet.

---

## Utveckla

```bash
npm test                      # kör testerna (Node 22+)
npx serve docs                # eller valfri statisk webbserver; öppna http://localhost:3000
```

Mikrofonen kräver `https://` eller `localhost`.

---

## Roadmap

- [x] Mikrofon → PCM → chunkning i webbläsaren
- [x] Whisper i webbläsaren (KB-Whisper base, OpenAI:s base som reserv)
- [x] Ämneslager med Claude, live-ordmoln med avklingning
- [x] Inställningar: nyckel, halveringstid, antal ord, intervall, modell, reset, export
- [ ] Offline-läge (valfritt): lokal språkmodell i webbläsaren i stället för Claude

---

## Risker och öppna frågor

- **Whisper i webbläsaren på telefon** är det största osäkerhetsmomentet: hastigheten beror på WebGPU, och KB-Whisper kanske inte finns i ONNX-format.
- **Första nedladdningen** är stor (modell plus ONNX Runtime). Gör den gärna på wifi.
- **Molnet kräver nät:** utan uppkoppling eller nyckel visas bara transkriptet.
- **Fördröjning:** första ämnena dyker upp efter ~20 ord plus svarstiden från Claude.
- **Integritet:** transkriberad text skickas till Anthropic när Claude är på. Av/på finns i inställningarna.
