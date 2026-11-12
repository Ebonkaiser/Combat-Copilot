"""Owner authentication: passwordless email codes, signed session cookies, CSRF Origin check.

Two modes, decided server-side on every request:
  anonymous -- the default; public SRD rules only, nothing persisted for long.
  owner     -- a visitor who proved control of an allowlisted email address;
               may use private campaigns.

Flow: POST /auth/request-code emails a 6-digit code (always answering 202, so the
owner address cannot be enumerated); POST /auth/verify trades the code for a
signed, HttpOnly session cookie.

Pending codes and rate-limit counters live in process memory. That REQUIRES a
single uvicorn worker (the entrypoint runs exactly one); with more workers each
would keep its own state. Move it to SQLite or Redis before ever raising that.
Sessions are stateless signed tokens: changing SESSION_SECRET signs everyone out.
"""
import hashlib
import hmac
import logging
import math
import os
import secrets
import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass
from typing import Callable, Deque, Dict, FrozenSet, Literal, Mapping, Optional, Tuple
from urllib.parse import urlsplit

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response
from itsdangerous import BadData, URLSafeSerializer
from pydantic import BaseModel, Field
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from email_sender import ConsoleEmailSender, EmailDeliveryError, EmailSender, ResendEmailSender

logger = logging.getLogger("combat_copilot.auth")

Mode = Literal["anonymous", "owner"]

COOKIE_NAME = "cc_session"
SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60
SESSION_SALT = "combat-copilot.owner-session.v1"
CODE_LIFETIME_SECONDS = 10 * 60
CODE_MAX_FAILED_ATTEMPTS = 5
MIN_SECRET_LENGTH = 32

# (max hits, window in seconds)
REQUEST_PER_EMAIL = (3, 15 * 60)
REQUEST_PER_IP = (10, 60 * 60)
VERIFY_PER_IP = (10, 15 * 60)
# Development only: a person click-testing the login several times must not
# lock themselves out. Production always uses the limits above.
DEV_RATE_LIMIT_SCALE = 10

KNOWN_ENVS = ("development", "test", "production")
DEV_ALLOWED_ORIGINS = ("http://localhost:4200",)
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})


def normalize_email(value: str) -> str:
    return value.strip().lower()


def normalize_origin(value: str) -> str:
    return value.strip().rstrip("/").lower()


# ----------------------------------------------------------------------- config

@dataclass(frozen=True)
class AuthConfig:
    env: str = "production"
    owner_emails: FrozenSet[str] = frozenset()
    session_secret: str = ""  # never logged
    allowed_origins: Tuple[str, ...] = ()
    email_provider: str = ""
    email_api_key: str = ""  # never logged
    email_from: str = ""
    disabled_reason: Optional[str] = None  # why owner login is off, if it is

    @property
    def owner_login_enabled(self) -> bool:
        return self.disabled_reason is None

    @property
    def is_development(self) -> bool:
        return self.env == "development"

    @property
    def cookie_secure(self) -> bool:
        # The only place the Secure flag may be dropped (plain-http localhost).
        return not self.is_development

    @property
    def rate_limit_scale(self) -> int:
        return DEV_RATE_LIMIT_SCALE if self.is_development else 1


def _env_name(environ: Mapping[str, str]) -> str:
    name = (environ.get("ENV") or "production").strip().lower()
    if name not in KNOWN_ENVS:
        logger.warning("Unknown ENV value %r; treating it as production.", name)
        return "production"
    return name


def _parse_origins(raw: Optional[str], env: str) -> Tuple[str, ...]:
    if raw is None or not raw.strip():
        return DEV_ALLOWED_ORIGINS if env == "development" else ()
    origins = []
    for part in raw.split(","):
        origin = normalize_origin(part)
        if origin == "*":
            logger.warning("ALLOWED_ORIGINS must list explicit origins; ignoring '*' (wildcard plus cookies is unsafe).")
        elif origin:
            origins.append(origin)
    return tuple(origins)


def cors_origins_from_env(environ: Optional[Mapping[str, str]] = None) -> list[str]:
    """Origins the browser may call this API from across sites. Empty (the production default)
    means same-origin only, which is how nginx serves the app."""
    variables = os.environ if environ is None else environ
    return list(_parse_origins(variables.get("ALLOWED_ORIGINS"), _env_name(variables)))


