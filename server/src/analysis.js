import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { attempts, tasks, save, attemptDir } from './store.js';
import { ANALYSIS_SYSTEM_PROMPT } from './prompt.js';
import { reportSchema } from './reportSchema.js';

const execFileAsync = promisify(execFile);

const MODEL = process.env.ANALYSIS_MODEL || 'claude-opus-4-8';
const FRAME_INTERVAL_SECONDS = Number(process.env.FRAME_INTERVAL_SECONDS || 8);
const MAX_FRAMES = Number(process.env.MAX_FRAMES || 40);
const WEBCAM_FRAME_INTERVAL_SECONDS = Number(process.env.WEBCAM_FRAME_INTERVAL_SECONDS || 20);
const MAX_WEBCAM_FRAMES = Number(process.env.MAX_WEBCAM_FRAMES || 15);

async function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const mod = await import('ffmpeg-static');
    // The package can be present while its postinstall binary download failed.
    if (mod.default && fs.existsSync(mod.default)) return mod.default;
  } catch {
    // optional dependency not installed; fall through to system ffmpeg
  }
  return 'ffmpeg';
}

// ---------------------------------------------------------------------------
// Simple in-process job queue: one analysis at a time, survives restarts by
// re-enqueueing any attempt left in 'queued'/'processing' on boot.
// ---------------------------------------------------------------------------
const queue = [];
let running = false;

export function enqueueAnalysis(attemptId) {
  if (!queue.includes(attemptId)) queue.push(attemptId);
  drain();
}

export function recoverPendingJobs() {
  for (const attempt of Object.values(attempts)) {
    if (attempt.status === 'queued' || attempt.status === 'processing') {
      attempt.status = 'queued';
      enqueueAnalysis(attempt.id);
    }
  }
  save();
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const attemptId = queue.shift();
    try {
      await analyzeAttempt(attemptId);
    } catch (err) {
      console.error(`Analysis failed for ${attemptId}:`, err);
      const attempt = attempts[attemptId];
      if (attempt) {
        attempt.status = 'failed';
        attempt.error = String(err.message || err);
        save();
      }
    }
  }
  running = false;
}

// ---------------------------------------------------------------------------
// Pipeline steps
// ---------------------------------------------------------------------------

// MediaRecorder webm files lack duration/seek metadata; remuxing writes it so
// the founder's video player can seek. Also gives ffprobe-able duration.
// Covers both the tab recording and the webcam recording.
export async function remuxRecording(dir) {
  const ffmpeg = await resolveFfmpeg();
  const results = [];
  for (const [srcName, dstName] of [
    ['recording.webm', 'recording-fixed.webm'],
    ['webcam.webm', 'webcam-fixed.webm'],
  ]) {
    const src = path.join(dir, srcName);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, dstName);
    try {
      await execFileAsync(ffmpeg, ['-y', '-i', src, '-c', 'copy', dst], { timeout: 120_000 });
      results.push(dst);
    } catch (err) {
      console.error(`Remux failed for ${srcName} (will serve raw recording):`, err.message);
    }
  }
  return results;
}

async function extractFramesFrom(dir, { sources, framesSubdir, intervalSeconds, maxFrames, maxWidth }) {
  const video = sources.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!video) return [];

  const framesDir = path.join(dir, framesSubdir);
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const ffmpeg = await resolveFfmpeg();
  await execFileAsync(
    ffmpeg,
    [
      '-y', '-i', video,
      '-vf', `fps=1/${intervalSeconds},scale='min(${maxWidth},iw)':-2`,
      '-q:v', '6',
      path.join(framesDir, 'frame_%05d.jpg'),
    ],
    { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
  );

  let files = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
  // Frame N (1-indexed) is sampled around (N-1) * interval seconds.
  let frames = files.map((f, i) => ({
    file: path.join(framesDir, f),
    seconds: i * intervalSeconds,
  }));
  if (frames.length > maxFrames) {
    const step = frames.length / maxFrames;
    frames = Array.from({ length: maxFrames }, (_, i) => frames[Math.floor(i * step)]);
  }
  return frames;
}

const extractScreenFrames = (dir) =>
  extractFramesFrom(dir, {
    sources: ['recording-fixed.webm', 'recording.webm'],
    framesSubdir: 'frames',
    intervalSeconds: FRAME_INTERVAL_SECONDS,
    maxFrames: MAX_FRAMES,
    maxWidth: 1280,
  });

