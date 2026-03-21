<img src="https://assets.withone.ai/banners/mcp.png?v=2" alt="One MCP — Connect your agents to every app through a single MCP." style="border-radius: 5px;">

<h3 align="center">One MCP Server</h3>

<p align="center">
  <a href="https://withone.ai"><strong>Website</strong></a>
  &nbsp;·&nbsp;
  <a href="https://withone.ai/docs"><strong>Docs</strong></a>
  &nbsp;·&nbsp;
  <a href="https://app.withone.ai"><strong>Dashboard</strong></a>
  &nbsp;·&nbsp;
  <a href="https://withone.ai/changelog"><strong>Changelog</strong></a>
  &nbsp;·&nbsp;
  <a href="https://x.com/withoneai"><strong>X</strong></a>
  &nbsp;·&nbsp;
  <a href="https://linkedin.com/company/withoneai"><strong>LinkedIn</strong></a>
</p>

<p align="center">
  <a href="https://npmjs.com/package/@withone/mcp"><img src="https://img.shields.io/npm/v/%40withone%2Fmcp" alt="npm version"></a>
</p>

Connect your AI agents to 250+ apps through a single [MCP](https://modelcontextprotocol.io) server. Search for actions, read documentation, and execute API calls across platforms, without having to manage OAuth tokens or API keys.

```bash
npm install -g @withone/cli
one init
```

That's it. The [One CLI](https://www.npmjs.com/package/@withone/cli) will prompt you for your API key (get one from the [One dashboard](https://app.withone.ai/settings/api-keys)) and configure the MCP server for your environment: Claude Desktop, Cursor, Claude Code, Windsurf, or any MCP-compatible agent.

## Capabilities

- **250+ platforms.** Gmail, Slack, Shopify, HubSpot, Stripe, Linear, QuickBooks, and [more](https://app.withone.ai/tools).
- **Natural language execution.** "read my last gmail email", "send a message to #general on Slack"
- **Code generation.** "build a form to send emails using Gmail", "create a dashboard that lists my Linear projects"
- **No tool bloat.** Only 4 tools exposed regardless of how many platforms or actions you connect. Actions are search-based, so your agent's context window stays clean.
- **Fine-grained access control.** Restrict which actions, connections, and permission levels (read, write, admin) your agent has access to.
- **Secure by default.** All requests proxied through One, secrets automatically redacted, no platform API keys to manage.

## Examples

**Execute actions directly:**
> "Get my last 5 emails from Gmail"

> "Send a Slack message to #general: 'Meeting in 10 minutes'"

> "Get all products from my Shopify store"

**Generate integration code:**
> "Create a React form component that sends emails using Gmail"

> "Build a dashboard that displays Linear users and their assigned projects with filtering"

> "Create a paginatable table that fetches and displays QuickBooks invoices with search and sort"

## Tools

The server exposes four MCP tools:

| Tool | Description |
|------|-------------|
| `list_one_integrations` | List available platforms and active connections |
| `search_one_platform_actions` | Search for actions on a specific platform |
| `get_one_action_knowledge` | Get detailed documentation for an action |
| `execute_one_action` | Execute an API action on a connected platform |

## Manual Installation

If you prefer to configure the server manually instead of using `one init`, install the package directly:

```bash
npm install @withone/mcp
```

Then set the required environment variable:

```bash
ONE_SECRET=your-one-secret-key
```

### Identity Scoping

Scope connections to a specific identity (e.g., a user, team, or organization):

```bash
ONE_IDENTITY=user_123
ONE_IDENTITY_TYPE=user
```

| Variable | Description | Values |
|----------|-------------|--------|
| `ONE_IDENTITY` | The identifier for the entity (e.g., user ID, team ID) | Any string |
| `ONE_IDENTITY_TYPE` | The type of identity | `user`, `team`, `organization`, `project` |

When set, the MCP server will only return connections associated with the specified identity. This is useful for multi-tenant applications where you want to scope integrations to specific users or entities.

### Access Control

Fine-tune what the MCP server can see and do:

```bash
ONE_PERMISSIONS=read
ONE_CONNECTION_KEYS=conn_key_1,conn_key_2
ONE_ACTION_IDS=action_id_1,action_id_2
ONE_KNOWLEDGE_AGENT=true
```

| Variable | Type | Default | Description |
|---|---|---|---|
| `ONE_PERMISSIONS` | `read` \| `write` \| `admin` | `admin` | Filter actions by HTTP method. `read` = GET only, `write` = GET/POST/PUT/PATCH, `admin` = all methods |
| `ONE_CONNECTION_KEYS` | `*` or comma-separated keys | `*` | Restrict visible connections and platforms to specific connection keys |
| `ONE_ACTION_IDS` | `*` or comma-separated IDs | `*` | Restrict visible and executable actions to specific action IDs |
| `ONE_KNOWLEDGE_AGENT` | `true` \| `false` | `false` | Remove the `execute_one_action` tool entirely, forcing knowledge-only mode |

All defaults preserve current behavior. If no access control env vars are set, the server starts with full access and all tools available.

## Manual Configuration

If you used `one init`, the configuration below is already done for you. These examples are for reference or manual setups.

### Standalone

```bash
npx @withone/mcp
```

### Claude Desktop / Cursor

Add the following to your MCP config:

- **Claude Desktop:** MacOS: `~/Library/Application\ Support/Claude/claude_desktop_config.json` · Windows: `%APPDATA%/Claude/claude_desktop_config.json`
- **Cursor:** Open the Cursor menu and select "MCP Settings"

```json
{
  "mcpServers": {
    "one": {
      "command": "npx",
      "args": ["@withone/mcp"],
      "env": {
        "ONE_SECRET": "your-one-secret-key"
      }
    }
  }
}
```

### Remote MCP Server

The remote MCP server is available at [https://mcp.withone.ai](https://mcp.withone.ai).

### Docker

```bash
docker build -t one-mcp-server .
docker run -e ONE_SECRET=your_one_secret_key one-mcp-server
```

All environment variables listed above can be passed as `-e` flags.

## Security

All requests to third-party platforms are authenticated and proxied through One's API. The MCP server never handles OAuth tokens or platform API keys directly. The `ONE_SECRET` key is the sole credential required, and it is automatically redacted from all response payloads returned to clients. Sensitive headers are stripped from logged and returned request configurations.

## License

MIT

## Support

For support, please contact support@withone.ai or visit https://withone.ai
