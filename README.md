# Talmoln 🎙️☁️

Ett stöd för att hänga med i ett samtal. Du pratar, telefonen lyssnar, och appen visar vilka ämnen samtalet handlar om, med en kort förklaring till varje. Det nyaste ämnet står överst.

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
- **Ämnen med förklaring**: varje ämne får ett kort namn och en mening om vad som sägs, till exempel *Kontorsflytten – Flytten till nya kontoret blir i mars.*
- **Ämnen med förklaring** är huvudinnehållet: stora kort med ämnets namn och en mening om vad som sägs. **Nyaste ämnet överst.** Ordningen styrs av när ämnet först dök upp, så listan hoppar inte runt. Det som pratas om just nu får märket *Pratas om nu*, övriga visar när de senast nämndes (*Nämndes för 3 minuter sedan*). Sidan visar inget annat: det som sagts, fördröjningen och diagnostiken finns under Inställningar, och mikrofonknappen är diskret.
- **Gamla ämnen försvinner** när de inte nämnts på 15 minuter (inställbart 5–60 minuter). Högst 8 ämnen visas (inställbart 3–12).
- **Sparas på enheten**: samtalet (det som sagts och ämnena) sparas i webbläsarens `localStorage` och finns kvar om sidan laddas om. *Inställningar → Data → Nollställ samtalet* tar bort det.

Inte i scope: talaridentifiering, konton eller delning, analys av retorik.

---

## Tillgänglighet

Gränssnittet följer **WCAG 2.2 nivå AA**, och nivå AAA där det går:

- **Kontrast:** all text har minst 4,5:1 mot bakgrunden, och det mesta över 7:1. Kanter på knappar och fält har minst 3:1.
- **Lättläst:** typsnittet Atkinson Hyperlegible, framtaget av Braille Institute för läsbarhet. Meningarna från Claude är på lättläst svenska. Knapparna har text, inte bara ikoner.
- **Anpassningsbart** under Inställningar → Utseende: ljust eller mörkt tema (eller som telefonen), tre textstorlekar och *Minska rörelser*. Telefonens inställning för minskade rörelser följs också automatiskt.
- **Stora pekytor:** minst 48 × 48 px.
- **Tangentbord och skärmläsare:**
  - En länk för att hoppa direkt till ämnena, och tydliga fokusmarkeringar.
  - Rubriker och landmärken.
  - Nya ämnen läses upp när de dyker upp.
  - Ämnena är en vanlig lista med rubriker, i samma ordning som de syns.
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
│  Ämnen + transkript    ◄──────  ämneslager ──┼──────────────────────┼──► Claude API
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

**Hastighet:** med WebGPU (finns i Chrome på många nyare Android-telefoner) körs Whisper på grafikprocessorn. Annars används WebAssembly på processorn, med upp till 4 kärnor. GitHub Pages kan inte skicka de headers som flera trådar kräver (COOP/COEP), så `coi-serviceworker.js` (MIT) lägger till dem. Sidan laddas därför om en gång vid första besöket. Inställningar → Taligenkänning visar vad som används, och diagnostikloggen visar antal trådar.

Whisper räknar alltid på ett 30-sekundersfönster, så en ljudbit kostar ungefär lika mycket oavsett längd. Appen mäter hur lång tid varje bit tar och sätter bitlängden därefter, mellan 3 och 25 s. En snabb telefon får korta bitar och snabba svar. En långsam får längre bitar, så att den hinner med men svarar senare. Hinner den inte ens med 25 s bitar visas en varning: välj då KB-Whisper tiny.

