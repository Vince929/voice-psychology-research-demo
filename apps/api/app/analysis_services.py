import base64
import hashlib
import hmac
import json
import logging
import math
import socket
import threading
import subprocess
import tempfile
import time
import wave
from array import array
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests

from .config import (
    ASR_RESOLVE_IP,
    ASR_SECRET_ID,
    ASR_SECRET_KEY,
    DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL,
    DEEPSEEK_MODEL,
    TENCENTCLOUD_APP_ID,
)


logger = logging.getLogger(__name__)

ASR_HOST = "asr.cloud.tencent.com"
ASR_REQUEST_ATTEMPTS = 3
ASR_RETRY_DELAY_SECONDS = 0.5
_asr_resolution_lock = threading.Lock()


@contextmanager
def _pin_asr_host(ip: str):
    """Temporarily resolve ASR_HOST to a fixed IP (SNI/Host stay intact).

    The flash ASR route only exists on Tencent's mainland edge. On networks
    with an overseas DNS view the domain resolves to Tencent's overseas edge
    where /asr/flash/v1/<appid> returns nginx 404 for every request; pinning
    the connection to a mainland edge restores the service. Scoped to the
    ASR hostname only, and restored no matter how the block exits.
    """
    if not ip:
        yield
        return
    # getaddrinfo is process-global. Serialize the short override window so
    # concurrent ASR requests cannot restore another request's resolver.
    with _asr_resolution_lock:
        original_getaddrinfo = socket.getaddrinfo

        def pinned_getaddrinfo(host, *args, **kwargs):
            if host == ASR_HOST:
                return original_getaddrinfo(ip, *args, **kwargs)
            return original_getaddrinfo(host, *args, **kwargs)

        socket.getaddrinfo = pinned_getaddrinfo
        try:
            yield
        finally:
            socket.getaddrinfo = original_getaddrinfo


class ExternalServiceError(RuntimeError):
    def __init__(self, stage: str, message: str, retryable: bool) -> None:
        super().__init__(message)
        self.stage = stage
        self.retryable = retryable


def transcribe_m4a(audio_bytes: bytes, voice_format: str = "m4a") -> tuple[str | None, dict[str, Any], str | None]:
    """Tencent Cloud flash ASR. Reused as-is from the original demo project.
    voice_format follows the ASR flash API naming: m4a, aac, mp3, wav..."""
    if not all((TENCENTCLOUD_APP_ID, ASR_SECRET_ID, ASR_SECRET_KEY)):
        raise ExternalServiceError("transcription", "语音转写服务尚未完成配置，请联系管理员检查服务配置。", False)

    timestamp = int(time.time())
    query = {
        "convert_num_mode": "1",
        "engine_type": "16k_zh",
        "filter_dirty": "0",
        "filter_modal": "0",
        "filter_punc": "0",
        "first_channel_only": "1",
        "secretid": ASR_SECRET_ID,
        "speaker_diarization": "0",
        "timestamp": str(timestamp),
        "voice_format": voice_format,
        "word_info": "3",
    }
    path = f"/asr/flash/v1/{TENCENTCLOUD_APP_ID}"
    encoded_query = urlencode(sorted(query.items()))
    signing_text = f"POST{ASR_HOST}{path}?{encoded_query}"
    signature = base64.b64encode(
        hmac.new(ASR_SECRET_KEY.encode(), signing_text.encode(), hashlib.sha1).digest()
    ).decode()

    response: requests.Response | None = None
    last_error: requests.RequestException | None = None
    for attempt in range(1, ASR_REQUEST_ATTEMPTS + 1):
        try:
            with _pin_asr_host(ASR_RESOLVE_IP):
                response = requests.post(
                    f"https://{ASR_HOST}{path}?{encoded_query}",
                    data=audio_bytes,
                    headers={
                        "Authorization": signature,
                        "Content-Type": "application/octet-stream",
                        "Content-Length": str(len(audio_bytes)),
                    },
                    timeout=(10, 90),
                )
        except requests.RequestException as error:
            last_error = error
            logger.warning("asr request failed: attempt=%s/%s error=%s", attempt, ASR_REQUEST_ATTEMPTS, error)
        else:
            if response.status_code != 429 and response.status_code < 500:
                break
            logger.warning(
                "asr temporary response: attempt=%s/%s status=%s",
                attempt,
                ASR_REQUEST_ATTEMPTS,
                response.status_code,
            )
        if attempt < ASR_REQUEST_ATTEMPTS:
            time.sleep(ASR_RETRY_DELAY_SECONDS * attempt)

    if response is None:
        raise ExternalServiceError("transcription", "语音转写服务请求失败，请稍后重试。", True) from last_error
    if response.status_code >= 500 or response.status_code == 429:
        raise ExternalServiceError("transcription", f"语音转写服务暂时不可用（HTTP {response.status_code}），请稍后重试。", True)
    if not response.ok:
        raise ExternalServiceError("transcription", f"语音转写服务返回异常（HTTP {response.status_code}），请稍后重新发送。", False)

    payload = response.json()
    if payload.get("code") != 0:
        raise ExternalServiceError(
            "transcription",
            "语音转写服务未能处理该录音，请确认录音内容清晰后重新发送。",
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


def extract_asr_features(transcript: str, asr_result: dict[str, Any]) -> dict[str, Any]:
    """Sentence-level speech-rate / emotional-energy aggregates from the ASR result.

    Persisted on the user message and injected into the per-turn LLM prompt, so
    the strategy can consider more than the plain transcript.
    """
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
    }


