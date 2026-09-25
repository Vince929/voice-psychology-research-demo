import AsyncStorage from '@react-native-async-storage/async-storage';
import {Platform} from 'react-native';

export type ApiEnvironment = 'local' | 'production';

type ApiEnvironmentSettings = {
  environment: ApiEnvironment;
};

const API_ENVIRONMENT_STORAGE_KEY = '@voice-psychology/api-environment/v1';

// Android physical devices use adb reverse, while iOS simulators use the local host directly.
const localHost = Platform.select({android: '127.0.0.1', default: '127.0.0.1'});
export const LOCAL_API_BASE_URL = `http://${localHost}:8000/api`;

// Replace this with the deployed API endpoint before distributing the app.
export const PRODUCTION_API_BASE_URL = 'http://api.happymac.club:8443/api';

let currentSettings: ApiEnvironmentSettings = {environment: 'local'};

function resolvedApiBaseUrl(settings = currentSettings) {
  return settings.environment === 'production' ? PRODUCTION_API_BASE_URL : LOCAL_API_BASE_URL;
}

function toSettings(value: unknown): ApiEnvironmentSettings {
  if (!value || typeof value !== 'object') {
    return currentSettings;
  }
  const stored = value as Partial<ApiEnvironmentSettings>;
  return {environment: stored.environment === 'production' ? 'production' : 'local'};
}

async function persistSettings() {
  await AsyncStorage.setItem(API_ENVIRONMENT_STORAGE_KEY, JSON.stringify(currentSettings));
}

export function getApiEnvironmentSettings() {
  return currentSettings;
}

export function getApiBaseUrl() {
  return resolvedApiBaseUrl();
}

export async function loadApiEnvironmentSettings() {
  const stored = await AsyncStorage.getItem(API_ENVIRONMENT_STORAGE_KEY);
  if (stored) {
    try {
      currentSettings = toSettings(JSON.parse(stored));
    } catch {
      currentSettings = {environment: 'local'};
    }
  }
  return currentSettings;
}

export async function setApiEnvironment(environment: ApiEnvironment) {
  currentSettings = {...currentSettings, environment};
  await persistSettings();
  return currentSettings;
}
