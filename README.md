# Talmoln 🎙️☁️

Ett levande ordmoln av det du pratar om. Du pratar, telefonen lyssnar. Ord och ämnen som återkommer växer i molnet, och det som inte nämns på ett tag krymper.

Allt körs **lokalt på telefonen**: en Python-server i Termux och en webbsida i Chrome på `localhost`. Inget ljud lämnar enheten.

---

## 1. Vad det gör

- **Live-transkribering** av tal (svenska i första hand) med Whisper (whisper.cpp).
- **Nyckelordsextraktion** som plockar ut vad samtalet handlar om, inte bara vilka ord som är vanligast.
- **Ordmoln i webbläsaren** som uppdateras i realtid. Ordets storlek motsvarar hur viktigt ämnet är just nu.
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
│  │                          │          │ Nyckelordsmotor  │  │
│  │ Ordmoln (DOM)       ◄────┼──────────┤   ↓ vikter       │  │
│  │ Löpande transkript       │   JSON   │                  │  │
│  └──────────────────────────┘          └──────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

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
| Modell | `base` eller `small` (ggml), gärna **KB-Whisper** | KBLabs svenska finjustering ger klart bättre svenska. `tiny` är snabbast men sämst. |
| Nyckelord | Egen motor: stoppord + `snowballstemmer` (svensk) + viktad frekvens med avklingning | Ren Python, lätt och fullt kontrollerbar. Se avsnitt 5. |
| Frontend | Vanilla JS, egen ordmolnsrenderare (`cloud.js`) | Inget byggsteg, fungerar offline. Se nedan. |

**Varför inte `wordcloud2.js`?** Den lägger ut hela molnet från noll vid varje anrop, så alla ord hoppar runt var sjätte sekund. `cloud.js` (~150 rader) låter ord som redan finns stanna kvar på sin plats och animerar storlek, position och opacitet med CSS-transitioner. Nya ord tonar in nära mitten och ord som försvinner tonar ut.

---

## 4. Projektstruktur

```
.
├── README.md
├── requirements.txt          # körning
├── requirements-dev.txt      # + pytest, httpx
├── config.toml               # modell, chunk-längd, halveringstid m.m.
├── models/                   # ggml-modeller (gitignorerad)
├── scripts/
│   └── download_model.sh     # hämtar whisper.cpp- eller KB-Whisper-modeller
├── app/
│   ├── __main__.py           # `python -m app`
│   ├── main.py               # Starlette-app, routes, WebSocket, sessionstillstånd
│   ├── config.py             # läser config.toml
│   ├── audio.py              # PCM-buffert, chunkning vid tystnad, energibaserad VAD
│   ├── transcriber.py        # whisper.cpp (pywhispercpp), whisper-cli eller stub
│   ├── keywords.py           # nyckelordsmotor
│   ├── stopwords_sv.txt      # stoppord inkl. talspråk
│   └── weakwords_sv.txt      # ord som bara visas i bigram ("nya kontoret")
├── static/
│   ├── index.html
│   ├── app.js                # mic → worklet → websocket, rendering, inställningar
│   ├── cloud.js              # ordmolnet
│   ├── pcm-worklet.js        # AudioWorkletProcessor: float32 → int16 @16 kHz
│   └── style.css
└── tests/
    ├── test_keywords.py
    ├── test_audio.py
    └── test_server.py
```

---

## 5. Nyckelordsmotorn

För varje ny transkriberad bit text:

1. **Normalisera**: gemener, ta bort skiljetecken och siffror. Texten delas vid skiljetecken så att bigram inte bildas över meningsgränser.
2. **Filtrera** bort stoppord ("och", "att", "det", "som", "liksom", "typ", "alltså", "eh" …, se `stopwords_sv.txt`) och ord kortare än 3 tecken.
3. **Stamma** med svensk Snowball, så att "budgeten", "budgetar" och "budget" räknas som samma begrepp. Molnet visar den **vanligaste ytformen**, inte stammen.
4. **Bigram**: två innehållsord i rad (t.ex. "nya kontoret") räknas som ett eget begrepp när de nått `bigram_min_count` förekomster. Ett enskilt ord som nästan bara förekommer inuti ett visat bigram döljs, så att begreppet inte syns två gånger.
   **Svaga ord** (`weakwords_sv.txt`: "nya", "stora", "prata" …) får ingå i bigram men visas aldrig ensamma.
