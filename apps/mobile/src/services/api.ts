import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';

import {API_BASE_URL} from '../config/api';

const AUTH_STORAGE_KEY = '@agent/auth-token';

export type ExpressionPreference = 'gentle' | 'concise';

export type TtsParams = {
  voice_profile: string;
  rate: number;
  pitch: number;
  inter_sentence_pause_ms: number;
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

export function getAudioUrl(messageId: number): string {
  return `${API_BASE_URL}/messages/${messageId}/audio?token=${encodeURIComponent(authToken)}`;
}
