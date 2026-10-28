# INSTALL-FOR-AI.md — setup guide for the user's AI assistant

You are Claude Code or Codex, running inside the folder of the "หมู่บ้านหมาป่า" (Werewolf) game on the user's Windows PC. Set the game up by following these steps in order. The user speaks Thai: **talk to them in Thai**, short and plain.

## Rules

- **Ask before you install anything** (Node.js, Python, ffmpeg, pip packages, CLIs). Say what it is, why the game needs it, and how big it is roughly. Never install silently.
- **Never run a real AI game or a real connection test without asking.** Every AI call uses the user's plan quota. Self-tests in this guide use test mode (no AI calls).
- **The Gemini key is secret.** If the user gives you one, write it only to `data/gemini_key.txt` (create `data/` if needed). Never print it, echo it back, put it in another file, a command line, a URL, or send it anywhere.
- Do not change the game's code. Do not run `git` commands that change history. Do not delete folders.
- Stop and ask when a step fails twice.

## 0. Unblock the downloaded files

If the folder came from a downloaded ZIP, Windows marks every file "from the internet" and double-clicking `start.bat` shows a security warning. Ask the user, then run in this folder:

```
powershell -NoProfile -Command "Get-ChildItem -Recurse | Unblock-File"
```

## 1. Check what is already there

Run each, note the result:

```
node -v
py -3 --version        (if that fails: python --version)
claude --version
codex --version
ffmpeg -version
```

- **Node.js ≥ 18 is required.** Missing or older → ask, then `winget install -e --id OpenJS.NodeJS.LTS` (a new terminal may be needed afterwards for PATH).
- **Python ≥ 3.10** is needed only for character voices. Missing → ask, then `winget install -e --id Python.Python.3.12`.
- **At least one of Claude Code / Codex** (or a Gemini key, step 4) must work, or there is no AI to play.
  - Claude Code: needs **2.1.280 or newer** for `claude-opus-5-5`. Older → ask, then run `claude update`. Not installed → ask, then follow https://docs.claude.com/en/docs/claude-code (native installer or `npm install -g @anthropic-ai/claude-code`). The user must be logged in with their Claude plan: if `claude` says it is not logged in, tell the user to run `claude` in a terminal and log in themselves.
  - Codex: not installed, or `codex exec --help` does not list `--ignore-user-config` (too old for this game) → ask, then `npm install -g @openai/codex@latest`. Login is the user's job: tell them to run `codex login` in a terminal. `codex login status` shows whether they are logged in.
  - `claude auth status --json` shows whether Claude Code is logged in (`"loggedIn": true`) without using quota.
  - You cannot log in for the user and must not handle their passwords.

## 2. Install the voice package

Only if Python is present and the user wants voices (recommend yes — the free voice needs no key):

```
py -3 -m pip install -r requirements.txt
```

(Use `python -m pip …` if `py` does not exist.)

## 3. ffmpeg (optional)

Needed only for **Gemini voices** (not for the free voice). Ask the user whether they have a Gemini key and want Gemini voices. If yes and `ffmpeg` is missing → ask, then `winget install -e --id Gyan.FFmpeg`.

## 4. Gemini key (optional)

Ask once: "มีคีย์ Gemini API ไหม (ไม่มีก็เล่นได้)". If the user pastes a key, write it to `data/gemini_key.txt` (just the key, one line). Otherwise skip — they can add it later in the game's settings card.

## 4b. Mic / push-to-talk (optional)

Lets the user speak instead of typing when they play a seat. **Tested only with NVIDIA graphics cards.** With another brand or no graphics card there is no data on whether it works — do not recommend it; skip this step.

1. Run `nvidia-smi`. Not found → tell the user the mic needs an NVIDIA card, skip.
2. Ask the user (it downloads about 3 GB in total and uses disk space). Then:

   ```
   py -3 -m pip install -r requirements-mic.txt
   py -3 -c "from faster_whisper.utils import download_model; download_model('large-v3')"
   ```

3. If the user keeps faster-whisper in another Python (a venv), write that python.exe path into `data/settings.json` → `"paths": { "sttPython": "..." }` (the web page cannot set paths).
4. In the game: settings card → **ไมค์** → tick it. It only works in "ฉันเล่นด้วย"; hold Space to talk.

## 5. Self-test (no AI calls)

```
npm test
node app/launch.js --selftest
```

Both must pass. `--selftest` plays one test-mode game to the end and prints `เช็คผ่าน`. If something fails, show the user the last lines of the output in Thai and stop.

## 6. Desktop shortcut

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
```

It creates **หมู่บ้านหมาป่า** on the desktop, pointing at `start.bat`.

## 7. Tell the user (in Thai)

Summarise in a few lines:

- what was installed, what is ready: Claude / ChatGPT / Gemini / free voice / Gemini voice
- what is still missing and how to fix it (e.g. "ยังไม่ได้ล็อกอิน Codex — พิมพ์ codex login")
- how to start: double-click **หมู่บ้านหมาป่า** on the desktop → the browser opens the game → press **ตั้งค่า AI และเสียง** to pick companies and press **ทดสอบ** (each test uses 1 call of quota)
- the quota note: one game ≈ 30–45 AI calls (estimate); a $20 plan may only allow a few games per 5 hours

Then ask whether they want you to start the game now (`start.bat`). Do not start a real AI game yourself.
