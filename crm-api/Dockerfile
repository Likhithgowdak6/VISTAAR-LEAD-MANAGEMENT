# Mirrors ai-brain-service/Dockerfile deliberately: same base image, same layout, same uvicorn
# invocation. Two Python services on one box that are built and run differently is two things to
# learn instead of one.
#
# No libreoffice here - that image needs it for docx->pdf rendering and this one does not.
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

# BINDS LOOPBACK, NOT 0.0.0.0, and the two are only equivalent in a bridged container.
#
# This service runs with `network_mode: host` so that MONGODB_URI and REDIS_URL - written for
# the Node backend, which runs on the host under systemd and addresses localhost:27017 and
# localhost:6379 - mean the same thing here. That is what lets both backends share one set of
# connection strings with nothing duplicated and nothing to keep in sync.
#
# The consequence is that there is no Docker port mapping to confine this: the container shares
# the host's network namespace, so `--host 0.0.0.0` would publish the API on every interface
# the machine has. Binding 127.0.0.1 is what keeps it reachable only by Caddy, and it is the
# direct replacement for the `127.0.0.1:5002:5002` mapping a bridged service would have used.
#
# If `network_mode: host` is ever removed, this must become 0.0.0.0 or the container will
# accept no connections at all.
EXPOSE 5002
CMD ["uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "5002"]
