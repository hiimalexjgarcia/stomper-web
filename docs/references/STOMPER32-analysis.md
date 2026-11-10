# STOMPER32.EXE — Stomper Hyperion 5.0 — Static Reverse-Engineering Report

**Target** `~/Downloads/stomper/Stomper/STOMPER32.EXE`
**Size** 360 448 bytes · **SHA-256** `d4328ee77da141bcb0edca1e30bf0008f89d1899f07491f5a890ef70d2a13bd2`
**Format** PE32 (i386), Win32 GUI, MSVC 6.0, statically linked MFC
**Method** Static analysis only (never executed). Ghidra 12.1.4 headless via the REA MCP server
(`provider_id: ghidra`); 19 handlers that Ghidra never turned into procedures were recovered with
`objdump -d -M intel` on the raw file. The target was closed again with `close_binary` afterwards.

---

## 1. Binary overview

| Property | Value |
|---|---|
| Image base | `0x00400000` |
| Entry point | `0x004134A2` (`__tmainCRTStartup`) |
| Sections | `.text` VA `0x1000` raw `0x1000` size `0x35000` · `.rdata` VA `0x36000` raw `0x36000` `0xD000` · `.data` VA `0x43000` raw `0x43000` `0x6000` (vtables live here) · `.rsrc` VA `0x65000` raw `0x49000` `0xF000` |
| RVA↔file | for `.text`/`.rdata`/`.data` the RVA equals the file offset; VA→file = VA − `0x400000` |
| Imports | `kernel32`, `user32`, `gdi32`, `comdlg32`, `winmm` (`PlaySoundA`), `mmsystem`, `shell32` (`ShellExecute`), `advapi32` (`GetProfileIntA`) |
| Global app object | `theApp` at `0x00448118`, ctor `0x403200`, vtable `0x00436F98` |
| Dialog resources | main dialog template id **102**, About/splash id **16**, TUAREG wizard, Zap-News settings |
| Menus | `RT_MENU` **131** = main menu bar, **152** = oscillator-list context menu |
| Strings | version `5.01` @ `0x443468`, build `54` @ `0x443464`, `.wav` @ `0x443470` |

The program is **not** a step sequencer. It is a *software synthesizer / additive synth editor*:
a song is a list of up to **64 oscillators** (or filter modules), each with its own start/end time,
frequency glide, amplitude envelope, curve exponents, noise parameters and FM/AM modulation
sources. The engine renders the whole list into a PCM buffer; the app previews it by writing a
temporary `.wav` and calling `PlaySoundA`.

The build is shareware: `FUN_004071D0` reads `Stomper\V2Flag` and `GetProfileIntA("Stomper",
"MusicData",0)` and, when the trial has expired, shows *"Sorry - this version of Stomper Hyperion
has EXPIRED."* and launches `http://www.master-zap.com/stomper/`.

---

## 2. Entry point and main execution logic

```
__tmainCRTStartup  0x4134A2      (CRT)
  └─ WinMain        0x423BD7      (shim)
       └─ AfxWinMain 0x42C55D
            ├─ AfxGetThread 0x42A667
            ├─ AfxGetApp    0x43021B
            ├─ AfxWinInit   0x431AA7   → creates the main dialog
            │    └─ vtable+0x84  InitApplication 0x430510
            │         └─ vtable+0x50  CStomperApp::InitInstance 0x403290
            ├─ vtable+0x54  ExitInstance 0x42A480
            ├─ vtable+0x68  Run          0x4308D2   (modal message loop)
            └─ AfxWinTerm   0x433C46
```

The main dialog object owns everything:

* vtable `0x437658`, ctor `0x4034D0`, dtor `0x403870`, template id 102
* `+0xBC = 0x403C30` → `OnInitDialog`
* `+0xB8 = 0x429792` → `CDialog::DoModal`

### 2.1 `CStomperApp::InitInstance` — `0x403290` (objdump)

```asm
push  <dialog template 102>
call  CDialog::Create / CStomperDlg::Create      ; creates the modal main window
test  eax,eax
je    <fail>
mov   dword ptr [0x448118+...]                   ; theApp -> dlg
...
ret
```

Only three virtuals are overridden by the app class:

| vtable slot | address | meaning |
|---|---|---|
| `+0x04` | `0x403220` | destructor |
| `+0x28` | `0x4031F0` | `GetMessageMap` → base `0x436F60` (42 WM_COMMAND/WM_TIMER/WM_INITDIALOG entries) |
| `+0x50` | `0x403290` | `InitInstance` — creates the main dialog |

### 2.2 `OnInitDialog` — `0x403C30` (Ghidra pseudo-code, abridged)

```c
BOOL CStomperDlg::OnInitDialog()            // 0x403C30
{
    CDialog::OnInitDialog();
    // build the control map, set the default sample rate
    *(int *)(this + 0x9FC)   = 0x5622;                 // 22050 Hz
    *(int *)(this + 0x31200) = 0;                      // oscillator count = 0
    // create the default/empty song (FUN_00406110 — used when a file fails to load)
    FUN_00406110(this);                                // default/empty song
    // install the menus
    HMENU h = LoadMenu(...);  SetMenu(...);
    // start the "Zap News" / timer machinery
    FUN_00407290(this);                                // news auto-check
    SetTimer(hDlg, 1, <interval>, 0);
    // shareware expiry check
    FUN_004071D0(this);                                // trial-days nag
    // first UI refresh
    FUN_00404A40(this);                                // tab list
    FUN_00404800(this, this + 0xA00);                  // paint controls
    return TRUE;
}
```

---

## 3. Core procedures (decompiled pseudo-code)

### 3.1 Model loader — `FUN_00407470` (`LPCSTR path, int slotArray, int *rate, int *count`)

Reads the song from a **Windows INI text file** (`.STU` / `.STP`).

