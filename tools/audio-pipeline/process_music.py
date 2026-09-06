"""Produce the shipped music loops from AI-generated masters (design/11 "Music & ambience").

The third driver beside `process_all.py` (combat SFX) and `process_ui.py` (screen cues).
It is separate because all three of its inputs differ from a cue's, and each difference
changes a step rather than a parameter:

  * The input is a 4-6 minute SONG, not a cue. A loop REGION has to be chosen, and its two
    endpoints have to match each other across the player's crossfade window -- so the
    region is an authored decision recorded in TRACKS below, measured by `music_probe`-style
    band analysis rather than eyeballed.
  * The input is mastered to 0 dBFS; the shipped cue set was deliberately peak-matched DOWN
    to the synth voices it replaced and lives at -14..-21 dBFS. There is no synth voice for
    music to match, so level is set by a BAND TARGET: the 250-2000 Hz RMS, which is the band
    `impact`, `muzzle` and `ui.tap` all peak in. Both masters measured ~20 dB hot.
  * It is stereo and it STAYS stereo. `audit.py`'s sfx/ui gates forbid stereo ("wastes
    bytes") because a 100 ms cue's second channel is pure overhead; a 76 s bed streams, so
    the bytes amortise and the RAM argument for mono does not apply at all.
  * The tempo is baked in here, not applied by the player. See `TEMPO_FACTOR` below for why
    this is a source-pipeline decision rather than a runtime `playbackRate` knob.

One property worth stating because it is not obvious: every filter here runs as a single
zero-phase multiply over the WHOLE region's spectrum. That is circular convolution, and a
loop region IS circular -- so filtering cannot introduce the endpoint discontinuity that a
windowed/overlap-add filter would.

Usage:  ./venv/Scripts/python process_music.py [--track menu|boss] [--out DIR]
"""
import argparse, os, shutil
import numpy as np
import soundfile as sf
import pedalboard  # pip install pedalboard -- pitch-preserving time-stretch (Rubber Band), see TEMPO_FACTOR

# The band measurement lives in audit.py -- it is the measurement+gate module, and the
# producer sharing it is what keeps the number this script reports and the number the gate
# checks from drifting apart. (They already drifted once inside this file: a search metric
# that sampled the crossfade window ranked a region at 3.01 dB that the full-window measure
# read as 5.61 dB.)
from audit import (BAND_N, XFADE_S, band_edges, band_profile, band_rms,
                   profile_diff, xfade_band_diff)

SRC_DIR = '../../art/audio/sources'
OUT_DIR = '../../client/public/audio/music'
CUE_DIR = '../../client/public/audio'

# Level target: the 250-2000 Hz RMS every track is normalised to. Chosen so each cue's
# PEAK still stands 9-15 dB above the music's continuous level in the band they share
# (ui.tap -20.9, muzzle -16.6, impact -14.7, deflect -14.3 dBFS peak). Comparing the music's
# RMS to a cue's RMS instead would demand a ~25 dB cut and bury the music; comparing to the
# cue's peak is the honest form of "can the transient still be heard over the bed".
MID_BAND = (250.0, 2000.0)
MID_TARGET_DBFS = -30.0
PEAK_CEILING_DBFS = -3.0     # headroom for inter-sample peaks and MP3 encode overshoot

RATE_LADDER = [24000, 32000, 44100, 48000]
QUALITY_LADDER = [0.6, 0.4, 0.2]     # libsndfile VBR quality; higher number = smaller file

