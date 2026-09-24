import {Platform} from 'react-native';

const host = Platform.select({android: '10.0.2.2', default: '127.0.0.1'});

export const API_BASE_URL = `http://${host}:8000/api`;
