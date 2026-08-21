# MCP bridge

Optional zero-SDK stdio MCP client. Configure `.flavorlite/mcp.json`, then
activate it with `/plugin reload mcp-bridge` and run `/mcp connect <name>`.

```json
{
  "servers": {
    "example": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "category": "shell"
    }
  }
}
```

Remote tools are exposed as `mcp_<server>_<tool>` and default to the `shell`
permission category. Use `category: "read"` only for a server whose entire
tool surface is demonstrably read-only.
