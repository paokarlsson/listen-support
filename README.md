# Talmoln 🎙️☁️

Ett levande ordmoln av det du pratar om. Du pratar, telefonen lyssnar. Ämnen som återkommer växer i molnet, och det som inte nämns på ett tag krymper.

Ljudet stannar **på telefonen**: en Python-server i Termux transkriberar lokalt med Whisper, och en webbsida i Chrome på `localhost` visar molnet. Transkriberad **text** (aldrig ljud) skickas till Claude API, som avgör vad samtalet handlar om. Molnet kommer helt från Claude: utan API-nyckel eller nät visas bara transkriptet.

---

## Två sätt att köra

| | **Webbversionen** (`docs/`) – rekommenderas | **Termux-servern** (`app/`) – reserv |
|---|---|---|
| Installation | Ingen. Öppna sidan i Chrome | Termux, Python, bygge av whisper.cpp |
| Whisper körs | I webbläsaren (transformers.js, WebGPU eller WebAssembly) | I Termux (whisper.cpp, snabbare på CPU) |
| Modellen | Laddas ner från Hugging Face första gången, sparas sedan i webbläsaren | Laddas ner med `scripts/download_model.sh` |
| API-nyckeln | Anges i appens inställningar och sparas i webbläsaren | `.env` på telefonen |

### Webbversionen: kom igång

1. **Slå på GitHub Pages:** på GitHub, gå till repot → **Settings** → **Pages**. Under *Build and deployment*, välj *Source* **Deploy from a branch**, välj grenen `ccr-a5a1c1f9-s7n6r9` och mappen **`/docs`**, och tryck **Save**. Efter någon minut ligger sidan på **https://paokarlsson.github.io/listen-support/**.
2. **Öppna sidan i Chrome på telefonen**, tryck på ⚙️ och klistra in din Anthropic API-nyckel. Tryck **Testa** för att kontrollera den. Nyckeln skapar du på console.anthropic.com under *API Keys*.
3. **Tryck på 🎙️** och tillåt mikrofonen. Första gången laddas Whisper-modellen ner, och en förloppsindikator visas. Sedan finns den kvar i webbläsaren.

**Om nyckeln:** den sparas bara i den här webbläsaren (eller bara tills fliken stängs, om du bockar ur *Kom ihåg*). Den skickas bara till `api.anthropic.com`, aldrig till GitHub. En nyckel i en webbläsare kan i princip läsas av skript på sidan, så skapa en egen nyckel med en låg utgiftsgräns i Anthropic Console. Anropen görs med headern `anthropic-dangerous-direct-browser-access: true`, som Anthropic kräver för anrop direkt från en webbsida.

**Vad som går över nätet i webbversionen:**

| Vad | Till | När |
|---|---|---|
| Sidan själv | GitHub Pages | Vid varje besök |
| Whisper-modellen | Hugging Face (`huggingface.co`) | Första gången, sedan från webbläsarens cache |
| transformers.js 4.3.2 och ONNX Runtime | jsDelivr (`cdn.jsdelivr.net`), låst version | Första gången, sedan från cache |
| Transkriberad text (aldrig ljud) | Anthropic (`api.anthropic.com`) | Ungefär var 20:e sekund medan du pratar |

Ljudet lämnar aldrig telefonen. `tests/test_local_only.py` kontrollerar att vår egen kod inte anropar något annat än Anthropic och jsDelivr. (Biblioteket ligger inte i repot, eftersom GitHubs skanner tar ett modellnamn i det för en API-nyckel och stoppar pushen.)

**Modell:** standard är KB-Whisper base (`KBLab/kb-whisper-base`). Om den inte går att ladda i webbläsaren, till exempel för att KBLab inte publicerat den i ONNX-format, byter appen automatiskt till OpenAI:s Whisper base och säger det. I inställningarna kan du välja KB-Whisper tiny eller OpenAI:s modeller.

