"""
Settings for the Python CRM API.

READS THE SAME VARIABLES THE NODE BACKEND ALREADY HAS, and deliberately defines no new ones.
`MONGODB_URI`, `REDIS_URL` and `JWT_ACCESS_SECRET` are supplied to this container from the same
place Node reads them, which is the whole basis of coexistence: the two services are different
implementations of one backend, not two systems that happen to share a database. A second set of
credentials would be a second thing to rotate and a second way for them to disagree.

NOTHING HERE IS LOGGED. The secret is a `str` on a settings object and never reaches a log line,
an error message or a health response - see `app/main.py`, which reports whether dependencies are
reachable and nothing about how it reaches them.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # The same connection string Mongoose uses. It must carry `replicaSet=rs0`: the deployment
    # runs mongod with `--replSet rs0` and the Node backend opens transactions against it, so a
    # URI without it would appear to work here - health only reads - and fail much later when
    # the first migrated module needs a transaction. `app/db.py` asserts the topology rather
    # than trusting the string.
    mongodb_uri: str = ""

    redis_url: str = ""

    # Verifies tokens the Node backend signed. Same secret, same algorithm; see app/auth.py.
    jwt_access_secret: str = ""

    # Mirrored only so `meta.environment` matches Node's health response exactly. The React app
    # reads these responses and must not be able to tell which service answered.
    node_env: str = "development"

    # The replica set this database is expected to be part of. Named rather than assumed so the
    # readiness probe can say "connected to the wrong cluster" instead of just "connected".
    expected_replica_set: str = "rs0"


settings = Settings()