```c
int FUN_00407470(LPCSTR path, int slots, int *rate, int *count)
{
    GetPrivateProfileStringA("Common","SampleFrequency","22050", buf,0x3F,path);
    *rate = atoi(buf);
    if (*rate == 11000) *rate = 0x2B11;      // 11025
    if (*rate == 22000) *rate = 0x5622;      // 22050
    if (*rate == 44000) *rate = 0xAC44;      // 44100

    GetPrivateProfileStringA("Common","Oscillators","0", buf,0x3F,path);
    *count = atoi(buf) + 1;
    if (*count > 0x40) *count = 0x40;        // hard limit: 64 oscillators

    for (i = 0; i < *count; i++) {
        puVar4 = (int *)(slots + 0x264);            // per-slot field base
        memset(puVar4 - 0x99, 0, 0x264);            // clear the slot
        wsprintfA(section, "Oscillator %d", i);

        GetPrivateProfileStringA(section,"Enabled","0",buf,0x3F,path);
        puVar4[-2] = atoi(buf);                     // +0x25C  Enabled  (0=Off 1=On 2=Inaudible)
        GetPrivateProfileStringA(section,"Filter","0",buf,0x3F,path);
        *puVar4    = atoi(buf);                     // +0x264  role     (0=osc 1/2=filter)
        GetPrivateProfileStringA(section,"WaveForm","0",buf,0x3F,path);
        puVar4[1]  = atoi(buf);                     // +0x268  WaveForm (0 sin 1 tri 2 sq 3 saw 4 wav)
        GetPrivateProfileStringA(section,"WavFile","",slot->wavfile,0xFA,path);
        puVar4[0x1B]= 0;                            // +0x2D0  wav FILE*
        GetPrivateProfileStringA(section,"Comment","",slot->comment,0xFA,path);
        GetPrivateProfileStringA(section,"LoopWav","0",buf,0xFA,path);
        puVar4[2]  = atoi(buf);                     // +0x26C  LoopWav
        GetPrivateProfileStringA(section,"StartF","2000",buf,0x3F,path);
        *(double *)(puVar4 - 0x13) = atof(buf);     // +0x218  StartF  (Hz)
        GetPrivateProfileStringA(section,"EndF","0",buf,0x3F,path);
        *(double *)(puVar4 - 0x11) = atof(buf);     // +0x220  EndF    (Hz)
        GetPrivateProfileStringA(section,"StartA","1",buf,0x3F,path);
        *(double *)(puVar4 - 0x0F) = atof(buf);     // +0x228  StartA
        GetPrivateProfileStringA(section,"EndA","0",buf,0x3F,path);
        *(double *)(puVar4 - 0x0D) = atof(buf);     // +0x230  EndA
        GetPrivateProfileStringA(section,"StartT","0",buf,0x3F,path);
        *(double *)(puVar4 - 0x17) = atof(buf);     // +0x208  StartT  (ms or beat:fraction)
        GetPrivateProfileStringA(section,"EndT","200",buf,0x3F,path);
        *(double *)(puVar4 - 0x15) = atof(buf);     // +0x210  EndT
        GetPrivateProfileStringA(section,"AMModFac","0",buf,0x3F,path);
        *(double *)(puVar4 + 5)   = atof(buf);      // +0x278  AMModFac
        GetPrivateProfileStringA(section,"AMModBy","-1",buf,0x3F,path);
        puVar4[8] = atoi(buf);                      // +0x284  AM source index
        GetPrivateProfileStringA(section,"FMModFac","0",buf,0x3F,path);
        *(double *)(puVar4 + 3)   = atof(buf);      // +0x270  FMModFac
        GetPrivateProfileStringA(section,"FMModBy","-1",buf,0x3F,path);
        puVar4[7] = atoi(buf);                      // +0x27C  FMModBy
        GetPrivateProfileStringA(section,"CurveShape0","0.1",buf,0x3F,path);
        *(double *)(puVar4 - 9)   = atof(buf);      // +0x240  curve exponent (timing)
        GetPrivateProfileStringA(section,"CurveShape1","10",buf,0x3F,path);
        *(double *)(puVar4 - 7)   = atof(buf);      // +0x248  curve exponent (amplitude)
        GetPrivateProfileStringA(section,"CurveShape2","1",buf,0x3F,path);
        *(double *)(puVar4 - 5)   = atof(buf);      // +0x250  curve exponent (waveform)
        GetPrivateProfileStringA(section,"NoiseBW","0.1",buf,0x3F,path);
        *(double *)(puVar4 - 0xB) = atof(buf);      // +0x238  NoiseBW
        GetPrivateProfileStringA(section,"NoiseChangeRate","1",buf,0x3F,path);
        puVar4[-3] = atoi(buf);                     // +0x258  NoiseChangeRate
        puVar4 += 0xC2;                             // stride 0xC2*4 = 0x308 bytes
    }
    FUN_00408A20(slots, *count);   // rebuild the modulation/derivation links
    return 1;
}
```

> The default string for `Enabled`, `Filter`, `WaveForm` and `StartT` is the shared
> `"0"` at `0x00443148` (not the `"1"`/`"200"` that an earlier reading of the
> disassembly suggested). `Enabled` is parsed with `abs()`, so old files that
> store `-1` still load as On. `EndT` really does default to `"200"`.

### 3.2 Song loader — `FUN_00404540(void *this, LPCSTR path)`

