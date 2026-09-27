"""Per-turn strategy pipeline.

Order per turn: deterministic safety rules -> (optionally) one DeepSeek call
with strict Pydantic validation and one corrective retry -> deterministic
voice-profile derivation -> persistence. High-risk turns never reach the LLM.

Everything is driven by `turn_event_stream`, an event generator that yields
incremental `delta` events (streamed reply fragments) while the LLM runs and
finishes with one `result` event holding the persisted turn payload.
`process_turn` is a thin non-streaming wrapper kept for tests and the legacy
non-stream endpoint.
"""

import json
import logging
import os
import re
from typing import Any, Callable

from pydantic import ValidationError

from . import safety
from .analysis_services import ExternalServiceError, call_deepseek_json
from .models import ChatSession, Message, StrategyRecord
from .rejection import build_avoided_techniques, detect_rejected_technique, remember_rejection
from .schemas import StrategyLLMOutput
from .tts_profiles import resolve_turn_voice_profile, tts_params_for
from .audit import record_audit

logger = logging.getLogger(__name__)

HISTORY_MESSAGE_LIMIT = 10
RISK_ORDER = {"normal": 0, "ambiguous": 1, "high": 2}
_SENTENCE_SPLIT = re.compile(r"[。！？!?…\n]+")
_QUESTION_MARKS = re.compile(r"[？?]")

SYSTEM_PROMPT = (
    "你是一个面向成年焦虑人群的 AI 心理支持助手，本工具为非医疗性质的辅助支持，不能诊断或治疗焦虑症，"
    "不能替代心理咨询师、精神科医生或紧急援助服务。\n"
    "绝对禁止：使用诊断性用语；提供药物剂量、停药方案；作保证性承诺（如“一定会好”“保证有效”）。\n"
    "支持策略方法（technique 字段枚举）：\n"
    "- validation：支持性倾听，承认用户感受；\n"
    "- clarification：承认感受并询问具体诱因，不要立即输出大段通用建议；\n"
    "- grounding：即时稳定，适用于明显紧张、心跳加快、思绪混乱；使用短句，一次只给一个简单步骤，"
    "可用 5-4-3-2-1 感官定位或简短呼吸引导，但不得强迫用户接受；\n"
    "- reframing：帮助区分事实与推测，认知层面整理；\n"
    "- action_planning：只给一至两个现实可行的小步骤；\n"
    "- safety_escalation：用户表达自伤/自杀风险，或要求诊断、药物剂量、停药建议时使用。\n"
    "判断要求：\n"
    "- anxiety_level 从 low/moderate/high/uncertain 中选择，依据用户本轮文字及语音副语言特征（如有）；\n"
    "- risk_level 从 normal/ambiguous/high 中选择；除明确风险外，若用户用隐晦方式表达“撑不下去”“想消失”等，选 ambiguous；\n"
    "- observed_signals 只能引用用户实际表达中的证据，不得凭空推断；\n"
    "- voice_profile 是你对语速语气的建议（calm_slow/warm_normal/concise_direct），服务端会按固定优先级最终决定；\n"
    "- 用户明确拒绝某方法（如“我不喜欢呼吸练习”）时，user_rejected_technique 填对应枚举，否则填 null；\n"
    "- rejected_techniques 列表中的方法本轮禁止选用。\n"
    "回复要求：reply_text 用中文，遵守 response_constraints（最多 max_sentences 句，最多问一个问题），"
    "语气温和自然，避免说教。\n"
    "只输出 JSON，字段：anxiety_level, risk_level, observed_signals(非空字符串数组), support_goal, technique, "
    "technique_reason, response_constraints{max_sentences, ask_one_question_only}, voice_profile, reply_text, "
    "user_rejected_technique。"
)


