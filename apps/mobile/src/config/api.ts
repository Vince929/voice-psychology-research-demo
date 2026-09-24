import {Platform} from 'react-native';

// Android emulators reach the host through 10.0.2.2. Physical Android devices
// use adb reverse and must address the forwarded host port as 127.0.0.1.
const host = Platform.select({android: '127.0.0.1', default: '127.0.0.1'});

export const API_BASE_URL = `http://${host}:8000/api`;
