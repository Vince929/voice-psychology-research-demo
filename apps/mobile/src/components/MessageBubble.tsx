import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import type {MessageInfo} from '../services/api';
import {colors} from './ui';

type Props = {
  message: MessageInfo;
  ttsPlaying: boolean;
  feedback: 'helpful' | 'unhelpful' | null;
  feedbackDisabled: boolean;
  onPlayTts: (message: MessageInfo) => void;
  onFeedback: (message: MessageInfo, feedback: 'helpful' | 'unhelpful') => void;
};

/** Chat bubble. Assistant bubbles offer TTS replay with the recorded profile params. */
export function MessageBubble({message, ttsPlaying, feedback, feedbackDisabled, onPlayTts, onFeedback}: Props) {
  const isUser = message.role === 'user';
  return (
    <View style={[bubbleStyles.row, isUser ? bubbleStyles.rowUser : bubbleStyles.rowAssistant]}>
      <View style={[bubbleStyles.bubble, isUser ? bubbleStyles.bubbleUser : bubbleStyles.bubbleAssistant]}>
        <Text style={isUser ? bubbleStyles.textUser : bubbleStyles.textAssistant}>{message.content}</Text>
      </View>
      <View style={bubbleStyles.actions}>
        {!isUser ? (
          <>
            <Pressable accessibilityRole="button" hitSlop={8} onPress={() => onPlayTts(message)}>
              <Text style={bubbleStyles.actionText}>{ttsPlaying ? '停止播放 ◼' : '语音播放 ▶'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={feedbackDisabled || feedback === 'helpful'}
              hitSlop={8}
              onPress={() => onFeedback(message, 'helpful')}>
              <Text style={[bubbleStyles.feedbackText, feedback === 'helpful' && bubbleStyles.feedbackSelected]}>有帮助</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={feedbackDisabled || feedback === 'unhelpful'}
              hitSlop={8}
              onPress={() => onFeedback(message, 'unhelpful')}>
              <Text style={[bubbleStyles.feedbackText, feedback === 'unhelpful' && bubbleStyles.feedbackSelected]}>无帮助</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

const bubbleStyles = StyleSheet.create({
  row: {gap: 4},
  rowUser: {alignItems: 'flex-end'},
  rowAssistant: {alignItems: 'flex-start'},
  bubble: {maxWidth: '86%', paddingHorizontal: 14, paddingVertical: 11, borderRadius: 16},
  bubbleUser: {backgroundColor: colors.primaryDark, borderBottomRightRadius: 4},
  bubbleAssistant: {backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.border, borderBottomLeftRadius: 4},
  textUser: {fontSize: 15, lineHeight: 23, color: '#FFFFFF'},
  textAssistant: {fontSize: 15, lineHeight: 23, color: colors.ink},
  actions: {flexDirection: 'row', gap: 14, paddingHorizontal: 4},
  actionText: {fontSize: 12, fontWeight: '800', color: colors.primary},
  feedbackText: {fontSize: 12, fontWeight: '700', color: colors.muted},
  feedbackSelected: {color: colors.primary, fontWeight: '800'},
});