def load_auth_config(environ: Optional[Mapping[str, str]] = None) -> AuthConfig:
    variables = os.environ if environ is None else environ
    env = _env_name(variables)

    owner_emails = frozenset(
        normalize_email(part) for part in (variables.get("OWNER_EMAILS") or "").split(",") if part.strip()
    )
    secret = variables.get("SESSION_SECRET") or ""
    provider = (variables.get("EMAIL_PROVIDER") or ("console" if env == "development" else "")).strip().lower()
    api_key = variables.get("EMAIL_API_KEY") or ""
    sender_address = variables.get("EMAIL_FROM") or ""

    reason: Optional[str] = None
    if not owner_emails:
        reason = "OWNER_EMAILS is not set"
    elif len(secret.encode("utf-8")) < MIN_SECRET_LENGTH:
        reason = f"SESSION_SECRET must be at least {MIN_SECRET_LENGTH} characters"
    elif provider == "console":
        if env not in ("development", "test"):
            reason = "EMAIL_PROVIDER=console is only allowed when ENV is development or test"
    elif provider == "resend":
        if not api_key or not sender_address:
            reason = "EMAIL_PROVIDER=resend needs EMAIL_API_KEY and EMAIL_FROM"
    else:
        reason = "EMAIL_PROVIDER must be 'resend' (or 'console' in development)"

    return AuthConfig(
        env=env,
        owner_emails=owner_emails,
        session_secret=secret,
        allowed_origins=_parse_origins(variables.get("ALLOWED_ORIGINS"), env),
        email_provider=provider,
        email_api_key=api_key,
        email_from=sender_address,
        disabled_reason=reason,
    )


def build_email_sender(config: AuthConfig) -> Optional[EmailSender]:
    if not config.owner_login_enabled:
        return None
    if config.email_provider == "resend":
        return ResendEmailSender(api_key=config.email_api_key, from_address=config.email_from)
    return ConsoleEmailSender()


# ------------------------------------------------------------------ rate limit

class RateLimited(Exception):
    def __init__(self, retry_after: int):
        super().__init__(f"rate limited; retry in {retry_after}s")
        self.retry_after = retry_after


class SlidingWindowLimiter:
    """In-memory sliding-window counters, bounded in size. Single process only."""

    def __init__(self, clock: Callable[[], float], max_keys: int = 10_000):
        self._clock = clock
        self._max_keys = max_keys
        self._entries: "OrderedDict[str, Tuple[float, Deque[float]]]" = OrderedDict()
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window: float) -> Optional[int]:
        """Counts one attempt. Returns None if allowed, else the seconds until it would be."""
        now = self._clock()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                entry = (window, deque())
                self._entries[key] = entry
            else:
                self._entries.move_to_end(key)
            hits = entry[1]
            while hits and hits[0] <= now - window:
                hits.popleft()
            if len(hits) >= limit:
                return max(1, math.ceil(hits[0] + window - now))
            hits.append(now)
            if len(self._entries) > self._max_keys:
                self._prune(now)
            return None

    def _prune(self, now: float) -> None:
        for key in [k for k, (window, hits) in self._entries.items() if not hits or hits[-1] <= now - window]:
            del self._entries[key]
        while len(self._entries) > self._max_keys:
            self._entries.popitem(last=False)


# --------------------------------------------------------------------- service

@dataclass
class _PendingCode:
    digest: bytes
    expires_at: float
    failed_attempts: int = 0


