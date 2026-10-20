#!/usr/bin/env python3
"""
fake_client.py: Test client for verifying the petd monitor daemon WebSocket API.

Connects to ws://127.0.0.1:8765, listens to pushed events in real time,
and issues sample commands (get_stats, set_reminder, set_limit, dismiss).
"""

import argparse
import asyncio
import json
import sys
import time

try:
    import websockets
except ImportError:
    print("Error: websockets library is required. Run 'pip install websockets'.")
    sys.exit(1)


async def listen_events(ws):
    """Continuously listens and prints all incoming events from petd."""
    try:
        async for message in ws:
            try:
                data = json.loads(message)
                msg_type = data.get("type", "unknown")
                payload = data.get("data", {})
                timestamp = time.strftime("%H:%M:%S")

                print(f"\n[EVENT {timestamp}] <{msg_type.upper()}>")
                print(json.dumps(payload, indent=2))
                print("-" * 50)
            except json.JSONDecodeError:
                print(f"[RAW MSG] {message}")
    except websockets.exceptions.ConnectionClosed:
        print("\n[INFO] WebSocket connection closed by server.")


async def demo_commands(ws):
    """Executes a series of automated verification commands."""
    await asyncio.sleep(1.0)

    # 1. Request current stats
    print("\n>>> [DEMO] Requesting initial stats via 'get_stats'...")
    await ws.send(json.dumps({"type": "get_stats"}))
    await asyncio.sleep(1.5)

    # 2. Schedule a reminder for 5 seconds in the future
    print("\n>>> [DEMO] Scheduling a test reminder ('Stretch break!') in 4 seconds...")
    await ws.send(
        json.dumps(
            {
                "type": "set_reminder",
                "data": {"message": "Stretch break! 🧘", "due_in_seconds": 4},
            }
        )
    )
    await asyncio.sleep(1.5)

    # 3. Update the daily limit
    print("\n>>> [DEMO] Setting daily screen time limit to 7200 seconds (2 hours)...")
    await ws.send(
        json.dumps(
            {
                "type": "set_limit",
                "data": {"limit_seconds": 7200},
            }
        )
    )
    await asyncio.sleep(5.0)

    # 4. Request stats again to verify update
    print("\n>>> [DEMO] Requesting updated stats...")
    await ws.send(json.dumps({"type": "get_stats"}))


async def interactive_mode(ws):
    """Interactive prompt for sending commands manually."""
    print("\nInteractive mode active.")
    print("Commands:")
    print("  stats                                 - Get stats")
    print("  remind <seconds> <message>            - Set reminder")
    print("  limit <seconds>                       - Set daily screen-time limit")
    print("  dismiss reminder <id>                 - Dismiss reminder")
    print("  dismiss warning                       - Dismiss screen-time warning")
    print("  quit                                  - Exit")

    loop = asyncio.get_running_loop()
    while True:
        try:
            line = await loop.run_in_executor(None, input, "petd-client> ")
            line = line.strip()
            if not line:
                continue
            if line in ("quit", "exit"):
                break

            parts = line.split(maxsplit=2)
            cmd = parts[0].lower()

            if cmd == "stats":
                await ws.send(json.dumps({"type": "get_stats"}))
            elif cmd == "remind" and len(parts) >= 3:
                sec = float(parts[1])
                msg = parts[2]
                await ws.send(
                    json.dumps(
                        {
                            "type": "set_reminder",
                            "data": {"message": msg, "due_in_seconds": sec},
                        }
                    )
                )
            elif cmd == "limit" and len(parts) >= 2:
                sec = int(parts[1])
                await ws.send(
                    json.dumps(
                        {
                            "type": "set_limit",
                            "data": {"limit_seconds": sec},
                        }
                    )
                )
            elif cmd == "dismiss" and len(parts) >= 2:
                target = parts[1].lower()
                r_id = int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else None
                await ws.send(
                    json.dumps(
                        {
                            "type": "dismiss",
                            "data": {"target": target, "id": r_id},
                        }
                    )
                )
            else:
                print(f"Unknown command syntax: '{line}'")
        except EOFError:
            break
        except Exception as e:
            print(f"Error sending command: {e}")


async def main():
    parser = argparse.ArgumentParser(description="Test fake client for petd daemon")
    parser.add_argument(
        "--url",
        default="ws://127.0.0.1:8765",
        help="WebSocket URL (default: ws://127.0.0.1:8765)",
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Run in interactive command mode",
    )
    parser.add_argument(
        "--listen-only",
        action="store_true",
        help="Only listen to events without executing demo commands",
    )

    args = parser.parse_args()

    print(f"Connecting to petd monitor daemon at {args.url}...")
    try:
        async with websockets.connect(args.url) as ws:
            print("Connected! Listening for pet events...")

            listener_task = asyncio.create_task(listen_events(ws))

            if args.interactive:
                await interactive_mode(ws)
                listener_task.cancel()
            elif args.listen_only:
                await listener_task
            else:
                # Run demo commands and then listen
                await demo_commands(ws)
                print("\nDemo commands completed. Continuing to listen for live events (Ctrl+C to stop)...")
                await listener_task
    except ConnectionRefusedError:
        print(f"Connection failed: Is the petd daemon running at {args.url}?")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nExiting fake client.")


if __name__ == "__main__":
    asyncio.run(main())
