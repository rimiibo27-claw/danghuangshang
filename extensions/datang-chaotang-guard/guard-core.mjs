import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildAutoCaseKey,
  DEFAULT_ROLLCALL_ARCHIVES_ROOT,
  DEFAULT_ROLLCALL_WORKSPACE_ROOT,
  PLUGIN_ID,
  extractCaseKey,
  extractCaseSummary,
  extractFormalEnvelope,
  extractConversationTarget,
  extractSenderId,
  isTargetConversation,
  readControlState,
  readJsonFile,
  resolvePluginConfig,
  stripReactionNoise,
  writeJsonFile,
} from "./shared.mjs";

const CORE_THREE_PROVINCES = new Set(["silijian", "neige", "shangshu"]);
const AUDIT_ACCOUNT_ID = "duchayuan";
const HANYUANDIAN_CHANNEL_ID = "1482260119457632359";
const HANYUANDIAN_ALLOWED_ACCOUNTS = new Set(["dianzhongsheng"]);
const HANYUANDIAN_REPORT_ACCOUNTS = new Set(["silijian", "neige", "shangshu"]);
const HANYUANDIAN_REPORT_ORDER = ["silijian", "neige", "shangshu"];
const HANYUANDIAN_SUMMARY_ACCOUNTS = [
  "dianzhongsheng",
  "silijian",
  "neige",
  "shangshu",
  "duchayuan",
];
let activeRollcallArchivesRoot = DEFAULT_ROLLCALL_ARCHIVES_ROOT;
let activeRollcallWorkspaceRoot = DEFAULT_ROLLCALL_WORKSPACE_ROOT;
const ROLLCALL_ACCOUNT_LABELS = {
  dianzhongsheng: "殿中省·高力士",
  silijian: "中书省·苏绰",
  neige: "门下省·魏徵",
  shangshu: "尚书省·裴耀卿",
  duchayuan: "御史台·海瑞",
};
const HANYUANDIAN_TRIGGER_REGEX = /上朝|早朝|点卯|點卯|朝会|朝會|含元殿上朝|开始点卯|開始點卯/u;
const DECISION_STATUSES = new Set([
  "REVISE_NEXT_ROUND",
  "CONSENSUS_REACHED",
  "ESCALATE_TO_HUMAN",
]);
const AUDIT_VERDICTS = new Set(["PASS", "FAIL"]);
const MAX_RECENT_INBOUND_SIGNATURES = 24;
const ASSISTANT_TURN_RESERVATION_TTL_MS = 90_000;

function createChannelState(caseKey = "宣政殿待办", maxRoundsOverride = null) {
  return {
    caseKey,
    caseStartMessageId: "",
    round: 1,
    autoTurns: 0,
    halted: false,
    escalationSent: false,
    speakerCounts: {},
    roundSpeakerCounts: {},
    expectedAccounts: ["silijian"],
    phase: "await_draft",
    lastInbound: null,
    recentInboundSignatures: [],
    pendingTurnReservations: {},
    haltReason: "",
    maxRoundsOverride,
  };
}

function createHanyuandianState() {
  return {
    mode: "hanyuandian_rollcall",
    phase: "idle",
    caseStartMessageId: "",
    expectedAccounts: [],
    speakerCounts: {},
    pendingSpeakerReservations: {},
    lastInbound: null,
    recentInboundSignatures: [],
    haltReason: "",
  };
}

function cloneStateForTest(state) {
  return JSON.parse(JSON.stringify(state));
}

function normalizeStoredCounterMap(value) {
  if (!value || typeof value !== "object") return {};
  const next = {};
  for (const [key, count] of Object.entries(value)) {
    if (Number.isInteger(count) && count >= 0) {
      next[key] = count;
    }
  }
  return next;
}

function normalizeStoredInbound(value) {
  if (!value || typeof value !== "object") return null;
  return {
    senderId: typeof value.senderId === "string" ? value.senderId : "",
    senderAccountId: typeof value.senderAccountId === "string" ? value.senderAccountId : "",
    isHuman: value.isHuman === true,
    isResetSender: value.isResetSender === true,
    senderIsProtected: value.senderIsProtected === true,
    cleanedContent: typeof value.cleanedContent === "string" ? value.cleanedContent : "",
    caseKey: typeof value.caseKey === "string" ? value.caseKey : "",
    chainStage: typeof value.chainStage === "string" ? value.chainStage : "",
    verdict: typeof value.verdict === "string" ? value.verdict : "",
    status: typeof value.status === "string" ? value.status : "",
    round: Number.isInteger(value.round) && value.round >= 1 ? value.round : null,
  };
}

function normalizeStoredTurnReservations(value) {
  if (!value || typeof value !== "object") return {};
  const next = {};
  for (const [accountId, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const round = Number.isInteger(entry.round) && entry.round >= 1 ? entry.round : null;
    const chainStage = typeof entry.chainStage === "string" ? entry.chainStage.trim() : "";
    const reservedAtMs =
      Number.isInteger(entry.reservedAtMs) && entry.reservedAtMs > 0 ? entry.reservedAtMs : null;
    if (!round || !chainStage || !reservedAtMs) continue;
    next[accountId] = {
      caseKey: typeof entry.caseKey === "string" ? entry.caseKey : "",
      round,
      chainStage,
      reservedAtMs,
    };
  }
  return next;
}

function normalizeStoredChannelState(value) {
  if (!value || typeof value !== "object") {
    return createChannelState();
  }

  const storedPhase =
    typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : "await_draft";

  const next = createChannelState(
    typeof value.caseKey === "string" && value.caseKey.trim() ? value.caseKey.trim() : "宣政殿待办",
    Number.isInteger(value.maxRoundsOverride) && value.maxRoundsOverride >= 1
      ? value.maxRoundsOverride
      : null,
  );
  next.caseStartMessageId =
    typeof value.caseStartMessageId === "string" && value.caseStartMessageId.trim()
      ? value.caseStartMessageId.trim()
      : "";
  next.round = Number.isInteger(value.round) && value.round >= 1 ? value.round : 1;
  next.autoTurns = Number.isInteger(value.autoTurns) && value.autoTurns >= 0 ? value.autoTurns : 0;
  next.halted = value.halted === true;
  next.escalationSent = value.escalationSent === true;
  next.speakerCounts = normalizeStoredCounterMap(value.speakerCounts);
  next.roundSpeakerCounts = normalizeStoredCounterMap(value.roundSpeakerCounts);
  next.expectedAccounts =
    Array.isArray(value.expectedAccounts)
      ? value.expectedAccounts.filter((entry) => typeof entry === "string" && entry.trim())
      : next.halted || storedPhase === "closed"
        ? []
        : ["silijian"];
  next.phase = storedPhase;
  next.lastInbound = normalizeStoredInbound(value.lastInbound);
  next.recentInboundSignatures = Array.isArray(value.recentInboundSignatures)
    ? value.recentInboundSignatures.filter((entry) => typeof entry === "string" && entry.trim())
        .slice(-MAX_RECENT_INBOUND_SIGNATURES)
    : [];
  next.pendingTurnReservations = normalizeStoredTurnReservations(value.pendingTurnReservations);
  next.haltReason = typeof value.haltReason === "string" ? value.haltReason : "";
  return next;
}

function normalizeStoredHanyuandianState(value) {
  if (!value || typeof value !== "object") {
    return createHanyuandianState();
  }

  const next = createHanyuandianState();
  next.caseStartMessageId =
    typeof value.caseStartMessageId === "string" && value.caseStartMessageId.trim()
      ? value.caseStartMessageId.trim()
      : "";
  next.speakerCounts = normalizeStoredCounterMap(value.speakerCounts);
  next.pendingSpeakerReservations = normalizeStoredCounterMap(value.pendingSpeakerReservations);
  next.lastInbound = normalizeStoredInbound(value.lastInbound);
  next.recentInboundSignatures = Array.isArray(value.recentInboundSignatures)
    ? value.recentInboundSignatures.filter((entry) => typeof entry === "string" && entry.trim())
        .slice(-MAX_RECENT_INBOUND_SIGNATURES)
    : [];
  next.haltReason = typeof value.haltReason === "string" ? value.haltReason : "";

  const storedPhase =
    typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : "idle";
  next.phase = ["idle", "await_rollcall_open", "await_rollcall_reports", "closed"].includes(
    storedPhase,
  )
    ? storedPhase
    : "idle";

  next.expectedAccounts =
    Array.isArray(value.expectedAccounts) && value.expectedAccounts.length > 0
      ? value.expectedAccounts.filter((entry) => typeof entry === "string" && entry.trim())
      : next.phase === "await_rollcall_open"
        ? ["dianzhongsheng"]
        : next.phase === "await_rollcall_reports"
          ? ["silijian", "neige", "shangshu"].filter(
              (accountId) => (next.speakerCounts[accountId] ?? 0) < 1,
            )
          : [];

  return next;
}

function readSharedStateStore(stateFile) {
  const store = readJsonFile(stateFile);
  if (!store || typeof store !== "object") {
    return { channels: {} };
  }
  return {
    channels: store.channels && typeof store.channels === "object" ? store.channels : {},
  };
}

function hasActiveDiscussionState(state) {
  return Boolean(state && state.lastInbound && !state.halted);
}

function hasActiveHanyuandianRollcall(state) {
  return Boolean(
    state &&
      (state.phase === "await_rollcall_open" || state.phase === "await_rollcall_reports"),
  );
}

function shouldGuardHanyuandianSession(state) {
  return Boolean(
    state &&
      (state.phase === "await_rollcall_open" ||
        state.phase === "await_rollcall_reports" ||
        state.phase === "closed"),
  );
}

function pruneExpiredHanyuandianReservations(state, now = Date.now()) {
  const reservations =
    state.pendingSpeakerReservations && typeof state.pendingSpeakerReservations === "object"
      ? state.pendingSpeakerReservations
      : {};
  const next = {};
  for (const [accountId, reservedAtMs] of Object.entries(reservations)) {
    if (!Number.isInteger(reservedAtMs) || reservedAtMs <= 0) continue;
    if (now - reservedAtMs >= ASSISTANT_TURN_RESERVATION_TTL_MS) continue;
    next[accountId] = reservedAtMs;
  }
  state.pendingSpeakerReservations = next;
}

function hasHanyuandianReservation(state, accountId, now = Date.now()) {
  pruneExpiredHanyuandianReservations(state, now);
  return Number.isInteger(state.pendingSpeakerReservations?.[accountId]);
}

function rememberHanyuandianReservation(state, accountId, now = Date.now()) {
  pruneExpiredHanyuandianReservations(state, now);
  state.pendingSpeakerReservations[accountId] = now;
}

function clearHanyuandianReservation(state, accountId) {
  if (!state.pendingSpeakerReservations || typeof state.pendingSpeakerReservations !== "object") {
    state.pendingSpeakerReservations = {};
    return;
  }
  delete state.pendingSpeakerReservations[accountId];
}

function getNextHanyuandianExpectedAccount(state) {
  return (
    HANYUANDIAN_REPORT_ORDER.find((accountId) => (state.speakerCounts[accountId] ?? 0) < 1) || ""
  );
}

function getEffectiveMaxRounds(state, config) {
  return state.maxRoundsOverride ?? config.maxDiscussionRounds;
}

function buildEscalationContent(state, config, reason) {
  return [
    "宣政殿三省讨论已被守卫熔断，现停转待陛下裁断。",
    JSON.stringify({
      verdict: "ESCALATE_TO_HUMAN",
      case_key: state.caseKey,
      reason,
      round: state.round,
      phase: state.phase,
      auto_turns: state.autoTurns,
      speaker_counts: state.speakerCounts,
      expected_accounts: state.expectedAccounts,
      max_rounds: getEffectiveMaxRounds(state, config),
      next_step: "await_imperial_reset",
    }),
  ].join("\n");
}

function isGuardRelayText(text) {
  return /守卫转递：/u.test(String(text ?? ""));
}

function shouldTreatAsResetSignal(senderId, inboundSummary, config) {
  if (!config.resetSenderIds.has(senderId)) return false;
  if (inboundSummary.maxRounds != null) return true;
  return /"request_type"\s*:\s*"THREE_PROVINCE_ROUND_TEST"/u.test(
    inboundSummary.cleanedContent || "",
  );
}

function resolveInboundMessageId(metadata = {}) {
  const directKeys = [
    metadata.messageId,
    metadata.discordMessageId,
    metadata.eventId,
    metadata.id,
    metadata.message?.id,
    metadata.rawEvent?.id,
  ];
  for (const candidate of directKeys) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function compareDiscordMessageIds(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    !/^\d+$/.test(left) ||
    !/^\d+$/.test(right)
  ) {
    return null;
  }
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    if (leftValue === rightValue) return 0;
    return leftValue < rightValue ? -1 : 1;
  } catch {
    return null;
  }
}

