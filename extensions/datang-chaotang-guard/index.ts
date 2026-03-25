import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { createDatangChaotangGuard } from "./guard-core.mjs";
import { runAction } from "./toggle-datang-freeze.mjs";

type DatangAction = "freeze" | "unfreeze" | "status";
const execFileAsync = promisify(execFile);
const AGENTS_ROOT = "/Users/miibo/.openclaw/agents";
const HANYUANDIAN_CHANNEL_ID = "1482260119457632359";
const OPENCLAW_CLI_PATH = process.env.OPENCLAW_CLI_PATH || "/opt/homebrew/bin/openclaw";
const PRIVATE_ROLLCALL_TIMEOUT_SECONDS = 90;
const PRIVATE_ROLLCALL_THINKING = "minimal";
const HANYUANDIAN_SUMMARY_ACCOUNTS = [
  "dianzhongsheng",
  "silijian",
  "neige",
  "shangshu",
  "duchayuan",
] as const;
const HANYUANDIAN_NON_HOST_ACCOUNTS = HANYUANDIAN_SUMMARY_ACCOUNTS.filter(
  (accountId) => accountId !== "dianzhongsheng",
);
const PRIVATE_ROLLCALL_ROLE_LOCKS: Record<(typeof HANYUANDIAN_SUMMARY_ACCOUNTS)[number], string> = {
  dianzhongsheng: "殿中监·高力士",
  silijian: "中书省·苏绰",
  neige: "门下省·魏徵",
  shangshu: "尚书省·裴耀卿",
  duchayuan: "御史台·海瑞",
};

function countEnabledAccounts(accountStates?: Record<string, boolean>): number {
  if (!accountStates) return 0;
  return Object.values(accountStates).filter((value) => value !== false).length;
}

