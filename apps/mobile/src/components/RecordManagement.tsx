import React, {useCallback, useEffect, useState} from 'react';
import {Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import {
  AnalysisStatus,
  CollectionRecord,
  RecordSummary,
  cancelAnalysis,
  deleteRecord,
  deleteSubjectRecords,
  getAudioUrl,
  getRecord,
  listRecords,
  retryAnalysis,
} from '../services/api';
import {playRemoteAudio, recordingErrorMessage, stopRemoteAudio} from '../services/recorder';

type NoticeTone = 'success' | 'error' | 'info';

type RecordManagementProps = {
  onContinueCollection: () => void;
  onNewParticipant: () => void;
  onNotice: (message: string, tone?: NoticeTone) => void;
};

const ACTIVE_STATUSES: AnalysisStatus[] = ['pending', 'transcribing', 'analyzing'];
const STATUS_LABELS: Record<AnalysisStatus, string> = {
  pending: '待转录',
  transcribing: '转录中',
  analyzing: 'AI 分析中',
  completed: '分析完成',
  failed: '分析失败',
  cancelled: '已取消',
};

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {hour12: false});
}

function formatDuration(duration?: number) {
  if (!duration) {
    return '时长待转录';
  }
  const seconds = Math.round(duration / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

const LEGACY_ERROR_MESSAGES: Record<string, string> = {
  'Tencent Cloud ASR returned an empty transcript': '未识别到有效语音内容，请确认录音时已靠近麦克风并清晰朗读。',
  'Tencent Cloud ASR is not configured': '语音转写服务尚未完成配置，请联系管理员检查服务配置。',
  'Tencent Cloud ASR request failed': '语音转写服务请求失败，系统将自动重试。',
  'DeepSeek is not configured': 'AI 分析服务尚未完成配置，请联系管理员检查服务配置。',
  'DeepSeek request failed': 'AI 分析服务请求失败，系统将自动重试。',
  'Analysis worker lease expired': '分析任务处理超时，请重新分析。',
  'Unexpected worker error': '分析任务处理异常，系统将自动重试。',
};

function taskErrorMessage(task: RecordSummary['task'] | CollectionRecord['task']) {
  if (!task?.error_message) {
    return null;
  }
  return LEGACY_ERROR_MESSAGES[task.error_message] || task.error_message;
}

function taskNotice(task: RecordSummary['task'] | CollectionRecord['task']) {
  return task?.error_code === 'no_speech_detected' ? taskErrorMessage(task) : null;
}

function taskLabel(task: RecordSummary['task'] | CollectionRecord['task']) {
  if (taskNotice(task)) {
    return '未识别到有效语音';
  }
  if (task?.status === 'failed' && task.failed_stage === 'transcription') {
    return '转录失败';
  }
  return task ? STATUS_LABELS[task.status] : STATUS_LABELS.failed;
}

export function RecordManagement({onContinueCollection, onNewParticipant, onNotice}: RecordManagementProps) {
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<CollectionRecord | null>(null);
  const [loading, setLoading] = useState(false);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      setRecords(await listRecords());
    } catch {
      onNotice('无法加载录音列表，请检查本地服务是否已启动。', 'error');
    } finally {
      setLoading(false);
    }
  }, [onNotice]);

  const refreshSelectedRecord = useCallback(async () => {
    if (selectedRecord) {
      setSelectedRecord(await getRecord(selectedRecord.id));
    }
  }, [selectedRecord]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  useEffect(() => {
    if (!records.some(record => record.task && ACTIVE_STATUSES.includes(record.task.status))) {
      return;
    }
    const interval = setInterval(() => void loadRecords(), 2500);
    return () => clearInterval(interval);
  }, [records, loadRecords]);

  async function showRecord(recordId: number) {
    try {
      setSelectedRecord(await getRecord(recordId));
    } catch {
      onNotice('无法打开详情，这条记录可能已经被删除。', 'error');
    }
  }

  async function openAudio(recordId: number) {
    try {
      await playRemoteAudio(getAudioUrl(recordId));
      onNotice('正在播放录音。', 'success');
    } catch (error) {
      onNotice(`音频播放失败：${recordingErrorMessage(error)}`, 'error');
    }
  }

  async function stopAudio() {
    try {
      await stopRemoteAudio();
      onNotice('已停止播放。', 'info');
    } catch (error) {
      onNotice(`停止播放失败：${recordingErrorMessage(error)}`, 'error');
    }
  }

  async function handleRetry(recordId: number) {
    try {
      await retryAnalysis(recordId);
      await loadRecords();
      await refreshSelectedRecord();
      onNotice('已重新加入转录与分析队列。', 'success');
    } catch {
      onNotice('无法重新分析，请稍后重试。', 'error');
    }
  }

  async function handleCancel(recordId: number) {
    try {
      await cancelAnalysis(recordId);
      await loadRecords();
      await refreshSelectedRecord();
      onNotice('已请求取消分析任务。', 'info');
    } catch {
      onNotice('当前任务无法取消。', 'error');
    }
  }

  function confirmDeleteRecord(record: RecordSummary) {
    Alert.alert('删除这条录音？', '原始录音、转写和分析结果会永久删除，无法恢复。', [
      {text: '取消', style: 'cancel'},
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteRecord(record.id);
            setSelectedRecord(null);
            await loadRecords();
            onNotice('这条录音及分析数据已删除。', 'success');
          } catch {
            onNotice('删除失败，请检查服务后重试。', 'error');
          }
        },
      },
    ]);
  }

  function confirmDeleteSubject(subjectId: string) {
    Alert.alert('删除该编号的全部数据？', '该编号下的所有录音、转写和分析结果会永久删除，无法恢复。', [
      {text: '取消', style: 'cancel'},
      {
        text: '删除全部',
        style: 'destructive',
        onPress: async () => {
          try {
            const result = await deleteSubjectRecords(subjectId);
            setSelectedRecord(null);
            await loadRecords();
            onNotice(`已删除该编号下的 ${result.deleted_count} 条录音。`, 'success');
          } catch {
            onNotice('删除失败，请检查服务后重试。', 'error');
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.section}>
      <View style={styles.titleRow}>
        <View style={styles.titleCopy}>
          <Text style={styles.heading}>录音文件</Text>
          <Text style={styles.body}>同一匿名编号可连续采集多条录音，转录和 AI 分析在后台执行。</Text>
        </View>
        <Pressable style={({pressed}) => [styles.refreshButton, pressed && styles.pressed]} disabled={loading} onPress={() => void loadRecords()}>
          {loading ? <Text style={styles.refreshButtonText}>刷新中</Text> : <View style={styles.refreshButtonContent}><Text style={styles.refreshIcon}>↻</Text><Text style={styles.refreshButtonText}>刷新</Text></View>}
        </Pressable>
      </View>
      {records.length === 0 && !loading ? (
        <View style={styles.emptyPanel}>
          <Text style={styles.emptyTitle}>还没有录音文件</Text>
          <Text style={styles.empty}>完成一次录音并提交后，转录与分析进度会显示在这里。</Text>
        </View>
      ) : null}
      {records.map(record => <RecordCard key={record.id} record={record} onDetail={() => void showRecord(record.id)} onRetry={() => void handleRetry(record.id)} onDelete={() => confirmDeleteRecord(record)} />)}
      <PrimaryButton label="继续为当前参与者采集" onPress={onContinueCollection} />
      <Pressable style={({pressed}) => [styles.newParticipantButton, pressed && styles.pressed]} onPress={onNewParticipant}>
        <Text style={styles.newParticipantButtonText}>新建参与者（生成新匿名编号）</Text>
      </Pressable>
      <Modal visible={selectedRecord !== null} animationType="slide" transparent onRequestClose={() => setSelectedRecord(null)}>
        {selectedRecord ? <RecordDetail record={selectedRecord} onClose={() => setSelectedRecord(null)} onPlay={() => void openAudio(selectedRecord.id)} onStop={() => void stopAudio()} onRetry={() => void handleRetry(selectedRecord.id)} onCancel={() => void handleCancel(selectedRecord.id)} onDeleteRecord={() => confirmDeleteRecord(selectedRecord)} onDeleteSubject={() => confirmDeleteSubject(selectedRecord.subject_id)} /> : null}
      </Modal>
    </View>
  );
}

function RecordCard({record, onDetail, onRetry, onDelete}: {record: RecordSummary; onDetail: () => void; onRetry: () => void; onDelete: () => void}) {
  const status = record.task?.status ?? 'failed';
  const hasNotice = Boolean(taskNotice(record.task));
  const canRetry = !record.task || !ACTIVE_STATUSES.includes(status);
  const statusLabel = taskLabel(record.task);
  return (
    <View style={styles.recordCard}>
      <View style={styles.recordTopRow}>
        <View style={styles.recordTitleWrap}><View style={[styles.recordSignal, status === 'completed' && styles.recordSignalCompleted, status === 'failed' && styles.recordSignalFailed]} /><Text style={styles.recordTitle}>{record.subject_id}</Text></View>
        <Text style={[styles.statusPill, status === 'failed' && styles.statusPillFailed, hasNotice && styles.statusPillWarning, status === 'completed' && !hasNotice && styles.statusPillCompleted]}>{statusLabel}</Text>
      </View>
      <Text style={styles.recordMeta}>{record.audio_filename} · {formatTime(record.created_at)}</Text>
      {record.task?.status === 'failed' ? <Text style={styles.errorText}>{taskErrorMessage(record.task) || '任务处理失败，可查看详情后重新分析。'}</Text> : null}
      {taskNotice(record.task) ? <Text style={styles.infoText}>{taskNotice(record.task)}</Text> : null}
      <View style={styles.actionRow}>
        <ActionButton label="查看详情" onPress={onDetail} />
        {canRetry ? <ActionButton label="重新分析" onPress={onRetry} /> : null}
        <ActionButton label="删除" destructive onPress={onDelete} />
      </View>
    </View>
  );
}

function RecordDetail({record, onClose, onPlay, onStop, onRetry, onCancel, onDeleteRecord, onDeleteSubject}: {record: CollectionRecord; onClose: () => void; onPlay: () => void; onStop: () => void; onRetry: () => void; onCancel: () => void; onDeleteRecord: () => void; onDeleteSubject: () => void}) {
  const task = record.task;
  const isActive = Boolean(task && ACTIVE_STATUSES.includes(task.status));
  const sentences = record.asr_result?.flash_result?.flatMap(result => result.sentence_list || []) || [];
  return (
    <View style={styles.modalBackdrop}>
      <View style={styles.detailSheet}>
        <View style={styles.sheetHandle} />
        <View style={styles.detailHeader}>
          <Pressable style={({pressed}) => [styles.backButton, pressed && styles.pressed]} onPress={onClose}><Text style={styles.backButtonText}>‹ 返回</Text></Pressable>
          <Text style={styles.detailTitle}>录音详情</Text>
          <View style={styles.headerSpacer} />
        </View>
        <ScrollView contentContainerStyle={styles.detailContent}>
          <View style={styles.detailIdentity}>
            <Text style={styles.detailSubject}>{record.subject_id}</Text>
            <Text style={styles.detailText}>{formatTime(record.created_at)}</Text>
            {task ? <Text style={styles.detailStatus}>{taskLabel(task)}</Text> : null}
          </View>
          <Text style={styles.detailText}>年龄段：{record.age_group || '未填写'}　性别：{record.gender || '未填写'}</Text>
          <Text style={styles.detailText}>语言：{record.language || '普通话'}　环境：{record.recording_environment || '未填写'}</Text>
          <PrimaryButton label="播放原始录音" onPress={onPlay} />
          <ActionButton label="停止播放" onPress={onStop} />
          {isActive ? <ActionButton label="取消当前分析" destructive onPress={onCancel} /> : null}
          {!isActive ? <ActionButton label="重新分析" onPress={onRetry} /> : null}
          {task?.status === 'failed' && taskErrorMessage(task) ? <SectionBlock title="任务状态" value={`${task.failed_stage === 'transcription' ? '转录' : '分析'}失败：${taskErrorMessage(task)}`} /> : null}
          {taskNotice(task) ? <SectionBlock title="转录结果" value={taskNotice(task)!} /> : null}
          {record.transcript ? <SectionBlock title="真实转写" value={record.transcript} /> : null}
          {record.asr_result ? <SectionBlock title="ASR 依据" value={`录音时长：${formatDuration(record.asr_result.audio_duration)}\n句段数：${sentences.length}`} /> : null}
          {sentences.length > 0 ? <View style={styles.detailBlock}><Text style={styles.detailHeading}>句段时间线</Text>{sentences.map((sentence, index) => <Text key={`${sentence.start_time}-${index}`} style={styles.detailText}>{formatDuration(sentence.start_time)} - {formatDuration(sentence.end_time)}　{sentence.text}</Text>)}</View> : null}
          {record.analysis_result ? <AnalysisBlock result={record.analysis_result} /> : null}
          <Text style={styles.disclaimer}>实验性预测，仅供演示与自我观察，不构成医疗、心理诊断或人格测评。</Text>
          <View style={styles.dangerZone}>
            <Text style={styles.dangerHint}>删除操作不可恢复</Text>
            <ActionButton label="删除本条录音" destructive onPress={onDeleteRecord} />
            <ActionButton label="删除该编号的全部数据" destructive onPress={onDeleteSubject} />
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

function AnalysisBlock({result}: {result: NonNullable<CollectionRecord['analysis_result']>}) {
  return <View style={styles.analysisCard}>
    <Text style={styles.detailHeading}>实验性表达洞察</Text>
    <Text style={styles.analysisState}>{result.expression_state}</Text>
    <Text style={styles.detailText}>活力指数 {result.vitality_score}　紧张度 {result.tension_score}</Text>
    <Text style={styles.detailText}>{result.summary}</Text>
    <Text style={styles.detailText}>依据：{result.evidence.join('；')}</Text>
    <Text style={styles.detailText}>建议：{result.suggestion}</Text>
  </View>;
}

function SectionBlock({title, value}: {title: string; value: string}) {
  return <View style={styles.detailBlock}><Text style={styles.detailHeading}>{title}</Text><Text style={styles.detailText}>{value}</Text></View>;
}

function PrimaryButton({label, disabled, onPress}: {label: string; disabled?: boolean; onPress: () => void}) {
  return <Pressable disabled={disabled} style={({pressed}) => [styles.button, disabled && styles.buttonDisabled, pressed && !disabled && styles.buttonPressed]} onPress={onPress}><Text style={styles.buttonText}>{label}</Text><Text style={styles.buttonArrow}>→</Text></Pressable>;
}

function ActionButton({label, destructive, onPress}: {label: string; destructive?: boolean; onPress: () => void}) {
  return <Pressable style={({pressed}) => [styles.actionButton, destructive && styles.actionButtonDestructive, pressed && styles.pressed]} onPress={onPress}><Text style={[styles.actionButtonText, destructive && styles.actionButtonTextDestructive]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  section: {gap: 18},
  titleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16},
  titleCopy: {flex: 1, gap: 5},
  heading: {fontSize: 29, letterSpacing: -0.9, fontWeight: '800', color: '#173A35'},
  body: {fontSize: 15, lineHeight: 22, color: '#61736B'},
  refreshButton: {minHeight: 42, minWidth: 80, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#E6F0E9'},
  refreshButtonContent: {flexDirection: 'row', alignItems: 'center', gap: 5},
  refreshIcon: {fontSize: 18, lineHeight: 18, color: '#1D6258', fontWeight: '700', includeFontPadding: false},
  refreshButtonText: {fontSize: 13, lineHeight: 18, fontWeight: '800', color: '#1D6258', includeFontPadding: false},
  button: {minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 18, backgroundColor: '#D86B51', borderRadius: 16, shadowColor: '#A64734', shadowOpacity: 0.2, shadowRadius: 10, shadowOffset: {width: 0, height: 6}, elevation: 4},
  buttonDisabled: {backgroundColor: '#B9C1BA', shadowOpacity: 0},
  buttonPressed: {transform: [{scale: 0.985}]},
  buttonText: {fontWeight: '800', fontSize: 16, color: '#FFFFFF'},
  buttonArrow: {fontWeight: '800', fontSize: 16, color: '#FFFFFF'},
  newParticipantButton: {minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: '#BFD4C8', backgroundColor: '#F8FBF8'},
  newParticipantButtonText: {fontSize: 14, fontWeight: '800', color: '#1D6258'},
  emptyPanel: {padding: 25, borderRadius: 20, borderWidth: 1, borderColor: '#D9DED5', borderStyle: 'dashed', backgroundColor: '#FFFCF6', gap: 8},
  emptyTitle: {fontSize: 18, fontWeight: '800', color: '#173A35'},
  empty: {fontSize: 15, lineHeight: 22, color: '#61736B'},
  recordCard: {gap: 10, padding: 18, borderRadius: 20, borderWidth: 1, borderColor: '#E2E1D9', backgroundColor: '#FFFCF6', shadowColor: '#274B43', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: {width: 0, height: 4}, elevation: 2},
  recordCardPressed: {opacity: 0.82, transform: [{scale: 0.99}]},
  recordTopRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12},
  recordTitleWrap: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9},
  recordSignal: {width: 9, height: 9, borderRadius: 5, backgroundColor: '#E5A84E'},
  recordSignalCompleted: {backgroundColor: '#4F9B7B'},
  recordSignalFailed: {backgroundColor: '#D86B51'},
  recordTitle: {flex: 1, fontSize: 18, fontWeight: '800', color: '#173A35'},
  statusPill: {paddingHorizontal: 10, paddingVertical: 6, borderRadius: 99, backgroundColor: '#FFF1D4', fontSize: 12, color: '#95601C', fontWeight: '800'},
  statusPillCompleted: {backgroundColor: '#E1F0E8', color: '#246A59'},
  statusPillWarning: {backgroundColor: '#FFF1D4', color: '#95601C'},
  statusPillFailed: {backgroundColor: '#FCE4DF', color: '#A54436'},
  recordMeta: {fontSize: 13, color: '#71817A'},
  errorText: {fontSize: 13, color: '#A54436'},
  infoText: {fontSize: 13, lineHeight: 19, color: '#95601C'},
  actionRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4},
  actionButton: {minHeight: 38, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 13, borderRadius: 10, backgroundColor: '#E8F1EC'},
  actionButtonDestructive: {backgroundColor: '#FCE8E3'},
  actionButtonText: {fontSize: 13, fontWeight: '800', color: '#1D6258'},
  actionButtonTextDestructive: {color: '#A54436'},
  modalBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(18, 45, 40, 0.48)'},
  detailSheet: {maxHeight: '91%', paddingTop: 11, backgroundColor: '#FFFCF6', borderTopLeftRadius: 28, borderTopRightRadius: 28},
  sheetHandle: {width: 42, height: 4, borderRadius: 4, alignSelf: 'center', backgroundColor: '#CDD6D0', marginBottom: 7},
  detailHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 58, paddingHorizontal: 24, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#E6E4DC'},
  detailTitle: {fontSize: 17, fontWeight: '800', color: '#173A35'},
  backButton: {minWidth: 72, paddingVertical: 11, marginLeft: -6},
  backButtonText: {fontSize: 15, fontWeight: '800', color: '#1D6258'},
  headerSpacer: {minWidth: 72},
  detailContent: {gap: 18, paddingHorizontal: 22, paddingTop: 23, paddingBottom: 40},
  detailIdentity: {gap: 6},
  detailSubject: {fontSize: 22, fontWeight: '800', color: '#173A35'},
  detailStatus: {fontSize: 14, color: '#26705E', fontWeight: '800'},
  detailBlock: {gap: 8, paddingTop: 4},
  detailHeading: {fontSize: 13, letterSpacing: 0.4, fontWeight: '900', color: '#2C6D5F'},
  detailText: {fontSize: 15, lineHeight: 23, color: '#50655D'},
  analysisCard: {gap: 9, padding: 19, borderRadius: 18, borderWidth: 1, borderColor: '#CEE0D5', backgroundColor: '#EAF3EC'},
  analysisState: {fontSize: 22, fontWeight: '800', color: '#173A35'},
  disclaimer: {fontSize: 13, lineHeight: 20, color: '#7D6548', padding: 14, backgroundColor: '#FFF3DC', borderRadius: 12},
  dangerZone: {gap: 10, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#F0D9D5'},
  dangerHint: {fontSize: 13, color: '#A1574A'},
  pressed: {opacity: 0.7},
});
