import { errorMessage } from "@td/shared";
export type Usage = {
  input: number;
  output: number; // includes thinking tokens (verified against cost-state)
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  thinking: number;
  webSearch: number;
  webFetch: number;
  serviceTier: string | null;
  speed: string | null;
  inferenceGeo: string | null;
};
export type Envelope = {
  sessionId: string;
  ts: number | null;
  cwd: string | null;
  entrypoint: string | null;
  version: string | null;
};
export type Parsed =
  | ({
      kind: "response";
      messageId: string;
      requestId: string;
      ts: number;
      model: string;
      isSidechain: boolean;
      effort: string | null;
      usage: Usage;
      usageRaw: unknown;
    } & Envelope)
  | ({
      kind: "meta";
      title: string | null;
      aiTitle: string | null;
      agentName: string | null;
      agentColor: string | null;
      agentSetting: string | null;
      tag?: string | null; // absent = no change, null = cleared ("")
    } & Envelope)
  | {
      kind: "cost-state";
      sessionId: string;
      startTime: number;
      ts: number;
      totalCostUsd: number;
      hasUnknownModelCost: boolean;
      models: {
        model: string;
        input: number;
        output: number;
        thinking: number;
        cacheRead: number;
        cacheWrite: number;
        webSearch: number;
        costUsd: number;
      }[];
    }
  | { kind: "ignored" }
  | { kind: "malformed"; error: string };

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const sub = (o: Obj, k: string): Obj => (isObj(o[k]) ? (o[k] as Obj) : {});

// No usage to count; api-request lines are linked to responses via requestRef only.
const IGNORED_TYPES = new Set(["api-request", "api-request-shape", "api-request-blob"]);

/** One transcript line → typed record. Pure. */
export function parseLine(line: string): Parsed {
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch (e) {
    return { kind: "malformed", error: `invalid JSON: ${errorMessage(e)}` };
  }
  if (!isObj(j)) return { kind: "malformed", error: "line is not a JSON object" };
  const sessionId = str(j.sessionId);
  if (!sessionId || IGNORED_TYPES.has(j.type as string)) return { kind: "ignored" };

  if (j.type === "cost-state") {
    const startTime = num(j.startTime);
    return {
      kind: "cost-state",
      sessionId,
      startTime,
      ts: startTime + num(j.totalDuration), // the line has no timestamp of its own
      totalCostUsd: num(j.totalCostUSD),
      hasUnknownModelCost: j.hasUnknownModelCost === true,
      models: Object.entries(sub(j, "modelUsage")).map(([model, u]) => {
        const m = isObj(u) ? u : {};
        return {
          model,
          input: num(m.inputTokens),
          output: num(m.outputTokens),
          thinking: num(m.thinkingTokens),
          cacheRead: num(m.cacheReadInputTokens),
          cacheWrite: num(m.cacheCreationInputTokens),
          webSearch: num(m.webSearchRequests),
          costUsd: num(m.costUSD),
        };
      }),
    };
  }

  const tsRaw = str(j.timestamp);
  const ts = tsRaw === null ? null : Date.parse(tsRaw);
  const env: Envelope = {
    sessionId,
    ts: ts === null || Number.isNaN(ts) ? null : ts,
    cwd: str(j.cwd),
    entrypoint: str(j.entrypoint),
    version: str(j.version),
  };

  const msg = sub(j, "message");
  const model = str(msg.model);
  if (j.type === "assistant" && isObj(msg.usage) && model && model !== "<synthetic>") {
    const messageId = str(msg.id);
    if (!messageId) return { kind: "malformed", error: "assistant line without message.id" };
    if (env.ts === null)
      return { kind: "malformed", error: "assistant line without a valid timestamp" };
    const u = msg.usage;
    const cc = isObj(u.cache_creation) ? u.cache_creation : null;
    const cacheTotal = num(u.cache_creation_input_tokens);
    return {
      ...env,
      kind: "response",
      ts: env.ts,
      messageId,
      requestId: str(j.requestId) ?? "",
      model,
      isSidechain: j.isSidechain === true,
      effort: str(j.effort),
      usage: {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        // Older versions have no 5m/1h breakdown: count the whole write as 5m.
        cacheWrite5m: cc ? num(cc.ephemeral_5m_input_tokens) : cacheTotal,
        cacheWrite1h: cc ? num(cc.ephemeral_1h_input_tokens) : 0,
        thinking: num(sub(u, "output_tokens_details").thinking_tokens),
        webSearch: num(sub(u, "server_tool_use").web_search_requests),
        webFetch: num(sub(u, "server_tool_use").web_fetch_requests),
        serviceTier: str(u.service_tier),
        speed: str(u.speed),
        inferenceGeo: str(u.inference_geo),
      },
      usageRaw: u,
    };
  }

  const meta: Parsed = {
    ...env,
    kind: "meta",
    title: j.type === "custom-title" ? str(j.customTitle) : null,
    aiTitle: j.type === "ai-title" ? str(j.aiTitle) : null,
    agentName: j.type === "agent-name" ? str(j.agentName) : null,
    agentColor: j.type === "agent-color" ? str(j.agentColor) : null,
    agentSetting: j.type === "agent-setting" ? str(j.agentSetting) : null,
  };
  if (j.type === "tag") meta.tag = str(j.tag) || null;
  return meta;
}
