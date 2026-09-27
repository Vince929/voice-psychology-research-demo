import React, {useCallback, useEffect, useState} from 'react';
import {BackHandler, Keyboard, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View} from 'react-native';

import {Toast} from './src/components/Toast';
import {colors} from './src/components/ui';
import {ChatScreen} from './src/screens/ChatScreen';
import {HistoryScreen} from './src/screens/HistoryScreen';
import {LoginScreen} from './src/screens/LoginScreen';
import {NewSessionScreen} from './src/screens/NewSessionScreen';
import {SummaryScreen} from './src/screens/SummaryScreen';
import {loadStoredToken, logout, verifyToken} from './src/services/api';

type Route =
  | {name: 'login'}
  | {name: 'history'}
  | {name: 'newSession'}
  | {name: 'chat'; sessionId: number}
  | {name: 'summary'; sessionId: number};

type NoticeTone = 'success' | 'error' | 'info';

const ROUTE_TITLES: Record<Route['name'], string> = {
  login: '语音心理支持助手',
  history: '我的会话',
  newSession: '创建会话',
  chat: '对话',
  summary: '会话总结',
};

export default function App() {
  const [booting, setBooting] = useState(true);
  const [username, setUsername] = useState('');
  const [route, setRoute] = useState<Route>({name: 'login'});
  // 最近打开的会话：聊天页保持挂载（隐藏而非卸载），返回时零重建、状态/滚动位置保留。
  const [chatSessionId, setChatSessionId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{message: string; tone: NoticeTone} | null>(null);

  const showNotice = useCallback((message: string, tone: NoticeTone = 'info') => {
    setNotice({message, tone});
  }, []);

  const backToHistory = useCallback(() => {
    Keyboard.dismiss();
    setRoute({name: 'history'});
  }, []);

  const openChat = useCallback((sessionId: number) => {
    setChatSessionId(sessionId);
    setRoute({name: 'chat', sessionId});
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadStoredToken();
      const user = await verifyToken();
      if (cancelled) {
        return;
      }
      if (user) {
        setUsername(user.username);
        setRoute({name: 'history'});
      }
      setBooting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'login' || route.name === 'history') {
        return false;
      }
      backToHistory();
      return true;
    });
    return () => subscription.remove();
  }, [route.name, backToHistory]);

  async function handleLogout() {
    await logout();
    setUsername('');
    setChatSessionId(null);
    setRoute({name: 'login'});
    showNotice('已退出登录。', 'info');
  }

  const statusBarInset = StatusBar.currentHeight ?? 0;
  const canGoBack = route.name === 'chat' || route.name === 'summary' || route.name === 'newSession';
  const signedIn = !booting && route.name !== 'login';

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#153B36" />
      <View style={[styles.header, {paddingTop: statusBarInset + 14}]}>
        <View style={styles.headerRow}>
          {canGoBack ? (
            <Pressable accessibilityLabel="返回会话列表" style={styles.backButton} onPress={backToHistory}>
              <Text style={styles.backButtonText}>‹ 返回</Text>
            </Pressable>
          ) : (
            <View style={{minWidth: 76}} />
          )}
          <Text style={styles.headerTitle}>{ROUTE_TITLES[route.name]}</Text>
          {route.name === 'history' ? (
            <Pressable accessibilityLabel="退出登录" style={styles.logoutButton} onPress={() => void handleLogout()}>
              <Text style={styles.logoutText}>{username} · 退出</Text>
            </Pressable>
          ) : (
            <View style={{minWidth: 76}} />
          )}
        </View>
      </View>
      {booting ? (
        <View style={styles.booting}>
          <Text style={{color: colors.muted}}>正在恢复登录状态…</Text>
        </View>
      ) : null}
      {!booting && route.name === 'login' ? (
        <LoginScreen
          onLoggedIn={name => {
            setUsername(name);
            setRoute({name: 'history'});
          }}
        />
      ) : null}
      {signedIn ? (
        <View style={route.name === 'history' ? styles.screenLayer : styles.screenHidden}>
          <HistoryScreen
            active={route.name === 'history'}
            onOpenSession={openChat}
            onNewSession={() => setRoute({name: 'newSession'})}
            onNotice={showNotice}
          />
        </View>
      ) : null}
      {!booting && route.name === 'newSession' ? (
        <NewSessionScreen
          onCreated={session => {
            openChat(session.id);
          }}
        />
      ) : null}
      {signedIn && chatSessionId !== null ? (
        <View style={route.name === 'chat' ? styles.screenLayer : styles.screenHidden}>
          <ChatScreen
            key={chatSessionId}
            sessionId={chatSessionId}
            active={route.name === 'chat'}
            onEnded={sessionId => {
              setRoute({name: 'summary', sessionId});
            }}
            onOpenSummary={sessionId => setRoute({name: 'summary', sessionId})}
            onNotice={showNotice}
          />
        </View>
      ) : null}
      {!booting && route.name === 'summary' ? (
        <SummaryScreen
          sessionId={route.sessionId}
          onBack={backToHistory}
          onOpenChat={openChat}
        />
      ) : null}
      <Toast message={notice?.message ?? null} tone={notice?.tone} onDismiss={() => setNotice(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: '#F6F2EA'},
  screenLayer: {flex: 1},
  screenHidden: {display: 'none'},
  header: {paddingHorizontal: 20, paddingBottom: 16, backgroundColor: '#153B36'},
  headerRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 34},
  backButton: {minWidth: 76, paddingVertical: 6},
  backButtonText: {fontSize: 15, fontWeight: '700', color: '#F7E7C2'},
  headerTitle: {fontSize: 17, fontWeight: '800', color: '#FFFDF7'},
  logoutButton: {minWidth: 76, alignItems: 'flex-end', paddingVertical: 6},
  logoutText: {fontSize: 13, fontWeight: '700', color: '#B8DDCB'},
  booting: {flex: 1, alignItems: 'center', justifyContent: 'center'},
});