def _estimate_pitch_hz(samples: array, sample_rate: int) -> float | None:
    """Estimate a voiced frame's fundamental frequency with normalized autocorrelation."""
    frame_size = min(len(samples), max(1, round(sample_rate * 0.04)))
    if frame_size < 8:
        return None
    start = max(0, (len(samples) - frame_size) // 2)
    frame = samples[start : start + frame_size]
    mean = sum(frame) / len(frame)
    centered = [sample - mean for sample in frame]
    energy = sum(sample * sample for sample in centered)
    if energy <= 0:
        return None
    min_lag = max(1, sample_rate // 350)
    max_lag = min(len(centered) // 2, sample_rate // 80)
    best_lag = 0
    best_correlation = 0.0
    for lag in range(min_lag, max_lag + 1):
        left = centered[:-lag]
        right = centered[lag:]
        denominator = math.sqrt(sum(sample * sample for sample in left) * sum(sample * sample for sample in right))
        if denominator == 0:
            continue
        correlation = sum(left_sample * right_sample for left_sample, right_sample in zip(left, right)) / denominator
        if correlation > best_correlation:
            best_correlation = correlation
            best_lag = lag
    if best_lag == 0 or best_correlation < 0.55:
        return None
    return round(sample_rate / best_lag, 1)


def extract_audio_features(audio_bytes: bytes) -> dict[str, Any] | None:
    """Short-window loudness and fundamental-frequency metrics (reused from the demo)."""
    try:
        with tempfile.TemporaryDirectory(prefix="voice-features-") as directory:
            input_path = Path(directory) / "recording.m4a"
            output_path = Path(directory) / "recording.wav"
            input_path.write_bytes(audio_bytes)
            subprocess.run(
                [
                    "ffmpeg", "-v", "error", "-y", "-i", str(input_path), "-ac", "1", "-ar", "16000", "-f", "wav", str(output_path),
                ],
                check=True,
                capture_output=True,
                timeout=45,
            )
            with wave.open(str(output_path), "rb") as wav_file:
                sample_rate = wav_file.getframerate()
                sample_width = wav_file.getsampwidth()
                channels = wav_file.getnchannels()
                raw_frames = wav_file.readframes(wav_file.getnframes())
    except (FileNotFoundError, subprocess.SubprocessError, wave.Error, OSError) as error:
        logger.warning("audio feature extraction skipped: %s", error)
        return None

    if sample_rate <= 0 or sample_width != 2 or channels != 1:
        logger.warning("audio feature extraction skipped: unsupported wav format")
        return None

    samples = array("h")
    samples.frombytes(raw_frames)
    if not samples:
        return None
    if samples.itemsize != 2:
        logger.warning("audio feature extraction skipped: unexpected sample size")
        return None

    window_samples = max(1, sample_rate // 4)
    dbfs_values: list[float] = []
    pitch_values: list[float] = []
    for start in range(0, len(samples), window_samples):
        chunk = samples[start : start + window_samples]
        if not chunk:
            continue
        rms = math.sqrt(sum(sample * sample for sample in chunk) / len(chunk))
        dbfs = max(-80.0, 20 * math.log10(max(rms, 1.0) / 32768.0))
        dbfs_values.append(dbfs)
        if dbfs > -55:
            pitch_hz = _estimate_pitch_hz(chunk, sample_rate)
            if pitch_hz is not None:
                pitch_values.append(pitch_hz)

    if not dbfs_values:
        return None
    low_dbfs = min(dbfs_values)
    high_dbfs = max(dbfs_values)
    return {
        "loudness_summary": {
            "average_dbfs": round(sum(dbfs_values) / len(dbfs_values), 1),
            "peak_dbfs": round(high_dbfs, 1),
            "dynamic_range_db": round(high_dbfs - low_dbfs, 1),
            "duration_ms": round(len(samples) * 1000 / sample_rate),
        },
        "pitch_summary": {
            "voiced_frame_count": len(pitch_values),
            "average_hz": round(sum(pitch_values) / len(pitch_values), 1) if pitch_values else None,
            "range_hz": round(max(pitch_values) - min(pitch_values), 1) if pitch_values else None,
        },
    }


def call_deepseek_json(
    system_prompt: str, user_content: str, followup: list[dict[str, str]] | None = None
) -> tuple[dict[str, Any], str | None]:
    """Generic DeepSeek chat call with response_format=json_object.

    Reuses the request/error-handling skeleton from the demo project; the
    caller owns the prompt content and output validation. `followup` carries
    assistant/user messages appended after the first user turn, used to ask
    the model to correct an invalid previous output.
    """
    if not DEEPSEEK_API_KEY:
        raise ExternalServiceError("llm", "AI 服务尚未完成配置，请联系管理员检查服务配置。", False)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
        *(followup or []),
    ]
    try:
        response = requests.post(
            f"{DEEPSEEK_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": DEEPSEEK_MODEL,
                "response_format": {"type": "json_object"},
                "messages": messages,
            },
            timeout=(10, 120),
        )
    except requests.RequestException as error:
        raise ExternalServiceError("llm", "AI 服务请求失败，请稍后重试。", True) from error

    if response.status_code >= 500 or response.status_code == 429:
        raise ExternalServiceError("llm", f"AI 服务暂时不可用（HTTP {response.status_code}），请稍后重试。", True)
    if not response.ok:
        raise ExternalServiceError("llm", f"AI 服务返回异常（HTTP {response.status_code}），请稍后重试。", False)

    payload = response.json()
    try:
        content = payload["choices"][0]["message"]["content"]
        result = json.loads(content)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
        raise ExternalServiceError("llm", "AI 服务返回的数据格式异常，请稍后重试。", False) from error
    if not isinstance(result, dict):
        raise ExternalServiceError("llm", "AI 服务返回的数据格式异常，请稍后重试。", False)
    return result, payload.get("id")


_REPLY_TEXT_KEY = '"reply_text"'
_JSON_STRING_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}


class _ReplyTextExtractor:
    """Incrementally decode the reply_text string value from a streaming JSON object.

    DeepSeek streams the JSON answer token by token; this state machine finds
    the "reply_text" key and re-emits its string content (JSON escapes already
    decoded) as characters arrive, so the client sees the reply typing out in
    real time instead of waiting for the whole JSON object. Everything after
    the closing quote is ignored. If the key never appears (or the value is
    not a string) nothing is emitted -- full validation of the complete JSON
    still happens in the caller, this is display-only.
    """

    _SEARCH_KEEP = 48  # tail retained while scanning, in case the key spans a chunk boundary

    def __init__(self) -> None:
        self._pending = ""
        self._state = "await_key"  # await_key | await_quote | in_string | escape | unicode | done
        self._digits = ""

    def feed(self, chunk: str) -> str:
        self._pending += chunk
        out: list[str] = []
        text = self._pending
        pos = 0
        length = len(text)
        while pos < length and self._state != "done":
            if self._state == "await_key":
                index = text.find(_REPLY_TEXT_KEY, pos)
                if index < 0:
                    keep_from = max(pos, length - self._SEARCH_KEEP)
                    self._pending = text[keep_from:]
                    return "".join(out)
                pos = index + len(_REPLY_TEXT_KEY)
                self._state = "await_quote"
            elif self._state == "await_quote":
                char = text[pos]
                if char in " \t\r\n:":
                    pos += 1
                    continue
                if char == '"':
                    pos += 1
                    self._state = "in_string"
                else:
                    # Not a string value (schema violation) -- stop emitting;
                    # the strict validation on the complete JSON still fails.
                    self._state = "done"
            elif self._state == "in_string":
                char = text[pos]
                if char == '"':
                    pos += 1
                    self._state = "done"
                elif char == "\\":
                    pos += 1
                    self._state = "escape"
                else:
                    out.append(char)
                    pos += 1
            elif self._state == "escape":
                char = text[pos]
                pos += 1
                if char == "u":
                    self._state = "unicode"
                    self._digits = ""
                else:
                    out.append(_JSON_STRING_ESCAPES.get(char, char))
                    self._state = "in_string"
            else:  # unicode
                self._digits += text[pos]
                pos += 1
                if len(self._digits) == 4:
                    try:
                        out.append(chr(int(self._digits, 16)))
                    except ValueError:
                        out.append("?")
                    self._state = "in_string"
        self._pending = text[pos:]
        return "".join(out)


def stream_deepseek_json(
    system_prompt: str, user_content: str, followup: list[dict[str, str]] | None = None
):
    """Streaming variant of call_deepseek_json (DeepSeek SSE protocol).

    Yields incremental decoded chunks of the reply_text field while the model
    streams the JSON answer. The generator's return value matches
    call_deepseek_json exactly: (parsed_dict, request_id), so the caller keeps
    the same strict-validation + retry flow. Network/format errors raise
    ExternalServiceError just like the non-streaming call.
    """
    if not DEEPSEEK_API_KEY:
        raise ExternalServiceError("llm", "AI 服务尚未完成配置，请联系管理员检查服务配置。", False)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
        *(followup or []),
    ]
    try:
        response = requests.post(
            f"{DEEPSEEK_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": DEEPSEEK_MODEL,
                "response_format": {"type": "json_object"},
                "messages": messages,
                "stream": True,
            },
            timeout=(10, 180),
            stream=True,
        )
    except requests.RequestException as error:
        raise ExternalServiceError("llm", "AI 服务请求失败，请稍后重试。", True) from error

    if response.status_code >= 500 or response.status_code == 429:
        response.close()
        raise ExternalServiceError("llm", f"AI 服务暂时不可用（HTTP {response.status_code}），请稍后重试。", True)
    if not response.ok:
        response.close()
        raise ExternalServiceError("llm", f"AI 服务返回异常（HTTP {response.status_code}），请稍后重试。", False)

    extractor = _ReplyTextExtractor()
    content_parts: list[str] = []
    request_id: str | None = None
    try:
        for raw_line in response.iter_lines():
            if not raw_line:
                continue
            line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else raw_line
            if not line.startswith("data:"):
                continue
            data = line[len("data:"):].strip()
            if not data:
                continue
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
                choices = chunk.get("choices") or [{}]
                delta = (choices[0].get("delta") or {}).get("content")
                if chunk.get("id"):
                    request_id = chunk["id"]
            except (json.JSONDecodeError, TypeError, IndexError, AttributeError) as error:
                raise ExternalServiceError("llm", "AI 服务返回的数据格式异常，请稍后重试。", False) from error
            if not isinstance(delta, str) or not delta:
                continue
            content_parts.append(delta)
            visible = extractor.feed(delta)
            if visible:
                yield visible
    except requests.RequestException as error:
        raise ExternalServiceError("llm", "AI 服务连接中断，请稍后重试。", True) from error
    finally:
        response.close()

    raw_text = "".join(content_parts)
    try:
        result = json.loads(raw_text)
    except json.JSONDecodeError as error:
        raise ExternalServiceError("llm", "AI 服务返回的数据格式异常，请稍后重试。", False) from error
    if not isinstance(result, dict):
        raise ExternalServiceError("llm", "AI 服务返回的数据格式异常，请稍后重试。", False)
    return result, request_id
