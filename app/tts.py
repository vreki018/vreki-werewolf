#!/usr/bin/env python
"""VreKi ep003 - one line of text + character id -> mp3.

Engines (chosen per character in tts_voices.json, "engine": "gemini" | "edge"):
  gemini = Google Gemini TTS (paid key, voice + style prompt per character, ONE request per line, never split).
           Models are tried in the order of tts_voices.json -> gemini.models: when one is over its daily
           limit (HTTP 429 "per day") the next one is used with the same voice (and style where the model
           supports it). Each model has its own daily cap per project.
  edge   = Microsoft Edge neural TTS via edge-tts (free, no key) - the last fallback (every Gemini model out
           of quota, key/config error, timeout, bad audio), so a line still gets a voice.

Usage:
  python tts.py --char jaem --text "ข้อความ" --out line.mp3
  python tts.py --char jaem --stdin --out line.mp3     (UTF-8 text on stdin)
  python tts.py --serve                                (stay running: one JSON request per stdin line
                                                        {"id":..,"char":..,"text":..,"out":..}
                                                        -> one JSON result per stdout line)
  python tts.py --list                                 (print the voice settings per character)
  python tts.py --usage [--since 2026-10-20]           (audio seconds + cost estimate per game folder)
  python tts.py --quota                                (Gemini requests used today per model, caps, reset time)
  per-call overrides: --engine edge|gemini, --model (first model to try), --style, --voice, --rate, --pitch,
  --split (Edge only: cut a long line into chunks); the same keys work in a --serve request.

  Testing without spending the Gemini daily caps: add --engine edge (or "engine": "edge" in a --serve
  request). To check the Gemini path itself use one short line with
  --model gemini-2.5-flash-preview-tts --model-only (a fallback model's cap, never the Flash cap).

Result = one JSON line (ASCII-escaped) on stdout:
  {"ok": true, "char": "jaem", "out": "...", "engine": "gemini", "model": "...", "synth_ms": 1234,
   "duration_sec": 6.12, "audio_sec": 6.12, "cost_usd_est": 0.0014, "voice": ..., "gemini_attempts": [...]}
  "engine"/"model" = what actually made the audio; "fallback_reason" is set when Gemini failed and Edge was used.
  {"ok": false, "error": "..."}
Exit code 0 = mp3 written, 1 = failed. A failed line writes no file (temp .part file is removed).
Every call (ok or not) is appended to the usage log (VREKI_TTS_USAGE_LOG), with every
Gemini request it made, so --quota can count requests per model per day.

The Gemini key is read at call time from the file in VREKI_GEMINI_KEY_FILE (set by voice.js to
data/gemini_key.txt) and is sent only in the x-goog-api-key header. The usage log goes to
VREKI_TTS_USAGE_LOG (data/tts_usage.jsonl). edge-tts comes from pip (requirements.txt); a ../pylib
folder next to app/ is used first when it exists.
"""
import argparse
import asyncio
import base64
import datetime as dt
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
PYLIB = HERE.parent / "pylib"
if PYLIB.is_dir():
    sys.path.insert(0, str(PYLIB))

import edge_tts  # noqa: E402