```c
uint CStomperDlg::LoadFile(LPCSTR path)
{
    if (!FUN_00407470(path, this+0xA00, &this->rate /*0x9FC*/, &this->count /*0x31200*/)) {
        FUN_00406110(this);                 // fall back to the default song
        return 0;
    }
    FUN_00406E80(this);                     // update the sample-rate radio menu
    this->filename = path;                  // +0x78
    FUN_004059E0(this);                     // seed the undo snapshot
    this->saved = 1;                        // +0x85
    FUN_004061C0(this);                     // refresh the title bar
    FUN_00404A40(this);                     // rebuild the oscillator tabs
    SendMessageA(this->tabHwnd, TCM_SETCURSEL, 0, 0);
    // longest oscillator = song length  (this+0x428)
    for (i = 0; i < count; i++)
        if (i == 0 || this->maxEndT < ((double*)(this+0xC10))[i*0x61]) {
            *(double*)&this->maxEndT = ((double*)(this+0xC10))[i*0x61];   // +0x428
        }
    FUN_00404800(this, this+0xA00);         // repaint the UI
    this->dirty = 1;                        // +0x84
    return 1;
}
```

### 3.3 Song writer — `FUN_004079A0(LPCSTR path, int slots, int rate, int count)`

Mirror image of the loader — `WritePrivateProfileStringA` for `[Common]`
(`SampleFrequency`, `Oscillators`) and one `[Oscillator N]` section per oscillator with the
same key set.

### 3.4 Engine initialisation — `FUN_004081F0(slots, rate, count, int *maxLen, double k1, double k2)`

```c
void FUN_004081F0(int slots, int rate, int count, int *maxLen, double k1, double k2)
{
    for (i = 0; i < count; i++) {
        S = slots + i*0x308;
        FUN_00407FF0(S);                                    // load the WAV if WaveForm==4
        S->envStart = (int)(rate * S->StartT * 0.001);      // +0x288  (ms -> samples)
        S->envEnd   = (int)(rate * S->EndT   * 0.001);      // +0x28C
        if (maxLen) {
            S->phaseAcc = 0; S->noiseAcc = 0; S->lastOut = 0;
            if (*maxLen < S->envEnd && S->Enabled != 0) *maxLen = S->envEnd;
        }
        S->chained = 0;                                     // +0x2CC
        // The chain test compares the *previous envelope end* with this
        // envelope's start, not the two start times.
        if (i > 0 && S[-1].envEnd == S->envStart && S[-1].role == S->role)
            S->chained = 1;                                 // unison / "linked to previous"
        S->envLen  = S->envEnd - S->envStart;               // +0x290
        S->ampDelta = S->EndA - S->StartA;                   // +0x2A8
        if (S->role == 0) {                                 // ---- oscillator ----
            inc = k1 * S->StartF / rate;                    // cycles / sample
            if (S->WaveForm != 0) S->phaseInc = inc;       // phase in cycles
            else                  S->phaseInc = inc * 6.2831852;   // sine: phase in radians
            inc2 = k1 * S->EndF / rate;
            if (S->WaveForm != 0) inc2 = inc2; else inc2 = inc2 * 6.2831852;
        } else {                                            // ---- filter ----
            // Note the integer division: (rate / 10000) * rate, truncated.
            norm = (double)((rate / 10000) * rate);
            inc  = k2 * S->StartF * 2.0 / norm;             // one-pole coefficient
            inc2 = k2 * S->EndF   * 2.0 / norm;
        }
        S->phaseIncDelta = inc2 - inc;                      // +0x2A0  (frequency / cutoff glide)
    }
}
```

### 3.5 Mixer — `FUN_004083B0(double *mix, int, int *sampleIndex, int count, int slots)`

```c
void FUN_004083B0(double *mix, int _, int *sampleIndex, int count, int slots)
{
    for (i = 0; i < count; i++) {
        S = slots + i*0x308;
        if (S->Enabled != 0 && S->envStart <= *sampleIndex && *sampleIndex < S->envEnd) {

            if (S->chained) {                               // +0x2CC: unison with the previous osc
                S->chained = 0;
                S->phaseAcc = S[-1].phaseAcc;              // inherit phase  (+0x2B0/4)
                S->lastOut  = S[-1].lastOut;               // inherit output (+0x2C0/4)
            }

            double t = (double)(*sampleIndex - S->envStart) / (double)S->envLen;

            // envelope shaping: pow(t, curveExponent)
            double tf = pow(t, S->CurveShape0);            // +0x240   timing curve
            double ta = pow(t, S->CurveShape1);            // +0x248   amplitude curve

            double amp   = S->StartA + ta * S->ampDelta;   // +0x228/+0x230/+0x2A8
            double phase = S->phaseInc + tf * S->phaseIncDelta + S->noiseOffset;

            // ---- FM ----  (+0x270/+0x280)
            // The compiled code is multiplicative, not additive: the factor
            // scales the whole phase term.  A negative factor negates that
            // product instead (the original `fchs` quirk).
            if (S->fmsrc /*+0x280*/ >= 0 && S->FMModFac /*+0x270*/ != 0.0) {
                double src = slots[S->fmsrc].lastOut;             // +0x2C0
                if (S->FMModFac >= 0.0) phase = phase * src * S->FMModFac + phase;
                else                   phase = -(phase * src * S->FMModFac);
            }

            // ---- AM ----  (+0x278/+0x284), same multiplicative rule
            if (S->amsrc /*+0x284*/ >= 0 && S->AMModFac /*+0x278*/ != 0.0) {
                double src = slots[S->amsrc].lastOut;
                if (S->AMModFac >= 0.0) amp = amp * src * S->AMModFac + amp;
                else                   amp = -(amp * src * S->AMModFac);
            }

            if (S->role /*+0x264*/ == 0) {                  // ========== OSCILLATOR ==========
                S->phaseAcc += phase;
                double s = FUN_00407DB0(S) * amp;           // waveform generator

                // Enabled == 1 is audible; Enabled == 2 ("Inaudible") still
                // modulates other slots but contributes nothing to the mix.
                if (S->Enabled == 1) *mix += s;

                // Noise re-roll rules:
                //  * NoiseChangeRate == 0: reroll on every waveform sign change.
                //  * NoiseChangeRate > 0 : increment a counter, reroll once it
                //    exceeds the rate, then reset the counter to zero.
                // The RNG is advanced *only* when a reroll happens.
                if (S->NoiseBW /*+0x238*/ > 0.0) {
                    if (S->NoiseChangeRate /*+0x258*/ == 0) {
                        if (s * S->lastOut < 0.0)
                            // FUN_00407FD0 returns [0,1); the mixer maps it to
                            // [-1,1) with (r + r) - 1 before scaling.
                            S->noiseOffset = (2.0 * FUN_00407FD0() - 1.0) * S->NoiseBW * phase;  // +0x2B8
                    } else {
                        S->noiseCounter += 1;
                        if (S->NoiseChangeRate < S->noiseCounter) {
                            S->noiseOffset = (2.0 * FUN_00407FD0() - 1.0) * S->NoiseBW * phase;
                            S->noiseCounter = 0;
                        }
                    }
                }
                S->lastOut = s;                             // +0x2C0
            } else {                                        // ========== FILTER ==========
                // One-pole filter over the running mix.  +0x2B0 holds the
                // filter memory for a filter slot (the phase accumulator
                // shares the same field for an oscillator slot).
                double st = amp * S->filterState            // +0x2B0
                          + (*mix - S->lastOut) * phase;
                S->filterState = st;
                S->lastOut = st + S->lastOut;
                if (S->Enabled == 1) *mix = S->lastOut;     // Enabled == 2 only updates state
            }
        }
    }
}
```

