import React, {useMemo, useState} from 'react';
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {MBTI_QUESTIONS, PHQ9_QUESTIONS} from './src/types/assessment';
import {checkApiHealth, submitRecord} from './src/services/api';
import {requestMicrophonePermission, startRecording, stopRecording} from './src/services/recorder';

type Step = 'consent' | 'subject' | 'phq9' | 'mbti' | 'record';
const STEPS: Step[] = ['consent', 'subject', 'phq9', 'mbti', 'record'];
const STEP_TITLE: Record<Step, string> = {
  consent: '知情同意',
  subject: '匿名信息',
  phq9: 'PHQ-9 问卷',
  mbti: '偏好问卷',
  record: '语音采集',
};

function createSubjectId() {
  return `P-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
}

export default function App() {
  const [step, setStep] = useState<Step>('consent');
  const [consented, setConsented] = useState(false);
  const [subjectId, setSubjectId] = useState(createSubjectId);
  const [ageGroup, setAgeGroup] = useState('18-24');
  const [gender, setGender] = useState('不透露');
  const [phq9, setPhq9] = useState<Record<string, number>>({});
  const [mbti, setMbti] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState(false);
  const [audioUri, setAudioUri] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const phq9Score = useMemo(() => Object.values(phq9).reduce((sum, value) => sum + value, 0), [phq9]);
  const moveTo = (next: Step) => setStep(next);

  async function toggleRecording() {
    if (recording) {
      const uri = await stopRecording();
      setAudioUri(uri);
      setRecording(false);
      return;
    }
    const granted = await requestMicrophonePermission();
    if (!granted) {
      Alert.alert('无法录音', '请在系统设置中授予麦克风权限后重试。');
      return;
    }
    await startRecording();
    setRecording(true);
  }

  async function upload() {
    if (!audioUri) {
      Alert.alert('请先完成录音');
      return;
    }
    setSubmitting(true);
    try {
      await submitRecord({subject: {subject_id: subjectId, age_group: ageGroup, gender}, phq9, mbti}, audioUri);
      Alert.alert('已保存', '音频和问卷已保存至本地研究服务。');
      setAudioUri('');
    } catch {
      Alert.alert('提交失败', '请确认本地 FastAPI 服务已启动，并使用 Android 模拟器地址 10.0.2.2:8000。');
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyService() {
    try {
      await checkApiHealth();
      Alert.alert('服务可用', '本地数据库服务已连接。');
    } catch {
      Alert.alert('服务不可用', '请启动 apps/api 中的 FastAPI 服务。');
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor={styles.safeArea.backgroundColor} />
      <View style={styles.header}>
        <Text style={styles.kicker}>VOICE RESEARCH DEMO</Text>
        <Text style={styles.title}>语音心理科研采集</Text>
        <Text style={styles.subtitle}>{STEP_TITLE[step]} · 第 {STEPS.indexOf(step) + 1} / {STEPS.length} 步</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {step === 'consent' && (
          <View style={styles.section}>
            <Text style={styles.heading}>参与前请确认</Text>
            <Text style={styles.body}>本应用为本地工程演示原型，仅用于模拟科研采集流程，不提供医疗诊断。你可随时停止录制，并可要求删除自己的全部数据。</Text>
            <Pressable style={[styles.checkRow, consented && styles.checkRowActive]} onPress={() => setConsented(!consented)}>
              <Text style={styles.checkIcon}>{consented ? '✓' : '○'}</Text>
              <Text style={styles.checkText}>我已阅读并同意本科研采集协议</Text>
            </Pressable>
            <PrimaryButton label="进入实验" disabled={!consented} onPress={() => moveTo('subject')} />
          </View>
        )}
        {step === 'subject' && (
          <View style={styles.section}>
            <Text style={styles.heading}>匿名受试者信息</Text>
            <Text style={styles.body}>不收集姓名和手机号，仅使用匿名编号关联本次本地采集记录。</Text>
            <Field label="匿名编号" value={subjectId} onChangeText={setSubjectId} />
            <Choice label="年龄段" value={ageGroup} choices={['18-24', '25-34', '35-44', '45+']} onChange={setAgeGroup} />
            <Choice label="性别" value={gender} choices={['女', '男', '不透露']} onChange={setGender} />
            <PrimaryButton label="继续填写问卷" onPress={() => moveTo('phq9')} />
          </View>
        )}
        {step === 'phq9' && (
          <View style={styles.section}>
            <Text style={styles.heading}>PHQ-9 问卷</Text>
            <Text style={styles.body}>请按过去两周的实际情况选择。页面仅计算原始问卷分数，不作心理预测。</Text>
            <Text style={styles.score}>当前原始总分：{phq9Score}</Text>
            {PHQ9_QUESTIONS.map((question, index) => (
              <View key={question} style={styles.question}>
                <Text style={styles.questionText}>{index + 1}. {question}</Text>
                <Choice value={String(phq9[index])} choices={['0', '1', '2', '3']} onChange={value => setPhq9({...phq9, [index]: Number(value)})} />
              </View>
            ))}
            <PrimaryButton label="继续" disabled={Object.keys(phq9).length !== PHQ9_QUESTIONS.length} onPress={() => moveTo('mbti')} />
          </View>
        )}
        {step === 'mbti' && (
          <View style={styles.section}>
            <Text style={styles.heading}>偏好问卷</Text>
            <Text style={styles.body}>此处只记录选项维度计数，不输出人格标签。</Text>
            {MBTI_QUESTIONS.map(question => (
              <View key={question.id} style={styles.question}>
                <Text style={styles.questionText}>{question.text}</Text>
                <Choice value={mbti[question.id]} choices={question.options} onChange={value => setMbti({...mbti, [question.id]: value})} />
              </View>
            ))}
            <PrimaryButton label="进入语音采集" disabled={Object.keys(mbti).length !== MBTI_QUESTIONS.length} onPress={() => moveTo('record')} />
          </View>
        )}
        {step === 'record' && (
          <View style={styles.section}>
            <Text style={styles.heading}>朗读采集</Text>
            <View style={styles.promptBox}><Text style={styles.prompt}>“今天的天气很适合散步。我会以平稳自然的速度朗读这段文字，并在结束后保存录音。”</Text></View>
            <Text style={styles.body}>请在安静环境下朗读。演示音频仅上传至本机 FastAPI 服务。</Text>
            <PrimaryButton label={recording ? '停止录音' : audioUri ? '重新录音' : '开始录音'} onPress={toggleRecording} />
            {audioUri ? <Text style={styles.success}>录音已就绪，可提交。</Text> : null}
            <PrimaryButton label={submitting ? '正在保存…' : '提交本次采集'} disabled={!audioUri || submitting || recording} onPress={upload} />
            <Pressable onPress={verifyService}><Text style={styles.link}>检查本地数据库服务</Text></Pressable>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({label, value, onChangeText}: {label: string; value: string; onChangeText: (value: string) => void}) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput style={styles.input} value={value} onChangeText={onChangeText} /></View>;
}

function Choice({label, value, choices, onChange}: {label?: string; value?: string; choices: string[]; onChange: (value: string) => void}) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><View style={styles.choiceGroup}>{choices.map(choice => <Pressable key={choice} style={[styles.choice, value === choice && styles.choiceActive]} onPress={() => onChange(choice)}><Text style={[styles.choiceText, value === choice && styles.choiceTextActive]}>{choice}</Text></Pressable>)}</View></View>;
}

function PrimaryButton({label, disabled, onPress}: {label: string; disabled?: boolean; onPress: () => void}) {
  return <Pressable disabled={disabled} style={[styles.button, disabled && styles.buttonDisabled]} onPress={onPress}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: '#F2F7F6'}, header: {padding: 24, paddingTop: 34, backgroundColor: '#DDECE8'}, kicker: {fontSize: 11, letterSpacing: 1.8, color: '#4A716B', fontWeight: '700'}, title: {fontSize: 30, fontWeight: '800', color: '#13332F', marginTop: 8}, subtitle: {fontSize: 14, color: '#4A716B', marginTop: 6}, content: {padding: 20}, section: {gap: 16}, heading: {fontSize: 24, fontWeight: '800', color: '#163C36'}, body: {fontSize: 16, lineHeight: 25, color: '#385650'}, checkRow: {flexDirection: 'row', gap: 12, padding: 16, borderRadius: 12, backgroundColor: '#FFFFFF'}, checkRowActive: {backgroundColor: '#D2EAE3'}, checkIcon: {fontSize: 21, color: '#1B6559'}, checkText: {flex: 1, fontSize: 16, color: '#163C36'}, field: {gap: 8}, label: {fontSize: 14, fontWeight: '700', color: '#385650'}, input: {backgroundColor: '#FFFFFF', borderRadius: 10, padding: 14, fontSize: 16, color: '#163C36'}, choiceGroup: {flexDirection: 'row', flexWrap: 'wrap', gap: 8}, choice: {paddingVertical: 10, paddingHorizontal: 14, borderRadius: 22, backgroundColor: '#FFFFFF'}, choiceActive: {backgroundColor: '#1B6559'}, choiceText: {color: '#385650'}, choiceTextActive: {color: '#FFFFFF', fontWeight: '700'}, question: {gap: 10, padding: 16, borderRadius: 12, backgroundColor: '#E8F0EE'}, questionText: {fontSize: 16, lineHeight: 23, color: '#163C36'}, score: {fontSize: 18, color: '#1B6559', fontWeight: '800'}, promptBox: {borderLeftWidth: 5, borderLeftColor: '#D99B4D', padding: 18, backgroundColor: '#FFF8EC'}, prompt: {fontSize: 19, lineHeight: 31, color: '#4D371F'}, button: {alignItems: 'center', padding: 16, backgroundColor: '#1B6559', borderRadius: 12}, buttonDisabled: {backgroundColor: '#9DB6B0'}, buttonText: {fontWeight: '800', fontSize: 16, color: '#FFFFFF'}, success: {fontSize: 15, color: '#1B6559', fontWeight: '700'}, link: {textAlign: 'center', color: '#1B6559', fontWeight: '700', padding: 10},
});
