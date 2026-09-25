import AsyncStorage from '@react-native-async-storage/async-storage';

import {API_BASE_URL} from '../config/api';
import {Subject} from './api';
import {deleteRecordingFile, getRecordingFileInfo, readRecordingFileChunk} from './recorder';

const DRAFTS_STORAGE_KEY = '@voice-psychology/upload-drafts/v1';
const PART_SIZE_BYTES = 1024 * 1024;

type UploadedPart = {part_number: number; etag: string; size: number};

type UploadSessionResponse = {
  upload_id: string;
  status: 'uploading' | 'completed';
  total_bytes: number;
  uploaded_parts: UploadedPart[];
  record_id: number | null;
};

type CompleteUploadResponse = {record_id: number};

export type UploadDraft = {
  uploadId?: string;
  localUri: string;
  subject: Subject;
  idempotencyKey: string;
  audioFilename: string;
  audioContentType: string;
  totalBytes: number;
};

function base64ToBytes(value: string) {
  const binary = global.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {detail?: unknown} | null;
    const detail = typeof payload?.detail === 'string' ? payload.detail : null;
    throw new Error(detail || `录音上传请求失败（HTTP ${response.status}）。`);
  }
  return response.json() as Promise<T>;
}

async function loadDrafts(): Promise<UploadDraft[]> {
  const value = await AsyncStorage.getItem(DRAFTS_STORAGE_KEY);
  return value ? JSON.parse(value) as UploadDraft[] : [];
}

async function saveDrafts(drafts: UploadDraft[]) {
  await AsyncStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
}

async function saveDraft(draft: UploadDraft) {
  const drafts = await loadDrafts();
  const nextDrafts = [...drafts.filter(item => item.idempotencyKey !== draft.idempotencyKey), draft];
  await saveDrafts(nextDrafts);
}

async function removeDraft(idempotencyKey: string) {
  const drafts = await loadDrafts();
  await saveDrafts(drafts.filter(draft => draft.idempotencyKey !== idempotencyKey));
}

async function finalizeLocalDraft(draft: UploadDraft) {
  await removeDraft(draft.idempotencyKey);
  try {
    await deleteRecordingFile(draft.localUri);
  } catch {
    // The completed server-side record remains valid even if local cleanup is delayed.
  }
}

async function createOrLoadSession(draft: UploadDraft): Promise<UploadSessionResponse> {
  return request<UploadSessionResponse>('/upload-sessions', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      upload_id: draft.uploadId,
      subject: draft.subject,
      idempotency_key: draft.idempotencyKey,
      audio_filename: draft.audioFilename,
      audio_content_type: draft.audioContentType,
      total_bytes: draft.totalBytes,
    }),
  });
}

export async function createUploadDraft(subject: Subject, localUri: string, idempotencyKey: string): Promise<UploadDraft> {
  const info = await getRecordingFileInfo(localUri);
  const draft = {
    localUri: info.uri,
    subject,
    idempotencyKey,
    audioFilename: 'voice-sample.m4a',
    audioContentType: 'audio/mp4',
    totalBytes: Math.trunc(info.size),
  };
  await saveDraft(draft);
  return draft;
}

export async function resumeUpload(draft: UploadDraft): Promise<CompleteUploadResponse> {
  const fileInfo = await getRecordingFileInfo(draft.localUri);
  if (Math.trunc(fileInfo.size) !== draft.totalBytes) {
    throw new Error('本地录音文件已变更，请重新录音后再试。');
  }
  const session = await createOrLoadSession(draft);
  draft.uploadId = session.upload_id;
  await saveDraft(draft);

  if (session.status === 'completed' && session.record_id) {
    await finalizeLocalDraft(draft);
    return {record_id: session.record_id};
  }

  const uploadedPartNumbers = new Set(session.uploaded_parts.map(part => part.part_number));
  const partCount = Math.ceil(draft.totalBytes / PART_SIZE_BYTES);
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    if (uploadedPartNumbers.has(partNumber)) {
      continue;
    }
    const offset = (partNumber - 1) * PART_SIZE_BYTES;
    const length = Math.min(PART_SIZE_BYTES, draft.totalBytes - offset);
    const encodedChunk = await readRecordingFileChunk(draft.localUri, offset, length);
    const chunk = base64ToBytes(encodedChunk);
    await request<UploadSessionResponse>(`/upload-sessions/${session.upload_id}/parts/${partNumber}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/octet-stream'},
      body: chunk as unknown as BodyInit,
    });
  }

  const completed = await request<CompleteUploadResponse>(`/upload-sessions/${session.upload_id}/complete`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({part_count: partCount}),
  });
  await finalizeLocalDraft(draft);
  return completed;
}

export async function resumePendingUploads() {
  const drafts = await loadDrafts();
  const results = await Promise.allSettled(drafts.map(draft => resumeUpload(draft)));
  return results.filter((result): result is PromiseFulfilledResult<CompleteUploadResponse> => result.status === 'fulfilled').map(result => result.value);
}
