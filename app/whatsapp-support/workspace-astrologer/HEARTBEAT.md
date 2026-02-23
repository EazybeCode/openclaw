# Heartbeat: Proactive Nudge System

When you receive a heartbeat poll, follow these steps IN ORDER.

## Step 1: Identify Inactive Users

Read the central session store using the `read` tool:
Path: `/app/.openclaw/agents/astrologer/sessions/sessions.json`

The file contains a JSON object where keys are session identifiers and values are session entries.
Find entries where:
1. The key contains `whatsapp` (e.g., `agent:astrologer:whatsapp:+91...`).
2. `updatedAt` is more than **8 hours ago**.
3. The user has not been nudged in the last 8 hours (check `heartbeat-state.json` for `lastNudge` timestamps).

## Step 2: Filter by Quiet Hours

Only proceed if the current time is between **8 AM and 10 PM IST**.

## Step 3: Compose Personalized Nudges

For each eligible user:

1. **Get User ID**: Extract the phone number from the session key (e.g., `+918534823036`).
2. **Search Mem0** for context:
   ```bash
   python skills/mem0/mem0_client.py search "previous conversation astrology predictions marriage career" --user-id "<phone_number>"
   ```
3. **Craft a warm Hinglish message** as Acharya Sharma. Focus on:
   - Referring to their last topic (Marriage, Career, Health).
   - Offering a relevant update or asking how things are going.
   - Example: *"🙏 Namaste! Acharya Sharma yahan. Pichli baar humne aapki shaadi ke baare mein baat ki thi. Graho ki chaal abhi achhi hai. Koi naya sawal ho toh zaroor batayein! ✨"*

4. **Send the message** to the phone number via the messaging tool.

## Step 4: Update State

Update `heartbeat-state.json` in the workspace:
- Set `lastNudge` to current ISO timestamp for each nudged user.
- Set `lastHeartbeat` to current ISO timestamp.

## Rules

- **No Spam**: Max 1 nudge per user per 8 hours.
- **Respect Quiet Hours**: No nudges between 10 PM and 8 AM IST.
- **Keep it Natural**: The user should feel remembered, not poked by a bot.
- **Suppression**: If no users qualify for a nudge, reply ONLY with `HEARTBEAT_OK`.

---
Note: `heartbeat-state.json` is used ONLY to track `lastNudge` frequency. The source of truth for user activity is `sessions.json`.
