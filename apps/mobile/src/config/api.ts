import {Platform} from 'react-native';

// Android physical devices reach the local API through adb reverse (cmd.sh usb),
// so the loopback address works on both emulators and real devices.
const localHost = Platform.select({android: '127.0.0.1', default: '127.0.0.1'});
export const API_BASE_URL = `http://${localHost}:8000/api`;
