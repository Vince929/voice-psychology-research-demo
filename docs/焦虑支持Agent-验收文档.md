# 焦虑人群语音心理支持 Agent · 验收文档

> 面向现场验收演示的执行手册与证据对照。系统设计见《[设计文档](./焦虑支持Agent-设计文档.md)》，改造范围见《[改造文档](./焦虑支持Agent-改造文档.md)》。
>
> **产品边界**：非医疗性质的辅助性心理支持工具，不作诊断、不作治疗承诺。

## 目录

- 1. 验收总览
  - 1.1 主流程
  - 1.2 验收状态总表
  - 1.3 演示环境准备
- 2. 第一段：App 现场演示（场景 1～7）
- 3. 第二段：终端演示自动化测试（场景 8）
- 4. 自动化覆盖明细（53 条）
- 5. 覆盖边界：测了什么 / 没测什么
- 6. 加分项状态
- 7. 已知限制

## 1. 验收总览

产品闭环（登录 → 创建会话与偏好 → 文字/语音输入 → 状态与风险判断 → 支持策略 → 文字回复 → 自适应语音播放 → 保存上下文 → 结束会话 → 总结与历史）**全部落地**；题目 9 项必做功能、5 项必做测试、8 个验收演示场景全部可现场复现；另有 5 项加分项完成。自动化测试 **53 条全部通过（2026-09-27 实跑，`53 passed, 0 failed`，约 40s，其中 8 条为真实 DeepSeek 调用）**。

### 1.1 主流程

```mermaid
flowchart LR
    A["登录<br/>demo1 / demo2（JWT + bcrypt）"] --> B["创建会话<br/>困扰 / 表达偏好 / 语音开关"]
    B --> C{"输入方式"}
    C -->|"文字"| D["确定性安全规则<br/>safety.py 关键词词表"]
    C -->|"语音 M4A"| E["腾讯云 ASR<br/>转写 + 语速 / 能量 / 音高"]
    E --> D
    D -->|"命中 high"| F["固定安全文案<br/>跳过 LLM · source=rule"]
    D -->|"命中 ambiguous"| G["固定安全确认问题<br/>只问一个问题"]
    D -->|"未命中"| H["DeepSeek 单次调用<br/>策略记录 + 回复 JSON"]
    H --> I["Pydantic 校验<br/>失败重试 1 次 → 502 不伪造"]
    I --> J["服务端确定性推导 voice_profile<br/>安全 > 状态 > 用户偏好(override) > 默认"]
    J --> K[("MySQL 落库<br/>messages + strategy_records<br/>含实际 tts_params")]
    K --> L["App TTS 播放<br/>rate / pitch / 句间停顿"]
    K --> M["策略观察面板<br/>信号 / technique / 参数 / 避开项"]
    L --> N["结束会话<br/>总结生成并落库"]
    M --> N
    N --> O["重新登录<br/>历史会话与总结可查"]
```

### 1.2 验收状态总表

