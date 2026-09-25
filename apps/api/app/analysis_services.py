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


def transcribe_m4a(audio_bytes: bytes) -> tuple[str | None, dict[str, Any], str | None]:
    if not all((TENCENTCLOUD_APP_ID, AUDIO_COS_SECRET_ID, AUDIO_COS_SECRET_KEY)):
        raise ExternalServiceError("transcription", "语音转写服务尚未完成配置，请联系管理员检查服务配置。", False)

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
        raise ExternalServiceError("transcription", "语音转写服务请求失败，系统将自动重试。", True) from error

    if response.status_code >= 500 or response.status_code == 429:
        raise ExternalServiceError("transcription", f"语音转写服务暂时不可用（HTTP {response.status_code}），系统将自动重试。", True)
    if not response.ok:
        raise ExternalServiceError("transcription", f"语音转写服务返回异常（HTTP {response.status_code}），请稍后重新分析。", False)

    payload = response.json()
    if payload.get("code") != 0:
        raise ExternalServiceError(
            "transcription",
            "语音转写服务未能处理该录音，请确认录音内容清晰后重新分析。",
            False,
        )

    results = payload.get("flash_result") or []
    transcript = "\n".join(str(item.get("text", "")).strip() for item in results).strip()
    return transcript or None, payload, payload.get("request_id")


def _numeric_metric_summary(sentences: list[dict[str, Any]], field: str) -> dict[str, float | int] | None:
    values = [sentence[field] for sentence in sentences if isinstance(sentence.get(field), (int, float))]
    if not values:
        return None
    return {
        "count": len(values),
        "min": round(min(values), 2),
        "max": round(max(values), 2),
        "average": round(sum(values) / len(values), 2),
    }


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
        "sentence_count": len(sentences),
        "speech_speed_summary": _numeric_metric_summary(sentences, "speech_speed"),
        "emotional_energy_summary": _numeric_metric_summary(sentences, "emotional_energy"),
        "sentences": sentences,
    }


def analyze_expression(transcript: str, asr_result: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    if not DEEPSEEK_API_KEY:
        raise ExternalServiceError("analysis", "AI 分析服务尚未完成配置，请联系管理员检查服务配置。", False)

    prompt = {
        "role": "system",
        "content": (
            "You produce experimental, non-clinical emotion-state predictions from a transcript and ASR timing metrics. "
            "Return only JSON with expression_state, vitality_score, tension_score, emotion_dimensions, evidence, summary, suggestion, disclaimer. "
            "emotion_dimensions must be an object with Chinese string values for valence, arousal, and stability; "
            "describe only expression in this recording, using qualified language such as '偏积极', '平稳', or '可能有波动'. "
            "suggestion is a short neutral state explanation, never advice or an intervention. "
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
        raise ExternalServiceError("analysis", "AI 分析服务请求失败，系统将自动重试。", True) from error

    if response.status_code >= 500 or response.status_code == 429:
        raise ExternalServiceError("analysis", f"AI 分析服务暂时不可用（HTTP {response.status_code}），系统将自动重试。", True)
    if not response.ok:
        raise ExternalServiceError("analysis", f"AI 分析服务返回异常（HTTP {response.status_code}），请稍后重新分析。", False)

    payload = response.json()
    try:
        content = payload["choices"][0]["message"]["content"]
        result = json.loads(content)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
        raise ExternalServiceError("analysis", "AI 分析服务返回的数据格式异常，请稍后重新分析。", False) from error

    _validate_analysis_result(result)
    return result, payload.get("id")


def _validate_analysis_result(result: dict[str, Any]) -> None:
    required_keys = {"expression_state", "vitality_score", "tension_score", "emotion_dimensions", "evidence", "summary", "suggestion", "disclaimer"}
    if not required_keys.issubset(result):
        raise ExternalServiceError("analysis", "AI 分析结果不完整，请稍后重新分析。", False)
    if not all(isinstance(result[key], int) and 0 <= result[key] <= 100 for key in ("vitality_score", "tension_score")):
        raise ExternalServiceError("analysis", "AI 分析结果不符合预期，请稍后重新分析。", False)
    dimensions = result["emotion_dimensions"]
    if not isinstance(dimensions, dict) or not all(isinstance(dimensions.get(key), str) and dimensions[key].strip() for key in ("valence", "arousal", "stability")):
        raise ExternalServiceError("analysis", "AI 分析结果的情感维度不完整，请稍后重新分析。", False)
    prohibited = ("抑郁", "焦虑", "疾病", "MBTI")
    result_text = json.dumps({key: value for key, value in result.items() if key != "disclaimer"}, ensure_ascii=False)
    if any(word in result_text for word in prohibited):
        raise ExternalServiceError("analysis", "AI 分析结果包含不适合展示的内容，请重新分析。", False)
