import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { attempts, tasks, save, attemptDir } from './store.js';
import { ANALYSIS_SYSTEM_PROMPT } from './prompt.js';
import { reportSchema } from './reportSchema.js';
import { computeScoring, thinkingRatingFromScore } from './scoring.js';

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

// Scans the microphone track for audible segments using ffmpeg silencedetect.
// The model can't hear audio — these timestamped segments become voice-check
// pointers the founder can click and listen to.
export async function detectAudioActivity(dir) {
  const video = ['webcam-fixed.webm', 'webcam.webm']
    .map((f) => path.join(dir, f))
    .find((f) => fs.existsSync(f));
  if (!video) return { available: false, segments: [] };

  const ffmpeg = await resolveFfmpeg();
  let stderr;
  try {
    ({ stderr } = await execFileAsync(
      ffmpeg,
      ['-i', video, '-vn', '-af', 'silencedetect=noise=-35dB:d=1.5', '-f', 'null', '-'],
      { timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (err) {
    console.error('Audio activity scan failed:', err.message);
    return { available: false, segments: [] };
  }

  const durMatch = stderr.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
  const duration = durMatch
    ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3])
    : null;
  const hasAudioStream = /Stream #.*Audio/.test(stderr);
  if (!hasAudioStream || duration === null) return { available: false, segments: [] };

  // silencedetect reports the silent stretches; sound is everything between.
  const silences = [];
  let currentStart = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start: (\d+\.?\d*)/);
    const e = line.match(/silence_end: (\d+\.?\d*)/);
    if (s) currentStart = Number(s[1]);
    if (e && currentStart !== null) {
      silences.push([currentStart, Number(e[1])]);
      currentStart = null;
    }
  }
  if (currentStart !== null) silences.push([currentStart, duration]);

  const segments = [];
  let cursor = 0;
  for (const [s, e] of silences) {
    if (s - cursor >= 1) segments.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (duration - cursor >= 1) segments.push({ start: cursor, end: duration });
  return { available: true, segments };
}

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
      if (e.type === 'left_assessment_tab') return `${t} switched to another tab in the recorded window (that tab's content is visible in the window frames)`;
      if (e.type === 'returned_to_assessment_tab') return `${t} returned to the assessment tab`;
      if (e.type === 'focus_left_window') return `${t} FOCUS LEFT THE RECORDED WINDOW — unrecorded activity (violation ${e.violation ?? '?'} of 3)`;
      if (e.type === 'focus_gained') return `${t} focus returned to the assessment`;
      if (e.type === 'ended_by_lockdown') return `${t} SESSION AUTO-SUBMITTED: too many focus violations`;
      return `${t} ${e.type}`;
    })
    .join('\n');
}

