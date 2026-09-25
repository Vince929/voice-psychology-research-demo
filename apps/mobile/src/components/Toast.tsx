import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet, Text, View} from 'react-native';

type ToastProps = {
  message: string | null;
  tone?: 'success' | 'error' | 'info';
  onDismiss: () => void;
};

export function Toast({message, tone = 'info', onDismiss}: ToastProps) {
  const translateY = useRef(new Animated.Value(-14)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!message) {
      return;
    }
    opacity.setValue(0);
    translateY.setValue(-14);
    Animated.parallel([
      Animated.timing(opacity, {toValue: 1, duration: 190, useNativeDriver: true}),
      Animated.spring(translateY, {toValue: 0, damping: 16, stiffness: 210, mass: 0.72, useNativeDriver: true}),
    ]).start();
    const timer = setTimeout(onDismiss, 2400);
    return () => clearTimeout(timer);
  }, [message, onDismiss, opacity, translateY]);

  if (!message) {
    return null;
  }

  const symbol = tone === 'success' ? '✓' : tone === 'error' ? '!' : 'i';
  return (
    <View pointerEvents="none" style={styles.container}>
      <Animated.View style={[styles.toast, tone === 'success' && styles.success, tone === 'error' && styles.error, {opacity, transform: [{translateY}]}]}>
        <View style={[styles.marker, tone === 'success' && styles.markerSuccess, tone === 'error' && styles.markerError]}><Text style={styles.markerText}>{symbol}</Text></View>
        <Text style={styles.message}>{message}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {position: 'absolute', top: '20%', left: 18, right: 18, zIndex: 20},
  toast: {flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, paddingHorizontal: 14, borderRadius: 16, backgroundColor: '#173F39', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', shadowColor: '#102E2A', shadowOpacity: 0.28, shadowRadius: 18, shadowOffset: {width: 0, height: 9}, elevation: 7},
  success: {backgroundColor: '#1D6A5A'},
  error: {backgroundColor: '#A54335'},
  marker: {width: 23, height: 23, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E9B35B'},
  markerSuccess: {backgroundColor: '#BEE0CE'},
  markerError: {backgroundColor: '#F6C7BD'},
  markerText: {fontSize: 13, lineHeight: 16, color: '#163C36', fontWeight: '900'},
  message: {flex: 1, color: '#FFFFFF', fontSize: 14, lineHeight: 20, fontWeight: '700'},
});
