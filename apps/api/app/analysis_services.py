import base64
import hashlib
import hmac
import json
import time
from typing import Any
from urllib.parse import urlencode

import requests

from .config import (
    AUDIO_COS_SECRET_ID,
    AUDIO_COS_SECRET_KEY,
    DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL,
    DEEPSEEK_MODEL,
    TENCENTCLOUD_APP_ID,
)


class ExternalServiceError(RuntimeError):
    def __init__(self, stage: str, message: str, retryable: bool) -> None:
        super().__init__(message)
        self.stage = stage
        self.retryable = retryable


def transcribe_m4a(audio_bytes: bytes) -> tuple[str, dict[str, Any], str | None]:
    if not all((TENCENTCLOUD_APP_ID, AUDIO_COS_SECRET_ID, AUDIO_COS_SECRET_KEY)):
        raise ExternalServiceError("transcription", "Tencent Cloud ASR is not configured", False)

    timestamp = int(time.time())
    query = {
        "convert_num_mode": "1",
        "engine_type": "16k_zh",
        "filter_dirty": "0",
        "filter_modal": "0",
        "filter_punc": "0",
        "first_channel_only": "1",
        "secretid": AUDIO_COS_SECRET_ID,
        "speaker_diarization": "0",
        "timestamp": str(timestamp),
        "voice_format": "m4a",
        "word_info": "3",
    }
    path = f"/asr/flash/v1/{TENCENTCLOUD_APP_ID}"
    encoded_query = urlencode(sorted(query.items()))
    signing_text = f"POSTasr.cloud.tencent.com{path}?{encoded_query}"
    signature = base64.b64encode(
        hmac.new(AUDIO_COS_SECRET_KEY.encode(), signing_text.encode(), hashlib.sha1).digest()
    ).decode()

    try:
        response = requests.post(
            f"https://asr.cloud.tencent.com{path}?{encoded_query}",
            data=audio_bytes,
            headers={
                "Authorization": signature,
                "Content-Type": "application/octet-stream",
                "Content-Length": str(len(audio_bytes)),
            },
            timeout=(10, 90),
        )
    except requests.RequestException as error:
        raise ExternalServiceError("transcription", "Tencent Cloud ASR request failed", True) from error

    if response.status_code >= 500 or response.status_code == 429:
        raise ExternalServiceError("transcription", f"Tencent Cloud ASR returned HTTP {response.status_code}", True)
    if not response.ok:
        raise ExternalServiceError("transcription", f"Tencent Cloud ASR returned HTTP {response.status_code}", False)

    payload = response.json()
    if payload.get("code") != 0:
        message = str(payload.get("message") or "Tencent Cloud ASR rejected the recording")
        raise ExternalServiceError("transcription", message, False)

    results = payload.get("flash_result") or []
    transcript = "\n".join(str(item.get("text", "")).strip() for item in results).strip()
    if not transcript:
        raise ExternalServiceError("transcription", "Tencent Cloud ASR returned an empty transcript", False)
    return transcript, payload, payload.get("request_id")


def build_analysis_input(transcript: str, asr_result: dict[str, Any]) -> dict[str, Any]:
    sentences = [
        {
            "text": sentence.get("text", ""),
            "start_time_ms": sentence.get("start_time"),
            "end_time_ms": sentence.get("end_time"),
            "speech_speed": sentence.get("speech_speed"),
            "emotional_energy": sentence.get("emotional_energy"),
        }
        for result in asr_result.get("flash_result", [])
        for sentence in result.get("sentence_list", [])
    ]
    return {
        "transcript": transcript,
        "audio_duration_ms": asr_result.get("audio_duration"),
        "sentences": sentences,
    }


def analyze_expression(transcript: str, asr_result: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    if not DEEPSEEK_API_KEY:
        raise ExternalServiceError("analysis", "DeepSeek is not configured", False)

    prompt = {
        "role": "system",
        "content": (
            "You produce experimental expression observations from a transcript and ASR timing metrics. "
            "Return only JSON with expression_state, vitality_score, tension_score, evidence, summary, suggestion, disclaimer. "
            "Scores must be integers from 0 to 100. Do not diagnose illness, estimate depression or anxiety risk, "
            "assign personality types, or claim clinical accuracy. All evidence must refer only to the supplied transcript or ASR data. "
            "The disclaimer must state in Chinese that this is experimental and not a medical, psychological, or personality assessment."
        ),
    }
    user_content = json.dumps(build_analysis_input(transcript, asr_result), ensure_ascii=False)
    try:
        response = requests.post(
            f"{DEEPSEEK_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"},
            json={"model": DEEPSEEK_MODEL, "response_format": {"type": "json_object"}, "messages": [prompt, {"role": "user", "content": user_content}]},
            timeout=(10, 90),
        )
    except requests.RequestException as error:
        raise ExternalServiceError("analysis", "DeepSeek request failed", True) from error

    if response.status_code >= 500 or response.status_code == 429:
        raise ExternalServiceError("analysis", f"DeepSeek returned HTTP {response.status_code}", True)
    if not response.ok:
        raise ExternalServiceError("analysis", f"DeepSeek returned HTTP {response.status_code}", False)

    payload = response.json()
    try:
        content = payload["choices"][0]["message"]["content"]
        result = json.loads(content)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
        raise ExternalServiceError("analysis", "DeepSeek did not return valid JSON", False) from error

    _validate_analysis_result(result)
    return result, payload.get("id")


def _validate_analysis_result(result: dict[str, Any]) -> None:
    required_keys = {"expression_state", "vitality_score", "tension_score", "evidence", "summary", "suggestion", "disclaimer"}
    if not required_keys.issubset(result):
        raise ExternalServiceError("analysis", "DeepSeek result is missing required fields", False)
    if not all(isinstance(result[key], int) and 0 <= result[key] <= 100 for key in ("vitality_score", "tension_score")):
        raise ExternalServiceError("analysis", "DeepSeek scores are outside the allowed range", False)
    prohibited = ("抑郁", "焦虑", "疾病", "MBTI")
    result_text = json.dumps({key: value for key, value in result.items() if key != "disclaimer"}, ensure_ascii=False)
    if any(word in result_text for word in prohibited):
        raise ExternalServiceError("analysis", "DeepSeek result contains prohibited health or personality content", False)