function isInboundBeforeCaseStart(state, metadata = {}) {
  const currentMessageId = resolveInboundMessageId(metadata);
  if (!currentMessageId || !state.caseStartMessageId) return false;
  return compareDiscordMessageIds(currentMessageId, state.caseStartMessageId) === -1;
}

function buildInboundSignature(senderAccountId, nextInbound, metadata = {}) {
  const messageId = resolveInboundMessageId(metadata);
  if (messageId) {
    return `msg:${messageId}`;
  }

  const digest = crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        senderId: nextInbound.senderId,
        senderAccountId,
        caseKey: nextInbound.caseKey,
        chainStage: nextInbound.chainStage,
        verdict: nextInbound.verdict,
        status: nextInbound.status,
        round: nextInbound.round,
        cleanedContent: nextInbound.cleanedContent,
      }),
    )
    .digest("hex");
  return `sig:${digest}`;
}

function hasSeenInboundSignature(state, signature) {
  return Boolean(signature) && state.recentInboundSignatures.includes(signature);
}

function rememberInboundSignature(state, signature) {
  if (!signature) return;
  const next = state.recentInboundSignatures.filter((entry) => entry !== signature);
  next.push(signature);
  state.recentInboundSignatures = next.slice(-MAX_RECENT_INBOUND_SIGNATURES);
}

function pruneExpiredTurnReservations(state, now = Date.now()) {
  const reservations =
    state.pendingTurnReservations && typeof state.pendingTurnReservations === "object"
      ? state.pendingTurnReservations
      : {};
  const next = {};

  for (const [accountId, reservation] of Object.entries(reservations)) {
    if (!reservation || typeof reservation !== "object") continue;
    if (!Number.isInteger(reservation.reservedAtMs) || reservation.reservedAtMs <= 0) continue;
    if (now - reservation.reservedAtMs >= ASSISTANT_TURN_RESERVATION_TTL_MS) continue;
    next[accountId] = reservation;
  }

  state.pendingTurnReservations = next;
}

function getActiveTurnReservation(state, accountId, now = Date.now()) {
  pruneExpiredTurnReservations(state, now);
  const reservation = state.pendingTurnReservations?.[accountId];
  if (!reservation) return null;

  const expectedStage = getExpectedFormalStage(accountId);
  if (reservation.round !== state.round) return null;
  if (!expectedStage || reservation.chainStage !== expectedStage) return null;
  if (reservation.caseKey && state.caseKey && reservation.caseKey !== state.caseKey) return null;
  return reservation;
}

function reservationMatchesSummary(state, reservation, summary) {
  if (!reservation) return false;
  const summaryRound = summary.round ?? state.round;
  const summaryCaseKey = summary.caseKey || state.caseKey || "";
  return (
    reservation.round === summaryRound &&
    reservation.chainStage === summary.chainStage &&
    (!summaryCaseKey || !reservation.caseKey || reservation.caseKey === summaryCaseKey)
  );
}

function rememberTurnReservation(state, accountId, summary, now = Date.now()) {
  pruneExpiredTurnReservations(state, now);
  state.pendingTurnReservations[accountId] = {
    caseKey: summary.caseKey || state.caseKey || "宣政殿待办",
    round: summary.round ?? state.round,
    chainStage: summary.chainStage,
    reservedAtMs: now,
  };
}

function isCoreThreeProvinceAccount(accountId) {
  return CORE_THREE_PROVINCES.has(accountId);
}

function isAuditAccount(accountId) {
  return accountId === AUDIT_ACCOUNT_ID;
}

function isGuardedFormalAccount(accountId) {
  return isCoreThreeProvinceAccount(accountId) || isAuditAccount(accountId);
}

function resolveSenderAccountId(senderId, config) {
  if (typeof senderId !== "string" || !senderId) return "";
  for (const [accountId, userId] of Object.entries(config.accountUserIds)) {
    if (userId === senderId) return accountId;
  }
  return "";
}

function matchesProviderChannel(channelId, providerId) {
  if (typeof channelId !== "string" || !channelId.trim()) return false;
  if (typeof providerId !== "string" || !providerId.trim()) return false;

  const normalizedChannelId = channelId.trim();
  const normalizedProviderId = providerId.trim();
  return (
    normalizedChannelId === normalizedProviderId ||
    normalizedChannelId.startsWith(`${normalizedProviderId}:`) ||
    normalizedChannelId.startsWith(`${normalizedProviderId}/`) ||
    normalizedChannelId.startsWith(`${normalizedProviderId}-`)
  );
}

function isTargetSession(ctx, config) {
  const hasTargetSessionKey =
    typeof ctx.sessionKey === "string" &&
    ctx.sessionKey.includes(config.xuanzhengdianChannelId);
  if (!hasTargetSessionKey) return false;
  if (typeof ctx.channelId !== "string" || !ctx.channelId.trim()) return true;
  return matchesProviderChannel(ctx.channelId, config.providerId);
}

function getExpectedFormalStage(accountId) {
  if (accountId === "silijian") return "DRAFT";
  if (accountId === "neige") return "REVIEW";
  if (accountId === "shangshu") return "DECISION";
  if (accountId === AUDIT_ACCOUNT_ID) return "AUDIT";
  return "";
}

function isValidUpstreamFor(accountId, state) {
  const inbound = state.lastInbound;
  if (accountId === "silijian") {
    return Boolean(
      inbound &&
        (inbound.isHuman ||
          inbound.isResetSender ||
          (inbound.senderAccountId === AUDIT_ACCOUNT_ID &&
            inbound.chainStage === "AUDIT" &&
            inbound.status === "FAIL") ||
          (inbound.senderAccountId === "shangshu" &&
            inbound.chainStage === "DECISION" &&
            inbound.status === "REVISE_NEXT_ROUND")),
    );
  }

  if (accountId === "neige") {
    return Boolean(
      inbound &&
        inbound.senderAccountId === "silijian" &&
        inbound.chainStage === "DRAFT",
    );
  }

  if (accountId === "shangshu") {
    return Boolean(
      inbound &&
        inbound.senderAccountId === "neige" &&
        inbound.chainStage === "REVIEW" &&
        Boolean(inbound.verdict),
    );
  }

  if (accountId === AUDIT_ACCOUNT_ID) {
    return Boolean(
      inbound &&
        inbound.senderAccountId === "shangshu" &&
        inbound.chainStage === "DECISION" &&
        inbound.status === "CONSENSUS_REACHED",
    );
  }

  return true;
}

function hasCaseKeyMismatch(state, summary) {
  return Boolean(summary.caseKey && state.caseKey && summary.caseKey !== state.caseKey);
}

function matchesExpectedState(state, phase, round, expectedAccounts, halted = false) {
  if (state.phase !== phase) return false;
  if (state.round !== round) return false;
  if (state.halted !== halted) return false;
  if (state.expectedAccounts.length !== expectedAccounts.length) return false;
  return expectedAccounts.every((accountId, index) => state.expectedAccounts[index] === accountId);
}

function isInboundProgressAlreadyApplied(accountId, state, summary) {
  if (accountId === "silijian" && summary.chainStage === "DRAFT") {
    return matchesExpectedState(state, "await_review", summary.round ?? state.round, ["neige"]);
  }

  if (accountId === "neige" && summary.chainStage === "REVIEW") {
    return matchesExpectedState(state, "await_decision", summary.round ?? state.round, ["shangshu"]);
  }

  if (accountId !== "shangshu" || summary.chainStage !== "DECISION") {
    if (accountId !== AUDIT_ACCOUNT_ID || summary.chainStage !== "AUDIT") {
      return false;
    }

    const verdict = normalizeAuditVerdict(summary);
    if (verdict === "FAIL") {
      return matchesExpectedState(
        state,
        "await_draft",
        (summary.round ?? state.round) + 1,
        ["silijian"],
      );
    }

    return matchesExpectedState(state, "closed", summary.round ?? state.round, [], false);
  }

  if (normalizeDecisionStatus(summary) === "REVISE_NEXT_ROUND") {
    return matchesExpectedState(
      state,
      "await_draft",
      (summary.round ?? state.round) + 1,
      ["silijian"],
    );
  }

  if (normalizeDecisionStatus(summary) === "CONSENSUS_REACHED") {
    return matchesExpectedState(state, "await_audit", summary.round ?? state.round, [AUDIT_ACCOUNT_ID]);
  }

  return matchesExpectedState(state, "closed", summary.round ?? state.round, [], false);
}

function getCoreSendViolation(accountId, state, summary) {
  if (!state.expectedAccounts.includes(accountId)) {
    return `out_of_turn:${accountId}`;
  }
  if (!summary.chainStage) {
    return `missing_formal_json:${accountId}`;
  }
  if (summary.chainStage !== getExpectedFormalStage(accountId)) {
    return `wrong_stage:${accountId}:${summary.chainStage}`;
  }
  if (summary.round != null && summary.round !== state.round) {
    return `round_mismatch:${accountId}:${summary.round}`;
  }
  if (!isValidUpstreamFor(accountId, state)) {
    return `invalid_upstream:${accountId}`;
  }
  if (hasCaseKeyMismatch(state, summary)) {
    return `case_key_mismatch:${accountId}`;
  }
  if (!summary.caseKey && !state.caseKey) {
    return `missing_case_key:${accountId}`;
  }
  if (accountId === "neige" && !summary.verdict) {
    return "missing_review_verdict";
  }
  if (accountId === "shangshu") {
    const decisionStatus = normalizeDecisionStatus(summary);
    if (!decisionStatus) return "missing_decision_status";
    if (!DECISION_STATUSES.has(decisionStatus)) {
      return `invalid_decision_status:${decisionStatus}`;
    }
  }
  if (accountId === AUDIT_ACCOUNT_ID) {
    const auditVerdict = normalizeAuditVerdict(summary);
    if (!auditVerdict) return "missing_audit_verdict";
    if (!AUDIT_VERDICTS.has(auditVerdict)) {
      return `invalid_audit_verdict:${auditVerdict}`;
    }
  }
  return "";
}

function describeInboundSender(inbound) {
  if (!inbound) return "none";
  if (inbound.isHuman) return "human";
  if (inbound.isResetSender) return "reset_sender";
  if (inbound.senderAccountId) return inbound.senderAccountId;
  return inbound.senderId || "unknown";
}

