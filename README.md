# 焦虑人群语音心理支持 Agent

面向成年焦虑人群的 AI 心理支持 Agent（React Native App + FastAPI + MySQL）。用户登录后可通过文字或语音进行多轮交流；服务端每轮先经过**确定性安全规则 + LLM 结构化判断**评估焦虑程度与风险，再选择支持策略生成简短回复，并按「安全 > 状态 > 偏好 > 默认」优先级选定语音档案，交由 Android 系统 TTS 以可验证的不同参数播放；会话结束后生成总结并持久化。

> **产品边界**：本系统是非医疗性质的辅助性心理支持工具，不得声称能够诊断或治疗焦虑症，不能替代心理咨询师、精神科医生或紧急援助服务。

## 一、启动方式

```bash
# 1. 后端依赖
python3 -m venv apps/api/.venv
apps/api/.venv/bin/pip install -e "apps/api[dev]"

# 2. 配置环境变量（MySQL / 腾讯云 ASR / DeepSeek / JWT_SECRET）
cp apps/api/.env.example apps/api/.env
#    可选：改用本项目专属数据库（与任何其他项目的 MySQL 完全隔离）：
#    ./cmd.sh db:up   # MySQL 8 容器，端口 33061；再把 .env 中 DATABASE_URL 切到注释里的 33061 地址

# 3. 数据库迁移 + 注入验收测试账号（demo1 / demo2，密码 Passw0rd!）
./cmd.sh db:migrate
./cmd.sh seed

# 4. 启动后端（http://127.0.0.1:8000）
./cmd.sh api

# 5. 移动端（真机演示）
pnpm install
./cmd.sh usb       # adb reverse + 安装启动（需重新构建以包含 react-native-tts 原生模块）
./cmd.sh apk       # 或构建 release APK
```

前端固定连接 `http://127.0.0.1:8000/api`（真机经 `adb reverse tcp:8000 tcp:8000`）。

## 二、架构

| 组件　　　　　　　　　　 | 职责　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　 |
| --------------------------| ------------------------------------------------------------------------------------|
| React Native App　　　　 | 登录态、聊天 UI、录音上传、TTS 三档参数播放、语音风格实时编辑、策略观察面板　　　　|
| FastAPI　　　　　　　　　| JWT 鉴权、会话/消息 CRUD、每轮同步流水线（安全规则 → LLM → 校验 → 落库）、总结生成、审计与脱敏日志 |
| MySQL　　　　　　　　　　| `users` / `sessions` / `messages` / `strategy_records` / `audit_logs` 五表（yoyo 迁移）　　　　 |
| 腾讯云 ASR flash/v1　　　| 语音转写 + 句级语速/情感能量等副语言特征　　　　　　　　　　　　　　　　　　　　　 |
| DeepSeek (`json_object`) | 每轮输出「策略记录 + 回复」结构化 JSON；会话结束输出总结 JSON　　　　　　　　　　　|
| Android 系统 TTS　　　　 | 按档案参数（rate/pitch/句间停顿）播放回复　　　　　　　　　　　　　　　　　　　　　|

每轮处理流水线：

```
输入（文字 或 语音→ASR+副语言特征）
→ 第 1 层：确定性关键词安全规则（high 直接固定安全文案并跳过 LLM；ambiguous 固定安全确认问题）
→ 第 2 层：DeepSeek 单次调用输出策略记录 + 回复（LLM 可将风险升级，安全正文仍由服务端固定文案兜底）
→ Pydantic 严格校验（枚举/类型/observed_signals 非空），失败带错误说明重试 1 次，仍失败显式报错（502），不静默降级
→ voice_profile 服务端按固定优先级确定性推导 → TTS 参数随响应下发并落库
→ 消息与策略记录持久化
```

## 三、数据模型

| 表 | 关键字段 |
|---|---|
| `users` | `username` UNIQUE, `password_hash`(bcrypt), `created_at` |
| `sessions` | `user_id` FK, `concern`, `expression_preference`('gentle'/'concise'), `voice_reply_enabled`, `voice_profile_override`(用户可编辑语音风格, NULL=自动), `rejected_techniques` JSON, `status`('active'/'ended'), `max_risk_level`, `safety_triggered`, `summary` JSON, `created_at`, `ended_at` |
| `messages` | `session_id` FK, `role`, `content`, `audio_path`(本地相对路径), `asr_features` JSON（句级语速/能量/响度/音高）, `created_at` |
| `strategy_records` | `session_id`, `message_id`, `anxiety_level`, `risk_level`, `observed_signals`, `support_goal`, `technique`, `technique_reason`, `response_constraints`, `voice_profile`, `tts_params`(实际下发参数, 含 override_applied), `avoided_techniques`, `is_safety_escalation`, `source`('rule'/'llm') |
| `audit_logs` | `user_id`, `action`(login/login_failed/session_create/session_delete/session_end/safety_escalation/session_preferences_update), `session_id`, `detail` JSON（仅结构化枚举元数据）, `created_at` — 追加型审计，不存任何消息内容/转写 |

