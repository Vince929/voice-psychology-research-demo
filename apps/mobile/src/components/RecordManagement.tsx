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
  onStartNew: () => void;
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

export function RecordManagement({onStartNew, onNotice}: RecordManagementProps) {
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
          <Text style={styles.body}>转录和 AI 分析在后台任务中执行，处理中会自动刷新状态。</Text>
        </View>
        <Pressable style={styles.refreshButton} disabled={loading} onPress={() => void loadRecords()}>
          <Text style={styles.refreshButtonText}>{loading ? '刷新中' : '刷新'}</Text>
        </Pressable>
      </View>
      {records.length === 0 && !loading ? (
        <View style={styles.emptyPanel}>
          <Text style={styles.emptyTitle}>还没有录音文件</Text>
          <Text style={styles.empty}>完成一次录音并提交后，转录与分析进度会显示在这里。</Text>
        </View>
      ) : null}
      {records.map(record => <RecordCard key={record.id} record={record} onDetail={() => void showRecord(record.id)} onDelete={() => confirmDeleteRecord(record)} />)}
      <PrimaryButton label="开始新的采集" onPress={onStartNew} />
      <Modal visible={selectedRecord !== null} animationType="slide" transparent onRequestClose={() => setSelectedRecord(null)}>
        {selectedRecord ? <RecordDetail record={selectedRecord} onClose={() => setSelectedRecord(null)} onPlay={() => void openAudio(selectedRecord.id)} onStop={() => void stopAudio()} onRetry={() => void handleRetry(selectedRecord.id)} onCancel={() => void handleCancel(selectedRecord.id)} onDeleteRecord={() => confirmDeleteRecord(selectedRecord)} onDeleteSubject={() => confirmDeleteSubject(selectedRecord.subject_id)} /> : null}
      </Modal>
    </View>
  );
}