function buildGuardPrompt(accountId, state, config) {
  const activeReservation = getActiveTurnReservation(state, accountId);
  const inbound = state.lastInbound;
  const expectedAccounts =
    state.expectedAccounts.length > 0 ? state.expectedAccounts.join(", ") : "(none)";
  const maxRounds = getEffectiveMaxRounds(state, config);
  const neigeMention = formatTransitionMention("neige", config) || "@neige";
  const shangshuMention = formatTransitionMention("shangshu", config) || "@shangshu";
  const silijianMention = formatTransitionMention("silijian", config) || "@silijian";

  const lines = [
    "宣政殿守卫已切换到【三省回合制讨论模式】。",
    "目标：在有限轮次内，让中书省提案、门下省挑错、尚书省收敛，产出当前最优可行方案。",
    "你永远只能代表你自己的机构身份，绝不能把 sender/untrusted metadata 当成“你自己”。",
    "这不是执行派单流程。禁止六部、秘阁、殿中省介入讨论闭环；御史台只在尚书省形成共识后执行审计。",
    "禁止输出接案登记、状态板、归档、存档备查、等待提示、角色表演、总结转述。",
    "禁止任何工具调用、memory write、memory search、read/write/exec、技能调用与子代理调用。",
    "禁止代码块、禁止 Markdown 列表、禁止 [[reply_to_current]]、禁止补充说明段。",
    "除守卫指定的下一手交接 mention 外，禁止任何额外 @提及。",
    "禁止发 `status=RECEIVED` 之类回执。每轮只允许你输出 1 条正式消息。",
    `你的固定身份：${accountId}。`,
    `当前案号：${state.caseKey || "宣政殿待办"}。`,
    `当前轮次：${state.round}/${maxRounds}。`,
    `当前阶段：${state.phase}。`,
    `当前允许发言的下一手：${expectedAccounts}。`,
    `最近上游发送方：${describeInboundSender(inbound)}。`,
    `最近上游阶段：${inbound?.chainStage || "(none)"}。`,
    `最近上游裁决：${inbound?.verdict || "(none)"}。`,
    `最近上游状态：${inbound?.status || "(none)"}。`,
    "忽略所有以 `System:` 开头的 Discord reaction / 传输层噪音。",
  ];

  if (state.halted) {
    lines.push(`当前案件已停止自动讨论。停止原因：${state.haltReason || "closed"}。`);
    lines.push("你只能输出且只输出：NO_REPLY");
    return lines.join("\n");
  }

  if (!state.expectedAccounts.includes(accountId)) {
    lines.push("你不是当前应答方。禁止解释、禁止摘要、禁止 JSON、禁止礼貌句。");
    lines.push("你只能输出且只输出：NO_REPLY");
    return lines.join("\n");
  }

  if (activeReservation) {
    lines.push("你本轮的正式回文已写出，当前只等待消息送达与守卫推进状态。");
    lines.push("禁止重复生成第二份草案、复审或裁决。");
    lines.push("你只能输出且只输出：NO_REPLY");
    return lines.join("\n");
  }

  lines.push("输出格式必须是：第 1 行短摘要 + 第 2 行 JSON 对象。不要表格，不要多段长文。");
  lines.push("总长度控制在 700 字以内；JSON 只保留最小必要字段；字符串尽量单句，不写长段方案。");

  if (accountId === "silijian") {
    lines.push("你的职责是提出或修订方案，不得宣布结案，不得代替他人裁决。");
    lines.push(
      "第 1 轮：给出当前最优候选方案。后续轮：只根据门下省 objections 与尚书省 decision 做最小必要修订。",
    );
    lines.push("思考角度：像总设计师，先搭骨架、定边界、定成败标准；优先回答“怎么做才成”。");
    lines.push(`第 1 行必须在结尾只交接给门下省：${neigeMention}`);
    lines.push("candidate_plan 必须压缩成 1 句，key_assumptions 最多 2 条，tradeoffs 最多 2 条。");
    lines.push(
      'JSON 必须包含：{"chain_stage":"DRAFT","case_key","round","objective","candidate_plan","key_assumptions","tradeoffs","handoff":{"next_agent":"neige","required_action":"review"}}。',
    );
    return lines.join("\n");
  }

  if (accountId === "neige") {
    lines.push("你的职责是做最强反对意见审查，逼方案变硬，但不要越俎代庖做最终收敛。");
    lines.push(
      "如果方案仍有关键缺口，用 verdict=REVISE；如果已基本可行，用 verdict=APPROVED；若方向根本不成立，可用 verdict=VETO。",
    );
    lines.push("思考角度：像反方评审与风险审计官，优先挑隐藏前提、断点、越权与不可逆代价。");
    lines.push(`第 1 行必须在结尾只交接给尚书省：${shangshuMention}`);
    lines.push("major_objections 最多 3 条，required_changes 最多 3 条，preserved_strengths 最多 2 条。");
    lines.push(
      'JSON 必须包含：{"chain_stage":"REVIEW","case_key","round","verdict","major_objections","required_changes","preserved_strengths","handoff":{"next_agent":"shangshu","required_action":"decide"}}。',
    );
    return lines.join("\n");
  }

  if (accountId === "shangshu") {
    lines.push("你的职责是收敛争论，选出当轮最优方案或决定继续讨论，不得派单执行。");
    lines.push(
      "你只能输出三种终局之一：REVISE_NEXT_ROUND、CONSENSUS_REACHED、ESCALATE_TO_HUMAN。",
    );
    lines.push(
      "若继续下一轮，只能指出最小修订集；若达成共识，必须明确当前最优方案为何优于其他选项；若已无新增信息，请陛下裁断。",
    );
    lines.push("思考角度：像总裁决者，比较“继续讨论的增益”与“立即定案的成本节省”，偏爱当前最优可行解。");
    lines.push(`若 status=REVISE_NEXT_ROUND，第 1 行必须在结尾只交接给中书省：${silijianMention}`);
    lines.push("若 status 是终局态，禁止任何 mention。");
    lines.push("decision_summary 与 selected_direction 都必须各压缩成 1 句，required_revisions 最多 3 条。");
    lines.push("next_round 必须是数字轮次；若继续下一轮，必须填写当前 round + 1；禁止写 agent 名。");
    lines.push(
      'JSON 必须包含：{"chain_stage":"DECISION","case_key","round","status","decision_summary","selected_direction","required_revisions","next_round"}。',
    );
    return lines.join("\n");
  }

  if (accountId === AUDIT_ACCOUNT_ID) {
    lines.push("你的职责是做收敛后的真实性审计，不参与起草、挑错或裁决。");
    lines.push("只有在尚书省已给出 CONSENSUS_REACHED 后，你才可审计并给出 PASS/FAIL。");
    lines.push("若 verdict=PASS，表示当前方案边界清楚、证据足够、没有明显越权或伪完成。");
    lines.push("若 verdict=FAIL，必须只指出最关键的证据缺口或越权点，并把案件退回中书省继续修订。");
    lines.push(`若 verdict=FAIL，第 1 行必须在结尾只交接给中书省：${silijianMention}`);
    lines.push("若 verdict=PASS，禁止任何 mention。");
    lines.push("audit_summary 必须压缩成 1 句，evidence_refs 最多 3 条，required_fixes 最多 3 条。");
    lines.push(
      'JSON 必须包含：{"chain_stage":"AUDIT","case_key","round","verdict","audit_summary","evidence_refs","required_fixes","next_step"}。',
    );
    return lines.join("\n");
  }

  return lines.join("\n");
}

function scrubAgentMessageText(text) {
  return stripReactionNoise(text);
}

function normalizeOutgoingAccountLikeId(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const trimmed = value.trim();
  const agentMatch = trimmed.match(/(?:^|:)agent:([^:]+)/u);
  if (agentMatch?.[1]) return agentMatch[1];
  return trimmed;
}

function resolveOutgoingAccountId(ctx, event) {
  if (typeof ctx?.accountId === "string" && ctx.accountId.trim()) {
    return normalizeOutgoingAccountLikeId(ctx.accountId);
  }
  if (typeof ctx?.agentId === "string" && ctx.agentId.trim()) {
    return normalizeOutgoingAccountLikeId(ctx.agentId);
  }
  if (typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim()) {
    return normalizeOutgoingAccountLikeId(ctx.sessionKey);
  }
  const directAccountId = event?.accountId;
  if (typeof directAccountId === "string" && directAccountId.trim()) {
    return normalizeOutgoingAccountLikeId(directAccountId);
  }
  const directSessionKey = event?.sessionKey;
  if (typeof directSessionKey === "string" && directSessionKey.trim()) {
    return normalizeOutgoingAccountLikeId(directSessionKey);
  }
  const metadataAccountId = event?.metadata?.accountId;
  if (typeof metadataAccountId === "string" && metadataAccountId.trim()) {
    return normalizeOutgoingAccountLikeId(metadataAccountId);
  }
  const metadataAgentId = event?.metadata?.agentId;
  if (typeof metadataAgentId === "string" && metadataAgentId.trim()) {
    return normalizeOutgoingAccountLikeId(metadataAgentId);
  }
  const metadataSessionKey = event?.metadata?.sessionKey;
  if (typeof metadataSessionKey === "string" && metadataSessionKey.trim()) {
    return normalizeOutgoingAccountLikeId(metadataSessionKey);
  }
  return "";
}

function resolveOutboundChannelId(ctx, event) {
  if (typeof ctx?.channelId === "string" && ctx.channelId.trim()) {
    return ctx.channelId.trim();
  }
  const metadataChannel = event?.metadata?.channel;
  if (typeof metadataChannel === "string" && metadataChannel.trim()) {
    return metadataChannel.trim();
  }
  return "";
}

function inferHanyuandianOutgoingAccountId(accountId, outboundText, canInferHanyuandian, state) {
  if (accountId) return accountId;
  if (!canInferHanyuandian) return "";
  const text = String(outboundText ?? "");
  if (state.phase === "await_rollcall_open") {
    return "dianzhongsheng";
  }
  if (
    state.phase === "await_rollcall_reports" &&
    Array.isArray(state.expectedAccounts) &&
    state.expectedAccounts.length === 1 &&
    !isGuardRelayText(text) &&
    !looksLikeHanyuandianLeadershipText(text, { accountRoleIds: {}, accountUserIds: {} })
  ) {
    return state.expectedAccounts[0];
  }
  if (
    /^含元殿点卯继续[。！？!\s]*$/u.test(text.split("\n")[0] || "") ||
    /^含元殿点卯已毕/u.test(text)
  ) {
    return "dianzhongsheng";
  }
  return "";
}

