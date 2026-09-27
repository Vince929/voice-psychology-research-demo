import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';

import {API_BASE_URL} from '../config/api';

const AUTH_STORAGE_KEY = '@agent/auth-token';

export type ExpressionPreference = 'gentle' | 'concise';

export type VoiceProfileName = 'calm_slow' | 'warm_normal' | 'concise_direct';

export type TtsParams = {
  voice_profile: string;
  rate: number;
  pitch: number;
  inter_sentence_pause_ms: number;
  override_applied?: boolean;
};

export type StrategyRecordInfo = {
  id: number;
  message_id: number;
  anxiety_level: 'low' | 'moderate' | 'high' | 'uncertain';
  risk_level: 'normal' | 'ambiguous' | 'high';
  observed_signals: string[];
  support_goal: string;
  technique: string;
  technique_reason: string;
  response_constraints: {max_sentences: number; ask_one_question_only: boolean};
  voice_profile: string;
  tts_params: TtsParams;
  avoided_techniques: Array<{technique: string; reason: string}>;
  is_safety_escalation: boolean;
  source: 'rule' | 'llm';
  feedback: 'helpful' | 'unhelpful' | null;
};

export type MessageInfo = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  audio_url: string | null;
  asr_features: unknown;
  strategy_record: StrategyRecordInfo | null;
};

export type SessionSummaryPayload = {
  main_concern: string;
  key_feelings: string[];
  techniques_used: string[];
  rejected_methods: string[];
  agreed_next_step: string;
  risk_level: 'normal' | 'ambiguous' | 'high';
  safety_escalation_triggered: boolean;
  disclaimer: string;
};

export type SessionInfo = {
  id: number;
  concern: string;
  expression_preference: ExpressionPreference;
  voice_reply_enabled: boolean;
  voice_profile_override: VoiceProfileName | null;
  status: 'active' | 'ended';
  max_risk_level: string;
  safety_triggered: boolean;
  rejected_techniques: string[];
  summary: SessionSummaryPayload | null;
  created_at: string;
  ended_at: string | null;
};

export type SessionDetail = SessionInfo & {
  messages: MessageInfo[];
  strategy_records: StrategyRecordInfo[];
};

export type TurnResult = {
  user_message: MessageInfo;
  assistant_message: MessageInfo;
  strategy_record: StrategyRecordInfo;
};

const client = axios.create({baseURL: API_BASE_URL, timeout: 180000});

/** Debug logging: request path/params and response status/data. Toggle via setApiDebugLogging. */
const LOG_TAG = '[api]';
let apiDebugLogging = true;

// Toggle to silence request/response logging in release builds.
export function setApiDebugLogging(enabled: boolean) {
  apiDebugLogging = enabled;
}

client.interceptors.request.use(config => {
  const method = (config.method ?? 'get').toUpperCase();
  console.log(`${LOG_TAG} --> ${method} ${config.url}`, config.params ?? config.data ?? '');
  return config;
});

client.interceptors.response.use(
  response => {
    console.log(`${LOG_TAG} <-- ${response.status} ${response.config.method?.toUpperCase()} ${response.config.url}`, response.data);
    return response;
  },
  error => {
    if (axios.isAxiosError(error)) {
      console.warn(
        `${LOG_TAG} <-- ${error.response?.status ?? 'network'} ${error.config?.method?.toUpperCase()} ${error.config?.url}`,
        error.response?.data ?? error.message,
      );
    }
    return Promise.reject(error);
  },
);

let authToken = '';

function authHeaders(): Record<string, string> {
  return authToken ? {Authorization: `Bearer ${authToken}`} : {};
}

export function setAuthToken(token: string) {
  authToken = token;
}

export async function loadStoredToken(): Promise<string> {
  const stored = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
  if (stored) {
    authToken = stored;
  }
  return authToken;
}

export async function persistToken(token: string) {
  authToken = token;
  await AsyncStorage.setItem(AUTH_STORAGE_KEY, token);
}

export async function clearToken() {
  authToken = '';
  await AsyncStorage.removeItem(AUTH_STORAGE_KEY);
}