function buildUserContent({ task, attempt, frames, webcamFrames, audio, events, finalCode }) {
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

  // Interleave screen and webcam frames chronologically so the model sees
  // what was on screen and who was at the keyboard at the same moments.
  const merged = [
    ...frames.map((f) => ({ ...f, kind: 'SCREEN (recorded browser window)' })),
    ...webcamFrames.map((f) => ({ ...f, kind: 'WEBCAM (candidate-facing camera)' })),
  ].sort((a, b) => a.seconds - b.seconds || (a.kind < b.kind ? -1 : 1));

  for (const frame of merged) {
    content.push({ type: 'text', text: `${frame.kind} at ${formatClock(frame.seconds)}:` });
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
      text: '(No screen recording frames are available for this session — base your analysis on the event log and final submission only, and note the missing recording in the relevant sections.)',
    });
  }
  if (webcamFrames.length === 0) {
    content.push({
      type: 'text',
      text: '(No webcam frames are available for this session — note in the integrity section that webcam-based checks could not be performed.)',
    });
  }

  if (!audio?.available) {
    content.push({
      type: 'text',
      text: 'MICROPHONE AUDIO ACTIVITY: no usable audio track — voice checks could not be performed; say so in the integrity notes.',
    });
  } else if (audio.segments.length === 0) {
    content.push({
      type: 'text',
      text: 'MICROPHONE AUDIO ACTIVITY: the microphone was essentially silent for the entire session (no segments above the noise floor). voiceFlags should be empty.',
    });
  } else {
    content.push({
      type: 'text',
      text:
        'MICROPHONE AUDIO ACTIVITY (sound detected in these windows — you cannot hear the content; flag each as a listen-here pointer):\n' +
        audio.segments
          .map((s) => `${formatClock(s.start)}–${formatClock(s.end)} (${Math.round(s.end - s.start)}s of sound)`)
          .join('\n'),
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

function mockReport(events, finalCode, audio) {
  const pasted = events.filter((e) => e.type === 'paste').reduce((n, e) => n + (e.chars || 0), 0);
  const typed = events.filter((e) => e.type === 'typing').reduce((n, e) => n + (e.chars || 0), 0);
  const tabSwitches = events.filter((e) => e.type === 'left_assessment_tab').length;
  const violations = events.filter((e) => e.type === 'focus_left_window').length;
  const total = pasted + typed || 1;
  const aiPct = Math.min(100, Math.round((pasted / total) * 100));
  const voiceFlags = (audio?.segments || []).map((s) => ({
    at: formatClock(s.start),
    note: `Sound detected for ${Math.round(s.end - s.start)}s — listen at this moment.`,
  }));
  return {
    oneLineSummary:
      'MOCK REPORT (no LLM call was made) — set ANTHROPIC_API_KEY and unset MOCK_ANALYSIS for a real analysis.',
    completion: {
      verdict: finalCode && finalCode.trim() ? 'partial' : 'fail',
      requirementsTotal: 0,
      requirementsMet: 0,
      deliberateScopeCut: false,
      worksCorrectly: false,
      codeQuality: 5,
      required: 'Mock analysis — the brief was not evaluated.',
      delivered: finalCode && finalCode.trim() ? 'A non-empty submission was received.' : 'Empty submission.',
      reasoning: 'Mock analysis cannot judge requirements.',
      outputQuality: 'Not evaluated in mock mode.',
    },
    integrity: {
      status: voiceFlags.length > 0 || violations > 0 ? 'flagged' : 'clean',
      faceFlags: [],
      voiceFlags,
      windowBehavior: {
        tabSwitches,
        focusViolations: violations,
        unrecordedActivity: violations > 0,
        note: `Event log: ${tabSwitches} in-window tab switch(es), ${violations} focus escape(s). Frames not reviewed in mock mode.`,
      },
      notes: 'Mock analysis — webcam frames were not reviewed. Audio segments (if any) come from the real microphone scan.',
    },
    toolUsage: {
      percentOwnWork: 100 - aiPct,
      percentAiAssisted: aiPct,
      tools: [
        { name: 'Own typing/editing', kind: 'editor', minutes: 0, timesOpened: 1 },
        ...(pasted > 0 ? [{ name: 'Unknown source (pasted content)', kind: 'other', minutes: 0, timesOpened: events.filter((e) => e.type === 'paste').length }] : []),
      ],
      notes: `Estimated from the event log alone: ~${pasted} chars pasted vs ~${typed} chars typed.`,
    },
    toolPurposes: events
      .filter((e) => e.type === 'paste')
      .map((e) => ({
        at: formatClock((e.t ?? 0) / 1000),
        tool: 'Unknown source',
        purpose: `Pasted ${e.chars} characters into the editor.`,
        intent: 'accelerate',
      })),
    thinking: {
      signals: {
        modifiedAiOutputBeforeUse: false,
        caughtAiMistake: false,
        testedOwnWork: false,
        verifiedBeforeSubmit: false,
        brokeProblemDown: false,
        promptsImproved: false,
        explainedReasoning: false,
        pastedVerbatimNoTesting: false,
        noEvidenceOfUnderstanding: false,
        repeatedIdenticalPrompts: false,
        outputDiverged: false,
      },
      greenFlags: [],
      redFlags: [],
      evidence: 'Mock analysis — frames were not reviewed, so no thinking-depth evidence is available.',
    },
    timeline: [{ start: '0:00', end: '0:00', label: 'Mock analysis — timeline unavailable without LLM analysis' }],
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
  const audio = await detectAudioActivity(dir);

  let report;
  if (process.env.MOCK_ANALYSIS) {
    report = mockReport(events, finalCode, audio);
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
      messages: [{ role: 'user', content: buildUserContent({ task, attempt, frames, webcamFrames, audio, events, finalCode }) }],
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      throw new Error('The analysis model declined to process this session.');
    }
    const text = message.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error(`No text in analysis response (stop_reason: ${message.stop_reason})`);
    report = JSON.parse(text);
  }

  // The verdict is computed HERE, deterministically, from the observations —
  // never taken from the model. See scoring.js for the weights and gates.
  report.scoring = computeScoring(report, {
    durationSeconds: attempt.durationSeconds || 0,
    timeLimitMinutes: task.timeLimitMinutes,
    finalCodeEmpty: !finalCode.trim(),
    integrityReview: attempt.integrityReview?.decision || null,
  });
  report.recommendation = report.scoring.recommendation;
  if (report.thinking) {
    report.thinking.rating = thinkingRatingFromScore(report.scoring.layers.thinking.score);
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
