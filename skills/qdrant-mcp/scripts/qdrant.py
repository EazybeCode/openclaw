#!/usr/bin/env python3
"""
Qdrant MCP Client - Connect to Qdrant MCP server for semantic search.
Uses JSON-RPC 2.0 over HTTP (simplified, no SSE).
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.error
import ssl

# Qdrant MCP server URL (HTTP endpoint, not SSE)
QDRANT_MCP_URL = os.environ.get(
    "QDRANT_MCP_URL",
    "http://gw80os8k0kcgc488o0gw0so8.5.161.117.36.sslip.io"
)

# Default collection name
DEFAULT_COLLECTION = "knowledge_base_v2"


def mcp_request(method: str, params: dict = None, request_id: int = 1):
    """Send JSON-RPC 2.0 request to Qdrant MCP server."""
    # Try /mcp endpoint first (like BigQuery)
    url = f"{QDRANT_MCP_URL}/mcp"

    payload = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params or {}
    }

    data = json.dumps(payload).encode('utf-8')
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json"
    }

    req = urllib.request.Request(url, data=data, headers=headers, method='POST')

    try:
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=60, context=ctx) as response:
            result = json.loads(response.read().decode('utf-8'))
            return result
    except urllib.error.HTTPError as e:
        error_body = ""
        try:
            error_body = e.read().decode('utf-8')
        except:
            pass
        return {"error": {"code": e.code, "message": f"{e.reason}: {error_body}"}}
    except urllib.error.URLError as e:
        return {"error": {"code": -1, "message": str(e.reason)}}
    except Exception as e:
        return {"error": {"code": -1, "message": str(e)}}


def initialize():
    """Initialize MCP connection."""
    return mcp_request("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {
            "name": "openclaw-qdrant",
            "version": "1.0.0"
        }
    })


def list_tools():
    """List available Qdrant tools."""
    # First initialize
    init_result = initialize()
    if "error" in init_result:
        return init_result

    return mcp_request("tools/list", {}, request_id=2)


def call_tool(tool_name: str, arguments: dict):
    """Call a Qdrant tool."""
    return mcp_request("tools/call", {
        "name": tool_name,
        "arguments": arguments
    }, request_id=3)


def search(query: str, collection: str = None, limit: int = 5):
    """
    Semantic search in Qdrant.

    Args:
        query: Search query (natural language)
        collection: Collection name (default: knowledge_base_v2)
        limit: Number of results to return

    Returns:
        Search results
    """
    collection = collection or DEFAULT_COLLECTION

    # Try qdrant-find tool (common name in Qdrant MCP)
    result = call_tool("qdrant-find", {
        "collection_name": collection,
        "query": query,
        "limit": limit
    })

    # If qdrant-find doesn't work, try search_points
    if "error" in result:
        result = call_tool("search_points", {
            "collection_name": collection,
            "query": query,
            "limit": limit
        })

    return result


def format_result(result: dict) -> str:
    """Format result for output."""
    if "error" in result:
        error = result["error"]
        if isinstance(error, dict):
            return f"Error: {error.get('message', error)}"
        return f"Error: {error}"

    if "result" in result:
        data = result["result"]
        if isinstance(data, dict) and "content" in data:
            content = data["content"]
            if isinstance(content, list):
                texts = []
                for item in content:
                    if isinstance(item, dict) and "text" in item:
                        texts.append(item["text"])
                    else:
                        texts.append(str(item))
                return "\n".join(texts)
            return str(content)
        return json.dumps(data, indent=2)

    return json.dumps(result, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Qdrant MCP Client")

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # list-tools command
    subparsers.add_parser("list-tools", help="List available tools")

    # search command
    search_parser = subparsers.add_parser("search", help="Semantic search")
    search_parser.add_argument("query", help="Search query")
    search_parser.add_argument("--collection", default=DEFAULT_COLLECTION, help="Collection name")
    search_parser.add_argument("--limit", type=int, default=5, help="Number of results")

    # call command (generic)
    call_parser = subparsers.add_parser("call", help="Call a tool")
    call_parser.add_argument("tool", help="Tool name")
    call_parser.add_argument("--args", help="JSON arguments")

    args = parser.parse_args()

    if args.command == "list-tools":
        result = list_tools()
        if "result" in result and "tools" in result["result"]:
            tools = result["result"]["tools"]
            print(f"Available Qdrant tools ({len(tools)}):\n")
            for tool in tools:
                print(f"  {tool['name']}")
                desc = tool.get('description', 'No description')
                # Truncate long descriptions
                if len(desc) > 100:
                    desc = desc[:100] + "..."
                print(f"    {desc}")
                print()
        else:
            print(format_result(result))

    elif args.command == "search":
        result = search(args.query, args.collection, args.limit)
        print(format_result(result))

    elif args.command == "call":
        arguments = {}
        if args.args:
            arguments = json.loads(args.args)
        result = call_tool(args.tool, arguments)
        print(format_result(result))

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
