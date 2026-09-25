import React, {useCallback, useState} from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {RecordManagement} from './src/components/RecordManagement';
import {Toast} from './src/components/Toast';
import {checkApiHealth, submitRecord} from './src/services/api';
import {recordingErrorMessage, requestMicrophonePermission, startRecording, stopRecording} from './src/services/recorder';

type Step = 'consent' | 'subject' | 'record' | 'records';
const STEPS: Exclude<Step, 'records'>[] = ['consent', 'subject', 'record'];
const STEP_TITLE: Record<Step, string> = {
  consent: '知情同意',
  subject: '匿名信息',
  record: '语音采集',
  records: '录音文件',
};

function createSubjectId() {
  return `P-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
}

function createIdempotencyKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export default function App() {
  const [step, setStep] = useState<Step>('consent');
  const [consented, setConsented] = useState(false);
  const [subjectId, setSubjectId] = useState(createSubjectId);
  const [ageGroup, setAgeGroup] = useState('18-24');
  const [gender, setGender] = useState('不透露');
  const [language, setLanguage] = useState('普通话');
  const [recordingEnvironment, setRecordingEnvironment] = useState('安静室内');
  const [recording, setRecording] = useState(false);
  const [audioUri, setAudioUri] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{message: string; tone: 'success' | 'error' | 'info'} | null>(null);

  const showNotice = useCallback((message: string, tone: 'success' | 'error' | 'info' = 'info') => {
    setNotice({message, tone});
  }, []);

  function goBack() {
    if (step === 'records') {
      setStep('record');
      return;
    }
    const currentIndex = STEPS.indexOf(step);
    if (currentIndex > 0) {
      setStep(STEPS[currentIndex - 1]);
    }
  }

  function resetCollection() {
    setSubjectId(createSubjectId());
    setAgeGroup('18-24');
    setGender('不透露');
    setLanguage('普通话');
    setRecordingEnvironment('安静室内');
    setAudioUri('');
  }

  async function toggleRecording() {
    try {
      if (recording) {
        setAudioUri(await stopRecording());
        setRecording(false);
        return;
      }
      if (!await requestMicrophonePermission()) {
        showNotice('需要麦克风权限后才能录音，请在系统设置中开启。', 'error');
        return;
      }
      await startRecording();
      setRecording(true);
    } catch (error) {
      setRecording(false);
      showNotice(`录音未启动：${recordingErrorMessage(error)}`, 'error');
    }
  }

  async function upload() {
    if (!audioUri) {
      showNotice('请先完成一段录音，再提交分析。', 'info');
      return;
    }
    setSubmitting(true);
    try {
      await submitRecord(
        {
          subject_id: subjectId,
          age_group: ageGroup,
          gender,
          language,
          recording_environment: recordingEnvironment,
        },
        audioUri,
        createIdempotencyKey(),
      );
      resetCollection();
      setStep('records');
      showNotice('录音已提交，正在等待转录任务处理。', 'success');
    } catch {
      showNotice('提交失败。请检查本地服务与音频存储配置。', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyService() {
    try {
      await checkApiHealth();
      showNotice('本地服务连接正常。', 'success');
    } catch {
      showNotice('本地服务不可用，请启动 FastAPI 后重试。', 'error');
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <View style={styles.headerRow}>
          {step !== 'consent' ? <Pressable style={styles.backButton} onPress={goBack}><Text style={styles.backButtonText}>‹ 返回</Text></Pressable> : <View style={styles.backButtonSpacer} />}
          <Text style={styles.kicker}>{step === 'records' ? '任务状态与结果' : `采集步骤 ${STEPS.indexOf(step as Exclude<Step, 'records'>) + 1} / ${STEPS.length}`}</Text>
        </View>
        <Text style={styles.title}>声研洞察</Text>
        <Text style={styles.subtitle}>{step === 'records' ? '查看转录、分析进度与实验性表达洞察' : STEP_TITLE[step]}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {step === 'consent' && (
          <View style={styles.section}>
            <Text style={styles.heading}>参与前请确认</Text>
            <Text style={styles.body}>本应用是语音表达洞察工程演示。分析结果仅供演示与自我观察，不构成医疗、心理诊断或人格测评。你可随时删除自己的录音与分析数据。</Text>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{checked: consented}}
              onPress={() => setConsented(current => !current)}
              style={[styles.consentCard, consented && styles.consentCardActive]}
            >
              <View style={[styles.consentIndicator, consented && styles.consentIndicatorActive]}>
                {consented ? <Text style={styles.consentTick}>✓</Text> : null}
              </View>
              <Text style={styles.consentLabel}>我已阅读并同意本次语音采集说明</Text>
            </Pressable>
            <PrimaryButton label="进入采集" disabled={!consented} onPress={() => setStep('subject')} />
            <Pressable onPress={() => setStep('records')}><Text style={styles.link}>暂不录音，查看文件列表</Text></Pressable>
          </View>
        )}
        {step === 'subject' && (
          <View style={styles.section}>
            <Text style={styles.heading}>匿名采集信息</Text>
            <Text style={styles.body}>不收集姓名和手机号。年龄段、性别和环境仅用于记录与质量解释，不参与 AI 表达判断。</Text>
            <Field label="匿名编号" value={subjectId} onChangeText={setSubjectId} />
            <Choice label="年龄段" value={ageGroup} choices={['18-24', '25-34', '35-44', '45+']} onChange={setAgeGroup} />
            <Choice label="性别" value={gender} choices={['女', '男', '不透露']} onChange={setGender} />
            <Choice label="语言/方言" value={language} choices={['普通话']} onChange={setLanguage} />
            <Choice label="录音环境" value={recordingEnvironment} choices={['安静室内', '一般室内', '轻微噪声']} onChange={setRecordingEnvironment} />
            <PrimaryButton label="进入语音采集" onPress={() => setStep('record')} />
          </View>
        )}
        {step === 'record' && (
          <View style={styles.section}>
            <Text style={styles.heading}>朗读采集</Text>
            <View style={styles.promptBox}><Text style={styles.prompt}>“今天我想分享一下最近完成项目时的感受。过程里有一些挑战，但我会保持清晰、自然的节奏，表达我真实的想法。”</Text></View>
            <Text style={styles.body}>请在安静环境下朗读。原始 M4A 录音会上传到服务端，由腾讯云 ASR 转写，再由 AI 生成实验性表达洞察。</Text>
            <PrimaryButton label={recording ? '停止录音' : audioUri ? '重新录音' : '开始录音'} onPress={toggleRecording} />
            {audioUri ? <Text style={styles.success}>M4A 录音已就绪，可提交转录和分析。</Text> : null}
            <PrimaryButton label={submitting ? '正在提交…' : '提交并开始分析'} disabled={!audioUri || submitting || recording} onPress={upload} />
            <Pressable onPress={() => setStep('records')}><Text style={styles.link}>查看录音文件列表</Text></Pressable>
            <Pressable onPress={verifyService}><Text style={styles.link}>检查本地 API 服务</Text></Pressable>
          </View>
        )}
        {step === 'records' ? <RecordManagement onStartNew={() => setStep('subject')} onNotice={showNotice} /> : null}
      </ScrollView>
      <Toast message={notice?.message ?? null} tone={notice?.tone} onDismiss={() => setNotice(null)} />
    </SafeAreaView>
  );
}

function Field({label, value, onChangeText}: {label: string; value: string; onChangeText: (value: string) => void}) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput style={styles.input} value={value} onChangeText={onChangeText} /></View>;
}

function Choice({label, value, choices, onChange}: {label?: string; value?: string; choices: string[]; onChange: (value: string) => void}) {
  return <View style={styles.field}>{label ? <Text style={styles.label}>{label}</Text> : null}<View style={styles.choiceGroup}>{choices.map(choice => <Pressable key={choice} style={[styles.choice, value === choice && styles.choiceActive]} onPress={() => onChange(choice)}><Text style={[styles.choiceText, value === choice && styles.choiceTextActive]}>{choice}</Text></Pressable>)}</View></View>;
}

function PrimaryButton({label, disabled, onPress}: {label: string; disabled?: boolean; onPress: () => void}) {
  return <Pressable disabled={disabled} style={[styles.button, disabled && styles.buttonDisabled]} onPress={onPress}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: '#E8F0ED'}, header: {paddingHorizontal: 28, paddingTop: 26, paddingBottom: 24, backgroundColor: '#D9E8E2', borderBottomWidth: 1, borderBottomColor: '#C5D8D1'}, headerRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, kicker: {fontSize: 12, letterSpacing: 0.8, color: '#4A716B', fontWeight: '700'}, backButton: {minWidth: 76, paddingVertical: 11, marginLeft: -6}, backButtonSpacer: {minWidth: 76}, backButtonText: {fontSize: 15, fontWeight: '700', color: '#1B6559'}, title: {fontSize: 31, letterSpacing: -1, fontWeight: '800', color: '#13332F', marginTop: 16}, subtitle: {fontSize: 15, color: '#4A716B', marginTop: 6}, content: {paddingHorizontal: 24, paddingTop: 24, paddingBottom: 40}, section: {gap: 18}, heading: {fontSize: 25, letterSpacing: -0.5, fontWeight: '800', color: '#163C36'}, body: {fontSize: 16, lineHeight: 25, color: '#385650'}, consentCard: {minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14, borderWidth: 1, borderColor: '#C4D7D0', backgroundColor: '#FAFCFB'}, consentCardActive: {borderColor: '#75A99A', backgroundColor: '#E2F0EB'}, consentIndicator: {width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: '#7B9890', alignItems: 'center', justifyContent: 'center'}, consentIndicatorActive: {backgroundColor: '#1B6559', borderColor: '#1B6559'}, consentTick: {color: '#FFFFFF', fontSize: 17, fontWeight: '800', lineHeight: 20, includeFontPadding: false}, consentLabel: {flex: 1, fontSize: 16, lineHeight: 23, color: '#163C36', fontWeight: '600'}, field: {gap: 9}, label: {fontSize: 14, fontWeight: '700', color: '#385650'}, input: {backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, fontSize: 16, color: '#163C36'}, choiceGroup: {flexDirection: 'row', flexWrap: 'wrap', gap: 9}, choice: {paddingVertical: 10, paddingHorizontal: 14, borderRadius: 22, backgroundColor: '#FFFFFF'}, choiceActive: {backgroundColor: '#1B6559'}, choiceText: {color: '#385650'}, choiceTextActive: {color: '#FFFFFF', fontWeight: '700'}, promptBox: {borderLeftWidth: 5, borderLeftColor: '#D99B4D', padding: 18, backgroundColor: '#FFF8EC'}, prompt: {fontSize: 19, lineHeight: 31, color: '#4D371F'}, button: {minHeight: 50, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, backgroundColor: '#1B6559', borderRadius: 12}, buttonDisabled: {backgroundColor: '#9DB6B0'}, buttonText: {fontWeight: '800', fontSize: 16, color: '#FFFFFF'}, success: {fontSize: 15, color: '#1B6559', fontWeight: '700'}, link: {textAlign: 'center', color: '#1B6559', fontWeight: '700', paddingVertical: 10},
});
