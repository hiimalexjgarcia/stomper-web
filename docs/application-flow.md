# Application flow

Runtime and user-flow diagrams for the Stomper Hyperion web port. The source
module named in each step is the authoritative implementation.

## Runtime overview

```mermaid
flowchart TD
  A["index.html<br/>src/main.ts"] --> B["App<br/>src/app.ts"]
  B --> S["Store<br/>AppState · undo/redo · autosave"]
  B --> U["UI components"]
  U --> U1["Menu bar · shortcuts"]
  U --> U2["Oscillator tabs/list"]
  U --> U3["Parameter pages"]
  U --> U4["Timeline editor"]
  U --> U5["Transport · status bar"]
  U -- "user commands" --> B
  S -- "subscribe(state, changed)" --> U

  B --> COD["INI codec<br/>songFromIni / iniFromSong"]
  B --> PB["Playback<br/>src/audio/session.ts"]
  B --> OR["Offline render<br/>src/audio/render.ts"]
  B --> DEC["WAV decode<br/>src/audio/decode.ts"]
  B --> AS["localStorage autosave"]

  PB -- "AudioWorklet available" --> AW["stomper-processor<br/>src/audio/worklet.ts"]
  PB -- "no AudioWorklet" --> RS["renderSongSync<br/>main thread"]
  OR -- "OfflineAudioContext + AudioWorklet" --> AW
  OR -- "no AudioWorklet" --> RS

  AW --> MX["mixSample<br/>src/dsp/mixer.ts"]
  RS --> MX
  EN["DspContext from prepareEngine<br/>src/dsp/engine.ts"] --> MX
  WF["waveform.ts"] --> MX
  NZ["noise.ts<br/>MSVC LCG"] --> MX

  COD --> M[("Song model<br/>64 OscModel slots")]
  M --> PB
  M --> OR
  M --> S
```

Live playback runs at the device sample rate; offline export runs at the song's
selected rate. Both feed the same `prepareEngine`/`mixSample` engine.

## Startup

```mermaid
sequenceDiagram
  participant Main as main.ts
  participant App
  participant Store
  participant UI
  participant LS as localStorage
  Main->>App: new App()
  App->>Store: create default song
  Main->>App: mount(#app)
  App->>UI: build menubar, tabs, list, params, editor, transport, status
  App->>Store: subscribe(...)
  App->>Store: restoreAutosave()
  Store->>LS: read stomper.autosave.v1
  LS-->>Store: oscillators, rate, filename, tempo
  App->>UI: refreshAll()
```

If a previous session was restored, the status bar reports it. A clean start
shows the default one-oscillator song at 48000 Hz.

## Open and save

```mermaid
flowchart TD
  A["File → Open"] --> B{"File System Access API?"}
  B -- "yes" --> C["showOpenFilePicker"]
  B -- "no" --> D["hidden input type=file"]
  C --> E["read file text"]
  D --> E
  E --> F["songFromIni(text, name)"]
  F --> G["Store.commit('open name')"]
  G --> H["replace song · reset tab/subtab · clear WAV cache"]
  H --> I["refresh UI · adopt the file's sample rate"]
  F -- "parse error" --> J["status message"]

  K["File → Save / Save As"] --> L["iniFromSong(song)"]
  L --> M{"writable file handle?"}
  M -- "yes" --> N["write via File System Access API"]
  M -- "no" --> O["download .stu blob"]
  N --> P["dirty = false · saved = true"]
  O --> P
```

The loader applies the original defaults for missing keys and treats
`Enabled=-1` as On.

## Editing, undo and autosave

```mermaid
flowchart TD
  A["Parameter / editor / menu edit"] --> B{"Continuous drag?"}
  B -- "no" --> C["Store.commit(label, mutator)"]
  B -- "yes" --> D["Store.begin(label) once"]
  D --> E["Store.live(mutator) on each move"]
  E --> F["Store.end()"]
  C --> G["snapshot pushed · redo stack cleared"]
  F --> G
  G --> H["mutate AppState · dirty = true"]
  H --> I["emit(changed keys)"]
  I --> J["UI subscribers re-render"]
  I --> K["Playback.update if playing"]
  G --> L["autosave to localStorage"]

  M["Undo / Redo"] --> N["swap snapshot stacks · emit"]
  N --> J
```

Dragging is one undo step: the snapshot is taken at `begin`, and `end` commits
the gesture. The undo stack holds up to 200 snapshots.

## Playback

```mermaid
sequenceDiagram
  participant User
  participant App
  participant PB as Playback
  participant AC as AudioContext
  participant AW as AudioWorklet
  participant FB as renderSongSync
  User->>App: Play
  App->>PB: start(oscillators, wav)
  PB->>PB: stop() existing playback
  PB->>AC: new AudioContext + resume()
  alt AudioWorklet available
    PB->>AW: ensureEngineModule (once per context)
    PB->>AW: prepareEngine(model, deviceRate, wav)
    PB->>AW: new AudioWorkletNode(processorOptions)
    AW-->>PB: {type:'ended'} at maxLen
  else no AudioWorklet
    PB->>FB: renderSongSync(model, deviceRate, wav)
    FB-->>PB: Float32Array
    PB->>AC: AudioBufferSourceNode.start()
    AC-->>PB: onended
  end
  PB-->>App: onended callback
  App->>PB: stop() + close context
  App-->>User: transport back to ▶ Play
```

While a worklet render is running, model edits call `Playback.update`, which
posts a freshly prepared `DspContext` to the processor without restarting it.
Fallback playback uses a fixed buffer, so live edits do not affect it. Pressing
Stop, or reaching the natural end, disconnects the node and closes the context.

## Export and normalize

```mermaid
flowchart TD
  A["Export WAV"] --> B["prepareEngine → maxLen frames"]
  B --> C["OfflineAudioContext(1, frames, song.rate)"]
  C --> D{"AudioWorklet?"}
  D -- "yes" --> E["render in stomper-processor"]
  D -- "no" --> F["renderSongSync"]
  E --> G["samples + peak"]
  F --> G
  G --> H["encodeWav: clamp [-1,1] → ×32760 → truncate"]
  H --> I["download .wav"]

  J["Normalize"] --> K["renderSong on the same path"]
  K --> L["peak > 0: scale startA/endA of audible oscillator slots"]
  L --> M["Store.commit('normalize')"]
```

`Normalize` is a modelled port of `FUN_00406A70`: render, find the peak, then
divide the amplitude envelope of every slot with `enabled === 1` and
`role === 0`.

## DSP sample path

```mermaid
flowchart LR
  A["OscModel[] + WAV buffers"] --> B["prepareEngine(model, rate, wav)"]
  B --> C["DspContext<br/>envelopes · phases · chained flags<br/>filter normalisation"]
  C --> D["mixSample(ctx, frame)"]
  D --> E["each slot in list order"]
  E --> F["time/amplitude envelope + glide"]
  F --> G["waveform<br/>sine · saw · square · triangle · WAV"]
  G --> H["FM / AM from earlier slots"]
  H --> I["noise re-roll<br/>MSVC _rand()"]
  I --> J{"role"}
  J -- "oscillator" --> K["add to running mix"]
  J -- "filter" --> L["state-variable filter<br/>Enabled=1 replaces mix<br/>Enabled=2 updates state only"]
  K --> M["one mono sample"]
  L --> M
```

The mixer is sequential and order-dependent, matching `FUN_004083B0`: a filter
processes everything mixed before it.