class AuthService:
    def __init__(
        self,
        config: AuthConfig,
        sender: Optional[EmailSender] = None,
        clock: Callable[[], float] = time.time,
    ):
        self.config = config
        self.sender = sender
        self.clock = clock  # replaceable at runtime so tests can move time
        self._limiter = SlidingWindowLimiter(lambda: self.clock())
        self._pending: Dict[str, _PendingCode] = {}
        self._lock = threading.Lock()
        secret = config.session_secret.encode("utf-8") if config.owner_login_enabled else secrets.token_bytes(32)
        self._code_key = hmac.new(secret, b"combat-copilot.sign-in-code.v1", hashlib.sha256).digest()
        self._missing_digest = secrets.token_bytes(32)
        self._serializer = (
            URLSafeSerializer(config.session_secret, salt=SESSION_SALT) if config.owner_login_enabled else None
        )

    def close(self) -> None:
        close = getattr(self.sender, "close", None)
        if callable(close):
            close()

    def _limit(self, key: str, rule: Tuple[int, int]) -> None:
        retry_after = self._limiter.hit(key, rule[0] * self.config.rate_limit_scale, rule[1])
        if retry_after is not None:
            raise RateLimited(retry_after)

    def _digest(self, email: str, code: str) -> bytes:
        return hmac.new(self._code_key, f"{email}\x00{code}".encode("utf-8"), hashlib.sha256).digest()

    # ---- codes

    def request_code(self, email: str, ip: str) -> Optional[str]:
        """Rate-limits the request, then returns the code to deliver -- or None when the email is not
        allowlisted (or login is off). The caller answers identically either way."""
        self._limit(f"request-ip:{ip}", REQUEST_PER_IP)
        self._limit(f"request-email:{email}", REQUEST_PER_EMAIL)

        # Done for every email, allowlisted or not, so the work (and timing) does not reveal membership.
        code = f"{secrets.randbelow(10**6):06d}"
        digest = self._digest(email, code)

        if not self.config.owner_login_enabled or email not in self.config.owner_emails:
            return None
        with self._lock:
            # Replaces (invalidates) any earlier unused code for this email.
            self._pending[email] = _PendingCode(digest, self.clock() + CODE_LIFETIME_SECONDS)
        return code

    def deliver_code(self, email: str, code: str) -> None:
        """Runs after the response is sent. A failure is logged, never shown to the requester."""
        if self.sender is None:
            logger.error("No email sender is configured; a sign-in code was not delivered.")
            return
        try:
            self.sender.send_code(email, code, CODE_LIFETIME_SECONDS // 60)
        except EmailDeliveryError as exc:
            logger.error("Sign-in code was not delivered: %s", exc)
        except Exception as exc:  # noqa: BLE001 -- never let a provider failure surface to the caller
            logger.error("Sign-in code was not delivered (%s).", exc.__class__.__name__)

    def verify_code(self, email: str, code: str, ip: str) -> Optional[str]:
        """Trades a code for a session token. Returns None for EVERY failure -- unknown email, no or
        expired or used code, wrong code, too many attempts -- so the caller cannot tell them apart."""
        self._limit(f"verify-ip:{ip}", VERIFY_PER_IP)

        candidate = self._digest(email, code.strip())
        matched = False
        with self._lock:
            pending = self._pending.get(email)
            if pending is None:
                hmac.compare_digest(self._missing_digest, candidate)  # keep the work uniform
            elif self.clock() >= pending.expires_at:
                del self._pending[email]
            elif hmac.compare_digest(pending.digest, candidate):
                del self._pending[email]  # single use
                matched = True
            else:
                pending.failed_attempts += 1
                if pending.failed_attempts >= CODE_MAX_FAILED_ATTEMPTS:
                    del self._pending[email]  # the next attempt fails even with the right code
        return self.create_session(email) if matched else None

    # ---- sessions

    def create_session(self, email: str) -> str:
        assert self._serializer is not None
        issued = int(self.clock())
        return self._serializer.dumps({"sub": email, "iat": issued, "exp": issued + SESSION_LIFETIME_SECONDS})

    def verify_session(self, token: Optional[str]) -> Optional[str]:
        """The owner's email for a valid session token, else None (missing, tampered, expired, or the
        address is no longer allowlisted)."""
        if not token or self._serializer is None:
            return None
        try:
            payload = self._serializer.loads(token)
        except BadData:
            return None
        if not isinstance(payload, dict):
            return None
        subject, expires = payload.get("sub"), payload.get("exp")
        if not isinstance(subject, str) or isinstance(expires, bool) or not isinstance(expires, (int, float)):
            return None
        if self.clock() >= expires:
            return None
        if subject not in self.config.owner_emails:
            return None
        return subject


def create_auth_service(environ: Optional[Mapping[str, str]] = None) -> AuthService:
    config = load_auth_config(environ)
    if config.is_development:
        logger.warning("ENV=development: insecure (non-Secure) cookies and the dev sign-in helper are active.")
    if config.owner_login_enabled:
        logger.info("Owner login enabled for %d allowlisted address(es).", len(config.owner_emails))
    elif config.owner_emails:
        logger.warning("Owner login is disabled: %s.", config.disabled_reason)
    else:
        logger.info("Owner login is not configured; the app runs in anonymous mode only.")
    return AuthService(config, sender=build_email_sender(config))


# --------------------------------------------------------- dependencies / routes

def get_auth(request: Request) -> AuthService:
    return request.app.state.auth


def current_owner(request: Request) -> Optional[str]:
    return get_auth(request).verify_session(request.cookies.get(COOKIE_NAME))


def get_mode(request: Request) -> Mode:
    return "owner" if current_owner(request) else "anonymous"


def require_owner(request: Request) -> str:
    """Dependency: the owner's email, or 401."""
    email = current_owner(request)
    if email is None:
        raise HTTPException(status_code=401, detail="Owner sign-in required")
    return email


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


class RequestCodeBody(BaseModel):
    email: str = Field(max_length=254)


class VerifyBody(BaseModel):
    email: str = Field(max_length=254)
    code: str = Field(max_length=32)


router = APIRouter(prefix="/auth", tags=["auth"])


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


@router.post("/request-code", status_code=202)
async def request_code(body: RequestCodeBody, request: Request, background_tasks: BackgroundTasks):
    auth = get_auth(request)
    email = normalize_email(body.email)
    try:
        code = auth.request_code(email, client_ip(request))
    except RateLimited as exc:
        raise HTTPException(status_code=429, detail="Too many requests", headers={"Retry-After": str(exc.retry_after)})
    if code is not None:
        # After the response, so the answer (and its timing) never depends on the allowlist.
        background_tasks.add_task(auth.deliver_code, email, code)
    return JSONResponse(status_code=202, content={"status": "sent_if_allowed"}, headers={"Cache-Control": "no-store"})


@router.post("/verify")
async def verify(body: VerifyBody, request: Request, response: Response):
    auth = get_auth(request)
    email = normalize_email(body.email)
    try:
        token = auth.verify_code(email, body.code, client_ip(request))
    except RateLimited as exc:
        raise HTTPException(status_code=429, detail="Too many attempts", headers={"Retry-After": str(exc.retry_after)})
    if token is None:
        raise HTTPException(status_code=401, detail="Invalid or expired code", headers={"Cache-Control": "no-store"})
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=SESSION_LIFETIME_SECONDS,
        path="/",
        httponly=True,
        secure=auth.config.cookie_secure,
        samesite="strict",
    )
    _no_store(response)
    return {"mode": "owner", "email": email}


