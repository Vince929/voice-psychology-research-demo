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
import type {ScrollViewInstance} from 'react-native';
import DocumentPicker, {types as pickerTypes} from 'react-native-document-picker';

import {MessageBubble} from '../components/MessageBubble';
import {StrategyPanel} from '../components/StrategyPanel';
import {colors, ui} from '../components/ui';
import type {
  MessageInfo,
  SessionDetail,
  StrategyRecordInfo,
  TtsParams,
  TurnResult,
  VoiceProfileName,
} from '../services/api';
import {
  endSession,
  extractErrorDetail,
  getSession,
  streamAudioMessage,
  streamTextMessage,
  streamVoiceMessage,
  submitReplyFeedback,
  updateSessionPreferences,
} from '../services/api';
import {
  recordingErrorMessage,
  requestMicrophonePermission,
  startRecording,
  stopRecording,
} from '../services/recorder';
import {initTtsEngine, speakWithProfile, stopSpeaking} from '../services/tts';

const FALLBACK_TTS_PARAMS: TtsParams = {
  voice_profile: 'warm_normal',
  rate: 1.0,
  pitch: 1.0,
  inter_sentence_pause_ms: 400,
};

const VOICE_STYLE_CHOICES: Array<{label: string; value: VoiceProfileName | null}> = [
  {label: '自动', value: null},
  {label: '舒缓慢速', value: 'calm_slow'},
  {label: '温和正常', value: 'warm_normal'},
  {label: '简洁明快', value: 'concise_direct'},
];

/** Parameters used only after replay priority checks allow the user's choice. */
const REPLAY_TTS_PARAMS: Record<VoiceProfileName, TtsParams> = {
  calm_slow: {voice_profile: 'calm_slow', rate: 0.7, pitch: 0.9, inter_sentence_pause_ms: 800},
  warm_normal: {voice_profile: 'warm_normal', rate: 1.0, pitch: 1.0, inter_sentence_pause_ms: 400},
  concise_direct: {voice_profile: 'concise_direct', rate: 1.15, pitch: 1.0, inter_sentence_pause_ms: 200},
};

function replayParamsFor(message: MessageInfo, userChoice: VoiceProfileName | null | undefined): TtsParams {
  const record = message.strategy_record;
  const recordedParams = record?.tts_params ?? FALLBACK_TTS_PARAMS;
  // Keep the same priority as the server: safety requirement > current state
  // (captured on this reply's strategy record) > user preference > default.
  if (
    record?.is_safety_escalation ||
    record?.risk_level === 'high' ||
    record?.risk_level === 'ambiguous' ||
    record?.anxiety_level === 'high'
  ) {
    return REPLAY_TTS_PARAMS.calm_slow;
  }
  return userChoice ? REPLAY_TTS_PARAMS[userChoice] : recordedParams;
}

// Android `height` mode: lower values lift the entire bottom dock further above
// the IME. Tune this per device if the input row is still partially obscured.
const ANDROID_KEYBOARD_VERTICAL_OFFSET = 0;