# Tempo, 2026-09-06 balance pass: the shipped beds read as not relaxed enough, and there is no
# synthesized "tempo" to turn a knob on -- every track is a fixed AI-generated master, so a
# tempo change has to happen to the AUDIO, not to a runtime parameter.
#
# THIS WAS TRIED THE OTHER WAY FIRST, at the deck level (`HTMLMediaElement.playbackRate` /
# `InnerAudioContext.playbackRate`), and reverted: `preservesPitch` is a web guarantee, but
# WeChat's `InnerAudioContext` documents no pitch-preservation behaviour for its own
# `playbackRate`, so the identical multiplier would have shipped a DIFFERENT pitch on each
# platform -- an asset that sounds one way on web and another on WeChat is worse than the
# problem it was solving. Baking the stretch into the file at build time means every platform
# ships the same bytes.
#
# `pedalboard.time_stretch` (Rubber Band under the hood) is applied to the RAW region, before
# the shelf/level/measurement steps below -- so every band-diff and level number this script
# prints, and everything `audit.py --class music` gates, describes what actually ships, not
# the pre-stretch master. Its own convention is inverted from what "tempo" suggests: a HIGHER
# `stretch_factor` is a FASTER, SHORTER output, so slowing down means a factor BELOW 1.0.
#
# KNOWN GAP: `search_regions` (below) ranks candidate regions on the PRE-stretch master --
# same asymmetry this file's own docstring already warns about for the shelf ("it also
# searches the PROCESSED signal... the shelf is what forced it"). `menu`/`boss` did not need
# to be re-searched for this pass (their existing regions still measure inside the gate after
# stretching -- see `process()`'s printed band-diff), but a FUTURE region search that ignores
# this factor could rank a region that does not survive being stretched, for the same reason
# a region ranked on the raw master did not survive being shelved.
TEMPO_FACTOR = 0.7


def time_stretch(x: np.ndarray, sr: int) -> np.ndarray:
    """Slow `x` down by `TEMPO_FACTOR`, keeping pitch. `x` is (samples, channels) float64,
    matching every other function in this file; pedalboard wants float32 and hands back
    whatever shape it was given, so the cast is the only adaptation needed at either end."""
    if TEMPO_FACTOR == 1.0:
        return x
    stretched = pedalboard.time_stretch(x.astype(np.float32), sr, stretch_factor=TEMPO_FACTOR)
    return stretched.astype(np.float64)

# track id -> the authored decision. `region` came from the crossfade-aware loop search
# (see the band-diff figures in `why`); `shelf` is (corner Hz, gain dB) or None.

# `region` is (start, dur) in SHIPPED/STRETCHED-track seconds -- i.e. positions in the file
# that actually ships, after `TEMPO_FACTOR` -- not in the Suno master's own timeline. See
# `search_regions`'s TEMPO_FACTOR paragraph for why: a region chosen on the raw master does
# not survive being stretched (`pedalboard.time_stretch` is content-adaptive, not a uniform
# transform), so both entries below were RE-SEARCHED directly on the stretched signal
# (2026-09-06) rather than reusing the native-tempo regions from 2026-08-31. Each `why` gives
# the native-master position too, for anyone who wants to find the passage by ear in the
# original Suno file.
TRACKS = {
    'menu': dict(
        src='suno/Crystal Menu.mp3', region=(81.0, 68.0), shelf=None,
        why='Suno, 2026-08-31; region re-picked 2026-09-06 after TEMPO_FACTOR=0.7 made the '
            '2026-08-31 region (69 s from 218.5 s, band-diff 1.15 dB natively) measure 6.6 dB '
            'once stretched -- FAR over the 2.5 dB gate. Re-searched on the stretched whole '
            'track directly: 68 s from 81.0 s (native master position ~56.7 s), band-diff '
            '1.76 dB / level-diff 0.02 dB post-stretch, close in length to the original pick '
            'and comfortably inside the gate. Shorter candidates measured better still (down '
            'to 0.83 dB at 24.5 s) but were not worth trading away this much loop length for, '
            'sight unseen -- see `search_regions`\' printed table for the full ranking. Energy '
            'sits 160 Hz-1.2 kHz with no sub problem, so still no shelf.'),
    'boss': dict(
        src='suno/Frozen Resonance.mp3', region=(147.5, 47.5), shelf=(80.0, -14.0),
        why='Suno, 2026-08-31; region re-picked 2026-09-06 for the same reason as `menu` -- '
            'the 2026-08-31 region (64.5 s from 145.0 s, band-diff 1.62 dB natively) measured '
            '2.2-2.9 dB once stretched, too close to the 2.5 dB gate to keep. Re-searched on '
            'the stretched, SHELVED track directly (shelf changes the energy weighting, same '
            'as the 2026-08-31 search already accounted for): 47.5 s from 147.5 s (native '
            'master position ~103.2 s), band-diff 1.68 dB / level-diff 0.38 dB post-stretch. '
            'A tighter 20-30 s cluster measured noticeably better (down to 1.27 dB / 0.04 dB '
            'level-diff) but roughly halves the loop length; kept the longer region since '
            'nobody has heard either to judge whether the shorter one reads as repetitive in '
            'a boss fight. Generated against the MENU brief and measured as a sub-bass drone '
            'instead -- 90% of its energy below 109 Hz, nothing above 2 kHz -- which is dread, '
            'not a calm hub, so it became the boss bed. The shelf tames a 40-49 Hz band '
            'sitting 13 dB above every other: inaudible on a phone speaker, the only thing '
            'audible on headphones, and it costs MP3 bits either way.'),
}


