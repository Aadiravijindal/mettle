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

export async function startSessionRecording({ attemptId, withWebcam }) {
  // Screen capture is required — it is the work product being assessed.
  // preferCurrentTab defaults candidates to sharing just this tab; they can
  // still choose a window or the full screen from the browser picker.
  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 5 },
    audio: false,
    preferCurrentTab: false,
    selfBrowserSurface: 'include',
  });

  let webcamStream = null;
  if (withWebcam) {
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240 },
        audio: false,
      });
    } catch (err) {
      console.warn('Webcam unavailable, continuing without it:', err);
    }
  }

  const mimeType = pickMimeType();
  const recorders = [];

  const screenUploader = new ChunkUploader(attemptId, 'screen');
  const screenRecorder = new MediaRecorder(screenStream, { mimeType, videoBitsPerSecond: 1_200_000 });
  screenRecorder.ondataavailable = (e) => screenUploader.push(e.data);
  screenRecorder.start(CHUNK_MS);
  recorders.push({ recorder: screenRecorder, uploader: screenUploader, mediaStream: screenStream });

  if (webcamStream) {
    const camUploader = new ChunkUploader(attemptId, 'webcam');
    const camRecorder = new MediaRecorder(webcamStream, { mimeType, videoBitsPerSecond: 250_000 });
    camRecorder.ondataavailable = (e) => camUploader.push(e.data);
    camRecorder.start(CHUNK_MS);
    recorders.push({ recorder: camRecorder, uploader: camUploader, mediaStream: webcamStream });
  }

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
  };
}
