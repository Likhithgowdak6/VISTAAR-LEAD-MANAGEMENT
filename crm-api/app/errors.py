"""
Error responses, in the envelope the Node backend uses.

THIS IS NOT COSMETIC, and it was nearly missed. FastAPI's defaults are wrong for this API in
two ways that the React client would notice immediately:

  1. STATUS CODE. FastAPI answers a request-validation failure with 422. Node answers 400 -
     `parseWithSchema` throws `createHttpError({ statusCode: 400, code: 'VALIDATION_FAILED' })`
     for every bad body, query or param. A client branching on 400 would silently stop handling
     validation errors the moment a module moved to Python.

  2. BODY SHAPE. FastAPI returns `{"detail": [...]}`. Node returns
     `{"error": {code, message, details, requestId}}`, and the client reads `error.code` to
     decide what to do - notably whether to attempt a token refresh on a 401.

So both are reshaped here, once, for every route. Mirrors
backend/src/middleware/error.middleware.ts.

`requestId` carries the real id assigned by `request_context.py`, not null. It is what connects
a customer's "it failed" to a line in the server log, and the comparison harness treats a field
that is a string in Node and null here as the difference it is.
"""

import logging
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.config import settings
from app.request_context import get_request_id


def error_body(
    code: str,
    message: str,
    details: Any = None,
    request_id: str | None = None,
) -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "details": details,
            "requestId": request_id,
        }
    }


def _field_errors(exc: RequestValidationError) -> dict[str, list[str]]:
    """
    zod's `error.flatten().fieldErrors`, approximated.

    Node sends `{ "title": ["String must contain at least 1 character(s)"] }` - a map of field
    name to messages. FastAPI gives a list of objects with a `loc` tuple. The shape is matched;
    the exact wording of each message is not, because it comes from a different validation
    library and no client branches on it.
    """
    fields: dict[str, list[str]] = {}

    for error in exc.errors():
        location = [str(part) for part in error.get("loc", ())]

        # ONLY THE FIRST element is the location marker, and only it is dropped.
        #
        # Filtering "body" out of the whole tuple looks equivalent and is not: `starred-messages`
        # has a field literally named `body`, so its loc is ("body", "body") and both parts were
        # being removed. The error then landed under `_` instead of `body`, meaning a client
        # reading `details.body` found nothing for the one field most likely to fail validation.
        if location and location[0] in ("body", "query", "path"):
            location = location[1:]

        key = ".".join(location) or "_"
        fields.setdefault(key, []).append(str(error.get("msg", "Invalid value")))

    return fields


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        # 400, not FastAPI's 422. See the module docstring.
        source = "Body"

        for error in exc.errors():
            first = error.get("loc", ("body",))[0] if error.get("loc") else "body"
            source = {"body": "Body", "query": "Query", "path": "Params"}.get(str(first), "Body")
            break

        return JSONResponse(
            status_code=400,
            content=error_body(
                "VALIDATION_FAILED",
                f"{source} validation failed.",
                _field_errors(exc),
                get_request_id(request),
            ),
        )

    @app.exception_handler(HTTPException)
    async def _http(request: Request, exc: HTTPException) -> JSONResponse:
        # Routes raise HTTPException with the envelope already built (see deps.py and the
        # routers), in which case it is passed through untouched. A bare string detail - from
        # FastAPI itself, or a route that has not been converted - is wrapped so no response
        # can escape in the wrong shape.
        if isinstance(exc.detail, dict) and "error" in exc.detail:
            content = exc.detail
            content["error"].setdefault("details", None)
            # Overwritten, not defaulted: the routers build the envelope without an id because
            # only the handler can see the request.
            content["error"]["requestId"] = get_request_id(request)
        else:
            content = error_body(
                "HTTP_ERROR", str(exc.detail), request_id=get_request_id(request)
            )

        return JSONResponse(status_code=exc.status_code, content=content, headers=exc.headers)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        """
        Anything that escaped, in Node's envelope.

        WITHOUT THIS, Starlette answers an unhandled exception with the plain-text body
        "Internal Server Error" and no JSON at all - so the React client's `error.code` read
        throws while handling the error, and the user sees a blank screen instead of a message.
        Node's handler never does that: every failure, including a 500, carries the envelope.

        THE MESSAGE IS HIDDEN IN PRODUCTION, matching `error.middleware.ts`. A Mongo duplicate-key
        error names the collection and the index; that belongs in the log, not in a response.
        """
        logging.getLogger("crm-api").exception(
            "Request failed: %s %s", request.method, request.url.path
        )

        return JSONResponse(
            status_code=500,
            content=error_body(
                "INTERNAL_SERVER_ERROR",
                "Internal server error."
                if settings.node_env == "production"
                else f"{type(exc).__name__}: {exc}",
                request_id=get_request_id(request),
            ),
        )

    @app.exception_handler(404)
    async def _not_found(request: Request, exc: Any) -> JSONResponse:
        # Matches Node's notFoundHandler, including the method and URL in the message.
        if isinstance(exc, HTTPException) and isinstance(exc.detail, dict) and "error" in exc.detail:
            return JSONResponse(status_code=404, content=exc.detail)

        return JSONResponse(
            status_code=404,
            content=error_body(
                "ROUTE_NOT_FOUND",
                f"Route {request.method} {request.url.path} not found.",
                request_id=get_request_id(request),
            ),
        )
