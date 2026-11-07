"""
The Python CRM API.

PHASE 0 OF THE NODE -> PYTHON MIGRATION, and it serves exactly one module: health. The point is
not the endpoint - it is 89 lines in Node and nobody needed it rewritten. The point is proving
the path everything else will follow: FastAPI deployed beside the Node backend, Caddy routing by
path prefix, Python reading the same MongoDB and verifying the same sessions, and a rollback
that has actually been executed once rather than merely written down.

THE RESPONSES ARE BYTE-IDENTICAL TO NODE'S, deliberately. The React frontend is unchanged and
calls the same `/api/v1/health` it always has; it must not be able to tell which service
answered. That is the contract every later phase inherits, so it is established here where the
payload is four fields and getting it wrong costs nothing.

WHAT THIS SERVICE DELIBERATELY DOES NOT DO: no background jobs, no schedulers, no queue
consumers, no writes of any kind. The Node backend owns all thirteen runners and every write
path, and will keep owning them until individual modules are moved one at a time. Two services
running the same sweep would send a customer the same message twice.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app import cache, db
from app.config import settings

# The same value the Node backend reports. NOT a new name: this is the same API with a different
# implementation behind part of it, and a client that could distinguish them would be a client
# that breaks when the next module moves.
SERVICE_NAME = "wam-backend"

# THE PYTHON ROUTES ARE SPELLED EXACTLY AS THE PUBLIC API IS, and that is not cosmetic.
#
# Caddy's `handle` directive matches a path prefix and forwards it UNCHANGED - it does not strip
# it the way `handle_path` does. So a browser request for /api/v1/health arrives at this service
# still spelled /api/v1/health. Mounting these at a bare /health would 404 the instant Caddy
# started routing here, and the 404 would come from FastAPI rather than from anything that
# looked like a routing problem.
#
# Keeping the service's own paths identical to the public ones also means every later module
# moves by changing one Caddy line, with no per-route rewriting to get wrong.
API_PREFIX = "/api/v1"


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Clients are created lazily on first use rather than opened here, so the service starts and
    # can report an unreachable dependency instead of failing to boot because of one.
    yield
    await db.close()
    await cache.close()


app = FastAPI(
    title="Vistaar CRM API (Python)",
    # No docs in production: this is an internal API behind Caddy, and an auto-generated schema
    # browser is surface nobody asked for.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


@app.get(f"{API_PREFIX}/health")
async def liveness() -> dict:
    """
    Is the process up.

    Deliberately touches no dependency. Liveness answers "should this container be restarted",
    and restarting the API because Redis is down would take down the half that still works.
    Readiness below is where dependencies are reported.
    """
    return {
        "data": {"status": "ok", "service": SERVICE_NAME},
        "meta": {"environment": settings.node_env},
    }


@app.get(f"{API_PREFIX}/health/readiness")
async def readiness() -> JSONResponse:
    """
    Is it safe to send this service traffic.

    503 when it is not, matching the Node backend: a readiness probe that returns 200 while a
    dependency is down is a probe that cannot be used to gate anything.
    """
    mongodb = await db.get_status()
    redis = await cache.get_status()

    ready = bool(mongodb["ready"]) and bool(redis["ready"])

    return JSONResponse(
        status_code=200 if ready else 503,
        content={
            "data": {
                "status": "ready" if ready else "not_ready",
                "service": SERVICE_NAME,
                "dependencies": {"mongodb": mongodb, "redis": redis},
            },
            "meta": {"environment": settings.node_env},
        },
    )