function shortenText(value, maxLength = 160) {
  if (value == null) return "";
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const normalized = String(raw).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function shortenList(value, maxItems = 3, maxItemLength = 72) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => shortenText(item, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeDecisionStatus(summary) {
  return summary.status || summary.verdict || "";
}

function normalizeAuditVerdict(summary) {
  const verdict = summary.verdict || summary.status || "";
  if (verdict === "PASS" || verdict === "FAIL") return verdict;
  return "";
}

function buildCanonicalFormalPayload(accountId, summary, state, config) {
  const expectedStage = getExpectedFormalStage(accountId);
  if (expectedStage && summary.chainStage && summary.chainStage !== expectedStage) {
    return null;
  }

  const payload = summary.payload && typeof summary.payload === "object" ? summary.payload : {};
  const caseKey = summary.caseKey || "宣政殿待办";
  const round = summary.round ?? 1;

  if (accountId === "silijian") {
    return {
      chain_stage: "DRAFT",
      case_key: caseKey,
      round,
      objective: shortenText(payload.objective, 96),
      candidate_plan: shortenText(
        payload.candidate_plan ?? payload.plan ?? payload.summary ?? payload.selected_direction,
        160,
      ),
      key_assumptions: shortenList(payload.key_assumptions, 2, 48),
      tradeoffs: shortenList(payload.tradeoffs, 2, 48),
      handoff: {
        next_agent: "neige",
        required_action: "review",
      },
    };
  }

  if (accountId === "neige") {
    return {
      chain_stage: "REVIEW",
      case_key: caseKey,
      round,
      verdict: summary.verdict || "REVISE",
      major_objections: shortenList(
        payload.major_objections ?? payload.objections ?? payload.unresolved_issues,
        3,
        56,
      ),
      required_changes: shortenList(
        payload.required_changes ?? payload.suggestions,
        3,
        56,
      ),
      preserved_strengths: shortenList(
        payload.preserved_strengths ?? payload.strengths ?? payload.advantages,
        2,
        48,
      ),
      handoff: {
        next_agent: "shangshu",
        required_action: "decision",
      },
    };
  }

  if (accountId === "shangshu") {
    const status = normalizeDecisionStatus(summary);
    return {
      chain_stage: "DECISION",
      case_key: caseKey,
      round,
      status,
      decision_summary: shortenText(
        payload.decision_summary ?? payload.selected_direction ?? payload.summary,
        110,
      ),
      selected_direction: shortenText(
        payload.selected_direction ?? payload.candidate_plan ?? payload.decision_summary,
        96,
      ),
      required_revisions: shortenList(
        payload.required_revisions ?? payload.required_changes ?? payload.suggestions,
        3,
        48,
      ),
      next_round:
        status === "REVISE_NEXT_ROUND"
          ? summary.nextRound ?? round + 1
          : undefined,
    };
  }

  if (accountId === AUDIT_ACCOUNT_ID) {
    const verdict = normalizeAuditVerdict(summary);
    const shouldReturnToDraft =
      verdict === "FAIL" && round < getEffectiveMaxRounds(state ?? createChannelState(), config);
    return {
      chain_stage: "AUDIT",
      case_key: caseKey,
      round,
      verdict,
      audit_summary: shortenText(
        payload.audit_summary ?? payload.summary ?? payload.decision_summary,
        110,
      ),
      evidence_refs: shortenList(
        payload.evidence_refs ?? payload.evidence ?? payload.findings,
        3,
        64,
      ),
      required_fixes: shortenList(
        payload.required_fixes ?? payload.required_changes ?? payload.objections,
        3,
        56,
      ),
      next_step:
        verdict === "PASS"
          ? "close_case"
          : shouldReturnToDraft
            ? "return_to_silijian"
            : "await_imperial_review",
    };
  }

  return null;
}

function formatBotMention(accountId, config) {
  const userId = config.accountUserIds[accountId];
  return typeof userId === "string" && userId.trim() ? `<@${userId.trim()}>` : "";
}

function formatBotRoleMention(accountId, config) {
  const roleId = config.accountRoleIds?.[accountId];
  return typeof roleId === "string" && roleId.trim() ? `<@&${roleId.trim()}>` : "";
}

function formatHanyuandianCallMention(accountId, config) {
  return formatBotMention(accountId, config) || formatBotRoleMention(accountId, config);
}

function formatTransitionMention(accountId, config) {
  return [formatBotMention(accountId, config), formatBotRoleMention(accountId, config)]
    .filter(Boolean)
    .join(" ");
}

function isTargetSessionForChannel(ctx, config, channelId) {
  const hasTargetSessionKey =
    typeof ctx.sessionKey === "string" && ctx.sessionKey.includes(channelId);
  if (!hasTargetSessionKey) return false;
  if (typeof ctx.channelId !== "string" || !ctx.channelId.trim()) return true;
  return matchesProviderChannel(ctx.channelId, config.providerId);
}

function getHanyuandianRoleMentions(config) {
  return ["silijian", "neige", "shangshu"]
    .map((accountId) => formatBotRoleMention(accountId, config))
    .filter(Boolean);
}

function containsAllHanyuandianRoleMentions(text, config) {
  const normalized = String(text ?? "");
  const roleMentions = getHanyuandianRoleMentions(config);
  return roleMentions.length === 3 && roleMentions.every((mention) => normalized.includes(mention));
}

function isHanyuandianTriggerText(text) {
  return HANYUANDIAN_TRIGGER_REGEX.test(stripFormattingNoise(text));
}

function looksLikeHanyuandianLeadershipText(text, config) {
  const normalized = stripFormattingNoise(text);
  if (!normalized) return false;
  return (
    isHanyuandianTriggerText(normalized) ||
    containsAllHanyuandianRoleMentions(normalized, config) ||
    /点名|點名|诸位臣工|諸位臣工|早朝开始|早朝點卯|早朝点卯|会签开始|會簽開始|各衙门依次奏事|各衙門依次奏事|主持开局|主持點卯|主持点卯|協同確認點卯開始|协同确认点卯开始/u.test(
      normalized,
    )
  );
}

function containsForbiddenHanyuandianTerms(text) {
  const normalized = stripFormattingNoise(text);
  if (!normalized) return false;
  return /宣案-|宣案|会签|會簽|提案已拟|提案已擬|待门下省审议|待門下省審議|尚书省裁决|尚書省裁決|朕已御殿|朕/u.test(
    normalized,
  );
}

function containsAnyHanyuandianRoleMention(text, config) {
  const normalized = String(text ?? "");
  return getHanyuandianRoleMentions(config).some((mention) => normalized.includes(mention));
}

function containsForbiddenHanyuandianReportTerms(text, config) {
  const normalized = stripFormattingNoise(text);
  if (!normalized) return false;
  return (
    containsAnyHanyuandianRoleMention(normalized, config) ||
    /殿中监|殿中監|高力士|点卯|點卯|点名|點名|在否|待喏|待奏|应喏|應喏|恭候|依次应|依次應|速速应|速速應|晚朝已开|早朝开始|卯时已到|卯時已到|会齐|會齊|奏事呈上/u.test(
      normalized,
    )
  );
}

function containsDisallowedHanyuandianReportContent(text, config) {
  const normalized = stripFormattingNoise(text);
  if (!normalized) return false;
  return (
    containsAnyHanyuandianRoleMention(normalized, config) ||
    /宣案-|宣案|会签|會簽|提案已拟|提案已擬|待门下省审议|待門下省審議|尚书省裁决|尚書省裁決|点卯|點卯|点名|點名|主持开局|主持點卯|主持点卯|高力士|殿中监|殿中監/u.test(
      normalized,
    )
  );
}

function looksLikeHostedHanyuandianDigest(text) {
  const normalized = stripFormattingNoise(text);
  if (!normalized) return false;
  return (
    /今日点卯由殿中省代奏在值官员近况/u.test(normalized) &&
    /【殿中省·高力士】/u.test(normalized) &&
    /最近所办：/u.test(normalized) &&
    /当前异常：/u.test(normalized) &&
    /最可骄之处：/u.test(normalized) &&
    /需协调：/u.test(normalized)
  );
}

function buildHostedHanyuandianFailureContent(reason = "本轮未取得合格的后台采样。") {
  return [
    "含元殿点卯未成。",
    "殿中省未敢代拟诸司近况，以免失实。",
    `缘由：${reason}`,
    "请陛下稍后重开点卯。",
  ].join("\n");
}

function buildCanonicalHanyuandianRollcallContent(config) {
  return buildHostedHanyuandianFailureContent();
}

function buildHanyuandianRelayContent(nextAccountId, config) {
  const mention = formatHanyuandianCallMention(nextAccountId, config);
  if (!mention) return "";
  return [
    "含元殿点卯继续。",
    `${mention} 请报最近所办、当前异常、最可骄之处、是否需协调。`,
  ].join("\n");
}

function parseHanyuandianStructuredReport(text) {
  const normalized = stripFormattingNoise(text)
    .replace(/<final>|<\/final>/giu, "")
    .replace(/\r/g, "")
    .trim();
  if (!normalized) return null;

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const values = {
    recent: "",
    issue: "",
    pride: "",
    coordination: "",
  };

  for (const line of lines) {
    const colonIndex = line.indexOf("：") >= 0 ? line.indexOf("：") : line.indexOf(":");
    if (colonIndex <= 0) continue;
    const label = line.slice(0, colonIndex).replace(/\s+/g, "");
    const value = line.slice(colonIndex + 1).trim();
    if (!value) continue;
    if (label === "最近所办") values.recent = value;
    if (label === "当前异常") values.issue = value;
    if (label === "最可骄之处") values.pride = value;
    if (label === "需协调" || label === "是否需协调") values.coordination = value;
  }

  if (!values.recent || !values.issue || !values.pride || !values.coordination) {
    return null;
  }

  return [
    `最近所办：${values.recent}`,
    `当前异常：${values.issue}`,
    `最可骄之处：${values.pride}`,
    `需协调：${values.coordination}`,
  ].join("\n");
}

function getHanyuandianReportLabel(accountId) {
  if (accountId === "silijian") return "中书省";
  if (accountId === "neige") return "门下省";
  if (accountId === "shangshu") return "尚书省";
  return "有司";
}

function buildHostedHanyuandianReportContent(accountId, reportText, nextAccountId, config) {
  const lines = [`${getHanyuandianReportLabel(accountId)}应卯如下。`, reportText];
  if (nextAccountId) {
    const relay = buildHanyuandianRelayContent(nextAccountId, config);
    if (relay) {
      lines.push("", relay);
    }
  } else {
    lines.push("", buildHanyuandianCloseContent());
  }
  return lines.join("\n");
}

function buildHanyuandianCloseContent() {
  return "含元殿点卯已毕。三省各归本司，有本启奏，无本退朝。";
}

function safeReadTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function listDescendantFiles(rootDir, matcher) {
  const files = [];
  function walk(currentDir) {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (typeof matcher === "function" && !matcher(fullPath)) continue;
      files.push(fullPath);
    }
  }
  walk(rootDir);
  return files.sort((left, right) => {
    try {
      return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
    } catch {
      return right.localeCompare(left);
    }
  });
}

function extractTextFromMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) =>
      item && typeof item === "object" && item.type === "text" && typeof item.text === "string"
        ? item.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function scoreRollcallEvidence(text) {
  const normalized = stripFormattingNoise(text);
  if (!normalized) return -Infinity;
  let score = Math.min(normalized.length, 480);
  if (/最近所办|当前异常|最可骄之处|需协调|是否需协调/u.test(normalized)) score += 300;
  if (/近办|运转无异常|最可称道者|最为可喜者|尚需/u.test(normalized)) score += 180;
  if (/已应卯，诸务如实|已应卯，记录在案|已应卯，诸事明晰/u.test(normalized)) score -= 260;
  if (/NO_REPLY/u.test(normalized)) score -= 500;
  return score;
}

function findBestArchivedAssistantText(accountId) {
  const currentRoot = path.join(activeRollcallWorkspaceRoot, "agents", accountId, "sessions");
  const archiveRoots = [];
  try {
    const dirs = fs.readdirSync(activeRollcallArchivesRoot, { withFileTypes: true });
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      archiveRoots.push(path.join(activeRollcallArchivesRoot, entry.name, "sessions", accountId));
    }
  } catch {
    // ignore
  }
  const roots = [currentRoot, ...archiveRoots];
  let bestText = "";
  let bestScore = -Infinity;

  for (const rootDir of roots) {
    const jsonlFiles = listDescendantFiles(rootDir, (filePath) => filePath.endsWith(".jsonl"));
    for (const filePath of jsonlFiles.slice(0, 8)) {
      const text = safeReadTextFile(filePath);
      if (!text) continue;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed?.type !== "message" || parsed?.message?.role !== "assistant") continue;
        const candidate = extractTextFromMessageContent(parsed.message.content);
        const score = scoreRollcallEvidence(candidate);
        if (score > bestScore) {
          bestScore = score;
          bestText = candidate;
        }
      }
    }
    if (bestScore >= 260) break;
  }

  return bestText;
}

function findLatestWorkspaceMemoryText(accountId) {
  const memoryDir = path.join(activeRollcallWorkspaceRoot, `workspace-${accountId}`, "memory");
  const files = listDescendantFiles(memoryDir, (filePath) => filePath.endsWith(".md"));
  for (const filePath of files) {
    const text = stripFormattingNoise(safeReadTextFile(filePath));
    if (!text) continue;
    if (/日志|存档|Session|轮次状态|目标|修订要求|裁定依据/u.test(text)) {
      return text;
    }
  }
  return "";
}

function parseLabeledRollcallFields(text) {
  const structured = parseHanyuandianStructuredReport(text);
  if (!structured) return null;
  const values = {};
  for (const line of structured.split("\n")) {
    const colonIndex = line.indexOf("：");
    if (colonIndex <= 0) continue;
    const label = line.slice(0, colonIndex);
    const value = line.slice(colonIndex + 1).trim();
    if (label === "最近所办") values.recent = value;
    if (label === "当前异常") values.issue = value;
    if (label === "最可骄之处") values.pride = value;
    if (label === "需协调") values.coordination = value;
  }
  return values;
}

function firstMatchingGroup(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return stripFormattingNoise(match[1]).replace(/[。；;，,]+$/u, "").trim();
    }
  }
  return "";
}

function extractRollcallFieldsFromText(accountId, text) {
  const normalized = stripFormattingNoise(text);
  if (!normalized) return null;

  const structured = parseLabeledRollcallFields(normalized);
  if (
    structured?.recent &&
    structured?.issue &&
    structured?.pride &&
    structured?.coordination
  ) {
    return structured;
  }

  const recent = firstMatchingGroup(normalized, [
    /(?:最近所办|最近所辦|近办|近辦|最近主要在)[:：]?\s*([^。\n]+(?:[。；;][^。\n]+)*)/u,
    /^(?:中书省|門下省|门下省|尚书省|御史台|殿中省)?(?:近办|近來|近来|最近所办)[:：]?\s*([^。\n]+(?:[。；;][^。\n]+)*)/u,
  ]);
  let issue = "";
  if (/运转无异常|運轉無異常|当前无异常|暫未見新增異常|暂未见新增异常|无阻塞异常|未见明显异常/u.test(normalized)) {
    issue = "暂无明显异常。";
  } else {
    issue = firstMatchingGroup(normalized, [
      /(?:当前异常|當前異常)[:：]?\s*([^。\n]+(?:[。；;][^。\n]+)*)/u,
      /(?:异常|異常)[:：]?\s*([^。\n]+(?:[。；;][^。\n]+)*)/u,
    ]);
  }
  const pride = firstMatchingGroup(normalized, [
    /(?:最可骄之处|最值得骄傲之处|最可稱道者|最可称道者|最为可喜者|最可告慰者)[:：]?\s*([^。\n]+(?:[。；;][^。\n]+)*)/u,
  ]);
  let coordination = firstMatchingGroup(normalized, [
    /(?:需协调|是否需协调|尚需[^。\n]*协调[^。\n]*|尚需陛下或殿中省协调者)[:：]?\s*([^。\n]+(?:[。；;][^。\n]+)*)/u,
  ]);
  if (!coordination && /暂无需协调|暂不需协调|無需協調|无需协调/u.test(normalized)) {
    coordination = "暂无需协调。";
  }

  if (!recent || !issue || !pride || !coordination) return null;
  return { recent, issue, pride, coordination };
}

function resolveHostedRollcallEvidence(accountId) {
  return {
    archivedText: findBestArchivedAssistantText(accountId),
    memoryText: findLatestWorkspaceMemoryText(accountId),
  };
}

