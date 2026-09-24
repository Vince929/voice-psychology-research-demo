import React, {useCallback, useEffect, useState} from 'react';
import {Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import {
  CollectionRecord,
  deleteRecord,
  deleteSubjectRecords,
  getAudioUrl,
  getRecord,
  listRecords,
  RecordSummary,
} from '../services/api';
import {playRemoteAudio, recordingErrorMessage, stopRemoteAudio} from '../services/recorder';

type RecordManagementProps = {
  onStartNew: () => void;
};

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {hour12: false});
}

export function RecordManagement({onStartNew}: RecordManagementProps) {
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<CollectionRecord | null>(null);
  const [loading, setLoading] = useState(false);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      setRecords(await listRecords());
    } catch {
      Alert.alert('加载失败', '请确认本地 FastAPI 服务已启动。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  async function showRecord(recordId: number) {
    try {
      setSelectedRecord(await getRecord(recordId));
    } catch {
      Alert.alert('加载详情失败', '该记录可能已被删除，请刷新列表。');
    }
  }

  async function openAudio(recordId: number) {
    try {
      await playRemoteAudio(getAudioUrl(recordId));
    } catch (error) {
      Alert.alert('无法播放', `音频播放失败：${recordingErrorMessage(error)}`);
    }
  }

  async function stopAudio() {
    try {
      await stopRemoteAudio();
    } catch (error) {
      Alert.alert('停止播放失败', recordingErrorMessage(error));
    }
  }

  function confirmDeleteRecord(record: RecordSummary) {
    Alert.alert('删除本条记录？', '将永久删除对应问卷和音频文件，且无法恢复。', [
      {text: '取消', style: 'cancel'},
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteRecord(record.id);
            setSelectedRecord(null);
            await loadRecords();
          } catch {
            Alert.alert('删除失败', '请确认本地服务可用后重试。');
          }
        },
      },
    ]);
  }

  function confirmDeleteSubject(subjectId: string) {
    Alert.alert('删除该受试者全部数据？', '这会永久清理该匿名编号的全部问卷和音频，且无法恢复。', [
      {text: '取消', style: 'cancel'},
      {
        text: '删除全部',
        style: 'destructive',
        onPress: async () => {
          try {
            const result = await deleteSubjectRecords(subjectId);
            setSelectedRecord(null);
            await loadRecords();
            Alert.alert('已删除', `已清理 ${result.deleted_count} 条记录及对应音频。`);
          } catch {
            Alert.alert('删除失败', '请确认本地服务可用后重试。');
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>记录管理</Text>
      <Text style={styles.body}>可查看问卷、用系统播放器打开音频，或按伦理要求永久删除单条及某匿名受试者的全部数据。</Text>
      <PrimaryButton label={loading ? '正在刷新…' : '刷新列表'} disabled={loading} onPress={() => void loadRecords()} />
      {records.length === 0 && !loading ? <Text style={styles.empty}>暂无已保存记录。</Text> : null}
      {records.map(record => (
        <View key={record.id} style={styles.recordCard}>
          <Text style={styles.recordTitle}>{record.subject_id}</Text>
          <Text style={styles.recordMeta}>{formatTime(record.created_at)} · PHQ-9 原始分：{record.phq9_total}</Text>
          <View style={styles.actionRow}>
            <ActionButton label="详情" onPress={() => void showRecord(record.id)} />
            <ActionButton label="播放音频" onPress={() => void openAudio(record.id)} />
            <ActionButton label="删除" destructive onPress={() => confirmDeleteRecord(record)} />
          </View>
        </View>
      ))}
      <PrimaryButton label="开始新的采集" onPress={onStartNew} />
      <Modal visible={selectedRecord !== null} animationType="slide" transparent onRequestClose={() => setSelectedRecord(null)}>
        {selectedRecord ? <RecordDetail record={selectedRecord} onClose={() => setSelectedRecord(null)} onPlay={() => void openAudio(selectedRecord.id)} onStop={() => void stopAudio()} onDeleteRecord={() => confirmDeleteRecord(selectedRecord)} onDeleteSubject={() => confirmDeleteSubject(selectedRecord.subject_id)} /> : null}
      </Modal>
    </View>
  );
}

function RecordDetail({record, onClose, onPlay, onStop, onDeleteRecord, onDeleteSubject}: {record: CollectionRecord; onClose: () => void; onPlay: () => void; onStop: () => void; onDeleteRecord: () => void; onDeleteSubject: () => void}) {
  return (
    <View style={styles.modalBackdrop}>
      <View style={styles.detailSheet}>
        <View style={styles.detailHeader}>
          <Text style={styles.heading}>记录详情</Text>
          <Pressable style={styles.backButton} onPress={onClose}><Text style={styles.backButtonText}>返回列表</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.detailContent}>
        <Text style={styles.detailText}>匿名编号：{record.subject_id}</Text>
        <Text style={styles.detailText}>年龄段：{record.age_group || '未填写'} · 性别：{record.gender || '未填写'}</Text>
        <Text style={styles.detailText}>采集时间：{formatTime(record.created_at)}</Text>
        <Text style={styles.detailHeading}>PHQ-9 作答</Text>
        <Text style={styles.detailText}>{JSON.stringify(record.phq9_answers)}</Text>
        <Text style={styles.detailHeading}>偏好问卷作答</Text>
        <Text style={styles.detailText}>{JSON.stringify(record.mbti_answers)}</Text>
        {record.analysis_result ? <><Text style={styles.detailHeading}>调试模拟分析</Text><Text style={styles.detailText}>{JSON.stringify(record.analysis_result)}</Text></> : null}
        <PrimaryButton label="播放音频" onPress={onPlay} />
        <ActionButton label="停止播放" onPress={onStop} />
        <ActionButton label="删除本条记录" destructive onPress={onDeleteRecord} />
        <ActionButton label="删除该受试者全部数据" destructive onPress={onDeleteSubject} />
        <Pressable onPress={onClose}><Text style={styles.link}>返回记录列表</Text></Pressable>
        </ScrollView>
      </View>
    </View>
  );
}

function PrimaryButton({label, disabled, onPress}: {label: string; disabled?: boolean; onPress: () => void}) {
  return <Pressable disabled={disabled} style={[styles.button, disabled && styles.buttonDisabled]} onPress={onPress}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

function ActionButton({label, destructive, onPress}: {label: string; destructive?: boolean; onPress: () => void}) {
  return <Pressable style={[styles.actionButton, destructive && styles.actionButtonDestructive]} onPress={onPress}><Text style={[styles.actionButtonText, destructive && styles.actionButtonTextDestructive]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  section: {gap: 16}, heading: {fontSize: 24, fontWeight: '800', color: '#163C36'}, body: {fontSize: 16, lineHeight: 25, color: '#385650'}, button: {alignItems: 'center', padding: 16, backgroundColor: '#1B6559', borderRadius: 12}, buttonDisabled: {backgroundColor: '#9DB6B0'}, buttonText: {fontWeight: '800', fontSize: 16, color: '#FFFFFF'}, empty: {textAlign: 'center', padding: 30, color: '#4A716B'}, recordCard: {gap: 8, padding: 16, borderRadius: 12, backgroundColor: '#FFFFFF'}, recordTitle: {fontSize: 18, fontWeight: '800', color: '#163C36'}, recordMeta: {fontSize: 14, color: '#4A716B'}, actionRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4}, actionButton: {paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8, backgroundColor: '#E1EEEA'}, actionButtonDestructive: {backgroundColor: '#FBE7E5'}, actionButtonText: {fontWeight: '700', color: '#1B6559'}, actionButtonTextDestructive: {color: '#A43F35'}, modalBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(19, 51, 47, 0.36)'}, detailSheet: {maxHeight: '90%', paddingTop: 20, backgroundColor: '#F8FBFA', borderTopLeftRadius: 24, borderTopRightRadius: 24}, detailHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingBottom: 14}, backButton: {paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8, backgroundColor: '#E1EEEA'}, backButtonText: {fontWeight: '700', color: '#1B6559'}, detailContent: {gap: 14, paddingHorizontal: 24, paddingBottom: 32}, detailHeading: {fontSize: 16, fontWeight: '800', color: '#163C36', marginTop: 4}, detailText: {fontSize: 15, lineHeight: 23, color: '#385650'}, link: {textAlign: 'center', color: '#1B6559', fontWeight: '700', padding: 10},
});
