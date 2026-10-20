from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional


@dataclass
class UsageReport:
    provider: str
    used: int
    limit: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class UsageProvider(ABC):
    """Abstract plugin interface for AI token usage providers."""

    @abstractmethod
    async def get_usage(self) -> Dict[str, Any]:
        """
        Returns token usage metrics in standard format:
        {'provider': str, 'used': int, 'limit': Optional[int]}
        """
        pass
