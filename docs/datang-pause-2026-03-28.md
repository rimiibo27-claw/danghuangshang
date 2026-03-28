# 赛博大唐暂停纪要（2026-03-28）

状态：暂停  
仓库分支：`main`  
记录时仓库 HEAD：`8376c92dbf4b321a70557b5eeb8018eb3b558eb2`

## 1. 本文目的

这份文档不是“已修复说明”，而是停项档案。

目标是把截至 `2026-03-28` 对“大唐 / 三省 / 宣政殿”这套多 Agent 讨论链路的真实问题、证据、已尝试修补点、剩余未解点完整留档，方便未来重启时直接接手，而不是再从头猜。

## 2. 截止停项时的结论

结论很直接：

- 三省讨论链路曾经可以局部跑通，但没有达到“稳定可交付”。
- 问题已经不是单纯 prompt 不够强，也不是只差一两个 if。
- 真实卡点落在“共享频道中的会话污染 + 角色接棒唤醒不稳定 + 结构化输出脆弱”三者叠加。
- 因此继续在原运行态上小修小补，性价比很低。

## 3. 最终观察到的故障分层

### A. 结构化输出脆弱

门下省输出的 `REVIEW` JSON 一旦字段为空、数组损坏、引号转义不完整，守卫就会把整条链路卡死。

最典型证据：

```text
2026-03-28T07:06:25.372+08:00 [gateway] datang-chaotang-guard:
blocked invalid assistant transcript account=neige
reason=empty_major_objections:neige
case=热点验收-20260328-B round=1
```

来源：

- `/Users/miibo/.openclaw/logs/gateway.err.log`

这说明“模型已经开口”不等于“链路可以推进”。只要 formal payload 不够稳，状态机就停。

### B. 共享频道会话污染

在同一个 Discord 频道里，非当前轮次的官员也可能被拉起并写入自己的会话。  
这会造成连续 `user` turn，被 OpenClaw 自己当成异常上下文清理。

最典型证据：

```text
2026-03-28T08:01:44.493+08:00 [agent/embedded]
Removed orphaned user message to prevent consecutive user turns.
runId=0b0ad9fd-58ec-48c2-9cd6-8a1a79337cc2
sessionId=f13c10bc-8425-4201-8db1-a3c50f00665e
```

来源：

- `/Users/miibo/.openclaw/logs/gateway.err.log`

这不是“某次模型发疯”，而是架构层问题：多角色共享频道时，错误角色也能吃到上一手的正式回文。

### C. 接棒唤醒不稳定

即使前一手已经成功发出并被 canonicalize，下一手也不一定会被稳定拉起。

截至停项前，最新 live 案 `热点验收-20260328-D` 的表现是：

- 人类发案成功
- 中书省第 1 轮 `DRAFT` 成功发出
- 状态推进到 `await_review`
- 但门下省没有继续接棒

关键证据：

```text
2026-03-28T08:08:55.629+08:00 [gateway] datang-chaotang-guard:
reset xuanzhengdian case=热点验收-20260328-D round=1 sender=1478708449968656438

2026-03-28T08:09:21.137+08:00 [gateway] datang-chaotang-guard:
canonicalized assistant transcript account=silijian case=热点验收-20260328-D round=1 stage=DRAFT

2026-03-28T08:09:21.140+08:00 [gateway] datang-chaotang-guard:
advanced from assistant transcript account=silijian case=热点验收-20260328-D
phase=await_review round=1 expected=neige
```

同时，停项前没有观察到对应的：

- `relay sent case=热点验收-20260328-D ... next=neige`
- `canonicalized assistant transcript account=neige case=热点验收-20260328-D`

来源：

- `/Users/miibo/.openclaw/logs/gateway.log`

这意味着“状态机知道下一手应该是门下省”与“运行时真的把门下省叫醒”仍然不是同一件事。

### D. 运行时本身存在额外噪音

当时运行环境还出现过 Discord gateway 异常断连：

```text
2026-03-28T08:03:33.665+08:00 [discord] gateway:
WebSocket connection closed with code 1006
```

以及更早一轮的：

```text
2026-03-28T07:45:32.199+08:00 [openclaw] Uncaught exception:
Error: Max reconnect attempts (0) reached after code 1005
```

这类噪音不一定是大唐逻辑本身造成，但会让真实验收结果更不稳定。

## 4. 截止停项时，哪些东西是“确实曾经工作过的”