## 四、策略依据与四条支持路径

| 路径 | technique | 方法学依据 | 关键约束 |
|---|---|---|---|
| A 情绪确认与澄清 | `validation` / `clarification` | 支持性倾听、澄清式提问 | 承认感受 + 询问具体诱因，不输出大段通用建议 |
| B 即时稳定 | `grounding` | 5-4-3-2-1 感官定位、简短呼吸引导 | 短句、一次只给一个简单步骤，不强迫接受 |
| C 认知与行动整理 | `reframing` / `action_planning` | CBT 认知重构与行为激活 | 区分事实/推测，一至两个可行小步骤，不作保证性承诺 |
| D 安全分流 | `safety_escalation` | 危机响应规范 | 固定文案，完全跳过普通支持流程 |

适用边界：以上均为心理支持通用技术，本系统不进行任何临床诊断、治疗或用药指导。

三档风险处理：`normal` 走正常策略；`ambiguous` 先发一次直接的安全确认问题，不给一般建议；`high` 停止普通对话，进入固定安全分流文案（说明能力边界 / 鼓励联系专业人员 / 紧急风险建议联系当地紧急服务 / 不提供药物剂量与保证性承诺 / 语气温和）。

## 五、自适应语音回复（参数可验证）

voice_profile 由服务端按**安全要求 > 当前状态 > 用户表达偏好 > 默认设置**确定性推导（不直接采信 LLM 建议）：

| 档案 | rate | pitch | 句间停顿 | 适用 |
|---|---|---|---|---|
| `calm_slow` | 0.7 | 0.9 | 800ms | 明显紧张 / 安全轮 |
| `warm_normal` | 1.0 | 1.0 | 400ms | 一般焦虑 |
| `concise_direct` | 1.15 | 1.0 | 200ms | 状态稳定且偏好直接 |

实际下发的 `tts_params` 每轮落库并在策略观察面板展示（rate/pitch/停顿），App 端 `react-native-tts` 按句分段播放并在句间插入对应停顿，三档参数真实不同。

用户还可在聊天页实时编辑语音风格（「自动 / 舒缓慢速 / 温和正常 / 简洁明快」，`PATCH /api/sessions/{id}/preferences`），但服务端强制：**安全分流轮、高/模糊风险轮、高焦虑轮一律忽略用户选择回退 `calm_slow`**，优先级不变；每轮 `tts_params.override_applied` 记录用户选择是否生效，面板可见。

## 六、账户与安全边界

- JWT Bearer + bcrypt 哈希存储；密码不明文；登录失败 401 明确提示。
- 所有会话/消息接口强制鉴权，查询一律以 `session.user_id == current_user.id` 过滤，越权访问返回 404（不泄露存在性）。
- 方法拒绝记忆：正则 + LLM 字段双通道检测，命中后写入 `sessions.rejected_techniques`，后续每轮 Prompt 注入并禁止选用；服务端二次校验撞拒方法时重试一次，仍撞上则显式失败。
- 安全判断不依赖单一对话 Prompt：确定性关键词词表在 LLM 之前运行；LLM 只负责识别升级，安全响应正文全部为服务端固定文案；LLM 输出校验失败时显式报错，绝不伪装成功。
- 敏感数据治理（加分项）：①追加型审计表 `audit_logs` 记录登录/建会/删会/结束/安全分流/偏好修改，仅存枚举与元数据；②HTTP 中间件日志只记方法/路径/状态/耗时，消息正文与转写永不入日志（测试断言消息内容不出现在任何日志与审计行中）。

## 七、测试

```bash
./cmd.sh test    # = apps/api/.venv/bin/python -m pytest tests -v（自动跑迁移 + 注入测试账号）
```