export function extractErrorDetail(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const detail = (error.response?.data as {detail?: unknown} | undefined)?.detail;
    if (typeof detail === 'string' && detail) {
      return detail;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

export async function checkApiHealth(): Promise<boolean> {
  try {
    const response = await client.get('/health', {timeout: 8000});
    return Boolean(response.data?.ok);
  } catch {
    return false;
  }
}

export async function login(username: string, password: string): Promise<string> {
  const response = await client.post<{token: string; username: string}>(
    '/auth/login',
    {username, password},
    {timeout: 20000},
  );
  await persistToken(response.data.token);
  return response.data.username;
}

export async function logout() {
  try {
    await client.post('/auth/logout', undefined, {headers: authHeaders(), timeout: 8000});
  } catch {
    // Stateless JWT: local clearing is authoritative.
  }
  await clearToken();
}

export async function verifyToken(): Promise<{id: number; username: string} | null> {
  try {
    const response = await client.get<{id: number; username: string}>('/auth/me', {
      headers: authHeaders(),
      timeout: 10000,
    });
    return response.data;
  } catch {
    await clearToken();
    return null;
  }
}

export async function createSession(
  concern: string,
  expressionPreference: ExpressionPreference,
  voiceReplyEnabled: boolean,
): Promise<SessionInfo> {
  const response = await client.post<SessionInfo>(
    '/sessions',
    {
      concern,
      expression_preference: expressionPreference,
      voice_reply_enabled: voiceReplyEnabled,
    },
    {headers: authHeaders()},
  );
  return response.data;
}

export async function listSessions(): Promise<SessionInfo[]> {
  const response = await client.get<SessionInfo[]>('/sessions', {headers: authHeaders()});
  return response.data;
}

export async function getSession(sessionId: number): Promise<SessionDetail> {
  const response = await client.get<SessionDetail>(`/sessions/${sessionId}`, {headers: authHeaders()});
  return response.data;
}

export async function sendTextMessage(sessionId: number, text: string): Promise<TurnResult> {
  const response = await client.post<TurnResult>(
    `/sessions/${sessionId}/messages`,
    {text},
    {headers: authHeaders()},
  );
  return response.data;
}

export async function sendVoiceMessage(sessionId: number, audioUri: string): Promise<TurnResult> {
  const form = new FormData();
  form.append('audio', {
    uri: audioUri,
    type: 'audio/mp4',
    name: 'voice-message.m4a',
  } as never);
  const response = await client.post<TurnResult>(`/sessions/${sessionId}/messages`, form, {
    headers: {...authHeaders(), 'Content-Type': 'multipart/form-data'},
  });
  return response.data;
}

export type StreamCallbacks = {
  /** Called for each incremental fragment of the assistant reply. */
  onDelta: (text: string) => void;
  /** Called when previously streamed fragments are invalidated (regenerating). */
  onReset: () => void;
};

type StreamEvent =
  | {type: 'delta'; text: string}
  | {type: 'reset'; reason?: string}
  | {type: 'result'; result: TurnResult}
  | {type: 'error'; detail?: string; stage?: string; retryable?: boolean};

/**
 * Consumes the server's SSE stream over XHR. React Native's fetch cannot read
 * response chunks incrementally, but its XHR implementation exposes partial
 * `responseText` through `onprogress` when responseType is 'text' (the same
 * mechanism event-source libraries rely on). Resolves with the final turn
 * result once the `result` event arrives.
 */
function streamTurnRequest(
  path: string,
  body: string | FormData,
  callbacks: StreamCallbacks,
): Promise<TurnResult> {
  return new Promise<TurnResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}${path}`);
    if (authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
    }
    if (typeof body === 'string') {
      xhr.setRequestHeader('Content-Type', 'application/json');
    }
    // For FormData RN derives the multipart boundary itself; setting the
    // header manually would omit it.
    xhr.responseType = 'text';
    xhr.timeout = 180000;

    let consumedLength = 0;
    let buffer = '';
    let finalResult: TurnResult | null = null;
    let failureMessage: string | null = null;

    const handleEvent = (event: StreamEvent) => {
      if (event.type === 'delta') {
        callbacks.onDelta(event.text);
      } else if (event.type === 'reset') {
        callbacks.onReset();
      } else if (event.type === 'result') {
        finalResult = event.result;
      } else if (event.type === 'error') {
        failureMessage = event.detail || 'AI 服务返回异常，请稍后重试。';
      }
    };

    const consumeChunk = (chunk: string) => {
      buffer += chunk;
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (!payload) {
            continue;
          }
          try {
            handleEvent(JSON.parse(payload) as StreamEvent);
          } catch {
            // Ignore malformed / keep-alive lines.
          }
        }
      }
    };

    const drain = () => {
      const full = xhr.responseText || '';
      if (full.length > consumedLength) {
        consumeChunk(full.slice(consumedLength));
        consumedLength = full.length;
      }
    };

    xhr.onprogress = drain;

    xhr.onload = () => {
      drain();
      if (failureMessage) {
        reject(new Error(failureMessage));
        return;
      }
      if (xhr.status === 200 && finalResult) {
        resolve(finalResult);
        return;
      }
      if (xhr.status !== 200) {
        const full = xhr.responseText || '';
        try {
          const parsed = JSON.parse(full) as {detail?: unknown};
          if (typeof parsed.detail === 'string' && parsed.detail) {
            reject(new Error(parsed.detail));
            return;
          }
        } catch {
          // Fall through to the generic message.
        }
        reject(new Error(`请求失败（HTTP ${xhr.status}）。`));
        return;
      }
      reject(new Error('连接中断，回复未完成，请稍后重试。'));
    };
    xhr.onerror = () => reject(new Error('网络连接失败，请稍后重试。'));
    xhr.ontimeout = () => reject(new Error('请求超时，请稍后重试。'));

    if (apiDebugLogging) {
      const bodyDesc = typeof body === 'string' ? body : '[FormData audio]';
      console.log(`${LOG_TAG} --> POST ${path}`, bodyDesc);
      const originalOnLoad = xhr.onload as ((...args: never[]) => void) | null;
      xhr.onload = (...args: never[]) => {
        console.log(`${LOG_TAG} <-- ${xhr.status} POST ${path}`, xhr.responseText?.slice(0, 500));
        originalOnLoad?.(...args);
      };
    }

    xhr.send(body);
  });
}

export function streamTextMessage(
  sessionId: number,
  text: string,
  callbacks: StreamCallbacks,
): Promise<TurnResult> {
  return streamTurnRequest(`/sessions/${sessionId}/messages/stream`, JSON.stringify({text}), callbacks);
}

export type AudioUploadSource = {
  uri: string;
  name: string;
  type: string;
};

export function streamAudioMessage(
  sessionId: number,
  source: AudioUploadSource,
  callbacks: StreamCallbacks,
): Promise<TurnResult> {
  const form = new FormData();
  form.append('audio', source as never);
  return streamTurnRequest(`/sessions/${sessionId}/messages/stream`, form, callbacks);
}

export function streamVoiceMessage(
  sessionId: number,
  audioUri: string,
  callbacks: StreamCallbacks,
): Promise<TurnResult> {
  return streamAudioMessage(
    sessionId,
    {uri: audioUri, type: 'audio/mp4', name: 'voice-message.m4a'},
    callbacks,
  );
}

export async function endSession(sessionId: number): Promise<SessionSummaryPayload> {
  const response = await client.post<{summary: SessionSummaryPayload; idempotent: boolean}>(
    `/sessions/${sessionId}/end`,
    undefined,
    {headers: authHeaders()},
  );
  return response.data.summary;
}

export async function deleteSession(sessionId: number): Promise<void> {
await client.delete(`/sessions/${sessionId}`, {headers: authHeaders()});
}

export async function submitReplyFeedback(
  messageId: number,
  feedback: 'helpful' | 'unhelpful',
): Promise<{message_id: number; feedback: 'helpful' | 'unhelpful'; technique_blocked: boolean}> {
  const response = await client.patch(`/messages/${messageId}/feedback`, {feedback}, {headers: authHeaders()});
  return response.data;
}

export async function updateSessionPreferences(
  sessionId: number,
  voiceProfileOverride: VoiceProfileName | null,
): Promise<SessionInfo> {
  const response = await client.patch<SessionInfo>(
    `/sessions/${sessionId}/preferences`,
    {voice_profile_override: voiceProfileOverride},
    {headers: authHeaders()},
  );
  return response.data;
}

export function getAudioUrl(messageId: number): string {
  return `${API_BASE_URL}/messages/${messageId}/audio?token=${encodeURIComponent(authToken)}`;
}
