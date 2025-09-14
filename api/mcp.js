Last login: Sun Sep 14 17:45:32 on ttys000
jonsherman@jon ~ % cd ~/Desktop/vercel-mcp
git add api/mcp.js
git commit -m "add fetch tool (JSON Schema) for MCP spec"
git push

[main 5db0f66] add fetch tool (JSON Schema) for MCP spec
 1 file changed, 62 insertions(+), 7 deletions(-)
Enumerating objects: 7, done.
Counting objects: 100% (7/7), done.
Delta compression using up to 8 threads
Compressing objects: 100% (3/3), done.
Writing objects: 100% (4/4), 1.28 KiB | 1.28 MiB/s, done.
Total 4 (delta 2), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (2/2), completed with 2 local objects.
To https://github.com/jds6958/vercel-mcp.git
   6cb1f07..5db0f66  main -> main
jonsherman@jon vercel-mcp % DOMAIN=vercel-mcp-smoky.vercel.app

jonsherman@jon vercel-mcp % printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
curl -sN -H 'Accept: application/json, text/event-stream' \
         -H 'Content-Type: application/json' \
         --data-binary @- \
         "https://$DOMAIN/api/mcp"
# Example: by deployment id
printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fetch","arguments":{"id":"dpl_XXXXXXXX"}}}' | \
curl -sN -H 'Accept: application/json, text/event-stream' \
         -H 'Content-Type: application/json' \
         --data-binary @- \
         "https://$DOMAIN/api/mcp"

event: message
data: {"result":{"tools":[{"name":"search","description":"Find projects and deployments on Vercel","inputSchema":{"type":"object","properties":{},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}},{"name":"fetch","description":"Fetch a single Vercel item (deployment or project) by id/URL.","inputSchema":{"type":"object","properties":{},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}}]},"jsonrpc":"2.0","id":1}

zsh: command not found: #
event: message
data: {"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"keyValidator._parse is not a function"}}

jonsherman@jon vercel-mcp % 