| #   | 测试（`apps/api/tests/`）　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　 | LLM　　　　|
| -----| ---------------------------------------------------------------------------------------------------------------| ------------|
| 1   | `test_normal_strategy.py` 普通焦虑输入选择正常支持策略，Schema 校验通过、记录可回读　　　　　　　　　　　　　 | 真实调用　 |
| 2   | `test_ambiguous_confirmation.py` 模糊风险进入安全确认（固定问题、不给一般建议）　　　　　　　　　　　　　　　 | 规则　　　 |
| 3   | `test_high_risk_escalation.py` 明确高风险进入 `safety_escalation`，**LLM 调用次数断言为 0**　　　　　　　　　 | 不经过 LLM |
| 4   | `test_rejection_memory.py` 拒绝方法后 `rejected_techniques` 记录、后续轮次不再选用且面板说明避开原因　　　　　| 真实调用　 |
| 5   | `test_cross_user_isolation.py` demo2 访问 demo1 的会话：读取/发消息/结束/删除均 404；未登录 401；错误密码 401 | 不涉及　　 |
| 6   | `test_external_service_failure.py` LLM/ASR 不可用 → 502 且不落任何伪造回复；LLM 宕机时高危输入仍走安全分流　 | 模拟故障　 |
| 7   | `test_session_cleanup.py` 删除会话：消息/记录级联清除 + 磁盘音频文件与目录删除　　　　　　　　　　　　　　　 | 不涉及　　 |
| 8   | `test_voice_profile_override.py` 语音风格可编辑；高危/高焦虑轮忽略用户选择（解析函数单测 + 接口集成）　　　 | 真实调用　 |
| 9   | `test_audit_and_redaction.py` 登录/删会/安全分流写入审计；消息内容不出现在日志与审计行（caplog 断言）　　　 | 不涉及　　 |

策略类测试真实调用 DeepSeek（需在 `.env` 配置 `DEEPSEEK_API_KEY`），断言结构与行为、不断言具体文案；安全分流与鉴权测试不 Mock。

## 八、已知限制

- 本地演示形态，未部署公网；未做注册/找回密码/第三方登录。
- 三档 TTS 参数为建议初始值，不同机型引擎听感有差异，演示前建议真机调校。
- 句级副语言特征依赖腾讯 ASR 实际返回，缺失时降级为纯文本判断（面板可查看 asr_features）。
- 每轮 Prompt 仅注入最近 10 条历史消息，超长会话不做全量上下文。
- 未实现的加分项：GAD-7 自评量表、回复「有帮助/无帮助」反馈、ASR 低置信度二次确认。
- 语音风格编辑为会话级设置（存 `sessions.voice_profile_override`），未做全局用户级默认。

## 九、与原项目（voice-psychology-research-demo）的复用与改动清单

详细清单见 `docs/焦虑支持Agent-改造文档.md`。摘要：

- **复用**：FastAPI 应用与 CORS 骨架、SQLAlchemy + yoyo 迁移体系、腾讯云 ASR 签名调用（`transcribe_m4a`）、DeepSeek `json_object` 调用骨架（重构为通用 `call_deepseek_json`）、本地声学特征提取、RN 原生录音模块（`services/recorder.ts`）、`cmd.sh` 启动脚本、`.env` 配置体系。
- **新增**：账户体系（JWT + bcrypt，`auth.py`）、四张新表与迁移、确定性安全词表与固定安全文案（`safety.py`）、策略 Prompt 与每轮流水线（`strategy.py`）、方法拒绝检测与记忆（`rejection.py`）、三档语音档案（`tts_profiles.py`）、会话总结（`summary.py`）、Pydantic 策略 Schema（`schemas.py`）、登录/创建会话/聊天/历史/总结五屏 + 策略观察面板 + TTS 服务、5 项 pytest 测试、测试账号 seed.sql。
- **删除**：Worker 异步任务队列、COS 分块断点续传、旧单轮采集分析路由与三张旧表、录音列表/详情页与环境切换组件。
- **本轮新增（工程加固与加分项）**：`voice_profile_override` 会话级语音风格编辑（服务端强制安全优先）、`audit_logs` 审计表与埋点、HTTP 脱敏日志中间件、删除会话的磁盘级联清理、LLM/ASR 故障不伪装成功的服务端测试、独立数据库容器命令（`db:up`/`db:down`/`db:reset`）、JWT secret 强度要求（≥32 字节）、修复 multipart 语音上传被 422 拒绝的类型判断 bug。
