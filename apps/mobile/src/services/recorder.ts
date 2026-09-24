import {PermissionsAndroid, Platform} from 'react-native';
import AudioRecorderPlayer from 'react-native-audio-recorder-player';

const recorder = new AudioRecorderPlayer();

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

export function startRecording() {
  return recorder.startRecorder();
}

export function stopRecording() {
  return recorder.stopRecorder();
}