> Notes on the compiled code:
>
> * FM/AM are **multiplicative** and the sign of the modulation factor selects between
>   `x + x*src*fac` and `-(x*src*fac)`, not a phase offset.
> * An **Enabled == 1 filter overwrites** the running mix with its output; Enabled == 2
>   advances the filter state without contributing any sound.
> * The noise RNG (`_rand`) is only advanced when a reroll condition fires, so the
>   noise sequence depends on the exact envelope history of every slot ahead of it.
> * `_rand()` is MSVC's LCG (`state = state*214013 + 2531011`, seed 1, no `_srand`),
>   returning `((state >> 16) & 0x7fff) / 32767` in `[0, 1)`; `FUN_00407FD0` scales
>   that to `[0, 1)` and the mixer maps it to `[-1, 1)` with `(r + r) - 1`.

### 3.6 Waveform generator — `FUN_00407DB0(S)`

```c
double FUN_00407DB0(int S)
{
    double phase = *(double *)(S + 0x2B0);        // phase accumulator
    switch (S->WaveForm) {                       // +0x268
    case 0:  v = sin(phase);                     break;        // sine (phase in radians)
    case 1:  v = 1.0 - 2.0*fmod(phase, 1.0);     break;        // falling ramp, [-1,1]
    case 2:  // duty-cycle square: CurveShape2 shifts the on/off threshold
        v = (pow(fmod(phase, 1.0), S->CurveShape2) > 0.5) ? 1.0 : -1.0;
        break;                                                // already exactly ±1
    case 3:  { double x = fmod(phase, 1.0);       // triangle, [-1,1]
               if (x < 0.25)      v = x*4.0;
               else if (x <= 0.75) v = 1.0 - (x-0.25)*4.0;
               else                v = (x-0.75)*4.0 - 1.0;
               break; }
    case 4:  { int idx = (S->LoopWav == 0)
                     ? min((int)phase, S->frameCount-1)
                     : ((int)phase % S->frameCount);
               fseek(S->wav, 0x2C + S->frameSize*idx, SEEK_SET);
               if (S->bitsPerSample == 8) v = ((unsigned char)v - 0x7F) * 0.0078125;
               else                       v = (short)v * 3.0517578125e-05;
               break; }
    default: v = phase;                                   // unknown id -> raw phase
    }
    // shape the sample with CurveShape2 (a signed pow); case 2 is already ±1
    return (v > 0.0) ? pow(v, S->CurveShape2) : -pow(-v, S->CurveShape2);
}
```

The waveform ids are Sine / Saw / Square / Triangle / WAV file; the "saw" is a **falling ramp**
(`1 - 2x`), the triangle uses the `0.25`/`0.75` breakpoints above, and the square's duty cycle
comes from `CurveShape2` rather than a fixed 50 %. The tail is `pow()` from the MSVC CRT
(`FUN_004125A0` = `_pow`, `FUN_004132AE` = `fmod`, `FUN_004127C0` = `__ftol`,
`FUN_00407FD0` = the noise RNG). The `fchs` pair on the negative branch cancels, so the sign
of the raw waveform is preserved.

### 3.7 WAV loader — `FUN_00407FF0(S)`

```c
void FUN_00407FF0(int S)
{
    if (S->WaveForm != 4) return;
    S->wav = fopen(S->wavFile, "rb");
    if (!S->wav) return;
    fread(&S->wavHeader, 0x2C, 1, S->wav);        // 44-byte canonical header
    if (S->wavHeader.wFormatTag != 1) {           // +0x2E8
        MessageBoxA(NULL,"Sorry, compressed wav, i dont grok that yet!","Stomper",MB_ICONERROR);
        fclose(S->wav); S->wav = NULL; return;
    }
    S->frameSize   = (S->bitsPerSample/8) * S->blockAlign;   // +0x300
    S->frameCount  = S->dataSize / S->frameSize;              // +0x304
}
```

### 3.8 WAV renderer — `FUN_004087F0(path, slots, rate, count, rect)`

Writes a 44-byte WAV header (`FUN_00408990`), then loops
`FUN_004081F0` (prepare) → `FUN_004083B0` (mix one sample) → `FUN_00412937` (write 16-bit
sample). It returns the peak amplitude, which `FUN_00406A70` (Normalize) uses.

Each mixed `double` is clamped to `[-1, 1]`, multiplied by **32760.0** (the constant at
`0x00437790`, not 32767.0) and converted with `__ftol`, which truncates toward zero. The port
does the same, which is why exported WAVs match the reference files to the last LSB.

