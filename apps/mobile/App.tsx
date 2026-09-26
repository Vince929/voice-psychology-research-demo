import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Animated,
  BackHandler,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {ApiEnvironmentSelector} from './src/components/ApiEnvironmentSelector';
import {RecordManagement} from './src/components/RecordManagement';
import {Toast} from './src/components/Toast';
import {ApiEnvironment, getApiEnvironmentSettings, loadApiEnvironmentSettings, setApiEnvironment} from './src/config/api';
import {createUploadDraft, isDemoUploadModeEnabled, resumePendingUploads, resumeUpload, setDemoUploadMode} from './src/services/resumableUpload';
import {recordingErrorMessage, requestMicrophonePermission, startRecording, stopRecording} from './src/services/recorder';

type Step = 'consent' | 'subject' | 'record' | 'records';
type NoticeTone = 'success' | 'error' | 'info';

const STEPS: Exclude<Step, 'records'>[] = ['consent', 'subject', 'record'];
const SIGNAL_BAR_COLORS = ['#1D6258', '#287A6A', '#3D9A81', '#65B99B', '#A4D7B8', '#65B99B', '#3D9A81', '#287A6A', '#1D6258'];
const STEP_TITLE: Record<Step, string> = {
  consent: '知情同意',
  subject: '匿名信息',
  record: '语音采集',
  records: '录音文件',
};

const READING_PROMPTS = [
  {
    id: 'short',
    label: '短篇 · 约 20 秒',
    text: '今天的天气很适合散步。我会用平稳自然的节奏朗读这段文字，清晰表达此刻的感受。',
  },
  {
    id: 'standard',
    label: '标准 · 约 40 秒',
    text: '今天我想分享一下最近完成项目时的感受。过程里有一些挑战，但我会保持清晰、自然的节奏，表达我真实的想法。遇到问题时，我会先整理重点，再一步一步寻找合适的解决方法。',
  },
  {
    id: 'long',
    label: '长篇 · 约 1 分钟',
    text: '最近我完成了一项需要持续投入的工作。刚开始时，面对陌生的内容和有限的时间，我感到有些紧张，也担心自己无法兼顾所有细节。后来我把任务拆分成几个小步骤，先完成最重要的部分，再根据反馈不断调整。这个过程让我意识到，保持稳定的节奏和清楚的表达，往往比急着给出答案更重要。现在回头看，虽然中间有不少困难，但我也更加相信自己可以通过耐心和练习，把复杂的事情逐渐做好。',
  },
];