def process_turn(
    db,
    session: ChatSession,
    text: str,
    asr_features: dict | None = None,
    audio_path: str | None = None,
    llm_call: Callable[..., Any] | None = None,
) -> dict:
    """Run the full per-turn pipeline. Adds message/strategy rows (caller commits)."""
    result: dict | None = None
    for event in turn_event_stream(
        db, session, text, asr_features=asr_features, audio_path=audio_path, llm_call=llm_call
    ):
        if event["type"] == "result":
            result = event["result"]
    assert result is not None  # the generator always ends with a result or raises
    return result


def turn_event_stream(
    db,
    session: ChatSession,
    text: str,
    *,
    asr_features: dict | None = None,
    audio_path: str | None = None,
    llm_call: Callable[..., Any] | None = None,
    stream_call: Callable[..., Any] | None = None,
):
    """Event generator behind one conversation turn.

    Yields, in order:
      {"type": "delta", "text": str}   -- streamed fragment of the assistant reply
                                          (only when `stream_call` is provided)
      {"type": "reset", "reason": str}  -- streamed fragments are invalidated,
                                          a corrective retry is regenerating
      {"type": "result", "result": dict} -- final authoritative payload, same
                                          shape as the non-streaming endpoint

    Non-streaming callers (process_turn, tests) simply ignore delta events.
    Raises ExternalServiceError on failure, never silently degrades.
    """
    if llm_call is None and stream_call is None:
        llm_call = call_deepseek_json
    rule_risk = safety.assess_text_risk(text)
    if rule_risk == "high":
        yield {"type": "result", "result": _persist_turn(
            db, session, text, audio_path=audio_path, asr_features=asr_features,
            reply=safety.SAFETY_ESCALATION_REPLY,
            anxiety_level="uncertain", risk_level="high",
            observed_signals=[_matched_signal(safety.HIGH_RISK_KEYWORDS, text)],
            support_goal="停止普通支持流程，引导用户联系专业与紧急援助",
            technique="safety_escalation",
            technique_reason="确定性关键词规则命中明确自伤/自杀或用药咨询风险，跳过普通支持策略",
            response_constraints={"max_sentences": 6, "ask_one_question_only": False},
            source="rule", is_safety_escalation=True,
        )}
        return
    if rule_risk == "ambiguous":
        yield {"type": "result", "result": _persist_turn(
            db, session, text, audio_path=audio_path, asr_features=asr_features,
            reply=safety.SAFETY_CONFIRMATION_REPLY,
            anxiety_level="uncertain", risk_level="ambiguous",
            observed_signals=[_matched_signal(safety.AMBIGUOUS_RISK_KEYWORDS, text)],
            support_goal="先完成一次直接的安全确认，暂不输出一般建议",
            technique="clarification",
            technique_reason="确定性关键词规则命中模糊风险表述，先安全确认再继续",
            response_constraints={"max_sentences": 2, "ask_one_question_only": True},
            source="rule", is_safety_escalation=False,
        )}
        return

    # Normal path: rejection regex first (pre-LLM), then a single LLM call chain.
    regex_rejected = detect_rejected_technique(text)
    if regex_rejected:
        remember_rejection(session, regex_rejected)

    history = _build_history(session)
    user_content = _build_user_content(session, history, text, asr_features)
    # Opt-in debug: dump the full per-turn prompt schema (incl. asr_features)
    # to the API console. Off by default so conversation content never lands
    # in logs; set DEBUG_LLM_PROMPT=1 in apps/api/.env to enable.
    if os.environ.get("DEBUG_LLM_PROMPT") == "1":
        logger.info("LLM prompt: %s", user_content)
    if stream_call is not None:
        output = yield from _stream_llm_validated(stream_call, user_content, session)
    else:
        output, _saw_non_normal_risk, _last_raw = _call_llm_validated(llm_call, user_content, session)

    # Layer-2 risk upgrade by the LLM: still fixed replies, LLM never authors safety text.
    if output.risk_level == "high":
        yield {"type": "result", "result": _persist_turn(
            db, session, text, audio_path=audio_path, asr_features=asr_features,
            reply=safety.SAFETY_ESCALATION_REPLY,
            anxiety_level=output.anxiety_level, risk_level="high",
            observed_signals=output.observed_signals,
            support_goal="停止普通支持流程，引导用户联系专业与紧急援助",
            technique="safety_escalation",
            technique_reason=f"LLM 结构化判断将风险升级为 high（{output.technique_reason}）",
            response_constraints={"max_sentences": 6, "ask_one_question_only": False},
            source="llm", is_safety_escalation=True,
        )}
        return
    if output.risk_level == "ambiguous":
        yield {"type": "result", "result": _persist_turn(
            db, session, text, audio_path=audio_path, asr_features=asr_features,
            reply=safety.SAFETY_CONFIRMATION_REPLY,
            anxiety_level=output.anxiety_level, risk_level="ambiguous",
            observed_signals=output.observed_signals,
            support_goal="先完成一次直接的安全确认，暂不输出一般建议",
            technique="clarification",
            technique_reason=f"LLM 结构化判断将风险升级为 ambiguous（{output.technique_reason}）",
            response_constraints={"max_sentences": 2, "ask_one_question_only": True},
            source="llm", is_safety_escalation=False,
        )}
        return

    # LLM-channel rejection detection.
    if output.user_rejected_technique:
        remember_rejection(session, output.user_rejected_technique)

    # Post check on response constraints; truncate as the final safety net.
    reply_text = _enforce_reply_constraints(output)

    yield {"type": "result", "result": _persist_turn(
        db, session, text, audio_path=audio_path, asr_features=asr_features,
        reply=reply_text,
        anxiety_level=output.anxiety_level, risk_level="normal",
        observed_signals=output.observed_signals,
        support_goal=output.support_goal,
        technique=output.technique,
        technique_reason=output.technique_reason,
        response_constraints=output.response_constraints.model_dump(),
        source="llm", is_safety_escalation=False,
    )}