`热点验收-20260328-C` 一度完成了 2 轮闭环，并收敛到终局裁决。

关键日志：

```text
2026-03-28T08:00:46.128+08:00 canonicalized assistant transcript account=neige case=热点验收-20260328-C round=1 stage=REVIEW
2026-03-28T08:01:21.063+08:00 canonicalized assistant transcript account=shangshu case=热点验收-20260328-C round=1 stage=DECISION
2026-03-28T08:02:33.390+08:00 canonicalized assistant transcript account=neige case=热点验收-20260328-C round=2 stage=REVIEW
2026-03-28T08:03:17.025+08:00 canonicalized assistant transcript account=shangshu case=热点验收-20260328-C round=2 stage=DECISION
2026-03-28T08:03:17.027+08:00 advanced from assistant transcript account=shangshu case=热点验收-20260328-C phase=closed round=2 expected=(none)
```

对应频道消息可见：

- 人类起案：`1487239734861500456`
- 中书第 1 轮：`1487239858475892928`
- 门下第 1 轮：`1487239995692679168`
- 尚书第 1 轮：`1487240142258180197`
- 中书第 2 轮：`1487240230753927278`
- 门下第 2 轮：`1487240445670064250`
- 尚书终局：`1487240628164104434`

这说明：

- 三省人格并非完全无效。
- 当前实现可以“偶尔形成完整闭环”。
- 但这个闭环无法证明系统已经稳定，因为同一阶段也观测到了会话污染和下一手唤醒失败。

## 5. 截止停项前，已经尝试过的修补方向

以下方向已经做过，不应再从头重复摸索：

1. 把状态推进从依赖“频道 echo 回流”改为尽量依赖正式 transcript / sent 事件推进。
2. 给 `REVIEW` 结构加过更宽松的 malformed payload 修复思路。
3. 针对共享频道串扰，加过“正式回文只允许写入真正下一手会话”的拦截思路。
4. 清理过运行态里的大唐专用 Discord accounts、控制文件、工作区、会话污染。
5. 做过真实 Discord 热点验收，而不是只跑玩具 case。

也就是说，未来若重启，不要再把重点放在：

- 单纯重写 prompt
- 单纯增加 few-shot
- 单纯再跑一遍小案例说“似乎好了”

## 6. 更可信的根因判断

如果以后要重启，我建议默认采用下面这个判断框架：

1. **三省不是“多 persona prompt”问题，而是“多参与者对话编排”问题。**
   当前失败核心在 orchestration，不在人设文案。

2. **共享频道 + 被动 mention 触发，不足以支撑稳定多轮讨论。**
   只靠频道消息被谁看见、谁被提及、谁碰巧起 run，太脆。

3. **formal payload 必须有硬校验、重试、降级策略。**
   不能把“模型一次吐对 JSON”当作运行前提。

4. **下一手唤醒必须是显式调度，不应主要依赖频道自然回流。**
   状态机知道 `expected=neige`，还不够；需要一个可验证的 dispatch。

5. **每个官员必须有独立的会话邮箱/线程边界。**
   不能再让“别人的正式回文”默认落进当前官员 session。

## 7. 如果未来要重启，优先级建议

### 最高优先级

- 把“三省讨论”重构成显式调度流，不再依赖共享频道自然唤醒。
- 一手发完后，直接由 orchestrator 定向触发下一手，而不是只在频道里 mention。
- formal schema 校验失败时，进入自动重试或 repair，而不是直接卡死整案。

### 次高优先级

- 每个官员使用独立对话上下文，不共享原始频道 transcript。
- 频道只作为“展示层”，不作为真实状态推进的唯一来源。

### 低优先级

- 再微调人设
- 再润色 JSON 模板
- 再补更多礼貌性转场文案

## 8. 当前运行态说明

`2026-03-28` 已经把本机运行态里的“赛博大唐”彻底清理掉，只保留：

- OpenClaw `main`
- Telegram `laowang`
- Telegram `wangcai`
- Discord `default -> main`

因此：

- 当前本机 `.openclaw` 已不再保留大唐插件与控制文件
- 仓库保留此纪要，作为以后重启的唯一暂停档案之一

## 9. 建议的下次重启入口

如果以后真要重启，建议从下面两件事开始：

1. 先设计新的 orchestration 方案，再决定是否复用旧 prompt。
2. 先做“可验证 dispatch + per-role mailbox”的最小闭环原型，再接 Discord 展示层。

不要反过来。
