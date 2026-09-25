import React, {useEffect, useState} from 'react';
import {Modal, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';

import {ApiEnvironment, LOCAL_API_BASE_URL} from '../config/api';

type ApiEnvironmentSelectorProps = {
  environment: ApiEnvironment;
  productionApiBaseUrl: string;
  visible: boolean;
  onDismiss: () => void;
  onSave: (environment: ApiEnvironment, productionApiBaseUrl: string) => Promise<void>;
};

export function ApiEnvironmentSelector({environment, productionApiBaseUrl, visible, onDismiss, onSave}: ApiEnvironmentSelectorProps) {
  const [selectedEnvironment, setSelectedEnvironment] = useState<ApiEnvironment>(environment);
  const [apiBaseUrl, setApiBaseUrl] = useState(productionApiBaseUrl);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setSelectedEnvironment(environment);
      setApiBaseUrl(productionApiBaseUrl);
    }
  }, [environment, productionApiBaseUrl, visible]);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(selectedEnvironment, apiBaseUrl);
      onDismiss();
    } finally {
      setSaving(false);
    }
  }

  return <Modal animationType="fade" transparent visible={visible} onRequestClose={onDismiss}>
    <View style={styles.backdrop}>
      <View style={styles.panel}>
        <Text style={styles.eyebrow}>API CONNECTION</Text>
        <Text style={styles.title}>切换服务环境</Text>
        <Text style={styles.description}>本地环境适用于调试；线上环境需要填写部署后的 API 地址。</Text>
        <View style={styles.optionGroup}>
          <Pressable accessibilityRole="radio" accessibilityState={{checked: selectedEnvironment === 'local'}} style={({pressed}) => [styles.option, selectedEnvironment === 'local' && styles.optionActive, pressed && styles.pressed]} onPress={() => setSelectedEnvironment('local')}>
            <Text style={styles.optionTitle}>本地 API</Text>
            <Text style={styles.optionDetail}>{LOCAL_API_BASE_URL}</Text>
          </Pressable>
          <Pressable accessibilityRole="radio" accessibilityState={{checked: selectedEnvironment === 'production'}} style={({pressed}) => [styles.option, selectedEnvironment === 'production' && styles.optionActive, pressed && styles.pressed]} onPress={() => setSelectedEnvironment('production')}>
            <Text style={styles.optionTitle}>线上 API</Text>
            <Text style={styles.optionDetail}>{apiBaseUrl || '请填写线上 API 地址'}</Text>
          </Pressable>
        </View>
        <Text style={styles.inputLabel}>线上 API 地址</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          editable={!saving}
          keyboardType="url"
          placeholder="https://example.com/api"
          placeholderTextColor="#91A39B"
          style={styles.input}
          value={apiBaseUrl}
          onChangeText={setApiBaseUrl}
        />
        <View style={styles.actions}>
          <Pressable disabled={saving} style={({pressed}) => [styles.cancelButton, pressed && !saving && styles.pressed]} onPress={onDismiss}><Text style={styles.cancelButtonText}>取消</Text></Pressable>
          <Pressable disabled={saving} style={({pressed}) => [styles.saveButton, saving && styles.saveButtonDisabled, pressed && !saving && styles.pressed]} onPress={() => void handleSave()}><Text style={styles.saveButtonText}>{saving ? '保存中…' : '保存并切换'}</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, justifyContent: 'center', padding: 20, backgroundColor: 'rgba(10, 35, 30, 0.56)'},
  panel: {gap: 14, padding: 22, borderRadius: 24, backgroundColor: '#FFFCF6'},
  eyebrow: {fontSize: 11, letterSpacing: 1.4, fontWeight: '900', color: '#287A6A'},
  title: {fontSize: 25, letterSpacing: -0.6, fontWeight: '800', color: '#173A35'},
  description: {fontSize: 14, lineHeight: 21, color: '#587068'},
  optionGroup: {gap: 9},
  option: {gap: 3, padding: 13, borderRadius: 14, borderWidth: 1, borderColor: '#D9DFD6', backgroundColor: '#FBFBF6'},
  optionActive: {borderColor: '#287A6A', backgroundColor: '#E8F3ED'},
  optionTitle: {fontSize: 15, fontWeight: '800', color: '#173A35'},
  optionDetail: {fontSize: 12, lineHeight: 17, color: '#60766E'},
  inputLabel: {marginTop: 2, fontSize: 13, fontWeight: '800', color: '#465E56'},
  input: {height: 47, paddingHorizontal: 13, borderRadius: 12, borderWidth: 1, borderColor: '#D9DFD6', backgroundColor: '#F7F8F3', color: '#173A35', fontSize: 14},
  actions: {flexDirection: 'row', gap: 10, marginTop: 4},
  cancelButton: {flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: '#BFD4C8'},
  cancelButtonText: {fontSize: 15, fontWeight: '800', color: '#1D6258'},
  saveButton: {flex: 1.55, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#1E6B5B'},
  saveButtonDisabled: {backgroundColor: '#8FAFA3'},
  saveButtonText: {fontSize: 15, fontWeight: '800', color: '#FFFFFF'},
  pressed: {opacity: 0.74},
});
