// api/mcp.js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// Force Node runtime in Vercel (avoid Edge semantics)
export const config = { runtime: "nodejs" };

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const DEFAULT_TEAM = process.env.VERCEL_TEAM_ID || ""; // optional

async function v(apiPath, params = {}) {
  const url = new URL(`https://api.vercel.com${apiPath}`);
  for (const [k, val] of Object.entries(params)) {
    if (val !== undefined && val !== "") url.searchParams.set(k, String(val));
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vercel API ${apiPath} failed ${res.status}: ${text}`);
  }
  return res.json();
}

function buildServer() {
  const server = new McpServer({ name: "vercel-readonly", version: "1.0.0" });

  // Tool 1: search(query)
  server.registerTool(
    "search",
    {
      title: "Search Vercel",
      description: "Find projects and deployments on Vercel",
      inputSchema: z.object({ query: z.string() }),
    },
    async ({ query }) => {
      const teamMatch = query.match(/team:(\S+)/);
      const teamId = teamMatch?.[1] || DEFAULT_TEAM || undefined;
      const q = query.replace(/team:\S+/g, "").trim();

      const [projects, deployments] = await Promise.all([
        v("/v10/projects", { search: q || undefined, teamId }),
        v("/v6/deployments", { app: q || undefined, teamId, limit: 10 }),
      ]);

      const content = [];
      for (const p of projects.projects?.slice(0, 10) || []) {
        content.push({ type: "text", text: `Project • ${p.name} • id=${p.id}` });
      }
      for (const d of deployments.deployments || []) {
        const title = `Deployment • ${d.name} • ${d.readyState || d.state} • ${d.target || ""}`;
        if (d.inspectorUrl) {
          content.push({
            type: "resource_link",
            uri: d.inspectorUrl,
            name: title,
            description: d.url ? `URL: ${d.url}` : undefined,
          });
        } else {
          content.push({ type: "text", text: title });
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "No matches." });
      return { content };
    }
  );

  // Tool 2: fetch(id)
  server.registerTool(
    "fetch",
    {
      title: "Fetch Vercel item",
      description: "Fetch project or deployment details by ID/URL",
      inputSchema: z.object({ id: z.string() }),
    },
    async ({ id }) => {
      const teamId = DEFAULT_TEAM || undefined;
      const isDeployment = id.startsWith("dpl_") || id.includes(".vercel.app");
      if (isDeployment) {
        const d = await v(`/v13/deployments/${encodeURIComponent(id)}`, { teamId });
        const lines = [
          `Deployment ${d.id} (${d.name})`,
          `state: ${d.readyState || d.state} target: ${d.target}`,
          d.url ? `url: https://${d.url}` : "",
          d.inspectorUrl ? `inspector: ${d.inspectorUrl}` : "",
        ].filter(Boolean);
        const content = [{ type: "text", text: lines.join("\n") }];
        if (d.inspectorUrl) content.push({ type: "resource_link", uri: d.inspectorUrl, name: "Open in Vercel" });
        return { content };
      } else {
        const p = await v(`/v9/projects/${encodeURIComponent(id)}`, { teamId });
        const lines = [
          `Project ${p.name} (id: ${p.id})`,
          p.framework ? `framework: ${p.framework}` : "",
          p.latestDeployments?.length ? `latest deployments: ${p.latestDeployments.map(x => x?.id).slice(0,3).join(", ")}` : "",
        ].filter(Boolean);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    }
  );

  return server;
}

export default async function handler(req, res) {
  if (!VERCEL_TOKEN) {
    res.status(500).json({ error: "Missing VERCEL_TOKEN environment variable" });
    return;
  }

  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { try { transport.close(); server.close(); } catch {} });

    // ---- Robust raw-body read (Buffer concat) ----
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";

    // ---- Parse JSON (double-parse fallback) ----
    let payload;
    if (bodyText) {
      try {
        payload = JSON.parse(bodyText);
        if (typeof payload === "string") payload = JSON.parse(payload);
      } catch {
        payload = undefined; // we'll surface a clean error below
      }
    }

    // ---- DEBUG MODE: reply with what we parsed (no MCP call) ----
    if (req.headers["x-debug"] === "1") {
      res.setHeader("Content-Type", "application/json");
      res.status(200).end(
        JSON.stringify({
          receivedType: typeof bodyText,
          bodyText,
          parsedType: typeof payload,
          parsedPreview:
            payload && typeof payload === "object"
              ? { jsonrpc: payload.jsonrpc, method: payload.method, hasParams: !!payload.params }
              : payload,
        })
      );
      return;
    }

    // Normal MCP handling
    await server.connect(transport);
    await transport.handleRequest(req, res, payload);
  } catch (e) {
    console.error("[mcp] error:", e);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  }
}
