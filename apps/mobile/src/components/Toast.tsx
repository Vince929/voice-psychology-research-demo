import React, {useEffect} from 'react';
import {StyleSheet, Text, View} from 'react-native';

type ToastProps = {
  message: string | null;
  tone?: 'success' | 'error' | 'info';
  onDismiss: () => void;
};

export function Toast({message, tone = 'info', onDismiss}: ToastProps) {
  useEffect(() => {
    if (!message) {
      return;
    }
    const timer = setTimeout(onDismiss, 1600);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) {
    return null;
  }

  return (
    <View pointerEvents="none" style={styles.container}>
      <View style={[styles.toast, tone === 'success' && styles.success, tone === 'error' && styles.error]}>
        <View style={styles.marker} />
        <Text style={styles.message}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {position: 'absolute', top: '50%', left: 20, right: 20, zIndex: 20, transform: [{translateY: -36}]},
  toast: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13, paddingHorizontal: 15, borderRadius: 14, backgroundColor: '#163C36', shadowColor: '#163C36', shadowOpacity: 0.16, shadowRadius: 14, shadowOffset: {width: 0, height: 8}, elevation: 5},
  success: {backgroundColor: '#1B6559'},
  error: {backgroundColor: '#A43F35'},
  marker: {width: 7, height: 7, borderRadius: 4, backgroundColor: '#D7EFE8'},
  message: {flex: 1, color: '#FFFFFF', fontSize: 14, lineHeight: 20, fontWeight: '600'},
});
