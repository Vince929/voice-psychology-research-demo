import Tts from 'react-native-tts';

import type {TtsParams} from './api';

let initialized = false;
let engineAvailable = false;
let finishResolver: (() => void) | null = null;
let finishListenerAttached = false;

type TtsModule = {
  engines?: () => Promise<string[]>;
  voices?: () => Promise<Array<Record<string, unknown>>>;
  setDefaultLanguage: (language: string) => Promise<string>;
  setDefaultRate: (rate: number, skipSilence?: boolean) => Promise<string>;
  setDefaultPitch: (pitch: number) => Promise<string>;
  setDefaultVoice: (voiceId: string) => Promise<string>;
  speak: (utterance: string) => Promise<string>;
  stop: (onWordBoundary?: boolean) => Promise<string>;
  addEventListener: (event: string, handler: (...args: unknown[]) => void) => {remove: () => void};
};

const tts = Tts as unknown as TtsModule;

const SENTENCE_SPLIT = /[。！？!?…\n]+/;

function ensureFinishListener() {
  if (finishListenerAttached) {
    return;
  }
  finishListenerAttached = true;
  tts.addEventListener('tts-finish', () => {
    const resolve = finishResolver;
    finishResolver = null;
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
    await tts.setDefaultRate(1.0);
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

function waitForFinish(timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    finishResolver = resolve;
    setTimeout(() => {
      if (finishResolver === resolve) {
        finishResolver = null;
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
  await tts.setDefaultRate(params.rate);
  await tts.setDefaultPitch(params.pitch);

  const sentences = text.split(SENTENCE_SPLIT).filter(sentence => sentence.trim());
  const chunks = sentences.length > 0 ? sentences : [text];
  for (let index = 0; index < chunks.length; index += 1) {
    await tts.speak(chunks[index].trim());
    // Estimate a generous finish timeout, then enforce the profile's pause.
    await waitForFinish(Math.max(4000, chunks[index].length * 400));
    if (index < chunks.length - 1) {
      await waitMs(params.inter_sentence_pause_ms);
    }
  }
}

export async function stopSpeaking(): Promise<void> {
  try {
    await tts.stop(true);
  } catch {
    // Ignore stop errors when nothing is playing.
  }
  const resolve = finishResolver;
  finishResolver = null;
  resolve?.();
}
