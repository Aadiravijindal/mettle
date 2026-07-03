import { api } from './api.js';

const CHUNK_MS = 30_000; // upload every 30s so a crash doesn't lose the session

// Sequential upload queue per stream: chunks must be appended server-side in
// order, so each upload waits for the previous one.
class ChunkUploader {
  constructor(attemptId, stream) {
    this.attemptId = attemptId;
    this.stream = stream;
    this.chain = Promise.resolve();
    this.failed = 0;
  }

  push(blob) {
    if (!blob || blob.size === 0) return;
    this.chain = this.chain.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await api.uploadChunk(this.attemptId, this.stream, blob);
          return;
        } catch (err) {
          if (attempt === 2) {
            this.failed++;
            console.error(`chunk upload failed (${this.stream}):`, err);
          } else {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
      }
    });
  }

  drain() {
    return this.chain;
  }
}

function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

// Proves the shared window is the one hosting this page: flash a solid
// magenta overlay over the page and check the color shows up in the captured
// frames. A different window (or a window on another screen) will never show
// the overlay. Fails open on environments where frames can't be sampled —
// the analysis still sees the frames and flags a wrong window.
const VERIFY_COLOR = { r: 255, g: 0, b: 255 };

async function verifySharedWindowShowsThisPage(stream) {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    `position:fixed;inset:0;z-index:2147483647;background:rgb(${VERIFY_COLOR.r},${VERIFY_COLOR.g},${VERIFY_COLOR.b})`;
  document.body.appendChild(overlay);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Poll a few frames: capture pipelines take a moment to deliver a frame
    // that includes the overlay.
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (video.videoWidth === 0) continue;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // Sample the central region — skips the window's tab strip / title bar.
      const { data } = ctx.getImageData(32, 27, 96, 54);
      let r = 0, g = 0, b = 0;
      const px = data.length / 4;
      for (let p = 0; p < data.length; p += 4) {
        r += data[p]; g += data[p + 1]; b += data[p + 2];
      }
      r /= px; g /= px; b /= px;
      const dist = Math.abs(r - VERIFY_COLOR.r) + Math.abs(g - VERIFY_COLOR.g) + Math.abs(b - VERIFY_COLOR.b);
      if (dist < 180) return true;
    }
    return false;
  } catch (err) {
    console.warn('window verification unavailable, continuing:', err);
    return true;
  } finally {
    overlay.remove();
    video.srcObject = null;
  }
}

export async function startSessionRecording({ attemptId }) {
  // Capture the entire browser WINDOW hosting the assessment — every tab the
  // candidate opens in it (AI tools, docs, search) is part of the recording.
  // monitorTypeSurfaces removes the "Entire screen" option; the surface type
  // and the specific window are verified after the picker.
  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 5, displaySurface: 'window' },
    audio: false,
    preferCurrentTab: false,
    selfBrowserSurface: 'include',
    monitorTypeSurfaces: 'exclude',
    surfaceSwitching: 'exclude',
  });
  const surface = screenStream.getVideoTracks()[0]?.getSettings().displaySurface;
  if (surface && surface !== 'window') {
    screenStream.getTracks().forEach((t) => t.stop());
    const err = new Error('You must share this browser window — pick it under "Window" in the prompt (not a tab, not your entire screen).');
    err.name = 'WrongSurfaceError';
    throw err;
  }
  const isThisWindow = await verifySharedWindowShowsThisPage(screenStream);
  if (!isThisWindow) {
    screenStream.getTracks().forEach((t) => t.stop());
    const err = new Error("The window you shared doesn't appear to be this one. Share the browser window that contains this assessment page.");
    err.name = 'WrongWindowError';
    throw err;
  }

  // Webcam + microphone are mandatory: the camera feed is analyzed for
  // integrity (candidate present, alone, looking at the screen) and the mic
  // lets the reviewer hear if someone is coaching off-screen.
  let webcamStream;
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: true,
    });
  } catch (cause) {
    screenStream.getTracks().forEach((t) => t.stop());
    const err = new Error('Camera and microphone access are required for this assessment.');
    err.name = 'WebcamRequiredError';
    err.cause = cause;
    throw err;
  }

  const mimeType = pickMimeType();
  const recorders = [];

  const screenUploader = new ChunkUploader(attemptId, 'screen');
  const screenRecorder = new MediaRecorder(screenStream, { mimeType, videoBitsPerSecond: 1_200_000 });
  screenRecorder.ondataavailable = (e) => screenUploader.push(e.data);
  screenRecorder.start(CHUNK_MS);
  recorders.push({ recorder: screenRecorder, uploader: screenUploader, mediaStream: screenStream });

  const camUploader = new ChunkUploader(attemptId, 'webcam');
  const camRecorder = new MediaRecorder(webcamStream, { mimeType, videoBitsPerSecond: 400_000 });
  camRecorder.ondataavailable = (e) => camUploader.push(e.data);
  camRecorder.start(CHUNK_MS);
  recorders.push({ recorder: camRecorder, uploader: camUploader, mediaStream: webcamStream });

  return {
    screenStream,
    webcamStream,
    // Resolves when both recorders have flushed their final chunk and all
    // uploads have completed.
    async stop() {
      await Promise.all(
        recorders.map(({ recorder, uploader, mediaStream }) => {
          return new Promise((resolve) => {
            if (recorder.state === 'inactive') return resolve();
            recorder.onstop = resolve;
            recorder.stop();
          }).then(() => {
            mediaStream.getTracks().forEach((t) => t.stop());
            return uploader.drain();
          });
        }),
      );
    },
    onScreenShareEnded(cb) {
      screenStream.getVideoTracks()[0]?.addEventListener('ended', cb);
    },
    onWebcamEnded(cb) {
      webcamStream.getVideoTracks()[0]?.addEventListener('ended', cb);
    },
  };
}