Biblioteket är [transformers.js](https://github.com/huggingface/transformers.js) 4.3.2, som hämtas från jsDelivr låst till exakt den versionen. Det ligger inte i repot: GitHubs push-skydd tar modellnamnet `Mistral3ForConditionalGeneration` i biblioteket för en Mistral-nyckel och stoppar pushen.

---

## Ämneslagret (Claude)

**När:** så fort minst 8 ord har transkriberats, sedan som tätast var 10:e sekund (inställbart 5–60 s) och bara om minst 8 nya ord har kommit sedan förra anropet. Tystnad ger alltså inga anrop.

**Indata:** de senaste 2 minuternas transkript (högst 8000 tecken) och föregående ämneslista, så att Claude kan **återanvända samma ämnesnamn** i stället för att hitta på nya varje gång.

**Utdata:** strukturerad JSON via verktyget `report_topics` med `strict: true`. Modellen är `claude-haiku-5-5`, som tillåter ett tvingat verktygsanrop, så svaret är alltid ett anrop som följer schemat:

```json
{
  "topics": [
    { "label": "Kontorsflytten", "summary": "Flytten till nya kontoret blir i mars.", "weight": 0.9, "keywords": ["flytten", "nya kontoret"] },
    { "label": "Budget", "summary": "Pengarna till kontoret räcker nästan inte.", "weight": 0.6, "keywords": ["budgeten", "tight"] }
  ]
}
```

Systemprompten (`docs/topics.js`) säger att texten är till för en person med nedsatt kognitiv förmåga och ber om lättläst svenska: högst 15 ord per mening, vanliga och konkreta ord, inga förkortningar, och vad som faktiskt sägs (vem, vad, när) i stället för abstrakta beskrivningar.

**Ämneslistan:**
- Varje ämne minns när det först dök upp (`firstSeen`) och när Claude senast nämnde det (`lastMentioned`). Listan sorteras på `firstSeen`, nyaste överst.
- *Pratas om nu*: ämnet fanns med i Claudes senaste svar, med vikt minst 0,4, och svaret är högst 90 s gammalt.
- Ett ämne som inte nämnts på 15 minuter tas bort. Förklaringen uppdateras när Claude säger något nytt om ämnet.
- **Ämnesstabilitet:** om Claude döper om ett ämne men orden i stort sett är desamma (Jaccard ≥ 0,5) behålls det gamla namnet.

**Felhantering:** timeout på 15 s. Vid fel behålls senaste ämnen och de avklingar, och ett nytt försök görs vid nästa intervall. Indikatorn i sidhuvudet visar `offline` (inget nät, timeout) eller `fel` (HTTP-fel, avböjd förfrågan, svar utan verktygsanrop).

**Kostnad:** som mest ett anrop per ~10 s med några tusen tokens in och ett par hundra ut. Med Haiku blir en timmes samtal billigt. Inställningarna visar tokens för sessionen.

**Integritet:** i inställningarna slås Claude av och på. När det slås av försvinner Claudes ämnen direkt, och ett svar som kommer under tiden slängs.

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
│   ├── pages.yml             # push till main: tester → uppladdning → publicering (med ett omförsök)
│   └── test.yml              # tester på andra grenar och pull requests
├── docs/                     # webbappen (GitHub Pages)
│   ├── index.html, style.css
│   ├── app.js                # mic → worklet → chunkning → Whisper-worker → Claude → ämneskort
│   ├── asr-worker.js         # Whisper i en Web Worker (transformers.js)
│   ├── chunker.js            # chunkning vid tystnad, VAD, hallucinationsfilter
│   ├── topics.js             # ämneslagret: anropar Claude, tolkar svaret, håller ämneslistan
│   ├── fonts/                # Atkinson Hyperlegible (SIL Open Font License)
│   ├── manifest.webmanifest  # gör sidan installerbar som app (hemskärm/skrivbord)
│   ├── icons/                # appikoner: SVG, 192/512 px, maskable och Apple touch-ikon
│   └── pcm-worklet.js        # AudioWorkletProcessor: mikrofon → float32 @16 kHz
└── tests/                    # node --test
    ├── chunker.test.mjs
    ├── topics.test.mjs       # med låtsas-API
    └── network.test.mjs      # inget utom Anthropic och jsDelivr anropas
```


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
- [x] Ämneslager med Claude: ämnen med förklaring på lättläst svenska, nyaste överst (ordmolnet borttaget)
- [x] Inställningar: nyckel, halveringstid, antal ord, intervall, modell, reset, export
- [ ] Offline-läge (valfritt): lokal språkmodell i webbläsaren i stället för Claude

---

## Risker och öppna frågor

- **Whisper i webbläsaren på telefon** är det största osäkerhetsmomentet: hastigheten beror på WebGPU, och KB-Whisper kanske inte finns i ONNX-format.
- **Första nedladdningen** är stor (modell plus ONNX Runtime). Gör den gärna på wifi.
- **Ämnena kräver nät:** utan uppkoppling eller nyckel visas bara det som sägs.
- **Fördröjning:** första ämnena dyker upp efter ~20 ord plus svarstiden från Claude.
- **Integritet:** transkriberad text skickas till Anthropic när Claude är på. Av/på finns i inställningarna.