**Hastighet:** med WebGPU (finns i Chrome på många nyare Android-telefoner) körs Whisper på grafikprocessorn. Annars används WebAssembly på processorn. GitHub Pages kan inte skicka de headers som krävs för flertrådad WebAssembly, så då körs den i en tråd, vilket är långsammare. Ligger transkriberingen efter visas "kö N" nere till höger. Välj då KB-Whisper tiny i inställningarna.

**Testa webbkoden:** `node --test tests/web/*.test.mjs`

---

## 1. Vad det gör

- **Live-transkribering** av tal (svenska i första hand) med Whisper (whisper.cpp).
- **Ämnen med Claude**: slår ihop synonymer och böjningar till ämnen ("bil", "körde", "parkering" → *Transport*) och ger dem begripliga namn.
- **Ordmoln i webbläsaren**: ämnesnamnen är de stora orden och ämnenas ord ligger runt omkring i samma färg. Storleken motsvarar hur mycket det pratas om ämnet just nu.
- **Tidsavklingning**: gamla ämnen tonar ut så att molnet visar det som pågår nu, inte bara totalsumman.

### Inte i scope (just nu)
- Talaridentifiering (vem som säger vad)
- Molnsynk, konton eller delning
- Analys av vältalighet eller retorik

---

## 2. Arkitektur

```
┌────────────────────── Android-telefon ──────────────────────┐
│                                                              │
│  Chrome (http://localhost:8000)          Termux              │
│  ┌──────────────────────────┐          ┌──────────────────┐  │
│  │ Mikrofon (getUserMedia)  │          │ Python-server    │  │
│  │   ↓ AudioWorklet         │ WebSocket│                  │  │
│  │ 16 kHz mono PCM ─────────┼─────────►│ Ljudbuffert      │  │
│  │                          │          │   ↓ (var ~6 s)   │  │
│  │                          │          │ Whisper (lokalt) │  │
│  │                          │          │   ↓ text         │  │
│  │ Löpande transkript  ◄────┼──────────┤ Ämneslager ──────┼──┼──► Claude API
│  │ Ordmoln (DOM)       ◄────┼──────────┤   ↓ ämnen+vikter │  │   (text, var ~20 s)
│  └──────────────────────────┘   JSON   └──────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Vad som går över nätet

**Allt körs lokalt på telefonen utom anropen till Anthropic.**

| Vad | Var | Nät vid körning |
|---|---|---|
| Mikrofon, PCM-omvandling, ordmoln, gränssnitt | Chrome på telefonen | Nej. Sidan laddar inget utifrån: inga CDN:er och inga webbtypsnitt |
| Webbserver | Termux, bunden till `127.0.0.1` | Nej |
| Transkribering (Whisper) | Termux | Nej. Modellen läses från `models/` och laddas aldrig ner automatiskt |
| Ämnen | Claude API | Ja. Bara transkriberad text skickas, aldrig ljud, och bara till `api.anthropic.com` |

Det kontrolleras i koden: ämneslagret vägrar starta om `topics.api_url` pekar på någon annan värd än `https://api.anthropic.com`. Whisper kräver en befintlig modellfil, eftersom pywhispercpp annars laddar ner en modell när den får ett namn som `base`. Servern varnar om `server.host` sätts till något annat än localhost. `tests/test_local_only.py` testar allt detta och att inga filer i `static/` laddar något utifrån.

Nätet behövs bara en gång vid installationen: `pkg`, `pip`, `git clone` och nedladdningen av Whisper-modellen.

**Varför fånga ljudet i webbläsaren?** Chrome tillåter mikrofon på `localhost` (räknas som säker kontext), och det är mycket enklare än att läsa mikrofonen från Termux. Webbsidan skickar rå **16 kHz mono PCM**, vilket är precis det Whisper vill ha. Då behövs ingen ffmpeg-avkodning på servern.

> ⚠️ Använd inte `MediaRecorder` med timeslice. Bara den första webm-biten har header, så de följande går inte att avkoda var för sig. Vi använder `AudioWorklet` och skickar PCM direkt.

