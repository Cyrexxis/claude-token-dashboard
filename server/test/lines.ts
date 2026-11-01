// Synthetic transcript lines shaped like Claude Code 2.1.309+ output. Never real content.
export const NOON = Date.parse("2026-10-15T12:00:00Z");

export type AssistantOpts = Partial<{
  sessionId: string;
  messageId: string;
  requestId: string | null; // null = omit the field
  ts: number | string | null; // null = omit the field
  model: string;
  usage: Record<string, unknown> | null; // null = omit usage
  isSidechain: boolean;
  cwd: string;
  entrypoint: string;
  effort: string;
}>;

export const usage = (input = 10, output = 20, extra: Record<string, unknown> = {}) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  speed: "standard",
  inference_geo: "global",
  ...extra,
});

export function assistant(o: AssistantOpts = {}): string {
  const ts = o.ts === undefined ? NOON : o.ts;
  const line: Record<string, unknown> = {
    parentUuid: null,
    isSidechain: o.isSidechain ?? false,
    message: {
      model: o.model ?? "claude-opus-5-5",
      id: o.messageId ?? "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "synthetic" }],
      ...(o.usage === null ? {} : { usage: o.usage ?? usage() }),
    },
    type: "assistant",
    uuid: crypto.randomUUID(),
    effort: o.effort ?? "high",
    userType: "external",
    entrypoint: o.entrypoint ?? "cli",
    cwd: o.cwd ?? "/home/user/demo",
    sessionId: o.sessionId ?? "s1",
    version: "2.1.309",
  };
  if (o.requestId !== null) line.requestId = o.requestId ?? "req_1";
  if (ts !== null) line.timestamp = typeof ts === "number" ? new Date(ts).toISOString() : ts;
  return JSON.stringify(line);
}

export type CostStateOpts = Partial<{
  sessionId: string;
  startTime: number;
  totalDuration: number;
  totalCostUSD: number;
  modelUsage: Record<string, Record<string, number>>;
}>;

export function costState(o: CostStateOpts = {}): string {
  return JSON.stringify({
    type: "cost-state",
    sessionId: o.sessionId ?? "s1",
    totalCostUSD: o.totalCostUSD ?? 4.8484315,
    totalAPIDuration: 1000,
    totalDuration: o.totalDuration ?? 60_000,
    startTime: o.startTime ?? NOON,
    modelUsage: o.modelUsage ?? {
      "claude-opus-5-5": {
        inputTokens: 178,
        outputTokens: 73415,
        thinkingTokens: 28540,
        cacheReadInputTokens: 8961590,
        cacheCreationInputTokens: 195092,
        webSearchRequests: 0,
        costUSD: 4.822066,
      },
      "claude-haiku-5-5": {
        inputTokens: 41080,
        outputTokens: 4515,
        thinkingTokens: 2293,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 2,
        costUSD: 0.0263655,
      },
    },
    hasUnknownModelCost: false,
  });
}

export const customTitle = (sessionId: string, title: string) =>
  JSON.stringify({ type: "custom-title", customTitle: title, sessionId });
export const aiTitle = (sessionId: string, title: string) =>
  JSON.stringify({ type: "ai-title", aiTitle: title, sessionId });
export const agentName = (sessionId: string, name: string) =>
  JSON.stringify({ type: "agent-name", agentName: name, sessionId });
export const agentColor = (sessionId: string, color: string) =>
  JSON.stringify({ type: "agent-color", agentColor: color, sessionId });
export const agentSetting = (sessionId: string, setting: string) =>
  JSON.stringify({ type: "agent-setting", agentSetting: setting, sessionId });
export const tag = (sessionId: string, value: string) =>
  JSON.stringify({ type: "tag", tag: value, sessionId });
export const user = (sessionId: string, ts: number) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "synthetic" },
    timestamp: new Date(ts).toISOString(),
    sessionId,
    cwd: "/home/user/demo",
    entrypoint: "cli",
    version: "2.1.309",
  });
