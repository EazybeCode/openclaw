---
name: hubspot-mcp
description: "Query HubSpot CRM data. Get contacts, deals, companies, and engagement metrics."
metadata: { "openclaw": { "emoji": "🔶", "requires": { "bins": ["python3"] }, "env": [] } }
---

# HubSpot MCP Skill

Query HubSpot CRM data through the HubSpot MCP server.

## Token Management

HubSpot access tokens are fetched automatically from MongoDB using the tenant's `org_id` and `workspace_id`.

- **Database**: `eazybe-ai`
- **Collection**: `Users_hubspot_mcp_tokens`
- **Lookup**: By `org_id` (primary) and optionally `workspace_id`

No environment variable needed - tokens are fetched per-tenant from MongoDB.

## Available Tools

| Tool                       | Description                    |
| -------------------------- | ------------------------------ |
| `hubspot_search_contacts`  | Search for contacts in HubSpot |
| `hubspot_search_deals`     | Search for deals/opportunities |
| `hubspot_search_companies` | Search for companies           |
| `hubspot_get_contact`      | Get a specific contact by ID   |
| `hubspot_get_deal`         | Get a specific deal by ID      |
| `hubspot_list_pipelines`   | List deal pipelines and stages |

## Example Commands

### List available tools

```bash
python3 skills/hubspot-mcp/scripts/hubspot.py --org-id "ORG_ID" --workspace-id "WORKSPACE_ID" list-tools
```

### Search contacts

```bash
python3 skills/hubspot-mcp/scripts/hubspot.py --org-id "ORG_ID" --workspace-id "WORKSPACE_ID" call hubspot_search_contacts --query "email:*@company.com"
```

### Search deals

```bash
python3 skills/hubspot-mcp/scripts/hubspot.py --org-id "ORG_ID" --workspace-id "WORKSPACE_ID" call hubspot_search_deals --query "amount>10000"
```

### Get contact by ID

```bash
python3 skills/hubspot-mcp/scripts/hubspot.py --org-id "ORG_ID" --workspace-id "WORKSPACE_ID" call hubspot_get_contact --id "12345"
```

## Quick Commands

```bash
# List all tools
python3 skills/hubspot-mcp/scripts/hubspot.py --org-id "ORG_ID" --workspace-id "WS_ID" list-tools

# Call any tool
python3 skills/hubspot-mcp/scripts/hubspot.py --org-id "ORG_ID" --workspace-id "WS_ID" call <tool_name> --args '{"key": "value"}'
```

## MongoDB Token Document Schema

```json
{
  "org_id": "organization-uuid",
  "workspace_id": "workspace-uuid",
  "access_token": "pat-na1-xxx...",
  "refresh_token": "xxx...",
  "expires_in": 1800,
  "expires_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z"
}
```