**Ljudvägen i detalj**

1. `AudioContext({sampleRate: 16000})` – Chrome omsamplar mikrofonen. Om det inte går omsamplar `pcm-worklet.js` själv (linjär interpolation).
2. Workleten gör om float32 till int16 och skickar block om 100 ms över WebSocket.
3. `audio.py` samlar ljudet. Efter ~6 s väntar den på första tysta ram och klipper där, så att ord inte klipps mitt i. Kommer ingen paus klipps biten vid 9 s i den tystaste punkten.
4. Bitar utan tal (energibaserad VAD) hoppas över.
5. Whisper körs i en bakgrundstråd. Slutet av förra biten skickas med som prompt för bättre sammanhang.
6. Kända Whisper-hallucinationer ur tystnad ("Textning.nu", "Tack för att ni tittade" …) filtreras bort.

---

## 3. Teknikval

| Del | Val | Varför |
|---|---|---|
| Webbserver | **Starlette + Uvicorn** | Ren Python och fungerar i Termux utan att Rust-beroenden (pydantic-core) behöver kompileras. WebSocket-stöd ingår. |
| Speech-to-text | **whisper.cpp** via `pywhispercpp` | Byggs med clang/cmake i Termux och är snabbt på ARM-CPU. Reservplan: `backend = "cli"` anropar en manuellt byggd `whisper-cli`. |
| Modell | **KB-Whisper `base`** (ggml, sparas som `models/kb-whisper-base.bin`) | KBLabs (Kungliga bibliotekets) svenska finjustering av Whisper. Klart bättre svenska än OpenAI:s `base` i samma storlek, så den är lika snabb på telefonen. `kb-small` ger ännu bättre svenska men är tyngre; vanliga `base` finns kvar som reserv (se `scripts/download_model.sh`). |
| Ämneslager | **Claude API** (`claude-haiku-5-5` som standard) anropat direkt med `httpx` | Snabb och billig modell som klarar svenska bra. Vi använder inte `anthropic`-SDK:n eftersom den drar in pydantic-core (Rust), som är jobbigt att bygga i Termux. Ett rent HTTP-anrop räcker. |
| Frontend | Vanilla JS, egen ordmolnsrenderare (`cloud.js`) | Inget byggsteg, fungerar offline. Se nedan. |

**Varför inte `wordcloud2.js`?** Den lägger ut hela molnet från noll vid varje anrop, så alla ord hoppar runt var sjätte sekund. `cloud.js` (~150 rader) låter ord som redan finns stanna kvar på sin plats och animerar storlek, position och opacitet med CSS-transitioner. Nya ord tonar in nära mitten och ord som försvinner tonar ut.

---

## 4. Projektstruktur

```
.
├── README.md
├── requirements.txt          # körning
├── requirements-dev.txt      # + pytest
├── .env.example              # ANTHROPIC_API_KEY=...  (riktiga .env är gitignorerad)
├── config.toml               # modell, chunk-längd, halveringstid, LLM-intervall m.m.
├── models/                   # ggml-modeller (gitignorerad)
├── scripts/
│   └── download_model.sh     # hämtar whisper.cpp- eller KB-Whisper-modeller
├── app/
│   ├── __main__.py           # `python -m app`
│   ├── main.py               # Starlette-app, routes, WebSocket, sessionstillstånd
│   ├── config.py             # läser config.toml
│   ├── audio.py              # PCM-buffert, chunkning vid tystnad, energibaserad VAD
│   ├── transcriber.py        # whisper.cpp (pywhispercpp), whisper-cli eller stub
│   └── topics.py             # ämneslager: anropar Claude, tolkar svaret, bygger molnet
├── docs/                     # webbversionen (GitHub Pages)
│   ├── index.html, style.css
│   ├── app.js                # mic → worklet → chunkning → Whisper-worker → Claude → moln
│   ├── asr-worker.js         # Whisper i en Web Worker (transformers.js)
│   ├── chunker.js            # chunkning vid tystnad, VAD, hallucinationsfilter
│   ├── topics.js             # ämneslagret, anropar Claude direkt från webbläsaren
│   └── cloud.js, pcm-worklet.js
├── static/                   # webbsidan för Termux-servern
│   ├── index.html
│   ├── app.js                # mic → worklet → websocket, rendering, inställningar
│   ├── cloud.js              # ordmolnet
│   ├── pcm-worklet.js        # AudioWorkletProcessor: float32 → int16 @16 kHz
│   └── style.css
└── tests/
    ├── test_audio.py
    ├── test_topics.py        # ämneslagret, med låtsas-API
    ├── test_local_only.py    # inget utom Anthropic-anropen går över nätet
    └── web/                  # tester för webbversionen (node --test)
    └── test_server.py
```