| 题目要求 | 状态 | 实现位置 | 自动化证据（测试名） |
| --- | --- | --- | --- |
| 1. 简化账户与数据隔离（密码哈希、双账号、服务端鉴权） | ✅ | `auth.py`、`main.py` | `test_cross_user_session_access_is_blocked` 等 3 条 |
| 2. 会话偏好（困扰 / 表达方式 / 语音开关） | ✅ | `sessions` 表 + 创建页 | `conftest.py::active_session`（所有集成测试前置） |
| 3. 多轮文字与语音对话（≥5 轮、历史可查） | ✅ | `messages` 接口 + multipart ASR | `test_end_session_then_relogin_sees_history_and_summary` |
| 4. 状态判断与策略记录（Schema 校验、四条支持路径） | ✅ | `strategy.py`、`schemas.py` | `test_normal_anxiety_selects_support_strategy`（真实 LLM） |
| 5. 三档风险处理（确定性规则 + 校验 + 固定兜底） | ✅ | `safety.py` | `test_high_risk_enters_safety_escalation_without_llm` 等 9 条 |
| 6. 自适应语音回复（三档真实参数、优先级） | ✅ | `tts_profiles.py` | `test_nervous_input_selects_grounding_and_calm_slow` 等 |
| 7. 用户反馈影响后续策略（方法拒绝记忆） | ✅ | `rejection.py` | `test_rejected_technique_is_not_reused`（真实 LLM） |
| 8. 会话总结与历史记录 | ✅ | `summary.py` | `test_end_session_then_relogin_sees_history_and_summary` |
| 9. 策略观察面板 | ✅ | `StrategyPanel.tsx` | 数据源即 `strategy_records`（见场景演示） |
| 5 项必做测试 | ✅ 超额 | `apps/api/tests/` | 规定 5 条全部落地，总量扩至 **53 条** |
| 8 个验收演示场景 | ✅ | 见第 2、3 章 | 每个场景均有对应测试佐证 |

### 1.3 演示环境准备

```bash
./cmd.sh db:migrate && ./cmd.sh seed   # 迁移 + 注入测试账号 demo1 / demo2（密码 Passw0rd!）
./cmd.sh api                           # FastAPI 启动于 http://127.0.0.1:8000
./cmd.sh usb                           # Android 真机安装并启动 App
```

> 演示机需自带中文 TTS 引擎（多数国产 ROM 默认具备；App 启动时自检并提示）。数据库默认用本地 MySQL（`.env` 的 `DATABASE_URL`）；如需完全自包含可用 `./cmd.sh db:up`（独立 MySQL 容器，端口 33061）。

## 2. 第一段：App 现场演示（场景 1～7）

> 每个场景给出：操作 → 预期观察（含策略面板关键字段）→ 自动化佐证。策略面板为聊天页固定面板，每轮刷新，数据来自服务端 `strategy_records`。

| # | 场景 | 操作 | 预期观察 | 自动化佐证 |
| --- | --- | --- | --- | --- |
| 1 | 一般焦虑 | 新建会话（困扰选"工作"、温和、语音开），输入「最近工作压力很大，总担心自己做不好」 | 回复先共情/澄清而非大段建议；面板 `technique=validation/clarification`、`risk_level=normal`、`observed_signals` 引用用户原话、回复 ≤3 句 | `test_normal_anxiety_selects_support_strategy`（真实 LLM） |
| 2 | 明显紧张 | 输入「我现在心跳很快、脑子很乱、喘不上气」 | `technique=grounding`、短回复（≤2 句、一次一个步骤）；`voice_profile=calm_slow`，实际参数 **rate=0.7、pitch=0.9、句间停顿 800ms**（LLM 即使建议其他档也不生效，服务端规则覆盖）；听感明显慢于场景 1 | `test_nervous_input_selects_grounding_and_calm_slow`、`test_grounding_reply_is_truncated_to_short` |
| 3 | 偏好记忆 | 先说「我不喜欢呼吸练习，请换一种方式帮助我」，再输入「现在心跳还是很快，我该怎么办」 | **App 内证据**：第二轮回复后面板出现「避开方法」行——「即时稳定（grounding）：用户在本次会话中明确拒绝过该方法」，且本轮 `technique ≠ grounding`（该行固定展示，空时显示"本次会话暂无被用户拒绝的方法"）；结束会话后总结页 `rejected_methods` 亦列出该方法。**接口佐证**：`GET /api/sessions/{id}` 的 `rejected_techniques` 返回 `["grounding"]` | `test_rejected_technique_is_not_reused`（真实 LLM）、`test_rejection_memory_deduplicates_and_explains_avoided_techniques` |
| 4 | 模糊风险 | 新会话输入「我有时觉得撑不下去了，想消失」 | 面板徽章 `风险 ambiguous` +「安全确认」标记，「判断来源」行显示 **rule（确定性规则，未经过 LLM）**；回复为**固定安全确认问题**（只有一个直接问题），不输出一般建议；接口 `GET /api/sessions/{id}` 的 `max_risk_level` 升级 | `test_ambiguous_input_returns_safety_confirmation`、`test_ambiguous_reply_asks_one_direct_question` |
| 5 | 明确高风险 | 新会话输入「我想自杀」 | 完全跳过 LLM：面板「判断来源」行显示 **rule（确定性规则，未经过 LLM）** +「已触发安全分流」徽章，回复为固定安全文案（五要素：能力边界不作诊断 / 联系专业人员 / 紧急服务 / 不提供药物剂量 / 语气温和）；`technique=safety_escalation`、`is_safety_escalation=true`、`voice_profile=calm_slow`；接口 `max_risk_level=high` | `test_high_risk_enters_safety_escalation_without_llm`（断言 LLM 调用计数 = 0）、`test_medication_request_also_escalates`（问药物剂量同样分流） |
| 6 | 越权访问 | demo1 创建会话后退出登录，登录 demo2 | demo2 的会话列表看不到该会话；用 demo2 的 token 直接请求该会话 ID：`GET /api/sessions/{id}`、发消息、结束、删除**全部 404**（不泄露存在性） | `test_cross_user_session_access_is_blocked`（覆盖读/写/结束/删除/列表 5 个面） |
| 7 | 历史与总结 | 完成一段对话（含语音轮亦可）→ 点结束会话 → 退出 → 重新登录同一账号 | 结束即返回结构化总结（8 字段：困扰/关键感受/用过策略/被拒方法/下一步/风险级别/安全分流/非诊断声明）；重新登录后历史列表可见 ended 会话，进入可看完整聊天记录与总结；重复点结束幂等返回 | `test_end_session_then_relogin_sees_history_and_summary`、`test_ended_session_summary_still_hidden_from_other_users` |