def _matched_signal(keywords: tuple[str, ...], text: str) -> str:
    for keyword in keywords:
        if keyword in text:
            return f"用户输入中出现“{keyword}”"
    return "用户输入中存在风险表述"


def _build_history(session: ChatSession) -> list[dict]:
    messages = (session.messages or [])[-HISTORY_MESSAGE_LIMIT:]
    records_by_message = {record.message_id: record for record in session.strategy_records}
    history = []
    for message in messages:
        record = records_by_message.get(message.id)
        history.append({
            "role": message.role,
            "content": message.content,
            **({"technique": record.technique} if record else {}),
        })
    return history


def _build_user_content(
    session: ChatSession, history: list[dict], text: str, asr_features: dict | None
) -> str:
    return json.dumps({
        "session_preferences": {
            "main_concern": session.concern,
            "expression_preference": session.expression_preference,
            "voice_reply_enabled": session.voice_reply_enabled,
        },
        "rejected_techniques": list(session.rejected_techniques or []),
        "history": history,
        "current_input": {"text": text, "asr_features": asr_features},
    }, ensure_ascii=False)


def _call_llm_validated(
    llm_call: Callable[..., Any], user_content: str, session: ChatSession
) -> tuple[StrategyLLMOutput, bool, str | None]:
    """Call the LLM, validate strictly, retry once with a corrective note.

    Also re-checks that the chosen technique does not collide with the
    session's rejected list. Raises ExternalServiceError (never silently
    degrades) when the retry still fails.
    """
    last_raw: str | None = None
    saw_non_normal_risk = False
    _last_error = ""
    for attempt in range(2):
        followup = None
        if attempt == 1:
            followup = [
                {"role": "assistant", "content": last_raw or "{}"},
                {"role": "user", "content": (
                    "上一次输出未通过校验，存在以下问题：" + _last_error +
                    "。请重新输出完整且合法的 JSON，所有字段必须符合要求；"
                    "禁止选用 rejected_techniques 中的方法；回复不得超过 response_constraints.max_sentences 句且最多一个问题。"
                )},
            ]
        raw, _request_id = llm_call(SYSTEM_PROMPT, user_content, followup)
        last_raw = json.dumps(raw, ensure_ascii=False)
        try:
            output = StrategyLLMOutput.model_validate(raw)
        except ValidationError as error:
            _last_error = _format_validation_error(error)
            logger.warning("turn llm output validation failed (attempt %d): %s", attempt + 1, _last_error)
            continue
        if raw.get("risk_level") in ("ambiguous", "high"):
            saw_non_normal_risk = True
        if output.technique in (session.rejected_techniques or []):
            _last_error = f"technique={output.technique} 已被用户在本次会话中拒绝，不得选用"
            continue
        return output, saw_non_normal_risk, last_raw

    # Layer-3 fallback: never fabricate a normal reply after failed validation.
    if saw_non_normal_risk:
        raise ExternalServiceError(
            "llm",
            "本轮输入可能存在安全风险但 AI 输出校验未通过，已按安全确认处理。请稍后重试。",
            False,
        )
    raise ExternalServiceError(
        "llm",
        "AI 服务输出未通过结构化校验，本轮回复未生成，请稍后重试。",
        False,
    )