---

## 5. Ämneslagret (Claude)

**När:** så fort minst 20 ord har transkriberats, sedan som tätast var 20:e sekund (inställbart 10–120 s i appen) och bara om minst 20 nya ord har kommit sedan förra anropet. Tystnad ger alltså inga anrop.

**Indata till Claude:**
- De senaste 3 minuternas transkript (glidande fönster, högst 8000 tecken)
- Föregående ämneslista, så att Claude kan **återanvända samma ämnesnamn** istället för att hitta på nya varje gång

**Utdata:** strukturerad JSON via verktyget `report_topics` med `strict: true`. Claude Haiku 5.5 tillåter ett tvingat verktygsanrop (`tool_choice: {"type": "tool"}`), så svaret är alltid ett anrop som följer schemat:

```json
{
  "topics": [
    { "label": "Kontorsflytten", "weight": 0.9, "keywords": ["flytten", "nya kontoret", "lokal"] },
    { "label": "Budget", "weight": 0.6, "keywords": ["budgeten", "kostnad", "offert"] }
  ]
}
```

Om du byter `model` i `config.toml` till Opus 5.5 eller Sonnet 5.5 behöver `tool_choice` ändras till `auto` (de modellerna tillåter inte tvingade verktygsanrop).

Systemprompten finns i `app/topics.py` (`SYSTEM_PROMPT`) och följer utkastet: 3–8 ämnen, korta svenska namn, vikt efter senaste avsnittet, återanvänd namn, hitta inte på.

**Molnet (`TopicLayer.cloud_terms`):**
- Ämnesnamnen är de stora orden. Ämnenas ord från Claude visas runt omkring i samma färg som sitt ämne, i storlek `keyword_factor` (0,45) av ämnets. Sätt `show_keywords = false` för att bara visa ämnesnamnen.
- Ett ord som Claude lägger under flera ämnen visas en gång, hos det starkaste.
- Ämnesvikter avklingar mellan anropen:

  ```
  vikt(t) = vikt(t0) · exp(-ln2 · (t - t0) / halveringstid)      halveringstid = 120 s
  ```

  Ett nytt svar blandas 50/50 med den avklingade gamla vikten, så molnet ändras mjukt. Servern skickar avklingade vikter varannan sekund även när inget nytt sägs.
- **Ämnesstabilitet:** om Claude ändå döper om ett ämne men nyckelorden i stort sett är desamma (Jaccard ≥ 0,5) behåller servern det gamla namnet.

**Felhantering:** timeout på 15 s. Vid fel behålls senaste ämnen, de avklingar och ett nytt försök görs vid nästa intervall. Inget nät eller timeout ger status `offline`. HTTP-fel som 429 och 5xx, avböjda förfrågningar och svar utan verktygsanrop ger `error`. Inget undantag lämnar `topics.py`, så appen kraschar aldrig på grund av API:t.

**Kostnad:** som mest ett anrop per ~20 s med några tusen tokens in och ett par hundra ut. Med Haiku blir en timmes samtal billigt. Loggen visar tokens per anrop och totalt för sessionen, och samma siffror syns i inställningarna och i exporten.

