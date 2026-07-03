# Mettle — AI-Fluency Hiring Assessment (MVP)

Send a candidate one real task with a time limit. They work in a **proctored,
window-locked** browser session: their entire browser window (every tab in it —
AI tools included), their webcam, and their microphone are recorded. The share
is verified to be the right window, every paste and tab-switch is logged, and
moving focus to another window or app three times ends the attempt. Afterwards
an async analysis job samples frames from both recordings (time-interleaved,
so the screen and the face are judged at the same moments), scans the
microphone track for voices, and asks Claude for a layered, evidence-based
founder report:

0. **Verdict** — recommendation, completion, time used, one-line summary
1. **Task completion** — required vs delivered, reasoning, output quality
2. **Session integrity** — face flags, voice flags, and window behavior, each
   with a clickable timestamp into the recordings; flags are pointers for the
   founder to review, never an automatic cheating verdict
3. **Tools used & how much** — own-work vs assisted split, plus a per-tool
   table (which AI, which tools, minutes, times opened)
4. **What each tool use was for** — timestamped purposes read from the frames
5. **Depth of their own thinking** — evidence-backed green/red flags + rating
6. **Timeline** — clickable chapters that seek both videos in sync
7. **Full recordings** — browser window + webcam with microphone audio
8. **Candidate comparison** — a sortable table across all attempts on a task

## Stack

- **Client** — React + Vite + Tailwind, Monaco editor, `getDisplayMedia`
  (window surface required; a color-flash check verifies the shared window is
  the one hosting the assessment) + `getUserMedia` (camera + mic, mandatory) +
  `MediaRecorder` with chunked upload every 30s (a crash doesn't lose the
  session).
- **Server** — Node + Express, JSON-file storage under `server/data/`, in-process
  analysis queue.
- **Analysis** — `ffmpeg` frame sampling of the window recording (1 frame / 8s,
  ≤40 frames) and the webcam recording (1 frame / 20s, ≤15 frames),
  time-interleaved; `ffmpeg silencedetect` voice-activity scan of the mic
  track; event log + final code → Claude (`claude-opus-4-8`) with a strict
  JSON schema for the layered report.

## Run it

```bash
npm install            # installs server + client workspaces (ffmpeg-static included)
export ANTHROPIC_API_KEY=sk-ant-...

npm run dev            # server on :4000, client on :5173 (proxied)
# or production-style:
npm run build && npm start   # server serves the built client on :4000
```

Open `http://localhost:5173` (dev) — enter your email on the founder page,
create a task, copy the shareable link, open it in another browser as the
"candidate".

> Tab capture requires Chrome or Edge and a secure context (localhost counts).

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for real analysis |
| `MOCK_ANALYSIS` | unset | Set to `1` to generate a stub report without calling the API (demo/testing) |
| `ANALYSIS_MODEL` | `claude-opus-4-8` | Claude model for the analysis |
| `FRAME_INTERVAL_SECONDS` | `8` | Tab-recording frame sampling interval |
| `MAX_FRAMES` | `40` | Cap on tab frames sent to the model |
| `WEBCAM_FRAME_INTERVAL_SECONDS` | `20` | Webcam frame sampling interval |
| `MAX_WEBCAM_FRAMES` | `15` | Cap on webcam frames sent to the model |
| `FFMPEG_PATH` | bundled `ffmpeg-static` | Override the ffmpeg binary |
| `RETENTION_DAYS` | `90` | Recordings older than this are auto-deleted (reports are kept) |
| `PORT` | `4000` | Server port |

## Flow

1. **Founder** (`/`): enter your email → create a task (title, brief, time limit,
   optional starter code) → get an unguessable shareable link. Tasks are stored
   server-side under your email; no password auth in the MVP.
2. **Candidate** (`/attempt/:taskId`): sees the brief → explicit consent screen →
   shares **this browser window** (surface type and the specific window are
   verified — a tab, another window, or the full screen is rejected) and grants
   the **camera + microphone (both required)** → Monaco workspace with a
   countdown timer and a live webcam preview (bottom-left). They may open AI
   tools/search/docs in other tabs of that window — it's all recorded. Chunks
   upload every 30s; pastes (with a content snippet), typing, and every
   tab/focus switch are logged. **Moving focus outside the recorded window
   three times auto-submits the attempt.**
