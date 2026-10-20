import logging
import sys


def setup_logging(level_name: str = "INFO", log_format: str | None = None) -> logging.Logger:
    """Configures structured, informative logging for petd."""
    level = getattr(logging, level_name.upper(), logging.INFO)
    
    if not log_format:
        log_format = "%(asctime)s [%(levelname)s] [%(name)s] %(message)s"

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(log_format, datefmt="%Y-%m-%d %H:%M:%S"))

    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # Avoid adding duplicate handlers if setup_logging is called multiple times
    if not any(isinstance(h, logging.StreamHandler) for h in root_logger.handlers):
        root_logger.addHandler(handler)
    else:
        # Update level of existing handlers
        for h in root_logger.handlers:
            h.setLevel(level)

    logger = logging.getLogger("petd")
    logger.setLevel(level)
    return logger
