# One MCP Server: Installation Guide for AI Agents

This guide is for AI agents (Cline, Claude, Cursor, and similar) setting up the One MCP server for a user. Follow the options in order. Option A requires no credentials up front and is the recommended path.

## What this server does

One connects the agent to 700+ apps (Gmail, Slack, Stripe, Shopify, HubSpot, Notion, Linear, Salesforce, QuickBooks, and more) through four tools:

| Tool | Purpose |
|------|---------|
| `list_one_integrations` | List the user's connected platforms, each with the access it grants |
| `search_one_platform_actions` | Search actions on a platform |
| `get_one_action_knowledge` | Read an action's real parameters and docs before calling it |
| `execute_one_action` | Execute the action against the live account |

## Option A: Remote server (recommended, OAuth, nothing to install)

Add this entry to the client's MCP settings file (for Cline: `cline_mcp_settings.json`, or `~/.cline/mcp.json` for the Cline CLI):

```json
{
  "mcpServers": {
    "one": {
      "type": "streamableHttp",
      "url": "https://mcp.withone.ai/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Important: include `"type": "streamableHttp"` explicitly. Some clients treat a missing `type` as legacy SSE and will fail to connect.

Authentication: the first connection returns 401 and the client surfaces an OAuth authorize action. That opens the user's browser to One's consent screen (creating an account there is free). After the user approves, the four tools become available. No API key is needed and no secret is written to the settings file.

## Option B: Local server (npx, API key)

Requirements: Node.js 18+ and a One API key. The user can create one at https://app.withone.ai/settings/api-keys. Ask the user for the key; never guess or invent one.

```json
{
  "mcpServers": {
    "one": {
      "command": "npx",
      "args": ["-y", "@withone/mcp"],
      "env": {
        "ONE_SECRET": "the-user's-api-key"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Optional environment variables for access control (`ONE_PERMISSIONS`, `ONE_CONNECTION_KEYS`, `ONE_ACTION_IDS`, `ONE_KNOWLEDGE_AGENT`) and identity scoping (`ONE_IDENTITY`, `ONE_IDENTITY_TYPE`) are documented in [README.md](README.md).

## Verify the installation

Call `list_one_integrations`. A successful setup returns JSON containing a `connections` array, where each entry has a `platform`, a `key`, and the `access` it grants. Treat the presence of `connections` as success.

The rest of the payload differs slightly between the two options, so do not key your success check on anything else:

- Remote (Option A): `connections` plus `connectedCount`.
- Local (Option B): `connections` plus `availablePlatforms` and `summary` (`{ "connectedCount": <n>, "availableCount": <n> }`).

An empty `connections` list is still a successful install: it means the user has not connected any apps yet. In that case, tell the user to connect apps at https://app.withone.ai (or approve them on the OAuth consent screen for the remote server).

Note for clients that load MCP config at startup (Cline included): the server is not callable until the client is restarted or the MCP servers are reloaded. Tell the user to restart rather than reporting a failure.

## Troubleshooting

- Remote server never connects: confirm `"type": "streamableHttp"` is present and the URL is exactly `https://mcp.withone.ai/mcp`.
- Remote server shows 401 after previously working: the OAuth token expired. Trigger the client's re-authenticate action for the `one` server.
- Local server exits immediately or returns 401: `ONE_SECRET` is missing or invalid. Ask the user to re-copy it from https://app.withone.ai/settings/api-keys.
- Support: support@withone.ai or https://www.withone.ai/docs/mcp
