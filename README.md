# Mettle — AI-Fluency Hiring Assessment (MVP)

Send a candidate one real task with a time limit and full freedom to use any AI tool.
Their screen (and optionally webcam) is recorded while they work in an in-browser
editor; afterwards an async analysis job samples frames from the recording, combines
them with the editor's paste/typing log and the final submission, and asks Claude for
an evidence-based report: how much was AI-generated vs their own work, a session
timeline with chapter markers, red/green flags, and a hire recommendation.

## Stack

- **Client** — React + Vite + Tailwind, Monaco editor, `getDisplayMedia` + `MediaRecorder`
  with chunked upload every 30s (a crash doesn't lose the session).
- **Server** — Node + Express, JSON-file storage under `server/data/`, in-process
  analysis queue.
- **Analysis** — `ffmpeg` frame sampling (1 frame / 8s, capped at 40 frames) + paste-event
  log + final code → Claude (`claude-opus-4-8`) with a strict JSON report schema.

## Run it

```bash
npm install            # installs server + client workspaces (ffmpeg-static included)
export ANTHROPIC_API_KEY=sk-ant-...

npm run dev            # server on :4000, client on :5173 (proxied)
# or production-style:
npm run build && npm start   # server serves the built client on :4000
```

Open `http://localhost:5173` (dev) — create a task, copy the shareable link, open it
in another tab as the "candidate".

> Screen recording requires Chrome or Edge and a secure context (localhost counts).

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for real analysis |
| `MOCK_ANALYSIS` | unset | Set to `1` to generate a stub report without calling the API (demo/testing) |
| `ANALYSIS_MODEL` | `claude-opus-4-8` | Claude model for the analysis |
| `FRAME_INTERVAL_SECONDS` | `8` | Screen-recording frame sampling interval |
| `MAX_FRAMES` | `40` | Cap on frames sent to the model |
| `FFMPEG_PATH` | bundled `ffmpeg-static` | Override the ffmpeg binary |
| `RETENTION_DAYS` | `90` | Recordings older than this are auto-deleted (reports are kept) |
| `PORT` | `4000` | Server port |

## Flow

1. **Founder** (`/`): create a task (title, brief, time limit, optional starter code) → get an unguessable shareable link. No auth in the MVP.
2. **Candidate** (`/attempt/:taskId`): sees the brief → explicit consent screen (screen recording required, webcam optional) → Monaco workspace with a countdown timer. Screen chunks upload every 30s; paste/typing events are logged.
3. **Submit** (or timer expiry, or stopping the screen share): recording stops, final code uploads, the analysis job runs.
4. **Founder** (`/founder/attempts/:id`): report with recommendation, AI-usage split, signals, clickable session timeline synced to the raw recording.

## Consent & privacy

- Nothing records until the candidate explicitly agrees on the consent screen.
- Webcam is strictly optional; screen recording is required (it's the work product).
- Recordings auto-delete after `RETENTION_DAYS` (default 90); reports are kept.
- The analysis prompt is scoped to task-relevant activity only — incidental personal
  content in the capture is explicitly excluded from the report.

## Non-goals (MVP)

No auth system, no ATS integrations, no desktop app, no live analysis, no mobile,
one (coding) task type. Storage is local disk — swap `server/data/` for S3 later.
