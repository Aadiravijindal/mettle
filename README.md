# Mettle — AI-Fluency Hiring Assessment (MVP)

Send a candidate one real task with a time limit. They work in a **proctored,
tab-locked** in-browser editor: the assessment tab, their webcam, and their
microphone are recorded, every paste and tab-switch is logged, and leaving the
tab three times ends the attempt. Afterwards an async analysis job samples
frames from both recordings, combines them with the editor's event log and the
final submission, and asks Claude for an evidence-based report: how much was
AI-generated vs their own work, a session timeline, integrity checks (present,
alone, looking at the screen), red/green flags, and a hire recommendation.

## Stack

- **Client** — React + Vite + Tailwind, Monaco editor, `getDisplayMedia`
  (locked to the current tab via `preferCurrentTab`) + `getUserMedia`
  (camera + mic, mandatory) + `MediaRecorder` with chunked upload every 30s
  (a crash doesn't lose the session).
- **Server** — Node + Express, JSON-file storage under `server/data/`, in-process
  analysis queue.
- **Analysis** — `ffmpeg` frame sampling of the tab recording (1 frame / 8s, ≤40
  frames) and the webcam recording (1 frame / 20s, ≤15 frames) + event log +
  final code → Claude (`claude-opus-4-8`) with a strict JSON report schema.

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
   the browser confirms sharing **this tab only** (no screen/window options) and
   requests the **camera + microphone (both required)** → Monaco workspace with
   a countdown timer and a live webcam preview (bottom-left). Chunks upload
   every 30s; pastes (with a content snippet), typing, and every tab/focus
   switch are logged. **Three tab/focus violations auto-submit the attempt.**
3. **Submit** (or timer expiry, stopping the share/camera, or lockdown):
   recordings stop, final code uploads, the analysis job runs.
4. **Founder** (`/founder/attempts/:id`): report with recommendation, AI-usage
   split, understanding signals, proctoring/integrity checks (present
   throughout, anyone else visible, looking off-screen), tab-switch count,
   clickable session timeline, and both recordings (tab + webcam with audio).

## Consent & privacy

- Nothing records until the candidate explicitly agrees on the consent screen.
- Only the assessment tab is captured — never the rest of the screen. Camera
  and microphone are mandatory and stated plainly before the session starts.
- Recordings auto-delete after `RETENTION_DAYS` (default 90); reports are kept.
- The analysis prompt is scoped to task-relevant activity and the specific
  integrity checks — incidental personal content in the capture is explicitly
  excluded from the report.

## Non-goals (MVP)

No auth system, no ATS integrations, no desktop app, no live analysis, no mobile,
one (coding) task type. Storage is local disk — swap `server/data/` for S3 later.
A browser cannot truly lock down the candidate's machine (a second device is
always possible) — the webcam integrity checks and tab-switch log are the
mitigation, not a guarantee.