VOICES_FILE = HERE / "tts_voices.json"
# edge-tts output format: audio-24khz-48kbitrate-mono-mp3 (constant bitrate) -> length = bytes * 8 / 48000
BYTES_PER_SEC = 48000 / 8
# th-TH-PremwadeeNeural sometimes answers "NoAudioReceived" after ~2.6 s (2026-10-18: up to 1 call in 4,
# once 4 in a row). It is the service, not the text: the same request works a few seconds later,
# so retry with a growing wait (worst case ~25 s before giving up).
RETRIES = 4
RETRY_WAIT_SEC = [0.5, 1, 2, 4]
EDGE_PARALLEL = 4  # split mode: at most this many Edge requests at once (a 1300-char line = ~30 chunks)
# it once also returned a 0.36 s clip for a 100-character line -> treat audio shorter than
# MIN_SEC_PER_CHAR per character (Thai speech here is ~15 characters per second) as a failure too.
MIN_SEC_PER_CHAR = 0.025
# Gemini: also reject audio far longer than the text could need (a model that rambles or reads the style).
MAX_SEC_PER_CHAR, MAX_SEC_EXTRA = 0.3, 4
# split mode: Premwadee takes ~1 s per 1 s of speech (Niwat ~0.2 s), so a long line is cut at spaces
# into chunks of <= SPLIT_CHARS characters, synthesized at the same time, and joined in order.
SPLIT_CHARS = 45
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
AUDIO_TOKENS_PER_SEC = 25  # Gemini bills output audio at 25 tokens per second
NO_QUOTA_CODES = (400, 401, 403, 404, 429, "config")  # requests that did not use a daily request
GEMINI_DEFAULTS = {
    "models": ["gemini-3.8-flash-tts"],
    "no_style_models": [],
    # per-request timeout grows with the line: base + per_char * characters, capped (2026-10-18 game:
    # lines of 750-1359 chars, 22-120 s of audio, timed out at the old flat 20 s)
    "timeout_base_sec": 30, "timeout_per_char_sec": 0.08, "timeout_cap_sec": 150,
    # the whole line (all Gemini models + Edge) must finish inside the room's wait (config.json
    # voice.timeoutSec = 150 s)
    "line_budget_sec": 145,
    # daily caps reset at 00:00 UTC = 07:00 Thai (from the 429 "retry in" time on 2026-10-18)
    "quota_reset_utc_hour": 0,
    "lines_per_game_est": 35,
}


class GeminiError(Exception):
    def __init__(self, msg, code=None, attempts=None):
        super().__init__(msg)
        self.code = code
        self.attempts = attempts or []


def load_config():
    with open(VOICES_FILE, encoding="utf-8") as f:
        return json.load(f)


def gcfg(cfg):
    return {**GEMINI_DEFAULTS, **(cfg.get("gemini") or {})}


def load_voices():
    return load_config()["characters"]


def setting_for(char_id, overrides=None):
    voices = load_voices()
    if char_id not in voices:
        raise KeyError(f"unknown character id '{char_id}' (known: {', '.join(voices)})")
    s = dict(voices[char_id])
    s.setdefault("engine", "edge")
    ov = {k: v for k, v in (overrides or {}).items() if v}
    if "engine" in ov:
        s["engine"] = ov.pop("engine")
    if s["engine"] == "gemini" and "voice" in ov:
        s["gemini_voice"] = ov.pop("voice")  # --voice picks the Gemini voice; the Edge fallback stays
    s.update(ov)
    return s


def split_text(text, max_chars=SPLIT_CHARS):
    chunks, cur = [], ""
    for w in text.split(" "):
        if cur and len(cur) + 1 + len(w) > max_chars:
            chunks.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}" if cur else w
    if cur:
        chunks.append(cur)
    return chunks


# ---------------------------------------------------------------- edge
async def synth_bytes(text, s, deadline=None):
    """One edge-tts request with retries -> (mp3 bytes, attempts). Stops retrying past `deadline`."""
    last_err = None
    for attempt in range(RETRIES + 1):
        try:
            comm = edge_tts.Communicate(
                text, s["voice"],
                rate=s.get("rate", "+0%"), pitch=s.get("pitch", "+0Hz"), volume=s.get("volume", "+0%"),
                receive_timeout=20,
            )
            buf = bytearray()
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    buf += chunk["data"]
            if not buf:
                raise RuntimeError("no audio received")
            if len(buf) / BYTES_PER_SEC < len(text) * MIN_SEC_PER_CHAR:
                raise RuntimeError(f"audio too short ({len(buf) / BYTES_PER_SEC:.2f} s for {len(text)} chars)")
            return bytes(buf), attempt + 1
        except Exception as e:  # network hiccup, NoAudioReceived, ...
            last_err = e
            if attempt < RETRIES:
                wait = RETRY_WAIT_SEC[attempt]
                if deadline and time.perf_counter() + wait > deadline:
                    break
                await asyncio.sleep(wait)
    raise RuntimeError(f"{type(last_err).__name__}: {last_err}")


async def edge_to(text, s, tmp, deadline=None):
    chunks = split_text(text) if s.get("split") else [text]
    gate = asyncio.Semaphore(EDGE_PARALLEL)

    async def one(c):
        async with gate:
            return await synth_bytes(c, s, deadline)

    parts = await asyncio.gather(*[one(c) for c in chunks])
    tmp.write_bytes(b"".join(p[0] for p in parts))  # same mp3 format per chunk -> plain join plays in order
    return {"engine": "edge", "model": "edge-tts", "voice": s["voice"], "rate": s.get("rate", "+0%"),
            "pitch": s.get("pitch", "+0Hz"), "chunks": len(chunks), "attempts": sum(p[1] for p in parts),
            "audio_sec": round(tmp.stat().st_size / BYTES_PER_SEC, 2), "cost_usd_est": 0.0}