### 3.9 Normalize — `FUN_00406A70`

```c
void CStomperDlg::Normalize()
{
    FUN_004056E0(this);                       // push an undo snapshot
    char *tmp = FUN_00409090(this->helper, &s);
    double peak = FUN_004087F0(tmp, this->slots, this->rate, this->count, 0);
    if (peak > 0.0) {
        for (i = 0; i < count; i++) {
            double *p = (double*)(this+0xC28 + i*0x308);       // slot+0x228 = StartA
            if (*(int*)(p+0x34) == 1          // +0x25C == Enabled == On
                && *(int*)(p+0x3C) == 0) {   // +0x264 == role == oscillator
                p[0] /= peak;                // StartA
                p[1] /= peak;                // EndA
            }
        }
        FUN_00404800(this, this->slots + curTab*0x308);   // repaint
    }
}
```

### 3.10 Undo — `FUN_004059E0` (push) / `FUN_00405870` (pop)

```c
void FUN_004059E0(int this)                   // "push snapshot"
{
    // free the whole undo stack
    while (node = this->undoHead /*+0x98*/) { this->undoHead = node->next; free(node->text); free(node); }
    // copy the whole model (64 slots * 0x308 = 0x18400 bytes = 0x6100 dwords)
    for (i = 0; i < 0x6100; i++) this->snapshot[i] = this->slots[i];
    this->curTab = 0; this->subTab = 0; this->snapCount = this->count;   // +0x31204/08/0C
}
```

The snapshot lives at `this+0x18E00`; the undo stack nodes are chained through `this+0x98`.
`FUN_00405870` restores the snapshot, rebuilds the tab list, re-selects the tab and repaints.

### 3.11 Tab list — `FUN_00404A40`

One tab per oscillator plus a final **"New"** tab.

```c
for (i = 0; i < count; i++) {
    S = slots + i*0x308;
    text = itoa(i);                                  // tab caption = the oscillator index
    if (S->role != 0) text += filterName(S->role);   // "LP12" style suffix
    image = (S->Enabled == 0) ? 5                    // Off
           : (S->Enabled == 2) ? S->role + 2          // Inaudible
                                : S->role;            // On
    TCM_SETITEM(TCM_SETITEMW, i, &TCITEM{TCIF_TEXT|TCIF_IMAGE, text, image});
}
text = "New"; image = 4;                             // the trailing "New" tab
```

### 3.12 Title bar — `FUN_004061C0`

`"untitled"` when `this+0x78` is empty, a `*` prefix when `this+0x85` (saved flag) is clear,
then the file name.

### 3.13 Preview / play — `FUN_004043B0`

```c
void CStomperDlg::PlayPreview()
{
    FUN_004056E0(this);                       // undo snapshot
    if (this->dirty /*+0x84*/) {
        FUN_004080E0(&rect, this->slots, this->count, this->rate, &this->gridRect);
        char *tmp = FUN_00409090(this->helper /*+0x5C*/, &s);
        FUN_004087F0(tmp, this->slots, this->rate, this->count, &rect);   // render the WAV
        this->dirty = 0;
    }
    char *path = FUN_00409120(this->helper, &s);
    PlaySoundA(path, NULL, SND_ASYNC);
}
```

`FUN_004080E0` computes the grid metrics: the maximum `EndT` over the *enabled* oscillators and
the client-rect scaling used by the on-screen envelope editors.

### 3.14 UI refresh — `FUN_00404800(this, S)`

1. `FUN_00405180` → `FUN_00408A20` rebuilds the derivation links between oscillators
   (adjacent oscillators with matching frequency/amplitude/enable parameters are chained).
2. `FUN_00404C90` builds the sub-tab pages.
3. Radio buttons: On/Off/Inaudible (`0x40C/0x40D/0x40E`), Oscillator/Filter (`0x410/0x411`).
4. The list control (`0x143`) is repopulated and the selected-tab widgets updated:
   * sub-tab 0 **Frequency**: `+0x218`/`+0x220` (start/end Hz), curve `+0x240`,
     length `+0x210`, FM source `+0x280`, FM factor `+0x270`, rect `this+0x31228`
   * sub-tab 1 **Amplitude**: `+0x228`/`+0x230` (start/end amp), curve `+0x248`,
     AM source `+0x284`, AM factor `+0x278`, rect `this+0x31230`
   * sub-tab 2 **Filter**: `FUN_00409A10` (cutoff / resonance page)

---

## 4. Data model

### 4.1 Oscillator record — 0x308 bytes, up to 64 of them at `this+0xA00`

Slot *i* base = `this + 0xA00 + i*0x308`; count at `this+0x31200`.