def db(x: float) -> float:
    return -np.inf if x <= 1e-12 else 20.0 * np.log10(x)


def search_regions(src: str, shelf: tuple | None = None, lo_s: float = 20.0,
                   hi_s: float = 90.0, hop_s: float = 0.5) -> list[tuple]:
    """Rank loop regions by the SAME measure the shipped file is then judged by.

    The first version of this search scored a candidate from four 4096-point frames spaced
    0.5 s apart -- 16 k of the 96 k samples in a 2 s crossfade window. It ranked a menu
    region at 3.01 dB that `xfade_band_diff` then measured at 5.61 dB on the extracted
    audio. Sampling a window is not measuring it, and a search whose ranking metric is
    coarser than its acceptance metric will hand back candidates that do not survive.

    So both now go through `band_profile` over the full window AND through `profile_diff`
    for the comparison -- the same two calls the gate makes, not a reimplementation. The
    second time this drifted, the search was averaging band differences unweighted while
    the gate weighted them by energy, and a region ranked 2.44 dB measured 3.39 dB.

    It also searches the PROCESSED signal, which is the third form the same drift took. The
    shelf is what forced it: `boss` is a sub-dominated drone, so attenuating below 80 Hz
    moves the energy weighting onto the mids, where its head and tail differ more. A region
    ranked 1.41 dB on the raw audio measured 3.69 dB after the shelf that always applies to
    it. Level normalisation is a scalar and cannot change a dB difference, and the 24 kHz
    resample only drops bands near -80 dBFS, so the shelf is the one step that matters here.

    `TEMPO_FACTOR` (2026-09-06) is the fourth form, and the one that mattered most: a region
    picked at native tempo does NOT survive being stretched, because `pedalboard.time_stretch`
    is content-adaptive (its transient handling reacts to what is locally there) rather than a
    uniform circular transform like the shelf -- `menu`'s region measured 1.15 dB natively and
    6.6 dB once stretched. So this searches the STRETCHED whole track, meaning `lo_s`/`hi_s`
    and every reported position/length are in SHIPPED (stretched) seconds, not the master's own
    timeline -- `report_search` prints both.

    Cost adds small terms for level mismatch and for settling in a passage quieter than the
    track's own median (which is how a search lands on the intro).
    """
    x, sr = sf.read(src, dtype='float32', always_2d=True)
    x = time_stretch(x.astype(np.float64), sr)
    if shelf:
        x = low_shelf(x.astype(np.float64), sr, *shelf)
    mono = x.mean(axis=1)
    w, hop = int(XFADE_S * sr), int(hop_s * sr)
    nwin = (len(mono) - w) // hop + 1
    prof = np.stack([band_profile(mono[i * hop:i * hop + w], sr) for i in range(nwin)])
    lvl = np.array([db(float(np.sqrt(np.mean(mono[i * hop:i * hop + w] ** 2))))
                    for i in range(nwin)])
    med = float(np.median(lvl))
    steps_lo, steps_hi = int(lo_s / hop_s), int(hi_s / hop_s)
    xf_steps = int(XFADE_S / hop_s)
    out = []
    for i in range(nwin):
        for k in range(steps_lo, steps_hi + 1):
            j = i + k - xf_steps
            if j >= nwin:
                break
            d = profile_diff(prof[i], prof[j])
            dl = abs(lvl[j] - lvl[i])
            quiet = max(0.0, med - min(lvl[i], lvl[j]))
            out.append((d + 0.5 * dl + 0.5 * quiet, i * hop_s, k * hop_s, d, dl, lvl[i], lvl[j]))
    out.sort(key=lambda r: r[0])
    return out


