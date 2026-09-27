import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';

import type {SessionInfo} from '../services/api';
import {deleteSession, extractErrorDetail, listSessions} from '../services/api';
import {Badge, PrimaryButton, colors, ui} from '../components/ui';

export function HistoryScreen({
  active,
  onOpenSession,
  onNewSession,
  onNotice,
}: {
  active: boolean;
  onOpenSession: (sessionId: number) => void;
  onNewSession: () => void;
  onNotice: (message: string, tone?: 'success' | 'error' | 'info') => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const items = await listSessions();
      setSessions(items);
      setError('');
    } catch (err) {
      setError(extractErrorDetail(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // 挂载时与每次重新激活（从聊天页返回）时拉取：页面保活不卸载，返回时
  // 已渲染的列表立即可见，后台请求到达后再更新状态/风险徽标，快且不陈旧。
  useEffect(() => {
    if (!active) {
      return;
    }
    void refresh();
  }, [active, refresh]);

  async function remove(sessionId: number) {
    try {
      await deleteSession(sessionId);
      onNotice('会话及相关数据已删除。', 'success');
      await refresh();
    } catch (err) {
      onNotice(extractErrorDetail(err), 'error');
    }
  }

  return (
    <ScrollView
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.primary} />}>
      <View style={{gap: 8}}>
        <Text style={ui.heading}>我的会话</Text>
        <Text style={ui.body}>下拉刷新。点击会话查看聊天记录或总结。</Text>
      </View>
      <PrimaryButton label="＋ 新建会话" onPress={onNewSession} />
      {loading ? <Text style={ui.hint}>加载中…</Text> : null}
      {error ? <Text style={ui.errorText}>{error}</Text> : null}
      {sessions.map(session => (
        <View key={session.id} style={[ui.card, {gap: 8}]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`打开会话 ${session.concern}`}
            style={({pressed}) => [styles.cardBody, pressed && ui.pressed]}
            onPress={() => onOpenSession(session.id)}>
            <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}}>
              <Text style={{fontSize: 16, fontWeight: '800', color: colors.ink}}>{session.concern}</Text>
              <Badge text={session.status === 'active' ? '进行中' : '已结束'} tone={session.status === 'active' ? 'ok' : 'warn'} />
            </View>
            <View style={{flexDirection: 'row', gap: 6, flexWrap: 'wrap'}}>
              <Badge
                text={`最高风险 ${session.max_risk_level}`}
                tone={session.max_risk_level === 'high' ? 'danger' : session.max_risk_level === 'ambiguous' ? 'warn' : 'ok'}
              />
              {session.safety_triggered ? <Badge text="触发过安全分流" tone="danger" /> : null}
              <Text style={ui.hint}>{session.created_at.replace('T', ' ').slice(0, 19)}</Text>
            </View>
          </Pressable>
          <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
            <Pressable
              accessibilityRole="button"
              hitSlop={6}
              style={({pressed}) => [styles.openLink, pressed && ui.pressed]}
              onPress={() => onOpenSession(session.id)}>
              <Text style={styles.openLinkText}>{session.status === 'ended' ? '查看记录与总结 →' : '继续对话 →'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              style={({pressed}) => pressed && ui.pressed}
              onPress={() => void remove(session.id)}>
              <Text style={{fontSize: 12, fontWeight: '800', color: colors.danger}}>删除</Text>
            </Pressable>
          </View>
        </View>
      ))}
      {!loading && !error && sessions.length === 0 ? <Text style={ui.hint}>还没有会话，点击上方按钮创建一个。</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Flat (non-nested) pressables: a Pressable inside another Pressable is a
  // known source of Android touch-handling bugs (the outer onPress stops
  // firing), so the card shell is a plain View and each action is its own
  // top-level Pressable.
  cardBody: {gap: 8},
  openLink: {paddingVertical: 2},
  openLinkText: {fontSize: 12, fontWeight: '700', color: colors.primary},
});
