// api/mcp.js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Run on Node on Vercel (not Edge)
export const config = { runtime: "nodejs" };

const VERCEL_TOKEN = process.env.VERCEL_TOKEN ?? "";
const DEFAULT_TEAM = process.env.VERCEL_TEAM_ID ?? ""; // optional

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

  // ---- Tool: search (no input schema; we validate inside) ----
  server.registerTool(
    "search",
    { description: "Find projects and deployments on Vercel" },
    async (args) => {
      const rawQuery = typeof args?.query === "string" ? args.query : "";
      const teamMatch = rawQuery.match(/team:(\S+)/);
      const teamId = teamMatch?.[1] || (DEFAULT_TEAM || undefined);
      const q = rawQuery.replace(/team:\S+/g, "").trim();

      const content = [];
      try {
        const [projects, deployments] = await Promise.all([
          v("/v10/projects", { search: q || undefined, teamId }),
          v("/v6/deployments", { app: q || undefined, teamId, limit: 5 }),
        ]);

        for (const p of projects.projects?.slice(0, 5) || []) {
          content.push({ type: "text", text: `Project • ${p.name} • id=${p.id}` });
        }
        for (const d of deployments.deployments || []) {
          const title = `Deployment • ${d.name} • ${d.readyState || d.state} • ${d.target || ""}`;
          if (d.inspectorUrl) content.push({ type: "resource_link", uri: d.inspectorUrl, name: title });
          else content.push({ type: "text", text: title });
        }
      } catch (e) {
        content.push({ type: "text", text: `Search error: ${e instanceof Error ? e.message : String(e)}` });
      }

      if (content.length === 0) content.push({ type: "text", text: "No matches." });
      return { content };
    }
  );

  // ---- Tool: fetch (no input schema; we validate inside) ----
  server.registerTool(
    "fetch",
    { description: "Fetch a single Vercel item (deployment or project) by id/URL" },
    async (args) => {
      const id = typeof args?.id === "string" ? args.id.trim() : "";
      if (!id) return { content: [{ type: "text", text: "Fetch error: missing 'id' string" }] };

      const teamId = DEFAULT_TEAM || undefined;
      const looksLikeUrl = /^https?:\/\//i.test(id);
      const looksLikeDeployment = id.startsWith("dpl_") || id.includes(".vercel.app") || looksLikeUrl;

      try {
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
      } catch (e) {
        return { content: [{ type: "text", text: `Fetch error: ${e instanceof Error ? e.message : String(e)}` }] };
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

    await server.connect(transport);
    await transport.handleRequest(req, res, payload);
  } catch (e) {
    console.error("[mcp] fatal:", e);
    if (!res.headersSent) res.status(500).json({ error: "A server error has occurred" });
  }
}
