#!/usr/bin/env python3
"""
Eazybe Team API Client - Fetch team members for name-to-user_id mapping.
This enables comparing people by name using BigQuery user_ids.
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.error
import ssl

# Eazybe Team API
EAZYBE_TEAM_API = "https://eazybe.com/api/v1/whatzapp/allteamdeails"


def fetch_team_members(org_id: str) -> list:
    """
    Fetch team members from Eazybe API.

    Args:
        org_id: Organization ID (workspace_id or org_id)

    Returns:
        List of team members with user_id, name, mobile, email
    """
    team_members = []

    try:
        url = f"{EAZYBE_TEAM_API}?user_id={org_id}"

        req = urllib.request.Request(url, method='GET')
        ctx = ssl.create_default_context()

        with urllib.request.urlopen(req, timeout=30, context=ctx) as response:
            data = json.loads(response.read().decode('utf-8'))

            if data.get("type") and data.get("data"):
                for member in data["data"]:
                    # Extract from whatzapp_basic_info
                    basic_info = member.get("whatzapp_basic_info", {})
                    if basic_info:
                        user_id = str(basic_info.get("id", ""))
                        name = basic_info.get("name", "")

                        if name and user_id and user_id != "0":
                            team_members.append({
                                "user_id": user_id,
                                "name": name,
                                "mobile": str(basic_info.get("mobile", "") or basic_info.get("callyzer_mobile", "")),
                                "email": basic_info.get("email", ""),
                                "org_id": str(member.get("org_id", "")),
                                "role": member.get("callyzer_user_role", {}).get("role_name", "") if member.get("callyzer_user_role") else "",
                                "team_name": member.get("callyzer_orgamnization_team", {}).get("team_name", "") if member.get("callyzer_orgamnization_team") else ""
                            })

        return team_members

    except urllib.error.HTTPError as e:
        print(f"HTTP Error: {e.code} {e.reason}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return []


def find_member_by_name(name: str, team_members: list) -> dict:
    """
    Find team member by name with smart matching.
    Priority: exact match > first name match > partial match > fuzzy match
    """
    name_lower = name.lower().strip()
    search_words = name_lower.split()

    best_match = None
    best_score = 0

    for member in team_members:
        member_name = member.get("name", "").lower()
        member_words = member_name.split()
        score = 0

        # Exact match (highest priority)
        if name_lower == member_name:
            return member

        # First word/name match (e.g., "mohit" matches "Mohit Eazybe")
        if search_words[0] == member_words[0]:
            score += 100
        elif search_words[0] in member_words[0] or member_words[0] in search_words[0]:
            score += 50

        # Check if search term is contained in member name
        if name_lower in member_name:
            score += 30

        # Word overlap scoring
        for search_word in search_words:
            for member_word in member_words:
                if search_word == member_word:
                    score += 20
                elif search_word in member_word:
                    score += 10
                elif member_word in search_word:
                    score += 5

        # Update best match
        if score > best_score:
            best_score = score
            best_match = member

    # Return best match if score is above threshold
    return best_match if best_score >= 10 else None


def main():
    parser = argparse.ArgumentParser(description="Eazybe Team API Client")
    parser.add_argument("--org-id", required=True, help="Organization/Workspace ID")

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # list command - list all team members
    subparsers.add_parser("list", help="List all team members")

    # find command - find member by name
    find_parser = subparsers.add_parser("find", help="Find member by name")
    find_parser.add_argument("name", help="Name to search for")

    args = parser.parse_args()

    if args.command == "list":
        members = fetch_team_members(args.org_id)
        if members:
            print(f"Found {len(members)} team members:\n")
            for m in members:
                print(f"  {m['name']}")
                print(f"    user_id: {m['user_id']}")
                print(f"    mobile: {m.get('mobile', 'N/A')}")
                print(f"    email: {m.get('email', 'N/A')}")
                print(f"    role: {m.get('role', 'N/A')}")
                print()
            # Also output as JSON for programmatic use
            print("\n--- JSON Output ---")
            print(json.dumps(members, indent=2))
        else:
            print("No team members found")

    elif args.command == "find":
        members = fetch_team_members(args.org_id)
        found = find_member_by_name(args.name, members)
        if found:
            print(f"Found: {found['name']}")
            print(f"  user_id: {found['user_id']}")
            print(f"  mobile: {found.get('mobile', 'N/A')}")
            print(f"  email: {found.get('email', 'N/A')}")
            print(json.dumps(found))
        else:
            print(f"No team member found matching '{args.name}'")
            print(f"Available team members: {[m['name'] for m in members]}")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
