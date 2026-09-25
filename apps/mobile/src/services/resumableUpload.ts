import AsyncStorage from '@react-native-async-storage/async-storage';

import {getApiBaseUrl} from '../config/api';
import {Subject} from './api';
import {deleteRecordingFile, getRecordingFileInfo, readRecordingFileChunk} from './recorder';

const DRAFTS_STORAGE_KEY = '@voice-psychology/upload-drafts/v1';
// Tencent COS requires every multipart part except the last one to be at least 1 MiB.
const STANDARD_PART_SIZE_BYTES = 1024 * 1024;
const DEMO_PART_SIZE_BYTES = STANDARD_PART_SIZE_BYTES;
const DEMO_PART_DELAY_MS = 3000;

let demoUploadModeEnabled = false;

export function setDemoUploadMode(enabled: boolean) {
  demoUploadModeEnabled = enabled;
}

export function isDemoUploadModeEnabled() {
  return demoUploadModeEnabled;
}

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
  partSizeBytes?: number;
  isDemoUpload?: boolean;
  apiBaseUrl?: string;
  createdAt: string;
};

export type UploadDraftProgress = UploadDraft & {
  uploadedBytes: number;
  uploadedPartCount: number;
  partCount: number;
  uploading: boolean;
};

type UploadProgressListener = () => void;

const uploadProgressListeners = new Set<UploadProgressListener>();
const activeUploadKeys = new Set<string>();

function notifyUploadProgress() {
  uploadProgressListeners.forEach(listener => listener());
}

export function subscribeToUploadProgress(listener: UploadProgressListener) {
  uploadProgressListeners.add(listener);
  return () => uploadProgressListeners.delete(listener);
}

function delay(milliseconds: number) {
  return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

function draftPartSizeBytes(draft: UploadDraft) {
  return draft.partSizeBytes || STANDARD_PART_SIZE_BYTES;
}

export function uploadErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) {
    return error;
  }
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return '发生未知错误，请检查应用调试日志和服务端日志。';
}

function base64ToBytes(value: string) {
  const binary = global.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function request<T>(path: string, init: RequestInit, apiBaseUrl = getApiBaseUrl()): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
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

async function createOrLoadSession(draft: UploadDraft, restartMultipartUpload: boolean): Promise<UploadSessionResponse> {
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
      restart_multipart_upload: restartMultipartUpload,
    }),
  }, draft.apiBaseUrl);
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
    partSizeBytes: demoUploadModeEnabled ? DEMO_PART_SIZE_BYTES : STANDARD_PART_SIZE_BYTES,
    isDemoUpload: demoUploadModeEnabled,
    apiBaseUrl: getApiBaseUrl(),
    createdAt: new Date().toISOString(),
  };
  await saveDraft(draft);
  return draft;
}

function toDraftProgress(draft: UploadDraft, session?: UploadSessionResponse): UploadDraftProgress {
  const uploadedParts = session?.uploaded_parts || [];
  return {
    ...draft,
    uploadedBytes: uploadedParts.reduce((total, part) => total + part.size, 0),
    uploadedPartCount: uploadedParts.length,
    partCount: Math.ceil(draft.totalBytes / draftPartSizeBytes(draft)),
    uploading: activeUploadKeys.has(draft.idempotencyKey),
  };
}

export async function getPendingUploadDrafts(): Promise<UploadDraftProgress[]> {
  const drafts = await loadDrafts();
  return Promise.all(drafts.map(async draft => {
    const session = draft.uploadId
      ? await request<UploadSessionResponse>(`/upload-sessions/${draft.uploadId}`, {method: 'GET'}, draft.apiBaseUrl).catch(() => undefined)
      : undefined;
    return toDraftProgress(draft, session);
  }));
}

export async function resumeUpload(draft: UploadDraft): Promise<CompleteUploadResponse> {
  activeUploadKeys.add(draft.idempotencyKey);
  notifyUploadProgress();
  try {
    const fileInfo = await getRecordingFileInfo(draft.localUri);
    if (Math.trunc(fileInfo.size) !== draft.totalBytes) {
      throw new Error('本地录音文件已变更，请重新录音后再试。');
    }
    const restartMultipartUpload = draftPartSizeBytes(draft) < STANDARD_PART_SIZE_BYTES;
    if (restartMultipartUpload) {
      // Old demo drafts used 128 KiB parts, which COS rejects for non-final parts.
      // Start a clean multipart session with the valid part size instead of leaving it stuck.
      draft.partSizeBytes = STANDARD_PART_SIZE_BYTES;
    }
    const session = await createOrLoadSession(draft, restartMultipartUpload);
    draft.uploadId = session.upload_id;
    await saveDraft(draft);
    notifyUploadProgress();

    if (session.status === 'completed' && session.record_id) {
      await finalizeLocalDraft(draft);
      return {record_id: session.record_id};
    }

    const uploadedPartNumbers = new Set(session.uploaded_parts.map(part => part.part_number));
    const partSizeBytes = draftPartSizeBytes(draft);
    const partCount = Math.ceil(draft.totalBytes / partSizeBytes);
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      if (uploadedPartNumbers.has(partNumber)) {
        continue;
      }
      const offset = (partNumber - 1) * partSizeBytes;
      const length = Math.min(partSizeBytes, draft.totalBytes - offset);
      const encodedChunk = await readRecordingFileChunk(draft.localUri, offset, length);
      const chunk = base64ToBytes(encodedChunk);
      await request<UploadSessionResponse>(`/upload-sessions/${session.upload_id}/parts/${partNumber}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/octet-stream'},
        body: chunk as unknown as BodyInit,
      }, draft.apiBaseUrl);
      notifyUploadProgress();
      if (draft.isDemoUpload) {
        await delay(DEMO_PART_DELAY_MS);
      }
    }

    const completed = await request<CompleteUploadResponse>(`/upload-sessions/${session.upload_id}/complete`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({part_count: partCount}),
    }, draft.apiBaseUrl);
    await finalizeLocalDraft(draft);
    return completed;
  } catch (error) {
    console.error('[resumable-upload] Failed to resume upload', {
      idempotencyKey: draft.idempotencyKey,
      uploadId: draft.uploadId,
      error,
    });
    throw error;
  } finally {
    activeUploadKeys.delete(draft.idempotencyKey);
    notifyUploadProgress();
  }
}

export async function resumePendingUploads() {
  const drafts = await loadDrafts();
  // Demo drafts deliberately remain paused after an app restart for interruption demonstrations.
  const autoResumableDrafts = drafts.filter(draft => !draft.isDemoUpload);
  const results = await Promise.allSettled(autoResumableDrafts.map(draft => resumeUpload(draft)));
  return results.filter((result): result is PromiseFulfilledResult<CompleteUploadResponse> => result.status === 'fulfilled').map(result => result.value);
}
