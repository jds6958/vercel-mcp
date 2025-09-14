// api/mcp.js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Ensure Node runtime on Vercel (not Edge)
export const config = { runtime: "nodejs" };

const VERCEL_TOKEN = process.env.VERCEL_TOKEN ?? "";
const DEFAULT_TEAM = process.env.VERCEL_TEAM_ID ?? "";

async function v(apiPath, params = {}) {
  const url = new URL(`https://api.vercel.com${apiPath}`);
  for (const [k, val] of Object.entries(params)) {
    if (val !== undefined && val !== "") url.searchParams.set(k, String(val));
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } });
  if (!res.ok) throw new Error(`Vercel API ${apiPath} failed ${res.status}: ${await res.text()}`);
  return res.json();
}

function buildServer() {
  const server = new McpServer({ name: "vercel-readonly", version: "1.0.0" });

  // ✅ Plain JSON Schema (no Zod)
  const SearchInputJsonSchema = {
    type: "object",
    properties: {
      query: { type: "string", description: "Search text, e.g. 'team:team_123 my-app'" }
    },
    required: ["query"],
    additionalProperties: false
  };

  server.registerTool(
    "search",
    {
      description: "Find projects and deployments on Vercel",
      inputSchema: SearchInputJsonSchema
    },
    async ({ query }) => {
      const teamMatch = query.match(/team:(\S+)/);
      const teamId = teamMatch?.[1] || (DEFAULT_TEAM || undefined);
      const q = query.replace(/team:\S+/g, "").trim();

      const [projects, deployments] = await Promise.all([
        v("/v10/projects", { search: q || undefined, teamId }),
        v("/v6/deployments", { app: q || undefined, teamId, limit: 5 })
      ]);

      const content = [];

      for (const p of projects.projects?.slice(0, 5) || []) {
        content.push({ type: "text", text: `Project • ${p.name} • id=${p.id}` });
      }

      for (const d of deployments.deployments || []) {
        const title = `Deployment • ${d.name} • ${d.readyState || d.state} • ${d.target || ""}`;
        if (d.inspectorUrl) {
          content.push({ type: "resource_link", uri: d.inspectorUrl, name: title });
        } else {
          content.push({ type: "text", text: title });
        }
      }

      if (content.length === 0) content.push({ type: "text", text: "No matches." });
      return { content };
    }
  );

  return server;
}

export default async function handler(req, res) {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { try { transport.close(); server.close(); } catch {} });

    // Robust body read + parse (works on Vercel)
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bodyText = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
    let payload;
    if (bodyText) {
      try { payload = JSON.parse(bodyText); if (typeof payload === "string") payload = JSON.parse(payload); } catch {}
    }

    // Optional: ?debug=1 probe
    const url = new URL(req.url, "https://local");
    if (url.searchParams.get("debug") === "1") {
      res.setHeader("Content-Type", "application/json");
      res.status(200).end(JSON.stringify({
        parsedType: typeof payload,
        parsedPreview: payload && typeof payload === "object"
          ? { jsonrpc: payload.jsonrpc, method: payload.method, hasParams: !!payload.params }
          : payload
      }));
      return;
    }

    await server.connect(transport);
    await transport.handleRequest(req, res, payload);
  } catch (e) {
    console.error("[mcp] fatal:", e);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  }
}