5. **Poängsätt** med tidsavklingning:

   ```
   score(term) = Σ  exp(-ln2 · (nu - t_i) / halveringstid)
                för varje förekomst i
   ```

   Summan hålls inkrementellt (poängen skrivs ned sedan förra uppdateringen, sedan läggs +1 till), vilket är exakt samma sak. Förekomsten räknas från när biten spelades in, inte när transkriberingen blev klar. Standard för halveringstid: 120 s. Termer under `forget_below` glöms helt.
6. **Skicka topp-N** (standard 40) med normaliserade vikter 0–1 till klienten, vid varje ny bit och var 2:a sekund så att molnet krymper även i tystnad.

### Senare förbättringar
- Lemmatisering istället för stamning (t.ex. Stanza), om det går att köra på telefonen. Snowball stammar ibland olika böjningar olika ("kontoret" → `kontor`, "kontor" → `kont`).
- Semantisk klustring med embeddings, så att "bil", "körde" och "parkering" samlas under ett ämne
- Valfritt LLM-steg som sammanfattar ämnen i klartext (kräver nätverk, alltså opt-in)

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
    { "text": "budgeten", "weight": 1.0, "kind": "word" },
    { "text": "nya kontoret", "weight": 0.72, "kind": "bigram" },
    { "text": "flytten", "weight": 0.41, "kind": "word" }
  ],
  "latency_ms": 2140,
  "backlog": 0
}
```

Övriga typer: `hello` (vid anslutning: inställningar, senaste transkript, termer), `terms` (periodisk avklingning), `chunk` (en ljudbit togs emot: längd, om den innehöll tal, kölängd), `status` (biten gav ingen text), `settings`, `reset`.

**Klient → server (text)**

| Meddelande | Effekt |
|---|---|
| `{"type": "settings", "half_life": 60, "top_n": 30}` | Ändra halveringstid/antal ord (gäller alla klienter) |
| `{"type": "stop"}` | Mikrofonen stängdes – transkribera det som är kvar i bufferten |

Om transkriberingen inte hinner med släpps de äldsta bitarna när fler än 3 väntar, så att molnet inte hamnar allt längre efter.

---

## 7. Kom igång på Android (Termux)

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

# 4. Ladda ner en modell (base räcker för att komma igång)
./scripts/download_model.sh base        # eller kb-base / kb-small för bättre svenska
#    …och kontrollera transcriber.model_path i config.toml

# 5. Håll Termux vid liv när skärmen släcks
termux-wake-lock

# 6. Starta
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
- [x] **Fas 3 – Ordmoln:** nyckelordsmotor + live-ordmoln med avklingning
- [x] **Fas 4 – Finputs:** reglage för halveringstid/topp-N, reset, export, mjuka animationer
- [ ] **Fas 5 – Smartare ämnen:** bigram-tuning (påbörjad: satsgränser, svaga ord), embeddings/klustring

---

## 10. Risker och öppna frågor

- **Bygget av whisper.cpp i Termux** är det största osäkerhetsmomentet. Reservplan finns: `backend = "cli"`.
- **Whisper och korta bitar:** ord kan klippas mitt i vid gränserna. Vi klipper vid första paus efter målängden och skickar förra bitens slut som prompt. Om Whisper börjar upprepa sig: sätt `use_prompt = false`.
- **Stoppordslistan** behöver tunas för talspråk, eftersom talad svenska har mycket fler utfyllnadsord än skriven. Redigera `app/stopwords_sv.txt` och `app/weakwords_sv.txt` – de läses vid start.
- **Ska molnet visa ord eller ämnen?** Molnet visar ord och bigram. Ämnesklustring kommer i fas 5.