3. **Submit** (or timer expiry, stopping the share/camera, or lockdown):
   recordings stop, final code uploads, the analysis job runs.
4. **Founder** (`/founder/attempts/:id`): report with recommendation, AI-usage
   split, understanding signals, proctoring/integrity checks (present
   throughout, anyone else visible, looking off-screen), tab-switch count,
   clickable session timeline, and both recordings (tab + webcam with audio).

## The decision algorithm

The hire verdict is **not an AI opinion**. Claude is the perception layer only —
it reports timestamped observations (requirements met, tested or not, caught an
AI mistake or not, tool-use intents, integrity flags). A deterministic engine
(`server/src/scoring.js`) turns those into the verdict, and the report page
shows the whole calculation.

**Composite score (0–100)** = weighted layer scores:

| Layer | Weight | Scored from |
|---|---|---|
| Task completion | 35% | pass/partial/fail base, requirements met / total, works correctly ±8, code quality ×4 (−20..+20 — quality keeps separating candidates at the top; a mediocre complete submission can't max this layer) |
| Depth of thinking | 30% | fixed +/− rules over evidenced signals (caught AI mistake +18, tested own work +15, modified AI output +12, verified before submit +12, broke problem down +10, explained reasoning +10, prompts improved +8; pasted verbatim unverified −20, no understanding −25, output diverged −12, identical prompts −8). **Silent-mastery floor:** a correct, clean (quality ≥7), ≥85%-own-work solution floors this layer at 85 — an expert who just knows the answer is not punished for not narrating. |
| Tool use | 20% | purposeful uses (+6 each, max 5), thinking-avoidant uses (−12 each, capped at −36 so a rocky start can't bury a visible recovery), healthy own/AI mix +10, finished well under time +10 |
| Integrity | 15% | −15/face flag, −10/voice flag, −20/focus escape, −25 unrecorded activity; restored to 100 when the founder reviews and clears the flags |

**Bands:** ≥80 strong hire · ≥62 hire · ≥42 borderline · <42 no hire.

**Hard gates** (can only lower the band, never raise it):
- Empty submission or task failed → **no hire**
- ≥80% AI output with **neither editing nor verification** → **no hire**
  ("didn't edit it" is not "didn't understand it" — visibly running/reading/
  testing the pasted code counts as understanding)
- Partial completion → capped at **hire** — *unless* it was a deliberate,
  explicitly communicated scope cut with the rest delivered polished
  (triage is judgment, not failure)
- Requirements ticked but implementation brittle/minimal (quality ≤3) →
  capped at **borderline** (the rules-lawyer guard)
- Any integrity flag → capped at **borderline, pending human review** — never
  auto-rejected. The founder clicks the flagged timestamps, watches the
  moments, and resolves in one click: **clear** lifts the cap and restores
  the integrity score; **confirm** caps at no hire.

Fairness is a hard rule in the observation prompt: thinking is judged by
technical substance, never by English fluency or verbosity; short blunt
prompts that work are effective tool use; unrecognized tools are described
neutrally, never treated as suspicious.

Same observations always produce the same verdict; every triggered rule is
listed on the report. Candidates on a task are ranked by score in a sortable
comparison table. The judgment itself is regression-tested against 10
real-world edge cases (`npm test` → `server/test/scoring-stress.mjs`): the
fast quiet expert, the slow learner who recovers, the verified copy-paster,
the one loud paste, the false integrity flag, the rules-lawyer, the unknown
tool, the strategic skipper, and more.

## Consent & privacy

- Nothing records until the candidate explicitly agrees on the consent screen.
- Only the assessment browser window is captured — never the rest of the
  screen or other windows. Camera and microphone are mandatory and stated
  plainly before the session starts.
- Recordings auto-delete after `RETENTION_DAYS` (default 90); reports are kept.
- The analysis prompt is scoped to task-relevant activity and the specific
  integrity checks — incidental personal content in the capture is explicitly
  excluded from the report.

## Non-goals (MVP)

No auth system, no ATS integrations, no desktop app, no live analysis, no mobile,
one (coding) task type. Storage is local disk — swap `server/data/` for S3 later.
A browser cannot truly lock down the candidate's machine (a second device is
always possible) — the webcam integrity checks, focus-violation strikes, and
the analysis-time correlation of away-periods against window frames are the
mitigation, not a guarantee.