function normalizeHostedRollcallFields(accountId, fields) {
  if (!fields || typeof fields !== "object") return null;
  const recent = typeof fields.recent === "string" ? fields.recent.trim() : "";
  const issue = typeof fields.issue === "string" ? fields.issue.trim() : "";
  const pride = typeof fields.pride === "string" ? fields.pride.trim() : "";
  const coordination =
    typeof fields.coordination === "string" ? fields.coordination.trim() : "";
  if (!recent || !issue || !pride || !coordination) return null;

  const clamp = (value) => {
    const compact = value.replace(/\s+/g, " ").trim();
    const chars = Array.from(compact);
    return chars.length > 40 ? `${chars.slice(0, 40).join("")}...` : compact;
  };

  return {
    recent: clamp(recent),
    issue: clamp(issue),
    pride: clamp(pride),
    coordination: clamp(coordination),
  };
}

function buildHostedHanyuandianRollcallDigest(reportOverrides = null) {
  if (!reportOverrides || typeof reportOverrides !== "object") {
    return buildHostedHanyuandianFailureContent();
  }
  const lines = ["含元殿已开朝。今日点卯由殿中省代奏在值官员近况。", ""];
  for (const accountId of HANYUANDIAN_SUMMARY_ACCOUNTS) {
    const label = ROLLCALL_ACCOUNT_LABELS[accountId] ?? accountId;
    const overrideFields =
      reportOverrides && typeof reportOverrides === "object" ? reportOverrides[accountId] : null;
    const fields = normalizeHostedRollcallFields(accountId, overrideFields);
    if (!fields) {
      return buildHostedHanyuandianFailureContent(`【${label}】后台自述未采得合格四字段。`);
    }
    lines.push(`【${label}】`);
    lines.push(`最近所办：${fields.recent}`);
    lines.push(`当前异常：${fields.issue}`);
    lines.push(`最可骄之处：${fields.pride}`);
    lines.push(`需协调：${fields.coordination}`);
    lines.push("");
  }
  lines.push("含元殿点卯已毕。诸司各归本署，有本启奏，无本退朝。");
  return lines.join("\n");
}

function buildHanyuandianGuardPrompt(accountId, state, config) {
  if (!shouldGuardHanyuandianSession(state)) return "";

  const lines = [
    "含元殿守卫已启用。",
    "含元殿只处理朝会点卯，不处理宣案、提案、审议、裁决、会签。",
    "禁止把用户的“谁主持”“开始点卯”解释成宣政殿案件。",
    "禁止出现“宣案”“会签”“提案已拟”“待门下省审议、尚书省裁决”等宣政殿话术。",
    "禁止自称“朕”。你面对的是陛下，但你不是陛下。",
    "禁止代替其他机构发言。",
    "当前点卯采用殿中省单主持代奏：只有殿中省会在公共频道公开发言，其他官员一律静默。",
  ];

  if (accountId !== "dianzhongsheng") {
    lines.push("你不是本轮点卯主持。无论被提及、被引用或看到他人回文，都不得公开发言。");
    lines.push("你只能输出且只输出：NO_REPLY");
    return lines.join("\n");
  }

  if (state.phase === "await_rollcall_open") {
    lines.push("本轮点卯由插件私下采集后公开代奏。");
    lines.push("你不得公开发言。你只能输出且只输出：NO_REPLY");
    return lines.join("\n");
  }

  if (state.phase === "closed") {
    lines.push("本轮点卯已结束。除非陛下再次发起点卯，否则你必须静默。");
    lines.push("你只能输出且只输出：NO_REPLY");
    return lines.join("\n");
  }

  return lines.join("\n");
}

function buildCanonicalFormalContent(accountId, summary, config) {
  const payload = buildCanonicalFormalPayload(accountId, summary, null, config);
  if (!payload) return "";

  const caseKey = summary.caseKey || "宣政殿待办";
  const round = summary.round ?? 1;
  let shortLine = `【${caseKey}】${accountId} 第${round}轮正式回文。`;

  if (accountId === "silijian") {
    shortLine = `【${caseKey}】中书省第${round}轮提案。`;
  } else if (accountId === "neige") {
    shortLine = `【${caseKey}】门下省第${round}轮审议。`;
  } else if (accountId === "shangshu") {
    shortLine = `【${caseKey}】尚书省第${round}轮裁决：${payload.status || "PENDING"}。`;
  } else if (accountId === AUDIT_ACCOUNT_ID) {
    shortLine = `【${caseKey}】御史台审计：${payload.verdict || "PENDING"}。`;
  }

  let nextMention = "";
  if (accountId === "silijian") {
    nextMention = formatTransitionMention("neige", config);
  } else if (accountId === "neige") {
    nextMention = formatTransitionMention("shangshu", config);
  } else if (accountId === "shangshu" && payload.status === "REVISE_NEXT_ROUND") {
    nextMention = formatTransitionMention("silijian", config);
  } else if (accountId === AUDIT_ACCOUNT_ID && payload.verdict === "FAIL") {
    nextMention = formatTransitionMention("silijian", config);
  }
  if (nextMention) {
    shortLine = `${shortLine} ${nextMention}`;
  }

  return `${shortLine}\n${JSON.stringify(payload)}`;
}

function buildRelayDirective(state, config, nextInbound) {
  if (state.halted || state.expectedAccounts.length === 0) return null;
  const nextAccountId = state.expectedAccounts[0];
  const mention = formatTransitionMention(nextAccountId, config);
  if (!mention) return null;
  if (String(nextInbound.cleanedContent ?? "").includes(mention)) return null;

  let action = "请下一手继续讨论。";
  if (state.phase === "await_review") {
    action = `请门下省审议第${state.round}轮方案。`;
  } else if (state.phase === "await_decision") {
    action = `请尚书省裁决第${state.round}轮讨论。`;
  } else if (state.phase === "await_draft") {
    action = `请中书省起草第${state.round}轮修订案。`;
  } else if (state.phase === "await_audit") {
    action = `请御史台审计第${state.round}轮收敛结果。`;
  }

  return {
    accountId: "dianzhongsheng",
    nextAccountId,
    caseKey: state.caseKey,
    phase: state.phase,
    round: state.round,
    content: `【${state.caseKey}】守卫转递：${action} ${mention}`,
  };
}

function flattenMessageTextContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }

    if (part.type === "output_text" && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }

    if (typeof part.text === "string" && !part.type) {
      parts.push(part.text);
    }
  }

  return parts.join("\n\n").trim();
}

function stripFormattingNoise(text) {
  return stripReactionNoise(text)
    .replace(/<\/?final>/gi, " ")
    .replace(/\[\[\s*reply_to_current\s*\]\]/gi, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeInternalErrorText(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;
  return (
    /^assistantMsg\.content\.flatMap is not a function$/iu.test(normalized) ||
    /^(TypeError|ReferenceError|SyntaxError|RangeError):/iu.test(normalized) ||
    /^Cannot read properties of /iu.test(normalized)
  );
}

function inferReviewVerdictFromText(text) {
  if (/\bVETO\b|否决|驳回/iu.test(text)) return "VETO";
  if (/\bAPPROVED\b|通过|同意|可行/iu.test(text)) return "APPROVED";
  return "REVISE";
}

function inferDecisionStatusFromText(text) {
  if (/\bCONSENSUS_REACHED\b|达成共识|方案通过|准行|通过/iu.test(text)) {
    return "CONSENSUS_REACHED";
  }
  if (
    /\bESCALATE_TO_HUMAN\b|升级给人类|升级至人类|待用户裁决|待人类裁决|请陛下裁断|待陛下裁断|请吾皇裁断|待吾皇裁断|恭请圣裁/iu.test(
      text,
    )
  ) {
    return "ESCALATE_TO_HUMAN";
  }
  if (/\bREVISE_NEXT_ROUND\b|继续讨论|下一轮|继续修订|再议一轮/iu.test(text)) {
    return "REVISE_NEXT_ROUND";
  }
  return "";
}

function inferAuditVerdictFromText(text) {
  if (/\bFAIL\b|审计不通过|不予结案|退回三省|退回重议|需返修|存在越权|证据不足/iu.test(text)) {
    return "FAIL";
  }
  if (/\bPASS\b|审计通过|准予结案|可以结案|通过审计/iu.test(text)) {
    return "PASS";
  }
  return "";
}

function buildFallbackFormalSummary(accountId, rawText, state) {
  const cleanedContent = stripFormattingNoise(rawText);
  if (!cleanedContent) return null;

  const caseKey = extractCaseKey(cleanedContent) || state.caseKey || "宣政殿待办";
  const round = state.round ?? 1;

  if (accountId === "silijian") {
    return {
      cleanedContent,
      payload: {
        objective: shortenText(state.lastInbound?.caseKey || caseKey, 64),
        candidate_plan: shortenText(cleanedContent, 220),
        key_assumptions: [],
        tradeoffs: [],
      },
      caseKey,
      chainStage: "DRAFT",
      verdict: "",
      status: "",
      round,
      nextRound: null,
      maxRounds: null,
    };
  }

  if (accountId === "neige") {
    return {
      cleanedContent,
      payload: {
        major_objections: [],
        required_changes: [],
        preserved_strengths: [],
        summary: shortenText(cleanedContent, 220),
      },
      caseKey,
      chainStage: "REVIEW",
      verdict: inferReviewVerdictFromText(cleanedContent),
      status: "",
      round,
      nextRound: null,
      maxRounds: null,
    };
  }

  if (accountId === "shangshu") {
    const status = inferDecisionStatusFromText(cleanedContent);
    if (!status) return null;
    return {
      cleanedContent,
      payload: {
        decision_summary: shortenText(cleanedContent, 140),
        selected_direction: shortenText(cleanedContent, 120),
        required_revisions: [],
      },
      caseKey,
      chainStage: "DECISION",
      verdict: status,
      status,
      round,
      nextRound: status === "REVISE_NEXT_ROUND" ? round + 1 : null,
      maxRounds: null,
    };
  }

  if (accountId === AUDIT_ACCOUNT_ID) {
    const verdict = inferAuditVerdictFromText(cleanedContent);
    if (!verdict) return null;
    return {
      cleanedContent,
      payload: {
        audit_summary: shortenText(cleanedContent, 140),
        evidence_refs: [],
        required_fixes: [],
      },
      caseKey,
      chainStage: "AUDIT",
      verdict,
      status: verdict,
      round,
      nextRound: verdict === "FAIL" ? round + 1 : null,
      maxRounds: null,
    };
  }

  return null;
}

function resolveFormalSummaryForAccount(accountId, rawText, state) {
  const cleanedText = stripFormattingNoise(rawText);
  const summary = extractFormalEnvelope(cleanedText);
  if (summary.chainStage) {
    return {
      ...summary,
      cleanedContent: cleanedText,
      caseKey: summary.caseKey || state.caseKey || extractCaseSummary(cleanedText),
      round: summary.round ?? state.round ?? 1,
    };
  }
  return buildFallbackFormalSummary(accountId, cleanedText, state);
}

function scrubMessageForTranscript(message) {
  if (!message || typeof message !== "object" || message.role !== "user") {
    return null;
  }

  if (typeof message.content === "string") {
    const cleaned = scrubAgentMessageText(message.content);
    if (cleaned === message.content) return null;
    if (!cleaned) return { block: true };
    return { message: { ...message, content: cleaned } };
  }

  if (!Array.isArray(message.content)) return null;

  let changed = false;
  const nextContent = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string") {
      nextContent.push(part);
      continue;
    }
    const cleaned = scrubAgentMessageText(part.text);
    if (cleaned !== part.text) changed = true;
    if (!cleaned) continue;
    nextContent.push({ ...part, text: cleaned });
  }

  if (!changed) return null;
  if (nextContent.length === 0) return { block: true };
  return { message: { ...message, content: nextContent } };
}

function setInitialInboundState(state, senderId, senderAccountId, inboundSummary, config) {
  state.lastInbound = {
    senderId,
    senderAccountId,
    isHuman: config.humanUserIds.has(senderId),
    isResetSender: config.resetSenderIds.has(senderId),
    senderIsProtected: false,
    cleanedContent: inboundSummary.cleanedContent,
    caseKey: inboundSummary.caseKey || state.caseKey,
    chainStage: inboundSummary.chainStage,
    verdict: inboundSummary.verdict,
    status: normalizeDecisionStatus(inboundSummary),
    round: inboundSummary.round,
  };
}