| offset | type | field | notes |
|---|---|---|---|
| `+0x000` | `char[250]` | WavFile | path of the sample for `WaveForm == 4` |
| `+0x100` | `char[250]` | Comment | user text |
| `+0x208` | `double` | StartT | start time (ms, or `beat:fraction`) |
| `+0x210` | `double` | EndT | end time — the longest one defines the song length |
| `+0x218` | `double` | StartF | start frequency (Hz) |
| `+0x220` | `double` | EndF | end frequency (Hz) — the pair defines the glide |
| `+0x228` | `double` | StartA | start amplitude |
| `+0x230` | `double` | EndA | end amplitude |
| `+0x238` | `double` | NoiseBW | noise bandwidth/amount |
| `+0x240` | `double` | CurveShape0 | timing-curve exponent (`pow(t,·)`) |
| `+0x248` | `double` | CurveShape1 | amplitude-curve exponent |
| `+0x250` | `double` | CurveShape2 | waveform-curve exponent |
| `+0x258` | `int` | NoiseChangeRate | how often the noise re-rolls |
| `+0x25C` | `int` | Enabled | 0 = Off, 1 = On, 2 = Inaudible (modulator only) |
| `+0x264` | `int` | Filter / role | 0 = oscillator, 1/2 = filter type |
| `+0x268` | `int` | WaveForm | 0 sine, 1 triangle, 2 square/random, 3 saw, 4 WAV |
| `+0x26C` | `int` | LoopWav | wrap the WAV instead of clamping |
| `+0x270` | `double` | FMModFac | frequency-modulation factor |
| `+0x278` | `double` | AMModFac | amplitude-modulation factor |
| `+0x27C` | `int` | FMModBy | FM source oscillator index (−1 = none) |
| `+0x280` | `int` | FM source index | used by the mixer (−1 = none) |
| `+0x284` | `int` | AMModBy | AM source oscillator index (−1 = none) |
| `+0x288` | `int` | env start (samples) | `StartT * rate / 1000` |
| `+0x28C` | `int` | env end (samples) | `EndT * rate / 1000` |
| `+0x290` | `int` | env length (samples) | |
| `+0x298` | `double` | phase increment | start increment (rad/sample for sine) |
| `+0x2A0` | `double` | phase-increment delta | `end − start` → glide |
| `+0x2A8` | `double` | amplitude delta | `EndA − StartA` |
| `+0x2B0` | `double` | phase accumulator | |
| `+0x2B8` | `double` | noise offset | |
| `+0x2C0` | `double` | last output | also the modulation source value |
| `+0x2C8` | `int` | noise counter | |
| `+0x2CC` | `int` | chained-to-previous | set by the engine, consumed by the mixer |
| `+0x2D0` | `FILE*` | wav handle | |
| `+0x2D4` | `byte[44]` | WAV header | canonical `WAVE` header |
| `+0x2E8` | `short` | wFormatTag | must be 1 (PCM) |
| `+0x2EA` | `short` | blockAlign | |
| `+0x2F6` | `short` | bits per sample | 8 or 16 |
| `+0x2FC` | `int` | data size | |
| `+0x300` | `int` | frame size | `(bits/8)*blockAlign` |
| `+0x304` | `int` | frame count | `dataSize/frameSize` |

### 4.2 Main-dialog object

| offset | meaning |
|---|---|
| `+0x5C` | pointer to the synth/temp-file helper |
| `+0x60` | trial days left |
| `+0x74` | secondary file name (export/plugin target) |
| `+0x78` | current file name (`CString`) |
| `+0x84` | dirty flag |
| `+0x85` | saved flag |
| `+0x98` | undo-stack head |
| `+0x9FC` | sample rate (0x5622 = 22050, 0xAC44 = 44100, 48000) |
| `+0xA00` | oscillator array (stride 0x308) |
| `+0x18E00` | undo snapshot (0x18400 bytes = 0x6100 dwords) |
| `+0x31200` | oscillator count (max 64) |
| `+0x31204/8/C/10` | undo metadata: current tab, sub-tab, count, rate |
| `+0x31228 / +0x31230` | renderer target rects (frequency / amplitude tabs) |
| `+0x312B0` | status / tempo text |
| `+0x31328` | renderer target rect |
| `+0x31380` | oscillator-list HWND |
| `+0x313A0` | `CTabCtrl` |
| `+0x313BC` | pattern-tab HWND |
| `+0x313DC` | second tab HWND |
| `+0x313F8` | sub-tab HWND (Frequency / Amplitude / Waveshape | Cutoff F / Resonance) |
| `+0x31490` | news widget |

### 4.3 File format (`.STU` song, `.STP` sound) — plain INI text

```ini
[Common]
SampleFrequency=22050
Oscillators=3

[Oscillator 0]
Enabled=1
Filter=0
WaveForm=0
WavFile=
Comment=
LoopWav=0
StartF=2000
EndF=0
StartA=1
EndA=0
StartT=200
EndT=200
CurveShape0=0.1
CurveShape1=10
CurveShape2=1
NoiseBW=0.1
NoiseChangeRate=1
AMModFac=0
AMModBy=-1
FMModFac=0
FMModBy=-1
```

---

## 5. Feature processing

