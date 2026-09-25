import AsyncStorage from '@react-native-async-storage/async-storage';
import {Platform} from 'react-native';

export type ApiEnvironment = 'local' | 'production';

type ApiEnvironmentSettings = {
  environment: ApiEnvironment;
  productionApiBaseUrl: string;
};

const API_ENVIRONMENT_STORAGE_KEY = '@voice-psychology/api-environment/v1';

// Android physical devices use adb reverse, while iOS simulators use the local host directly.
const localHost = Platform.select({android: '127.0.0.1', default: '127.0.0.1'});
export const LOCAL_API_BASE_URL = `http://${localHost}:8000/api`;

// You can set a team-wide default here. A URL saved from the app takes precedence.
export const PRODUCTION_API_BASE_URL = '';

let currentSettings: ApiEnvironmentSettings = {
  environment: 'local',
  productionApiBaseUrl: PRODUCTION_API_BASE_URL,
};

function normalizeApiBaseUrl(value: string) {
  const baseUrl = value.trim().replace(/\/+$/, '');
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('API 地址必须以 http:// 或 https:// 开头。');
  }
  return baseUrl;
}

function resolvedApiBaseUrl(settings = currentSettings) {
  if (settings.environment === 'production') {
    if (!settings.productionApiBaseUrl) {
      throw new Error('请先填写线上 API 地址。');
    }
    return settings.productionApiBaseUrl;
  }
  return LOCAL_API_BASE_URL;
}

function toSettings(value: unknown): ApiEnvironmentSettings {
  if (!value || typeof value !== 'object') {
    return currentSettings;
  }
  const stored = value as Partial<ApiEnvironmentSettings>;
  return {
    environment: stored.environment === 'production' ? 'production' : 'local',
    productionApiBaseUrl: typeof stored.productionApiBaseUrl === 'string'
      ? stored.productionApiBaseUrl
      : PRODUCTION_API_BASE_URL,
  };
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
      if (currentSettings.productionApiBaseUrl) {
        currentSettings.productionApiBaseUrl = normalizeApiBaseUrl(currentSettings.productionApiBaseUrl);
      }
      if (currentSettings.environment === 'production' && !currentSettings.productionApiBaseUrl) {
        currentSettings.environment = 'local';
      }
    } catch {
      currentSettings = {
        environment: 'local',
        productionApiBaseUrl: PRODUCTION_API_BASE_URL,
      };
    }
  }
  return currentSettings;
}

export async function setApiEnvironment(environment: ApiEnvironment) {
  resolvedApiBaseUrl({...currentSettings, environment});
  currentSettings = {...currentSettings, environment};
  await persistSettings();
  return currentSettings;
}

export async function setProductionApiBaseUrl(value: string) {
  currentSettings = {
    ...currentSettings,
    productionApiBaseUrl: normalizeApiBaseUrl(value),
  };
  await persistSettings();
  return currentSettings;
}
