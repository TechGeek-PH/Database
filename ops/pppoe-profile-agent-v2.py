#!/usr/bin/env python3
from __future__ import annotations

import logging
import os
import signal
import sys
import time
from typing import Any

import requests
import routeros_api

AGENT_VERSION = "2.1.0-profile"
STOP = False


def env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name)
        if value is not None and str(value).strip():
            return str(value).strip()
    return default


SUPABASE_URL = env("SUPABASE_URL").rstrip("/")
SUPABASE_KEY = env("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY")
MIKROTIK_HOST = env("MIKROTIK_HOST", "MIKROTIK_API_HOST", default="10.200.0.2")
MIKROTIK_USER = env("MIKROTIK_USER", "MIKROTIK_USERNAME", "MIKROTIK_API_USER")
MIKROTIK_PASSWORD = env("MIKROTIK_PASSWORD", "MIKROTIK_API_PASSWORD")
MIKROTIK_PORT = int(env("MIKROTIK_PORT", "MIKROTIK_API_PORT", default="8728"))
MIKROTIK_USE_SSL = env("MIKROTIK_USE_SSL", default="false").lower() in {"1", "true", "yes", "on"}
MIKROTIK_SSL_VERIFY = env("MIKROTIK_SSL_VERIFY", default="false").lower() in {"1", "true", "yes", "on"}
POLL_SECONDS = max(0.5, float(env("PPPOE_AGENT_POLL_SECONDS", default="2")))
HTTP_TIMEOUT = max(5.0, float(env("PPPOE_AGENT_HTTP_TIMEOUT", default="20")))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tgph-pppoe-profile-agent")


def validate() -> None:
    missing = []
    if not SUPABASE_URL:
        missing.append("SUPABASE_URL")
    if not SUPABASE_KEY:
        missing.append("SUPABASE_SERVICE_ROLE_KEY")
    if not MIKROTIK_USER:
        missing.append("MIKROTIK_USER/MIKROTIK_API_USER")
    if not MIKROTIK_PASSWORD:
        missing.append("MIKROTIK_PASSWORD/MIKROTIK_API_PASSWORD")
    if missing:
        raise RuntimeError("Missing environment: " + ", ".join(missing))


def rpc(name: str, body: dict[str, Any]) -> Any:
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/rpc/{name}",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"TechGeekPH-PPPoE-Profile-Agent/{AGENT_VERSION}",
        },
        json=body,
        timeout=HTTP_TIMEOUT,
    )
    if not r.ok:
        raise RuntimeError(f"Supabase RPC {name} failed ({r.status_code}): {r.text[:500]}")
    return r.json() if r.text.strip() else None


def ros_id(row: dict[str, Any]) -> str:
    return str(row.get("id") or row.get(".id") or "").strip()


def router_pool() -> routeros_api.RouterOsApiPool:
    return routeros_api.RouterOsApiPool(
        MIKROTIK_HOST,
        username=MIKROTIK_USER,
        password=MIKROTIK_PASSWORD,
        port=MIKROTIK_PORT,
        plaintext_login=True,
        use_ssl=MIKROTIK_USE_SSL,
        ssl_verify=MIKROTIK_SSL_VERIFY,
        ssl_verify_hostname=MIKROTIK_SSL_VERIFY,
    )


def claim() -> dict[str, Any] | None:
    out = rpc("tg_agent_claim_pppoe_job_v2", {})
    if not isinstance(out, dict):
        return None
    job = out.get("job")
    return job if isinstance(job, dict) else None


def finish(job_id: int, success: bool, secret_id: str | None, message: str,
           kick_verified: bool | None, kick_message: str | None) -> Any:
    return rpc("tg_agent_finish_pppoe_job_v2", {
        "p_job_id": job_id,
        "p_success": success,
        "p_router_secret_id": secret_id,
        "p_message": message,
        "p_session_kick_verified": kick_verified,
        "p_session_kick_message": kick_message,
        "p_agent_version": AGENT_VERSION,
    })


