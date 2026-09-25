import {DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform} from 'react-native';

type VoiceRecorderModule = {
  start(demoUpload: boolean): Promise<string>;
  stop(): Promise<string>;
  getFileInfo(uri: string): Promise<{uri: string; size: number}>;
  readFileChunk(uri: string, offset: number, length: number): Promise<string>;
  deleteFile(uri: string): Promise<void>;
  play(url: string): Promise<void>;
  stopPlayback(): Promise<void>;
};

const {VoiceRecorder} = NativeModules as {VoiceRecorder?: VoiceRecorderModule};

function getRecorder(): VoiceRecorderModule {
  if (!VoiceRecorder) {
    throw new Error('原生录音模块未加载。请重新构建并安装 Android 应用后重试。');
  }
  return VoiceRecorder;
}

export async function requestMicrophonePermission() {
  if (Platform.OS !== 'android') {
    return true;
  }
  const status = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    {
      title: '需要麦克风权限',
      message: '语音心理科研采集需要录制一段朗读音频。',
      buttonPositive: '允许',
      buttonNegative: '暂不允许',
    },
  );
  return status === PermissionsAndroid.RESULTS.GRANTED;
}

export function startRecording(demoUpload = false) {
  return getRecorder().start(demoUpload);
}

export function stopRecording() {
  return getRecorder().stop();
}

export function getRecordingFileInfo(uri: string) {
  return getRecorder().getFileInfo(uri);
}

export function readRecordingFileChunk(uri: string, offset: number, length: number) {
  return getRecorder().readFileChunk(uri, offset, length);
}

export function deleteRecordingFile(uri: string) {
  return getRecorder().deleteFile(uri);
}

export function playRemoteAudio(url: string) {
  return getRecorder().play(url);
}

export function stopRemoteAudio() {
  return getRecorder().stopPlayback();
}

export function subscribeToPlaybackStopped(listener: () => void) {
  const subscription = DeviceEventEmitter.addListener('VoiceRecorderPlaybackStopped', listener);
  return () => subscription.remove();
}

export function recordingErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return '未知原生录音错误';
}
