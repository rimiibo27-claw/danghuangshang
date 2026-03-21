import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { createDatangChaotangGuard } from "./guard-core.mjs";
import { runAction } from "./toggle-datang-freeze.mjs";

type DatangAction = "freeze" | "unfreeze" | "status";

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

export default function register(api: OpenClawPluginApi) {
  const guard = createDatangChaotangGuard(api.pluginConfig ?? {});

  registerDatangCommand(api, "freeze");
  registerDatangCommand(api, "unfreeze");
  registerDatangCommand(api, "status");

  api.on("message_received", async (event, ctx) => {
    const result = guard.handleMessageReceived(event, ctx, api.logger);
    const relay = result?.relay;
    if (!relay) return result;

    try {
      const currentConfig = api.runtime.config.loadConfig();
      await api.runtime.channel.discord.sendMessageDiscord(
        `channel:${guard.config.xuanzhengdianChannelId}`,
        relay.content,
        {
          cfg: currentConfig,
          accountId: relay.accountId,
          silent: true,
        },
      );
      api.logger.info?.(
        `datang-chaotang-guard: relay sent case=${relay.caseKey} round=${String(
          relay.round,
        )} phase=${relay.phase} next=${relay.nextAccountId}`,
      );
    } catch (error) {
      api.logger.warn?.(`datang-chaotang-guard: relay send failed: ${String(error)}`);
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
    guard.handleBeforeAgentStart(event, ctx, api.logger),
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
      return guard.handleMessageSending(event, ctx, api.logger);
    } catch (error) {
      api.logger.warn?.(`datang-chaotang-guard: message_sending failed: ${String(error)}`);
      return;
    }
  });

  api.on("message_sent", async (event, ctx) => {
    if (!channelMatchesProviderId(ctx.channelId, guard.config.providerId)) return;
    const targetIsXuanzhengdian =
      typeof event.to === "string" && event.to.includes(guard.config.xuanzhengdianChannelId);
    if (!targetIsXuanzhengdian && !guard.config.protectedAccounts.has(ctx.accountId ?? "")) return;
    api.logger.warn?.(
      `datang-chaotang-guard: message_sent account=${ctx.accountId ?? "unknown"} to=${String(
        event.to ?? "",
      )} success=${String(event.success)} content=${String(event.content ?? "").slice(0, 120)}`,
    );
  });
}
