import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDatangChaotangGuard } from "./guard-core.mjs";
import { runAction } from "./toggle-datang-freeze.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "datang-chaotang-guard-"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function unwrapForwardedContent(result, fallbackContent) {
  assert.notDeepEqual(result, { cancel: true });
  return typeof result?.content === "string" ? result.content : fallbackContent;
}

test("global mute cancels protected account sends before channel-specific rules", () => {
  const tempDir = makeTempDir();
  const controlFile = path.join(tempDir, "control.json");
  writeJson(controlFile, { globalMute: true, lastAction: "freeze", accountSnapshot: {} });

  const guard = createDatangChaotangGuard({ controlFile });
  const result = guard.handleMessageSending(
    { to: "1482260119025614989/1482260119457632359", content: "朝会回报" },
    { channelId: "discord", accountId: "silijian" },
    {},
  );

  assert.deepEqual(result, { cancel: true });
});

test("xuanzhengdian guard enforces round-based three-province discussion", () => {
  const tempDir = makeTempDir();
  const controlFile = path.join(tempDir, "control.json");
  writeJson(controlFile, { globalMute: false, lastAction: "unfreeze", accountSnapshot: {} });

  const guard = createDatangChaotangGuard({
    controlFile,
    maxDiscussionRounds: 3,
    maxDiscussionTurns: 9,
    xuanzhengdianBlockedAccounts: [
      "duchayuan",
      "bingbu",
      "hubu",
      "libu",
      "gongbu",
      "libu2",
      "xingbu",
      "hanlinyuan",
      "mige",
      "dianzhongsheng",
    ],
  });
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content:
        [
          "【闭环演示案-丙】用户发起：请三省在最多 3 轮内讨论出当前最优可行方案，只讨论，不派工。",
          JSON.stringify({
            case_key: "闭环演示案-丙",
            max_rounds: 3,
          }),
        ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const shangshuPreflight = guard.handleBeforeAgentStart(
    { prompt: "宣政殿消息", messages: [] },
    {
      agentId: "shangshu",
      channelId: "discord",
      sessionKey: "agent:shangshu:discord:channel:1482260425616789595",
    },
    {},
  );
  assert.equal(shangshuPreflight.providerOverride, "minimax-portal");
  assert.match(shangshuPreflight.appendSystemContext, /只输出：NO_REPLY|NO_REPLY/);

  assert.deepEqual(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: "**await_draft 阶段，我非当前应答方（silijian），静默。**\n\nNO_REPLY",
        metadata: { accountId: "shangshu" },
      },
      { channelId: "discord" },
      {},
    ),
    { cancel: true },
  );

  const blockedShangshuBeforeReview = guard.handleMessageSending(
    {
      to: "guild/1482260425616789595",
      content: [
        "尚书省抢先收敛。",
        JSON.stringify({
          chain_stage: "DECISION",
          case_key: "闭环演示案-丙",
          round: 1,
          status: "REVISE_NEXT_ROUND",
        }),
      ].join("\n"),
    },
    { channelId: "discord", accountId: "shangshu" },
    {},
  );
  assert.deepEqual(blockedShangshuBeforeReview, { cancel: true });

  const silijianRound1Content = unwrapForwardedContent(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "中书省提交第 1 轮方案。",
          JSON.stringify({
            chain_stage: "DRAFT",
            case_key: "闭环演示案-丙",
            round: 1,
            objective: "验证三省回合制讨论",
            candidate_plan: { summary: "先收集边界，再收敛单案方案" },
            key_assumptions: ["只允许三省发言"],
            tradeoffs: ["讨论速度降低，稳定性提升"],
          }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "silijian" },
      {},
    ),
    [
      "中书省提交第 1 轮方案。",
      JSON.stringify({
        chain_stage: "DRAFT",
        case_key: "闭环演示案-丙",
        round: 1,
        objective: "验证三省回合制讨论",
        candidate_plan: { summary: "先收集边界，再收敛单案方案" },
      }),
    ].join("\n"),
  );

  assert.deepEqual(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "中书省重复发言，不应通过。",
          JSON.stringify({
            chain_stage: "DRAFT",
            case_key: "闭环演示案-丙",
            round: 1,
            objective: "不该二次发言",
          }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "silijian" },
      {},
    ),
    { cancel: true },
  );

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: silijianRound1Content,
      metadata: { senderId: "1482003317327659049", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const neigeRound1Content = unwrapForwardedContent(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "门下省给出第 1 轮反对意见。",
          JSON.stringify({
            chain_stage: "REVIEW",
            case_key: "闭环演示案-丙",
            round: 1,
            verdict: "REVISE",
            major_objections: ["缺少失败退出条件"],
            required_changes: ["补齐终局状态"],
          }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "neige" },
      {},
    ),
    [
      "门下省给出第 1 轮反对意见。",
      JSON.stringify({
        chain_stage: "REVIEW",
        case_key: "闭环演示案-丙",
        round: 1,
        verdict: "REVISE",
        major_objections: ["缺少失败退出条件"],
      }),
    ].join("\n"),
  );

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: neigeRound1Content,
      metadata: { senderId: "1482007277140709508", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const shangshuRound1Content = unwrapForwardedContent(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "尚书省裁决进入下一轮。",
          JSON.stringify({
            chain_stage: "DECISION",
            case_key: "闭环演示案-丙",
            round: 1,
            status: "REVISE_NEXT_ROUND",
            decision_summary: "继续讨论一轮，补齐退出条件",
            required_revisions: ["补齐终局状态"],
            next_round: 2,
          }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "shangshu" },
      {},
    ),
    [
      "尚书省裁决进入下一轮。",
      JSON.stringify({
        chain_stage: "DECISION",
        case_key: "闭环演示案-丙",
        round: 1,
        status: "REVISE_NEXT_ROUND",
        decision_summary: "继续讨论一轮，补齐退出条件",
        next_round: 2,
      }),
    ].join("\n"),
  );

  const blockedNeigeOutOfTurn = guard.handleMessageSending(
    {
      to: "guild/1482260425616789595",
      content: [
        "门下省越序补充。",
        JSON.stringify({
          chain_stage: "REVIEW",
          case_key: "闭环演示案-丙",
          round: 2,
          verdict: "REVISE",
        }),
      ].join("\n"),
    },
    { channelId: "discord", accountId: "neige" },
    {},
  );
  assert.deepEqual(blockedNeigeOutOfTurn, { cancel: true });

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: shangshuRound1Content,
      metadata: { senderId: "1482262068760416317", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const silijianRound2Content = unwrapForwardedContent(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "中书省提交第 2 轮修订方案。",
          JSON.stringify({
            chain_stage: "DRAFT",
            case_key: "闭环演示案-丙",
            round: 2,
            objective: "补齐终局状态并保持只讨论",
            candidate_plan: { summary: "加入共识终局与人工升级终局" },
            key_assumptions: ["最多 3 轮"],
            tradeoffs: ["更稳，但输出更严格"],
          }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "silijian" },
      {},
    ),
    [
      "中书省提交第 2 轮修订方案。",
      JSON.stringify({
        chain_stage: "DRAFT",
        case_key: "闭环演示案-丙",
        round: 2,
        objective: "补齐终局状态并保持只讨论",
        candidate_plan: { summary: "加入共识终局与人工升级终局" },
      }),
    ].join("\n"),
  );

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: silijianRound2Content,
      metadata: { senderId: "1482003317327659049", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const neigeRound2Content = unwrapForwardedContent(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "门下省确认第 2 轮可收敛。",
          JSON.stringify({
            chain_stage: "REVIEW",
            case_key: "闭环演示案-丙",
            round: 2,
            verdict: "APPROVED",
            major_objections: [],
            required_changes: [],
          }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "neige" },
      {},
    ),
    [
      "门下省确认第 2 轮可收敛。",
      JSON.stringify({
        chain_stage: "REVIEW",
        case_key: "闭环演示案-丙",
        round: 2,
        verdict: "APPROVED",
      }),
    ].join("\n"),
  );

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: neigeRound2Content,
      metadata: { senderId: "1482007277140709508", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  unwrapForwardedContent(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "尚书省宣布形成共识。",
          JSON.stringify({
            chain_stage: "DECISION",
            case_key: "闭环演示案-丙",
            round: 2,
            status: "CONSENSUS_REACHED",
            decision_summary: "当前方案已满足目标与边界，可以收口。",
            selected_direction: "三省回合制讨论 + 终局熔断",
            required_revisions: [],
          }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "shangshu" },
      {},
    ),
    [
      "尚书省宣布形成共识。",
      JSON.stringify({
        chain_stage: "DECISION",
        case_key: "闭环演示案-丙",
        round: 2,
        status: "CONSENSUS_REACHED",
      }),
    ].join("\n"),
  );

  const blockedExecution = guard.handleMessageSending(
    { to: "guild/1482260425616789595", content: "工部回报施工完成" },
    { channelId: "discord", accountId: "gongbu" },
    {},
  );
  assert.deepEqual(blockedExecution, { cancel: true });

  const blockedSilijianAfterConsensus = guard.handleMessageSending(
    {
      to: "guild/1482260425616789595",
      content: [
        "中书省结案总结。",
        JSON.stringify({
          chain_stage: "DRAFT",
          case_key: "闭环演示案-丙",
          round: 3,
          objective: "不该再发言",
        }),
      ].join("\n"),
    },
    { channelId: "discord", accountId: "silijian" },
    {},
  );
  assert.deepEqual(blockedSilijianAfterConsensus, { cancel: true });
});

