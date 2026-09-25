import axios from 'axios';

import {getApiBaseUrl} from '../config/api';

export type Subject = {
  subject_id: string;
  age_group: string;
  gender: string;
  language: string;
  recording_environment: string;
};

export type AnalysisStatus = 'pending' | 'transcribing' | 'analyzing' | 'completed' | 'failed' | 'cancelled';

export type AnalysisTask = {
  id: number;
  status: AnalysisStatus;
  attempt_count: number;
  max_attempts: number;
  failed_stage: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type RecordSummary = {
  id: number;
  subject_id: string;
  emotion_keywords: string[];
  created_at: string;
  task: AnalysisTask | null;
};

export type AsrSentence = {
  text: string;
  start_time: number;
  end_time: number;
  speech_speed?: number;
  emotional_energy?: number;
};

export type AsrResult = {
  audio_duration?: number;
  flash_result?: Array<{text: string; sentence_list?: AsrSentence[]}>;
};

export type AudioFeatures = {
  metric: 'short_term_loudness_dbfs';
  window_ms: number;
  duration_ms: number;
  summary: {
    average_dbfs: number;
    peak_dbfs: number;
    dynamic_range_db: number;
  };
  volume_trend: Array<{
    time_ms: number;
    loudness_dbfs: number;
  }>;
  pitch_summary?: {
    voiced_frame_count: number;
    average_hz: number | null;
    range_hz: number | null;
  };
  pitch_trend?: Array<{
    time_ms: number;
    pitch_hz: number | null;
  }>;
};

export type AnalysisResult = {
  expression_state: string;
  vitality_score: number;
  tension_score: number;
  emotion_dimensions?: {
    valence: string;
    arousal: string;
    stability: string;
  };
  emotion_keywords?: string[];
  audio_features?: AudioFeatures;
  evidence: string[];
  summary: string;
  suggestion: string;
  disclaimer: string;
};

export type CollectionRecord = RecordSummary & {
  age_group: string | null;
  gender: string | null;
  language: string | null;
  recording_environment: string | null;
  transcript: string | null;
  asr_result: AsrResult | null;
  analysis_result: AnalysisResult | null;
};

const client = axios.create({timeout: 15000});

function requestConfig() {
  return {baseURL: getApiBaseUrl()};
}

export async function checkApiHealth() {
  return client.get('/health', requestConfig());
}

export async function listRecords(): Promise<RecordSummary[]> {
  const response = await client.get<RecordSummary[]>('/records', requestConfig());
  return response.data;
}

export async function getRecord(recordId: number): Promise<CollectionRecord> {
  const response = await client.get<CollectionRecord>(`/records/${recordId}`, requestConfig());
  return response.data;
}

export async function deleteRecord(recordId: number) {
  await client.delete(`/records/${recordId}`, requestConfig());
}

export async function deleteSubjectRecords(subjectId: string) {
  const response = await client.delete<{deleted_count: number}>(`/subjects/${encodeURIComponent(subjectId)}`, requestConfig());
  return response.data;
}

export async function retryAnalysis(recordId: number) {
  const response = await client.post<{record_id: number; task: AnalysisTask}>(`/records/${recordId}/analysis/retry`, undefined, requestConfig());
  return response.data;
}

export async function cancelAnalysis(recordId: number) {
  const response = await client.post<{record_id: number; task: AnalysisTask}>(`/records/${recordId}/analysis/cancel`, undefined, requestConfig());
  return response.data;
}

export function getAudioUrl(recordId: number) {
  return `${getApiBaseUrl()}/records/${recordId}/audio`;
}

export async function submitRecord(subject: Subject, audioUri: string, idempotencyKey: string) {
  const form = new FormData();
  form.append('subject', JSON.stringify(subject));
  form.append('idempotency_key', idempotencyKey);
  form.append('audio', {
    uri: audioUri,
    type: 'audio/mp4',
    name: 'voice-sample.m4a',
  } as never);
  const response = await client.post<{record_id: number; task: AnalysisTask; idempotent: boolean}>('/records', form, {
    ...requestConfig(),
    headers: {'Content-Type': 'multipart/form-data'},
  });
  return response.data;
}
