"""Ollama (local) provider profile.

Dedicated provider for local Ollama instances. Distinct from ``custom``
(generic endpoint) and ``ollama-cloud`` (ollama.com hosted).

Key behaviors:
  - Default base_url: http://localhost:11434/v1 (standard Ollama OpenAI-compat)
  - No API key required (local instance)
  - fetch_models: tries /api/tags first (Ollama native, more reliable),
    falls back to /v1/models (OpenAI-compat)
  - ollama_num_ctx → extra_body.options.num_ctx
  - reasoning_config disabled → extra_body.think = False
  - default_max_tokens=65536 (prevents Ollama's num_predict=128 truncation)
"""

from typing import Any

from providers import register_provider
from providers.base import ProviderProfile


class OllamaLocalProfile(ProviderProfile):
    """Ollama local provider — think=false, num_ctx, /api/tags model discovery."""

    def build_api_kwargs_extras(
        self,
        *,
        reasoning_config: dict | None = None,
        ollama_num_ctx: int | None = None,
        **ctx: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        extra_body: dict[str, Any] = {}

        # Ollama context window
        if ollama_num_ctx:
            options = extra_body.get("options", {})
            options["num_ctx"] = ollama_num_ctx
            extra_body["options"] = options

        # Disable thinking when reasoning is turned off
        if reasoning_config and isinstance(reasoning_config, dict):
            _effort = (reasoning_config.get("effort") or "").strip().lower()
            _enabled = reasoning_config.get("enabled", True)
            if _effort == "none" or _enabled is False:
                extra_body["think"] = False

        return extra_body, {}

    def fetch_models(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 8.0,
    ) -> list[str] | None:
        """Fetch models from a local Ollama instance.

        Tries Ollama's native /api/tags endpoint first (returns
        {"models": [{"name": "gemma4:26b"}, ...]}), which is more
        reliable than /v1/models on some Ollama versions.
        Falls back to OpenAI-compat /v1/models.
        """
        import json
        import urllib.request

        effective_base = (base_url or self.base_url).rstrip("/")
        if not effective_base:
            return None

        # Try /api/tags first (Ollama native)
        # base_url is typically http://localhost:11434/v1 — strip /v1 for /api/tags
        tags_url = effective_base
        if tags_url.endswith("/v1"):
            tags_url = tags_url[:-3]
        tags_url = tags_url.rstrip("/") + "/api/tags"

        try:
            req = urllib.request.Request(tags_url, headers={"User-Agent": "hermes-cli"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read())
                models = data.get("models", [])
                names = [m.get("name", "") for m in models if m.get("name")]
                if names:
                    return names
        except Exception:
            pass

        # Fall back to OpenAI-compat /v1/models
        try:
            models_url = effective_base + "/models"
            req = urllib.request.Request(models_url, headers={"User-Agent": "hermes-cli"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read())
                models = data.get("data", [])
                names = [m.get("id", "") for m in models if m.get("id")]
                if names:
                    return names
        except Exception:
            pass

        return None


ollama_local = OllamaLocalProfile(
    name="ollama-local",
    aliases=("ollama_local", "ollama-server"),
    display_name="Ollama (Local)",
    description="Ollama (Local instance, localhost:11434)",
    env_vars=(),  # No API key needed for local
    base_url="http://localhost:11434/v1",
    auth_type="api_key",  # keep api_key type so it auto-injects into picker
    supports_health_check=True,
    default_max_tokens=65536,
)

register_provider(ollama_local)