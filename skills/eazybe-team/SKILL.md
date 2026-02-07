---
name: eazybe-team
description: "Fetch team members for name-to-user_id mapping. Required for comparing people in BigQuery."
metadata: { "openclaw": { "emoji": "👥", "requires": { "bins": ["python3"] }, "env": [] } }
---

# Eazybe Team API Skill

Fetch team members from Eazybe API to map names to BigQuery user_ids.

## Why This is Important

BigQuery uses numeric `user_id` values (like `1016867`), not names. When a user asks to "Compare mohit and chandan", you need to:

1. First find their user_ids using this skill
2. Then query BigQuery with those user_ids

## Commands

### List all team members

```bash
python3 skills/eazybe-team/scripts/team.py --org-id "WORKSPACE_ID" list
```

### Find a person by name

```bash
python3 skills/eazybe-team/scripts/team.py --org-id "WORKSPACE_ID" find "mohit"
```

## Example Workflow

1. User asks: "Compare mohit and chandan"
2. Find mohit's user_id: `python3 skills/eazybe-team/scripts/team.py --org-id "12839" find "mohit"`
3. Find chandan's user_id: `python3 skills/eazybe-team/scripts/team.py --org-id "12839" find "chandan"`
4. Query BigQuery with both user_ids:
   ```sql
   SELECT user_id, AVG(avg_agent_response_time_seconds), SUM(agent_message_count)
   FROM waba-454907.whatsapp_analytics.daily_performance_summary
   WHERE org_id='902' AND user_id IN ('123456', '789012')
   GROUP BY user_id
   ```

## API Endpoint

```
https://eazybe.com/api/v1/whatzapp/allteamdeails?user_id={org_id}
```
