"""Session summary generation (DeepSeek + strict Pydantic validation)."""

import json

from pydantic import ValidationError

from .analysis_services import ExternalServiceError, call_deepseek_json
from .models import ChatSession
from .schemas import SummaryOutput

SUMMARY_SYSTEM_PROMPT = (
    "你是一个 AI 心理支持会话的总结助手。基于给定的会话偏好、完整对话记录、每轮支持策略记录与用户拒绝的方法，"
    "生成会话总结。所有内容只能引用会话中真实出现过的表达与确认过的行动，不得凭空补充用户没有表达过的事实"
    "或未确认的行动计划；缺失项如实标注（例如 agreed_next_step 填“本次会话未确认下一步行动”）。\n"
    "只输出 JSON，字段：main_concern(string), key_feelings(字符串数组，用户实际提到的感受或身体反应，无则空数组), "
    "techniques_used(字符串数组), rejected_methods(字符串数组), agreed_next_step(string), "
    "risk_level(\"normal\"|\"ambiguous\"|\"high\"), safety_escalation_triggered(bool), "
    "disclaimer(非诊断声明，说明本总结不构成医学诊断或治疗建议)。"
)


def generate_summary(session: ChatSession, llm_call=call_deepseek_json) -> dict:
    records_by_message = {record.message_id: record for record in session.strategy_records}
    turns = []
    for message in session.messages or []:
        record = records_by_message.get(message.id)
        turns.append({
            "role": message.role,
            "content": message.content,
            **({
                "technique": record.technique,
                "risk_level": record.risk_level,
            } if record else {}),
        })

    user_content = json.dumps({
        "session_preferences": {
            "main_concern": session.concern,
            "expression_preference": session.expression_preference,
        },
        "rejected_techniques": list(session.rejected_techniques or []),
        "safety_escalation_ever_triggered": session.safety_triggered,
        "max_risk_level": session.max_risk_level,
        "turns": turns,
    }, ensure_ascii=False)

    raw, _request_id = llm_call(SUMMARY_SYSTEM_PROMPT, user_content)
    try:
        summary = SummaryOutput.model_validate(raw).model_dump()
    except ValidationError:
        # One corrective retry with the validation error spelled out.
        followup = [
            {"role": "assistant", "content": json.dumps(raw, ensure_ascii=False)},
            {"role": "user", "content": "上一次输出未通过校验，请严格按字段与枚举要求重新输出完整 JSON。"},
        ]
        raw, _request_id = llm_call(SUMMARY_SYSTEM_PROMPT, user_content, followup)
        try:
            summary = SummaryOutput.model_validate(raw).model_dump()
        except ValidationError as error:
            raise ExternalServiceError(
                "llm", f"会话总结未通过结构化校验（{error.errors()[0]['msg']}），请重新生成。", False
            ) from error
    return summary
