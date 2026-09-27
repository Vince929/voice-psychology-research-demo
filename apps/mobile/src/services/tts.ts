import Tts from 'react-native-tts';

import type {TtsParams} from './api';

let initialized = false;
let engineAvailable = false;
let finishResolver: (() => void) | null = null;
let finishUtteranceId: string | null = null;
let finishListenerAttached = false;
/** Bumped on every stop, so an in-flight speakWithProfile loop can abort. */
let playbackGeneration = 0;

type TtsModule = {
  engines?: () => Promise<string[]>;
  voices?: () => Promise<Array<Record<string, unknown>>>;
  setDefaultLanguage: (language: string) => Promise<string>;
  setDefaultRate: (rate: number, skipTransform?: boolean) => Promise<string>;
  setDefaultPitch: (pitch: number) => Promise<string>;
  setDefaultVoice: (voiceId: string) => Promise<string>;
  speak: (utterance: string) => Promise<string>;
  stop: (onWordBoundary?: boolean) => Promise<string>;
  addEventListener: (event: string, handler: (...args: unknown[]) => void) => {remove: () => void};
};

const tts = Tts as unknown as TtsModule;

/**
 * Global rate calibration, applied on top of the server-provided rate with
 * Android's native speech-rate semantics (skipTransform=true): 1.0 = engine
 * normal pace, 0.6 = 60% speed. react-native-tts WITHOUT skipTransform maps
 * JS 1.0 to Android setSpeechRate(3.0), which made everything 3x fast.
 */
const RATE_CALIBRATION = 1.0;

/**
 * The native tts-finish event passes an {utteranceId} object (see
 * TextToSpeechModule.sendEvent), not a bare string. Extract the id from
 * either shape; return null when it cannot be determined.
 */
function extractUtteranceId(args: unknown[]): string | null {
  const first = args.length > 0 ? args[0] : null;
  if (first != null && typeof first === 'object' && first != null && 'utteranceId' in (first as Record<string, unknown>)) {
    const value = (first as Record<string, unknown>).utteranceId;
    return value == null ? null : String(value);
  }
  if (typeof first === 'string' || typeof first === 'number') {
    return String(first);
  }
  return null;
}

const SENTENCE_SPLIT = /[。！？!?…\n]+/;

function ensureFinishListener() {
  if (finishListenerAttached) {
    return;
  }
  finishListenerAttached = true;
  tts.addEventListener('tts-finish', (...args: unknown[]) => {
    const utteranceId = extractUtteranceId(args);
    // Ignore stale finish events from a previous utterance when ids are known.
    if (finishUtteranceId !== null && utteranceId !== null && utteranceId !== finishUtteranceId) {
      return;
    }
    const resolve = finishResolver;
    finishResolver = null;
    finishUtteranceId = null;
    resolve?.();
  });
}

/** Check the Android system TTS engine once and configure Chinese output. */
export async function initTtsEngine(): Promise<boolean> {
  if (initialized) {
    return engineAvailable;
  }
  initialized = true;
  try {
    await tts.setDefaultLanguage('zh-CN');
    // skipTransform=true: use Android's native rate semantics (1.0 = normal).
    await tts.setDefaultRate(1.0, true);
    await tts.setDefaultPitch(1.0);
    engineAvailable = true;
  } catch {
    engineAvailable = false;
  }
  ensureFinishListener();
  return engineAvailable;
}

export async function ttsEngineAvailable(): Promise<boolean> {
  return initTtsEngine();
}

function waitForFinish(utteranceId: string | null, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    finishUtteranceId = utteranceId;
    finishResolver = resolve;
    setTimeout(() => {
      if (finishResolver === resolve) {
        finishResolver = null;
        finishUtteranceId = null;
      }
      resolve();
    }, timeoutMs);
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Speak the reply sentence by sentence with the profile's real rate/pitch and
 * inter-sentence pause, so different voice profiles are audibly different.
 */
export async function speakWithProfile(text: string, params: TtsParams): Promise<void> {
  if (!(await initTtsEngine())) {
    throw new Error('当前设备没有可用的中文语音合成引擎，无法播放语音回复。');
  }
  // skipTransform=true keeps Android native semantics; without it the library
  // maps JS 1.0 -> setSpeechRate(3.0) and everything plays 3x fast.
  await tts.setDefaultRate(params.rate * RATE_CALIBRATION, true);
  await tts.setDefaultPitch(params.pitch);

  const sentences = text.split(SENTENCE_SPLIT).filter(sentence => sentence.trim());
  const chunks = sentences.length > 0 ? sentences : [text];
  // Scale the per-char duration estimate by the real (calibrated) rate, so the
  // finish timeout does not fire while the engine is still speaking.
  const effectiveRate = Math.max(params.rate * RATE_CALIBRATION, 0.1);
  const generation = playbackGeneration;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index].trim();
    const utteranceId = await tts.speak(chunk);
    if (playbackGeneration !== generation) {
      return; // stopped while awaiting the engine
    }
    // Estimate a generous finish timeout, then enforce the profile's pause.
    await waitForFinish(utteranceId != null ? String(utteranceId) : null, Math.max(6000, chunk.length * 400 * 1.3 / effectiveRate));
    if (playbackGeneration !== generation) {
      return; // stopped while this sentence was playing
    }
    if (index < chunks.length - 1) {
      await waitMs(params.inter_sentence_pause_ms);
      if (playbackGeneration !== generation) {
        return; // stopped during the inter-sentence pause
      }
    }
  }
}

export async function stopSpeaking(): Promise<void> {
  playbackGeneration += 1;
  try {
    await tts.stop(true);
  } catch {
    // Ignore stop errors when nothing is playing.
  }
  const resolve = finishResolver;
  finishResolver = null;
  finishUtteranceId = null;
  resolve?.();
}