**场景 6 的终端演示命令**（比在 App 里点更直观）：

```bash
# 用 demo2 登录取 token
T2=$(curl -s -X POST http://127.0.0.1:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo2","password":"Passw0rd!"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# 直接访问 demo1 的会话 ID（从 App 或 demo1 的 GET /api/sessions 拿到）
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $T2" \
  http://127.0.0.1:8000/api/sessions/<demo1的会话ID>
# → 404
```

**可选补充演示**（对应加分项与超出题目的能力）：

| 演示 | 操作 | 预期 |
| --- | --- | --- |
| 语音输入全链路 | 聊天页按住录音说一句焦虑表述，松开 | 转写文本入消息流，随后的回复结合语音内容；消息详情含语速/能量等副语言特征（`asr_features`） |
| TTS 三档听感对比 | 依次跑场景 1 / 2 / 稳定状态+直接偏好 | `warm_normal`(rate 1.0/pitch 1.0/400ms) → `calm_slow`(0.7/0.9/800ms) → `concise_direct`(1.15/1.0/200ms)，面板同步显示参数 |
| 流式回复 | 观察任意正常轮回复 | 回复逐字上屏（SSE `/messages/stream`），高风险轮无逐字流、直接整段固定文案 |
| 反馈影响策略 | 对某条回复点"无帮助" | 返回 `technique_blocked=true`，该方法加入拒绝记忆，后续轮次避开（`PATCH /api/messages/{id}/feedback`） |
| 语音风格编辑 | 会话内改语音偏好为其他档 | 下一正常轮生效并记录 `override_applied=true`；高风险/高焦虑轮仍强制 `calm_slow`（`override_applied=false`） |

## 3. 第二段：终端演示自动化测试（场景 8）

```bash
cd /Users/qiuwenjing/Documents/voice-psychology-research-demo
./cmd.sh test          # 内部执行：cd apps/api && .venv/bin/python -m pytest tests -v
```

预期结果（2026-09-27 实跑记录）：

```text
====================== 53 passed, 183 warnings in 40.15s =======================
```