function channelMatchesProviderId(channelId: string | undefined, providerId: string): boolean {
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

function formatDatangReply(
  action: DatangAction,
  result: {
    globalMute: boolean;
    protectedAccounts?: string[];
    xuanzhengdianBlockedAccounts?: string[];
    accountStates?: Record<string, boolean>;
  },
): string {
  const enabledCount = countEnabledAccounts(result.accountStates);
  const totalCount = result.protectedAccounts?.length ?? 0;
  const blockedList =
    result.xuanzhengdianBlockedAccounts && result.xuanzhengdianBlockedAccounts.length > 0
      ? result.xuanzhengdianBlockedAccounts.join(", ")
      : "(none)";

  if (action === "freeze") {
    return [
      "赛博大唐已进入全朝静默。",
      `globalMute: ${String(result.globalMute)}`,
      `大唐官员账号: ${enabledCount}/${totalCount} 处于启用状态`,
      `宣政殿仅限制六部: ${blockedList}`,
      "说明：gateway 会自动热重载账号；如需复核，可执行 /datang-status。",
    ].join("\n");
  }

  if (action === "unfreeze") {
    return [
      "赛博大唐已解除全朝静默。",
      `globalMute: ${String(result.globalMute)}`,
      `大唐官员账号: ${enabledCount}/${totalCount} 处于启用状态`,
      `宣政殿仅限制六部: ${blockedList}`,
      "说明：gateway 会自动热重载账号；如需复核，可执行 /datang-status。",
    ].join("\n");
  }

  return [
    "赛博大唐当前状态如下。",
    `globalMute: ${String(result.globalMute)}`,
    `大唐官员账号: ${enabledCount}/${totalCount} 处于启用状态`,
    `宣政殿仅限制六部: ${blockedList}`,
    "可用命令：/datang-freeze /datang-unfreeze /datang-status",
  ].join("\n");
}

function registerDatangCommand(api: OpenClawPluginApi, action: DatangAction) {
  const name = `datang-${action}`;

  api.registerCommand({
    name,
    nativeNames: {
      discord: name,
    },
    description:
      action === "freeze"
        ? "Silence all Cyber Tang agents."
        : action === "unfreeze"
          ? "Restore Cyber Tang agents from the saved freeze snapshot."
          : "Show Cyber Tang freeze status.",
    requireAuth: true,
    handler: async (ctx) => {
      if (ctx.channel !== "discord") {
        return { text: "此命令仅支持在 Discord 中使用。" };
      }

      try {
        const result = runAction({
          action,
          configPath: "/Users/miibo/.openclaw/openclaw.json",
          controlFile: "",
          restart: false,
        });

        api.logger.info?.(
          `datang-chaotang-guard: command ${name} sender=${ctx.senderId ?? "unknown"} channel=${
            ctx.to ?? ctx.from ?? ctx.channel
          } globalMute=${String(result.globalMute)}`,
        );

        return { text: formatDatangReply(action, result) };
      } catch (error) {
        api.logger.warn?.(`datang-chaotang-guard: command ${name} failed: ${String(error)}`);
        return { text: `执行 ${name} 失败：${String(error)}` };
      }
    },
  });
}

function buildHanyuandianOpeningContent(
  guard: ReturnType<typeof createDatangChaotangGuard>,
  rollcallFields?: Record<string, { recent: string; issue: string; pride: string; coordination: string }>,
): string {
  return guard.buildHostedHanyuandianRollcallContent(rollcallFields ?? null);
}

function buildPrivateRollcallPrompt(
  accountId: (typeof HANYUANDIAN_SUMMARY_ACCOUNTS)[number],
  evidence: { archivedText: string; memoryText: string },
): string {
  const role = PRIVATE_ROLLCALL_ROLE_LOCKS[accountId] ?? accountId;
  const archivedText = evidence.archivedText.trim() || "(无)";
  const memoryText = evidence.memoryText.trim() || "(无)";
  return [
    `角色锁定：你现在不是通用助理，你就是${role}。`,
    "场景锁定：这是含元殿后台点卯采样，不公开，不寒暄，不提流程，不提其他官员。",
    "任务：根据你最近实际所做之事，输出一份近况自述。",
    "事实约束：只能依据下列真实留痕作保守重述，不得补写未发生之事；拿不准就明确写信息不足。",
    "长度约束：每行尽量简短，控制在 40 个中文字符内。",
    "硬性要求：1. 必须用中文；2. 只能输出四行；3. 不得出现第五行；4. 每行必须以固定字段名开头。",
    "会话留痕：",
    archivedText,
    "工作区记忆：",
    memoryText,
    "请在不新增事实的前提下，用你自己的口吻写成下列四行：",
    "输出模板如下：",
    "最近所办：...",
    "当前异常：...",
    "最可骄之处：...",
    "需协调：...",
  ].join("\n");
}

function extractAgentPayloadText(raw: string): string {
  const normalized = String(raw ?? "").trim();
  if (!normalized) return "";
  const start =
    normalized.lastIndexOf('{\n  "payloads"') >= 0
      ? normalized.lastIndexOf('{\n  "payloads"')
      : normalized.lastIndexOf('{"payloads"');
  const candidate = start >= 0 ? normalized.slice(start) : normalized;
  try {
    const parsed = JSON.parse(candidate);
    if (!Array.isArray(parsed?.payloads)) return "";
    return parsed.payloads
      .map((entry: { text?: string }) => (typeof entry?.text === "string" ? entry.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

async function collectPrivateRollcallFields(
  accountId: (typeof HANYUANDIAN_SUMMARY_ACCOUNTS)[number],
  api: OpenClawPluginApi,
  guard: ReturnType<typeof createDatangChaotangGuard>,
) {
  const sessionId = String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  const evidence = guard.resolveHostedRollcallEvidence(accountId);
  if (!evidence.archivedText.trim() && !evidence.memoryText.trim()) {
    throw new Error("缺少可用留痕");
  }
  resetAgentSessions(accountId, api);
  try {
    const result = await execFileAsync(
      OPENCLAW_CLI_PATH,
      [
        "agent",
        "--agent",
        accountId,
        "--local",
        "--session-id",
        sessionId,
        "--message",
        buildPrivateRollcallPrompt(accountId, evidence),
        "--thinking",
        PRIVATE_ROLLCALL_THINKING,
        "--timeout",
        String(PRIVATE_ROLLCALL_TIMEOUT_SECONDS),
        "--json",
      ],
      {
        cwd: "/Users/miibo",
        maxBuffer: 1024 * 1024,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const text = extractAgentPayloadText(output);
    const fields = guard.extractHostedRollcallFields(accountId, text);
    if (!fields) {
      api.logger.warn?.(
        `datang-chaotang-guard: private rollcall unparseable account=${accountId} text=${text.slice(0, 120)}`,
      );
      throw new Error("返回未命中四字段格式");
    }
    api.logger.info?.(`datang-chaotang-guard: private rollcall collected account=${accountId}`);
    return fields;
  } catch (error) {
    api.logger.warn?.(
      `datang-chaotang-guard: private rollcall failed account=${accountId}: ${String(error)}`,
    );
    throw error;
  } finally {
    resetAgentSessions(accountId, api);
  }
}

async function collectHostedRollcallFields(
  api: OpenClawPluginApi,
  guard: ReturnType<typeof createDatangChaotangGuard>,
) {
  const reports: Record<string, { recent: string; issue: string; pride: string; coordination: string }> = {};
  const failures: Array<{ accountId: string; reason: string }> = [];
  for (const accountId of HANYUANDIAN_SUMMARY_ACCOUNTS) {
    try {
      reports[accountId] = await collectPrivateRollcallFields(accountId, api, guard);
    } catch (error) {
      failures.push({ accountId, reason: String(error) });
    }
  }
  if (failures.length > 0) {
    const aggregated = new Error("后台私采未全部成功");
    Object.assign(aggregated, { rollcallFailures: failures });
    throw aggregated;
  }
  return reports;
}

function buildHostedRollcallFailureContent(
  guard: ReturnType<typeof createDatangChaotangGuard>,
  failures: Array<{ accountId: string; reason: string }>,
) {
  const reason = failures
    .map(({ accountId, reason: rawReason }) => {
      const label = PRIVATE_ROLLCALL_ROLE_LOCKS[accountId as keyof typeof PRIVATE_ROLLCALL_ROLE_LOCKS] ?? accountId;
      return `【${label}】${String(rawReason).slice(0, 60)}`;
    })
    .join("；");
  return guard.buildHostedHanyuandianFailureContent(reason || "后台私采失败");
}

async function sendHostedHanyuandianRollcall(
  api: OpenClawPluginApi,
  guard: ReturnType<typeof createDatangChaotangGuard>,
  source: string,
) {
  const currentConfig = api.runtime.config.loadConfig();
  try {
    for (const accountId of HANYUANDIAN_SUMMARY_ACCOUNTS) {
      resetAgentSessions(accountId, api);
    }
    const rollcallFields = await collectHostedRollcallFields(api, guard);
    const openingContent = buildHanyuandianOpeningContent(guard, rollcallFields);
    await api.runtime.channel.discord.sendMessageDiscord(`channel:${HANYUANDIAN_CHANNEL_ID}`, openingContent, {
      cfg: currentConfig,
      accountId: "dianzhongsheng",
      silent: true,
    });
    guard.acknowledgeHostedHanyuandianPublish(openingContent, api.logger);
    scheduleHostedHanyuandianCleanup(api);
    api.logger.info?.(`datang-chaotang-guard: hosted hanyuandian rollcall sent via ${source}`);
    return { ok: true as const };
  } catch (error) {
    const failures = Array.isArray((error as { rollcallFailures?: unknown[] })?.rollcallFailures)
      ? ((error as { rollcallFailures: Array<{ accountId: string; reason: string }> }).rollcallFailures)
      : [{ accountId: "dianzhongsheng", reason: String(error) }];
    const failureContent = buildHostedRollcallFailureContent(guard, failures);
    await api.runtime.channel.discord.sendMessageDiscord(`channel:${HANYUANDIAN_CHANNEL_ID}`, failureContent, {
      cfg: currentConfig,
      accountId: "dianzhongsheng",
      silent: true,
    });
    guard.acknowledgeHostedHanyuandianFailure(failureContent, api.logger);
    scheduleHostedHanyuandianCleanup(api);
    api.logger.warn?.(`datang-chaotang-guard: hosted hanyuandian rollcall failed via ${source}: ${String(error)}`);
    return { ok: false as const, failures };
  }
}

function registerDatangRollcallCommand(
  api: OpenClawPluginApi,
  guard: ReturnType<typeof createDatangChaotangGuard>,
) {
  api.registerCommand({
    name: "datang-rollcall",
    nativeNames: {
      discord: "datang-rollcall",
    },
    description: "Open Hanyuandian rollcall hosted by dianzhongsheng.",
    requireAuth: true,
    handler: async (ctx) => {
      if (ctx.channel !== "discord") {
        return { text: "此命令仅支持在 Discord 中使用。" };
      }

      const senderId =
        typeof ctx.senderId === "string" && ctx.senderId.trim()
          ? ctx.senderId.trim()
          : "1476931252576850095";

      try {
        guard.handleMessageReceived(
          {
            from: HANYUANDIAN_CHANNEL_ID,
            content: "点卯",
            metadata: {
              senderId,
              channelId: HANYUANDIAN_CHANNEL_ID,
            },
          },
          {
            channelId: guard.config.providerId,
            conversationId: HANYUANDIAN_CHANNEL_ID,
          },
          api.logger,
        );

        const result = await sendHostedHanyuandianRollcall(api, guard, "command");

        api.logger.info?.(
          `datang-chaotang-guard: command datang-rollcall sender=${senderId} target=${HANYUANDIAN_CHANNEL_ID}`,
        );

        return { text: result.ok ? "含元殿点卯已发起。" : "含元殿点卯未成，已公开报失败。" };
      } catch (error) {
        api.logger.warn?.(`datang-chaotang-guard: command datang-rollcall failed: ${String(error)}`);
        return { text: `执行 datang-rollcall 失败：${String(error)}` };
      }
    },
  });
}

function queueRelaySend(
  api: OpenClawPluginApi,
  guard: ReturnType<typeof createDatangChaotangGuard>,
  relay: {
    accountId: string;
    targetChannelId?: string;
    content: string;
    caseKey?: string;
    round?: number;
    phase?: string;
    nextAccountId?: string;
    resetAccountIds?: string[];
    delayMs?: number;
  },
  source: string,
) {
  void (async () => {
    try {
      const relayTargetChannelId = relay.targetChannelId ?? guard.config.xuanzhengdianChannelId;
      if (relayTargetChannelId === HANYUANDIAN_CHANNEL_ID && relay.accountId === "dianzhongsheng") {
        await sendHostedHanyuandianRollcall(api, guard, source);
        return;
      }
      const resetAccountIds = Array.from(
        new Set([...(relay.resetAccountIds ?? []), relay.nextAccountId ?? ""]).values(),
      ).filter(Boolean);
      for (const accountId of resetAccountIds) {
        resetAgentSessions(accountId, api);
      }
      if (relay.delayMs && relay.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, relay.delayMs));
      }
      const currentConfig = api.runtime.config.loadConfig();
      const outboundContent = relay.content;
      await api.runtime.channel.discord.sendMessageDiscord(
        `channel:${relayTargetChannelId}`,
        outboundContent,
        {
          cfg: currentConfig,
          accountId: relay.accountId,
          silent: true,
        },
      );
      api.logger.info?.(
        `datang-chaotang-guard: relay sent via ${source} case=${relay.caseKey ?? ""} round=${String(
          relay.round ?? "",
        )} phase=${relay.phase ?? ""} next=${relay.nextAccountId ?? ""}`,
      );
    } catch (error) {
      api.logger.warn?.(`datang-chaotang-guard: relay send via ${source} failed: ${String(error)}`);
    }
  })();
}

function resetAgentSessions(accountId: string, api: OpenClawPluginApi) {
  if (!accountId.trim()) return;
  const sessionsDir = path.join(AGENTS_ROOT, accountId, "sessions");
  try {
    if (!fs.existsSync(sessionsDir)) return;
    const entries = fs.readdirSync(sessionsDir);
    for (const entry of entries) {
      const fullPath = path.join(sessionsDir, entry);
      if (entry === "sessions.json") continue;
      if (entry.endsWith(".jsonl") || entry.endsWith(".jsonl.lock")) {
        fs.rmSync(fullPath, { force: true });
      }
    }
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}\n", "utf8");
    api.logger.info?.(`datang-chaotang-guard: reset sessions for next rollcall account=${accountId}`);
  } catch (error) {
    api.logger.warn?.(`datang-chaotang-guard: failed to reset sessions for ${accountId}: ${String(error)}`);
  }
}

function isHanyuandianSessionContext(ctx: { sessionKey?: string; channelId?: string }): boolean {
  return (
    (typeof ctx.sessionKey === "string" && ctx.sessionKey.includes(HANYUANDIAN_CHANNEL_ID)) ||
    channelMatchesProviderId(ctx.channelId, HANYUANDIAN_CHANNEL_ID)
  );
}

function scheduleAccountSessionCleanup(
  accountId: string,
  api: OpenClawPluginApi,
  delaysMs = [0, 1500, 5000],
) {
  for (const delayMs of delaysMs) {
    setTimeout(() => {
      resetAgentSessions(accountId, api);
      api.logger.info?.(
        `datang-chaotang-guard: session cleanup account=${accountId} delayMs=${String(delayMs)}`,
      );
    }, delayMs);
  }
}

function scheduleHostedHanyuandianCleanup(api: OpenClawPluginApi) {
  const delaysMs = [1500, 5000, 12000];
  for (const delayMs of delaysMs) {
    setTimeout(() => {
      for (const accountId of HANYUANDIAN_NON_HOST_ACCOUNTS) {
        resetAgentSessions(accountId, api);
      }
      api.logger.info?.(
        `datang-chaotang-guard: hosted hanyuandian cleanup sweep delayMs=${String(delayMs)}`,
      );
    }, delayMs);
  }
}

export default function register(api: OpenClawPluginApi) {
  const guard = createDatangChaotangGuard(api.pluginConfig ?? {});

  registerDatangCommand(api, "freeze");
  registerDatangCommand(api, "unfreeze");
  registerDatangCommand(api, "status");
  registerDatangRollcallCommand(api, guard);

  api.on("message_received", async (event, ctx) => {
    const result = guard.handleMessageReceived(event, ctx, api.logger);
    const relay = result?.relay;
    if (relay) {
      queueRelaySend(api, guard, relay, "message_received");
    }

    return result;
  });

  api.on("before_model_resolve", async (event, ctx) =>
    guard.handleBeforeModelResolve(event, ctx, api.logger),
  );

  api.on("before_prompt_build", async (event, ctx) =>
    guard.handleBeforePromptBuild(event, ctx, api.logger),
  );

  api.on("before_agent_start", async (event, ctx) =>
    {
      const accountId = ctx.agentId ?? "";
      if (
        accountId &&
        HANYUANDIAN_NON_HOST_ACCOUNTS.includes(
          accountId as (typeof HANYUANDIAN_NON_HOST_ACCOUNTS)[number],
        ) &&
        isHanyuandianSessionContext(ctx)
      ) {
        scheduleAccountSessionCleanup(accountId, api);
      }
      return guard.handleBeforeAgentStart(event, ctx, api.logger);
    },
  );

  api.on("before_message_write", (event, ctx) =>
    guard.handleBeforeMessageWrite(event, ctx, api.logger),
  );

  api.on("before_tool_call", async (event, ctx) => {
    try {
      return guard.handleBeforeToolCall(event, ctx, api.logger);
    } catch (error) {
      api.logger.warn?.(`datang-chaotang-guard: before_tool_call failed: ${String(error)}`);
      return;
    }
  });

  api.on("message_sending", async (event, ctx) => {
    try {
      const result = guard.handleMessageSending(event, ctx, api.logger);
      const relay = result?.relay;
      if (relay) {
        queueRelaySend(api, guard, relay, "message_sending");
      }
      return result;
    } catch (error) {
      api.logger.warn?.(`datang-chaotang-guard: message_sending failed: ${String(error)}`);
      return;
    }
  });

  api.on("message_sent", async (event, ctx) => {
    const result = guard.handleMessageSent?.(event, ctx, api.logger);
    const relay = result?.relay;
    if (relay) {
      queueRelaySend(api, guard, relay, "message_sent");
    }

    if (!channelMatchesProviderId(ctx.channelId, guard.config.providerId)) return;
    const targetIsXuanzhengdian =
      typeof event.to === "string" && event.to.includes(guard.config.xuanzhengdianChannelId);
    const targetIsHanyuandian =
      typeof event.to === "string" && event.to.includes("1482260119457632359");
    if (
      !targetIsXuanzhengdian &&
      !targetIsHanyuandian &&
      !guard.config.protectedAccounts.has(ctx.accountId ?? "")
    ) {
      return;
    }
    api.logger.warn?.(
      `datang-chaotang-guard: message_sent account=${ctx.accountId ?? "unknown"} to=${String(
        event.to ?? "",
      )} success=${String(event.success)} content=${String(event.content ?? "").slice(0, 120)}`,
    );
  });
}
