import React, {useState} from 'react';
import {ScrollView, Text, View} from 'react-native';

import type {ExpressionPreference, SessionInfo} from '../services/api';
import {createSession, extractErrorDetail} from '../services/api';
import {Choice, Field, PrimaryButton, ui} from '../components/ui';

const CONCERN_CHOICES = ['工作压力', '学习压力', '人际关系', '健康担忧', '睡眠问题', '其他'];

export function NewSessionScreen({onCreated}: {onCreated: (session: SessionInfo) => void}) {
  const [concern, setConcern] = useState(CONCERN_CHOICES[0]);
  const [customConcern, setCustomConcern] = useState('');
  const [expressionPreference, setExpressionPreference] = useState<ExpressionPreference>('gentle');
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (submitting) {
      return;
    }
    const finalConcern = customConcern.trim() ? customConcern.trim() : concern;
    if (!finalConcern) {
      setError('请先选择或填写主要困扰。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const session = await createSession(finalConcern, expressionPreference, voiceReplyEnabled);
      onCreated(session);
    } catch (err) {
      setError(extractErrorDetail(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={ui.content}>
      <View style={{gap: 8}}>
        <Text style={ui.heading}>创建会话</Text>
        <Text style={ui.body}>这些偏好会随会话保存，并影响每一轮的回复方式。</Text>
      </View>
      <View style={ui.card}>
        <Choice label="当前主要困扰" value={concern} choices={CONCERN_CHOICES} onChange={setConcern} />
        <Field label="或自行描述" value={customConcern} onChangeText={setCustomConcern} placeholder="填写后将优先使用" />
        <Choice
          label="期望的表达方式"
          value={expressionPreference === 'concise' ? '简洁直接' : '温和陪伴'}
          choices={['温和陪伴', '简洁直接']}
          onChange={value => setExpressionPreference(value === '简洁直接' ? 'concise' : 'gentle')}
        />
        <Choice
          label="是否自动播放语音回复"
          value={voiceReplyEnabled ? '自动播放' : '手动播放'}
          choices={['自动播放', '手动播放']}
          onChange={value => setVoiceReplyEnabled(value === '自动播放')}
        />
        {error ? <Text style={ui.errorText}>{error}</Text> : null}
      </View>
      <PrimaryButton label={submitting ? '创建中…' : '开始会话'} disabled={submitting} onPress={() => void submit()} />
    </ScrollView>
  );
}
