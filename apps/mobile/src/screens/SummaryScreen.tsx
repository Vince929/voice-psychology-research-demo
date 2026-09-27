import React, {useEffect, useState} from 'react';
import {ScrollView, Text, View} from 'react-native';

import type {SessionDetail} from '../services/api';
import {extractErrorDetail, getSession} from '../services/api';
import {Badge, PrimaryButton, SecondaryButton, ui} from '../components/ui';
import {colors} from '../components/ui';

function SummaryRow({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <View style={{gap: 4}}>
      <Text style={{fontSize: 12, fontWeight: '800', color: colors.muted, letterSpacing: 0.5}}>{label}</Text>
      <View style={{gap: 3}}>{children}</View>
    </View>
  );
}

export function SummaryScreen({sessionId, onBack, onOpenChat}: {sessionId: number; onBack: () => void; onOpenChat: (sessionId: number) => void}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getSession(sessionId)
      .then(data => {
        if (!cancelled) {
          setDetail(data);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(extractErrorDetail(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const summary = detail?.summary ?? null;

  return (
    <ScrollView contentContainerStyle={ui.content}>
      <View style={{gap: 8}}>
        <Text style={ui.heading}>会话总结</Text>
        <Text style={ui.body}>总结仅引用会话中真实出现过的表达与确认过的行动。</Text>
      </View>
      {error ? <Text style={ui.errorText}>{error}</Text> : null}
      {!detail && !error ? <Text style={ui.hint}>加载中…</Text> : null}
      {detail && !summary ? <Text style={ui.errorText}>该会话尚未生成总结。</Text> : null}
      {summary ? (
        <View style={[ui.card, {gap: 14}]}>
          <SummaryRow label="本次主要困扰">
            <Text style={{fontSize: 15, color: colors.ink}}>{summary.main_concern}</Text>
          </SummaryRow>
          <SummaryRow label="关键感受">
            {summary.key_feelings.map((item, index) => (
              <Text key={`${item}-${index}`} style={{fontSize: 14, lineHeight: 21, color: colors.body}}>· {item}</Text>
            ))}
          </SummaryRow>
          <SummaryRow label="采用过的支持策略">
            {summary.techniques_used.length > 0 ? (
              summary.techniques_used.map((item, index) => (
                <Text key={`${item}-${index}`} style={{fontSize: 14, lineHeight: 21, color: colors.body}}>· {item}</Text>
              ))
            ) : (
              <Text style={ui.hint}>无</Text>
            )}
          </SummaryRow>
          <SummaryRow label="用户拒绝的方法">
            {summary.rejected_methods.length > 0 ? (
              summary.rejected_methods.map((item, index) => (
                <Text key={`${item}-${index}`} style={{fontSize: 14, lineHeight: 21, color: colors.body}}>· {item}</Text>
              ))
            ) : (
              <Text style={ui.hint}>无</Text>
            )}
          </SummaryRow>
          <SummaryRow label="下一步行动">
            <Text style={{fontSize: 14, lineHeight: 21, color: colors.ink}}>{summary.agreed_next_step}</Text>
          </SummaryRow>
          <View style={{flexDirection: 'row', gap: 6, flexWrap: 'wrap'}}>
            <Badge
              text={`会话风险 ${summary.risk_level}`}
              tone={summary.risk_level === 'high' ? 'danger' : summary.risk_level === 'ambiguous' ? 'warn' : 'ok'}
            />
            <Badge
              text={summary.safety_escalation_triggered ? '触发过安全分流' : '未触发安全分流'}
              tone={summary.safety_escalation_triggered ? 'danger' : 'ok'}
            />
          </View>
          <Text style={{fontSize: 12, lineHeight: 18, color: colors.muted}}>{summary.disclaimer}</Text>
        </View>
      ) : null}
      {detail ? (
        <View style={{gap: 10}}>
          <SecondaryButton label="查看完整聊天记录" onPress={() => onOpenChat(sessionId)} />
          <PrimaryButton label="返回会话列表" onPress={onBack} />
        </View>
      ) : null}
    </ScrollView>
  );
}
