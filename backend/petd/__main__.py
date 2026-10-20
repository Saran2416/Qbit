import argparse
import asyncio
import sys
from pathlib import Path

from petd.config import load_config
from petd.daemon import PetDaemon


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="petd",
        description="Cross-platform background monitor daemon for desktop-pet robot app",
    )
    parser.add_argument(
        "-c",
        "--config",
        type=Path,
        default=None,
        help="Path to custom config.toml file",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Override log level to DEBUG",
    )

    args = parser.parse_args()

    config = load_config(args.config)
    if args.debug:
        config.log_level = "DEBUG"

    daemon = PetDaemon(config=config)

    try:
        asyncio.run(daemon.run())
    except (KeyboardInterrupt, SystemExit):
        pass
    except Exception as e:
        sys.stderr.write(f"petd runtime error: {e}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
