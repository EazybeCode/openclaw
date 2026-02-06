#!/usr/bin/env python3
"""
BigQuery MCP Client - Connect to BigQuery MCP server via JSON-RPC 2.0
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.error

# Default BigQuery MCP server URL
DEFAULT_MCP_URL = "http://ck8c84oo40gkcwwk4gcokco0.5.161.117.36.sslip.io"

def get_mcp_url():
    """Get BigQuery MCP server URL from environment or default."""
    return os.environ.get("BIGQUERY_MCP_URL", DEFAULT_MCP_URL)

def mcp_request(method: str, params: dict = None, request_id: int = 1):
    """Send JSON-RPC 2.0 request to BigQuery MCP server."""
    url = f"{get_mcp_url()}/mcp"

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
        with urllib.request.urlopen(req, timeout=60) as response:
            result = json.loads(response.read().decode('utf-8'))
            return result
    except urllib.error.HTTPError as e:
        return {"error": {"code": e.code, "message": e.reason}}
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
            "name": "openclaw-bigquery-skill",
            "version": "1.0.0"
        }
    })

def list_tools():
    """List available BigQuery tools."""
    init_result = initialize()
    if "error" in init_result:
        return init_result
    return mcp_request("tools/list", {}, request_id=2)

def call_tool(tool_name: str, arguments: dict):
    """Call a BigQuery tool."""
    init_result = initialize()
    if "error" in init_result:
        return init_result
    return mcp_request("tools/call", {
        "name": tool_name,
        "arguments": arguments
    }, request_id=3)

# Actual tool functions matching BigQuery MCP server
def list_dataset_ids():
    """List available datasets."""
    return call_tool("list_dataset_ids", {})

def list_table_ids(dataset_id: str):
    """List tables in a dataset."""
    return call_tool("list_table_ids", {"dataset": dataset_id})

def get_dataset_info(dataset_id: str):
    """Get dataset metadata."""
    return call_tool("get_dataset_info", {"dataset": dataset_id})

def get_table_info(dataset_id: str, table_id: str):
    """Get table metadata/schema."""
    return call_tool("get_table_info", {"dataset": dataset_id, "table": table_id})

def execute_sql(sql: str):
    """Execute a SQL query."""
    return call_tool("execute_sql", {"sql": sql})

def search_catalog(query: str):
    """Search for tables, views, models, routines or connections."""
    return call_tool("search_catalog", {"query": query})


def analyze_contribution(metric: str, dimensions: list = None):
    """Analyze contribution to metric changes."""
    args = {"metric": metric}
    if dimensions:
        args["dimensions"] = dimensions
    return call_tool("analyze_contribution", args)

def forecast(table: str, time_column: str, value_column: str, periods: int = 30):
    """Forecast time series data."""
    return call_tool("forecast", {
        "table": table,
        "timeColumn": time_column,
        "valueColumn": value_column,
        "periods": periods
    })

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
    parser = argparse.ArgumentParser(description="BigQuery MCP Client")
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # list-tools command
    subparsers.add_parser("list-tools", help="List available tools")

    # datasets command
    subparsers.add_parser("datasets", help="List datasets")

    # tables command
    tables_parser = subparsers.add_parser("tables", help="List tables in dataset")
    tables_parser.add_argument("dataset", help="Dataset ID")

    # schema command
    schema_parser = subparsers.add_parser("schema", help="Get table schema")
    schema_parser.add_argument("dataset", help="Dataset ID")
    schema_parser.add_argument("table", help="Table ID")

    # query command
    query_parser = subparsers.add_parser("query", help="Execute SQL query")
    query_parser.add_argument("sql", help="SQL query")

    # search command
    search_parser = subparsers.add_parser("search", help="Search catalog")
    search_parser.add_argument("query", help="Search query")

    # call command (generic)
    call_parser = subparsers.add_parser("call", help="Call any tool")
    call_parser.add_argument("tool", help="Tool name")
    call_parser.add_argument("--args", help="JSON arguments")
    call_parser.add_argument("--sql", help="SQL for execute_sql")
    call_parser.add_argument("--dataset", help="Dataset ID")
    call_parser.add_argument("--table", help="Table ID")
    call_parser.add_argument("--query", help="Search query")
    call_parser.add_argument("--question", help="Question for insights")

    args = parser.parse_args()

    if args.command == "list-tools":
        result = list_tools()
        if "result" in result and "tools" in result["result"]:
            tools = result["result"]["tools"]
            print(f"Available BigQuery tools ({len(tools)}):\n")
            for tool in tools:
                print(f"  {tool['name']}")
                print(f"    {tool.get('description', 'No description')}")
                print()
        else:
            print(format_result(result))

    elif args.command == "datasets":
        result = list_dataset_ids()
        print(format_result(result))

    elif args.command == "tables":
        result = list_table_ids(args.dataset)
        print(format_result(result))

    elif args.command == "schema":
        result = get_table_info(args.dataset, args.table)
        print(format_result(result))

    elif args.command == "query":
        result = execute_sql(args.sql)
        print(format_result(result))

    elif args.command == "search":
        result = search_catalog(args.query)
        print(format_result(result))

    elif args.command == "call":
        tool_name = args.tool
        arguments = {}

        if args.args:
            arguments = json.loads(args.args)
        else:
            if args.sql:
                arguments["sql"] = args.sql
            if args.dataset:
                arguments["dataset"] = args.dataset
            if args.table:
                arguments["table"] = args.table
            if args.query:
                arguments["query"] = args.query
            if args.question:
                arguments["question"] = args.question

        result = call_tool(tool_name, arguments)
        print(format_result(result))

    else:
        parser.print_help()

if __name__ == "__main__":
    main()