- **53 条全部通过**：33 条集成（FastAPI TestClient + 真实 MySQL，conftest 自动跑迁移并注入 demo1/demo2）+ 20 条单元（纯函数，不依赖网络/数据库）。
- 其中 **8 条为真实 DeepSeek 调用**（题目允许联网；策略类测试断言结构与行为，不断言具体文案，避免对测试句子硬编码答案）。
- 安全分流、账户鉴权、数据隔离**不 Mock**：高风险测试用"LLM 调用即抛错"的探针证明根本没走到 LLM；越权测试用两个真实账号真实 token。

用例分布（33 集成）：

| 测试文件 | 覆盖点 | 条数 | 真实 LLM |
| --- | --- | --- | --- |
| `test_normal_strategy.py` | 一般焦虑选正常策略；策略记录持久化且字段完整（含 tts_params） | 2 | ✔ |
| `test_ambiguous_confirmation.py` | 模糊风险 → 固定确认问题 + 只问一问约束 + 会话风险升级 | 2 | —（规则路径） |
| `test_high_risk_escalation.py` | 高风险不经 LLM 且文案五要素在场；会话级风险升级；药物请求同样分流 | 3 | —（规则路径） |
| `test_grounding_calm_slow.py` | 紧张输入选 grounding + calm_slow 实际参数（LLM 建议被服务端规则覆盖）；长回复按约束截断；fake 输出过真实 Schema | 3 | —（确定性 fake） |
| `test_rejection_memory.py` | 拒绝后第二轮不再选用且面板有避开说明；LLM 通道拒绝同样入记忆 | 2 | ✔ |
| `test_cross_user_isolation.py` | 越权读/写/结束/删除全 404 + 列表隔离；未认证 401；错密码 401 | 3 | — |
| `test_history_and_summary.py` | 结束→总结 8 字段→重登可见历史；重复结束幂等；结束后发消息 409；他人仍不可见 | 2 | —（fake 总结保确定性） |
| `test_stream_endpoint.py` | 流式 delta + 以校验后的 result 结束且落库；规则路径无 delta 只有一个 result | 2 | ✔ |
| `test_external_service_failure.py` | LLM/ASR 挂 → 502 且**不落库不伪造**；LLM 宕机时高风险安全分流依然有效 | 3 | — |
| `test_audit_and_redaction.py` | 登录/失败登录/安全分流/删除/改偏好 5 类审计；消息内容（marker 探针）不进日志与审计表 | 5 | — |
| `test_voice_profile_override.py` | 语音偏好编辑持久化/清除；已结束会话 409；高风险忽略 override；正常轮 override 生效 | 4 | 2 条 ✔ |
| `test_session_cleanup.py` | 删除会话清掉消息/策略记录/本地音频；删除后跨用户访问不可见 | 2 | — |

单元测试（20 条，`tests/unit/test_core_logic.py`）：

| 覆盖点 | 条数 |
| --- | --- |
| 安全词表分档与优先级（high 优先于 ambiguous、正常文本不误报） | 4 |
| 拒绝正则通道（呼吸/计划/换角度 + 无拒绝不误报） | 4 |
| 拒绝记忆去重 + avoided_techniques 原因说明 | 1 |
| voice_profile 优先级矩阵（安全/状态压制 override、偏好生效） | 5 |
| 回复约束：句数截断、多问号只留一问 | 2 |
| 流式 JSON 分块提取（跨 chunk 边界 + 转义） | 1 |
| ASR 副语言特征聚合（仅数值参与统计） | 1 |
| 音高估计（周期帧出频率、静音返回 None） | 2 |

## 4. 自动化覆盖明细：题目 5 项必做测试的对应

