---
name: bigquery-mcp
description: "Query WhatsApp Analytics data from BigQuery. Get response times, message counts, conversation metrics, and performance insights."
metadata:
  {
    "openclaw": { "emoji": "📊", "requires": { "bins": ["python3"] }, "env": ["BIGQUERY_MCP_URL"] },
  }
---

# BigQuery MCP Skill

Query WhatsApp Analytics data warehouse through the BigQuery MCP server.

## Dataset: whatsapp_analytics

### Tables

| Table                       | Description                              | Rows  |
| --------------------------- | ---------------------------------------- | ----- |
| `conversation_summary`      | Aggregated conversation metrics per chat | 22.5M |
| `daily_performance_summary` | Daily agent performance metrics          | 24.8M |
| `message_events`            | Raw message events                       | -     |
| `working_hours`             | Working hours configuration              | -     |

### Key Fields

**conversation_summary:**

- `uid`, `org_id`, `chat_id`, `phone_number`
- `average_response_time`, `first_response_time`
- `analytics.messages_sent`, `analytics.messages_received`, `analytics.total_messages`
- `conversation_starter`, `last_message_from`

**daily_performance_summary:**

- `activity_date`, `user_id`, `org_id`, `contact_id`
- `agent_message_count`, `contact_message_count`
- `avg_agent_response_time_seconds`, `time_to_first_response_seconds`

## Example Queries

### Average response time by agent

```bash
python3 skills/bigquery-mcp/scripts/bigquery.py query "SELECT user_id, AVG(avg_agent_response_time_seconds) as avg_response_time FROM whatsapp_analytics.daily_performance_summary WHERE activity_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) GROUP BY user_id ORDER BY avg_response_time"
```

### Daily message volume

```bash
python3 skills/bigquery-mcp/scripts/bigquery.py query "SELECT activity_date, SUM(agent_message_count) as sent, SUM(contact_message_count) as received FROM whatsapp_analytics.daily_performance_summary GROUP BY activity_date ORDER BY activity_date DESC LIMIT 30"
```

### Top performing agents (fastest response)

```bash
python3 skills/bigquery-mcp/scripts/bigquery.py query "SELECT user_id, COUNT(*) as conversations, AVG(avg_agent_response_time_seconds) as avg_response FROM whatsapp_analytics.daily_performance_summary WHERE activity_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) GROUP BY user_id ORDER BY avg_response ASC LIMIT 10"
```

### Conversation starters analysis

```bash
python3 skills/bigquery-mcp/scripts/bigquery.py query "SELECT conversation_starter, COUNT(*) as count FROM whatsapp_analytics.conversation_summary GROUP BY conversation_starter"
```

## Quick Commands

```bash
# List datasets
python3 skills/bigquery-mcp/scripts/bigquery.py datasets

# List tables
python3 skills/bigquery-mcp/scripts/bigquery.py tables whatsapp_analytics

# Get table schema
python3 skills/bigquery-mcp/scripts/bigquery.py schema whatsapp_analytics daily_performance_summary

# Ask AI for insights
python3 skills/bigquery-mcp/scripts/bigquery.py insights "What is the average response time trend over the last week?"

# Search catalog
python3 skills/bigquery-mcp/scripts/bigquery.py search "response time"
```

## Available Tools

| Tool                   | Description              |
| ---------------------- | ------------------------ |
| `list_dataset_ids`     | List all datasets        |
| `list_table_ids`       | List tables in a dataset |
| `get_table_info`       | Get table schema         |
| `execute_sql`          | Run SQL queries          |
| `ask_data_insights`    | AI-powered data insights |
| `analyze_contribution` | Analyze metric changes   |
| `forecast`             | Time series forecasting  |