test("shangshu revise beyond max rounds escalates to human", () => {
  const tempDir = makeTempDir();
  const controlFile = path.join(tempDir, "control.json");
  writeJson(controlFile, { globalMute: false, lastAction: "unfreeze", accountSnapshot: {} });

  const guard = createDatangChaotangGuard({
    controlFile,
    maxDiscussionRounds: 2,
    maxDiscussionTurns: 6,
  });

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-丁】用户发起：请两轮内收敛。",
        JSON.stringify({ case_key: "闭环演示案-丁", max_rounds: 2 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const dingDraftContent = unwrapForwardedContent(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "中书省第 1 轮方案。",
          JSON.stringify({ chain_stage: "DRAFT", case_key: "闭环演示案-丁", round: 1 }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "silijian" },
      {},
    ),
    '【闭环演示案-丁】中书省第1轮提案。\n{"chain_stage":"DRAFT","case_key":"闭环演示案-丁","round":1,"objective":"","candidate_plan":"","key_assumptions":[],"tradeoffs":[],"handoff":{"next_agent":"neige","required_action":"review"}}',
  );
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: dingDraftContent,
      metadata: { senderId: "1482003317327659049", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );
  const dingReviewContent = unwrapForwardedContent(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "门下省第 1 轮审议。",
          JSON.stringify({
            chain_stage: "REVIEW",
            case_key: "闭环演示案-丁",
            round: 1,
            verdict: "REVISE",
          }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "neige" },
      {},
    ),
    '【闭环演示案-丁】门下省第1轮审议。\n{"chain_stage":"REVIEW","case_key":"闭环演示案-丁","round":1,"verdict":"REVISE","major_objections":[],"required_changes":[],"preserved_strengths":[],"handoff":{"next_agent":"shangshu","required_action":"decision"}}',
  );
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: dingReviewContent,
      metadata: { senderId: "1482007277140709508", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );
  const dingDecisionRound1Content = unwrapForwardedContent(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "尚书省要求进入第 2 轮。",
          JSON.stringify({
            chain_stage: "DECISION",
            case_key: "闭环演示案-丁",
            round: 1,
            status: "REVISE_NEXT_ROUND",
            decision_summary: "先进入第 2 轮",
            next_round: 2,
          }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "shangshu" },
      {},
    ),
    '【闭环演示案-丁】尚书省第1轮裁决：REVISE_NEXT_ROUND。\n{"chain_stage":"DECISION","case_key":"闭环演示案-丁","round":1,"status":"REVISE_NEXT_ROUND","decision_summary":"先进入第 2 轮","selected_direction":"","required_revisions":[],"next_round":2}',
  );
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: dingDecisionRound1Content,
      metadata: { senderId: "1482262068760416317", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );
  const dingDraftRound2Content = unwrapForwardedContent(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "中书省第 2 轮方案。",
          JSON.stringify({ chain_stage: "DRAFT", case_key: "闭环演示案-丁", round: 2 }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "silijian" },
      {},
    ),
    '【闭环演示案-丁】中书省第2轮提案。\n{"chain_stage":"DRAFT","case_key":"闭环演示案-丁","round":2,"objective":"","candidate_plan":"","key_assumptions":[],"tradeoffs":[],"handoff":{"next_agent":"neige","required_action":"review"}}',
  );
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: dingDraftRound2Content,
      metadata: { senderId: "1482003317327659049", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );
  const dingReviewRound2Content = unwrapForwardedContent(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "门下省第 2 轮审议。",
          JSON.stringify({
            chain_stage: "REVIEW",
            case_key: "闭环演示案-丁",
            round: 2,
            verdict: "REVISE",
          }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "neige" },
      {},
    ),
    '【闭环演示案-丁】门下省第2轮审议。\n{"chain_stage":"REVIEW","case_key":"闭环演示案-丁","round":2,"verdict":"REVISE","major_objections":[],"required_changes":[],"preserved_strengths":[],"handoff":{"next_agent":"shangshu","required_action":"decision"}}',
  );
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: dingReviewRound2Content,
      metadata: { senderId: "1482007277140709508", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const result = guard.handleMessageSending(
    {
      to: "guild/1482260425616789595",
      content: [
        "尚书省还想再来一轮。",
        JSON.stringify({
          chain_stage: "DECISION",
          case_key: "闭环演示案-丁",
          round: 2,
          status: "REVISE_NEXT_ROUND",
          decision_summary: "继续讨论",
          next_round: 3,
        }),
      ].join("\n"),
    },
    { channelId: "discord", accountId: "shangshu" },
    {},
  );

  assert.equal(typeof result?.content, "string");
  assert.match(result.content, /ESCALATE_TO_HUMAN/);
});

