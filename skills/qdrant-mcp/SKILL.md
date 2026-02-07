---
name: qdrant-mcp
description: "Search knowledge base. Use for: product questions, company info, feature explanations, documentation, how-to questions."
metadata: { "openclaw": { "emoji": "🔍", "requires": { "bins": ["python3"] }, "env": [] } }
---

# Qdrant MCP Skill

Semantic search on the Qdrant knowledge base using vector similarity.

## When to Use This Skill

Use Qdrant when the user asks about:

- **Product/Company info**: "What is Eazybe?", "What features do you have?"
- **How-to questions**: "How do I...", "How can I..."
- **Documentation**: "How does X work?", "Explain feature Y"
- **Past conversations**: "Did anyone ask about...", "Similar issues"

**DO NOT use for**: Analytics, metrics, comparisons, numbers (use BigQuery instead)

## Use Cases

- Search chat history and customer conversations
- Find relevant documentation
- Discover patterns in past interactions
- Contextual search using natural language

## Commands

### Semantic Search

```bash
python3 skills/qdrant-mcp/scripts/qdrant.py search "your search query"
```

### Search with Options

```bash
python3 skills/qdrant-mcp/scripts/qdrant.py search "customer complaint about billing" --limit 10
```

### List Available Tools

```bash
python3 skills/qdrant-mcp/scripts/qdrant.py list-tools
```

### Call a Specific Tool

```bash
python3 skills/qdrant-mcp/scripts/qdrant.py call qdrant-find --args '{"collection_name":"knowledge_base_v2","query":"search text","limit":5}'
```

## Configuration

- **MCP Server**: `http://gw80os8k0kcgc488o0gw0so8.5.161.117.36.sslip.io/sse`
- **Transport**: SSE (Server-Sent Events) via MCP Python SDK
- **Default Collection**: `knowledge_base_v2`

## When to Use Qdrant

- Questions about past conversations
- Finding similar customer issues
- Searching documentation or help articles
- Contextual/semantic search (not exact keyword matching)