**Integritet:** knappen *Ämnen* i sidhuvudet öppnar inställningarna, där lagret slås av och på. När det slås av tas Claudes ämnen bort ur molnet direkt, och ett svar som kommer under tiden slängs. Startläget styrs av `topics.enabled` i `config.toml`.

### API-nyckeln
- Läses från miljövariabeln `ANTHROPIC_API_KEY` eller från en `.env`-fil i projektroten.
- `.env` står i `.gitignore`. Nyckeln checkas **aldrig** in.
- Nyckeln stannar på servern och skickas aldrig till webbläsaren.

---

## 6. API

| Metod | Väg | Beskrivning |
|---|---|---|
| `GET` | `/` | Serverar `static/index.html` |
| `WS` | `/ws` | Klient → server: binära PCM-ramar (int16 LE, 16 kHz mono) och JSON-kommandon. Server → klient: JSON-uppdateringar |
| `POST` | `/reset` | Nollställ transkript och ordmoln |
| `GET` | `/export` | Hela transkriptet + slutliga vikter som JSON (`?download=1` ger en fil) |

**Server → klient**

```json
{
  "type": "update",
  "segment": "vi måste prata om budgeten för nya kontoret",
  "terms": [
    { "text": "Kontorsflytten", "weight": 1.0, "kind": "topic", "topic": "Kontorsflytten" },
    { "text": "Budget", "weight": 0.66, "kind": "topic", "topic": "Budget" },
    { "text": "hyresvärden", "weight": 0.45, "kind": "keyword", "topic": "Kontorsflytten" }
  ],
  "llm": { "status": "ok", "last_update_s": 12, "enabled": true, "has_key": true,
           "model": "claude-haiku-5-5", "busy": false, "usage": { "calls": 4, "input_tokens": 5210, "output_tokens": 640, "failed": 0 } },
  "latency_ms": 2140,
  "backlog": 0
}
```

`llm.status` är `ok`, `off` (ingen nyckel eller avslaget, se `llm.reason`), `offline`, `error` eller `pending` (på men inget svar ännu). Frontend visar det som en liten indikator i sidhuvudet.

Övriga typer: `hello` (vid anslutning: inställningar, senaste transkript, termer, llm), `terms` (periodisk avklingning och nya ämnen), `llm` (ett Claude-anrop startade), `chunk` (en ljudbit togs emot: längd, om den innehöll tal, kölängd), `status` (biten gav ingen text), `settings`, `reset`.

**Klient → server (text)**

| Meddelande | Effekt |
|---|---|
| `{"type": "settings", "half_life": 60, "top_n": 30}` | Ändra ämnenas halveringstid/max antal ord i molnet (gäller alla klienter) |
| `{"type": "settings", "llm_enabled": false, "llm_interval": 60}` | Slå av/på ämneslagret, ändra intervallet |
| `{"type": "stop"}` | Mikrofonen stängdes – transkribera det som är kvar i bufferten |

Om transkriberingen inte hinner med släpps de äldsta bitarna när fler än 3 väntar, så att molnet inte hamnar allt längre efter.

---

## 7. Termux-servern (reserv): kom igång

> Installera Termux från **F-Droid**. Versionen på Play Store är föråldrad.

```bash
# 1. Systempaket
pkg update && pkg upgrade
pkg install python git clang cmake make python-numpy

# 2. Hämta projektet
git clone <repo-url> talmoln
cd talmoln

# 3. Python-beroenden (bygger whisper.cpp, tar några minuter)
pip install -r requirements.txt

# 4. Ladda ner Whisper-modellen (KB-Whisper base – redan vald i config.toml)
./scripts/download_model.sh
#    …och kontrollera transcriber.model_path i config.toml

# 5. API-nyckel (krävs för ordmolnet)
cp .env.example .env
nano .env          # klistra in ANTHROPIC_API_KEY=...

# 6. Håll Termux vid liv när skärmen släcks
termux-wake-lock

# 7. Starta
python -m app
```

