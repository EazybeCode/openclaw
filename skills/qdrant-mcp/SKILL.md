---
name: qdrant-mcp
description: "Semantic search on knowledge base. Search chat history, documentation, and customer conversations."
metadata: { "openclaw": { "emoji": "🔍", "requires": { "bins": ["python3"] }, "env": [] } }
---

# Qdrant MCP Skill

Semantic search on the Qdrant knowledge base using vector similarity.

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

- **MCP Server**: `http://gw80os8k0kcgc488o0gw0so8.5.161.117.36.sslip.io`
- **Default Collection**: `knowledge_base_v2`

## When to Use Qdrant

- Questions about past conversations
- Finding similar customer issues
- Searching documentation or help articles
- Contextual/semantic search (not exact keyword matching)