function updateExpectedAccounts(state, accountId, summary, config) {
  state.pendingTurnReservations = {};

  if (accountId === "silijian") {
    state.halted = false;
    state.haltReason = "";
    state.phase = "await_review";
    state.expectedAccounts = ["neige"];
    return;
  }

  if (accountId === "neige") {
    state.halted = false;
    state.haltReason = "";
    state.phase = "await_decision";
    state.expectedAccounts = ["shangshu"];
    return;
  }

  if (accountId === "shangshu") {
    const decisionStatus = normalizeDecisionStatus(summary);
    if (decisionStatus === "REVISE_NEXT_ROUND") {
      state.halted = false;
      state.haltReason = "";
      state.round += 1;
      state.phase = "await_draft";
      state.expectedAccounts = ["silijian"];
      state.roundSpeakerCounts = {};
      return;
    }

    if (decisionStatus === "CONSENSUS_REACHED") {
      state.halted = false;
      state.haltReason = "";
      state.phase = "await_audit";
      state.expectedAccounts = [AUDIT_ACCOUNT_ID];
      return;
    }

    state.phase = "closed";
    state.expectedAccounts = [];
    state.halted = false;
    state.haltReason = "";
    return;
  }

  if (accountId === AUDIT_ACCOUNT_ID) {
    const auditVerdict = normalizeAuditVerdict(summary);
    if (auditVerdict === "FAIL") {
      if (state.round >= getEffectiveMaxRounds(state, config)) {
        state.phase = "closed";
        state.expectedAccounts = [];
        state.halted = false;
        state.haltReason = "audit_failed_after_max_rounds";
        return;
      }

      state.halted = false;
      state.haltReason = "";
      state.round += 1;
      state.phase = "await_draft";
      state.expectedAccounts = ["silijian"];
      state.roundSpeakerCounts = {};
      return;
    }

    state.phase = "closed";
    state.expectedAccounts = [];
    state.halted = false;
    state.haltReason = "";
  }
}

