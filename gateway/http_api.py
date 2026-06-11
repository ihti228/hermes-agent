"""
Management HTTP API for the gateway.

This module provides a FastAPI-based HTTP server that exposes the gateway's
management interface including:
- WebSocket for tui_gateway JSON-RPC (/api/ws)
- REST endpoints for status, control, sessions, config, skills, cron, etc.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import time
from typing import Optional

from fastapi import FastAPI, WebSocket, Query, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path

# Import tui_gateway WebSocket handler
from tui_gateway.ws import handle_ws as _handle_ws

# Gateway runner will be injected at startup
_gateway_runner = None
_http_token: Optional[str] = None


def set_gateway_runner(runner) -> None:
    """Inject the gateway runner instance."""
    global _gateway_runner
    _gateway_runner = runner


def set_http_token(token: Optional[str]) -> None:
    """Set the HTTP management API token."""
    global _http_token
    _http_token = token


def get_http_token() -> Optional[str]:
    """Get the HTTP management API token."""
    return _http_token


def get_runner():
    """Get the gateway runner instance."""
    if _gateway_runner is None:
        raise HTTPException(status_code=503, detail="Gateway not initialized")
    return _gateway_runner


# ---- Auth dependency ----
async def verify_token(token: str = Query(...)):
    """Verify the management API token."""
    expected = get_http_token()
    if not expected:
        raise HTTPException(status_code=503, detail="Management API not configured")
    if not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid token")
    return token


# ---- WebSocket auth ----
async def verify_ws_token(ws: WebSocket, token: str = Query(...)) -> bool:
    """Verify WebSocket token."""
    expected = get_http_token()
    if not expected:
        await ws.close(code=4401)
        return False
    if not hmac.compare_digest(token, expected):
        await ws.close(code=4401)
        return False
    return True


# ---- Response models ----
class StatusResponse(BaseModel):
    state: str
    platforms: dict
    pid: int
    uptime_seconds: float


class GatewayControlResponse(BaseModel):
    ok: bool
    message: str = ""


# ---- Create FastAPI app ----
def create_app() -> FastAPI:
    """Create the management API FastAPI application."""
    from hermes_state import SessionDB
    from hermes_cli.config import load_config
    from tools.skills_tool import _find_all_skills
    from hermes_cli.skills_config import get_disabled_skills
    from hermes_constants import get_hermes_home
    from hermes_cli.logs import _read_tail, _parse_since, LOG_FILES, _LEVEL_ORDER
    from hermes_logging import COMPONENT_PREFIXES

    app = FastAPI(
        title="Hermes Gateway Management API",
        version="1.0.0",
        docs_url=None,  # Disable docs in production
        redoc_url=None,
    )

    # CORS for local desktop (file:// origin)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---- WebSocket endpoint (tui_gateway) ----
    @app.websocket("/api/ws")
    async def ws_endpoint(ws: WebSocket, token: str = Query(...)):
        if not await verify_ws_token(ws, token):
            return
        try:
            await _handle_ws(ws)
        except Exception as e:
            # Log but don't crash
            import logging
            logging.getLogger(__name__).error(f"WS error: {e}")

    # ---- Health/Status ----
    @app.get("/api/status")
    async def status(token: str = Depends(verify_token)):
        runner = get_runner()
        return StatusResponse(
            state=runner.state,
            platforms={
                p.value: getattr(a, "status", "unknown")
                for p, a in runner.adapters.items()
            },
            pid=os.getpid(),
            uptime_seconds=time.time() - runner.start_time,
        )

    # ---- Gateway control ----
    @app.post("/api/gateway/restart")
    async def gateway_restart(token: str = Depends(verify_token)):
        runner = get_runner()
        runner.request_restart(via_service=True)
        return GatewayControlResponse(ok=True, message="Restart initiated")

    @app.post("/api/gateway/stop")
    async def gateway_stop(token: str = Depends(verify_token)):
        runner = get_runner()
        import asyncio
        asyncio.create_task(runner.stop())
        return GatewayControlResponse(ok=True, message="Stop initiated")

    # ---- Session endpoints (Phase 2) ----
    @app.get("/api/sessions")
    async def get_sessions(
        limit: int = 20,
        offset: int = 0,
        min_messages: int = 0,
        archived: str = "exclude",
        order: str = "created",
    ):
        """List sessions."""
        if archived not in ("exclude", "only", "include"):
            raise HTTPException(
                status_code=400,
                detail="archived must be one of: exclude, only, include",
            )
        if order not in ("created", "recent"):
            raise HTTPException(
                status_code=400,
                detail="order must be one of: created, recent",
            )
        runner = get_runner()
        try:
            db = SessionDB()
            try:
                min_message_count = max(0, min_messages)
                archived_only = archived == "only"
                include_archived = archived == "include"
                sessions = db.list_sessions_rich(
                    limit=limit,
                    offset=offset,
                    min_message_count=min_message_count,
                    include_archived=include_archived,
                    archived_only=archived_only,
                    order_by_last_active=order == "recent",
                )
                total = db.session_count(
                    min_message_count=min_message_count,
                    include_archived=include_archived,
                    archived_only=archived_only,
                    exclude_children=True,
                )
                now = time.time()
                for s in sessions:
                    s["is_active"] = (
                        s.get("ended_at") is None
                        and (now - s.get("last_active", s.get("started_at", 0))) < 300
                    )
                    s["archived"] = bool(s.get("archived"))
                return {"sessions": sessions, "total": total, "limit": limit, "offset": offset}
            finally:
                db.close()
        except Exception:
            raise HTTPException(status_code=500, detail="Internal server error")

    @app.get("/api/sessions/{session_id}")
    async def get_session_detail(session_id: str):
        """Get a session by ID."""
        db = SessionDB()
        try:
            sid = db.resolve_session_id(session_id)
            session = db.get_session(sid) if sid else None
            if not session:
                raise HTTPException(status_code=404, detail="Session not found")
            return session
        finally:
            db.close()

    @app.get("/api/sessions/{session_id}/messages")
    async def get_session_messages(session_id: str):
        """Get messages for a session."""
        db = SessionDB()
        try:
            sid = db.resolve_session_id(session_id)
            if not sid:
                raise HTTPException(status_code=404, detail="Session not found")
            sid = db.resolve_resume_session_id(sid)
            messages = db.get_messages(sid)
            return {"session_id": sid, "messages": messages}
        finally:
            db.close()

    @app.delete("/api/sessions/{session_id}")
    async def delete_session_endpoint(session_id: str):
        """Delete a session."""
        db = SessionDB()
        try:
            if not db.delete_session(session_id):
                raise HTTPException(status_code=404, detail="Session not found")
            return {"ok": True}
        finally:
            db.close()

    # ---- Model endpoints ----
    @app.get("/api/model/info")
    async def get_model_info(token: str = Depends(verify_token)):
        """Get current model info."""
        from hermes_cli.config import load_config
        cfg = load_config()
        model = cfg.get("model", {})
        return {
            "provider": model.get("provider"),
            "model": model.get("model"),
            "base_url": model.get("base_url"),
            "context_length": model.get("context_length"),
        }

    # ---- Config endpoints ----
    @app.get("/api/config")
    async def get_config(token: str = Depends(verify_token)):
        """Get full config."""
        from hermes_cli.config import load_config
        return load_config()

    # ---- Skills endpoints ----
    @app.get("/api/skills")
    async def get_skills(token: str = Depends(verify_token)):
        """Get all skills."""
        from tools.skills_tool import _find_all_skills
        from hermes_cli.skills_config import get_disabled_skills
        from hermes_cli.config import load_config
        config = load_config()
        disabled = get_disabled_skills(config)
        skills = _find_all_skills(skip_disabled=True)
        for s in skills:
            s["enabled"] = s["name"] not in disabled
        return skills

    @app.put("/api/skills/toggle")
    async def toggle_skill(name: str, enabled: bool, token: str = Depends(verify_token)):
        """Enable/disable a skill."""
        from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills
        from hermes_cli.config import load_config
        config = load_config()
        disabled = get_disabled_skills(config)
        if enabled:
            disabled.discard(name)
        else:
            disabled.add(name)
        save_disabled_skills(config, disabled)
        return {"ok": True, "name": name, "enabled": enabled}

    # ---- Cron endpoints ----
    @app.get("/api/cron/jobs")
    async def get_cron_jobs(token: str = Depends(verify_token)):
        """List cron jobs."""
        runner = get_runner()
        return runner.cron_scheduler.list_jobs()

    # ---- Logs endpoint ----
    @app.get("/api/logs")
    async def get_logs(
        log_name: str = "agent",
        num_lines: int = 100,
        level: Optional[str] = None,
        since: Optional[str] = None,
        component: Optional[str] = None,
        token: str = Depends(verify_token),
    ):
        """Get logs."""
        from hermes_constants import get_hermes_home
        log_dir = get_hermes_home() / "logs"
        log_path = log_dir / f"{log_name}.log"
        if not log_path.exists():
            return {"lines": []}
        try:
            from hermes_cli.logs import _read_tail, _parse_since, LOG_FILES, _LEVEL_ORDER
            from hermes_logging import COMPONENT_PREFIXES
            
            filename = LOG_FILES.get(log_name)
            if filename is None:
                return {"lines": []}
            
            actual_path = log_dir / filename
            if not actual_path.exists():
                return {"lines": []}
            
            since_dt = None
            if since:
                since_dt = _parse_since(since)
            
            min_level = level.upper() if level else None
            if min_level and min_level not in _LEVEL_ORDER:
                min_level = None
            
            component_prefixes = None
            if component:
                component_lower = component.lower()
                if component_lower in COMPONENT_PREFIXES:
                    component_prefixes = COMPONENT_PREFIXES[component_lower]
            
            lines = _read_tail(
                actual_path, num_lines, has_filters=bool(min_level or since_dt or component_prefixes),
                min_level=min_level, session_filter=None,
                since=since_dt, component_prefixes=component_prefixes
            )
            return {"lines": lines}
        except Exception:
            # Fallback simple tail
            if not log_path.exists():
                return {"lines": []}
            lines_list = log_path.read_text().splitlines()[-num_lines:]
            return {"lines": lines_list}

    return app


# ---- Run server ----
async def run_http_server(
    runner,
    host: str = "127.0.0.1",
    port: int = 0,
    token: Optional[str] = None,
) -> tuple:
    """
    Start the HTTP management server.

    Returns (server, actual_port) tuple.
    """
    import uvicorn

    set_gateway_runner(runner)
    set_http_token(token)

    app = create_app()

    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level="warning",
        ws_ping_interval=20.0,
        ws_ping_timeout=20.0,
    )
    server = uvicorn.Server(config)

    # Start server in background
    http_task = asyncio.create_task(server.serve())

    # Wait for server to start and get actual port
    # Give it a moment to bind
    await asyncio.sleep(0.1)
    # Try to get the port - uvicorn might expose it differently
    actual_port = port
    if server.servers:
        try:
            actual_port = server.servers[0].sockets[0].getsockname()[1]
        except Exception:
            pass

    return server, actual_port