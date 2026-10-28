#!/usr/bin/env python
"""Push-to-talk speech -> Thai text for the player's seat (faster-whisper large-v3 on an NVIDIA GPU).

Optional part of the game: tested only with NVIDIA cards (CUDA). Install with
requirements-mic.txt and download the model once (see INSTALL-FOR-AI.md, step "mic").
  python stt.py --serve
      stays running; loads the model once, warms it up, prints {"ready": true, ...}
      then one JSON request per stdin line  {"id": .., "wav": "path/clip.wav"}
      -> one JSON result per stdout line   {"id": .., "ok": true, "text": "...", "stt_ms": 812, "audio_sec": 4.2, ...}
  ... stt.py --file a.wav --file b.wav [--model NAME]   (one-off: transcribe and print, for tests)

The clip is 16-bit mono PCM WAV (the room page records at 16 kHz; other rates are resampled here).
The model is read from the Hugging Face cache only; nothing is downloaded by this script.
"""
import argparse
import json
import os
import re
import sys
import time
import wave

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
# CUDA DLLs come from the nvidia-* pip wheels (requirements-mic.txt) but are not on the DLL
# search path by default: add every site-packages/nvidia/<lib>/bin this Python can see
import site  # noqa: E402
_sites = list(site.getsitepackages()) + [site.getusersitepackages()]
for _sp in _sites:
    for _sub in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
        _bin = os.path.join(_sp, "nvidia", _sub, "bin")
        if os.path.isdir(_bin):
            os.add_dll_directory(_bin)
            os.environ["PATH"] = _bin + os.pathsep + os.environ.get("PATH", "")
os.environ.setdefault("HF_HUB_OFFLINE", "1")  # use the cached model only, never download in the background
from faster_whisper import WhisperModel  # noqa: E402

SR = 16000
MODEL = "large-v3"  # --model overrides (config.json stt.model); "h2oai/faster-whisper-large-v3-turbo" is ~4x faster, more wrong words
# names and game words the clip is likely to contain; biases spelling without forcing it
PROMPT = "เกมหมาป่า ป้าแจ่ม ลุงเพิ่ม น้องฟ้า ครูวิทย์ เจ๊หมวย ตี๋ หมาป่า หมอดู หมอ ชาวบ้าน โหวต"
# whole-clip outputs whisper invents on silence or breath (seen in earlier clip transcripts)
JUNK = ("ขอบคุณที่รับชม", "โปรดติดตามตอนต่อไป", "ซับไทย", "ติดตามช่อง", "กดไลค์", "กดติดตาม", "สวัสดีครับ", "Thank you")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def clean(t):
    t = t.replace("\u0e4d\u0e32", "\u0e33")  # whisper writes sara am as nikhahit + sara aa; looks the same, breaks search
    # a phrase looped 8+ times = decoder stuck, keep one. Real speech repeats too ("โหวตลุง" x4 in the
    # 2026-10-19 live test), so a lower threshold would delete what was really said
    t = re.sub(r"(.{2,24}?)(?:\s*\1){7,}", r"\1", t)
    return re.sub(r"\s{2,}", " ", t).strip()


def read_wav(path):
    with wave.open(path, "rb") as w:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if width != 2:
        raise ValueError("need 16-bit PCM, got %d bytes/sample" % width)
    a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if rate != SR:
        t_out = np.arange(int(len(a) * SR / rate)) / SR
        a = np.interp(t_out, np.arange(len(a)) / rate, a).astype(np.float32)
    return a


def load_model(name=None):
    t0 = time.time()
    m = WhisperModel(name or MODEL, device="cuda", compute_type="float16")
    load_ms = int((time.time() - t0) * 1000)
    t1 = time.time()
    # warm-up: the first call compiles CUDA kernels; do it now so the first real clip is fast
    noise = (np.random.default_rng(0).standard_normal(SR) * 0.01).astype(np.float32)
    list(m.transcribe(noise, language="th", beam_size=1, vad_filter=False)[0])
    return m, load_ms, int((time.time() - t1) * 1000)


