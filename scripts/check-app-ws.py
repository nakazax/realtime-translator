"""Deployed-app health check: opens /api/ws through the Databricks Apps proxy
and waits for Azure's session.created, the same handshake the browser makes.

Usage:
  .venv/bin/python scripts/check-app-ws.py --profile <cli-profile> --url https://<app>.databricksapps.com

The session is closed as soon as session.created arrives, so the check costs
seconds of realtime-session time. Exit code 0 means the whole path
(browser -> app -> Azure) works; anything else prints the reason.
"""

import argparse
import asyncio
import json
import subprocess
import sys

import websockets


async def check(profile: str, url: str, timeout: float) -> str:
    token = json.loads(
        subprocess.check_output(["databricks", "auth", "token", "-p", profile])
    )["access_token"]
    ws_url = url.rstrip("/").replace("https://", "wss://", 1) + "/api/ws?target=ja"
    async with websockets.connect(
        ws_url,
        additional_headers={"Authorization": f"Bearer {token}"},
        open_timeout=timeout,
    ) as ws:
        event = json.loads(await asyncio.wait_for(ws.recv(), timeout))
    if event.get("type") != "session.created":
        raise RuntimeError(f"expected session.created, got {json.dumps(event)[:300]}")
    return event["session"]["id"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--profile", required=True, help="Databricks CLI profile")
    parser.add_argument("--url", required=True, help="App URL (https://...)")
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    try:
        session_id = asyncio.run(check(args.profile, args.url, args.timeout))
    except Exception as error:  # report any failure as a single line
        print(f"app WS check failed: {error!r}", file=sys.stderr)
        sys.exit(1)
    print(f"app WS check ok: session.created ({session_id})")


if __name__ == "__main__":
    main()