const extractWebcamFrames = (dir) =>
  extractFramesFrom(dir, {
    sources: ['webcam-fixed.webm', 'webcam.webm'],
    framesSubdir: 'webcam-frames',
    intervalSeconds: WEBCAM_FRAME_INTERVAL_SECONDS,
    maxFrames: MAX_WEBCAM_FRAMES,
    maxWidth: 640,
  });

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function readEvents(dir) {
  const file = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function formatEventLog(events) {
  if (events.length === 0) return '(no editor events were captured)';
  return events
    .map((e) => {
      const t = formatClock((e.t ?? 0) / 1000);
      if (e.type === 'paste') {
        const snippet = e.snippet ? `\n    pasted content begins: ${JSON.stringify(e.snippet)}` : '';
        return `${t} PASTE ${e.chars} chars${snippet}`;
      }
      if (e.type === 'typing') return `${t} typed ~${e.chars} chars`;
      if (e.type === 'delete') return `${t} deleted ~${e.chars} chars`;
      if (e.type === 'tab_out') return `${t} LEFT THE TAB (violation ${e.violation ?? '?'} of 3)`;
      if (e.type === 'tab_in') return `${t} returned to the tab`;
      if (e.type === 'focus_lost') return `${t} FOCUS MOVED TO ANOTHER WINDOW (violation ${e.violation ?? '?'} of 3)`;
      if (e.type === 'focus_gained') return `${t} focus returned to the tab`;
      if (e.type === 'ended_by_lockdown') return `${t} SESSION AUTO-SUBMITTED: too many tab/focus violations`;
      return `${t} ${e.type}`;
    })
    .join('\n');
}

function buildUserContent({ task, attempt, frames, webcamFrames, events, finalCode }) {
  const content = [];
  content.push({
    type: 'text',
    text: [
      `TASK BRIEF (title: ${task.title})`,
      `Time limit: ${task.timeLimitMinutes} minutes. Time used: ${formatClock(attempt.durationSeconds || 0)}.`,
      attempt.candidateName ? `Candidate: ${attempt.candidateName}` : '',
      '',
      task.brief,
    ]
      .filter(Boolean)
      .join('\n'),
  });

  for (const frame of frames) {
    content.push({ type: 'text', text: `Screenshot at ${formatClock(frame.seconds)}:` });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: fs.readFileSync(frame.file).toString('base64'),
      },
    });
  }
  if (frames.length === 0) {
    content.push({
      type: 'text',
      text: '(No screen recording frames are available for this session — base your analysis on the event log and final submission only, and note the missing video in your report.)',
    });
  }

  for (const frame of webcamFrames) {
    content.push({ type: 'text', text: `WEBCAM (candidate-facing camera) at ${formatClock(frame.seconds)}:` });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: fs.readFileSync(frame.file).toString('base64'),
      },
    });
  }
  if (webcamFrames.length === 0) {
    content.push({
      type: 'text',
      text: '(No webcam frames are available for this session — note in the integrity section that webcam-based checks could not be performed.)',
    });
  }

  content.push({
    type: 'text',
    text: `EDITOR EVENT LOG (timestamps from session start):\n${formatEventLog(events)}`,
  });
  content.push({
    type: 'text',
    text: `FINAL SUBMITTED ${task.language ? task.language.toUpperCase() + ' ' : ''}CODE/DOCUMENT:\n\n${finalCode || '(empty submission)'}`,
  });
  return content;
}

function mockReport(events, finalCode) {
  const pasted = events.filter((e) => e.type === 'paste').reduce((n, e) => n + (e.chars || 0), 0);
  const typed = events.filter((e) => e.type === 'typing').reduce((n, e) => n + (e.chars || 0), 0);
  const tabOuts = events.filter((e) => e.type === 'tab_out' || e.type === 'focus_lost').length;
  const total = pasted + typed || 1;
  const aiPct = Math.min(100, Math.round((pasted / total) * 100));
  return {
    aiUsageBreakdown: {
      percentEstimatedAIGenerated: aiPct,
      percentEstimatedOwnWork: 100 - aiPct,
      notes: `MOCK REPORT (no LLM call was made). Estimated from the event log: ~${pasted} chars pasted vs ~${typed} chars typed.`,
    },
    timeline: [{ start: '0:00', end: '0:00', label: 'Mock analysis — timeline unavailable without LLM analysis' }],
    signals: {
      caughtAIMistakes: false,
      understoodTheCode: 'unclear',
      problemBreakdown: 'unclear — mock analysis',
      testedOwnWork: false,
      tabSwitchCount: tabOuts,
      redFlags: [],
      greenFlags: [],
    },
    integrity: {
      candidatePresentThroughout: true,
      anotherPersonVisible: false,
      lookedAwayFrequently: false,
      notes: 'Mock analysis — webcam frames were not reviewed.',
    },
    completed: Boolean(finalCode && finalCode.trim()),
    summary: 'This is a mock report generated without calling the Claude API (set ANTHROPIC_API_KEY and unset MOCK_ANALYSIS for a real analysis).',
    recommendation: 'borderline',
  };
}

async function analyzeAttempt(attemptId) {
  const attempt = attempts[attemptId];
  if (!attempt) return;
  const task = tasks[attempt.taskId];
  const dir = attemptDir(attemptId);

  attempt.status = 'processing';
  attempt.error = null;
  save();

  const events = readEvents(dir);
  const finalCodePath = path.join(dir, 'final-code.txt');
  const finalCode = fs.existsSync(finalCodePath) ? fs.readFileSync(finalCodePath, 'utf8') : '';

  let report;
  if (process.env.MOCK_ANALYSIS) {
    report = mockReport(events, finalCode);
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set. Set it (or MOCK_ANALYSIS=1 for a stub report) and the job will retry on restart.');
    }
    let frames = [];
    try {
      frames = await extractScreenFrames(dir);
    } catch (err) {
      console.error('Frame extraction failed, analyzing without screenshots:', err.message);
    }
    let webcamFrames = [];
    try {
      webcamFrames = await extractWebcamFrames(dir);
    } catch (err) {
      console.error('Webcam frame extraction failed, analyzing without webcam:', err.message);
    }

    const client = new Anthropic();
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: ANALYSIS_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: reportSchema } },
      messages: [{ role: 'user', content: buildUserContent({ task, attempt, frames, webcamFrames, events, finalCode }) }],
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      throw new Error('The analysis model declined to process this session.');
    }
    const text = message.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error(`No text in analysis response (stop_reason: ${message.stop_reason})`);
    report = JSON.parse(text);
  }

  // Attach session metadata the founder page needs alongside the LLM output.
  report.attemptId = attemptId;
  report.candidateName = attempt.candidateName || 'Anonymous candidate';
  report.taskTitle = task.title;
  report.durationUsed = formatClock(attempt.durationSeconds || 0);
  report.timeLimit = `${task.timeLimitMinutes}:00`;

  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  attempt.status = 'complete';
  attempt.completedAt = new Date().toISOString();
  save();
  console.log(`Analysis complete for attempt ${attemptId}`);
}
