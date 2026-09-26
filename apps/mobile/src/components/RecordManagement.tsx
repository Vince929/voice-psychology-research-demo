import React, {useCallback, useEffect, useState} from 'react';
import {Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import {
  AnalysisStatus,
  AudioFeatures,
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
import {playRemoteAudio, recordingErrorMessage, stopRemoteAudio, subscribeToPlaybackStopped} from '../services/recorder';
import {getPendingUploadDrafts, resumeUpload, subscribeToUploadProgress, uploadErrorMessage, UploadDraftProgress} from '../services/resumableUpload';

type NoticeTone = 'success' | 'error' | 'info';

type RecordManagementProps = {
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

function formatChartTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

type MetricPoint = {time: number; value: number | null};
type ChartPoint = {x: number; y: number};

type ChartSeries = {
  points: ChartPoint[];
  min: number;
  max: number;
  middle: number;
};

function buildChartSeries(points: MetricPoint[], startTime: number, timeRange: number, width: number, height: number): ChartSeries {
  const values = points.flatMap(point => point.value === null ? [] : [point.value]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const valueRange = max - min;
  return {
    min,
    max,
    middle: (min + max) / 2,
    points: points.map(point => ({
      x: ((point.time - startTime) / timeRange) * width,
      y: point.value === null ? Number.NaN : (valueRange > 0 ? height - ((point.value - min) / valueRange) * height : height / 2),
    })),
  };
}

function TrendLine({points, color, showPoints}: {points: ChartPoint[]; color: string; showPoints?: boolean}) {
  return <View style={[styles.toneLinePath, {width: 210, height: 64}]}>
    {points.slice(1).map((point, index) => {
      const previous = points[index];
      if (!Number.isFinite(previous.y) || !Number.isFinite(point.y)) {
        return null;
      }
      const deltaX = point.x - previous.x;
      const deltaY = point.y - previous.y;
      const length = Math.sqrt(deltaX ** 2 + deltaY ** 2);
      const angle = Math.atan2(deltaY, deltaX) * 180 / Math.PI;
      return <View key={`line-${index}`} style={[styles.toneLineSegment, {width: length, left: previous.x, top: previous.y, backgroundColor: color, transform: [{rotate: `${angle}deg`}]}]} />;
    })}
    {showPoints ? points.filter(point => Number.isFinite(point.y)).map((point, index) => <View key={`point-${index}`} style={[styles.toneLinePoint, {left: point.x - 4, top: point.y - 4, backgroundColor: color}]} />) : null}
  </View>;
}

function AcousticTrend({audioFeatures}: {audioFeatures?: AudioFeatures}) {
  const volumePoints = (audioFeatures?.volume_trend || []).map(point => ({time: point.time_ms, value: point.loudness_dbfs}));
  const pitchPoints = (audioFeatures?.pitch_trend || []).map(point => ({time: point.time_ms, value: point.pitch_hz}));
  if (volumePoints.length === 0) {
    return null;
  }
  const plotWidth = 210;
  const plotHeight = 64;
  const allPoints = [...volumePoints, ...pitchPoints];
  const startTime = Math.min(...allPoints.map(point => point.time));
  const endTime = Math.max(...allPoints.map(point => point.time));
  const timeRange = endTime - startTime || 1;
  const downsample = (points: MetricPoint[]) => {
    const step = Math.max(1, Math.ceil(points.length / 52));
    return points.filter((_, index) => index % step === 0 || index === points.length - 1);
  };
  const volumeSeries = buildChartSeries(downsample(volumePoints), startTime, timeRange, plotWidth, plotHeight);
  const pitchSeries = pitchPoints.some(point => point.value !== null) ? buildChartSeries(downsample(pitchPoints), startTime, timeRange, plotWidth, plotHeight) : null;
return <View style={styles.toneTrendCard}>
<View style={styles.toneTrendHeader}>
<Text style={styles.detailHeading}>音量与声调变化</Text>
<Text style={styles.toneTrendBadge}>{pitchSeries ? '双曲线' : '音量曲线'}</Text>
</View>
<Text style={styles.toneTrendHint}>X 轴：录音时间　左 Y 轴：音量 dBFS　右 Y 轴：基频 F0 Hz</Text>
    <View style={styles.toneLegend}>
      <View style={styles.toneLegendItem}><View style={[styles.toneLegendMark, styles.toneLegendVolume]} /><Text style={styles.toneLegendText}>真实录音音量</Text></View>
      {pitchSeries ? <View style={styles.toneLegendItem}><View style={[styles.toneLegendMark, styles.toneLegendPitch]} /><Text style={styles.toneLegendText}>基频 F0（声调）</Text></View> : null}
    </View>
    <View style={styles.toneChartFrame}>
      <Text style={styles.toneYAxisTop}>{volumeSeries.max.toFixed(1)} dB</Text>
      <Text style={styles.toneYAxisMiddle}>{volumeSeries.middle.toFixed(1)} dB</Text>
      <Text style={styles.toneYAxisBottom}>{volumeSeries.min.toFixed(1)} dB</Text>
      {pitchSeries ? <View><Text style={styles.toneYAxisRightTop}>{pitchSeries.max.toFixed(0)} Hz</Text><Text style={styles.toneYAxisRightMiddle}>{pitchSeries.middle.toFixed(0)} Hz</Text><Text style={styles.toneYAxisRightBottom}>{pitchSeries.min.toFixed(0)} Hz</Text></View> : null}
      <View style={styles.toneChartPlot}>
        <View style={[styles.toneGridLine, styles.toneGridTop]} />
        <View style={[styles.toneGridLine, styles.toneGridMiddle]} />
        <View style={[styles.toneGridLine, styles.toneGridBottom]} />
        <TrendLine points={volumeSeries.points} color="#2F997B" />
        {pitchSeries ? <TrendLine points={pitchSeries.points} color="#C66D3C" /> : null}
      </View>
      <Text style={styles.toneXAxisStart}>{formatChartTime(startTime)}</Text>
      <Text style={styles.toneXAxisEnd}>{formatChartTime(endTime)}</Text>
    </View>
    <Text style={styles.toneTrendNote}>绿色曲线是每 {audioFeatures!.window_ms}ms 计算的短时音量；橙色曲线是有声片段的基频 F0，数值越高表示音高越高。基频是声学特征，不代表情绪或心理状态。</Text>
  </View>;
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

const EMOTION_KEYWORD_LABELS: Record<string, string> = {
  '积极': '积极',
  '低落': '低落',
  '平静': '平静',
  '兴奋': '活跃',
  '紧张': '紧张',
  '低活力': '低活力',
  '稳定': '稳定',
  '波动': '波动',
  '专注': '专注',
};

function emotionKeywordParts(keyword: string) {
  const label = EMOTION_KEYWORD_LABELS[keyword] || keyword;
  const [category, value] = label.split('·');
  return {category: value ? category : '', value: value || category};
}

export function RecordManagement({onNotice}: RecordManagementProps) {
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<CollectionRecord | null>(null);
  const [playingRecordId, setPlayingRecordId] = useState<number | null>(null);
  const [uploadDrafts, setUploadDrafts] = useState<UploadDraftProgress[]>([]);
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

  const loadUploadDrafts = useCallback(async () => {
    try {
      setUploadDrafts(await getPendingUploadDrafts());
    } catch {
      // The persisted local draft is still available even if the server cannot be reached.
    }
  }, []);

  const refreshSelectedRecord = useCallback(async () => {
    if (selectedRecord) {
      setSelectedRecord(await getRecord(selectedRecord.id));
    }
  }, [selectedRecord]);

  useEffect(() => {
    void loadRecords();
    void loadUploadDrafts();
  }, [loadRecords, loadUploadDrafts]);

  useEffect(() => subscribeToUploadProgress(() => {
    void Promise.all([loadUploadDrafts(), loadRecords()]);
  }), [loadRecords, loadUploadDrafts]);

  useEffect(() => subscribeToPlaybackStopped(() => setPlayingRecordId(null)), []);

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

  async function toggleAudio(recordId: number) {
    try {
      if (playingRecordId === recordId) {
        await stopRemoteAudio();
        setPlayingRecordId(null);
        return;
      }
      if (playingRecordId !== null) {
        await stopRemoteAudio();
      }
      await playRemoteAudio(getAudioUrl(recordId));
      setPlayingRecordId(recordId);
    } catch (error) {
      onNotice(`音频播放失败：${recordingErrorMessage(error)}`, 'error');
    }
  }

  async function closeRecordDetail() {
    if (playingRecordId !== null) {
      try {
        await stopRemoteAudio();
      } catch {
        // Closing the detail should not be blocked by a playback cleanup failure.
      }
      setPlayingRecordId(null);
    }
    setSelectedRecord(null);
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

  async function handleResumeUpload(draft: UploadDraftProgress) {
    try {
      await resumeUpload(draft);
      await Promise.all([loadRecords(), loadUploadDrafts()]);
      onNotice('录音上传已完成，已进入转录队列。', 'success');
  } catch (error) {
    console.error('[record-management] Failed to resume upload', {uploadId: draft.uploadId, error});
    await loadUploadDrafts();
    onNotice(`继续上传失败：${uploadErrorMessage(error)}`, 'error');
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
        <Pressable accessibilityRole="button" accessibilityLabel={loading ? '正在刷新录音文件' : '刷新录音文件'} style={({pressed}) => [styles.refreshButton, pressed && styles.pressed]} disabled={loading} onPress={() => { void loadRecords(); void loadUploadDrafts(); }}>
          <Text style={[styles.refreshIcon, loading && styles.refreshIconLoading]}>↻</Text>
        </Pressable>
      </View>
      {records.length === 0 && uploadDrafts.length === 0 && !loading ? (
        <View style={styles.emptyPanel}>
          <Text style={styles.emptyTitle}>还没有录音文件</Text>
          <Text style={styles.empty}>完成一次录音并提交后，转录与分析进度会显示在这里。</Text>
        </View>
      ) : null}
      {uploadDrafts.map(draft => <UploadCard key={draft.idempotencyKey} draft={draft} onResume={() => void handleResumeUpload(draft)} />)}
      {records.map(record => <RecordCard key={record.id} record={record} onDetail={() => void showRecord(record.id)} onRetry={() => void handleRetry(record.id)} onDelete={() => confirmDeleteRecord(record)} />)}
      <Modal visible={selectedRecord !== null} animationType="slide" transparent onRequestClose={() => void closeRecordDetail()}>
        {selectedRecord ? <RecordDetail record={selectedRecord} isPlaying={playingRecordId === selectedRecord.id} onClose={() => void closeRecordDetail()} onTogglePlayback={() => void toggleAudio(selectedRecord.id)} onRetry={() => void handleRetry(selectedRecord.id)} onCancel={() => void handleCancel(selectedRecord.id)} onDeleteRecord={() => confirmDeleteRecord(selectedRecord)} onDeleteSubject={() => confirmDeleteSubject(selectedRecord.subject_id)} /> : null}
      </Modal>
    </View>
  );
}

function UploadCard({draft, onResume}: {draft: UploadDraftProgress; onResume: () => void}) {
  const progress = draft.totalBytes > 0 ? Math.min(100, Math.round(draft.uploadedBytes / draft.totalBytes * 100)) : 0;
  return <View style={[styles.recordCard, styles.uploadCard]}>
    <View style={styles.recordTopRow}>
      <View style={styles.recordTitleWrap}><View style={styles.uploadSignal} /><Text numberOfLines={1} ellipsizeMode="tail" style={styles.recordTitle}>{draft.subject.subject_id}</Text></View>
      <Text style={styles.uploadStatusPill}>{draft.uploading ? '上传中' : '上传已暂停'}</Text>
    </View>
    <View style={styles.uploadProgressHeader}><Text style={styles.uploadProgressText}>已上传 {draft.uploadedPartCount} / {draft.partCount} 个分块</Text><Text style={styles.uploadProgressText}>{progress}%</Text></View>
    <View style={styles.uploadProgressTrack}><View style={[styles.uploadProgressFill, {width: `${progress}%`}]} /></View>
    <Text style={styles.recordTime}>{draft.createdAt ? formatTime(draft.createdAt) : '录音待上传'}</Text>
    {!draft.uploading ? <View style={styles.actionRow}><ActionButton label="继续上传" onPress={onResume} /></View> : <Text style={styles.uploadHint}>上传完成后将自动进入转录与 AI 分析。</Text>}
  </View>;
}

function RecordCard({record, onDetail, onRetry, onDelete}: {record: RecordSummary; onDetail: () => void; onRetry: () => void; onDelete: () => void}) {
  const status = record.task?.status ?? 'failed';
  const hasNotice = Boolean(taskNotice(record.task));
  const canRetry = !record.task || !ACTIVE_STATUSES.includes(status);
  const statusLabel = taskLabel(record.task);
  const keywordPlaceholder = status === 'completed' ? '暂无情感关键词' : '情感关键词生成中';
  const emotionKeywords = Array.isArray(record.emotion_keywords) ? record.emotion_keywords : [];
  return (
    <View style={styles.recordCard}>
      <View style={styles.recordTopRow}>
        <View style={styles.recordTitleWrap}><View style={[styles.recordSignal, status === 'completed' && styles.recordSignalCompleted, status === 'failed' && styles.recordSignalFailed]} /><Text numberOfLines={1} ellipsizeMode="tail" style={styles.recordTitle}>{record.subject_id}</Text></View>
        <Text numberOfLines={1} style={[styles.statusPill, status === 'failed' && styles.statusPillFailed, hasNotice && styles.statusPillWarning, status === 'completed' && !hasNotice && styles.statusPillCompleted]}>{statusLabel}</Text>
      </View>
      {emotionKeywords.length > 0 ? <View style={styles.keywordRow}>{emotionKeywords.map(keyword => {
        const {category, value} = emotionKeywordParts(keyword);
        return <View key={keyword} style={styles.keywordPill}>{category ? <Text style={styles.keywordCategory}>{category} · </Text> : null}<Text style={styles.keywordValue}>{value}</Text></View>;
      })}</View> : <Text style={styles.recordPendingText}>{keywordPlaceholder}</Text>}
      <Text style={styles.recordTime}>{formatTime(record.created_at)}</Text>
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

function RecordDetail({record, isPlaying, onClose, onTogglePlayback, onRetry, onCancel, onDeleteRecord, onDeleteSubject}: {record: CollectionRecord; isPlaying: boolean; onClose: () => void; onTogglePlayback: () => void; onRetry: () => void; onCancel: () => void; onDeleteRecord: () => void; onDeleteSubject: () => void}) {
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
          <PrimaryButton label={isPlaying ? '停止播放' : '播放原始录音'} active={isPlaying} onPress={onTogglePlayback} />
          {isActive ? <ActionButton label="取消当前分析" destructive onPress={onCancel} /> : null}
          {!isActive ? <ActionButton label="重新分析" onPress={onRetry} /> : null}
          {task?.status === 'failed' && taskErrorMessage(task) ? <SectionBlock title="任务状态" value={`${task.failed_stage === 'transcription' ? '转录' : '分析'}失败：${taskErrorMessage(task)}`} /> : null}
          {taskNotice(task) ? <SectionBlock title="转录结果" value={taskNotice(task)!} /> : null}
          {record.transcript ? <SectionBlock title="真实转写" value={record.transcript} /> : null}
          {record.asr_result ? <SectionBlock title="本次分析输入" value={`转写全文、录音时长：${formatDuration(record.asr_result.audio_duration)}、${sentences.length} 个句段，以及 ASR 返回的逐句语速和情感能量${record.analysis_result?.audio_features ? '；同时提取了原始录音的短时音量和动态范围。' : '。'}`} /> : null}
          <AcousticTrend audioFeatures={record.analysis_result?.audio_features} />
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
<View style={styles.analysisHeader}>
<Text style={styles.detailHeading}>情感状态分析预测</Text>
<Text numberOfLines={1} style={styles.analysisBadge}>实验性洞察</Text>
</View>
<Text style={styles.analysisState}>{result.expression_state}</Text>
    <View style={styles.scoreRow}>
      <View style={[styles.scorePill, styles.vitalityPill]}><Text style={styles.scoreLabel}>活力指数</Text><Text style={styles.scoreValue}>{result.vitality_score}<Text style={styles.scoreTotal}> / 100</Text></Text></View>
      <View style={[styles.scorePill, styles.tensionPill]}><Text style={styles.scoreLabel}>紧张度</Text><Text style={styles.scoreValue}>{result.tension_score}<Text style={styles.scoreTotal}> / 100</Text></Text></View>
    </View>
    {result.emotion_dimensions ? <View style={styles.dimensionBlock}>
      <Text style={styles.analysisSectionTitle}>情感维度</Text>
      <View style={styles.dimensionRow}>
        <View style={styles.dimensionItem}><Text style={styles.dimensionLabel}>情感倾向</Text><Text style={styles.dimensionValue}>{result.emotion_dimensions.valence}</Text></View>
        <View style={styles.dimensionItem}><Text style={styles.dimensionLabel}>唤醒水平</Text><Text style={styles.dimensionValue}>{result.emotion_dimensions.arousal}</Text></View>
        <View style={styles.dimensionItem}><Text style={styles.dimensionLabel}>稳定性</Text><Text style={styles.dimensionValue}>{result.emotion_dimensions.stability}</Text></View>
      </View>
    </View> : null}
    <View style={styles.analysisSection}>
      <Text style={styles.analysisSectionTitle}>预测解读</Text><Text style={styles.analysisSectionText}>{result.summary}</Text>
    </View>
    <View style={styles.evidenceBlock}>
      <Text style={styles.analysisSectionTitle}>预测依据</Text>
      {result.evidence.map((evidence, index) => <View key={`${evidence}-${index}`} style={styles.evidenceRow}><View style={styles.evidenceDot} /><Text style={styles.evidenceText}>{evidence}</Text></View>)}
    </View>
    <View style={styles.analysisSection}>
      <Text style={styles.analysisSectionTitle}>状态说明</Text><Text style={styles.analysisSectionText}>{result.suggestion}</Text>
    </View>
  </View>;
}

function SectionBlock({title, value}: {title: string; value: string}) {
  return <View style={styles.detailBlock}><Text style={styles.detailHeading}>{title}</Text><Text style={styles.detailText}>{value}</Text></View>;
}

function PrimaryButton({label, disabled, active, onPress}: {label: string; disabled?: boolean; active?: boolean; onPress: () => void}) {
  return <Pressable disabled={disabled} style={({pressed}) => [styles.button, disabled && styles.buttonDisabled, pressed && !disabled && styles.buttonPressed]} onPress={onPress}><Text style={styles.buttonText}>{label}</Text><Text style={styles.buttonArrow}>{active ? '■' : '→'}</Text></Pressable>;
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
  refreshButton: {width: 46, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#E6F0E9'},
  refreshIcon: {fontSize: 28, lineHeight: 30, color: '#1D6258', fontWeight: '700', includeFontPadding: false, textAlignVertical: 'center', transform: [{translateY: -1}]},
  refreshIconLoading: {opacity: 0.5},
  button: {minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 18, backgroundColor: '#1E6B5B', borderRadius: 16, shadowColor: '#123F38', shadowOpacity: 0.2, shadowRadius: 10, shadowOffset: {width: 0, height: 6}, elevation: 4},
  buttonDisabled: {backgroundColor: '#B9C1BA', shadowOpacity: 0},
  buttonPressed: {transform: [{scale: 0.985}]},
  buttonText: {fontWeight: '800', fontSize: 16, color: '#FFFFFF'},
  buttonArrow: {fontWeight: '800', fontSize: 16, color: '#FFFFFF'},
  emptyPanel: {padding: 25, borderRadius: 20, borderWidth: 1, borderColor: '#D9DED5', borderStyle: 'dashed', backgroundColor: '#FFFCF6', gap: 8},
  emptyTitle: {fontSize: 18, fontWeight: '800', color: '#173A35'},
  empty: {fontSize: 15, lineHeight: 22, color: '#61736B'},
  recordCard: {gap: 10, padding: 18, borderRadius: 20, borderWidth: 1, borderColor: '#E2E1D9', backgroundColor: '#FFFCF6', shadowColor: '#274B43', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: {width: 0, height: 4}, elevation: 2},
  recordCardPressed: {opacity: 0.82, transform: [{scale: 0.99}]},
  recordTopRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8},
  recordTitleWrap: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7},
  recordSignal: {width: 9, height: 9, borderRadius: 5, backgroundColor: '#A4D7B8'},
  recordSignalCompleted: {backgroundColor: '#4F9B7B'},
  recordSignalFailed: {backgroundColor: '#C45A4B'},
  uploadSignal: {width: 9, height: 9, borderRadius: 5, backgroundColor: '#E4A750'},
  recordTitle: {flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21, fontWeight: '800', color: '#173A35'},
  statusPill: {flexShrink: 0, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 99, backgroundColor: '#FFF1D4', fontSize: 11, lineHeight: 15, color: '#95601C', fontWeight: '800'},
  statusPillCompleted: {backgroundColor: '#E1F0E8', color: '#246A59'},
  statusPillWarning: {backgroundColor: '#FFF1D4', color: '#95601C'},
  statusPillFailed: {backgroundColor: '#FCE4DF', color: '#A54436'},
  uploadCard: {borderColor: '#EAD5B5', backgroundColor: '#FFFCF6'},
  uploadStatusPill: {flexShrink: 0, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 99, backgroundColor: '#FFF0D5', fontSize: 11, lineHeight: 15, color: '#9A621C', fontWeight: '800'},
  uploadProgressHeader: {flexDirection: 'row', justifyContent: 'space-between', gap: 12},
  uploadProgressText: {fontSize: 12, color: '#6F7063', fontWeight: '700'},
  uploadProgressTrack: {height: 7, overflow: 'hidden', borderRadius: 99, backgroundColor: '#F1E4CF'},
  uploadProgressFill: {height: '100%', borderRadius: 99, backgroundColor: '#D9953D'},
  uploadHint: {fontSize: 12, lineHeight: 18, color: '#8B6C42'},
  keywordRow: {minHeight: 25, flexDirection: 'row', flexWrap: 'wrap', gap: 6},
  keywordPill: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 99, backgroundColor: '#E1F0E8'},
  keywordCategory: {fontSize: 12, lineHeight: 16, fontWeight: '800', color: '#246A59'},
  keywordValue: {fontSize: 12, lineHeight: 16, fontWeight: '800', color: '#246A59'},
  recordPendingText: {flex: 1, fontSize: 13, color: '#71817A'},
  recordTime: {marginTop: 1, fontSize: 12, color: '#71817A'},
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
  toneTrendCard: {gap: 10, padding: 16, borderRadius: 18, borderWidth: 1, borderColor: '#CFE5DA', backgroundColor: '#F0F7F2'},
toneTrendHeader: {flexDirection: 'row', alignItems: 'center', gap: 8},
toneTrendHint: {fontSize: 12, lineHeight: 17, color: '#667C72'},
  toneLegend: {flexDirection: 'row', flexWrap: 'wrap', gap: 12},
  toneLegendItem: {flexDirection: 'row', alignItems: 'center', gap: 5},
  toneLegendMark: {width: 16, height: 3, borderRadius: 3},
  toneLegendVolume: {backgroundColor: '#2F997B'},
  toneLegendPitch: {backgroundColor: '#C66D3C'},
  toneLegendEnergy: {backgroundColor: '#8B5CC7'},
  toneLegendText: {fontSize: 11, color: '#567066'},
  toneTrendBadge: {flexShrink: 0, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 99, backgroundColor: '#D8EEE1', fontSize: 11, fontWeight: '800', color: '#216D5C'},
  toneChartFrame: {height: 118, marginTop: 2, position: 'relative'},
  toneChartPlot: {position: 'absolute', left: 28, right: 28, top: 10, height: 64, borderLeftWidth: 1, borderBottomWidth: 1, borderColor: '#9ECBB5'},
  toneGridLine: {position: 'absolute', left: 0, right: 0, borderTopWidth: 1, borderColor: '#D6E8DE', borderStyle: 'dashed'},
  toneGridTop: {top: 0},
  toneGridMiddle: {top: 32},
  toneGridBottom: {bottom: 0},
  toneLinePath: {position: 'absolute'},
  toneLineSegment: {position: 'absolute', height: 3, marginTop: -1.5, borderRadius: 4, backgroundColor: '#2F997B', transformOrigin: 'left center'},
  toneLinePoint: {position: 'absolute', width: 8, height: 8, borderRadius: 4, borderWidth: 2, borderColor: '#FFFFFF', backgroundColor: '#E3A653', shadowColor: '#1E6B5B', shadowOpacity: 0.22, shadowRadius: 3, shadowOffset: {width: 0, height: 1}, elevation: 2},
  toneYAxisTop: {position: 'absolute', top: 2, left: 0, fontSize: 10, color: '#577268'},
  toneYAxisMiddle: {position: 'absolute', top: 34, left: 0, fontSize: 10, color: '#577268'},
  toneYAxisBottom: {position: 'absolute', top: 66, left: 0, fontSize: 10, color: '#577268'},
  toneYAxisRightTop: {position: 'absolute', top: 2, right: 0, fontSize: 10, color: '#A15A31'},
  toneYAxisRightMiddle: {position: 'absolute', top: 34, right: 0, fontSize: 10, color: '#A15A31'},
  toneYAxisRightBottom: {position: 'absolute', top: 66, right: 0, fontSize: 10, color: '#A15A31'},
  toneXAxisStart: {position: 'absolute', left: 28, top: 79, fontSize: 10, color: '#577268'},
  toneXAxisEnd: {position: 'absolute', right: 28, top: 79, fontSize: 10, color: '#577268'},
  toneTrendNote: {fontSize: 11, lineHeight: 16, color: '#6B7D75'},
  detailHeading: {fontSize: 13, letterSpacing: 0.4, fontWeight: '900', color: '#2C6D5F'},
  detailText: {fontSize: 15, lineHeight: 23, color: '#50655D'},
  analysisCard: {gap: 14, padding: 18, borderRadius: 18, borderWidth: 1, borderColor: '#CEE0D5', backgroundColor: '#EAF3EC'},
analysisHeader: {flexDirection: 'row', alignItems: 'center', gap: 8},
analysisState: {marginTop: -8, fontSize: 22, fontWeight: '800', color: '#173A35'},
  analysisBadge: {flexShrink: 0, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 99, backgroundColor: '#D8EEE1', fontSize: 11, fontWeight: '800', color: '#216D5C'},
  scoreRow: {flexDirection: 'row', gap: 9},
  scorePill: {flex: 1, gap: 3, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 14},
  vitalityPill: {backgroundColor: '#D9EEE3'},
  tensionPill: {backgroundColor: '#F8E9D8'},
  scoreLabel: {fontSize: 12, fontWeight: '800', color: '#5C756B'},
  scoreValue: {fontSize: 22, lineHeight: 27, fontWeight: '900', color: '#173A35'},
  scoreTotal: {fontSize: 12, fontWeight: '700', color: '#668078'},
  dimensionBlock: {gap: 8, padding: 13, borderRadius: 14, backgroundColor: '#F8FCF8', borderWidth: 1, borderColor: '#D6E8DE'},
  dimensionRow: {flexDirection: 'row', gap: 8},
  dimensionItem: {flex: 1, minWidth: 0, gap: 4},
  dimensionLabel: {fontSize: 11, lineHeight: 15, color: '#6A8076'},
  dimensionValue: {fontSize: 13, lineHeight: 18, fontWeight: '800', color: '#235E52'},
  analysisSection: {gap: 6, paddingHorizontal: 2},
  analysisSectionTitle: {fontSize: 12, letterSpacing: 0.4, fontWeight: '900', color: '#2C6D5F'},
  analysisSectionText: {fontSize: 14, lineHeight: 22, color: '#50655D'},
  evidenceBlock: {gap: 8, padding: 13, borderRadius: 14, backgroundColor: '#FFFDF7', borderWidth: 1, borderColor: '#E4E8DE'},
  evidenceRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 8},
  evidenceDot: {width: 6, height: 6, marginTop: 7, borderRadius: 3, backgroundColor: '#5EAA87'},
  evidenceText: {flex: 1, fontSize: 14, lineHeight: 21, color: '#50655D'},
  disclaimer: {fontSize: 13, lineHeight: 20, color: '#7D6548', padding: 14, backgroundColor: '#FFF3DC', borderRadius: 12},
  dangerZone: {gap: 10, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#F0D9D5'},
  dangerHint: {fontSize: 13, color: '#A1574A'},
  pressed: {opacity: 0.7},
});