function createSubjectId() {
  return `P-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
}

function createIdempotencyKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export default function App() {
  const [step, setStep] = useState<Step>('consent');
  const [recordsReturnStep, setRecordsReturnStep] = useState<Exclude<Step, 'records'>>('consent');
  const [consented, setConsented] = useState(false);
  const [subjectId, setSubjectId] = useState(createSubjectId);
  const [ageGroup, setAgeGroup] = useState('18-24');
  const [gender, setGender] = useState('不透露');
  const [language, setLanguage] = useState('普通话');
  const [recordingEnvironment, setRecordingEnvironment] = useState('安静室内');
  const [selectedPromptId, setSelectedPromptId] = useState(READING_PROMPTS[1].id);
  const [recording, setRecording] = useState(false);
  const [audioUri, setAudioUri] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [demoUploadMode, setDemoUploadModeState] = useState(isDemoUploadModeEnabled);
  const [apiSettings, setApiSettings] = useState(getApiEnvironmentSettings);
  const [environmentSelectorVisible, setEnvironmentSelectorVisible] = useState(false);
  const [notice, setNotice] = useState<{message: string; tone: NoticeTone} | null>(null);

  const showNotice = useCallback((message: string, tone: NoticeTone = 'info') => {
    setNotice({message, tone});
  }, []);

  useEffect(() => {
    void (async () => {
      const settings = await loadApiEnvironmentSettings();
      setApiSettings(settings);
      const results = await resumePendingUploads();
      if (results.length > 0) {
        showNotice('已恢复完成中断的录音上传，转录任务正在处理中。', 'success');
      }
    })();
  }, [showNotice]);

  function goBack() {
    if (step === 'records') {
      setStep(recordsReturnStep);
      return;
    }
    const currentIndex = STEPS.indexOf(step);
    if (currentIndex > 0) {
      setStep(STEPS[currentIndex - 1]);
    }
  }

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'consent') {
        return false;
      }
      goBack();
      return true;
    });
    return () => subscription.remove();
  }, [recordsReturnStep, step]);

  function startNewParticipant() {
    setSubjectId(createSubjectId());
    setAgeGroup('18-24');
    setGender('不透露');
    setLanguage('普通话');
    setRecordingEnvironment('安静室内');
    setAudioUri('');
    setConsented(false);
    setStep('consent');
  }

  function continueCurrentParticipantCollection() {
    setAudioUri('');
    setStep('record');
  }

  async function toggleRecording() {
    try {
      if (recording) {
        const completedAudioUri = await stopRecording();
        setAudioUri(completedAudioUri);
        setRecording(false);
        await upload(completedAudioUri);
        return;
      }
      if (!await requestMicrophonePermission()) {
        showNotice('需要麦克风权限后才能录音，请在系统设置中开启。', 'error');
        return;
      }
      await startRecording(demoUploadMode);
      setRecording(true);
    } catch (error) {
      setRecording(false);
      showNotice(`录音未启动：${recordingErrorMessage(error)}`, 'error');
    }
  }

  function toggleDemoUploadMode() {
    const nextEnabled = !demoUploadMode;
    setDemoUploadMode(nextEnabled);
    setDemoUploadModeState(nextEnabled);
    showNotice(nextEnabled ? '已开启演示慢传：新录音将分块缓慢上传。' : '已关闭演示慢传：新录音将按正常速度上传。', 'info');
  }

  async function saveApiEnvironment(environment: ApiEnvironment) {
    try {
      const settings = await setApiEnvironment(environment);
      setApiSettings(settings);
      showNotice(`已切换至${environment === 'production' ? '线上' : '本地'} API 环境。`, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '环境配置保存失败。';
      showNotice(message, 'error');
      throw error;
    }
  }

  async function upload(audioUriToSubmit: string) {
    setSubmitting(true);
    try {
      const draft = await createUploadDraft(
        {
          subject_id: subjectId,
          age_group: ageGroup,
          gender,
          language,
          recording_environment: recordingEnvironment,
        },
        audioUriToSubmit,
        createIdempotencyKey(),
      );
      await resumeUpload(draft);
      setAudioUri('');
      showNotice('录音已提交，正在等待转录任务处理。继续采集会沿用当前匿名编号。', 'success');
    } catch {
      showNotice('上传已暂停，重新打开应用后会自动继续。', 'info');
    } finally {
      setSubmitting(false);
    }
  }

  const collectingStep = step !== 'records' ? STEPS.indexOf(step) + 1 : 0;
  const isHome = step === 'consent';
  const statusBarInset = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#153B36" />
      <View style={[styles.header, !isHome && styles.compactHeader, {paddingTop: statusBarInset + (isHome ? 14 : 16)}]}>
        <View style={styles.headerTopLine}>
          {isHome ? <Pressable accessibilityRole="button" accessibilityLabel="切换 API 环境" style={({pressed}) => [styles.environmentButton, pressed && styles.pressed]} onPress={() => setEnvironmentSelectorVisible(true)}>
            <View style={styles.environmentDot} />
            <Text style={styles.environmentButtonText}>{apiSettings.environment === 'production' ? '线上 API' : '本地 API'}</Text>
            <Text style={styles.environmentButtonArrow}>切换</Text>
          </Pressable> : <Pressable accessibilityLabel="返回上一页" style={({pressed}) => [styles.backButton, pressed && styles.pressed]} onPress={goBack}><Text style={styles.backButtonText}>‹ 返回</Text></Pressable>}
          <View style={styles.privacyPill}><View style={styles.privacyDot} /><Text style={styles.privacyText}>匿名采集</Text></View>
        </View>
        {isHome ? <>
          <Text style={styles.eyebrow}>VOICE RESEARCH / 01</Text>
          <Text style={styles.title}>声研洞察</Text>
          <Text style={styles.subtitle}>采集步骤 {collectingStep} / {STEPS.length} · {STEP_TITLE[step]}</Text>
          <StepRail activeIndex={collectingStep - 1} />
        </> : null}
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, step === 'record' && styles.recordContent, step === 'records' && styles.recordsContent]}>
        {step === 'consent' && (
          <View style={styles.section}>
            <Text style={styles.heading}>参与前，请先确认</Text>
            <Text style={styles.body}>这是用于自我观察的语音表达研究演示。结果不构成医疗、心理诊断或人格测评；你可以随时删除自己的录音与分析数据。</Text>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{checked: consented}}
              onPress={() => setConsented(current => !current)}
              style={({pressed}) => [styles.consentCard, consented && styles.consentCardActive, pressed && styles.pressed]}
            >
              <View style={[styles.consentIndicator, consented && styles.consentIndicatorActive]}>
                {consented ? <Text style={styles.consentTick}>✓</Text> : null}
              </View>
              <View style={styles.consentCopy}><Text style={styles.consentLabel}>我已阅读并理解采集说明</Text><Text style={styles.consentHint}>录音仅用于本次研究演示</Text></View>
            </Pressable>
            <View style={styles.actionHint}><View style={styles.actionHintDot} /><Text style={styles.actionHintText}>{consented ? '确认后将进入匿名信息页' : '阅读并确认后即可继续'}</Text></View>
            <PrimaryButton label="进入采集" disabled={!consented} onPress={() => setStep('subject')} />
            <Pressable style={({pressed}) => [styles.textLink, pressed && styles.pressed]} onPress={() => { setRecordsReturnStep('consent'); setStep('records'); }}><Text style={styles.link}>查看录音文件列表 →</Text></Pressable>
          </View>
        )}
        {step === 'subject' && (
          <View style={styles.section}>
            <Text style={styles.heading}>匿名采集信息</Text>
            <Text style={styles.body}>不收集姓名和手机号。以下信息只用于记录与质量解释，不参与 AI 表达判断。</Text>
            <View style={styles.formCard}>
              <Field label="匿名编号" value={subjectId} onChangeText={setSubjectId} />
              <Choice label="年龄段" value={ageGroup} choices={['18-24', '25-34', '35-44', '45+']} onChange={setAgeGroup} />
              <Choice label="性别" value={gender} choices={['女', '男', '不透露']} onChange={setGender} />
              <Choice label="语言/方言" value={language} choices={['普通话']} onChange={setLanguage} />
              <Choice label="录音环境" value={recordingEnvironment} choices={['安静室内', '一般室内', '轻微噪声']} onChange={setRecordingEnvironment} />
            </View>
            <PrimaryButton label="进入语音采集" onPress={() => setStep('record')} />
          </View>
        )}
        {step === 'record' && (
          <View style={styles.section}>
            <View style={styles.recordHeadingRow}>
              <Text style={styles.heading}>朗读采集</Text>
              <Pressable accessibilityRole="switch" accessibilityState={{checked: demoUploadMode}} style={({pressed}) => [styles.uploadModeToggle, demoUploadMode && styles.uploadModeToggleActive, pressed && styles.pressed]} onPress={toggleDemoUploadMode}>
                <Text style={styles.uploadModeLabel}>演示慢传</Text>
                <View style={[styles.uploadModeIndicator, demoUploadMode && styles.uploadModeIndicatorActive]}><View style={[styles.uploadModeKnob, demoUploadMode && styles.uploadModeKnobActive]} /></View>
              </Pressable>
            </View>
            <Text style={styles.body}>选择适合的篇幅后，以自然连贯的节奏完成朗读。录音会上传至服务端转写，再生成实验性表达洞察。</Text>
            <Choice value={selectedPromptId} choices={READING_PROMPTS.map(prompt => prompt.id)} labels={READING_PROMPTS.map(prompt => prompt.label)} onChange={setSelectedPromptId} />
            <View style={styles.promptBox}>
              <Text style={styles.promptLabel}>本次朗读</Text>
              <Text style={styles.prompt}>“{READING_PROMPTS.find(prompt => prompt.id === selectedPromptId)?.text}”</Text>
            </View>
          </View>
        )}
        {step === 'records' ? <RecordManagement onNotice={showNotice} /> : null}
      </ScrollView>
      {step === 'record' ? <RecordingDock recording={recording} submitting={submitting} audioUri={audioUri} onRecordPress={toggleRecording} onRecordsPress={() => { setRecordsReturnStep('record'); setStep('records'); }} /> : null}
      {step === 'records' ? <RecordsActionDock onContinueCollection={continueCurrentParticipantCollection} onNewParticipant={startNewParticipant} /> : null}
      <ApiEnvironmentSelector
        environment={apiSettings.environment}
        visible={environmentSelectorVisible}
        onDismiss={() => setEnvironmentSelectorVisible(false)}
        onSave={saveApiEnvironment}
      />
      <Toast message={notice?.message ?? null} tone={notice?.tone} onDismiss={() => setNotice(null)} />
    </SafeAreaView>
  );
}

function StepRail({activeIndex}: {activeIndex: number}) {
  return <View style={styles.stepRail}>{STEPS.map((item, index) => <React.Fragment key={item}><View style={[styles.stepDot, index <= activeIndex && styles.stepDotActive]}><Text style={[styles.stepDotText, index <= activeIndex && styles.stepDotTextActive]}>{index + 1}</Text></View>{index < STEPS.length - 1 ? <View style={[styles.stepLine, index < activeIndex && styles.stepLineActive]} /> : null}</React.Fragment>)}</View>;
}

function RecordingDock({recording, submitting, audioUri, onRecordPress, onRecordsPress}: {recording: boolean; submitting: boolean; audioUri: string; onRecordPress: () => void; onRecordsPress: () => void}) {
  return (
    <View style={styles.recordingDock}>
      <RecordingOrb recording={recording} submitting={submitting} onPress={onRecordPress} />
      {!recording && audioUri && !submitting ? <Text style={styles.errorMessage}>自动提交未完成，请检查提示后重新录音。</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="查看录音文件列表" hitSlop={8} style={({pressed}) => [styles.dockRecordsButton, pressed && styles.pressed]} onPress={onRecordsPress}><Text style={styles.dockRecordsButtonText}>查看录音文件列表</Text><Text style={styles.dockRecordsButtonArrow}>→</Text></Pressable>
    </View>
  );
}

function RecordsActionDock({onContinueCollection, onNewParticipant}: {onContinueCollection: () => void; onNewParticipant: () => void}) {
  return <View style={styles.recordsActionDock}>
    <PrimaryButton label="继续采集" onPress={onContinueCollection} />
    <Pressable accessibilityRole="button" accessibilityLabel="新建参与者" style={({pressed}) => [styles.newParticipantButton, pressed && styles.pressed]} onPress={onNewParticipant}>
      <Text style={styles.newParticipantButtonText}>新建参与者（生成新匿名编号）</Text>
    </Pressable>
  </View>;
}

function RecordingOrb({recording, submitting, onPress}: {recording: boolean; submitting: boolean; onPress: () => void}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const wave = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!recording) {
      pulse.stopAnimation();
      wave.stopAnimation();
      pulse.setValue(0);
      wave.setValue(0);
      return;
    }
    const pulseAnimation = Animated.loop(Animated.sequence([
      Animated.timing(pulse, {toValue: 1, duration: 1050, useNativeDriver: true}),
      Animated.timing(pulse, {toValue: 0, duration: 1050, useNativeDriver: true}),
    ]));
    const waveAnimation = Animated.loop(Animated.timing(wave, {toValue: 1, duration: 1320, useNativeDriver: true}));
    pulseAnimation.start();
    waveAnimation.start();
    return () => {
      pulseAnimation.stop();
      waveAnimation.stop();
    };
  }, [pulse, recording, wave]);

  const auraScale = pulse.interpolate({inputRange: [0, 1], outputRange: [0.92, 1.2]});
  const auraOpacity = pulse.interpolate({inputRange: [0, 1], outputRange: [0.26, 0.03]});
  const outerScale = pulse.interpolate({inputRange: [0, 1], outputRange: [1, 1.13]});
  const outerOpacity = pulse.interpolate({inputRange: [0, 1], outputRange: [0.52, 0.08]});
  return (
    <View style={styles.orbPanel}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={submitting ? '正在上传录音' : recording ? '结束录音并自动上传' : '开始录音'}
        accessibilityState={{disabled: submitting}}
        disabled={submitting}
        onPress={onPress}
        style={({pressed}) => [styles.orbButton, pressed && !submitting && styles.orbButtonPressed]}
      >
        <View style={styles.orbWrap}>
          <Animated.View style={[styles.orbAura, {opacity: auraOpacity, transform: [{scale: auraScale}]}]} />
          <Animated.View style={[styles.orbPulse, {opacity: outerOpacity, transform: [{scale: outerScale}]}]} />
          <View style={[styles.orb, recording && styles.orbRecording, submitting && styles.orbSubmitting]}>
            <View style={styles.orbCore}>{recording ? <View style={styles.pauseIcon}><View style={styles.pauseBar} /><View style={styles.pauseBar} /></View> : <View style={styles.micIcon}><View style={styles.micCapsule} /><View style={styles.micStem} /></View>}</View>
          </View>
        </View>
      </Pressable>
      <SignalBars active={recording} progress={wave} />
      <Text style={styles.orbTitle}>{submitting ? '录音提交中' : recording ? '录音进行中' : '轻触麦克风开始录音'}</Text>
    </View>
  );
}

function SignalBars({active, progress}: {active: boolean; progress: Animated.Value}) {
  const bars = [13, 21, 29, 18, 33, 24, 16, 27, 20];
  return (
    <View accessibilityLabel={active ? '录音进行中' : '录音未开始'} style={[styles.signalBars, !active && styles.signalBarsIdle]}>
      {bars.map((height, index) => {
        const phase = (index % 4 + 1) * 0.16;
        const scaleY = active ? progress.interpolate({inputRange: [0, phase, Math.min(phase + 0.35, 1), 1], outputRange: [0.38, 1, 0.54, 0.38]}) : 0.35;
        return <Animated.View key={`${height}-${index}`} style={[styles.signalBar, {height, backgroundColor: SIGNAL_BAR_COLORS[index], transform: [{scaleY}]}]} />;
      })}
    </View>
  );
}

function Field({label, value, onChangeText}: {label: string; value: string; onChangeText: (value: string) => void}) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput style={styles.input} value={value} onChangeText={onChangeText} selectionColor="#E86F51" /></View>;
}

function Choice({label, value, choices, labels, onChange}: {label?: string; value?: string; choices: string[]; labels?: string[]; onChange: (value: string) => void}) {
  return <View style={styles.field}>{label ? <Text style={styles.label}>{label}</Text> : null}<View style={styles.choiceGroup}>{choices.map((choice, index) => <Pressable key={choice} style={({pressed}) => [styles.choice, value === choice && styles.choiceActive, pressed && styles.pressed]} onPress={() => onChange(choice)}><Text style={[styles.choiceText, value === choice && styles.choiceTextActive]}>{labels?.[index] || choice}</Text></Pressable>)}</View></View>;
}

function PrimaryButton({label, disabled, onPress, recording, iconLarge}: {label: string; disabled?: boolean; onPress: () => void; recording?: boolean; iconLarge?: boolean}) {
  return <Pressable disabled={disabled} style={({pressed}) => [styles.button, recording && styles.buttonRecording, disabled && styles.buttonDisabled, pressed && !disabled && styles.buttonPressed]} onPress={onPress}><Text style={styles.buttonText}>{label}</Text><Text style={iconLarge ? styles.buttonIconLarge : styles.buttonArrow}>{recording ? '■' : '→'}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: '#F6F2EA'},
  header: {paddingHorizontal: 24, paddingTop: 14, paddingBottom: 25, backgroundColor: '#153B36', overflow: 'hidden'},
  compactHeader: {paddingTop: 16, paddingBottom: 8},
  headerTopLine: {height: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  backButton: {minWidth: 76, paddingVertical: 9, marginLeft: -6},
  backButtonSpacer: {height: 38, minWidth: 76},
  backButtonText: {fontSize: 15, fontWeight: '700', color: '#F7E7C2'},
  privacyPill: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.10)'},
  privacyDot: {width: 6, height: 6, borderRadius: 4, backgroundColor: '#B8DDCB'},
  privacyText: {fontSize: 12, color: '#E8F4ED', fontWeight: '700'},
  eyebrow: {marginTop: 18, fontSize: 11, letterSpacing: 1.5, fontWeight: '800', color: '#B8DDCB'},
  title: {marginTop: 5, fontSize: 35, letterSpacing: -1.5, fontWeight: '800', color: '#FFFDF7'},
  subtitle: {fontSize: 15, lineHeight: 22, color: '#C4D8D0', marginTop: 8, fontWeight: '500'},
  stepRail: {flexDirection: 'row', alignItems: 'center', marginTop: 22, maxWidth: 220},
  stepDot: {width: 25, height: 25, borderRadius: 13, borderWidth: 1, borderColor: '#658A80', alignItems: 'center', justifyContent: 'center'},
  stepDotActive: {borderColor: '#9ED7C0', backgroundColor: '#9ED7C0'},
  stepDotText: {fontSize: 11, color: '#A9C2BA', fontWeight: '800'},
  stepDotTextActive: {color: '#153B36'},
  stepLine: {height: 1, flex: 1, marginHorizontal: 6, backgroundColor: '#55786F'},
  stepLineActive: {backgroundColor: '#9ED7C0'},
  environmentButton: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.10)'},
  environmentDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: '#B8DDCB'},
  environmentButtonText: {fontSize: 12, fontWeight: '800', color: '#E8F4ED'},
  environmentButtonArrow: {fontSize: 11, fontWeight: '800', color: '#B8DDCB'},
  content: {paddingHorizontal: 20, paddingTop: 20, paddingBottom: 44},
  recordContent: {paddingBottom: 236},
  recordsContent: {paddingBottom: 140},
  section: {gap: 18},
  introMark: {flexDirection: 'row', alignItems: 'center', gap: 9},
  introMarkText: {fontSize: 13, letterSpacing: 1.4, fontWeight: '900', color: '#287A6A'},
  introMarkCaption: {fontSize: 12, color: '#75847B', fontWeight: '700'},
  heading: {fontSize: 29, letterSpacing: -0.9, fontWeight: '800', color: '#173A35'},
  body: {fontSize: 16, lineHeight: 26, color: '#4D625B'},
  consentCard: {minHeight: 78, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 15, borderRadius: 18, borderWidth: 1, borderColor: '#D7D9CE', backgroundColor: '#FFFCF6'},
  consentCardActive: {borderColor: '#80AE9C', backgroundColor: '#E9F2EB'},
  consentIndicator: {width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: '#91A69D', alignItems: 'center', justifyContent: 'center'},
  consentIndicatorActive: {backgroundColor: '#1E6B5B', borderColor: '#1E6B5B'},
  consentTick: {color: '#FFFFFF', fontSize: 17, fontWeight: '800', lineHeight: 20, includeFontPadding: false},
  consentCopy: {flex: 1, gap: 3},
  consentLabel: {fontSize: 16, lineHeight: 22, color: '#183C36', fontWeight: '800'},
  consentHint: {fontSize: 12, color: '#5E746C'},
  formCard: {gap: 18, padding: 17, borderRadius: 20, backgroundColor: '#FFFCF6', borderWidth: 1, borderColor: '#E2E1D9'},
  field: {gap: 9},
  label: {fontSize: 13, letterSpacing: 0.3, fontWeight: '800', color: '#465E56'},
  input: {backgroundColor: '#F4F5EF', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, color: '#163C36', borderWidth: 1, borderColor: '#E1E4DB'},
  choiceGroup: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  choice: {paddingVertical: 10, paddingHorizontal: 13, borderRadius: 99, borderWidth: 1, borderColor: '#D9DFD6', backgroundColor: '#FBFBF6'},
  choiceActive: {backgroundColor: '#173F39', borderColor: '#173F39'},
  choiceText: {color: '#4C625B', fontSize: 14, fontWeight: '600'},
  choiceTextActive: {color: '#FFFFFF', fontWeight: '800'},
  promptBox: {gap: 10, padding: 20, borderRadius: 20, backgroundColor: '#FFF4DD', borderLeftWidth: 4, borderLeftColor: '#E69B4C'},
  recordHeadingRow: {flexDirection: 'row', alignItems: 'center', gap: 26},
  uploadModeToggle: {flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 99, borderWidth: 1, borderColor: '#D9DFD6', backgroundColor: '#FFFCF6'},
  uploadModeToggleActive: {borderColor: '#D6B77F', backgroundColor: '#FFF7E9'},
  uploadModeIndicator: {width: 34, height: 21, justifyContent: 'center', paddingHorizontal: 3, borderRadius: 99, backgroundColor: '#B5C1BA'},
  uploadModeIndicatorActive: {backgroundColor: '#D28A35'},
  uploadModeKnob: {width: 17, height: 17, borderRadius: 9, backgroundColor: '#FFFFFF'},
  uploadModeKnobActive: {alignSelf: 'flex-end'},
  uploadModeLabel: {fontSize: 12, fontWeight: '800', color: '#314F47'},
  promptLabel: {fontSize: 12, letterSpacing: 1.2, fontWeight: '900', color: '#A56826'},
  prompt: {fontSize: 19, lineHeight: 32, color: '#49351E', fontWeight: '600'},
  recordingDock: {position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: 4, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10, backgroundColor: '#F6F2EA', borderTopWidth: 1, borderTopColor: '#DFE1D8', shadowColor: '#173A35', shadowOpacity: 0.13, shadowRadius: 12, shadowOffset: {width: 0, height: -4}, elevation: 12},
  recordsActionDock: {position: 'absolute', left: 0, right: 0, bottom: 0, gap: 9, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20, backgroundColor: '#F6F2EA', borderTopWidth: 1, borderTopColor: '#DFE1D8', shadowColor: '#173A35', shadowOpacity: 0.13, shadowRadius: 12, shadowOffset: {width: 0, height: -4}, elevation: 12},
  newParticipantButton: {minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: '#BFD4C8', backgroundColor: '#F8FBF8'},
  newParticipantButtonText: {fontSize: 14, fontWeight: '800', color: '#1D6258'},
  dockRecordsButton: {alignSelf: 'stretch', minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 12, zIndex: 2, elevation: 0, backgroundColor: 'transparent'},
  dockRecordsButtonText: {fontSize: 14, fontWeight: '800', color: '#1D6258'},
  dockRecordsButtonArrow: {fontSize: 15, fontWeight: '800', color: '#1D6258'},
  orbPanel: {alignItems: 'center', paddingTop: 0, paddingBottom: 0},
  orbButton: {borderRadius: 54},
  orbButtonPressed: {transform: [{scale: 0.96}], opacity: 0.9},
  orbWrap: {width: 102, height: 102, alignItems: 'center', justifyContent: 'center'},
  orbAura: {position: 'absolute', width: 100, height: 100, borderRadius: 50, backgroundColor: '#9ED7C0'},
  orbPulse: {position: 'absolute', width: 90, height: 90, borderRadius: 45, backgroundColor: '#5FB08F'},
  orb: {width: 76, height: 76, borderRadius: 38, backgroundColor: '#185B50', borderWidth: 5, borderColor: '#A9D9C3', alignItems: 'center', justifyContent: 'center', shadowColor: '#123F38', shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 7},
  orbRecording: {backgroundColor: '#246D5D', borderColor: '#C9E7D7'},
  orbSubmitting: {backgroundColor: '#2D7D69', borderColor: '#C4E2D2'},
  orbCore: {alignItems: 'center', justifyContent: 'center'},
  micIcon: {height: 27, width: 21, alignItems: 'center'},
  micCapsule: {width: 13, height: 18, borderRadius: 9, borderWidth: 2.5, borderColor: '#FFFFFF'},
  micStem: {width: 3, height: 7, borderRadius: 2, marginTop: 2, backgroundColor: '#FFFFFF'},
  pauseIcon: {height: 22, flexDirection: 'row', alignItems: 'center', gap: 5},
  pauseBar: {width: 5, height: 22, borderRadius: 3, backgroundColor: '#FFFFFF'},
  signalBars: {height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, marginTop: 0},
  signalBarsIdle: {opacity: 0.46},
  signalBar: {width: 4, borderRadius: 4},
  orbTitle: {marginTop: 0, fontSize: 15, fontWeight: '800', color: '#1A4039'},
  orbHint: {marginTop: 1, fontSize: 11, textAlign: 'center', lineHeight: 16, color: '#708078'},
  recordingSafetyNote: {paddingHorizontal: 16, fontSize: 11, lineHeight: 16, textAlign: 'center', color: '#9A4738', fontWeight: '700'},
  actionHint: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7},
  actionHintDot: {width: 6, height: 6, borderRadius: 4, backgroundColor: '#E29A4B'},
  actionHintText: {fontSize: 12, color: '#728179', fontWeight: '700'},
  button: {minHeight: 55, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 20, backgroundColor: '#1E6B5B', borderRadius: 16, shadowColor: '#123F38', shadowOpacity: 0.22, shadowRadius: 10, shadowOffset: {width: 0, height: 6}, elevation: 4},
  buttonRecording: {backgroundColor: '#155346'},
  buttonDisabled: {backgroundColor: '#C6C7BD', shadowOpacity: 0},
  buttonPressed: {transform: [{scale: 0.985}], shadowOpacity: 0.1},
  buttonText: {fontWeight: '800', fontSize: 16, color: '#FFFFFF'},
  buttonArrow: {fontWeight: '800', fontSize: 16, color: '#FFFFFF'},
  buttonIconLarge: {fontWeight: '800', fontSize: 26, lineHeight: 30, color: '#FFFFFF'},
  statusMessage: {fontSize: 12, textAlign: 'center', color: '#27705F', fontWeight: '700'},
  errorMessage: {fontSize: 12, textAlign: 'center', color: '#B04E3C', fontWeight: '700'},
  textLink: {alignSelf: 'center', padding: 8},
  link: {textAlign: 'center', color: '#1D6258', fontWeight: '800'},
  pressed: {opacity: 0.72},
});