def report_search(name: str) -> None:
    """`name` is a track id (searched with that track's shelf) or a bare source filename."""
    spec = TRACKS.get(name)
    src = os.path.join(SRC_DIR, spec['src']) if spec else (
        name if os.path.isabs(name) else os.path.join(SRC_DIR, name))
    shelf = spec['shelf'] if spec else None
    best = search_regions(src, shelf=shelf)
    print()
    print(f'{os.path.basename(src)}: {len(best)} candidate regions (SHIPPED/stretched '
          f'seconds, x{TEMPO_FACTOR} tempo already applied), ranked by full-window band '
          f'difference'
          + (f', shelf {shelf[1]:+.0f} dB below {shelf[0]:.0f} Hz applied' if shelf
             else ' (no shelf)'))
    print('    bucket     cost   start      len   band-diff  lvl-diff   head    tail   '
          '(native start)')
    for lo, hi in ((20, 30), (30, 45), (45, 60), (60, 75), (75, 90)):
        sel = [r for r in best if lo <= r[2] < hi]
        if not sel:
            continue
        c, st, ln, d, dl, hr, tr = sel[0]
        print(f'    {lo:3}-{hi:3}s  {c:6.2f}  {st:6.1f}s  {ln:5.1f}s   {d:6.2f}dB   '
              f'{dl:5.2f}dB  {hr:6.1f}  {tr:6.1f}   ({st * TEMPO_FACTOR:.1f}s)')


def low_shelf(x: np.ndarray, sr: int, f0: float, gain_db: float) -> np.ndarray:
    """Zero-phase low shelf: `gain_db` below f0, unity well above, smooth between.

    g(f) = 1 + (G-1)/(1+(f/f0)^ORDER), applied to one FFT of the whole region. Circular, so
    the loop's endpoints stay exactly as continuous as they were.

    ORDER is 4, not 2. A 2nd-order shelf at f0=80 Hz reaches only -6.9 dB at 40 Hz -- and
    40-49 Hz is the exact band this exists to tame, so the gentler curve under-delivers
    where it is aimed. The selfcheck below asserts the requirement (near-full attenuation
    by f0/2, unity by 4*f0) rather than the algebra, which is what caught it.
    """
    g_lin = 10.0 ** (gain_db / 20.0)
    n = len(x)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    gain = 1.0 + (g_lin - 1.0) / (1.0 + (freqs / f0) ** 4)
    out = np.empty_like(x)
    for c in range(x.shape[1]):
        out[:, c] = np.fft.irfft(np.fft.rfft(x[:, c]) * gain, n)
    return out


def set_band_target(x: np.ndarray, sr: int, target_db: float) -> tuple[np.ndarray, float]:
    """Scale so the MID_BAND RMS lands on target_db. Returns (signal, gain applied in dB)."""
    have = band_rms(x, sr, *MID_BAND)
    delta = target_db - have
    y = x * (10.0 ** (delta / 20.0))
    return y, delta


def peak_guard(x: np.ndarray, ceiling_db: float) -> tuple[np.ndarray, float]:
    peak = db(float(np.max(np.abs(x))))
    if peak <= ceiling_db:
        return x, 0.0
    trim_db = ceiling_db - peak
    return x * (10.0 ** (trim_db / 20.0)), trim_db


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """Per-channel spectral resample. `process_all.py`'s version is mono-only."""
    if sr_in == sr_out:
        return x
    n_out = int(round(len(x) * sr_out / sr_in))
    out = np.zeros((n_out, x.shape[1]))
    for c in range(x.shape[1]):
        spec = np.fft.rfft(x[:, c])
        bins = n_out // 2 + 1
        new = np.zeros(bins, dtype=complex)
        keep = min(len(spec), bins)
        new[:keep] = spec[:keep]
        out[:, c] = np.fft.irfft(new, n_out) * (n_out / len(x))
    return out


