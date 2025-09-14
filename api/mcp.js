// api/mcp.js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// Run on Node (not Edge)
export const config = { runtime: "nodejs" };

const VERCEL_TOKEN = process.env.VERCEL_TOKEN ?? "";
const DEFAULT_TEAM = process.env.VERCEL_TEAM_ID ?? ""; // optional default scope

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

  // ---- Zod input schemas (camelCase key: inputSchema) ----
  const SearchInput = z.object({
    query: z.string().describe("Search text, e.g. 'team:team_123 my-app'.")
  });

  const FetchInput = z.object({
    id: z.string().describe(
      "Deployment id (dpl_…), deployment URL (…vercel.app / https URL), or project id/name."
    )
  });

  // ---- Tool: search ----
  server.registerTool(
    "search",
    {
      description: "Find projects and deployments on Vercel",
      inputSchema: SearchInput, // ✅ camelCase, Zod object
    },
    async ({ query }) => {
      const teamMatch = query.match(/team:(\S+)/);
      const teamId = teamMatch?.[1] || (DEFAULT_TEAM || undefined);
      const q = query.replace(/team:\S+/g, "").trim();

      const [projects, deployments] = await Promise.all([
        v("/v10/projects", { search: q || undefined, teamId }),
        v("/v6/deployments", { app: q || undefined, teamId, limit: 5 }),
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

  // ---- Tool: fetch ----
  server.registerTool(
    "fetch",
    {
      description: "Fetch a single Vercel item (deployment or project) by id/URL",
      inputSchema: FetchInput, // ✅ camelCase, Zod object
    },
    async ({ id }) => {
      const teamId = DEFAULT_TEAM || undefined;
      const looksLikeUrl = /^https?:\/\//i.test(id);
      const looksLikeDeployment =
        id.startsWith("dpl_") || id.includes(".vercel.app") || looksLikeUrl;

      if (looksLikeDeployment) {
        const d = await v(`/v13/deployments/${encodeURIComponent(id)}`, { teamId });
        const lines = [
          `Deployment ${d.id} (${d.name})`,
          `state: ${d.readyState || d.state} • target: ${d.target || ""}`,
          d.url ? `url: https://${d.url}` : "",
          d.inspectorUrl ? `inspector: ${d.inspectorUrl}` : "",
        ].filter(Boolean);
        const out = [{ type: "text", text: lines.join("\n") }];
        if (d.inspectorUrl) out.push({ type: "resource_link", uri: d.inspectorUrl, name: "Open in Vercel" });
        if (d.url) out.push({ type: "resource_link", uri: `https://${d.url}`, name: "Open site" });
        return { content: out };
      } else {
        const p = await v(`/v9/projects/${encodeURIComponent(id)}`, { teamId });
        const lines = [
          `Project ${p.name} (id: ${p.id})`,
          p.framework ? `framework: ${p.framework}` : "",
          p.latestDeployments?.length
            ? `latest deployments: ${p.latestDeployments.map(x => x?.id).slice(0, 3).join(", ")}`
            : "",
        ].filter(Boolean);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    }
  );

  return server;
}

export default async function handler(req, res) {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { try { transport.close(); server.close(); } catch {} });

    // Read + parse JSON body robustly
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bodyText = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
    let payload;
    if (bodyText) {
      try { payload = JSON.parse(bodyText); if (typeof payload === "string") payload = JSON.parse(payload); } catch {}
    }

    // Optional: ?debug=1
    const url = new URL(req.url, "https://local");
    if (url.searchParams.get("debug") === "1") {
      res.setHeader("Content-Type", "application/json");
      res.status(200).end(JSON.stringify({
        parsedType: typeof payload,
        preview: payload && typeof payload === "object"
          ? { jsonrpc: payload.jsonrpc, method: payload.method, hasParams: !!payload.params }
          : payload
      }));
      return;
    }

    await server.connect(transport);
    await transport.handleRequest(req, res, payload);
  } catch (e) {
    console.error("[mcp] fatal:", e);
    if (!res.headersSent) res.status(500).json({ error: "A server error has occurred" });
  }
}