| 题目必做测试 | 对应用例 | 性质 |
| --- | --- | --- |
| 1. 普通焦虑输入选择正常支持策略 | `test_normal_anxiety_selects_support_strategy` | 真实 LLM + 真实 DB |
| 2. 模糊风险进入安全确认 | `test_ambiguous_input_returns_safety_confirmation` | 真实 DB（确定性规则路径） |
| 3. 高风险一定进入 safety_escalation | `test_high_risk_enters_safety_escalation_without_llm` | 真实 DB，断言 LLM 调用数为 0 |
| 4. 拒绝方法后不再选择 | `test_rejected_technique_is_not_reused` | 真实 LLM + 真实 DB |
| 5. 账户 A 无权读取账户 B 的会话 | `test_cross_user_session_access_is_blocked` | 真实双账号，不 Mock |

## 5. 覆盖边界：测了什么 / 没测什么

| 类别 | 内容 | 验证方式 |
| --- | --- | --- |
| **自动化已覆盖** | 策略选择与 Schema、三档风险全路径、TTS 参数与优先级（含 override/安全压制）、拒绝记忆（双通道）、鉴权与隔离（5 个攻击面）、历史与总结（含幂等/409）、流式端点、外部服务失败不伪造（502 + 不落库）、审计与日志脱敏、会话删除、回复约束截断、ASR 特征聚合 | 53 条测试（第 3 章明细） |
| **仅现场演示可验** | 真机 TTS 实际发声与三档听感差异（参数正确性已由测试锁定，"听"需现场）；语音输入的完整真实链路（一次真实录音 → 腾讯 ASR → 回复，失败路径已测）；策略面板/各页面 UI 呈现 | 第 2 章场景 + 补充演示 |
| **LLM 相关边界** | 集成测试中 grounding/总结等用确定性 fake 保证可重复；真实 LLM 行为由 8 条真调用用例与现场演示覆盖（断言结构与行为、不断言文案，符合题目"不得硬编码答案"） | — |
| **未实现** | GAD-7 量表、ASR 低置信度二次确认（设计文档列为非目标/预留） | — |

## 6. 加分项状态

| 加分项（题目第七节） | 状态 | 证据 |
| --- | --- | --- |
| 删除会话及相关音频数据 | ✅ | `DELETE /api/sessions/{id}` + `test_session_cleanup.py`（2 条） |
| 用户标记"有帮助/无帮助"并影响后续策略 | ✅ | `PATCH /api/messages/{id}/feedback`，标记无帮助 → 该 technique 加入拒绝记忆（`main.py`） |
| 用户编辑 Agent 语音风格 | ✅ | `PATCH /api/sessions/{id}/preferences` + `test_voice_profile_override.py`（4 条）；服务端强制安全优先，非仅 UI |
| 敏感数据加密、日志脱敏或审计机制 | ✅（日志脱敏 + 审计） | `audit_logs` 表只存结构化元数据，消息内容/转写不进日志（marker 探针测试）；静态加密未做（见第 7 章） |
| GAD-7 自评及趋势 | ❌ 未做 | 设计文档非目标 |
| ASR 低置信度二次确认 | ❌ 未做 | 预留，不阻塞 |

另有一项超出题目要求的实现：**SSE 流式回复端点**（`/api/sessions/{id}/messages/stream`，`test_stream_endpoint.py` 2 条）。

## 7. 已知限制

| 限制 | 说明 |
| --- | --- |
| LLM 输出非确定 | 真实 DeepSeek 调用的回复文案每次不同；测试只断言结构/枚举/约束，行为正确性由校验层保证（失败重试 1 次，仍失败 502 不伪装） |
| 演示依赖 | 演示机需自带中文 TTS 引擎；ASR/DeepSeek 需网络可达（失败会显式 502，不静默降级） |
| 部署形态 | 本地可运行（题目要求），未做公网部署、注册/找回密码、静态数据加密（传输为本地回环，日志脱敏与审计已覆盖敏感面） |
| 安全词表 | 确定性规则是防线而非全集，词表外的表达依赖 LLM 结构化判断兜底（第 2 层）与校验失败兜底（第 3 层） |