function RecordCard({record, onDetail, onDelete}: {record: RecordSummary; onDetail: () => void; onDelete: () => void}) {
  const status = record.task?.status ?? 'failed';
  const failureLabel = record.task?.failed_stage === 'transcription' ? '转录失败' : STATUS_LABELS[status];
  return (
    <View style={styles.recordCard}>
      <View style={styles.recordTopRow}>
        <Text style={styles.recordTitle}>{record.subject_id}</Text>
        <Text style={[styles.statusPill, status === 'failed' && styles.statusPillFailed, status === 'completed' && styles.statusPillCompleted]}>{failureLabel}</Text>
      </View>
      <Text style={styles.recordMeta}>{record.audio_filename} · {formatTime(record.created_at)}</Text>
      {record.task?.status === 'failed' ? <Text style={styles.errorText}>{record.task.error_message || '任务处理失败，可查看详情后重新分析。'}</Text> : null}
      <View style={styles.actionRow}>
        <ActionButton label="详情" onPress={onDetail} />
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
        <View style={styles.detailHeader}>
          <Pressable style={styles.backButton} onPress={onClose}><Text style={styles.backButtonText}>‹ 返回</Text></Pressable>
          <Text style={styles.detailTitle}>录音详情</Text>
          <View style={styles.headerSpacer} />
        </View>
        <ScrollView contentContainerStyle={styles.detailContent}>
          <View style={styles.detailIdentity}>
            <Text style={styles.detailSubject}>{record.subject_id}</Text>
            <Text style={styles.detailText}>{formatTime(record.created_at)}</Text>
            {task ? <Text style={styles.detailStatus}>{task.status === 'failed' && task.failed_stage === 'transcription' ? '转录失败' : STATUS_LABELS[task.status]}</Text> : null}
          </View>
          <Text style={styles.detailText}>年龄段：{record.age_group || '未填写'}　性别：{record.gender || '未填写'}</Text>
          <Text style={styles.detailText}>语言：{record.language || '普通话'}　环境：{record.recording_environment || '未填写'}</Text>
          <PrimaryButton label="播放原始录音" onPress={onPlay} />
          <ActionButton label="停止播放" onPress={onStop} />
          {isActive ? <ActionButton label="取消当前分析" destructive onPress={onCancel} /> : null}
          {task?.status === 'failed' ? <ActionButton label="重新分析" onPress={onRetry} /> : null}
          {task?.error_message ? <SectionBlock title="任务状态" value={`${task.failed_stage === 'transcription' ? '转录' : '分析'}失败：${task.error_message}`} /> : null}
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
  return <Pressable disabled={disabled} style={[styles.button, disabled && styles.buttonDisabled]} onPress={onPress}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

function ActionButton({label, destructive, onPress}: {label: string; destructive?: boolean; onPress: () => void}) {
  return <Pressable style={[styles.actionButton, destructive && styles.actionButtonDestructive]} onPress={onPress}><Text style={[styles.actionButtonText, destructive && styles.actionButtonTextDestructive]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  section: {gap: 18}, titleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16}, titleCopy: {flex: 1, gap: 5}, heading: {fontSize: 25, letterSpacing: -0.5, fontWeight: '800', color: '#163C36'}, body: {fontSize: 15, lineHeight: 22, color: '#52706A'}, refreshButton: {minHeight: 42, minWidth: 68, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#E1EEEA'}, refreshButtonText: {fontSize: 14, fontWeight: '700', color: '#1B6559'}, button: {minHeight: 50, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, backgroundColor: '#1B6559', borderRadius: 12}, buttonDisabled: {backgroundColor: '#9DB6B0'}, buttonText: {fontWeight: '800', fontSize: 16, color: '#FFFFFF'}, emptyPanel: {padding: 24, borderRadius: 16, borderWidth: 1, borderColor: '#C8D8D2', borderStyle: 'dashed', backgroundColor: '#F7FBF9', gap: 8}, emptyTitle: {fontSize: 17, fontWeight: '800', color: '#163C36'}, empty: {fontSize: 15, lineHeight: 22, color: '#52706A'}, recordCard: {gap: 10, padding: 18, borderRadius: 16, borderLeftWidth: 4, borderLeftColor: '#6FA597', backgroundColor: '#FAFCFB'}, recordTopRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12}, recordTitle: {flex: 1, fontSize: 18, fontWeight: '800', color: '#163C36'}, statusPill: {paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: '#FFF3D9', fontSize: 12, color: '#8A5A12', fontWeight: '700'}, statusPillCompleted: {backgroundColor: '#E1EEEA', color: '#285C52'}, statusPillFailed: {backgroundColor: '#FBE7E5', color: '#A43F35'}, recordMeta: {fontSize: 14, color: '#52706A'}, errorText: {fontSize: 13, color: '#A43F35'}, actionRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4}, actionButton: {minHeight: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#E1EEEA'}, actionButtonDestructive: {backgroundColor: '#FBE7E5'}, actionButtonText: {fontWeight: '700', color: '#1B6559'}, actionButtonTextDestructive: {color: '#A43F35'}, modalBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(19, 51, 47, 0.36)'}, detailSheet: {maxHeight: '91%', paddingTop: 16, backgroundColor: '#FAFCFB', borderTopLeftRadius: 26, borderTopRightRadius: 26}, detailHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 58, paddingHorizontal: 28, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#E2ECE8'}, detailTitle: {fontSize: 17, fontWeight: '800', color: '#163C36'}, backButton: {minWidth: 72, paddingVertical: 11, marginLeft: -6}, backButtonText: {fontSize: 15, fontWeight: '700', color: '#1B6559'}, headerSpacer: {minWidth: 72}, detailContent: {gap: 18, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 40}, detailIdentity: {gap: 6}, detailSubject: {fontSize: 21, fontWeight: '800', color: '#163C36'}, detailStatus: {fontSize: 14, color: '#285C52', fontWeight: '800'}, detailBlock: {gap: 8, paddingTop: 4}, detailHeading: {fontSize: 14, fontWeight: '800', color: '#285C52'}, detailText: {fontSize: 15, lineHeight: 23, color: '#46645E'}, analysisCard: {gap: 9, padding: 18, borderRadius: 14, backgroundColor: '#E8F0EE'}, analysisState: {fontSize: 21, fontWeight: '800', color: '#163C36'}, disclaimer: {fontSize: 13, lineHeight: 20, color: '#7A6652', padding: 14, backgroundColor: '#FFF8EC', borderRadius: 10}, dangerZone: {gap: 10, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#F0D9D5'}, dangerHint: {fontSize: 13, color: '#9B4B43'},
});