| Feature | Implementation |
|---|---|
| **New** (`0xE100` → `0x4061A0`) | resets the model, clears the tabs, marks the document dirty |
| **Open** (`0xE101` → `0x404490`) | `CFileDialog` with the filter `Stomper files (*.STU, *.STP)|*.STU;*.STP||`; on OK → `FUN_00404540` (INI loader) |
| **Save** (`0xE103` → `0x4060D0`) | `FUN_004079A0` (INI writer) to the current path |
| **Save as…** (`0x8011` → `0x404630`) | `CFileDialog` → sets `this+0x78` → `FUN_004079A0` |
| **Exit** (`0x8005` → `0x405D10`) | `FUN_00406350` (save-changes prompt) → `EndDialog` |
| **Undo** (`0xE12B` → `0x405AA0`) | pops the snapshot (`FUN_00405870`), rebuilds the tabs, repaints |
| **Copy / Cut / Paste** (`0xE122/0xE123/0xE125` → `0x405B80/0x405AF0/0x405C00`) | forwards `WM_COPY`(0x301) / `WM_CUT`(0x300) / `WM_PASTE`(0x302) to the focused list control; falls back to copying the selected slot |
| **On / Off / Inaudible** (`0x801E/0x801F/0x8020`, dialog radios `0x40C/0x40D/0x40E`) | sets `slot+0x25C` to 1 / 0 / 2 and refreshes the tab icons |
| **Insert oscillator** (`0x8007` → `0x405D00`, "Insert After" `0x8017` → `0x406320`) | shifts the slot array, inserts a fresh slot at the cursor |
| **Delete oscillator** (`0x8008` → `0x405CF0`) | removes the selected slot, renumbers the tabs |
| **Sample frequency** (`0x8029/0x802A/0x802B` → `0x406B80/0x406BA0/0x406BC0`) | sets `this+0x9FC` to 22050 / 44100 / 48000 and updates the radio menu (`FUN_00406E80`) |
| **Normalize** (`0x8027` → `0x406A70`) | render → peak → divide `StartA`/`EndA` of every audible oscillator by the peak |
| **Little Drummer Boy** (`0x8028` → `0x406A50`) | `ShellExecute` → `http://www.Master-Zap.com/ldb` (a web page with a demo song; the in-app default song is `FUN_00406110`, used when a file fails to load) |
| **Register as TUAREG plugin** (`0x8026` → `0x4067C0`) | `FUN_00406580` reads `tuareg.ini` (`[General] Version`, `[Paths] PluginPath`) and writes `stomper.ini`/`stompin.ini` with `name=Stomper Hyperion Plugin`, `kind=5`, `description=Stomper sound EDIT`, `executable=%s -tu`, `extension=.stu`; warns *"Sorry you need Tuareg FAT version for plugins to work!..."* |
| **Zap News** (`0x8035/0x8036` → `0x406C80/0x406D40`) | `FUN_00407290` reads `Stomper\NewsAuto`, `NewsFrequency`, `LastNewsDate` (intervals 0x15180 … 0x76A700 s), opens `news.swf` from `STOMPER32.HLP`, URL `http://www.z4p.com/stomper/news/` |
| **Display mode Hz / Note** (`0x803B/0x803C`) | switches the frequency editors between Hz and musical note names |
| **Display mode ms / beat:fraction** (`0x803E/0x803F`) | switches the time editors between milliseconds and `beat:fraction` |
| **Snap to note** (`0x803D`) | quantises the grid to musical notes |
| **Snap to time** (`0x8044/0x8040…0x8043`) | quantises to none / 1-4 / 1-8 / 1-16 / 1-32 note |
| **About** (`0x0010` → `0x406950`) | splash screen (`0x402EA0`) + about box (`0x4033D0`) |
| **Help** (`0x803A` → `0x4071B0`) | `http://www.master-zap.com/stomper/documentation.html` |
| **Web links** (`0x406A50/0x406BE0/0x406C00/0x406C20/0x406C40/0x406C60/0x407190/0x4071B0/0x407270`) | `ShellExecute` via `FUN_00407090` on `master-zap.com` / `mp3.com/zap` URLs |
| **Timer** (`0x113` → `0x405D30`) | periodic preview playback + `FUN_0042624D` |
| **DDE** (`0x403090`) | handles `GetMusic` / `CloseWindow`; `GetMusic` writes `Stomper\MusicData`, sets `*(this+0x5C)+0x60 = 1` and opens `http://www.master-zap.com/dlmusicware/` |

---

## 6. Command map (42 entries, base `0x436F60`)

| id | handler | feature |
|---|---|---|
| `0x042B` | `0x407190` | Web → Homepage |
| `0x112` (WM_INITDIALOG) | `0x404280` | dialog init → About/splash |
| `0x03F1` | `0x4043B0` | Preview / play |
| `0xE101` | `0x404490` | Open |
| `0x03F7` | `0x404720` | move track (button) |
| `0x0410` | `0x404F50` | Oscillator radio |
| `0x0411` | `0x404FC0` | Filter radio |
| `0x040C` | `0x405030` | On |
| `0x040D` | `0x4050A0` | Off |
| `0x040E` | `0x405110` | Inaudible |
| `0xE12B` (update) | `0x405A50` | ON_UPDATE_COMMAND_UI stub (`ret 0x4`) |
| `0x8008` | `0x405CF0` | Delete oscillator |
| `0x8007` | `0x405D00` | Insert oscillator |
| `0x8005` | `0x405D10` | Exit |
| `0x113` (WM_TIMER) | `0x405D30` | timer |
| `0x0422` (BN_CLICKED) | `0x405D50` | button |
| `0x0424` | `0x405F20` | button (→ `0x405D50`) |
| `0x0425` | `0x405F30` | export: undo → grid metrics → `FUN_004079A0(this+0x74,…)` |
| `0xE103` | `0x4060D0` | Save |
| `0x8011` | `0x404630` | Save as… |
| `0xE100` | `0x4061A0` | New |
| `0x8017` | `0x406320` | Insert After |
| `0xE122` | `0x405B80` | Copy |
| `0xE123` | `0x405AF0` | Cut |
| `0xE125` | `0x405C00` | Paste |
| `0xE12B` | `0x405AA0` | Undo |
| `0x8026` | `0x4067C0` | TUAREG registration |
| `0x0010` | `0x406950` | About |
| `0x8028` | `0x406A50` | Little Drummer Boy |
| `0x8027` | `0x406A70` | Normalize |
| `0x8029` | `0x406B80` | 22050 |
| `0x802A` | `0x406BA0` | 44100 |
| `0x802B` | `0x406BC0` | 48000 |
| `0x8032` | `0x406BE0` | Get Latest Version |
| `0x8033` | `0x406C00` | Stomper Sound Library |
| `0x8037` | `0x406C20` | More software |
| `0x802F` | `0x406C40` | Homepage |
| `0x8030` | `0x406C60` | Music by the author |
| `0x8035` | `0x406C80` | Zap News → Get News Now |
| `0x8036` | `0x406D40` | Zap News → Update Settings |
| `0x803A` | `0x4071B0` | Help |
| `0x8045` | `0x407270` | Stomper CHAT |

### Menus

**131 — menu bar**

*File* New (0xE100) · Open… (0xE101) · Save (0xE103) · Save as… (0x8011) · Exit (0x8005)
*Edit* Undo (0xE12B) · Cut (0xE123) · Copy (0xE122) · Paste (0xE125) · Insert Oscillator (0x8007) · Delete Oscillator (0x8008)
*Special* Sample Frequency ▸ 22050 / 44100 / 48000 (0x8029-0x802B) · Normalize (0x8027) · Little Drummer Boy (0x8028) · Register as TUAREG Plugin… (0x8026)
*Web* The Author ▸ Homepage / Music / More software · Stomper ▸ Latest Version / Sound Library / CHAT · ZapNews ▸ Get News Now / Update Settings
*Help* Heeeellp!!!!! (0x803A) · About Stomper Hyperion 5.0 (0x0010)