# ---------------------------------------------------------------- gemini
def pcm_to_wav(raw, rate=24000):
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(raw)
    return out.getvalue()


def gemini_request(text, voice, style, model, key, timeout):
    """-> (wav bytes, usage dict or None). Raises GeminiError (with HTTP code when there is one)."""
    part = {"type": "text", "text": text}
    if style:
        part["annotations"] = [{"type": "speech_metadata", "style": style}]
    body = {"model": model, "input": [{"type": "user_input", "content": [part]}],
            "response_format": {"type": "audio"}, "generation_config": {"speech_config": [{"voice": voice}]}}
    req = urllib.request.Request(GEMINI_URL, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                 method="POST", headers={"x-goog-api-key": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise GeminiError(f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:300]}", e.code)
    except Exception as e:  # timeout, connection reset, ...
        raise GeminiError(f"{type(e).__name__}: {e}")
    for step in data.get("steps") or []:
        if step.get("type") == "model_output":
            for c in step.get("content") or []:
                if c.get("type") == "audio" and c.get("data"):
                    raw = base64.b64decode(c["data"])
                    return (raw if raw[:4] == b"RIFF" else pcm_to_wav(raw)), (data.get("usage") or None)
    raise GeminiError("no audio in response")


def wav_seconds(wav):
    with wave.open(io.BytesIO(wav)) as w:
        return w.getnframes() / float(w.getframerate())


def ffmpeg_exe(cfg):
    exe = os.environ.get("VREKI_FFMPEG") or shutil.which("ffmpeg")
    if not exe or not Path(exe).exists() and not shutil.which(exe):
        raise RuntimeError("ffmpeg not found (PATH or VREKI_FFMPEG)")
    return exe


def wav_to_mp3(wav, dst, cfg):
    p = subprocess.run([ffmpeg_exe(cfg), "-hide_banner", "-loglevel", "error", "-y", "-f", "wav", "-i", "pipe:0",
                        "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", str(dst)],
                       input=wav, capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if p.returncode != 0 or not dst.exists() or dst.stat().st_size == 0:
        raise RuntimeError(f"ffmpeg failed: {p.stderr.decode('utf-8', errors='replace')[:200]}")


def cost_usd(cfg, model, audio_sec, usage):
    price_in, price_out = (gcfg(cfg).get("prices_usd_per_m") or {}).get(model, [0, 0])
    u = usage or {}  # interactions API: total_input_tokens / total_output_tokens
    tok_out = u.get("total_output_tokens") or u.get("output_tokens") or audio_sec * AUDIO_TOKENS_PER_SEC
    tok_in = u.get("total_input_tokens") or u.get("input_tokens") or 0
    return round((tok_in * price_in + tok_out * price_out) / 1e6, 6)


def retry_in_sec(msg):
    m = re.search(r"retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?", msg or "")
    if not m or not any(m.groups()):
        return None
    h, mi, s = m.groups()
    return int(h or 0) * 3600 + int(mi or 0) * 60 + float(s or 0)


def quota_state_path(cfg):
    g = gcfg(cfg)
    return Path(usage_log_path() or HERE / "tts_usage.jsonl").with_name("tts_quota_state.json")


def read_quota_state(cfg):
    try:
        return json.loads(quota_state_path(cfg).read_text(encoding="utf-8"))
    except Exception:
        return {}


def mark_exhausted(cfg, model, until_epoch, msg):
    """Remember 'model is over its daily cap until X' for every worker (file next to the usage log)."""
    try:
        p = quota_state_path(cfg)
        st = read_quota_state(cfg)
        st[model] = {"until": until_epoch, "until_local": time.strftime("%Y-%m-%d %H:%M", time.localtime(until_epoch)),
                     "message": msg[:200]}
        tmp = p.with_name(p.name + f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, p)
    except Exception:
        pass


def next_reset_epoch(cfg, now=None):
    h = gcfg(cfg)["quota_reset_utc_hour"]
    now_utc = dt.datetime.fromtimestamp(now or time.time(), dt.timezone.utc)
    reset = now_utc.replace(hour=h, minute=0, second=0, microsecond=0)
    if reset <= now_utc:
        reset += dt.timedelta(days=1)
    return reset.timestamp()


def quota_day(cfg, epoch):
    h = gcfg(cfg)["quota_reset_utc_hour"]
    return (dt.datetime.fromtimestamp(epoch, dt.timezone.utc) - dt.timedelta(hours=h)).date().isoformat()


async def gemini_to(text, s, tmp, cfg, deadline):
    g = gcfg(cfg)
    key_file = Path(os.environ.get("VREKI_GEMINI_KEY_FILE") or "")
    if not os.environ.get("VREKI_GEMINI_KEY_FILE") or not key_file.is_file():
        raise GeminiError("no Gemini key (data/gemini_key.txt)", "config")
    key = key_file.read_text(encoding="utf-8").strip()
    first = s.get("model") or g["models"][0]
    models = [first] if s.get("model_only") else [first] + [m for m in g["models"] if m != first]
    no_style = set(g.get("no_style_models") or [])
    exhausted = read_quota_state(cfg)
    attempts, last = [], None
    for model in models:
        if (exhausted.get(model) or {}).get("until", 0) > time.time():
            attempts.append({"model": model, "skipped": "over daily cap until " + exhausted[model]["until_local"]})
            continue
        tries = 0
        while True:
            tries += 1
            left = deadline - time.perf_counter()
            if left < 10:
                raise GeminiError(f"no time left for Gemini ({left:.0f} s)", "time", attempts)
            timeout = min(g["timeout_cap_sec"], g["timeout_base_sec"] + g["timeout_per_char_sec"] * len(text), left - 3)
            style = "" if model in no_style else s.get("style", "")
            t1 = time.perf_counter()
            a = {"model": model, "t": time.time(), "timeout_sec": round(timeout), "styled": bool(style)}
            try:
                wav, usage = await asyncio.to_thread(gemini_request, text, s["gemini_voice"], style, model, key, timeout)
                sec = wav_seconds(wav)
                if not len(text) * MIN_SEC_PER_CHAR <= sec <= len(text) * MAX_SEC_PER_CHAR + MAX_SEC_EXTRA:
                    raise GeminiError(f"audio length {sec:.1f} s does not fit {len(text)} chars", "bad_audio")
                await asyncio.to_thread(wav_to_mp3, wav, tmp, cfg)
                attempts.append({**a, "ok": True, "ms": round((time.perf_counter() - t1) * 1000)})
                return {"engine": "gemini", "model": model, "voice": s["gemini_voice"], "styled": bool(style),
                        "attempts": len([x for x in attempts if "skipped" not in x]), "gemini_attempts": attempts,
                        "audio_sec": round(sec, 2), "usage": usage, "cost_usd_est": cost_usd(cfg, model, sec, usage)}
            except GeminiError as e:
                last = e
                msg = str(e)
                attempts.append({**a, "ok": False, "code": e.code, "ms": round((time.perf_counter() - t1) * 1000),
                                 "error": msg[:160]})
                if e.code == 429 and "per day" in msg:
                    wait = retry_in_sec(msg)
                    mark_exhausted(cfg, model, time.time() + wait if wait else next_reset_epoch(cfg), msg)
                    break  # next model
                if e.code == 429:  # per-minute limit: wait the hint once if it is short, else next model
                    wait = retry_in_sec(msg) or 5
                    if tries == 1 and wait <= 15 and deadline - time.perf_counter() > wait + 20:
                        await asyncio.sleep(wait)
                        continue
                    break
                if e.code == 400 and style and ("annotation" in msg or "metadata" in msg):
                    no_style.add(model)  # this model takes no style; same model again without it
                    continue
                if e.code in ("config", 401, 403) or "timed out" in msg.lower():
                    # key/billing problem: every model shares it · timeout: the next model would be as slow
                    raise GeminiError(msg, e.code, attempts)
                if tries == 1:  # 5xx, connection reset, bad audio: once more on the same model
                    continue
                break
    raise GeminiError(f"all Gemini models failed or over their daily cap ({last})" if last else
                      "all Gemini models over their daily cap", getattr(last, "code", None), attempts)


# ---------------------------------------------------------------- main path
def usage_log_path():
    return os.environ.get("VREKI_TTS_USAGE_LOG") or None


def log_usage(cfg, entry):
    path = usage_log_path()
    if not path:
        return
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass  # the log must never break a line


async def synth(char_id, text, out, overrides=None):
    text = " ".join((text or "").split())
    if not text:
        raise ValueError("empty text")
    cfg = load_config()
    s = setting_for(char_id, overrides)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".part")
    t0 = time.perf_counter()
    deadline = t0 + gcfg(cfg)["line_budget_sec"]
    info, fallback, g_attempts = None, None, []
    entry = {"t": time.strftime("%Y-%m-%d %H:%M:%S"), "ts": round(time.time()), "char": char_id,
             "chars": len(text), "out": str(out)}
    try:
        if s["engine"] == "gemini":
            try:
                info = await gemini_to(text, s, tmp, cfg, deadline)
                g_attempts = info.pop("gemini_attempts")
            except Exception as e:
                fallback = f"{type(e).__name__}: {e}"[:300]
                g_attempts = getattr(e, "attempts", [])
                if tmp.exists():
                    tmp.unlink()
        if info is None:
            info = await edge_to(text, s, tmp, deadline)
        os.replace(tmp, out)
    except Exception as e:
        log_usage(cfg, {**entry, "ok": False, "engine": s["engine"], "error": f"{type(e).__name__}: {e}"[:300],
                        "fallback_reason": fallback, "gemini_attempts": g_attempts,
                        "synth_ms": round((time.perf_counter() - t0) * 1000)})
        raise
    finally:
        if tmp.exists():
            tmp.unlink()
    res = {"ok": True, "char": char_id, "out": str(out), "synth_ms": round((time.perf_counter() - t0) * 1000),
           "duration_sec": info["audio_sec"], "bytes": out.stat().st_size, **info}
    if g_attempts:
        res["gemini_attempts"] = g_attempts
    if fallback:
        res["fallback_reason"] = fallback
    log_usage(cfg, {**entry, "ok": True, "engine": res["engine"], "model": res["model"], "voice": res["voice"],
                    "audio_sec": res["audio_sec"], "cost_usd_est": res["cost_usd_est"], "synth_ms": res["synth_ms"],
                    "usage": res.get("usage"), "fallback_reason": fallback, "gemini_attempts": g_attempts})
    return res


def read_usage_log(cfg):
    path = Path(usage_log_path() or "")
    if not usage_log_path() or not path.is_file():
        return None
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def usage_report(since=None):
    cfg = load_config()
    entries = read_usage_log(cfg)
    if entries is None:
        return {"ok": False, "error": "no usage log"}
    games = defaultdict(lambda: defaultdict(float))
    for e in entries:
        if since and e.get("t", "") < since:
            continue
        g = games[Path(e.get("out", "?")).parent.name]
        g["lines"] += 1
        g["failed"] += 0 if e.get("ok") else 1
        g["fallback_to_edge"] += 1 if e.get("ok") and e.get("fallback_reason") else 0
        g[f"{e.get('engine')}_audio_sec"] += e.get("audio_sec") or 0
        if e.get("engine") == "gemini":
            g[f"lines_{e.get('model')}"] += 1
        g["cost_usd_est"] += e.get("cost_usd_est") or 0
    return {"ok": True, "since": since, "games": {k: {kk: round(vv, 4) for kk, vv in v.items()} for k, v in games.items()}}


def quota_report():
    """Gemini requests that used a daily request, per model, in the current quota day (an estimate built
    from the usage log; requests made outside tts.py are not in it). The 429 message is the real answer."""
    cfg = load_config()
    g = gcfg(cfg)
    now = time.time()
    day = quota_day(cfg, now)
    used = defaultdict(int)
    for e in read_usage_log(cfg) or []:
        ts = e.get("ts") or time.mktime(time.strptime(e["t"], "%Y-%m-%d %H:%M:%S"))
        if "gemini_attempts" in e:
            for a in e["gemini_attempts"]:
                if "skipped" not in a and quota_day(cfg, a.get("t", ts)) == day and a.get("code") not in NO_QUOTA_CODES:
                    used[a["model"]] += 1
        elif quota_day(cfg, ts) == day:  # entries written before 2026-10-18 23:59 (no per-request list)
            if e.get("engine") == "gemini" and e.get("ok"):
                used[e["model"]] += 1
            elif "Timeout" in (e.get("fallback_reason") or ""):
                used[g["models"][0]] += 1
    state = read_quota_state(cfg)
    caps = g.get("daily_caps") or {}
    per_game = g["lines_per_game_est"]
    models, left_total, unknown = {}, 0, False
    for m in g["models"]:
        cap = caps.get(m)
        ex = state.get(m) if (state.get(m) or {}).get("until", 0) > now else None
        left = 0 if ex else (None if cap is None else max(cap - used[m], 0))
        if left is None:
            unknown = True
        else:
            left_total += left
        models[m] = {"used_est": used[m], "daily_cap": cap, "left_est": left,
                     "over_cap_until": ex["until_local"] if ex else None,
                     "style": m not in (g.get("no_style_models") or [])}
    reset = next_reset_epoch(cfg, now)
    return {"ok": True, "quota_day_utc": day, "resets_at_local": time.strftime("%Y-%m-%d %H:%M", time.localtime(reset)),
            "models_in_order": models, "lines_per_game_est": per_game,
            "full_games_left_est": round(left_total / per_game, 1),
            "note": ("plus models with unknown cap" if unknown else "") + "; estimate from usage log"}


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


OVERRIDE_KEYS = ("voice", "rate", "pitch", "split", "engine", "model", "model_only", "style")


async def serve():
    sys.stdin.reconfigure(encoding="utf-8")
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            return
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            res = await synth(req["char"], req["text"], req["out"], {k: req.get(k) for k in OVERRIDE_KEYS})
        except Exception as e:
            res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        if "id" in req:
            res["id"] = req["id"]
        emit(res)


def main():
    ap = argparse.ArgumentParser(description="VreKi ep003 character TTS (Gemini with Edge fallback)")
    ap.add_argument("--char", help="character id from tts_voices.json (jaem, perm, fah, wit, muay, tee)")
    ap.add_argument("--text", help="line to speak")
    ap.add_argument("--stdin", action="store_true", help="read the line from stdin (UTF-8)")
    ap.add_argument("--out", help="mp3 path to write")
    ap.add_argument("--engine", choices=["edge", "gemini"], help="override the character's engine")
    ap.add_argument("--model", help="first Gemini model to try (the rest of gemini.models follow)")
    ap.add_argument("--model-only", dest="model_only", action="store_true",
                    help="with --model: try only that model (then Edge) - for tests that must not touch other caps")
    ap.add_argument("--style", help="override the Gemini style prompt for this call")
    ap.add_argument("--voice", help="override voice for this call (Gemini voice when the engine is gemini)")
    ap.add_argument("--rate", help='override Edge rate, e.g. "+10%%"')
    ap.add_argument("--pitch", help='override Edge pitch, e.g. "-8Hz"')
    ap.add_argument("--split", action="store_true", help="Edge: cut a long line into chunks synthesized in parallel")
    ap.add_argument("--serve", action="store_true", help="JSON-lines worker on stdin/stdout")
    ap.add_argument("--list", action="store_true", help="print voice settings")
    ap.add_argument("--usage", action="store_true", help="sum audio seconds and cost per game folder")
    ap.add_argument("--since", help="with --usage: only entries at or after this time, e.g. 2026-10-20")
    ap.add_argument("--quota", action="store_true", help="Gemini requests used today per model + reset time")
    a = ap.parse_args()

    if a.list:
        emit(load_voices())
        return 0
    if a.usage:
        emit(usage_report(a.since))
        return 0
    if a.quota:
        emit(quota_report())
        return 0
    if a.serve:
        asyncio.run(serve())
        return 0
    text = a.text
    if a.stdin:
        sys.stdin.reconfigure(encoding="utf-8")
        text = sys.stdin.read()
    if not a.char or not a.out or not text:
        emit({"ok": False, "error": "need --char, --out and --text (or --stdin)"})
        return 1
    try:
        emit(asyncio.run(synth(a.char, text, a.out, {k: getattr(a, k) for k in OVERRIDE_KEYS})))
        return 0
    except Exception as e:
        emit({"ok": False, "error": f"{type(e).__name__}: {e}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