def process(job: dict[str, Any]) -> None:
    job_id = int(job["id"])
    username = str(job.get("pppoe_username") or "").strip()
    target_profile = str(job.get("profile") or "").strip()
    kick_required = bool(job.get("disconnect_active_session"))
    account = str(job.get("account_no") or "")
    pool = None
    secret_id: str | None = None
    kick_verified: bool | None = None
    kick_message: str | None = None

    if not username or not target_profile:
        finish(job_id, False, None, "Missing PPPoE username or target profile.", False if kick_required else True, None)
        return

    log.info("job=%s account=%s username=%s profile=%s kick=%s", job_id, account, username, target_profile, kick_required)

    try:
        pool = router_pool()
        api = pool.get_api()
        secrets = api.get_resource("/ppp/secret")
        active = api.get_resource("/ppp/active")

        secret_rows = list(secrets.get(name=username) or [])
        if not secret_rows:
            raise RuntimeError(f"PPP secret not found for {username}")
        secret_id = ros_id(secret_rows[0])
        if not secret_id:
            raise RuntimeError(f"PPP secret id missing for {username}")

        # PROFILE mode only: preserve password, addresses, service, disabled state and comments.
        secrets.set(id=secret_id, profile=target_profile)
        verify_rows = list(secrets.get(name=username) or [])
        if not verify_rows:
            raise RuntimeError(f"PPP secret disappeared during verification for {username}")
        live_profile = str(verify_rows[0].get("profile") or "").strip()
        if live_profile.lower() != target_profile.lower():
            raise RuntimeError(f"Profile verify failed: expected {target_profile}, got {live_profile or 'blank'}")

        if kick_required:
            before = list(active.get(name=username) or [])
            old_ids = {ros_id(row) for row in before if ros_id(row)}
            if before:
                for row in before:
                    item_id = ros_id(row)
                    if not item_id:
                        continue
                    active.remove(id=item_id)
                time.sleep(1.25)
                after = list(active.get(name=username) or [])
                new_ids = {ros_id(row) for row in after if ros_id(row)}
                still = sorted(old_ids & new_ids)
                if still:
                    kick_verified = False
                    kick_message = "Old active PPP session id(s) still present: " + ", ".join(still)
                    raise RuntimeError(kick_message)
                kick_verified = True
                if after:
                    uptimes = ", ".join(str(row.get("uptime") or "?") for row in after)
                    kick_message = f"Removed {len(old_ids)} old active session(s); client reconnected with new session uptime {uptimes}."
                else:
                    kick_message = f"Removed {len(old_ids)} old active session(s); client is currently offline after kick."
            else:
                kick_verified = True
                kick_message = "No active PPP session existed; nothing to remove."
        else:
            kick_verified = True
            kick_message = "Session kick not required."

        msg = f"PPP secret profile verified on {MIKROTIK_HOST}: {live_profile}. {kick_message}"
        result = finish(job_id, True, secret_id, msg, kick_verified, kick_message)
        log.info("job=%s completed %s", job_id, result)
    except Exception as exc:
        msg = f"{type(exc).__name__}: {exc}"
        log.exception("job=%s failed", job_id)
        try:
            finish(job_id, False, secret_id, msg, kick_verified, kick_message)
        except Exception:
            log.exception("job=%s could not report failure", job_id)
    finally:
        if pool is not None:
            try:
                pool.disconnect()
            except Exception:
                pass


def stop_handler(signum: int, _frame: Any) -> None:
    global STOP
    log.info("signal %s received", signum)
    STOP = True


def main() -> int:
    validate()
    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)
    log.info("TechGeekPH PPPoE Profile Agent %s starting; router=%s:%s", AGENT_VERSION, MIKROTIK_HOST, MIKROTIK_PORT)
    while not STOP:
        try:
            job = claim()
            if job:
                process(job)
                continue
        except Exception:
            log.exception("poll failed")
        time.sleep(POLL_SECONDS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
