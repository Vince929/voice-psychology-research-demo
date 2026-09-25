import axios from 'axios';

import {API_BASE_URL} from '../config/api';

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

const client = axios.create({baseURL: API_BASE_URL, timeout: 15000});

export async function checkApiHealth() {
  return client.get('/health');
}

export async function listRecords(): Promise<RecordSummary[]> {
  const response = await client.get<RecordSummary[]>('/records');
  return response.data;
}

export async function getRecord(recordId: number): Promise<CollectionRecord> {
  const response = await client.get<CollectionRecord>(`/records/${recordId}`);
  return response.data;
}

export async function deleteRecord(recordId: number) {
  await client.delete(`/records/${recordId}`);
}

export async function deleteSubjectRecords(subjectId: string) {
  const response = await client.delete<{deleted_count: number}>(`/subjects/${encodeURIComponent(subjectId)}`);
  return response.data;
}

export async function retryAnalysis(recordId: number) {
  const response = await client.post<{record_id: number; task: AnalysisTask}>(`/records/${recordId}/analysis/retry`);
  return response.data;
}

export async function cancelAnalysis(recordId: number) {
  const response = await client.post<{record_id: number; task: AnalysisTask}>(`/records/${recordId}/analysis/cancel`);
  return response.data;
}

export function getAudioUrl(recordId: number) {
  return `${API_BASE_URL}/records/${recordId}/audio`;
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
    headers: {'Content-Type': 'multipart/form-data'},
  });
  return response.data;
}
