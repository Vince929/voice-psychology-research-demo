import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, RefreshControl, ScrollView, Text, View} from 'react-native';

import type {SessionInfo} from '../services/api';
import {deleteSession, extractErrorDetail, listSessions} from '../services/api';
import {Badge, PrimaryButton, colors, ui} from '../components/ui';

// 模块级缓存：HistoryScreen 随路由条件渲染反复卸载/挂载，
// 普通返回列表时直接复用缓存，避免每次重新拉取。
let cachedSessions: SessionInfo[] | null = null;

/** 会话列表需要失效的场景：新建会话、结束会话。删除会话在组件内主动 refresh。 */
export function invalidateSessionsCache() {
  cachedSessions = null;
}

export function HistoryScreen({
  onOpenSession,
  onNewSession,
  onNotice,
}: {
  onOpenSession: (sessionId: number) => void;
  onNewSession: () => void;
  onNotice: (message: string, tone?: 'success' | 'error' | 'info') => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>(cachedSessions ?? []);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(cachedSessions === null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const items = await listSessions();
      cachedSessions = items;
      setSessions(items);
      setError('');
    } catch (err) {
      setError(extractErrorDetail(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (cachedSessions !== null) {
      return;
    }
    void refresh();
  }, [refresh]);

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
        <Pressable
          key={session.id}
          accessibilityRole="button"
          style={({pressed}) => [ui.card, pressed && ui.pressed, {gap: 8}]}
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
          <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
            <Text style={ui.hint}>{session.status === 'ended' ? '查看记录与总结 →' : '继续对话 →'}</Text>
            <Pressable hitSlop={8} onPress={() => void remove(session.id)}>
              <Text style={{fontSize: 12, fontWeight: '800', color: colors.danger}}>删除</Text>
            </Pressable>
          </View>
        </Pressable>
      ))}
      {!loading && !error && sessions.length === 0 ? <Text style={ui.hint}>还没有会话，点击上方按钮创建一个。</Text> : null}
    </ScrollView>
  );
}