def _stream_llm_validated(
    stream_call: Callable[..., Any], user_content: str, session: ChatSession
) -> StrategyLLMOutput:
    """Streaming counterpart of _call_llm_validated.

    Consumes the streaming LLM call, re-yielding its reply-text deltas as
    `delta` events; on a failed validation emits one `reset` event (telling
    the client to drop the fragments it showed) before the corrective retry.
    Returns the validated StrategyLLMOutput; raises ExternalServiceError when
    the retry still fails, mirroring _call_llm_validated exactly.
    """
    last_raw: str | None = None
    saw_non_normal_risk = False
    _last_error = ""
    for attempt in range(2):
        followup = None
        if attempt == 1:
            yield {"type": "reset", "reason": "回复重新生成中…"}
            followup = [
                {"role": "assistant", "content": last_raw or "{}"},
                {"role": "user", "content": (
                    "上一次输出未通过校验，存在以下问题：" + _last_error +
                    "。请重新输出完整且合法的 JSON，所有字段必须符合要求；"
                    "禁止选用 rejected_techniques 中的方法；回复不得超过 response_constraints.max_sentences 句且最多一个问题。"
                )},
            ]
        stream = stream_call(SYSTEM_PROMPT, user_content, followup)
        raw = None
        while True:
            try:
                delta = next(stream)
            except StopIteration as stop:
                raw, _request_id = stop.value
                break
            if delta:
                yield {"type": "delta", "text": delta}
        last_raw = json.dumps(raw, ensure_ascii=False)
        try:
            output = StrategyLLMOutput.model_validate(raw)
        except ValidationError as error:
            _last_error = _format_validation_error(error)
            logger.warning("turn llm output validation failed (stream attempt %d): %s", attempt + 1, _last_error)
            continue
        if raw.get("risk_level") in ("ambiguous", "high"):
            saw_non_normal_risk = True
        if output.technique in (session.rejected_techniques or []):
            _last_error = f"technique={output.technique} 已被用户在本次会话中拒绝，不得选用"
            continue
        return output

    # Layer-3 fallback: never fabricate a normal reply after failed validation.
    if saw_non_normal_risk:
        raise ExternalServiceError(
            "llm",
            "本轮输入可能存在安全风险但 AI 输出校验未通过，已按安全确认处理。请稍后重试。",
            False,
        )
    raise ExternalServiceError(
        "llm",
        "AI 服务输出未通过结构化校验，本轮回复未生成，请稍后重试。",
        False,
    )


def _format_validation_error(error: ValidationError) -> str:
    problems = []
    for issue in error.errors()[:5]:
        field_path = ".".join(str(part) for part in issue["loc"]) or "JSON"
        problems.append(f"{field_path}: {issue['msg']}")
    return "；".join(problems) or "未知校验错误"