def encode_smallest(y: np.ndarray, sr_in: int, path: str,
                    tol_db: float = 1.5) -> tuple[int, int, float, float]:
    """Smallest MP3 over (rate x quality) that survives a MEASURED fidelity check.

    The check is not "did the encoder run" -- it decodes the result back and compares the
    two bands the mix actually depends on (250-2000 Hz, where the cues peak, and 2-8 kHz,
    where `deflect` has to cut through) against the pre-encode signal. An encoder setting
    that quietly dulls the bed would otherwise ship as "smallest file wins".

    Returns (rate, bytes, quality, worst band error in dB).
    """
    want_mid = band_rms(y, sr_in, *MID_BAND)
    want_sfx = band_rms(y, sr_in, 2000.0, 8000.0)
    best = None
    for r in RATE_LADDER:
        z = resample(y, sr_in, r)
        for q in QUALITY_LADDER:
            tmp = f'{path}.{r}.{q}.tmp'
            sf.write(tmp, z, r, format='MP3', subtype='MPEG_LAYER_III',
                     bitrate_mode='VARIABLE', compression_level=q)
            back, bsr = sf.read(tmp, dtype='float64', always_2d=True)
            err = max(abs(band_rms(back, bsr, *MID_BAND) - want_mid),
                      abs(band_rms(back, bsr, 2000.0, min(8000.0, bsr / 2 - 1)) - want_sfx))
            n = os.path.getsize(tmp)
            if err > tol_db:
                os.remove(tmp)
                continue
            if best is None or n < best[1]:
                if best:
                    os.remove(best[4])
                best = (r, n, q, err, tmp)
            else:
                os.remove(tmp)
    if best is None:
        raise SystemExit(f'no (rate, quality) on the ladder held {tol_db} dB for {path}')
    shutil.move(best[4], path)
    return best[0], best[1], best[2], best[3]


def cue_peaks() -> dict:
    """Peak dBFS of the shipped cues that play OVER music, for the report's headroom line."""
    out = {}
    for name in ('ui-tap_00', 'muzzle_00', 'impact_00', 'deflect_00'):
        p = os.path.join(CUE_DIR, name + '.mp3')
        if os.path.exists(p):
            x, _ = sf.read(p, dtype='float64', always_2d=True)
            out[name.split('_')[0]] = db(float(np.max(np.abs(x))))
    return out