**152 — oscillator-list context menu**

On (0x801E) · Off (0x801F) · Inaudible (0x8020) · Copy / Cut / Paste · Delete (0x8008) ·
Insert Before (0x8007) · Insert After (0x8017) · Display mode ▸ Hz (0x803B) / Note (0x803C) /
Snap to note (0x803D) · Display mode ▸ milliseconds (0x803E) / beat:fraction (0x803F) ·
Snap to time ▸ none (0x8044) / 1-4 (0x8040) / 1-8 (0x8041) / 1-16 (0x8042) / 1-32 (0x8043)

---

## 7. Evidence index (REA)

| evidence id | content |
|---|---|
| `ev_a04a9c9bbb8efaf3bded50ecffa13a0e604f17214a5ad1cdb9a89c77213bb6ca` | binary overview |
| `ev_ddd83c310ab0e89bfd6cddffe652f4f3de47c3647fea81cba303b58514f9e99b` | entry point / main execution logic |
| `ev_a3b7e62ad64fd063140dc91162852e5865458c07e2ed4671b458597acfac5909` | `AfxWinMain` |
| `ev_1e594574f3a068158874944341aa9bb64a179fc063f4f6581b2649bcdfe9baa1` | WinMain shim |
| `ev_99c368b18b0f89a15aca4aca4b9ff1e9e9ba4cdba1b35023938adfe59ea90f32` | `AfxWinInit` |
| `ev_78b1a62aa274b5d9b869874767fecd5421641b42a93aebe43094042c049c8a13` | `CDialog::DoModal` |
| `ev_aaa46507002004437e7ab6abefc396f40bacad0c1189b77e8807a7d76a389626` / `ev_e3514be313e782a0be9b12aee93f8dbe55f49c6c6f23c8c30b1c2d428ec2e96a` | `OnInitDialog` |
| `ev_6b8963f8808b6581bcc428eba6f7c2c52d09ac4085ecfed6eb60ab4c1b6af3e2` | app constructor |
| `ev_b60007f19e285069ae7ddc43a82222435d3eca08b9af65d96f81e90910a615a3` | dialog constructor |
| `ev_bb1576c5b2145d7752b7732eb1cd88a868b71d594c906d023f20858a93179c41` | xrefs to `0x403C30` |
| `ev_700f88d757d125ce52d92ec9f6d81d5016b67ca3e1537521df39fe9528015e22` | strings |
| `ev_16f9fe72ec582a24b0bc51c38a0f97ce7436611c56e939504780f78c987e1b66` | `_cinit` |
| `ev_3217b28367fe2390d7f141906043430c17c58ac7bb1aafc0800f6434e90461ec` | `0x403C30`, `0x404540`, `0x4071D0`, `0x406580` |
| `ev_7c7b853b4b5ee9d60a000840f932a0c9ae7d4c041541467b12a1a44543ef169f` | data-model batch |
| `ev_a1fc33ddcbf47c21781a50b5e9a2feabe8c2f5735f6d8c48445df3e7ed13eba8` | `0x404630`–`0x407450` |
| `ev_21eba4c30beacc3f4400a07efa215ddaec02db560260a0c0e99ab10c86b83ac1` | `0x403090`–`0x4056E0` |
| `ev_f0f8823712eddc107bc85068881b56c445db9de3f0d28d4ff3e859725e5486ed` | `0x405870`–`0x4060D0` |
| `ev_87bfbbf14f8d2ea9bd1a5bd57f0d6878f887a6bd45428238e64fbd3b9fd053cf` | `0x406540`–`0x406C80` |
| `ev_46edaf1657e864dafafe568400246642986b9e656c62507daa3d28f9bdc5c702` | `0x406D40`–`0x407FF0` |
| `ev_fb2637462c2940fc947bb071dd7a137915490e73a67526bc96ec2a6fbda54d10` | `0x4080E0`–`0x409A10` |
| `ev_e88256fd6fbade675983eecf3a1f18b8253b95fe7c5886c4a85cc9b091a8e014` | `0x401E30`–`0x401BB0` (grid widgets) |
| `ev_826e00ff7b671a61c5835d0d4b70078894f38107fa2dae87a578c81e9c232c14` | mixer `0x4083B0` |
| `ev_050e4dbea544625e781185cd2421904c808083d2b5a508a4fdc68e03df4998d9` | engine init `0x4081F0` |
| `ev_bebf87ceeaa8891b622b0026e0f070a6d963ec06ebbe6210ea7507ad24ac81d3` | loader / refresh / undo / tabs / title |
| `ev_d51c85c5c28b64a07e6d1ebb7053f8b20e8f0db732686aa32ba6728216403a1f` | writer / render / wavegen / wavload / preview |
| `ev_19c88e25a9735b951cbba1920ffa0d677b180da0e1b9f20c6e3bf3df205fd6d0` | `0x407470`, `0x4081F0`, `0x404540` (full text) |
| `ev_bac44ac19a39e90ade7d5d2d4313b44eb8378d7fb0f9dfb22fbee442cb606879` | `0x4059E0`, `0x404A40`, `0x4061C0`, `0x4043B0` |
| `ev_926decf439580f83d29dbdac176a5c12c6cf4198733864452363a6c74f878fdd` | `0x406A70`, `0x407FF0`, `0x407DB0` |
| `ev_94b40a9600976b03809e4805cca7007901d7e2900693c05aa985d4662ff73a0b` | objdump-only handlers |
| `ev_1a3313cfff2131c90c327c173d03a448c091ac4e4c7bfed74fdf6b696f1a14f0` | resource / message-map scan |
