"""
A request id on every request, exactly as the Node backend assigns one.

A PORT OF backend/src/middleware/request-context.middleware.ts.

WHY IT IS NOT OPTIONAL. Node puts `requestId` in every error body and echoes it in an
`x-request-id` response header. Python was returning `null` for the field and no header at all —
documented at the time as "null rather than invented", which was the wrong call twice over:

  - It is how a report gets traced. "The app said it failed, here is the id" is the only thing
    connecting a customer's screenshot to a line in the server log. Half the API answering with
    null would have made that work for some routes and silently not for others, with no way to
    tell which from the outside.
  - It is a visible difference. The response-comparison harness flagged it immediately, and a
    key that is a string in Node and null in Python is a real difference to a strict consumer.

AN INBOUND HEADER WINS, matching Node. A proxy or a client that already assigned an id keeps it,
so one id spans the whole hop rather than each service minting its own.
"""

from uuid import uuid4

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


def get_request_id(request: Request) -> str | None:
    """
    The id for this request, or None if the middleware did not run.

    Read defensively because the error handlers call it, and an error handler that raised while
    building an error response would replace a useful message with an unhelpful one.
    """
    return getattr(request.state, "request_id", None)


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        # `or` rather than a presence check: Node uses `req.get(...) || randomUUID()`, so an
        # empty header is replaced rather than carried through as an empty id.
        request_id = request.headers.get("x-request-id") or str(uuid4())

        request.state.request_id = request_id

        response = await call_next(request)
        response.headers["x-request-id"] = request_id

        return response
