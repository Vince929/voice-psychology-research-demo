import React from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';

export const colors = {
  bg: '#F6F2EA',
  card: '#FFFCF6',
  ink: '#173A35',
  body: '#4D625B',
  muted: '#75847B',
  primary: '#1E6B5B',
  primaryDark: '#153B36',
  border: '#E2E1D9',
  danger: '#B04E3C',
  warn: '#C97F2E',
  ok: '#2F7A4D',
  onPrimary: '#FFFFFF',
};

export const ui = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  content: {paddingHorizontal: 20, paddingTop: 18, paddingBottom: 44, gap: 16},
  heading: {fontSize: 26, letterSpacing: -0.8, fontWeight: '800', color: colors.ink},
  body: {fontSize: 15, lineHeight: 24, color: colors.body},
  label: {fontSize: 13, letterSpacing: 0.3, fontWeight: '800', color: '#465E56'},
  input: {
    backgroundColor: '#F4F5EF',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 16,
    color: colors.ink,
    borderWidth: 1,
    borderColor: '#E1E4DB',
  },
  card: {gap: 12, padding: 16, borderRadius: 18, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border},
  field: {gap: 9},
  choiceGroup: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  choice: {paddingVertical: 10, paddingHorizontal: 13, borderRadius: 99, borderWidth: 1, borderColor: '#D9DFD6', backgroundColor: '#FBFBF6'},
  choiceActive: {backgroundColor: colors.primaryDark, borderColor: colors.primaryDark},
  choiceText: {color: '#4C625B', fontSize: 14, fontWeight: '600'},
  choiceTextActive: {color: '#FFFFFF', fontWeight: '800'},
  button: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 20,
    backgroundColor: colors.primary,
    borderRadius: 16,
    shadowColor: '#123F38',
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: {width: 0, height: 6},
    elevation: 4,
  },
  buttonDisabled: {backgroundColor: '#C6C7BD', shadowOpacity: 0, elevation: 0},
  buttonText: {fontWeight: '800', fontSize: 16, color: colors.onPrimary},
  secondaryButton: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#BFD4C8',
    backgroundColor: '#F8FBF8',
    paddingHorizontal: 16,
  },
  secondaryButtonText: {fontSize: 14, fontWeight: '800', color: colors.primary},
  errorText: {fontSize: 13, lineHeight: 19, color: colors.danger, fontWeight: '700'},
  hint: {fontSize: 12, color: colors.muted, fontWeight: '600'},
  pressed: {opacity: 0.72},
});

export function PrimaryButton({label, disabled, onPress}: {label: string; disabled?: boolean; onPress: () => void}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={({pressed}) => [ui.button, disabled && ui.buttonDisabled, pressed && !disabled && ui.pressed]}
      onPress={onPress}>
      <Text style={ui.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function SecondaryButton({label, disabled, onPress}: {label: string; disabled?: boolean; onPress: () => void}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={({pressed}) => [ui.secondaryButton, pressed && !disabled && ui.pressed]}
      onPress={onPress}>
      <Text style={ui.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

export function Choice({
  label,
  value,
  choices,
  onChange,
}: {
  label?: string;
  value: string;
  choices: string[];
  onChange: (value: string) => void;
}) {
  return (
    <View style={ui.field}>
      {label ? <Text style={ui.label}>{label}</Text> : null}
      <View style={ui.choiceGroup}>
        {choices.map(choice => (
          <Pressable
            key={choice}
            accessibilityRole="button"
            style={({pressed}) => [ui.choice, value === choice && ui.choiceActive, pressed && ui.pressed]}
            onPress={() => onChange(choice)}>
            <Text style={[ui.choiceText, value === choice && ui.choiceTextActive]}>{choice}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secure?: boolean;
}) {
  return (
    <View style={ui.field}>
      <Text style={ui.label}>{label}</Text>
      <TextInput
        style={ui.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        secureTextEntry={secure}
        autoCapitalize="none"
      />
    </View>
  );
}

export function Badge({text, tone}: {text: string; tone: 'ok' | 'warn' | 'danger'}) {
  const toneColor = tone === 'ok' ? colors.ok : tone === 'warn' ? colors.warn : colors.danger;
  return (
    <View style={{paddingHorizontal: 9, paddingVertical: 4, borderRadius: 99, backgroundColor: `${toneColor}1A`, borderWidth: 1, borderColor: toneColor}}>
      <Text style={{fontSize: 11, fontWeight: '800', color: toneColor}}>{text}</Text>
    </View>
  );
}