export function createDatangChaotangGuard(rawConfig = {}) {
  const config = resolvePluginConfig(rawConfig);
  activeRollcallArchivesRoot = config.rollcallArchivesRoot || DEFAULT_ROLLCALL_ARCHIVES_ROOT;
  activeRollcallWorkspaceRoot = config.rollcallWorkspaceRoot || DEFAULT_ROLLCALL_WORKSPACE_ROOT;

  function getState(channelId) {
    const store = readSharedStateStore(config.stateFile);
    return normalizeStoredChannelState(store.channels[channelId]);
  }

  function getHanyuandianState(channelId = HANYUANDIAN_CHANNEL_ID) {
    const store = readSharedStateStore(config.stateFile);
    return normalizeStoredHanyuandianState(store.channels[channelId]);
  }

  function saveState(channelId, state) {
    const store = readSharedStateStore(config.stateFile);
    const channels = store.channels && typeof store.channels === "object" ? store.channels : {};
    channels[channelId] = cloneStateForTest(state);
    writeJsonFile(config.stateFile, { channels });
    return state;
  }

  function saveHanyuandianState(channelId, state) {
    const store = readSharedStateStore(config.stateFile);
    const channels = store.channels && typeof store.channels === "object" ? store.channels : {};
    channels[channelId] = cloneStateForTest(state);
    writeJsonFile(config.stateFile, { channels });
    return state;
  }

  function resetState(channelId, content, metadata = {}) {
    const summary = extractFormalEnvelope(content);
    const next = createChannelState(
      summary.caseKey || buildAutoCaseKey(),
      summary.maxRounds,
    );
    next.caseStartMessageId = resolveInboundMessageId(metadata);
    return saveState(channelId, next);
  }

  function resetHanyuandianState(channelId, metadata = {}) {
    const next = createHanyuandianState();
    next.caseStartMessageId = resolveInboundMessageId(metadata);
    return saveHanyuandianState(channelId, next);
  }

  function acknowledgeHostedHanyuandianPublish(content = "", logger, haltReason = "rollcall_complete") {
    const state = getHanyuandianState(HANYUANDIAN_CHANNEL_ID);
    if (state.phase !== "await_rollcall_open") return;

    clearHanyuandianReservation(state, "dianzhongsheng");
    state.lastInbound = {
      senderId: "",
      senderAccountId: "dianzhongsheng",
      isHuman: false,
      isResetSender: false,
      senderIsProtected: true,
      cleanedContent: stripFormattingNoise(content || buildCanonicalHanyuandianRollcallContent(config)),
      caseKey: "",
      chainStage: "",
      verdict: "",
      status: "",
      round: null,
    };
    state.phase = "closed";
    state.expectedAccounts = [];
    state.speakerCounts.dianzhongsheng = 1;
    state.haltReason = haltReason;
    saveHanyuandianState(HANYUANDIAN_CHANNEL_ID, state);
    logger?.info?.(`${PLUGIN_ID}: hanyuandian hosted rollcall acknowledged as published haltReason=${haltReason}`);
  }

  function handleHanyuandianMessageReceived(event, ctx, logger) {
    const senderId = extractSenderId(event.metadata);
    const senderAccountId = resolveSenderAccountId(senderId, config);
    const inboundText = flattenMessageTextContent(event.content);
    const cleanedContent = stripFormattingNoise(inboundText);
    const state = getHanyuandianState(HANYUANDIAN_CHANNEL_ID);
    const inboundSignature = buildInboundSignature(
      senderAccountId,
      {
        senderId,
        senderAccountId,
        cleanedContent,
        caseKey: "",
        chainStage: "",
        verdict: "",
        status: "",
        round: null,
      },
      event.metadata,
    );

    if (config.humanUserIds.has(senderId) && isHanyuandianTriggerText(cleanedContent)) {
      const next = resetHanyuandianState(HANYUANDIAN_CHANNEL_ID, event.metadata);
      next.phase = "await_rollcall_open";
      next.expectedAccounts = ["dianzhongsheng"];
      next.lastInbound = {
        senderId,
        senderAccountId: "",
        isHuman: true,
        isResetSender: false,
        senderIsProtected: false,
        cleanedContent,
        caseKey: "",
        chainStage: "",
        verdict: "",
        status: "ROLLCALL_TRIGGERED",
        round: null,
      };
      rememberInboundSignature(next, inboundSignature);
      saveHanyuandianState(HANYUANDIAN_CHANNEL_ID, next);
      logger?.info?.(`${PLUGIN_ID}: hanyuandian rollcall triggered by human sender=${senderId}`);
      return {
        relay: {
          accountId: "dianzhongsheng",
          targetChannelId: HANYUANDIAN_CHANNEL_ID,
          nextAccountId: "",
          caseKey: "含元殿点卯",
          phase: next.phase,
          round: 1,
          content: buildCanonicalHanyuandianRollcallContent(config),
          resetAccountIds: [...HANYUANDIAN_SUMMARY_ACCOUNTS],
        },
      };
    }

    if (!senderAccountId || !HANYUANDIAN_ALLOWED_ACCOUNTS.has(senderAccountId)) return;
    if (hasSeenInboundSignature(state, inboundSignature)) return;

    if (state.phase === "await_rollcall_open" && senderAccountId === "dianzhongsheng") {
      state.lastInbound = {
        senderId,
        senderAccountId,
        isHuman: false,
        isResetSender: false,
        senderIsProtected: true,
        cleanedContent,
        caseKey: "",
        chainStage: "",
        verdict: "",
        status: "",
        round: null,
      };
      clearHanyuandianReservation(state, senderAccountId);
      state.phase = "closed";
      state.expectedAccounts = [];
      state.speakerCounts.dianzhongsheng = 1;
      state.haltReason = "rollcall_complete";
      rememberInboundSignature(state, inboundSignature);
      saveHanyuandianState(HANYUANDIAN_CHANNEL_ID, state);
      logger?.info?.(`${PLUGIN_ID}: hanyuandian hosted rollcall published by dianzhongsheng`);
      return;
    }

    rememberInboundSignature(state, inboundSignature);
    saveHanyuandianState(HANYUANDIAN_CHANNEL_ID, state);
  }

  function handleMessageReceived(event, ctx, logger) {
    if (!matchesProviderChannel(ctx.channelId, config.providerId)) return;

    const conversationTarget = extractConversationTarget(event, ctx);
    if (isTargetConversation(conversationTarget, HANYUANDIAN_CHANNEL_ID)) {
      return handleHanyuandianMessageReceived(event, ctx, logger);
    }
    if (!isTargetConversation(conversationTarget, config.xuanzhengdianChannelId)) return;

    const senderId = extractSenderId(event.metadata);
    const senderAccountId = resolveSenderAccountId(senderId, config);
    const inboundSummary = extractFormalEnvelope(event.content);
    const isResetSignal = shouldTreatAsResetSignal(senderId, inboundSummary, config);

    if (senderAccountId === "dianzhongsheng" && isGuardRelayText(inboundSummary.cleanedContent)) {
      logger?.info?.(`${PLUGIN_ID}: ignored herald relay case=${extractCaseKey(event.content) || "(unknown)"}`);
      return;
    }

    if (config.resetSenderIds.has(senderId) && !isResetSignal) {
      logger?.info?.(`${PLUGIN_ID}: ignored non-reset herald message sender=${senderId}`);
      return;
    }

    if (config.humanUserIds.has(senderId) || isResetSignal) {
      const state = resetState(config.xuanzhengdianChannelId, event.content, event.metadata);
      setInitialInboundState(state, senderId, senderAccountId, inboundSummary, config);
      saveState(config.xuanzhengdianChannelId, state);
      logger?.info?.(
        `${PLUGIN_ID}: reset xuanzhengdian case=${state.caseKey} round=${state.round} sender=${senderId}`,
      );
      return;
    }

    if (!senderAccountId || !config.protectedAccounts.has(senderAccountId)) return;

    const state = getState(config.xuanzhengdianChannelId);
    pruneExpiredTurnReservations(state);
    if (isInboundBeforeCaseStart(state, event.metadata)) {
      logger?.info?.(
        `${PLUGIN_ID}: ignored stale inbound before case start sender=${senderAccountId || senderId || "unknown"} case=${
          state.caseKey
        } messageId=${resolveInboundMessageId(event.metadata) || "(none)"} start=${
          state.caseStartMessageId || "(none)"
        }`,
      );
      return;
    }
    const nextInbound = {
      senderId,
      senderAccountId,
      isHuman: false,
      isResetSender: false,
      senderIsProtected: true,
      cleanedContent: inboundSummary.cleanedContent,
      caseKey: inboundSummary.caseKey || extractCaseKey(event.content) || state.caseKey,
      chainStage: inboundSummary.chainStage,
      verdict: inboundSummary.verdict,
      status: normalizeDecisionStatus(inboundSummary),
      round: inboundSummary.round,
    };
    const inboundSignature = buildInboundSignature(senderAccountId, nextInbound, event.metadata);
    if (!state.caseKey || state.caseKey === "宣政殿待办") {
      state.caseKey = nextInbound.caseKey || buildAutoCaseKey();
    }

    if (hasSeenInboundSignature(state, inboundSignature)) {
      logger?.info?.(
        `${PLUGIN_ID}: ignored duplicate inbound sender=${senderAccountId || senderId || "unknown"} case=${
          nextInbound.caseKey || state.caseKey
        } stage=${nextInbound.chainStage || "(none)"} round=${String(nextInbound.round ?? state.round)} signature=${inboundSignature}`,
      );
      return;
    }

    if (state.phase === "closed") {
      state.lastInbound = nextInbound;
      rememberInboundSignature(state, inboundSignature);
      saveState(config.xuanzhengdianChannelId, state);
      logger?.info?.(
        `${PLUGIN_ID}: ignored late inbound after close sender=${senderAccountId} case=${state.caseKey} round=${String(
          nextInbound.round ?? state.round,
        )} stage=${nextInbound.chainStage || "(none)"}`,
      );
      return;
    }

    if (!isGuardedFormalAccount(senderAccountId) || !inboundSummary.chainStage) {
      state.lastInbound = nextInbound;
      rememberInboundSignature(state, inboundSignature);
      saveState(config.xuanzhengdianChannelId, state);
      return;
    }

    if (isInboundProgressAlreadyApplied(senderAccountId, state, inboundSummary)) {
      state.lastInbound = nextInbound;
      rememberInboundSignature(state, inboundSignature);
      saveState(config.xuanzhengdianChannelId, state);
      logger?.info?.(
        `${PLUGIN_ID}: inbound progress already applied sender=${senderAccountId} case=${state.caseKey} round=${inboundSummary.round ?? state.round} stage=${inboundSummary.chainStage}`,
      );
      return;
    }

    const inboundViolation = getCoreSendViolation(senderAccountId, state, inboundSummary);
    if (inboundViolation) {
      state.halted = true;
      state.phase = "closed";
      state.expectedAccounts = [];
      state.haltReason = `inbound_${inboundViolation}`;
      state.lastInbound = nextInbound;
      rememberInboundSignature(state, inboundSignature);
      saveState(config.xuanzhengdianChannelId, state);
      logger?.warn?.(
        `${PLUGIN_ID}: halted on inbound sender=${senderAccountId} reason=${inboundViolation} case=${state.caseKey} round=${state.round}`,
      );
      return;
    }

    const nextRoundSpeakerCount = (state.roundSpeakerCounts[senderAccountId] ?? 0) + 1;
    const nextAutoTurns = state.autoTurns + 1;
    const effectiveMaxRounds = getEffectiveMaxRounds(state, config);
    let inboundLimitViolation = "";

    if (nextRoundSpeakerCount > (config.speakerLimits[senderAccountId] ?? 1)) {
      inboundLimitViolation = `speaker_limit:${senderAccountId}`;
    } else if (nextAutoTurns > config.maxDiscussionTurns) {
      inboundLimitViolation = "discussion_turn_limit";
    } else if (
      senderAccountId === "shangshu" &&
      normalizeDecisionStatus(inboundSummary) === "REVISE_NEXT_ROUND" &&
      state.round >= effectiveMaxRounds
    ) {
      inboundLimitViolation = "discussion_round_limit";
    } else if (
      senderAccountId === AUDIT_ACCOUNT_ID &&
      normalizeAuditVerdict(inboundSummary) === "FAIL" &&
      state.round >= effectiveMaxRounds
    ) {
      inboundLimitViolation = "audit_failed_after_max_rounds";
    }

    if (inboundLimitViolation) {
      state.halted = true;
      state.phase = "closed";
      state.expectedAccounts = [];
      state.haltReason = `inbound_${inboundLimitViolation}`;
      state.lastInbound = nextInbound;
      rememberInboundSignature(state, inboundSignature);
      saveState(config.xuanzhengdianChannelId, state);
      logger?.warn?.(
        `${PLUGIN_ID}: halted on inbound sender=${senderAccountId} reason=${inboundLimitViolation} case=${state.caseKey} round=${state.round}`,
      );
      return;
    }

    state.autoTurns = nextAutoTurns;
    state.speakerCounts[senderAccountId] = (state.speakerCounts[senderAccountId] ?? 0) + 1;
    state.roundSpeakerCounts[senderAccountId] = nextRoundSpeakerCount;
    updateExpectedAccounts(state, senderAccountId, inboundSummary, config);
    state.lastInbound = nextInbound;
    rememberInboundSignature(state, inboundSignature);
    saveState(config.xuanzhengdianChannelId, state);
    logger?.info?.(
      `${PLUGIN_ID}: advanced from inbound sender=${senderAccountId} case=${state.caseKey} phase=${state.phase} round=${state.round} expected=${
        state.expectedAccounts.join(",") || "(none)"
      }`,
    );
    return {
      relay: buildRelayDirective(state, config, nextInbound),
    };
  }

  function handleBeforeAgentStart(event, ctx, logger) {
    const accountId = ctx.agentId ?? "";
    if (!config.protectedAccounts.has(accountId)) return;

    if (isTargetSessionForChannel(ctx, config, HANYUANDIAN_CHANNEL_ID)) {
      const hanyuandianState = getHanyuandianState(HANYUANDIAN_CHANNEL_ID);
      if (!shouldGuardHanyuandianSession(hanyuandianState)) return;
      logger?.info?.(
        `${PLUGIN_ID}: before_agent_start hanyuandian account=${accountId} phase=${hanyuandianState.phase} expected=${
          hanyuandianState.expectedAccounts.join(",") || "(none)"
        }`,
      );
      return {
        appendSystemContext: buildHanyuandianGuardPrompt(accountId, hanyuandianState, config),
      };
    }

    if (!isTargetSession(ctx, config)) return;

    const state = getState(config.xuanzhengdianChannelId);
    pruneExpiredTurnReservations(state);
    logger?.info?.(
      `${PLUGIN_ID}: before_agent_start account=${accountId} phase=${state.phase} round=${state.round} expected=${
        state.expectedAccounts.join(",") || "(none)"
      }`,
    );

    return {
      providerOverride: config.xuanzhengdianProviderOverride,
      modelOverride: config.xuanzhengdianModelOverride,
      appendSystemContext: buildGuardPrompt(accountId, state, config),
    };
  }

  function handleBeforeModelResolve(event, ctx, logger) {
    if (!isTargetSession(ctx, config)) return;

    const accountId = ctx.agentId ?? "";
    if (!config.protectedAccounts.has(accountId)) return;

    const state = getState(config.xuanzhengdianChannelId);
    pruneExpiredTurnReservations(state);
    logger?.info?.(
      `${PLUGIN_ID}: before_model_resolve account=${accountId} phase=${state.phase} round=${state.round}`,
    );

    return {
      providerOverride: config.xuanzhengdianProviderOverride,
      modelOverride: config.xuanzhengdianModelOverride,
    };
  }

  function handleBeforePromptBuild(event, ctx, logger) {
    const accountId = ctx.agentId ?? "";
    if (!config.protectedAccounts.has(accountId)) return;

    if (isTargetSessionForChannel(ctx, config, HANYUANDIAN_CHANNEL_ID)) {
      const hanyuandianState = getHanyuandianState(HANYUANDIAN_CHANNEL_ID);
      if (!shouldGuardHanyuandianSession(hanyuandianState)) return;
      logger?.info?.(
        `${PLUGIN_ID}: before_prompt_build hanyuandian account=${accountId} phase=${hanyuandianState.phase} expected=${
          hanyuandianState.expectedAccounts.join(",") || "(none)"
        }`,
      );
      return {
        appendSystemContext: buildHanyuandianGuardPrompt(accountId, hanyuandianState, config),
      };
    }

    if (!isTargetSession(ctx, config)) return;

    const state = getState(config.xuanzhengdianChannelId);
    pruneExpiredTurnReservations(state);
    logger?.info?.(
      `${PLUGIN_ID}: before_prompt_build account=${accountId} phase=${state.phase} round=${state.round} expected=${
        state.expectedAccounts.join(",") || "(none)"
      }`,
    );

    return {
      appendSystemContext: buildGuardPrompt(accountId, state, config),
    };
  }

  function handleBeforeMessageWrite(event, ctx, logger) {
    const accountId = ctx.agentId ?? "";
    if (
      isTargetSessionForChannel(ctx, config, HANYUANDIAN_CHANNEL_ID) &&
      config.protectedAccounts.has(accountId)
    ) {
      if (event.message?.role === "user") {
        return scrubMessageForTranscript(event.message);
      }

      if (event.message?.role !== "assistant") return;

      const hanyuandianState = getHanyuandianState(HANYUANDIAN_CHANNEL_ID);
      pruneExpiredHanyuandianReservations(hanyuandianState);
      const rawText = flattenMessageTextContent(event.message.content);
      if (!rawText.trim()) {
        logger?.info?.(`${PLUGIN_ID}: blocked empty hanyuandian assistant transcript account=${accountId}`);
        return { block: true };
      }
      if (looksLikeInternalErrorText(rawText)) {
        logger?.warn?.(
          `${PLUGIN_ID}: blocked internal hanyuandian assistant transcript account=${accountId}`,
        );
        return { block: true };
      }

      if (accountId !== "dianzhongsheng") {
        logger?.info?.(`${PLUGIN_ID}: blocked non-host hanyuandian transcript account=${accountId}`);
        return { block: true };
      }

      if (hanyuandianState.phase === "await_rollcall_open") {
        if (looksLikeHostedHanyuandianDigest(rawText)) {
          return {
            message: {
              ...event.message,
              content: [{ type: "text", text: rawText }],
            },
          };
        }
        logger?.info?.(`${PLUGIN_ID}: blocked non-digest hanyuandian host transcript account=${accountId}`);
        return { block: true };
      }

      logger?.info?.(
        `${PLUGIN_ID}: blocked duplicate hanyuandian host transcript account=${accountId} phase=${hanyuandianState.phase}`,
      );
      return { block: true };
    }

    if (!isTargetSession(ctx, config)) return;
    if (!config.protectedAccounts.has(accountId)) return;

    if (event.message?.role === "user") {
      return scrubMessageForTranscript(event.message);
    }

    if (event.message?.role !== "assistant" || !isGuardedFormalAccount(accountId)) return;

    const state = getState(config.xuanzhengdianChannelId);
    pruneExpiredTurnReservations(state);
    const rawText = flattenMessageTextContent(event.message.content);
    if (!rawText.trim()) {
      logger?.info?.(`${PLUGIN_ID}: blocked empty assistant transcript account=${accountId}`);
      return { block: true };
    }
    if (looksLikeInternalErrorText(rawText)) {
      logger?.warn?.(`${PLUGIN_ID}: blocked internal assistant error transcript account=${accountId}`);
      return { block: true };
    }

    if (state.halted || !state.expectedAccounts.includes(accountId)) {
      logger?.info?.(
        `${PLUGIN_ID}: blocked out-of-turn assistant transcript account=${accountId} phase=${state.phase} round=${state.round}`,
      );
      return { block: true };
    }

    const summary = resolveFormalSummaryForAccount(accountId, rawText, state);
    if (!summary) {
      logger?.warn?.(
        `${PLUGIN_ID}: blocked malformed assistant transcript account=${accountId} case=${state.caseKey} round=${state.round}`,
      );
      return { block: true };
    }

    const transcriptViolation = getCoreSendViolation(accountId, state, summary);
    if (transcriptViolation) {
      logger?.warn?.(
        `${PLUGIN_ID}: blocked invalid assistant transcript account=${accountId} reason=${transcriptViolation} case=${state.caseKey} round=${state.round}`,
      );
      return { block: true };
    }

    const activeReservation = getActiveTurnReservation(state, accountId);
    if (reservationMatchesSummary(state, activeReservation, summary)) {
      logger?.info?.(
        `${PLUGIN_ID}: blocked duplicate assistant transcript account=${accountId} case=${summary.caseKey || state.caseKey} round=${summary.round ?? state.round} stage=${summary.chainStage}`,
      );
      return { block: true };
    }

    const canonicalContent = buildCanonicalFormalContent(accountId, summary, config);
    if (!canonicalContent) {
      logger?.warn?.(
        `${PLUGIN_ID}: blocked non-canonical assistant transcript account=${accountId} case=${state.caseKey} round=${state.round}`,
      );
      return { block: true };
    }

    rememberTurnReservation(state, accountId, summary);
    saveState(config.xuanzhengdianChannelId, state);

    logger?.info?.(
      `${PLUGIN_ID}: canonicalized assistant transcript account=${accountId} case=${summary.caseKey} round=${summary.round} stage=${summary.chainStage}`,
    );
    return {
      message: {
        ...event.message,
        content: [{ type: "text", text: canonicalContent }],
      },
    };
  }

  function handleBeforeToolCall(event, ctx, logger) {
    const accountId = ctx.agentId ?? "";
    if (!isGuardedFormalAccount(accountId) && !HANYUANDIAN_ALLOWED_ACCOUNTS.has(accountId)) return;

    const state = getState(config.xuanzhengdianChannelId);
    const hanyuandianState = getHanyuandianState(HANYUANDIAN_CHANNEL_ID);
    pruneExpiredTurnReservations(state);
    pruneExpiredHanyuandianReservations(hanyuandianState);
    const guardBySession = isTargetSession(ctx, config);
    const guardByActiveDiscussion = hasActiveDiscussionState(state);
    const guardHanyuandianBySession = isTargetSessionForChannel(ctx, config, HANYUANDIAN_CHANNEL_ID);
    const guardHanyuandianByActive =
      HANYUANDIAN_ALLOWED_ACCOUNTS.has(accountId) && hasActiveHanyuandianRollcall(hanyuandianState);
    if (!guardBySession && !guardByActiveDiscussion && !guardHanyuandianBySession && !guardHanyuandianByActive) {
      return;
    }

    const toolName =
      (typeof ctx.toolName === "string" && ctx.toolName.trim()) ||
      (typeof event?.toolName === "string" && event.toolName.trim()) ||
      "tool";

    if (guardBySession || guardByActiveDiscussion) {
      logger?.warn?.(
        `${PLUGIN_ID}: blocked tool call account=${accountId} tool=${toolName} case=${state.caseKey} phase=${state.phase} round=${state.round}`,
      );
      return {
        block: true,
        blockReason: `宣政殿三省讨论禁止工具调用: ${toolName}`,
      };
    }

    logger?.warn?.(
      `${PLUGIN_ID}: blocked hanyuandian tool call account=${accountId} tool=${toolName} phase=${hanyuandianState.phase}`,
    );
    return {
      block: true,
      blockReason: `含元殿点卯禁止工具调用: ${toolName}`,
    };
  }

  function handleMessageSending(event, ctx, logger) {
    const outboundChannelId = resolveOutboundChannelId(ctx, event);
    const targetIsXuanzhengdian =
      isTargetConversation(event.to, config.xuanzhengdianChannelId) ||
      isTargetConversation(outboundChannelId, config.xuanzhengdianChannelId) ||
      isTargetSessionForChannel(ctx, config, config.xuanzhengdianChannelId);
    const targetIsHanyuandian =
      isTargetConversation(event.to, HANYUANDIAN_CHANNEL_ID) ||
      isTargetConversation(outboundChannelId, HANYUANDIAN_CHANNEL_ID) ||
      isTargetSessionForChannel(ctx, config, HANYUANDIAN_CHANNEL_ID);
    const outboundChannelMatchesProvider =
      !outboundChannelId || matchesProviderChannel(outboundChannelId, config.providerId);
    if (!outboundChannelMatchesProvider && !targetIsXuanzhengdian && !targetIsHanyuandian) return;

    const summary = extractFormalEnvelope(event.content);
    const outboundText = flattenMessageTextContent(event.content);
    const resolvedAccountId = resolveOutgoingAccountId(ctx, event);
    const state = getState(config.xuanzhengdianChannelId);
    const hanyuandianState = getHanyuandianState(HANYUANDIAN_CHANNEL_ID);
    pruneExpiredTurnReservations(state);
    pruneExpiredHanyuandianReservations(hanyuandianState);
    const canInferHanyuandian =
      targetIsHanyuandian ||
      (hasActiveHanyuandianRollcall(hanyuandianState) &&
        matchesProviderChannel(outboundChannelId || config.providerId, config.providerId));
    const accountId = inferHanyuandianOutgoingAccountId(
      resolvedAccountId,
      outboundText,
      canInferHanyuandian,
      hanyuandianState,
    );
    const inferredHanyuandianHerald =
      !resolvedAccountId && targetIsHanyuandian && accountId === "dianzhongsheng";
    const guardAsActiveDiscussion =
      isGuardedFormalAccount(accountId) && hasActiveDiscussionState(state);
    const guardHanyuandianSend =
      HANYUANDIAN_ALLOWED_ACCOUNTS.has(accountId) &&
      (targetIsHanyuandian || hasActiveHanyuandianRollcall(hanyuandianState));
    const shouldGuardXuanzhengdianSend = targetIsXuanzhengdian || guardAsActiveDiscussion;

    if (targetIsXuanzhengdian || isCoreThreeProvinceAccount(accountId)) {
      logger?.warn?.(
        `${PLUGIN_ID}: message_sending account=${accountId || "unknown"} to=${String(
          event.to ?? "",
        )} channel=${outboundChannelId} target=${String(targetIsXuanzhengdian)} phase=${state.phase} round=${state.round} stage=${summary.chainStage || "(none)"}`,
      );
    }

    if (
      shouldGuardXuanzhengdianSend &&
      !summary.chainStage &&
      /\bNO_REPLY\b/.test(String(event.content ?? ""))
    ) {
      logger?.info?.(`${PLUGIN_ID}: cancelled no-reply stub in xuanzhengdian`);
      return { cancel: true };
    }
    if (shouldGuardXuanzhengdianSend && looksLikeInternalErrorText(outboundText)) {
      logger?.warn?.(`${PLUGIN_ID}: blocked internal error outbound account=${accountId || "unknown"}`);
      return { cancel: true };
    }

    const controlState = readControlState(config.controlFile);
    if (!config.protectedAccounts.has(accountId)) {
      if (targetIsXuanzhengdian && accountId) {
        logger?.info?.(`${PLUGIN_ID}: skipped non-protected account ${accountId} in xuanzhengdian`);
      } else if (targetIsXuanzhengdian && !accountId) {
        logger?.warn?.(`${PLUGIN_ID}: missing accountId for xuanzhengdian outbound message`);
      }
      return;
    }

    if (controlState.globalMute) {
      logger?.info?.(`${PLUGIN_ID}: global mute cancelled ${accountId} -> ${event.to}`);
      return { cancel: true };
    }

    if (targetIsHanyuandian && config.protectedAccounts.has(accountId) && accountId !== "dianzhongsheng") {
      logger?.info?.(
        `${PLUGIN_ID}: blocked non-host hanyuandian outbound account=${accountId} phase=${hanyuandianState.phase}`,
      );
      return { cancel: true };
    }

    if (guardHanyuandianSend) {
      if (hanyuandianState.phase === "await_rollcall_open") {
        if (accountId !== "dianzhongsheng") {
          logger?.info?.(
            `${PLUGIN_ID}: blocked hanyuandian lead usurpation account=${accountId} phase=${hanyuandianState.phase}`,
          );
          return { cancel: true };
        }
        clearHanyuandianReservation(hanyuandianState, accountId);
        if (looksLikeHostedHanyuandianDigest(outboundText)) {
          return { content: String(event.content ?? "") };
        }
        logger?.info?.(`${PLUGIN_ID}: blocked non-digest hanyuandian host outbound account=${accountId}`);
        return { cancel: true };
      }

      if (accountId !== "dianzhongsheng") {
        logger?.info?.(
          `${PLUGIN_ID}: blocked non-host hanyuandian outbound account=${accountId} phase=${hanyuandianState.phase}`,
        );
        return { cancel: true };
      }

      if (hanyuandianState.phase === "idle" || hanyuandianState.phase === "closed") {
        logger?.info?.(
          `${PLUGIN_ID}: blocked inactive hanyuandian outbound account=${accountId} phase=${hanyuandianState.phase}`,
        );
        return { cancel: true };
      }
    }

    if (!shouldGuardXuanzhengdianSend) return;
    if (accountId === "dianzhongsheng" && isGuardRelayText(outboundText)) {
      return;
    }

    if (!targetIsXuanzhengdian && guardAsActiveDiscussion) {
      logger?.warn?.(
        `${PLUGIN_ID}: guarding core outbound via active case fallback account=${accountId} to=${String(
          event.to ?? "",
        )} case=${state.caseKey} phase=${state.phase} round=${state.round}`,
      );
    }

    if (config.xuanzhengdianBlockedAccounts.has(accountId)) {
      logger?.info?.(`${PLUGIN_ID}: blocked restricted account ${accountId} in xuanzhengdian`);
      return { cancel: true };
    }

    if (state.halted) {
      logger?.info?.(`${PLUGIN_ID}: halted case=${state.caseKey} account=${accountId}`);
      return { cancel: true };
    }

    if (!isGuardedFormalAccount(accountId)) {
      logger?.info?.(`${PLUGIN_ID}: blocked non-core account ${accountId} in xuanzhengdian`);
      return { cancel: true };
    }

    let normalizedContent = String(event.content ?? "");
    let normalizedSummary = summary;
    if (summary.chainStage) {
      const explicitViolation = getCoreSendViolation(accountId, state, summary);
      if (explicitViolation) {
        logger?.info?.(
          `${PLUGIN_ID}: blocked explicit formal outbound account=${accountId} reason=${explicitViolation} case=${state.caseKey} round=${state.round}`,
        );
        return { cancel: true };
      }

      const canonicalContent = buildCanonicalFormalContent(accountId, summary, config);
      if (!canonicalContent) {
        logger?.warn?.(
          `${PLUGIN_ID}: blocked non-canonical outbound account=${accountId} case=${state.caseKey} round=${state.round}`,
        );
        return { cancel: true };
      }
      normalizedContent = canonicalContent;
      normalizedSummary = extractFormalEnvelope(canonicalContent);
    }

    const coreViolation = getCoreSendViolation(accountId, state, normalizedSummary);
    if (coreViolation) {
      logger?.info?.(
        `${PLUGIN_ID}: blocked ${accountId} in xuanzhengdian reason=${coreViolation} case=${state.caseKey} round=${state.round}`,
      );
      return { cancel: true };
    }

    const nextRoundSpeakerCount = (state.roundSpeakerCounts[accountId] ?? 0) + 1;
    const nextAutoTurns = state.autoTurns + 1;
    const effectiveMaxRounds = getEffectiveMaxRounds(state, config);

    let violationReason = "";
    if (nextRoundSpeakerCount > (config.speakerLimits[accountId] ?? 1)) {
      violationReason = `speaker_limit:${accountId}`;
    } else if (nextAutoTurns > config.maxDiscussionTurns) {
      violationReason = "discussion_turn_limit";
    } else if (
      accountId === "shangshu" &&
      normalizeDecisionStatus(normalizedSummary) === "REVISE_NEXT_ROUND" &&
      state.round >= effectiveMaxRounds
    ) {
      violationReason = "discussion_round_limit";
    } else if (
      accountId === AUDIT_ACCOUNT_ID &&
      normalizeAuditVerdict(normalizedSummary) === "FAIL" &&
      state.round >= effectiveMaxRounds
    ) {
      violationReason = "audit_failed_after_max_rounds";
    }

    if (violationReason) {
      state.halted = true;
      state.phase = "closed";
      state.expectedAccounts = [];
      state.haltReason = violationReason;
      saveState(config.xuanzhengdianChannelId, state);
      if (!state.escalationSent) {
        state.escalationSent = true;
        saveState(config.xuanzhengdianChannelId, state);
        logger?.info?.(
          `${PLUGIN_ID}: escalated case=${state.caseKey} round=${state.round} reason=${violationReason}`,
        );
        return { content: buildEscalationContent(state, config, violationReason) };
      }
      return { cancel: true };
    }

    state.autoTurns = nextAutoTurns;
    state.speakerCounts[accountId] = (state.speakerCounts[accountId] ?? 0) + 1;
    state.roundSpeakerCounts[accountId] = nextRoundSpeakerCount;
    if (normalizedSummary.caseKey) {
      state.caseKey = normalizedSummary.caseKey;
    }
    updateExpectedAccounts(state, accountId, normalizedSummary, config);
    saveState(config.xuanzhengdianChannelId, state);
    if (normalizedContent !== event.content) {
      return { content: normalizedContent };
    }
    return;
  }

  function handleMessageSent(event, ctx, logger) {
    if (event?.success !== true) return;

    const outboundChannelId = resolveOutboundChannelId(ctx, event);
    const targetIsHanyuandian = isTargetConversation(event.to, HANYUANDIAN_CHANNEL_ID);
    const outboundChannelMatchesProvider =
      !outboundChannelId || matchesProviderChannel(outboundChannelId, config.providerId);
    if (!outboundChannelMatchesProvider && !targetIsHanyuandian) return;

    const accountId = resolveOutgoingAccountId(ctx, event);
    if (!HANYUANDIAN_ALLOWED_ACCOUNTS.has(accountId)) return;

    if (!targetIsHanyuandian) return;

    const outboundText = stripFormattingNoise(flattenMessageTextContent(event.content));
    if (!outboundText) return;

    const state = getHanyuandianState(HANYUANDIAN_CHANNEL_ID);
    pruneExpiredHanyuandianReservations(state);

    if (state.phase === "await_rollcall_open" && accountId === "dianzhongsheng") {
      acknowledgeHostedHanyuandianPublish(outboundText, logger);
      return;
    }
  }

  return {
    config,
    handleMessageReceived,
    handleBeforeModelResolve,
    handleBeforePromptBuild,
    handleBeforeAgentStart,
    handleBeforeMessageWrite,
    handleBeforeToolCall,
    handleMessageSending,
    handleMessageSent,
    acknowledgeHostedHanyuandianPublish(content = "", logger) {
      acknowledgeHostedHanyuandianPublish(content, logger);
    },
    acknowledgeHostedHanyuandianFailure(content = "", logger) {
      acknowledgeHostedHanyuandianPublish(content, logger, "rollcall_failed");
    },
    buildHostedHanyuandianRollcallContent(reportOverrides = null) {
      if (reportOverrides && typeof reportOverrides === "object") {
        return buildHostedHanyuandianRollcallDigest(reportOverrides);
      }
      return buildCanonicalHanyuandianRollcallContent(config);
    },
    buildHostedHanyuandianFailureContent(reason = "") {
      return buildHostedHanyuandianFailureContent(reason || "本轮未取得合格的后台采样。");
    },
    extractHostedRollcallFields(accountId, text) {
      return extractRollcallFieldsFromText(accountId, text);
    },
    resolveHostedRollcallEvidence(accountId) {
      return resolveHostedRollcallEvidence(accountId);
    },
    getStateForTest(channelId = config.xuanzhengdianChannelId) {
      return cloneStateForTest(getState(channelId));
    },
  };
}