@router.get("/me")
async def me(request: Request, response: Response):
    auth = get_auth(request)
    email = current_owner(request)
    _no_store(response)
    result: dict = {
        "mode": "owner" if email else "anonymous",
        "owner_login_enabled": auth.config.owner_login_enabled,
        "dev": auth.config.is_development and isinstance(auth.sender, ConsoleEmailSender),
    }
    if email:
        result["email"] = email
    return result


@router.post("/logout")
async def logout(request: Request, response: Response):
    auth = get_auth(request)
    response.delete_cookie(
        COOKIE_NAME,
        path="/",
        httponly=True,
        secure=auth.config.cookie_secure,
        samesite="strict",
    )
    _no_store(response)
    return {"mode": "anonymous"}


@router.get("/dev/last-code")
async def dev_last_code(email: str, request: Request):
    """Development convenience: the code the console sender "emailed". Answers exactly like an
    unknown route everywhere else -- including to any non-loopback client, so even an ENV set by
    mistake on a public host does not hand out sign-in codes."""
    auth = get_auth(request)
    sender = auth.sender
    host = request.client.host if request.client else ""
    loopback = host in ("127.0.0.1", "::1", "localhost")
    if not (auth.config.is_development and loopback and isinstance(sender, ConsoleEmailSender)):
        raise HTTPException(status_code=404, detail="Not Found")
    code = sender.last_codes.get(normalize_email(email))
    if code is None:
        raise HTTPException(status_code=404, detail="Not Found")
    return {"code": code}


# ------------------------------------------------------------- CSRF: Origin check

def origin_allowed(origin: str, host: Optional[str], allowed_origins: Tuple[str, ...]) -> bool:
    """A browser sets Origin on cross-site and same-site state-changing requests and a page cannot
    forge it. Allowed: an explicitly listed origin, or an origin whose host[:port] is the host the
    request was addressed to (the app and its API share one origin behind nginx)."""
    normalized = normalize_origin(origin)
    if normalized in allowed_origins:
        return True
    if normalized == "null" or not host:
        return False
    parts = urlsplit(normalized)
    return parts.scheme in ("http", "https") and parts.netloc == host.strip().lower()


class OriginCheckMiddleware:
    """Rejects state-changing requests (POST/PUT/DELETE/PATCH) that carry a foreign Origin.

    SameSite=Strict already keeps the cookie off cross-site requests; this is the second layer.
    Requests without an Origin header (curl, server-to-server) are not browsers and pass.
    Pure ASGI on purpose: it must not buffer the SSE damage stream.
    """

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] not in SAFE_METHODS:
            headers = Headers(scope=scope)
            origin = headers.get("origin")
            if origin is not None:
                auth = getattr(scope["app"].state, "auth", None)
                allowed = auth.config.allowed_origins if auth is not None else ()
                if not origin_allowed(origin, headers.get("host"), allowed):
                    response = JSONResponse({"detail": "Cross-origin request rejected"}, status_code=403)
                    await response(scope, receive, send)
                    return
        await self.app(scope, receive, send)
