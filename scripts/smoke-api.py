#!/usr/bin/env python3
"""
Smoke every API route and report anything that answers 5xx.

The bar is deliberately low and that is the point: a 401, a 404 and a 400 are
all *fine*: they mean the handler ran, made a decision and said so. A 500 means
it fell over, and on a route nobody clicks that can sit unnoticed until a
student finds it.

Routes are discovered from the filesystem rather than a hand-kept list, because
a hand-kept list is exactly what goes stale -- the surface has grown from 138
handlers to 152 since the last sweep, and no list was updated to say so.

SAFETY
    GET and HEAD only, unless --include-writes is passed. A smoke test that
    POSTs to production is not a smoke test, it is a data-entry session. Even
    with --include-writes, routes named in SKIP_WRITES are never called.

    Dynamic segments are filled with ids that do not exist, so a handler that
    reaches its database still returns 404 rather than reading someone's notes.

AUTH
    Set SMOKE_COOKIE to a session cookie to run the authenticated pass:

        read -rs SMOKE_COOKIE && export SMOKE_COOKIE
        python3 scripts/smoke-api.py --both

    The value is read from the environment and never printed, not even in the
    failure report.

USAGE
    python3 scripts/smoke-api.py                          # anonymous, production
    python3 scripts/smoke-api.py --both                   # + authenticated
    python3 scripts/smoke-api.py --base http://localhost:3000
    python3 scripts/smoke-api.py --include-writes         # local only, please
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP = REPO / "app"

DEFAULT_BASE = "https://study.busypizza.bond"

SAFE_METHODS = ("GET", "HEAD")
WRITE_METHODS = ("POST", "PUT", "PATCH", "DELETE")

METHOD_RE = re.compile(
    r"^export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b",
    re.MULTILINE,
)

# Endpoints that hold the connection open by design. Opening one and seeing a
# status is the whole check; reading the body would block until the deadline.
STREAMING = {
    "/api/notifications/stream",
    "/api/pages/[id]/stream",
}

# Never called at all, by any method.
#
# GET is not a synonym for "safe". /api/cron/backup is a GET that dumps every
# table it backs up, gzips it, uploads a snapshot and prunes old ones -- and it
# is admin-gated, so an authenticated sweep run by an admin silently performs a
# real backup. The first authenticated run of this script did exactly that
# before this list existed. Anything whose GET has a side effect belongs here.
SKIP_ALWAYS = {
    "/api/cron/backup",
}

# Never called with a write method, even under --include-writes. These either
# cost money, mutate production content, or exist to be triggered on a schedule.
SKIP_WRITES = {
    "/api/cron/backup",
    "/api/admin/upload",
    "/api/admin/users/reset-password",
    "/api/admin/content",
    "/api/upload",
    "/api/practice/ocr",
    "/api/ai/check-answer",
    "/api/ai/hint",
    "/api/ai/rag-chat",
    "/api/ai/study-actions",
    "/api/account/ai-credentials/test",
    "/api/mock-exams/generate",
    "/api/auth/signup",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
}

# Ids chosen to be syntactically plausible and certain not to exist.
SEGMENT_VALUES = {
    "[id]": "999999999",
    "[postId]": "999999999",
    "[...path]": "smoke/does-not-exist.png",
    "[...nextauth]": "session",
}


def ssl_context() -> ssl.SSLContext:
    """
    A verifying context that actually has roots in it.

    Python installed from python.org ships no CA bundle of its own and does not
    read the macOS keychain, so `create_default_context()` can come back with
    an empty store and fail every https call with CERTIFICATE_VERIFY_FAILED --
    which looks exactly like the whole site being down. Fall back to certifi's
    bundle when that happens. Verification stays on either way: a smoke test
    that skips it would pass against anything at all.
    """
    context = ssl.create_default_context()
    if context.cert_store_stats().get("x509_ca", 0) > 0:
        return context
    try:
        import certifi
    except ImportError:
        print(
            "warning: no CA certificates found and certifi is not installed; "
            "https calls will fail. Try `pip install certifi`, or run "
            "/Applications/Python*/Install\\ Certificates.command",
            file=sys.stderr,
        )
        return context
    return ssl.create_default_context(cafile=certifi.where())


SSL_CONTEXT = ssl_context()


@dataclass
class Route:
    url_path: str
    source_path: str
    methods: list[str]


@dataclass
class Result:
    method: str
    path: str
    status: int | None
    ms: int
    note: str = ""

    @property
    def is_server_error(self) -> bool:
        return self.status is not None and 500 <= self.status < 600

    @property
    def is_transport_error(self) -> bool:
        return self.status is None


@dataclass
class Pass:
    label: str
    results: list[Result] = field(default_factory=list)


def discover_routes() -> list[Route]:
    routes: list[Route] = []
    for handler in sorted(APP.rglob("route.ts")):
        rel = handler.relative_to(APP).parent
        segments = []
        for segment in rel.parts:
            # Route groups organise files without appearing in the URL.
            if segment.startswith("(") and segment.endswith(")"):
                continue
            segments.append(segment)
        url_path = "/" + "/".join(segments) if segments else "/"
        source = handler.read_text(encoding="utf-8")
        methods = sorted(set(METHOD_RE.findall(source)))
        if not methods:
            continue
        routes.append(
            Route(
                url_path=url_path,
                source_path=str(handler.relative_to(REPO)),
                methods=methods,
            )
        )
    return routes


def concrete(url_path: str) -> str:
    """Replace dynamic segments with values that resolve to nothing."""
    out = url_path
    for token, value in SEGMENT_VALUES.items():
        out = out.replace(token, value)
    # Any dynamic segment we did not name explicitly still has to be filled.
    out = re.sub(r"\[\.\.\.([^\]]+)\]", "smoke-none", out)
    out = re.sub(r"\[([^\]]+)\]", "999999999", out)
    return out


def request(
    base: str,
    method: str,
    path: str,
    cookie: str | None,
    timeout: float,
    streaming: bool,
) -> Result:
    url = base.rstrip("/") + path
    body = None
    headers = {
        "user-agent": "smoke-api/1.0 (+pre-launch regression sweep)",
        "accept": "application/json, text/plain, */*",
    }
    if method in WRITE_METHODS:
        # An empty JSON object: enough to get past body parsing and into the
        # handler's own validation, which should answer 400, never 500.
        body = b"{}"
        headers["content-type"] = "application/json"
    if cookie:
        headers["cookie"] = cookie

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CONTEXT) as response:
            if not streaming:
                response.read(2048)
            status = response.status
        return Result(method, path, status, int((time.monotonic() - started) * 1000))
    except urllib.error.HTTPError as error:
        # A 4xx is a decision, not a failure. Read and discard so the socket
        # closes cleanly.
        try:
            error.read(2048)
        except Exception:
            pass
        return Result(method, path, error.code, int((time.monotonic() - started) * 1000))
    except urllib.error.URLError as error:
        reason = getattr(error, "reason", error)
        note = "timeout" if isinstance(reason, TimeoutError) else str(reason)
        # A streaming route that holds the connection past the deadline has
        # answered by existing; that is not a fault.
        if streaming and note == "timeout":
            return Result(method, path, 200, int((time.monotonic() - started) * 1000), "stream held open")
        return Result(method, path, None, int((time.monotonic() - started) * 1000), note)
    except TimeoutError:
        if streaming:
            return Result(method, path, 200, int((time.monotonic() - started) * 1000), "stream held open")
        return Result(method, path, None, int((time.monotonic() - started) * 1000), "timeout")


def run_pass(
    label: str,
    routes: list[Route],
    base: str,
    cookie: str | None,
    include_writes: bool,
    timeout: float,
) -> Pass:
    result_pass = Pass(label=label)
    for route in routes:
        if route.url_path in SKIP_ALWAYS:
            print(f"  -- {'SKIP':6} {'':>5}  {'':>6}    {route.url_path}  (side effects)", flush=True)
            continue
        wanted = [m for m in route.methods if m in SAFE_METHODS]
        if include_writes and route.url_path not in SKIP_WRITES:
            wanted += [m for m in route.methods if m in WRITE_METHODS]
        if not wanted:
            continue
        path = concrete(route.url_path)
        is_stream = route.url_path in STREAMING
        for method in wanted:
            outcome = request(base, method, path, cookie, timeout, is_stream)
            result_pass.results.append(outcome)
            marker = "!!" if (outcome.is_server_error or outcome.is_transport_error) else "  "
            status = outcome.status if outcome.status is not None else "ERR"
            print(f" {marker} {method:6} {status:>5}  {outcome.ms:>6}ms  {path}", flush=True)
    return result_pass


def summarise(passes: list[Pass]) -> int:
    print()
    print("=" * 72)
    failures: list[tuple[str, Result]] = []
    for result_pass in passes:
        buckets: dict[str, int] = {}
        for outcome in result_pass.results:
            key = "ERR" if outcome.status is None else f"{outcome.status // 100}xx"
            buckets[key] = buckets.get(key, 0) + 1
            if outcome.is_server_error or outcome.is_transport_error:
                failures.append((result_pass.label, outcome))
        spread = "  ".join(f"{k} {v}" for k, v in sorted(buckets.items()))
        print(f"{result_pass.label:>14}: {len(result_pass.results):>3} calls   {spread}")

    if not failures:
        print("\nNo 5xx and no transport errors. The surface is answering.")
        return 0

    print(f"\n{len(failures)} handler(s) failed:\n")
    for label, outcome in failures:
        status = outcome.status if outcome.status is not None else f"ERR {outcome.note}"
        print(f"  [{label}] {outcome.method} {outcome.path} -> {status}")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("SMOKE_BASE", DEFAULT_BASE))
    parser.add_argument("--both", action="store_true", help="also run an authenticated pass")
    parser.add_argument("--authed-only", action="store_true")
    parser.add_argument("--include-writes", action="store_true")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--json", metavar="FILE", help="write the raw results here")
    args = parser.parse_args()

    routes = discover_routes()
    handlers = sum(len(r.methods) for r in routes)
    print(f"{len(routes)} route files, {handlers} handlers, base {args.base}")
    if args.include_writes:
        print("WRITE METHODS ENABLED - do not point this at production.")
    print()

    cookie = os.environ.get("SMOKE_COOKIE")
    passes: list[Pass] = []

    if not args.authed_only:
        print("--- anonymous ---")
        passes.append(run_pass("anonymous", routes, args.base, None, args.include_writes, args.timeout))

    if args.both or args.authed_only:
        if not cookie:
            print("\nSMOKE_COOKIE is not set, skipping the authenticated pass.", file=sys.stderr)
            print("  read -rs SMOKE_COOKIE && export SMOKE_COOKIE", file=sys.stderr)
        else:
            print("\n--- authenticated ---")
            passes.append(
                run_pass("authenticated", routes, args.base, cookie, args.include_writes, args.timeout)
            )

    if args.json:
        payload = {
            p.label: [
                {"method": r.method, "path": r.path, "status": r.status, "ms": r.ms, "note": r.note}
                for r in p.results
            ]
            for p in passes
        }
        Path(args.json).write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"\nWrote {args.json}")

    return summarise(passes)


if __name__ == "__main__":
    sys.exit(main())
