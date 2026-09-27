import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {MessageBubble} from '../components/MessageBubble';
import {StrategyPanel} from '../components/StrategyPanel';
import {colors, ui} from '../components/ui';
import type {MessageInfo, SessionDetail, StrategyRecordInfo, TtsParams, TurnResult} from '../services/api';
import {
  endSession,
  extractErrorDetail,
  getAudioUrl,
  getSession,
  sendTextMessage,
  sendVoiceMessage,
} from '../services/api';
import {
  recordingErrorMessage,
  requestMicrophonePermission,
  startRecording,
  stopRecording,
  stopRemoteAudio,
  playRemoteAudio,
} from '../services/recorder';
import {initTtsEngine, speakWithProfile, stopSpeaking} from '../services/tts';

const FALLBACK_TTS_PARAMS: TtsParams = {
  voice_profile: 'warm_normal',
  rate: 1.0,
  pitch: 1.0,
  inter_sentence_pause_ms: 400,
};

export function ChatScreen({
  sessionId,
  onEnded,
  onOpenSummary,
  onNotice,
}: {
  sessionId: number;
  onEnded: (sessionId: number) => void;
  onOpenSummary: (sessionId: number) => void;
  onNotice: (message: string, tone?: 'success' | 'error' | 'info') => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [messages, setMessages] = useState<MessageInfo[]>([]);
  const [latestRecord, setLatestRecord] = useState<StrategyRecordInfo | null>(null);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [ttsPlayingId, setTtsPlayingId] = useState<number | null>(null);
  const [audioPlayingId, setAudioPlayingId] = useState<number | null>(null);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    let cancelled = false;
    void getSession(sessionId)
      .then(data => {
        if (cancelled) {
          return;
        }
        setDetail(data);
        setMessages(data.messages);
        const lastRecord = data.strategy_records[data.strategy_records.length - 1] ?? null;
        setLatestRecord(lastRecord);
      })
      .catch(err => setError(extractErrorDetail(err)));
    void initTtsEngine().then(available => {
      if (!available) {
        onNotice('当前设备缺少中文语音合成引擎，语音播放不可用。', 'error');
      }
    });
    return () => {
      cancelled = true;
      void stopSpeaking();
      void stopRemoteAudio();
    };
  }, [sessionId, onNotice]);

  const applyTurn = useCallback(
    (result: TurnResult) => {
      setMessages(current => [
        ...current,
        {...result.user_message, audio_url: result.user_message.audio_url ?? null},
        result.assistant_message,
      ]);
      setLatestRecord(result.strategy_record);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({animated: true}));

      const autoPlay = detail?.voice_reply_enabled === true;
      if (autoPlay) {
        void playTts(result.assistant_message, result.strategy_record.tts_params);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail?.voice_reply_enabled],
  );

  async function playTts(message: MessageInfo, params?: TtsParams) {
    if (ttsPlayingId === message.id) {
      await stopSpeaking();
      setTtsPlayingId(null);
      return;
    }
    await stopSpeaking();
    setTtsPlayingId(message.id);
    const ttsParams = params ?? message.strategy_record?.tts_params ?? FALLBACK_TTS_PARAMS;
    try {
      await speakWithProfile(message.content, ttsParams);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : '语音播放失败。', 'error');
    } finally {
      setTtsPlayingId(current => (current === message.id ? null : current));
    }
  }

  async function playUserAudio(message: MessageInfo) {
    if (!message.audio_url) {
      return;
    }
    if (audioPlayingId === message.id) {
      await stopRemoteAudio();
      setAudioPlayingId(null);
      return;
    }
    await stopRemoteAudio();
    setAudioPlayingId(message.id);
    try {
      await playRemoteAudio(getAudioUrl(message.id));
    } catch (err) {
      onNotice(recordingErrorMessage(err), 'error');
    } finally {
      setAudioPlayingId(null);
    }
  }

  async function sendText() {
    const text = inputText.trim();
    if (!text || sending) {
      return;
    }
    setSending(true);
    setError('');
    setInputText('');
    try {
      const result = await sendTextMessage(sessionId, text);
      applyTurn(result);
    } catch (err) {
      setError(extractErrorDetail(err));
      setInputText(text);
    } finally {
      setSending(false);
    }
  }

  async function startVoiceRecording() {
    if (sending || recording) {
      return;
    }
    setError('');
    if (!await requestMicrophonePermission()) {
      onNotice('需要麦克风权限后才能录音，请在系统设置中开启。', 'error');
      return;
    }
    try {
      await startRecording(false);
      setRecording(true);
    } catch (err) {
      setRecording(false);
      onNotice(`录音未启动：${recordingErrorMessage(err)}`, 'error');
    }
  }

  async function finishVoiceRecording() {
    if (!recording) {
      return;
    }
    setRecording(false);
    setSending(true);
    try {
      const audioUri = await stopRecording();
      const result = await sendVoiceMessage(sessionId, audioUri);
      applyTurn(result);
    } catch (err) {
      setError(extractErrorDetail(err));
    } finally {
      setSending(false);
    }
  }

  async function end() {
    if (ending) {
      return;
    }
    setEnding(true);
    setError('');
    try {
      await stopSpeaking();
      await endSession(sessionId);
      onEnded(sessionId);
    } catch (err) {
      setError(extractErrorDetail(err));
    } finally {
      setEnding(false);
    }
  }

  const isActive = detail?.status === 'active';

  return (
    <KeyboardAvoidingView style={ui.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView ref={scrollRef} contentContainerStyle={chatStyles.content} keyboardShouldPersistTaps="handled">
        <StrategyPanel record={latestRecord} />
        {error ? <Text style={ui.errorText}>{error}</Text> : null}
        <View style={{gap: 12}}>
          {messages.map(message => (
            <MessageBubble
              key={message.id}
              message={message}
              ttsPlaying={ttsPlayingId === message.id}
              audioPlayingId={audioPlayingId}
              onPlayTts={target => void playTts(target)}
              onPlayAudio={target => void playUserAudio(target)}
            />
          ))}
          {messages.length === 0 && !error ? <Text style={ui.hint}>说点什么开始这次对话吧。</Text> : null}
        </View>
      </ScrollView>
      {isActive ? (
        <View style={chatStyles.dock}>
          <View style={chatStyles.inputRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={recording ? '结束录音并发送' : '按住录音'}
              style={({pressed}) => [chatStyles.micButton, (recording || pressed) && chatStyles.micButtonActive]}
              onPressIn={() => void startVoiceRecording()}
              onPressOut={() => void finishVoiceRecording()}>
              <Text style={chatStyles.micText}>{recording ? '⏺' : '🎤'}</Text>
            </Pressable>
            <TextInput
              style={chatStyles.input}
              value={inputText}
              onChangeText={setInputText}
              placeholder={recording ? '录音中，松开发送…' : '输入文字，或按住麦克风录音'}
              placeholderTextColor={colors.muted}
              multiline
              editable={!sending}
            />
            <Pressable
              accessibilityRole="button"
              disabled={sending || !inputText.trim()}
              style={({pressed}) => [chatStyles.sendButton, (sending || !inputText.trim()) && chatStyles.sendButtonDisabled, pressed && ui.pressed]}
              onPress={() => void sendText()}>
              <Text style={chatStyles.sendText}>{sending ? '…' : '发送'}</Text>
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={ending}
            style={({pressed}) => [chatStyles.endButton, pressed && ui.pressed]}
            onPress={() => void end()}>
            <Text style={chatStyles.endText}>{ending ? '正在生成总结…' : '结束会话并生成总结'}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={chatStyles.endedDock}>
          <Text style={ui.hint}>该会话已结束，仅可查看记录。</Text>
          <Pressable
            accessibilityRole="button"
            style={({pressed}) => [chatStyles.endButton, pressed && ui.pressed]}
            onPress={() => onOpenSummary(sessionId)}>
            <Text style={chatStyles.endText}>查看会话总结</Text>
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const chatStyles = StyleSheet.create({
  content: {paddingHorizontal: 20, paddingTop: 18, paddingBottom: 24, gap: 12},
  dock: {gap: 8, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12, backgroundColor: '#F6F2EA', borderTopWidth: 1, borderTopColor: '#DFE1D8', elevation: 10},
  endedDock: {gap: 8, alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 18, backgroundColor: '#F6F2EA', borderTopWidth: 1, borderTopColor: '#DFE1D8'},
  inputRow: {flexDirection: 'row', alignItems: 'flex-end', gap: 8},
  micButton: {width: 46, height: 46, borderRadius: 23, backgroundColor: colors.primaryDark, alignItems: 'center', justifyContent: 'center'},
  micButtonActive: {backgroundColor: colors.danger},
  micText: {fontSize: 18, color: '#FFFFFF'},
  input: {flex: 1, minHeight: 46, maxHeight: 120, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 12, fontSize: 15, color: colors.ink, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.border},
  sendButton: {minWidth: 64, minHeight: 46, borderRadius: 14, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10},
  sendButtonDisabled: {backgroundColor: '#C6C7BD'},
  sendText: {color: '#FFFFFF', fontWeight: '800'},
  endButton: {minHeight: 42, borderRadius: 12, borderWidth: 1, borderColor: '#BFD4C8', backgroundColor: '#F8FBF8', alignItems: 'center', justifyContent: 'center'},
  endText: {fontSize: 14, fontWeight: '800', color: colors.primary},
});
