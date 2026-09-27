import React, {useEffect, useState} from 'react';
import {KeyboardAvoidingView, Platform, ScrollView, Text, View} from 'react-native';

import {checkApiHealth, extractErrorDetail, login} from '../services/api';
import {Field, PrimaryButton, SecondaryButton, colors, ui} from '../components/ui';

const DEMO_ACCOUNTS = ['demo1', 'demo2'];
const DEMO_PASSWORD = 'Passw0rd!';

export function LoginScreen({onLoggedIn}: {onLoggedIn: (username: string) => void}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkApiHealth().then(online => {
      if (!cancelled) {
        setApiOnline(online);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    if (submitting) {
      return;
    }
    setError('');
    if (!username.trim() || !password) {
      setError('请输入用户名和密码。');
      return;
    }
    setSubmitting(true);
    try {
      const name = await login(username.trim(), password);
      onLoggedIn(name);
    } catch (err) {
      setError(extractErrorDetail(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView style={ui.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <View style={{gap: 8, marginTop: 12}}>
          <Text style={{fontSize: 11, letterSpacing: 1.5, fontWeight: '800', color: '#287A6A'}}>VOICE SUPPORT AGENT</Text>
          <Text style={ui.heading}>语音心理支持助手</Text>
          <Text style={ui.body}>
            本工具为非医疗性质的辅助性心理支持服务，不作诊断、不作治疗承诺、不替代心理咨询师与紧急援助服务。
          </Text>
        </View>
        {apiOnline === false ? <Text style={ui.errorText}>无法连接本地服务，请确认后端已启动（./cmd.sh api）。</Text> : null}
        <View style={ui.card}>
          <Field label="用户名" value={username} onChangeText={setUsername} placeholder="demo1 / demo2" />
          <Field label="密码" value={password} onChangeText={setPassword} placeholder="测试账号密码：Passw0rd!" secure />
          {error ? <Text style={ui.errorText}>{error}</Text> : null}
          <PrimaryButton label={submitting ? '登录中…' : '登录'} disabled={submitting} onPress={() => void submit()} />
          <View style={{flexDirection: 'row', gap: 8}}>
            {DEMO_ACCOUNTS.map(account => (
              <SecondaryButton
                key={account}
                label={`快速填充 ${account}`}
                disabled={submitting}
                onPress={() => {
                  setUsername(account);
                  setPassword(DEMO_PASSWORD);
                  setError('');
                }}
              />
            ))}
          </View>
          <Text style={[ui.hint, {textAlign: 'center', color: colors.muted}]}>
            验收测试账号：demo1 / demo2，密码 Passw0rd!
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