def selfcheck() -> None:
    """Every step, against a signal whose correct answer is known independently.

    Two bugs in this session's exploratory version of these measurements were found only
    this way -- an FFT normalisation that calibrated peak amplitude while reporting RMS,
    and a block loop that never executed on short input and read -inf for every cue. Both
    produced numbers that looked entirely plausible.
    """
    sr = 48000
    t = np.arange(sr * 4) / sr

    # band_rms: a sine reads its own RMS in its own band, and nothing in another band.
    for f, amp in ((100.0, 0.5), (1000.0, 0.25), (5000.0, 0.1)):
        x = (amp * np.sin(2 * np.pi * f * t))[:, None]
        lo, hi = (f * 0.8, f * 1.25)
        assert abs(band_rms(x, sr, lo, hi) - db(amp / np.sqrt(2))) < 0.5, f
        assert band_rms(x, sr, f * 4, f * 6) < db(amp / np.sqrt(2)) - 50, f

    # band_profile agrees with band_rms on a broadband signal (two implementations, one truth).
    rng = np.random.default_rng(11)
    noise = (rng.standard_normal(sr * 4) * 0.05)[:, None]
    prof = band_profile(noise, sr)
    edges = band_edges()
    sel = [b for b in range(BAND_N) if edges[b] >= 250 and edges[b + 1] <= 2000]
    agg = db(np.sqrt(np.sum(10 ** (prof[sel] / 10.0))))
    direct = band_rms(noise, sr, edges[sel[0]], edges[sel[-1] + 1])
    assert abs(agg - direct) < 0.5, f'{agg:.2f} vs {direct:.2f}'

    # low_shelf, held to the DESIGN requirement rather than to its own formula: essentially
    # the full cut by f0/2 (the band it is aimed at), unity well above, monotonic between.
    def shelf_at(f, f0=80.0, g=-14.0):
        y = low_shelf((0.4 * np.sin(2 * np.pi * f * t))[:, None], sr, f0, g)
        return db(float(np.sqrt(np.mean(y ** 2)))) - db(0.4 / np.sqrt(2))
    at40, at80, at160, at2k = (shelf_at(f) for f in (40.0, 80.0, 160.0, 2000.0))
    assert -14.5 < at40 < -10.0, f'f0/2 moved {at40:.2f} dB, wanted close to -14'
    assert abs(at2k) < 0.3, f'2 kHz moved {at2k:.2f} dB, wanted 0'
    assert at40 < at80 < at160 < at2k, f'not monotonic: {at40:.1f} {at80:.1f} {at160:.1f} {at2k:.1f}'
    sig = (rng.standard_normal(4096) * 0.1)[:, None]
    a = np.roll(low_shelf(sig, sr, 80.0, -14.0), 137, axis=0)
    b = low_shelf(np.roll(sig, 137, axis=0), sr, 80.0, -14.0)
    assert np.max(np.abs(a - b)) < 1e-9, 'low_shelf is not circular; a loop would gain a seam'

    # set_band_target hits the target; peak_guard only ever reduces.
    y, _ = set_band_target(noise, sr, -30.0)
    assert abs(band_rms(y, sr, *MID_BAND) - (-30.0)) < 0.01
    loud = np.clip(noise * 40, -0.99, 0.99)
    g, trim = peak_guard(loud, -3.0)
    assert trim < 0 and abs(db(float(np.max(np.abs(g)))) - (-3.0)) < 0.01
    q, trim0 = peak_guard(noise, -3.0)
    assert trim0 == 0.0 and np.array_equal(q, noise)

    # resample keeps duration, channel count and level for a stereo signal.
    st = np.stack([0.3 * np.sin(2 * np.pi * 440 * t), 0.3 * np.sin(2 * np.pi * 660 * t)], axis=1)
    z = resample(st, sr, 24000)
    assert z.shape[1] == 2 and abs(len(z) / 24000 - len(st) / sr) < 1e-3
    assert abs(db(float(np.sqrt(np.mean(z ** 2)))) - db(float(np.sqrt(np.mean(st ** 2))))) < 0.3

    # xfade_band_diff: identical head and tail read ~0; a tail an octave away does not.
    # Signals must exceed 4x the crossfade window (8 s at XFADE_S=2) or the measurement
    # returns nan -- and `nan < 0.5` is False, so the assertion fails rather than passing
    # silently. A `not (x > 0.5)` phrasing here would have let a nan through as a pass.
    per = st[:sr]
    same = np.concatenate([per] * 10)
    got_same = xfade_band_diff(same, sr)
    assert not np.isnan(got_same) and got_same < 0.5, got_same
    other = np.stack([0.3 * np.sin(2 * np.pi * 3000 * t[:sr]),
                      0.3 * np.sin(2 * np.pi * 3300 * t[:sr])], axis=1)
    lurch = np.concatenate([per] * 9 + [other])
    got_lurch = xfade_band_diff(lurch, sr)
    assert got_lurch > 5.0, got_lurch

    # time_stretch: duration scales by 1/TEMPO_FACTOR, and -- the property that justifies
    # reaching for it over a naive resample -- pitch does NOT move with it.
    tone = np.tile((0.3 * np.sin(2 * np.pi * 440.0 * t))[:, None], (1, 2))
    stretched = time_stretch(tone, sr)
    want_s = len(tone) / sr / TEMPO_FACTOR
    assert abs(len(stretched) / sr - want_s) < 0.05, \
        f'time_stretch duration {len(stretched) / sr:.2f}s, wanted ~{want_s:.2f}s'
    spec = np.abs(np.fft.rfft(stretched[:, 0]))
    freqs = np.fft.rfftfreq(len(stretched), 1.0 / sr)
    peak_f = float(freqs[np.argmax(spec)])
    assert abs(peak_f - 440.0) < 5.0, f'time_stretch moved the pitch to {peak_f:.1f} Hz'

    print('selfcheck: band_rms, band_profile, low_shelf (incl. circularity), set_band_target,'
          ' peak_guard, resample, xfade_band_diff, time_stretch -- all ok')