Öppna sedan **http://localhost:8000** i Chrome på telefonen, tryck på 🎙️ och tillåt mikrofonen. Sidan begär en *wake lock* så att skärmen hålls tänd medan du spelar in (Chrome stänger av mikrofonen för flikar i bakgrunden).

`python-numpy` från Termux-paketen sparar en lång kompilering. Om `pip` ändå försöker bygga numpy: `pip install -r requirements.txt --no-build-isolation`.

### Om pywhispercpp inte bygger

Bygg `whisper-cli` själv och använd CLI-backenden:

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp && cmake -B build && cmake --build build -j4 --config Release
cp build/bin/whisper-cli $PREFIX/bin/
```

I `config.toml`: `backend = "cli"`.

### Utveckla på datorn

```bash
pip install -r requirements-dev.txt
python -m pytest
python -m app            # http://127.0.0.1:8000
```

Utan modell startar servern ändå, i stub-läge, och sidan visar en varning. Sätt `backend = "stub"` för att bara testa ljudvägen (fas 1).

---

## 8. Prestanda – förväntningar

- Whisper körs i bitar om ~6–9 s. Med `base` på en modern telefon bör varje bit ta 1–3 s, alltså nära realtid. Fördröjningen visas nere till höger i appen, och "kö N" visas om transkriberingen ligger efter.
- `small` ger bättre svenska men kan släpa efter på äldre telefoner. Byt i `config.toml`, och prova `threads` = antalet stora kärnor.
- Den energibaserade VAD:n hoppar över tysta bitar och sparar både CPU och batteri. Justera `vad_rms_threshold` om den hoppar över tal (sänk) eller skickar brus (höj).
- Räkna med att telefonen blir varm vid långa sessioner.

---

## 9. Roadmap

- [x] **Fas 1 – Skelett:** server + webbsida, mikrofon → PCM → WebSocket, eko av byte-mängd
- [x] **Fas 2 – Transkribering:** whisper.cpp kopplat, löpande transkript visas
- [x] **Fas 3 – Ordmoln:** live-ordmoln med avklingning (den lokala nyckelordsmotorn är borttagen – molnet kommer från ämneslagret)
- [x] **Fas 4 – Ämneslager:** Claude-anrop, sammanslagning, statusindikator, felhantering
- [x] **Fas 5 – Finputs:** reglage för halveringstid/topp-N/LLM-intervall, reset, export, mjuka animationer
- [x] **Webbversion:** allt i webbläsaren, nyckel i inställningarna, GitHub Pages (`docs/`)
- [ ] **Fas 6 – Offline-läge (valfritt):** lokal LLM via llama.cpp som ersättning för Claude

---

## 10. Risker och öppna frågor

- **Bygget av whisper.cpp i Termux** är det största osäkerhetsmomentet. Reservplan finns: `backend = "cli"`.
- **Whisper och korta bitar:** ord kan klippas mitt i vid gränserna. Vi klipper vid första paus efter målängden och skickar förra bitens slut som prompt. Om Whisper börjar upprepa sig: sätt `use_prompt = false`.
- **Molnet kräver nät:** utan API-nyckel eller uppkoppling visas bara transkriptet. Fas 6 (lokal LLM) skulle ta bort det beroendet.
- **Fördröjning:** första ämnena dyker upp efter ~20 ord plus svarstiden från Claude, alltså några sekunder efter att du börjat prata – inte direkt.
- **Ämnesstabilitet:** om Claude döper om samma ämne mellan anropen hoppar molnet. Vi skickar med föregående lista och ber om återanvändning, och servern matchar dessutom namn mot nyckelord.
- **Integritet:** transkriberad text skickas till Anthropic när ämneslagret är på. Av/på finns i inställningarna och indikatorn i sidhuvudet visar läget.