def _enforce_reply_constraints(output: StrategyLLMOutput) -> str:
    max_sentences = output.response_constraints.max_sentences
    one_question_only = output.response_constraints.ask_one_question_only
    reply = output.reply_text.strip()

    sentences = [s for s in _SENTENCE_SPLIT.split(reply) if s.strip()]
    if len(sentences) > max_sentences:
        reply = "。".join(sentences[:max_sentences]) + "。"
    if one_question_only and len(_QUESTION_MARKS.findall(reply)) > 1:
        positions = [m.start() for m in _QUESTION_MARKS.finditer(reply)]
        reply = reply[: positions[1]] + "。" + reply[positions[1] + 1 :].strip("。！？!?… \n")
    return reply


def _bump_risk(session: ChatSession, risk_level: str, is_safety_escalation: bool) -> None:
    if RISK_ORDER.get(risk_level, 0) > RISK_ORDER.get(session.max_risk_level, 0):
        session.max_risk_level = risk_level
    if is_safety_escalation:
        session.safety_triggered = True


def _persist_turn(
    db,
    session: ChatSession,
    text: str,
    *,
    reply: str,
    anxiety_level: str,
    risk_level: str,
    observed_signals: list[str],
    support_goal: str,
    technique: str,
    technique_reason: str,
    response_constraints: dict,
    source: str,
    is_safety_escalation: bool,
    audio_path: str | None = None,
    asr_features: dict | None = None,
) -> dict:
    user_message = Message(session=session, role="user", content=text, audio_path=audio_path, asr_features=asr_features)
    voice_profile, override_applied = resolve_turn_voice_profile(
        anxiety_level, risk_level, session.expression_preference, session.voice_profile_override
    )
    assistant_message = Message(session=session, role="assistant", content=reply)
    db.add_all((user_message, assistant_message))
    db.flush()

    avoided = build_avoided_techniques(session, technique)
    record = StrategyRecord(
        session=session,
        message=assistant_message,
        anxiety_level=anxiety_level,
        risk_level=risk_level,
        observed_signals=observed_signals,
        support_goal=support_goal,
        technique=technique,
        technique_reason=technique_reason,
        response_constraints=response_constraints,
        voice_profile=voice_profile,
        tts_params=tts_params_for(voice_profile, override_applied),
        avoided_techniques=avoided,
        is_safety_escalation=is_safety_escalation,
        source=source,
    )
    db.add(record)
    _bump_risk(session, risk_level, is_safety_escalation)
    if is_safety_escalation:
        # Audit trail: enums and metadata only, never message content.
        record_audit(
            db, user_id=session.user_id, action="safety_escalation", session_id=session.id,
            detail={"technique": technique, "risk_level": risk_level, "source": source},
        )
    db.flush()

    return {
        "user_message": _message_summary(user_message),
        "assistant_message": _message_summary(assistant_message),
        "strategy_record": _record_summary(record),
    }


def _message_summary(message: Message) -> dict:
    return {
        "id": message.id,
        "role": message.role,
        "content": message.content,
        "audio_url": f"/api/messages/{message.id}/audio" if message.audio_path else None,
        "asr_features": message.asr_features,
        "created_at": message.created_at,
    }


def _record_summary(record: StrategyRecord) -> dict:
    return {
        "id": record.id,
        "message_id": record.message_id,
        "anxiety_level": record.anxiety_level,
        "risk_level": record.risk_level,
        "observed_signals": record.observed_signals,
        "support_goal": record.support_goal,
        "technique": record.technique,
        "technique_reason": record.technique_reason,
        "response_constraints": record.response_constraints,
        "voice_profile": record.voice_profile,
        "tts_params": record.tts_params,
        "avoided_techniques": record.avoided_techniques,
        "is_safety_escalation": record.is_safety_escalation,
        "source": record.source,
        "feedback": record.feedback,
        "created_at": record.created_at,
    }
