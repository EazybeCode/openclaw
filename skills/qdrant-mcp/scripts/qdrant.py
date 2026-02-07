#!/usr/bin/env python3
"""
Qdrant MCP Client - Connect to Qdrant MCP server via SSE transport.
Uses the official MCP Python SDK with Server-Sent Events.
"""

import os
import sys
import json
import argparse
import asyncio

# Qdrant MCP server URL (SSE endpoint)
QDRANT_MCP_URL = os.environ.get(
    "QDRANT_MCP_URL",
    "http://gw80os8k0kcgc488o0gw0so8.5.161.117.36.sslip.io"
)

# Ensure we use /sse endpoint
if not QDRANT_MCP_URL.endswith("/sse"):
    QDRANT_MCP_URL = QDRANT_MCP_URL.rstrip("/") + "/sse"

# Default collection name
DEFAULT_COLLECTION = "knowledge_base_v2"


async def list_tools_async():
    """List available Qdrant tools using MCP SDK SSE."""
    try:
        from mcp import ClientSession
        from mcp.client.sse import sse_client

        async with sse_client(QDRANT_MCP_URL) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools_result = await session.list_tools()

                if tools_result and tools_result.tools:
                    tools = []
                    for tool in tools_result.tools:
                        tool_info = {
                            "name": tool.name,
                            "description": tool.description or ""
                        }
                        if hasattr(tool, 'inputSchema') and tool.inputSchema:
                            if hasattr(tool.inputSchema, 'model_dump'):
                                tool_info["parameters"] = tool.inputSchema.model_dump()
                            elif isinstance(tool.inputSchema, dict):
                                tool_info["parameters"] = tool.inputSchema
                        tools.append(tool_info)
                    return {"tools": tools}
                return {"tools": []}
    except ImportError as e:
        return {"error": f"MCP SDK not installed. Run: pip install mcp. Error: {e}"}
    except Exception as e:
        return {"error": str(e)}


async def call_tool_async(tool_name: str, arguments: dict):
    """Call a Qdrant tool using MCP SDK SSE."""
    try:
        from mcp import ClientSession
        from mcp.client.sse import sse_client

        async with sse_client(QDRANT_MCP_URL) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool_name, arguments)

                # Check for error
                if hasattr(result, 'isError') and result.isError:
                    error_messages = []
                    if hasattr(result, 'content') and result.content:
                        for item in result.content if isinstance(result.content, list) else [result.content]:
                            if hasattr(item, 'text'):
                                error_messages.append(item.text)
                            else:
                                error_messages.append(str(item))
                    return {"error": " | ".join(error_messages) if error_messages else "Unknown error"}

                # Extract content from result
                if hasattr(result, 'content') and result.content:
                    if isinstance(result.content, list):
                        content_list = []
                        for item in result.content:
                            if hasattr(item, 'text'):
                                content_list.append(item.text)
                            elif hasattr(item, 'document'):
                                doc = item.document
                                if hasattr(doc, 'text'):
                                    content_list.append(doc.text)
                                elif isinstance(doc, dict):
                                    content_list.append(doc.get('text', str(doc)))
                                else:
                                    content_list.append(str(doc))
                            elif isinstance(item, dict):
                                if 'text' in item:
                                    content_list.append(item['text'])
                                else:
                                    content_list.append(str(item))
                            else:
                                content_list.append(str(item))
                        return {"content": content_list}
                    else:
                        if hasattr(result.content, 'text'):
                            return {"content": [result.content.text]}
                        else:
                            return {"content": [str(result.content)]}

                return {"result": "Tool executed successfully"}
    except ImportError as e:
        return {"error": f"MCP SDK not installed. Run: pip install mcp. Error: {e}"}
    except Exception as e:
        return {"error": str(e)}


async def search_async(query: str, collection: str = None, limit: int = 5):
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

    # Try qdrant-find tool first
    result = await call_tool_async("qdrant-find", {
        "collection_name": collection,
        "query": query,
        "limit": limit
    })

    # If qdrant-find doesn't work, try search_points
    if "error" in result:
        result = await call_tool_async("search_points", {
            "collection_name": collection,
            "query": query,
            "limit": limit
        })

    return result


def format_result(result: dict) -> str:
    """Format result for output."""
    if "error" in result:
        return f"Error: {result['error']}"

    if "content" in result:
        content = result["content"]
        if isinstance(content, list):
            return "\n".join(str(item) for item in content)
        return str(content)

    if "tools" in result:
        tools = result["tools"]
        output = f"Available Qdrant tools ({len(tools)}):\n"
        for tool in tools:
            output += f"\n  {tool['name']}\n"
            desc = tool.get('description', 'No description')
            if len(desc) > 100:
                desc = desc[:100] + "..."
            output += f"    {desc}\n"
        return output

    return json.dumps(result, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Qdrant MCP Client (SSE)")

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
        result = asyncio.run(list_tools_async())
        print(format_result(result))

    elif args.command == "search":
        result = asyncio.run(search_async(args.query, args.collection, args.limit))
        print(format_result(result))

    elif args.command == "call":
        arguments = {}
        if args.args:
            arguments = json.loads(args.args)
        result = asyncio.run(call_tool_async(args.tool, arguments))
        print(format_result(result))

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
