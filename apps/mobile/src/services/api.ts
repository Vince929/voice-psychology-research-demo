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

const client = axios.create({baseURL: API_BASE_URL, timeout: 15000});

export async function checkApiHealth() {
  return client.get('/health');
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
