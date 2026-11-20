import plugin from "../../plugin/.claude-plugin/plugin.json";

// plugin.json is the only version; this embeds it at compile time.
export const SERVER_VERSION: string = plugin.version;