test("formal outbound envelopes are compacted into single-message canonical payloads", () => {
  const tempDir = makeTempDir();
  const controlFile = path.join(tempDir, "control.json");
  writeJson(controlFile, { globalMute: false, lastAction: "unfreeze", accountSnapshot: {} });

  const guard = createDatangChaotangGuard({ controlFile });
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-丁】用户发起：请三省讨论可控闭环。",
        JSON.stringify({ case_key: "闭环演示案-丁", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const draftResult = guard.handleMessageSending(
    {
      to: "guild/1482260425616789595",
      content: [
        "【中书省提出候选方案】",
        "```json",
        JSON.stringify(
          {
            chain_stage: "DRAFT",
            case_key: "闭环演示案-丁",
            round: 1,
            objective: "在宣政殿内建立可控、可停止、可收敛的三省回合讨论机制",
            candidate_plan: {
              mechanism: "一个非常长、非常长、非常长的提案描述，用来验证发送前规范化会不会把报文压缩成单条 JSON。",
            },
            key_assumptions: ["只允许三省", "三轮上限", "终局后静默"],
            tradeoffs: ["约束更强", "表达更短"],
          },
          null,
          2,
        ),
        "```",
      ].join("\n"),
    },
    { channelId: "discord", accountId: "silijian" },
    {},
  );

  assert.equal(typeof draftResult?.content, "string");
  assert.match(draftResult.content, /"chain_stage":"DRAFT"/);
  assert.ok(draftResult.content.length < 800);

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: draftResult.content,
      metadata: { senderId: "1482003317327659049", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const reviewResult = guard.handleMessageSending(
    {
      to: "guild/1482260425616789595",
      content: [
        "门下省审议。",
        JSON.stringify({
          chain_stage: "REVIEW",
          case_key: "闭环演示案-丁",
          round: 1,
          verdict: "APPROVED_WITH_SUGGESTION",
          suggestions: ["补一个主动升级触发条件"],
        }),
      ].join("\n"),
    },
    { channelId: "discord", accountId: "neige" },
    {},
  );
  assert.equal(typeof reviewResult?.content, "string");
  assert.match(reviewResult.content, /"chain_stage":"REVIEW"/);

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: reviewResult.content,
      metadata: { senderId: "1482007277140709508", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const decisionResult = guard.handleMessageSending(
    {
      to: "guild/1482260425616789595",
      content: [
        "尚书省裁决。",
        JSON.stringify({
          chain_stage: "DECISION",
          case_key: "闭环演示案-丁",
          round: 1,
          verdict: "CONSENSUS_REACHED",
          decision_summary: "采纳门下建议后可以在一轮内收敛。",
        }),
      ].join("\n"),
    },
    { channelId: "discord", accountId: "shangshu" },
    {},
  );

  assert.equal(typeof decisionResult?.content, "string");
  assert.match(decisionResult.content, /"chain_stage":"DECISION"/);
  assert.match(decisionResult.content, /"status":"CONSENSUS_REACHED"/);
  assert.ok(!decisionResult.content.includes("```"));
});

test("active xuanzhengdian case guards core outbound even when target string is ambiguous", () => {
  const tempDir = makeTempDir();
  const controlFile = path.join(tempDir, "control.json");
  writeJson(controlFile, { globalMute: false, lastAction: "unfreeze", accountSnapshot: {} });

  const guard = createDatangChaotangGuard({ controlFile });
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-戊】用户发起：请三省讨论可控闭环。",
        JSON.stringify({ case_key: "闭环演示案-戊", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const result = guard.handleMessageSending(
    {
      to: "discord-outbound-opaque-target",
      content: [
        "门下省越位发言。",
        JSON.stringify({
          chain_stage: "REVIEW",
          case_key: "闭环演示案-戊",
          round: 1,
          verdict: "REVISE",
        }),
      ].join("\n"),
    },
    { channelId: "discord", accountId: "neige" },
    {},
  );

  assert.deepEqual(result, { cancel: true });
});

test("inbound formal messages advance three-province state even without outbound hook side effects", () => {
  const tempDir = makeTempDir();
  const controlFile = path.join(tempDir, "control.json");
  writeJson(controlFile, { globalMute: false, lastAction: "unfreeze", accountSnapshot: {} });

  const guard = createDatangChaotangGuard({ controlFile, maxDiscussionRounds: 3 });
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-己】用户发起：请三省在 3 轮内讨论出可控方案。",
        JSON.stringify({ case_key: "闭环演示案-己", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: '【闭环演示案-己】中书省第1轮提案。\n{"chain_stage":"DRAFT","case_key":"闭环演示案-己","round":1,"objective":"验证入站推进","candidate_plan":"先提案再审议","key_assumptions":[],"tradeoffs":[],"handoff":{"next_agent":"neige","required_action":"review"}}',
      metadata: { senderId: "1482003317327659049", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const neigeTurn = guard.handleBeforeAgentStart(
    { prompt: "宣政殿消息", messages: [] },
    {
      agentId: "neige",
      channelId: "discord",
      sessionKey: "agent:neige:discord:channel:1482260425616789595",
    },
    {},
  );
  assert.match(neigeTurn.appendSystemContext, /当前阶段：await_decision|当前阶段：await_review/);
  assert.match(neigeTurn.appendSystemContext, /当前允许发言的下一手：neige/);
  assert.doesNotMatch(neigeTurn.appendSystemContext, /只输出：NO_REPLY/);

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: '【闭环演示案-己】门下省第1轮审议。\n{"chain_stage":"REVIEW","case_key":"闭环演示案-己","round":1,"verdict":"APPROVED","major_objections":[],"required_changes":[],"preserved_strengths":[],"handoff":{"next_agent":"shangshu","required_action":"decision"}}',
      metadata: { senderId: "1482007277140709508", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const shangshuTurn = guard.handleBeforeAgentStart(
    { prompt: "宣政殿消息", messages: [] },
    {
      agentId: "shangshu",
      channelId: "discord",
      sessionKey: "agent:shangshu:discord:channel:1482260425616789595",
    },
    {},
  );
  assert.match(shangshuTurn.appendSystemContext, /当前允许发言的下一手：shangshu/);
  assert.match(shangshuTurn.appendSystemContext, /当前阶段：await_decision/);
  assert.doesNotMatch(shangshuTurn.appendSystemContext, /只输出：NO_REPLY/);
});

test("session-scoped prompt hooks still match xuanzhengdian when channelId is absent", () => {
  const guard = createDatangChaotangGuard({});
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-庚】用户发起：请三省讨论最小可控方案。",
        JSON.stringify({ case_key: "闭环演示案-庚", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const modelResolve = guard.handleBeforeModelResolve(
    { prompt: "宣政殿消息" },
    { agentId: "silijian", sessionKey: "agent:silijian:discord:channel:1482260425616789595" },
    {},
  );
  assert.equal(modelResolve.providerOverride, "minimax-portal");
  assert.equal(modelResolve.modelOverride, "minimax-portal/MiniMax-M2.7-highspeed");

  const promptBuild = guard.handleBeforePromptBuild(
    { prompt: "宣政殿消息", messages: [] },
    { agentId: "silijian", sessionKey: "agent:silijian:discord:channel:1482260425616789595" },
    {},
  );
  assert.match(promptBuild.appendSystemContext, /当前允许发言的下一手：silijian/);
});

test("before_message_write strips Discord reaction noise from xuanzhengdian transcripts", () => {
  const guard = createDatangChaotangGuard({});
  const result = guard.handleBeforeMessageWrite(
    {
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "System: [2026-03-20 23:20 GMT+8] Discord reaction added: 👀 by 1 on msg 2",
              "",
              "【闭环演示案-丁】门下省审议通过。",
              '{"chain_stage":"REVIEW","case_key":"闭环演示案-丁","verdict":"APPROVED"}',
            ].join("\n"),
          },
        ],
      },
    },
    {
      agentId: "neige",
      sessionKey: "agent:neige:discord:channel:1482260425616789595",
      channelId: "discord",
    },
  );

  assert.ok(result?.message);
  const nextText = result.message.content[0].text;
  assert.doesNotMatch(nextText, /Discord reaction/);
  assert.match(nextText, /门下省审议通过/);
});

test("duplicate inbound replay is ignored instead of halting the case", () => {
  const tempDir = makeTempDir();
  const controlFile = path.join(tempDir, "control.json");
  const stateFile = path.join(tempDir, "state.json");
  writeJson(controlFile, { globalMute: false, lastAction: "unfreeze", accountSnapshot: {} });

  const guard = createDatangChaotangGuard({
    controlFile,
    stateFile,
    maxDiscussionRounds: 3,
    maxDiscussionTurns: 9,
  });

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-戊】用户发起：请三省就最优可行方案进行受控讨论。",
        JSON.stringify({ case_key: "闭环演示案-戊", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const draftContent = unwrapForwardedContent(
    guard.handleMessageSending(
      {
        to: "guild/1482260425616789595",
        content: [
          "中书省首轮提案。",
          JSON.stringify({
            chain_stage: "DRAFT",
            case_key: "闭环演示案-戊",
            round: 1,
            objective: "验证重复入站不致熔断",
            candidate_plan: "以案号+阶段+轮次约束单案讨论推进",
          }),
        ].join("\n"),
      },
      { channelId: "discord", accountId: "silijian" },
      {},
    ),
    '【闭环演示案-戊】中书省第1轮提案。\n{"chain_stage":"DRAFT","case_key":"闭环演示案-戊","round":1,"objective":"验证重复入站不致熔断","candidate_plan":"以案号+阶段+轮次约束单案讨论推进","key_assumptions":[],"tradeoffs":[],"handoff":{"next_agent":"neige","required_action":"review"}}',
  );

  const duplicateInboundEvent = {
    from: "1482260425616789595",
    content: draftContent,
    metadata: {
      senderId: "1482003317327659049",
      channelId: "1482260425616789595",
    },
  };

  guard.handleMessageReceived(
    duplicateInboundEvent,
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );
  const afterFirstInbound = guard.getStateForTest();

  guard.handleMessageReceived(
    duplicateInboundEvent,
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );
  const afterReplay = guard.getStateForTest();

  assert.equal(afterFirstInbound.halted, false);
  assert.equal(afterReplay.halted, false);
  assert.equal(afterReplay.phase, "await_review");
  assert.deepEqual(afterReplay.expectedAccounts, ["neige"]);
  assert.equal(afterReplay.speakerCounts.silijian, 1);
  assert.equal(afterReplay.roundSpeakerCounts.silijian, 1);
  assert.equal(afterReplay.recentInboundSignatures.length, 1);
});

test("late inbound after a closed case is ignored instead of flipping the case to halted", () => {
  const tempDir = makeTempDir();
  const controlFile = path.join(tempDir, "control.json");
  const stateFile = path.join(tempDir, "state.json");
  writeJson(controlFile, { globalMute: false, lastAction: "unfreeze", accountSnapshot: {} });

  const guard = createDatangChaotangGuard({
    controlFile,
    stateFile,
    maxDiscussionRounds: 3,
    maxDiscussionTurns: 9,
  });

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-终】用户发起：请三省完成一轮正式收敛。",
        JSON.stringify({ case_key: "闭环演示案-终", max_rounds: 3 }),
      ].join("\n"),
      metadata: {
        senderId: "1476931252576850095",
        channelId: "1482260425616789595",
        messageId: "100",
      },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content:
        '【闭环演示案-终】中书省第1轮提案。\n{"chain_stage":"DRAFT","case_key":"闭环演示案-终","round":1,"objective":"验证闭案后迟到回包不再污染状态","candidate_plan":"先过一轮正式讨论并收敛","key_assumptions":[],"tradeoffs":[],"handoff":{"next_agent":"neige","required_action":"review"}}',
      metadata: {
        senderId: "1482003317327659049",
        channelId: "1482260425616789595",
        messageId: "101",
      },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content:
        '【闭环演示案-终】门下省第1轮审议。\n{"chain_stage":"REVIEW","case_key":"闭环演示案-终","round":1,"verdict":"APPROVED","major_objections":[],"required_changes":[],"preserved_strengths":["通过"],"handoff":{"next_agent":"shangshu","required_action":"decision"}}',
      metadata: {
        senderId: "1482007277140709508",
        channelId: "1482260425616789595",
        messageId: "102",
      },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const closingDecision =
    '【闭环演示案-终】尚书省第1轮裁决：CONSENSUS_REACHED。\n{"chain_stage":"DECISION","case_key":"闭环演示案-终","round":1,"status":"CONSENSUS_REACHED","decision_summary":"本案收敛完成","selected_direction":"按当前草案定稿","required_revisions":[],"next_round":null}';

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: closingDecision,
      metadata: {
        senderId: "1482262068760416317",
        channelId: "1482260425616789595",
        messageId: "103",
      },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const closedState = guard.getStateForTest();
  assert.equal(closedState.phase, "closed");
  assert.equal(closedState.halted, false);
  assert.equal(closedState.haltReason, "");
  assert.equal(closedState.lastInbound?.status, "CONSENSUS_REACHED");

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: closingDecision,
      metadata: {
        senderId: "1482262068760416317",
        channelId: "1482260425616789595",
        messageId: "104",
      },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const afterLateInbound = guard.getStateForTest();
  assert.equal(afterLateInbound.phase, "closed");
  assert.equal(afterLateInbound.halted, false);
  assert.equal(afterLateInbound.haltReason, "");
  assert.equal(afterLateInbound.lastInbound?.status, "CONSENSUS_REACHED");
});

test("duplicate assistant transcript is blocked before inbound progression", () => {
  const tempDir = makeTempDir();
  const controlFile = path.join(tempDir, "control.json");
  const stateFile = path.join(tempDir, "state.json");
  writeJson(controlFile, { globalMute: false, lastAction: "unfreeze", accountSnapshot: {} });

  const guard = createDatangChaotangGuard({
    controlFile,
    stateFile,
    maxDiscussionRounds: 3,
    maxDiscussionTurns: 9,
  });

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-辛】用户发起：请三省在有限轮次内讨论最优方案。",
        JSON.stringify({ case_key: "闭环演示案-辛", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content:
        '【闭环演示案-辛】中书省第1轮提案。\n{"chain_stage":"DRAFT","case_key":"闭环演示案-辛","round":1,"objective":"验证同轮同角色只写一次","candidate_plan":"先写一条正式 REVIEW，再看是否会重复","key_assumptions":[],"tradeoffs":[],"handoff":{"next_agent":"neige","required_action":"review"}}',
      metadata: { senderId: "1482003317327659049", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const firstReview = guard.handleBeforeMessageWrite(
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: [
              "门下省第1轮审议。",
              JSON.stringify({
                chain_stage: "REVIEW",
                case_key: "闭环演示案-辛",
                round: 1,
                verdict: "REVISE",
                major_objections: ["先确认不会重复写第二条"],
                required_changes: ["等待尚书省裁决前不要再次发言"],
              }),
            ].join("\n"),
          },
        ],
      },
    },
    {
      agentId: "neige",
      channelId: "discord",
      sessionKey: "agent:neige:discord:channel:1482260425616789595",
    },
    {},
  );

  assert.ok(firstReview?.message);

  const promptAfterFirstReview = guard.handleBeforePromptBuild(
    { prompt: "宣政殿消息", messages: [] },
    {
      agentId: "neige",
      channelId: "discord",
      sessionKey: "agent:neige:discord:channel:1482260425616789595",
    },
    {},
  );
  assert.match(promptAfterFirstReview.appendSystemContext, /你本轮的正式回文已写出/);
  assert.match(promptAfterFirstReview.appendSystemContext, /只输出：NO_REPLY/);

  const duplicateReview = guard.handleBeforeMessageWrite(
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: [
              "门下省重复审议，不应再写入。",
              JSON.stringify({
                chain_stage: "REVIEW",
                case_key: "闭环演示案-辛",
                round: 1,
                verdict: "APPROVED",
                major_objections: [],
                required_changes: [],
              }),
            ].join("\n"),
          },
        ],
      },
    },
    {
      agentId: "neige",
      channelId: "discord",
      sessionKey: "agent:neige:discord:channel:1482260425616789595",
    },
    {},
  );

  assert.deepEqual(duplicateReview, { block: true });
});

test("core three-province sessions block tool calls during active xuanzhengdian discussion", () => {
  const tempDir = makeTempDir();
  const controlFile = path.join(tempDir, "control.json");
  writeJson(controlFile, { globalMute: false, lastAction: "unfreeze", accountSnapshot: {} });

  const guard = createDatangChaotangGuard({ controlFile });
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-己】用户发起：请三省在宣政殿内讨论，不许调工具。",
        JSON.stringify({ case_key: "闭环演示案-己", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const blockedBySession = guard.handleBeforeToolCall(
    {
      toolName: "write",
      params: { file: "memory/2026-03-21.md" },
    },
    {
      agentId: "shangshu",
      channelId: "discord",
      sessionKey: "agent:shangshu:discord:channel:1482260425616789595",
      toolName: "write",
    },
    {},
  );
  assert.deepEqual(blockedBySession, {
    block: true,
    blockReason: "宣政殿三省讨论禁止工具调用: write",
  });

  const blockedByActiveCase = guard.handleBeforeToolCall(
    {
      toolName: "memory_search",
      params: { query: "闭环演示案-己" },
    },
    {
      agentId: "neige",
      channelId: "discord",
      sessionKey: "opaque-session-key",
      toolName: "memory_search",
    },
    {},
  );
  assert.deepEqual(blockedByActiveCase, {
    block: true,
    blockReason: "宣政殿三省讨论禁止工具调用: memory_search",
  });

  assert.equal(
    guard.handleBeforeToolCall(
      {
        toolName: "write",
        params: { file: "memory/2026-03-21.md" },
      },
      {
        agentId: "gongbu",
        channelId: "discord",
        sessionKey: "agent:gongbu:discord:channel:1482260425616789595",
        toolName: "write",
      },
      {},
    ),
    undefined,
  );
});

test("missing next-hand-off mention produces a herald relay directive", () => {
  const tempDir = makeTempDir();
  const controlFile = path.join(tempDir, "control.json");
  const stateFile = path.join(tempDir, "state.json");
  writeJson(controlFile, { globalMute: false, lastAction: "unfreeze", accountSnapshot: {} });

  const guard = createDatangChaotangGuard({
    controlFile,
    stateFile,
    maxDiscussionRounds: 3,
    maxDiscussionTurns: 9,
  });

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-辛】用户发起：请中书省先给出首轮方案。",
        JSON.stringify({ case_key: "闭环演示案-辛", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const result = guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "中书省提交首轮提案，但漏掉对门下省的 mention。",
        JSON.stringify({
          chain_stage: "DRAFT",
          case_key: "闭环演示案-辛",
          round: 1,
          objective: "验证 relay 补位",
          candidate_plan: "若正式回文缺少下一手 mention，则由殿中监补发守卫转递。",
        }),
      ].join("\n"),
      metadata: {
        senderId: "1482003317327659049",
        channelId: "1482260425616789595",
        messageId: "relay-missing-mention-1",
      },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  assert.equal(result?.relay?.accountId, "dianzhongsheng");
  assert.equal(result?.relay?.nextAccountId, "neige");
  assert.match(result?.relay?.content ?? "", /守卫转递：请门下省审议第1轮方案。/);
  assert.match(result?.relay?.content ?? "", /<@1482007277140709508>/);
  assert.match(result?.relay?.content ?? "", /<@&1482262714431836183>/);
});

test("assistant transcript is canonicalized before discord delivery", () => {
  const guard = createDatangChaotangGuard({});
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-戊】用户发起：请中书省先给出候选方案。",
        JSON.stringify({ case_key: "闭环演示案-戊", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const result = guard.handleBeforeMessageWrite(
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: [
              "[[reply_to_current]] 中书省起草首轮候选方案，请门下省审议。",
              "",
              "```json",
              JSON.stringify({
                chain_stage: "DRAFT",
                case_key: "闭环演示案-戊",
                round: 1,
                objective: "验证写入前正规化",
                candidate_plan:
                  "这是一个故意很长的候选方案描述，用来确认守卫会在真正写入和发往 Discord 之前把它压缩成短摘要加小 JSON，而不是让 Discord 自己把长文本切成多条消息。",
                key_assumptions: ["只允许三省发言", "最多三轮"],
                tradeoffs: ["压缩表达换稳定交付"],
              }),
              "```",
            ].join("\n"),
          },
          {
            type: "toolCall",
            id: "call_1",
            name: "write",
            arguments: { note: "should be dropped from transcript" },
          },
        ],
      },
    },
    {
      agentId: "silijian",
      sessionKey: "agent:silijian:discord:channel:1482260425616789595",
      channelId: "discord",
    },
    {},
  );

  assert.ok(result?.message);
  assert.ok(Array.isArray(result.message.content));
  assert.equal(result.message.content.length, 1);
  assert.equal(result.message.content[0].type, "text");
  assert.equal(typeof result.message.content[0].text, "string");
  assert.doesNotMatch(result.message.content[0].text, /```|\[\[reply_to_current\]\]|write/);
  assert.match(result.message.content[0].text, /【闭环演示案-戊】中书省第1轮提案。/);
  assert.match(result.message.content[0].text, /<@1482007277140709508> <@&1482262714431836183>/);
  assert.match(result.message.content[0].text, /"chain_stage":"DRAFT"/);
  assert.ok(result.message.content[0].text.length < 500);
});

test("stale backlog messages from before the current case start are ignored", () => {
  const tempDir = makeTempDir();
  const controlFile = path.join(tempDir, "control.json");
  const stateFile = path.join(tempDir, "state.json");
  writeJson(controlFile, { globalMute: false, lastAction: "unfreeze", accountSnapshot: {} });

  const guard = createDatangChaotangGuard({
    controlFile,
    stateFile,
    maxDiscussionRounds: 3,
    maxDiscussionTurns: 9,
  });

  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-壬】用户发起：请中书省起草。",
        JSON.stringify({ case_key: "闭环演示案-壬", max_rounds: 3 }),
      ].join("\n"),
      metadata: {
        senderId: "1476931252576850095",
        channelId: "1482260425616789595",
        messageId: "200",
      },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const baseline = guard.getStateForTest();
  assert.equal(baseline.caseKey, "闭环演示案-壬");
  assert.equal(baseline.caseStartMessageId, "200");
  assert.deepEqual(baseline.expectedAccounts, ["silijian"]);

  const staleResult = guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "旧案回放：门下省审议旧消息，不应污染当前案件。",
        JSON.stringify({
          chain_stage: "REVIEW",
          case_key: "旧案",
          round: 1,
          verdict: "REVISE",
        }),
      ].join("\n"),
      metadata: {
        senderId: "1482007277140709508",
        channelId: "1482260425616789595",
        messageId: "150",
      },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  assert.equal(staleResult, undefined);
  const afterStale = guard.getStateForTest();
  assert.equal(afterStale.caseKey, "闭环演示案-壬");
  assert.equal(afterStale.caseStartMessageId, "200");
  assert.deepEqual(afterStale.expectedAccounts, ["silijian"]);
  assert.deepEqual(afterStale.speakerCounts, {});
});

test("internal assistant error transcript is blocked before delivery", () => {
  const guard = createDatangChaotangGuard({});
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-庚】用户发起：请中书省起草。",
        JSON.stringify({ case_key: "闭环演示案-庚", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const result = guard.handleBeforeMessageWrite(
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "assistantMsg.content.flatMap is not a function" }],
      },
    },
    {
      agentId: "silijian",
      sessionKey: "agent:silijian:discord:channel:1482260425616789595",
      channelId: "discord",
    },
    {},
  );

  assert.deepEqual(result, { block: true });
});

test("out-of-turn assistant transcript is blocked before delivery", () => {
  const guard = createDatangChaotangGuard({});
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-己】用户发起：先由中书省起草。",
        JSON.stringify({ case_key: "闭环演示案-己", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const result = guard.handleBeforeMessageWrite(
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: [
              "尚书省抢答。",
              JSON.stringify({
                chain_stage: "DECISION",
                case_key: "闭环演示案-己",
                round: 1,
                status: "CONSENSUS_REACHED",
              }),
            ].join("\n"),
          },
        ],
      },
    },
    {
      agentId: "shangshu",
      sessionKey: "agent:shangshu:discord:channel:1482260425616789595",
      channelId: "discord",
    },
    {},
  );

  assert.deepEqual(result, { block: true });
});

test("explicit wrong-stage assistant transcript is blocked instead of canonicalized", () => {
  const guard = createDatangChaotangGuard({});
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-辛】用户发起：先由中书省起草。",
        JSON.stringify({ case_key: "闭环演示案-辛", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const result = guard.handleBeforeMessageWrite(
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: [
              "中书省误写成裁决。",
              JSON.stringify({
                chain_stage: "DECISION",
                case_key: "闭环演示案-辛",
                round: 1,
                status: "REVISE_NEXT_ROUND",
              }),
            ].join("\n"),
          },
        ],
      },
    },
    {
      agentId: "silijian",
      sessionKey: "agent:silijian:discord:channel:1482260425616789595",
      channelId: "discord",
    },
    {},
  );

  assert.deepEqual(result, { block: true });
});

test("provider-prefixed discord channel ids still enforce guarded outbound validation", () => {
  const guard = createDatangChaotangGuard({});
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-壬】用户发起：请中书省先提第 1 轮方案。",
        JSON.stringify({ case_key: "闭环演示案-壬", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const result = guard.handleMessageSending(
    {
      to: "guild/1482260425616789595",
      content: [
        "中书省正式提案。",
        JSON.stringify({
          chain_stage: "DRAFT",
          case_key: "闭环演示案-壬",
          round: 1,
          objective: "验证 provider-prefixed channelId 仍会进入守卫",
          candidate_plan: "维持三省顺序并在终局后静默",
        }),
      ].join("\n"),
    },
    { channelId: "discord:default", accountId: "silijian" },
    {},
  );

  assert.equal(typeof result?.content, "string");
  assert.match(result.content, /"chain_stage":"DRAFT"/);
  assert.match(result.content, /闭环演示案-壬/);
});

test("provider-prefixed discord channel ids do not leak explicit wrong-stage outbound", () => {
  const guard = createDatangChaotangGuard({});
  guard.handleMessageReceived(
    {
      from: "1482260425616789595",
      content: [
        "【闭环演示案-癸】用户发起：先由中书省起草。",
        JSON.stringify({ case_key: "闭环演示案-癸", max_rounds: 3 }),
      ].join("\n"),
      metadata: { senderId: "1476931252576850095", channelId: "1482260425616789595" },
    },
    { channelId: "discord", conversationId: "1482260425616789595" },
    {},
  );

  const result = guard.handleMessageSending(
    {
      to: "guild/1482260425616789595",
      content: [
        "中书省误发裁决。",
        JSON.stringify({
          chain_stage: "DECISION",
          case_key: "闭环演示案-癸",
          round: 1,
          status: "REVISE_NEXT_ROUND",
        }),
      ].join("\n"),
    },
    { channelId: "discord:default", accountId: "silijian" },
    {},
  );

  assert.deepEqual(result, { cancel: true });
});

test("freeze and unfreeze toggle protected account enablement without restarting in tests", () => {
  const tempDir = makeTempDir();
  const configPath = path.join(tempDir, "openclaw.json");
  const controlFile = path.join(tempDir, "control.json");

  writeJson(configPath, {
    channels: {
      discord: {
        accounts: {
          silijian: { enabled: true },
          neige: { enabled: true },
          shangshu: { enabled: false },
        },
      },
    },
    plugins: {
      entries: {
        "datang-chaotang-guard": {
          config: {
            controlFile,
            protectedAccounts: ["silijian", "neige", "shangshu"],
          },
        },
      },
    },
  });

  const frozen = runAction({
    action: "freeze",
    configPath,
    controlFile,
    restart: false,
  });
  assert.equal(frozen.globalMute, true);

  const frozenConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(frozenConfig.channels.discord.accounts.silijian.enabled, false);
  assert.equal(frozenConfig.channels.discord.accounts.neige.enabled, false);
  assert.equal(frozenConfig.channels.discord.accounts.shangshu.enabled, false);

  const unfrozen = runAction({
    action: "unfreeze",
    configPath,
    controlFile,
    restart: false,
  });
  assert.equal(unfrozen.globalMute, false);

  const unfrozenConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(unfrozenConfig.channels.discord.accounts.silijian.enabled, true);
  assert.equal(unfrozenConfig.channels.discord.accounts.neige.enabled, true);
  assert.equal(unfrozenConfig.channels.discord.accounts.shangshu.enabled, false);
});
