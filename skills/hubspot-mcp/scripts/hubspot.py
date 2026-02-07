#!/usr/bin/env python3
"""
HubSpot MCP Client - Connect to HubSpot MCP server via JSON-RPC 2.0
Fetches access tokens from MongoDB using org_id and workspace_id.
Includes automatic token refresh when expired.
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.error
import ssl
from datetime import datetime, timedelta

# HubSpot MCP server URL
HUBSPOT_MCP_URL = "https://mcp.hubspot.com/"

# MongoDB Configuration
MONGODB_URL = os.environ.get(
    "MONGODB_URL",
    "mongodb+srv://akshayvats:bfXzOD0hUH12wg9rxi4l@mongodb-99e99061-o95a30e35.database.cloud.ovh.us/admin?replicaSet=replicaset&tls=true"
)
MONGODB_DATABASE = "eazybe-ai"
MONGODB_COLLECTION = "Users_hubspot_mcp_tokens"


def is_token_expired(doc: dict) -> bool:
    """
    Check if token is expired or about to expire (within 5 minutes).
    """
    try:
        # Check expires_at field first
        if "expires_at" in doc and doc["expires_at"]:
            try:
                expires_at_str = str(doc["expires_at"]).replace('Z', '+00:00')
                expires_at = datetime.fromisoformat(expires_at_str)
                # Make naive if needed for comparison
                if expires_at.tzinfo:
                    now = datetime.now(expires_at.tzinfo)
                else:
                    now = datetime.now()
                # Expired if within 5 minutes
                return now >= (expires_at - timedelta(minutes=5))
            except Exception as e:
                print(f"Warning: Could not parse expires_at: {e}", file=sys.stderr)

        # Fallback: check updated_at + expires_in
        if "updated_at" in doc and "expires_in" in doc:
            try:
                updated_str = str(doc["updated_at"]).replace('Z', '+00:00')
                updated = datetime.fromisoformat(updated_str)
                expires_in = int(doc.get("expires_in", 1800))
                expires_at = updated + timedelta(seconds=expires_in)

                if expires_at.tzinfo:
                    now = datetime.now(expires_at.tzinfo)
                else:
                    now = datetime.now()
                return now >= (expires_at - timedelta(minutes=5))
            except Exception as e:
                print(f"Warning: Could not calculate expiration: {e}", file=sys.stderr)

        # If we can't determine, assume expired (safer to refresh)
        return True
    except Exception as e:
        print(f"Error checking token expiration: {e}", file=sys.stderr)
        return True


def refresh_hubspot_token(doc: dict, collection) -> str:
    """
    Refresh HubSpot access token using refresh_token.

    Args:
        doc: MongoDB document with token info
        collection: MongoDB collection to update

    Returns:
        New access token or None if refresh failed
    """
    refresh_token = doc.get("refresh_token")
    if not refresh_token:
        print("Error: No refresh_token available in MongoDB document", file=sys.stderr)
        return None

    # Get client credentials from document or environment
    client_id = doc.get("client_id") or os.environ.get("HUBSPOT_CLIENT_ID")
    client_secret = doc.get("client_secret") or os.environ.get("HUBSPOT_CLIENT_SECRET")

    if not client_id or not client_secret:
        print("Error: HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET required for token refresh", file=sys.stderr)
        print("  Set these in environment or store in MongoDB document", file=sys.stderr)
        return None

    # Call HubSpot OAuth endpoint to refresh token
    try:
        data = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret
        }).encode('utf-8')

        req = urllib.request.Request(
            "https://api.hubapi.com/oauth/v1/token",
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method='POST'
        )

        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=30, context=ctx) as response:
            result = json.loads(response.read().decode('utf-8'))

            new_access_token = result.get("access_token")
            new_refresh_token = result.get("refresh_token", refresh_token)
            expires_in = result.get("expires_in", 1800)
            expires_at = (datetime.now() + timedelta(seconds=expires_in)).isoformat()

            # Update MongoDB with new tokens
            update_data = {
                "access_token": new_access_token,
                "refresh_token": new_refresh_token,
                "expires_in": expires_in,
                "expires_at": expires_at,
                "updated_at": datetime.now().isoformat()
            }

            collection.update_one(
                {"_id": doc["_id"]},
                {"$set": update_data}
            )

            print(f"Token refreshed successfully, expires in {expires_in}s", file=sys.stderr)
            return new_access_token

    except urllib.error.HTTPError as e:
        error_body = ""
        try:
            error_body = e.read().decode('utf-8')
        except:
            pass
        print(f"Error refreshing token: {e.code} {e.reason}: {error_body}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Error refreshing token: {e}", file=sys.stderr)
        return None


def get_token_from_mongodb(org_id: str, workspace_id: str = None) -> str:
    """
    Fetch HubSpot access token from MongoDB.
    Automatically refreshes if expired.

    Args:
        org_id: Organization ID (primary identifier)
        workspace_id: Optional workspace ID for filtering

    Returns:
        Access token string or None
    """
    try:
        from pymongo import MongoClient
        import urllib.parse  # For urlencode in refresh

        client = MongoClient(MONGODB_URL, serverSelectionTimeoutMS=10000)
        db = client[MONGODB_DATABASE]
        collection = db[MONGODB_COLLECTION]

        # Build query - org_id is primary identifier
        query = {"org_id": org_id}
        if workspace_id:
            query["workspace_id"] = workspace_id

        doc = collection.find_one(query)

        # If not found with workspace_id, try without it
        if not doc and workspace_id:
            doc = collection.find_one({"org_id": org_id})

        if not doc:
            client.close()
            return None

        access_token = doc.get("access_token")

        # Check if token is expired and needs refresh
        if is_token_expired(doc):
            print(f"Token expired for org_id={org_id}, attempting refresh...", file=sys.stderr)
            new_token = refresh_hubspot_token(doc, collection)
            if new_token:
                access_token = new_token
            else:
                print("Warning: Token refresh failed, using expired token", file=sys.stderr)

        client.close()
        return access_token

    except ImportError:
        print("Error: pymongo not installed. Install with: pip install pymongo", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Error fetching token from MongoDB: {e}", file=sys.stderr)
        return None


def get_access_token(org_id: str = None, workspace_id: str = None) -> str:
    """
    Get HubSpot access token.

    Priority:
    1. MongoDB lookup using org_id and workspace_id (with auto-refresh)
    2. HUBSPOT_ACCESS_TOKEN environment variable (fallback)

    Args:
        org_id: Organization ID for MongoDB lookup
        workspace_id: Workspace ID for MongoDB lookup

    Returns:
        Access token string
    """
    # Try MongoDB first if org_id provided
    if org_id:
        token = get_token_from_mongodb(org_id, workspace_id)
        if token:
            return token
        print(f"Warning: No token found in MongoDB for org_id={org_id}", file=sys.stderr)

    # Fallback to environment variable
    token = os.environ.get("HUBSPOT_ACCESS_TOKEN")
    if token:
        return token

    print("Error: No HubSpot access token available", file=sys.stderr)
    print("  - No token found in MongoDB (org_id required)", file=sys.stderr)
    print("  - HUBSPOT_ACCESS_TOKEN environment variable not set", file=sys.stderr)
    sys.exit(1)


def mcp_request(method: str, params: dict = None, request_id: int = 1,
                org_id: str = None, workspace_id: str = None):
    """Send JSON-RPC 2.0 request to HubSpot MCP server."""
    access_token = get_access_token(org_id, workspace_id)

    payload = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params or {}
    }

    data = json.dumps(payload).encode('utf-8')
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {access_token}"
    }

    req = urllib.request.Request(HUBSPOT_MCP_URL, data=data, headers=headers, method='POST')

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


def list_tools(org_id: str = None, workspace_id: str = None):
    """List available HubSpot tools."""
    return mcp_request("tools/list", {}, org_id=org_id, workspace_id=workspace_id)


def call_tool(tool_name: str, arguments: dict, org_id: str = None, workspace_id: str = None):
    """Call a HubSpot tool."""
    return mcp_request("tools/call", {
        "name": tool_name,
        "arguments": arguments
    }, request_id=2, org_id=org_id, workspace_id=workspace_id)


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
    parser = argparse.ArgumentParser(description="HubSpot MCP Client")

    # Global arguments for tenant context
    parser.add_argument("--org-id", help="Organization ID for token lookup")
    parser.add_argument("--workspace-id", help="Workspace ID for token lookup")

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # list-tools command
    subparsers.add_parser("list-tools", help="List available tools")

    # call command
    call_parser = subparsers.add_parser("call", help="Call a tool")
    call_parser.add_argument("tool", help="Tool name")
    call_parser.add_argument("--args", help="JSON arguments")
    call_parser.add_argument("--query", help="Search query")
    call_parser.add_argument("--id", help="Object ID")
    call_parser.add_argument("--limit", type=int, help="Result limit")

    args = parser.parse_args()

    # Get tenant context
    org_id = args.org_id
    workspace_id = args.workspace_id

    if args.command == "list-tools":
        result = list_tools(org_id=org_id, workspace_id=workspace_id)
        if "result" in result and "tools" in result["result"]:
            tools = result["result"]["tools"]
            print(f"Available HubSpot tools ({len(tools)}):\n")
            for tool in tools:
                print(f"  {tool['name']}")
                print(f"    {tool.get('description', 'No description')}")
                print()
        else:
            print(format_result(result))

    elif args.command == "call":
        tool_name = args.tool
        arguments = {}

        if args.args:
            arguments = json.loads(args.args)
        else:
            if args.query:
                arguments["query"] = args.query
            if args.id:
                arguments["id"] = args.id
            if args.limit:
                arguments["limit"] = args.limit

        result = call_tool(tool_name, arguments, org_id=org_id, workspace_id=workspace_id)
        print(format_result(result))

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