def transcribe(model, audio, prompt=PROMPT):
    t0 = time.time()
    audio_sec = len(audio) / SR
    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    rms = float(np.sqrt(np.mean(audio ** 2))) if len(audio) else 0.0
    if audio_sec < 0.3 or peak < 0.01:
        return {"ok": True, "text": "", "empty": "too short or silent", "audio_sec": round(audio_sec, 2),
                "peak": round(peak, 3), "rms": round(rms, 4), "stt_ms": int((time.time() - t0) * 1000)}
    # tests/stt_bench.py on 5 real-voice clips: no timestamps + one temperature = 2.9 s mean, 3.4 s max for 9-12 s
    # of speech (timestamps / temperature fallback re-decode and took up to 10 s), same or better accuracy.
    # No VAD: a push-to-talk clip is nearly all speech, and VAD cut a word at a pause in the live test
    # ("ข้าม" -> "ข้าบ"); tests/stt_vad_compare.py on 15 clips: equal or better on every clip, same speed
    segs, info = model.transcribe(
        audio, language="th", beam_size=5, without_timestamps=True, temperature=0.0, vad_filter=False,
        condition_on_previous_text=False, initial_prompt=prompt or None)
    parts, dropped = [], []
    for s in segs:
        t = s.text.strip()
        if not t:
            continue
        # a segment that is probably not speech (breath, keyboard, room noise) -> leave it out
        if s.no_speech_prob > 0.6 and s.avg_logprob < -0.8:
            dropped.append(t)
            continue
        parts.append(t)
    text = clean(" ".join(parts))
    if text and any(text.startswith(j) for j in JUNK) and len(text) <= 30:
        dropped.append(text)
        text = ""
    if prompt and text and text.replace(" ", "") in prompt.replace(" ", ""):
        dropped.append(text)  # the prompt echoed back on a near-silent clip
        text = ""
    return {"ok": True, "text": text, "dropped": dropped or None, "audio_sec": round(audio_sec, 2),
            "speech_sec": round(info.duration_after_vad, 2), "peak": round(peak, 3), "rms": round(rms, 4),
            "stt_ms": int((time.time() - t0) * 1000)}


def serve(name):
    sys.stdin.reconfigure(encoding="utf-8")
    try:
        model, load_ms, warm_ms = load_model(name)
    except Exception as e:
        emit({"ready": False, "error": "%s: %s" % (type(e).__name__, e)})
        return 1
    emit({"ready": True, "model": name or MODEL, "load_ms": load_ms, "warm_ms": warm_ms})
    while True:
        line = sys.stdin.readline()
        if not line:
            return 0
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            res = transcribe(model, read_wav(req["wav"]), req.get("prompt", PROMPT))
        except Exception as e:
            res = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
        if "id" in req:
            res["id"] = req["id"]
        emit(res)


def main():
    ap = argparse.ArgumentParser(description="push-to-talk Thai transcription")
    ap.add_argument("--serve", action="store_true", help="JSON-lines worker on stdin/stdout")
    ap.add_argument("--file", action="append", help="transcribe this wav and print the result (repeatable)")
    ap.add_argument("--no-prompt", action="store_true", help="with --file: no name/word prompt")
    ap.add_argument("--model", help="faster-whisper model name or path (default large-v3)")
    a = ap.parse_args()
    if a.serve:
        return serve(a.model)
    if a.file:
        model, load_ms, warm_ms = load_model(a.model)
        emit({"ready": True, "model": a.model or MODEL, "load_ms": load_ms, "warm_ms": warm_ms})
        for f in a.file:
            r = transcribe(model, read_wav(f), None if a.no_prompt else PROMPT)
            r["file"] = os.path.basename(f)
            emit(r)
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
