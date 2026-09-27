import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import type {StrategyRecordInfo} from '../services/api';
import {Badge, colors, ui} from './ui';

const TECHNIQUE_LABELS: Record<string, string> = {
  validation: '情绪确认',
  clarification: '澄清提问',
  grounding: '即时稳定',
  reframing: '认知整理',
  action_planning: '行动规划',
  safety_escalation: '安全分流',
};

const VOICE_PROFILE_LABELS: Record<string, string> = {
  calm_slow: '舒缓慢速',
  warm_normal: '温和常规',
  concise_direct: '简洁直接',
};

function riskTone(riskLevel: string): 'ok' | 'warn' | 'danger' {
  if (riskLevel === 'high') {
    return 'danger';
  }
  return riskLevel === 'ambiguous' ? 'warn' : 'ok';
}

function Row({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <View style={panelStyles.row}>
      <Text style={panelStyles.rowLabel}>{label}</Text>
      <View style={panelStyles.rowValue}>{children}</View>
    </View>
  );
}

/** Fixed light-weight strategy observation panel (collapsible, refreshed per turn). */
export function StrategyPanel({record}: {record: StrategyRecordInfo | null}) {
  const [expanded, setExpanded] = useState(true);
  if (!record) {
    return (
      <View style={panelStyles.card}>
        <Text style={panelStyles.title}>策略观察面板</Text>
        <Text style={ui.hint}>本轮回复产生后将在这里展示决策依据。</Text>
      </View>
    );
  }
  return (
    <View style={panelStyles.card}>
      <Pressable accessibilityRole="button" style={panelStyles.headerRow} onPress={() => setExpanded(current => !current)}>
        <Text style={panelStyles.title}>策略观察面板</Text>
        <Text style={panelStyles.toggle}>{expanded ? '收起 ▲' : '展开 ▼'}</Text>
      </Pressable>
      {expanded ? (
        <View style={{gap: 9}}>
          <View style={panelStyles.badgeRow}>
            <Badge text={`焦虑 ${record.anxiety_level}`} tone={record.anxiety_level === 'high' ? 'danger' : record.anxiety_level === 'moderate' ? 'warn' : 'ok'} />
            <Badge text={`风险 ${record.risk_level}`} tone={riskTone(record.risk_level)} />
            <Badge text={record.is_safety_escalation ? '已触发安全分流' : '无安全分流'} tone={record.is_safety_escalation ? 'danger' : 'ok'} />
            {record.risk_level === 'ambiguous' && !record.is_safety_escalation ? <Badge text="安全确认" tone="warn" /> : null}
          </View>
          <Row label="观察信号">
            {record.observed_signals.map((signal, index) => (
              <Text key={`${signal}-${index}`} style={panelStyles.signal}>· {signal}</Text>
            ))}
          </Row>
          <Row label="本轮策略">
            <Text style={panelStyles.value}>
              {TECHNIQUE_LABELS[record.technique] ?? record.technique} · 目标：{record.support_goal}
            </Text>
          </Row>
          <Row label="选择理由">
            <Text style={panelStyles.value}>{record.technique_reason}</Text>
          </Row>
          <Row label="语音档案">
            <Text style={panelStyles.value}>
              {VOICE_PROFILE_LABELS[record.voice_profile] ?? record.voice_profile}
            </Text>
          </Row>
          <Row label="TTS 参数">
            <Text style={panelStyles.value}>
              rate={record.tts_params.rate} · pitch={record.tts_params.pitch} · 停顿=
              {record.tts_params.inter_sentence_pause_ms}ms
            </Text>
          </Row>
          {record.avoided_techniques.length > 0 ? (
            <Row label="避开方法">
              {record.avoided_techniques.map(item => (
                <Text key={item.technique} style={panelStyles.value}>
                  · {TECHNIQUE_LABELS[item.technique] ?? item.technique}：{item.reason}
                </Text>
              ))}
            </Row>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const panelStyles = StyleSheet.create({
  card: {gap: 10, padding: 15, borderRadius: 16, backgroundColor: '#EEF3EF', borderWidth: 1, borderColor: '#C9D9CD'},
  headerRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  title: {fontSize: 14, fontWeight: '800', color: colors.primaryDark},
  toggle: {fontSize: 12, fontWeight: '700', color: colors.primary},
  badgeRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
  row: {gap: 3},
  rowLabel: {fontSize: 11, fontWeight: '800', color: colors.muted, letterSpacing: 0.5},
  rowValue: {gap: 2},
  signal: {fontSize: 13, lineHeight: 19, color: colors.body},
  value: {fontSize: 13, lineHeight: 19, color: colors.ink},
});