export function ChatScreen({
  sessionId,
  active,
  onEnded,
  onOpenSummary,
  onNotice,
}: {
  sessionId: number;
  /** 页面保活导航：false = 当前被隐藏（用户在别的页），不拉数据、不播放语音 */
  active: boolean;
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
  const [ending, setEnding] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [savingStyle, setSavingStyle] = useState(false);
  const [feedbackSavingId, setFeedbackSavingId] = useState<number | null>(null);
  const scrollRef = useRef<ScrollViewInstance>(null);
  // Typewriter pump: LLM deltas land in the buffer, a timer releases them at
  // a readable pace (accelerating when the backlog grows so we never fall
  // too far behind the stream).
  const streamBufferRef = useRef('');
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recorderActiveRef = useRef(false);
  const stopRequestedRef = useRef(false);

  const didInitialScroll = useRef(false);
  useEffect(() => {
    if (!active) {
      // 被隐藏（导航离开但保持挂载）：上一次激活的 cleanup 已停掉 TTS/播放，无需拉取。
      return;
    }
    let cancelled = false;
    // 重新进入同一会话时重拉详情（状态可能已变，如已结束）并滚回最新消息。
    didInitialScroll.current = false;
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
      .catch(err => {
        if (!cancelled) {
          onNotice(`加载会话失败：${extractErrorDetail(err)}`, 'error');
        }
      });
    void initTtsEngine().then(available => {
      if (!available) {
        onNotice('当前设备缺少中文语音合成引擎，语音播放不可用。', 'error');
      }
    });
    return () => {
      cancelled = true;
      void stopSpeaking();
    };
  }, [sessionId, active, onNotice]);

  useEffect(() => {
    if (didInitialScroll.current || messages.length === 0) {
      return;
    }
    didInitialScroll.current = true;
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({animated: false}));
  }, [messages]);

  // Keep the growing streamed bubble pinned to the bottom while typing out.
  useEffect(() => {
    if (!streamingText) {
      return;
    }
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({animated: false}));
  }, [streamingText]);

  // Never leak the typewriter timer across unmounts / session switches.
  useEffect(() => {
    return () => stopStreamPump();
  }, []);

  function startStreamPump() {
    if (streamTimerRef.current !== null) {
      return;
    }
    streamTimerRef.current = setInterval(() => {
      const buffer = streamBufferRef.current;
      if (!buffer) {
        return;
      }
      // Base pace ~1 char per 30ms; release more per tick when backlogged
      // so the display catches up instead of lagging behind the LLM.
      const take = Math.max(1, Math.ceil(buffer.length / 12));
      streamBufferRef.current = buffer.slice(take);
      setStreamingText(current => current + buffer.slice(0, take));
    }, 30);
  }

  function stopStreamPump() {
    if (streamTimerRef.current !== null) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamBufferRef.current = '';
  }

  function enqueueStreamChunk(chunk: string) {
    streamBufferRef.current += chunk;
    startStreamPump();
  }

  function resetStreamDisplay() {
    stopStreamPump();
    setStreamingText('');
  }

  const applyTurn = useCallback(
    (result: TurnResult) => {
      setMessages(current => [
        ...current,
        {...result.user_message, audio_url: result.user_message.audio_url ?? null},
        // Attach the strategy record so manual replay (playTts without params)
        // reads the same tts_params as the initial auto-play; getSession later
        // returns the same shape from _session_detail.
        {...result.assistant_message, strategy_record: result.strategy_record},
      ]);
      setLatestRecord(result.strategy_record);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({animated: true}));

      // 隐藏期间完成的轮次不自动播语音，避免人在列表页时突然出声。
      const autoPlay = active && detail?.voice_reply_enabled === true;
      if (autoPlay) {
        void playTts(result.assistant_message, result.strategy_record.tts_params);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, detail?.voice_reply_enabled],
  );

  async function playTts(message: MessageInfo, params?: TtsParams) {
    if (ttsPlayingId === message.id) {
      await stopSpeaking();
      setTtsPlayingId(null);
      return;
    }
    await stopSpeaking();
    setTtsPlayingId(message.id);
  // Auto-play passes the server-resolved params explicitly. Manual replay
  // recomputes through the same priority order rather than letting the UI
  // override a safety or high-anxiety reply.
  const ttsParams = params ?? replayParamsFor(message, detail?.voice_profile_override);
  try {
    await speakWithProfile(message.content, ttsParams);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : '语音播放失败。', 'error');
    } finally {
      setTtsPlayingId(current => (current === message.id ? null : current));
    }
  }

  function appendPendingUserMessage(text: string) {
    const pendingId = -Date.now();
    setMessages(current => [
      ...current,
      {id: pendingId, role: 'user', content: text, audio_url: null, asr_features: null, strategy_record: null},
    ]);
    setAwaitingReply(true);
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({animated: true}));
    return pendingId;
  }

  function removePendingUserMessage(pendingId: number) {
    setMessages(current => current.filter(message => message.id !== pendingId));
    setAwaitingReply(false);
  }

  async function sendText() {
    const text = inputText.trim();
    if (!text || sending) {
      return;
    }
    setSending(true);
    setInputText('');
    setStreamingText('');
    const pendingId = appendPendingUserMessage(text);
    try {
      const result = await streamTextMessage(sessionId, text, {
        onDelta: enqueueStreamChunk,
        onReset: resetStreamDisplay,
      });
      removePendingUserMessage(pendingId);
      applyTurn(result);
    } catch (err) {
      removePendingUserMessage(pendingId);
      const message = extractErrorDetail(err);
      setInputText(text);
      onNotice(`发送失败：${message}`, 'error');
    } finally {
      stopStreamPump();
      setStreamingText('');
      setSending(false);
    }
  }

  async function startVoiceRecording() {
    if (sending || recorderActiveRef.current) {
      return;
    }
    if (!await requestMicrophonePermission()) {
      onNotice('需要麦克风权限后才能录音，请在系统设置中开启。', 'error');
      return;
    }
    // Mark the recorder as active before the async native start resolves:
    // MediaRecorder.prepare() takes a moment, and the user may already have
    // released the button by then (see finishVoiceRecording).
    recorderActiveRef.current = true;
    stopRequestedRef.current = false;
    try {
      await startRecording(false);
      setRecording(true);
      if (stopRequestedRef.current) {
        // The user released before the recorder warmed up: stop and discard.
        await stopRecording().catch(() => undefined);
        recorderActiveRef.current = false;
        setRecording(false);
      }
    } catch (err) {
      recorderActiveRef.current = false;
      setRecording(false);
      onNotice(`录音未启动：${recordingErrorMessage(err)}`, 'error');
    }
  }

  async function finishVoiceRecording() {
    if (!recorderActiveRef.current) {
      return;
    }
    stopRequestedRef.current = true;
    if (!recording) {
      // Native start still in flight; startVoiceRecording will stop and
      // discard the clip itself as soon as it resolves.
      return;
    }
    setRecording(false);
    setSending(true);
    setStreamingText('');
    const pendingId = appendPendingUserMessage('语音消息（识别中…）');
    try {
      const audioUri = await stopRecording();
      recorderActiveRef.current = false;
      const result = await streamVoiceMessage(sessionId, audioUri, {
        onDelta: enqueueStreamChunk,
        onReset: resetStreamDisplay,
      });
      removePendingUserMessage(pendingId);
      applyTurn(result);
    } catch (err) {
      removePendingUserMessage(pendingId);
      const message = extractErrorDetail(err);
      onNotice(`语音消息发送失败：${message}`, 'error');
    } finally {
      recorderActiveRef.current = false;
      stopStreamPump();
      setStreamingText('');
      setSending(false);
    }
  }

  async function rateReply(message: MessageInfo, feedback: 'helpful' | 'unhelpful') {
    if (feedbackSavingId !== null || !message.strategy_record) {
      return;
    }
    setFeedbackSavingId(message.id);
    try {
      const result = await submitReplyFeedback(message.id, feedback);
      setMessages(current => current.map(item =>
        item.id === message.id && item.strategy_record
          ? {...item, strategy_record: {...item.strategy_record, feedback: result.feedback}}
          : item,
      ));
      if (feedback === 'unhelpful') {
        onNotice(
          result.technique_blocked
            ? '已记录为无帮助，后续对话将避免使用这类支持方式。'
            : '已记录为无帮助。',
          'info',
        );
      } else {
        onNotice('已记录为有帮助，感谢你的反馈。', 'success');
      }
    } catch (err) {
      onNotice(`提交反馈失败：${extractErrorDetail(err)}`, 'error');
    } finally {
      setFeedbackSavingId(null);
    }
  }

  /** Formats the server-side ASR pipeline can transcribe (m4a/aac). */
  const SUPPORTED_AUDIO_EXTENSIONS = ['.m4a', '.aac'];

  async function pickAudioAndSend() {
    if (sending || recording) {
      return;
    }
    let file: {uri: string; name?: string | null; type?: string | null} | undefined;
    try {
      const picked = await DocumentPicker.pick({
        type: [pickerTypes.audio],
        allowMultiSelection: false,
      });
      file = picked[0];
    } catch (err) {
      if (DocumentPicker.isCancel(err)) {
        return; // user closed the picker
      }
      onNotice('选择音频文件失败，请重试。', 'error');
      return;
    }
    const name = file.name ?? '';
    const extensionIndex = name.lastIndexOf('.');
    const extension = extensionIndex >= 0 ? name.slice(extensionIndex).toLowerCase() : '';
    if (!SUPPORTED_AUDIO_EXTENSIONS.includes(extension)) {
      onNotice(`仅支持 M4A / AAC 格式的音频文件，当前文件：${name || '未知文件名'}。`, 'error');
      return;
    }
    const mimeType = extension === '.m4a' ? 'audio/mp4' : 'audio/aac';

    setSending(true);
    setStreamingText('');
    const pendingId = appendPendingUserMessage('语音消息（识别中…）');
    try {
      const result = await streamAudioMessage(
        sessionId,
        {uri: file.uri, name: name || 'upload' + extension, type: mimeType},
        {
          onDelta: enqueueStreamChunk,
          onReset: resetStreamDisplay,
        },
      );
      removePendingUserMessage(pendingId);
      applyTurn(result);
    } catch (err) {
      removePendingUserMessage(pendingId);
      const message = extractErrorDetail(err);
      onNotice(`语音消息发送失败：${message}`, 'error');
    } finally {
      stopStreamPump();
      setStreamingText('');
      setSending(false);
    }
  }

  async function chooseVoiceStyle(value: VoiceProfileName | null) {
    if (savingStyle || detail?.voice_profile_override === value) {
      return;
    }
    setSavingStyle(true);
    try {
      const updated = await updateSessionPreferences(sessionId, value);
      setDetail(current =>
        current ? {...current, voice_profile_override: updated.voice_profile_override} : current,
      );
      onNotice('语音风格已更新，下一轮回复生效。', 'success');
    } catch (err) {
      onNotice(extractErrorDetail(err), 'error');
    } finally {
      setSavingStyle(false);
    }
  }

  async function end() {
    if (ending) {
      return;
    }
    setEnding(true);
    try {
      await stopSpeaking();
      await endSession(sessionId);
      onEnded(sessionId);
    } catch (err) {
      onNotice(`结束会话失败：${extractErrorDetail(err)}`, 'error');
    } finally {
      setEnding(false);
    }
  }

  const isActive = detail?.status === 'active';

  return (
    <KeyboardAvoidingView
      style={ui.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'android' ? ANDROID_KEYBOARD_VERTICAL_OFFSET : 0}>
      <ScrollView ref={scrollRef} contentContainerStyle={chatStyles.content} keyboardShouldPersistTaps="handled">
        <StrategyPanel record={latestRecord} />
        <View style={{gap: 12}}>
          {messages.map(message => (
            <MessageBubble
              key={message.id}
              message={message}
              ttsPlaying={ttsPlayingId === message.id}
              feedback={message.strategy_record?.feedback ?? null}
              feedbackDisabled={feedbackSavingId !== null}
              onPlayTts={target => void playTts(target)}
              onFeedback={(target, feedback) => void rateReply(target, feedback)}
            />
          ))}
          {awaitingReply ? (
            <View style={chatStyles.pendingRow}>
              <View style={chatStyles.pendingBubble}>
                {streamingText ? (
                  <Text style={chatStyles.streamingText}>{streamingText}▍</Text>
                ) : (
                  <Text style={chatStyles.pendingText}>回复中…</Text>
                )}
              </View>
            </View>
          ) : null}
          {messages.length === 0 && !awaitingReply ? <Text style={ui.hint}>说点什么开始这次对话吧。</Text> : null}
        </View>
      </ScrollView>
      {isActive ? (
        <View style={chatStyles.dock}>
          <View style={chatStyles.styleRow}>
            <Text style={chatStyles.styleLabel}>语音风格</Text>
            <View style={ui.choiceGroup}>
              {VOICE_STYLE_CHOICES.map(choice => {
                const active = detail?.voice_profile_override === choice.value;
                return (
                  <Pressable
                    key={choice.label}
                    accessibilityRole="button"
                    disabled={savingStyle}
                    style={({pressed}) => [chatStyles.styleChip, active && chatStyles.styleChipActive, pressed && ui.pressed]}
                    onPress={() => void chooseVoiceStyle(choice.value)}>
                    <Text style={[chatStyles.styleChipText, active && chatStyles.styleChipTextActive]}>
                      {choice.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <View style={chatStyles.inputRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={sending ? '正在发送语音消息' : recording ? '结束录音并发送' : '开始录音'}
            disabled={sending}
            style={({pressed}) => [chatStyles.micButton, (recording || pressed) && chatStyles.micButtonActive]}
            // Tap once to start and tap again to stop. Using press-in/out made
            // a normal first tap start and stop the recorder in one gesture.
            onPress={() => void (recorderActiveRef.current ? finishVoiceRecording() : startVoiceRecording())}>
            <Text style={chatStyles.micText}>{sending ? '…' : recording ? '⏺' : '🎤'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="上传音频文件"
            disabled={sending}
            style={({pressed}) => [chatStyles.uploadButton, pressed && ui.pressed]}
            onPress={() => void pickAudioAndSend()}>
            <Text style={chatStyles.uploadText}>{sending ? '…' : '📎'}</Text>
          </Pressable>
            <TextInput
              style={chatStyles.input}
              value={inputText}
              onChangeText={setInputText}
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
  pendingRow: {alignItems: 'flex-start'},
  pendingBubble: {paddingHorizontal: 14, paddingVertical: 11, borderRadius: 16, borderBottomLeftRadius: 4, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.border},
  pendingText: {fontSize: 15, lineHeight: 23, color: colors.muted, fontWeight: '600'},
  streamingText: {fontSize: 15, lineHeight: 23, color: colors.ink},
  dock: {gap: 8, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12, backgroundColor: '#F6F2EA', borderTopWidth: 1, borderTopColor: '#DFE1D8', elevation: 10},
  styleRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  styleLabel: {fontSize: 12, fontWeight: '800', color: '#465E56'},
  styleChip: {paddingVertical: 6, paddingHorizontal: 10, borderRadius: 99, borderWidth: 1, borderColor: '#D9DFD6', backgroundColor: '#FBFBF6'},
  styleChipActive: {backgroundColor: colors.primaryDark, borderColor: colors.primaryDark},
  styleChipText: {color: '#4C625B', fontSize: 12, fontWeight: '600'},
  styleChipTextActive: {color: '#FFFFFF', fontWeight: '800'},
  endedDock: {gap: 8, alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 18, backgroundColor: '#F6F2EA', borderTopWidth: 1, borderTopColor: '#DFE1D8'},
  inputRow: {flexDirection: 'row', alignItems: 'flex-end', gap: 8},
  micButton: {width: 38, height: 38, borderRadius: 19, backgroundColor: colors.primaryDark, alignItems: 'center', justifyContent: 'center'},
  micButtonActive: {backgroundColor: colors.danger},
  micText: {fontSize: 15, color: '#FFFFFF'},
  uploadButton: {width: 38, height: 38, borderRadius: 19, backgroundColor: colors.primaryDark, alignItems: 'center', justifyContent: 'center'},
  uploadText: {fontSize: 15, color: '#FFFFFF'},
  input: {flex: 1, minHeight: 38, maxHeight: 120, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15, color: colors.ink, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.border},
  sendButton: {minWidth: 56, minHeight: 38, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10},
  sendButtonDisabled: {backgroundColor: '#C6C7BD'},
  sendText: {color: '#FFFFFF', fontWeight: '800', fontSize: 14},
  endButton: {minHeight: 42, borderRadius: 12, borderWidth: 1, borderColor: '#BFD4C8', backgroundColor: '#F8FBF8', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16},
  endText: {fontSize: 14, fontWeight: '800', color: colors.primary},
});