def process(track: str, out_dir: str) -> None:
    spec = TRACKS[track]
    src = os.path.join(SRC_DIR, spec['src'])
    # `region` is already in SHIPPED/stretched-track seconds -- see TRACKS' header comment.
    t0, dur = spec['region']
    info = sf.info(src)
    sr = info.samplerate

    # Stretch the WHOLE master before slicing out the region, not the other way round. The
    # first version of this cut the region first (at its native-tempo position) and stretched
    # that isolated clip -- which handed `pedalboard.time_stretch` two hard edges with no
    # musical context beyond them, and blew the loop seam's band-diff from ~1.5 dB (native
    # tempo, both tracks) to 6.6 dB (`menu`) / 2.69 dB (`boss`, just over the 2.5 dB gate) on
    # the first run. Stretching the full track gives the algorithm the same continuous context
    # a real mix engineer would, and slicing afterward is the same arithmetic
    # `sf.read(..., start=, stop=)` always did -- just directly in stretched-track seconds now,
    # which is also why `region` moved to that unit (see TRACKS above).
    whole, sr_read = sf.read(src, dtype='float64', always_2d=True)
    assert sr_read == sr
    whole = time_stretch(whole, sr)
    start = int(round(t0 * sr))
    stop = int(round((t0 + dur) * sr))
    x = whole[start:stop]

    print(f'\n{track}  <- {spec["src"]}  region {t0}-{t0 + dur}s ({dur}s, {x.shape[1]} ch)'
          f'  (native master ~{t0 * TEMPO_FACTOR:.1f}-{(t0 + dur) * TEMPO_FACTOR:.1f}s)')

    print(f'  in   peak {db(float(np.max(np.abs(x)))):+7.2f} dBFS   '
          f'mid {band_rms(x, sr, *MID_BAND):7.2f}   '
          f'sub {band_rms(x, sr, 20, 250):7.2f}   sfx {band_rms(x, sr, 2000, 8000):7.2f}')

    if spec['shelf']:
        f0, g = spec['shelf']
        print(f'       xfade band-diff {xfade_band_diff(x, sr):5.2f} dB (raw -- not the '
              f'comparable figure, the shelf below moves the energy weighting)')
        x = low_shelf(x, sr, f0, g)
        print(f'  shelf {g:+.1f} dB below {f0:.0f} Hz  ->  '
              f'sub {band_rms(x, sr, 20, 250):7.2f} dBFS, '
              f'xfade band-diff {xfade_band_diff(x, sr):5.2f} dB')
    else:
        print(f'       xfade band-diff {xfade_band_diff(x, sr):5.2f} dB')

    x, gain = set_band_target(x, sr, MID_TARGET_DBFS)
    print(f'  level {gain:+.2f} dB  ->  mid {band_rms(x, sr, *MID_BAND):.2f} dBFS '
          f'(target {MID_TARGET_DBFS})')
    x, trim = peak_guard(x, PEAK_CEILING_DBFS)
    if trim:
        print(f'  peak guard {trim:+.2f} dB (mid target missed by that much)')

    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f'{track}.mp3')
    rate, nbytes, q, err = encode_smallest(x, sr, path)

    back, bsr = sf.read(path, dtype='float64', always_2d=True)
    kbps = nbytes * 8 / (len(back) / bsr) / 1000.0
    print(f'  out  {rate} Hz, VBR q={q}, {nbytes / 1024:.1f} kB, {kbps:.1f} kbps, '
          f'band error {err:.2f} dB')
    print(f'       peak {db(float(np.max(np.abs(back)))):+7.2f} dBFS   '
          f'mid {band_rms(back, bsr, *MID_BAND):7.2f}   '
          f'sub {band_rms(back, bsr, 20, 250):7.2f}   '
          f'sfx {band_rms(back, bsr, 2000, min(8000, bsr / 2 - 1)):7.2f}')
    print(f'       decoded {len(back) / bsr:.3f} s (region {dur}s), '
          f'xfade band-diff {xfade_band_diff(back, bsr):5.2f} dB')
    mid = band_rms(back, bsr, *MID_BAND)
    peaks = cue_peaks()
    if peaks:
        head = '  '.join(f'{k} {p - mid:+5.1f}' for k, p in sorted(peaks.items(),
                                                                   key=lambda kv: kv[1]))
        print(f'       cue peak above music mid-band RMS:  {head}  dB')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--track', choices=sorted(TRACKS), action='append')
    ap.add_argument('--out', default=OUT_DIR)
    ap.add_argument('--search', metavar='TRACK_OR_FILE', action='append',
                    help='rank loop regions and exit. A track id searches that source WITH '
                         'the track shelf applied, which is what the gate then measures; '
                         'a bare filename searches the raw master.')
    a = ap.parse_args()
    selfcheck()
    if a.search:
        for f in a.search:
            report_search(f)
        return
    for t in (a.track or sorted(TRACKS)):
        process(t, a.out)


if __name__ == '__main__':
    main()
