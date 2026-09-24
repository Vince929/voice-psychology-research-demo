import axios from 'axios';

import {API_BASE_URL} from '../config/api';

export type Subject = {
  subject_id: string;
  age_group: string;
  gender: string;
};

export type RecordPayload = {
  subject: Subject;
  phq9: Record<string, number>;
  mbti: Record<string, string>;
};

export type RecordSummary = {
  id: number;
  subject_id: string;
  phq9_total: number;
  created_at: string;
};

export type CollectionRecord = RecordSummary & {
  age_group: string | null;
  gender: string | null;
  phq9_answers: Record<string, number>;
  mbti_answers: Record<string, string>;
  analysis_result: unknown;
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
  const response = await client.get<CollectionRecord>(`/record/${recordId}`);
  return response.data;
}

export async function deleteRecord(recordId: number) {
  await client.delete(`/record/${recordId}`);
}

export async function deleteSubjectRecords(subjectId: string) {
  const response = await client.delete<{deleted_count: number}>(`/subject/${encodeURIComponent(subjectId)}`);
  return response.data;
}

export function getAudioUrl(recordId: number) {
  return `${API_BASE_URL}/audio/${recordId}`;
}

export async function submitRecord(payload: RecordPayload, audioUri: string) {
  const form = new FormData();
  form.append('subject', JSON.stringify(payload.subject));
  form.append('phq9', JSON.stringify(payload.phq9));
  form.append('mbti', JSON.stringify(payload.mbti));
  form.append('audio', {
    uri: audioUri,
    type: 'audio/aac',
    name: 'voice-sample.aac',
  } as never);
  return client.post('/submit_record', form, {
    headers: {'Content-Type': 'multipart/form-data'},
  });
}
