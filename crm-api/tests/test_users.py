"""
User management — the module that decides what every other route is allowed to do.

`permissionOverrides` written here feeds `resolve_user_permissions`, so a defect in this file
does not show up as a broken user screen. It shows up as a staff member who can suddenly see
the owner's settings, or an admin who cannot archive a tag, three modules away.

THE TESTS THAT MATTER ARE THE REFUSALS. The three guards run in a fixed order and each masks
the next if it is moved:

  missing -> 404, super_admin -> 403, self -> 400

Checking self before super-admin lets a super admin disable themselves and lock the seed
account out of its own organisation. Checking existence last leaks whether an id belongs to a
super admin.

Bcrypt runs at cost 4 here. The production cost is 12; a suite that paid for 12 rounds on every
create would take minutes and get run less often.
"""

import time
from datetime import datetime, timezone
from typing import Any

import jwt
import pytest
from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import audit, db
from app.config import settings as config
from app.errors import install_error_handlers
from app.main import API_PREFIX
from app.passwords import verify_password
from app.permissions import SETTINGS_MANAGE, USERS_MANAGE, USERS_READ
from app.request_context import RequestContextMiddleware
from app.routers import users as users_router

ORG = ObjectId()
ACTOR = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()
OTHER_ORG = ObjectId()

VALID_PASSWORD = "correct-horse-battery"


@pytest.fixture(autouse=True)
def cheap_bcrypt(monkeypatch):
    monkeypatch.setattr(config, "bcrypt_rounds", 4)


def build_app() -> FastAPI:
    application = FastAPI()
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    application.include_router(users_router.router, prefix=f"{API_PREFIX}/users")

    return application


def token() -> str:
    return jwt.encode(
        {
            "sub": str(ACTOR),
            "sid": str(SESSION),
            "org": str(ORG),
            "type": "access",
            "exp": int(time.time()) + 900,
        },
        config.jwt_access_secret,
        algorithm="HS256",
    )


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {token()}"}


@pytest.fixture
def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.fixture
def client():
    return TestClient(build_app())


async def seed_auth(database, role: str = "admin") -> None:
    await database.organizations.insert_one({"_id": ORG, "status": "active"})
    await database[users_router.COLLECTION].insert_one(
        {
            "_id": ACTOR,
            "organizationId": ORG,
            "name": "Himanshu",
            "email": "himanshu@example.com",
            "role": role,
            "status": "active",
            "accountAccessMode": "all",
            "accountAccess": [],
        }
    )
    await database.refreshsessions.insert_one(
        {
            "_id": SESSION,
            "userId": ACTOR,
            "organizationId": ORG,
            "familyId": FAMILY,
            "status": "active",
        }
    )


async def seed_user(database, **over: Any) -> dict[str, Any]:
    moment = datetime(2026, 1, 1, tzinfo=timezone.utc)
    document = {
        "_id": ObjectId(),
        "organizationId": ORG,
        "name": "Ananya",
        "email": "ananya@example.com",
        "passwordHash": "$2b$04$" + "x" * 53,
        "role": "staff",
        "permissionOverrides": {"allow": [], "deny": []},
        "accountAccessMode": "selected",
        "accountAccess": [],
        "status": "active",
        "mustChangePassword": False,
        "passwordChangedAt": None,
        "lastLoginAt": None,
        "createdBy": None,
        "updatedBy": None,
        "createdAt": moment,
        "updatedAt": moment,
        **over,
    }
    await database[users_router.COLLECTION].insert_one(document)

    return document


def body(**over: Any) -> dict[str, Any]:
    return {
        "name": "Ananya",
        "email": "ananya@example.com",
        "password": VALID_PASSWORD,
        "accountAccessMode": "selected",
        **over,
    }


class TestTheSerializer:
    @pytest.mark.asyncio
    async def test_NEVER_RETURNS_THE_PASSWORD_HASH(self, client, database):
        # The hash is not a secret in the way a password is, but publishing it hands an attacker
        # an offline target, and there is no reason any client needs it.
        await seed_auth(database)
        user = await seed_user(database)

        response = client.get(f"/api/v1/users/{user['_id']}", headers=auth_headers())

        assert "passwordHash" not in response.text
        assert "$2b$" not in response.text

    @pytest.mark.asyncio
    async def test_NORMALISES_MISSING_PERMISSION_OVERRIDES(self, client, database):
        # A document written before the field existed has no key. A client doing
        # `user.permissionOverrides.allow.length` would throw on it.
        await seed_auth(database)
        user = await seed_user(database)
        await database[users_router.COLLECTION].update_one(
            {"_id": user["_id"]}, {"$unset": {"permissionOverrides": ""}}
        )

        data = client.get(f"/api/v1/users/{user['_id']}", headers=auth_headers()).json()["data"]

        assert data["permissionOverrides"] == {"allow": [], "deny": []}

    @pytest.mark.asyncio
    async def test_emits_exactly_nodes_field_set(self, client, database):
        await seed_auth(database)
        user = await seed_user(database)

        data = client.get(f"/api/v1/users/{user['_id']}", headers=auth_headers()).json()["data"]

        assert set(data) == {
            "id", "organizationId", "name", "email", "role", "permissionOverrides",
            "accountAccessMode", "accountAccess", "status", "mustChangePassword",
            "passwordChangedAt", "lastLoginAt", "createdBy", "updatedBy", "createdAt",
            "updatedAt",
        }


class TestList:
    @pytest.mark.asyncio
    async def test_SHOWS_ONLY_THIS_ORGANIZATIONS_USERS(self, client, database):
        await seed_auth(database)
        await seed_user(database)
        await seed_user(database, organizationId=OTHER_ORG, email="theirs@example.com")

        emails = [
            row["email"]
            for row in client.get("/api/v1/users", headers=auth_headers()).json()["data"]
        ]

        assert "theirs@example.com" not in emails

    @pytest.mark.asyncio
    async def test_sorts_newest_first_and_paginates(self, client, database):
        await seed_auth(database)
        await seed_user(
            database, email="old@example.com", createdAt=datetime(2026, 1, 1, tzinfo=timezone.utc)
        )
        await seed_user(
            database, email="new@example.com", createdAt=datetime(2026, 6, 1, tzinfo=timezone.utc)
        )

        response = client.get("/api/v1/users?limit=1&skip=0", headers=auth_headers())

        assert response.json()["data"][0]["email"] == "new@example.com"
        assert response.json()["meta"] == {"limit": 1, "skip": 0, "count": 1}

    @pytest.mark.asyncio
    async def test_filters_by_role_and_status(self, client, database):
        await seed_auth(database)
        await seed_user(database, role="manager", email="m@example.com")
        await seed_user(database, role="staff", status="disabled", email="s@example.com")

        managers = client.get("/api/v1/users?role=manager", headers=auth_headers()).json()["data"]
        disabled = client.get("/api/v1/users?status=disabled", headers=auth_headers()).json()["data"]

        assert [u["email"] for u in managers] == ["m@example.com"]
        assert [u["email"] for u in disabled] == ["s@example.com"]


class TestCreate:
    @pytest.mark.asyncio
    async def test_creates_and_hashes_the_password(self, client, database):
        await seed_auth(database)

        response = client.post("/api/v1/users", json=body(), headers=auth_headers())

        assert response.status_code == 201
        stored = await database[users_router.COLLECTION].find_one(
            {"email": "ananya@example.com"}
        )
        assert verify_password(VALID_PASSWORD, stored["passwordHash"]) is True

    @pytest.mark.asyncio
    async def test_THE_STORED_HASH_IS_VERIFIABLE_BY_NODE(self, client, database):
        # Node owns /auth/login until Phase 6, so this hash is read by bcryptjs on the very next
        # login. A $2a$ or $2y$ prefix here is a silent lockout with a correct password.
        await seed_auth(database)

        client.post("/api/v1/users", json=body(), headers=auth_headers())

        stored = await database[users_router.COLLECTION].find_one({"email": "ananya@example.com"})

        assert stored["passwordHash"].startswith("$2b$")
        assert len(stored["passwordHash"]) == 60

    @pytest.mark.asyncio
    async def test_lowercases_and_trims_the_email(self, client, database):
        await seed_auth(database)

        client.post(
            "/api/v1/users", json=body(email="  Ananya@Example.COM  "), headers=auth_headers()
        )

        assert await database[users_router.COLLECTION].find_one({"email": "ananya@example.com"})

    @pytest.mark.asyncio
    async def test_refuses_a_duplicate_email_in_the_same_organization(self, client, database):
        await seed_auth(database)
        await seed_user(database)

        response = client.post("/api/v1/users", json=body(), headers=auth_headers())

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "USER_EMAIL_ALREADY_EXISTS"

    @pytest.mark.asyncio
    async def test_THE_SAME_EMAIL_IN_ANOTHER_ORGANIZATION_IS_FINE(self, client, database):
        # Uniqueness is per organisation. Two studios may both employ an ananya@.
        await seed_auth(database)
        await seed_user(database, organizationId=OTHER_ORG)

        assert client.post("/api/v1/users", json=body(), headers=auth_headers()).status_code == 201

    @pytest.mark.asyncio
    async def test_ACCOUNT_ACCESS_IS_FORCED_EMPTY_WHEN_THE_MODE_IS_ALL(self, client, database):
        # A stale list alongside mode=all becomes a restriction the moment someone switches the
        # mode back to selected.
        await seed_auth(database)

        client.post(
            "/api/v1/users",
            json=body(accountAccessMode="all", accountAccess=[str(ObjectId())]),
            headers=auth_headers(),
        )

        stored = await database[users_router.COLLECTION].find_one({"email": "ananya@example.com"})

        assert stored["accountAccess"] == []

    @pytest.mark.asyncio
    async def test_SUPER_ADMIN_CANNOT_BE_CREATED(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/users", json=body(role="super_admin"), headers=auth_headers()
        )

        # Rejected by the schema before the service sees it, so this is 400 VALIDATION_FAILED
        # rather than 403 - the role is not in the assignable enum at all.
        assert response.status_code == 400
        assert await database[users_router.COLLECTION].find_one({"role": "super_admin"}) is None

    @pytest.mark.asyncio
    async def test_REJECTS_AN_UNKNOWN_PERMISSION_AT_WRITE_TIME(self, client, database):
        # resolve_user_permissions IGNORES an unknown entry at read time, which is right for a
        # stale record. Accepting one at write time stores a typo that silently never grants
        # anything while the admin sees it listed as though it works.
        await seed_auth(database)

        response = client.post(
            "/api/v1/users",
            json=body(permissionOverrides={"allow": ["not.a.real.permission"], "deny": []}),
            headers=auth_headers(),
        )

        assert response.status_code == 400
        assert "permissionOverrides.allow" in str(response.json()["error"]["details"])

    @pytest.mark.asyncio
    async def test_accepts_a_known_permission(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/users",
            json=body(permissionOverrides={"allow": [SETTINGS_MANAGE], "deny": []}),
            headers=auth_headers(),
        )

        assert response.status_code == 201
        assert response.json()["data"]["permissionOverrides"]["allow"] == [SETTINGS_MANAGE]

    @pytest.mark.asyncio
    async def test_THE_ROUTE_MINIMUM_IS_TWELVE_NOT_EIGHT(self, client, database):
        # PASSWORD_POLICY.MIN_LENGTH is 8, but the zod schema says min(12) and runs first. So a
        # 10-character password is VALIDATION_FAILED, never PASSWORD_TOO_SHORT.
        await seed_auth(database)

        response = client.post("/api/v1/users", json=body(password="x" * 10), headers=auth_headers())

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "VALIDATION_FAILED"

    @pytest.mark.asyncio
    async def test_A_PASSWORD_WITH_SURROUNDING_WHITESPACE_IS_REFUSED(self, client, database):
        # Reachable, unlike PASSWORD_TOO_SHORT: zod does not trim the password field.
        await seed_auth(database)

        response = client.post(
            "/api/v1/users", json=body(password="  " + VALID_PASSWORD + "  "), headers=auth_headers()
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "PASSWORD_HAS_SURROUNDING_WHITESPACE"

    @pytest.mark.asyncio
    async def test_writes_an_audit_row(self, client, database):
        await seed_auth(database)

        client.post("/api/v1/users", json=body(), headers=auth_headers())

        row = await database[audit.COLLECTION].find_one({})

        assert row["eventType"] == "USER_CREATED"
        assert row["actorId"] == ACTOR
        assert row["reasonCode"] == "user_created"
        assert row["metadata"]["source"] == "user-management"

    @pytest.mark.asyncio
    async def test_THE_AUDIT_ROW_NEVER_CONTAINS_THE_PASSWORD(self, client, database):
        await seed_auth(database)

        client.post("/api/v1/users", json=body(), headers=auth_headers())

        row = await database[audit.COLLECTION].find_one({})

        assert VALID_PASSWORD not in str(row)


class TestTheThreeGuards:
    """The order is the behaviour. Each guard masks the next if it is moved."""

    @pytest.mark.asyncio
    async def test_a_missing_user_is_404(self, client, database):
        await seed_auth(database)

        response = client.patch(
            f"/api/v1/users/{ObjectId()}", json={"name": "New"}, headers=auth_headers()
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "USER_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_A_SUPER_ADMIN_CANNOT_BE_MANAGED(self, client, database):
        await seed_auth(database)
        target = await seed_user(database, role="super_admin")

        response = client.patch(
            f"/api/v1/users/{target['_id']}", json={"name": "New"}, headers=auth_headers()
        )

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "SUPER_ADMIN_CANNOT_BE_MANAGED"

    @pytest.mark.asyncio
    async def test_A_USER_CANNOT_MANAGE_THEMSELVES(self, client, database):
        await seed_auth(database)

        response = client.patch(
            f"/api/v1/users/{ACTOR}", json={"name": "New"}, headers=auth_headers()
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "USER_CANNOT_MANAGE_SELF"

    @pytest.mark.asyncio
    async def test_SUPER_ADMIN_IS_CHECKED_BEFORE_SELF(self, client, database):
        # A super admin acting on their OWN record must get SUPER_ADMIN_CANNOT_BE_MANAGED. If
        # self were checked first they would get USER_CANNOT_MANAGE_SELF - and worse, reordering
        # the other way round would let them disable themselves and lock the seed account out of
        # its own organisation.
        await seed_auth(database, role="super_admin")

        response = client.patch(
            f"/api/v1/users/{ACTOR}/disable", headers=auth_headers()
        )

        assert response.json()["error"]["code"] == "SUPER_ADMIN_CANNOT_BE_MANAGED"

    @pytest.mark.asyncio
    async def test_existence_is_checked_before_super_admin(self, client, database):
        # Otherwise a 403 for an id that does not exist leaks that super admins are a thing and
        # invites probing for them.
        await seed_auth(database)

        assert (
            client.patch(f"/api/v1/users/{ObjectId()}/disable", headers=auth_headers()).json()[
                "error"
            ]["code"]
            == "USER_NOT_FOUND"
        )

    @pytest.mark.asyncio
    async def test_A_USER_IN_ANOTHER_ORGANIZATION_IS_NOT_FOUND(self, client, database):
        await seed_auth(database)
        target = await seed_user(database, organizationId=OTHER_ORG)

        response = client.patch(
            f"/api/v1/users/{target['_id']}", json={"name": "New"}, headers=auth_headers()
        )

        assert response.status_code == 404


class TestUpdate:
    @pytest.mark.asyncio
    async def test_updates_only_the_supplied_fields(self, client, database):
        await seed_auth(database)
        target = await seed_user(database)

        client.patch(
            f"/api/v1/users/{target['_id']}", json={"name": "Renamed"}, headers=auth_headers()
        )

        stored = await database[users_router.COLLECTION].find_one({"_id": target["_id"]})

        assert stored["name"] == "Renamed"
        assert stored["role"] == "staff"
        assert stored["email"] == "ananya@example.com"

    @pytest.mark.asyncio
    async def test_THE_EMAIL_CANNOT_BE_CHANGED(self, client, database):
        # `updateUserBodySchema` has no email field. Allowing it would let an admin move another
        # user's login to an address they control.
        await seed_auth(database)
        target = await seed_user(database)

        client.patch(
            f"/api/v1/users/{target['_id']}",
            json={"name": "Renamed", "email": "attacker@example.com"},
            headers=auth_headers(),
        )

        stored = await database[users_router.COLLECTION].find_one({"_id": target["_id"]})

        assert stored["email"] == "ananya@example.com"

    @pytest.mark.asyncio
    async def test_THE_PASSWORD_CANNOT_BE_CHANGED_HERE(self, client, database):
        await seed_auth(database)
        target = await seed_user(database)
        before = target["passwordHash"]

        client.patch(
            f"/api/v1/users/{target['_id']}",
            json={"name": "Renamed", "passwordHash": "$2b$04$" + "y" * 53},
            headers=auth_headers(),
        )

        stored = await database[users_router.COLLECTION].find_one({"_id": target["_id"]})

        assert stored["passwordHash"] == before

    @pytest.mark.asyncio
    async def test_SUPER_ADMIN_CANNOT_BE_ASSIGNED(self, client, database):
        await seed_auth(database)
        target = await seed_user(database)

        response = client.patch(
            f"/api/v1/users/{target['_id']}", json={"role": "super_admin"}, headers=auth_headers()
        )

        # 400 from the schema - super_admin is not in the assignable enum.
        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_switching_to_mode_all_clears_account_access(self, client, database):
        await seed_auth(database)
        target = await seed_user(database, accountAccess=[ObjectId()])

        client.patch(
            f"/api/v1/users/{target['_id']}",
            json={"accountAccessMode": "all"},
            headers=auth_headers(),
        )

        stored = await database[users_router.COLLECTION].find_one({"_id": target["_id"]})

        assert stored["accountAccess"] == []

    @pytest.mark.asyncio
    async def test_an_empty_patch_is_refused(self, client, database):
        await seed_auth(database)
        target = await seed_user(database)

        assert (
            client.patch(
                f"/api/v1/users/{target['_id']}", json={}, headers=auth_headers()
            ).status_code
            == 400
        )

    @pytest.mark.asyncio
    async def test_THE_AUDIT_ROW_RECORDS_FIELD_NAMES_NOT_VALUES(self, client, database):
        # Recording values is how an audit log grows a copy of the data it audits.
        await seed_auth(database)
        target = await seed_user(database)

        client.patch(
            f"/api/v1/users/{target['_id']}",
            json={"name": "Renamed", "role": "manager"},
            headers=auth_headers(),
        )

        row = await database[audit.COLLECTION].find_one({"eventType": "USER_UPDATED"})

        assert row["metadata"]["updatedFields"] == ["name", "role"]
        assert "Renamed" not in str(row["metadata"])
        assert row["targetUserId"] == target["_id"]


class TestDisableEnableAndReset:
    @pytest.mark.asyncio
    async def test_DISABLING_REVOKES_ACTIVE_SESSIONS(self, client, database):
        # Flipping status without revoking leaves a departed employee working until their access
        # token expires, and nothing in the UI shows it.
        await seed_auth(database)
        target = await seed_user(database)
        await database.refreshsessions.insert_one(
            {"_id": ObjectId(), "userId": target["_id"], "organizationId": ORG, "status": "active"}
        )

        response = client.patch(
            f"/api/v1/users/{target['_id']}/disable", headers=auth_headers()
        )

        assert response.status_code == 200
        assert response.json()["data"]["status"] == "disabled"

        session = await database.refreshsessions.find_one({"userId": target["_id"]})
        assert session["status"] == "revoked"
        assert session["revokeReason"] == "user_disabled"
        assert session["revokedAt"] is not None

    @pytest.mark.asyncio
    async def test_disabling_does_not_touch_another_users_sessions(self, client, database):
        await seed_auth(database)
        target = await seed_user(database)
        bystander = ObjectId()
        await database.refreshsessions.insert_one(
            {"_id": ObjectId(), "userId": bystander, "organizationId": ORG, "status": "active"}
        )

        client.patch(f"/api/v1/users/{target['_id']}/disable", headers=auth_headers())

        assert (await database.refreshsessions.find_one({"userId": bystander}))["status"] == "active"

    @pytest.mark.asyncio
    async def test_ENABLING_DOES_NOT_REVOKE_ANYTHING(self, client, database):
        # There is nothing to revoke, and re-enabling must not log out sessions created since.
        await seed_auth(database)
        target = await seed_user(database, status="disabled")
        await database.refreshsessions.insert_one(
            {"_id": ObjectId(), "userId": target["_id"], "organizationId": ORG, "status": "active"}
        )

        response = client.patch(f"/api/v1/users/{target['_id']}/enable", headers=auth_headers())

        assert response.json()["data"]["status"] == "active"
        assert (await database.refreshsessions.find_one({"userId": target["_id"]}))["status"] == "active"

    @pytest.mark.asyncio
    async def test_RESETTING_A_PASSWORD_REVOKES_SESSIONS(self, client, database):
        # The old sessions must die with the old password.
        await seed_auth(database)
        target = await seed_user(database)
        await database.refreshsessions.insert_one(
            {"_id": ObjectId(), "userId": target["_id"], "organizationId": ORG, "status": "active"}
        )

        response = client.patch(
            f"/api/v1/users/{target['_id']}/reset-password",
            json={"password": VALID_PASSWORD},
            headers=auth_headers(),
        )

        assert response.status_code == 200
        stored = await database[users_router.COLLECTION].find_one({"_id": target["_id"]})
        assert verify_password(VALID_PASSWORD, stored["passwordHash"]) is True
        assert stored["passwordChangedAt"] is not None
        assert stored["mustChangePassword"] is True

        session = await database.refreshsessions.find_one({"userId": target["_id"]})
        assert session["status"] == "revoked"
        assert session["revokeReason"] == "password_reset"

    @pytest.mark.asyncio
    async def test_reset_honours_must_change_password_false(self, client, database):
        await seed_auth(database)
        target = await seed_user(database)

        client.patch(
            f"/api/v1/users/{target['_id']}/reset-password",
            json={"password": VALID_PASSWORD, "mustChangePassword": False},
            headers=auth_headers(),
        )

        stored = await database[users_router.COLLECTION].find_one({"_id": target["_id"]})

        assert stored["mustChangePassword"] is False

    @pytest.mark.asyncio
    async def test_A_REFUSED_RESET_CHANGES_NOTHING(self, client, database):
        await seed_auth(database)
        target = await seed_user(database)
        before = target["passwordHash"]

        response = client.patch(
            f"/api/v1/users/{target['_id']}/reset-password",
            json={"password": "  " + VALID_PASSWORD + "  "},
            headers=auth_headers(),
        )

        assert response.status_code == 400
        stored = await database[users_router.COLLECTION].find_one({"_id": target["_id"]})
        assert stored["passwordHash"] == before
        assert await database[audit.COLLECTION].find_one({}) is None


class _RecordingCollection:
    """Forwards to the real collection, noting whether `session=` was supplied, then strips it."""

    def __init__(self, inner, name, log):
        self._inner = inner
        self._name = name
        self._log = log

    def __getattr__(self, attribute):
        target = getattr(self._inner, attribute)

        if attribute not in {"insert_one", "find_one_and_update", "update_many"}:
            return target

        async def recorded(*args, **kwargs):
            self._log.append((self._name, attribute, "session" in kwargs))
            kwargs.pop("session", None)

            return await target(*args, **kwargs)

        return recorded


class _RecordingDatabase:
    def __init__(self, inner, log):
        self._inner = inner
        self._log = log

    def __getitem__(self, name):
        return _RecordingCollection(self._inner[name], name, self._log)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        return _RecordingCollection(self._inner[name], name, self._log)


class TestTransactionParticipation:
    """
    mongomock implements no transactions, so these assert the thing a PORT gets wrong: that
    every write inside the body is handed the session. Nobody forgets `start_transaction`;
    people forget `session=` on the third write - and that write then silently escapes the
    transaction and is never rolled back, which is invisible until the day the second write
    fails.

    Atomicity itself is a property of the replica set and is verified in production by the
    readiness probe reporting `replicaSet.ok: true`. This file proves PARTICIPATION, and the
    distinction is stated rather than blurred.
    """

    @pytest.fixture
    def recorded(self, database, monkeypatch):
        log: list[tuple[str, str, bool]] = []
        monkeypatch.setattr(db, "get_database", lambda: _RecordingDatabase(database, log))

        return log

    @pytest.mark.asyncio
    async def test_EVERY_WRITE_IN_DISABLE_RECEIVES_THE_SESSION(self, client, database, recorded):
        await seed_auth(database)
        target = await seed_user(database)
        recorded.clear()

        client.patch(f"/api/v1/users/{target['_id']}/disable", headers=auth_headers())

        writes = [(name, op) for name, op, had_session in recorded if had_session]

        assert ("users", "find_one_and_update") in writes
        assert ("refreshsessions", "update_many") in writes
        assert all(had_session for _, _, had_session in recorded), recorded

    @pytest.mark.asyncio
    async def test_every_write_in_reset_password_receives_the_session(
        self, client, database, recorded
    ):
        await seed_auth(database)
        target = await seed_user(database)
        recorded.clear()

        client.patch(
            f"/api/v1/users/{target['_id']}/reset-password",
            json={"password": VALID_PASSWORD},
            headers=auth_headers(),
        )

        assert all(had_session for _, _, had_session in recorded), recorded
        assert ("refreshsessions", "update_many", True) in recorded

    @pytest.mark.asyncio
    async def test_the_create_insert_receives_the_session(self, client, database, recorded):
        await seed_auth(database)
        recorded.clear()

        client.post("/api/v1/users", json=body(), headers=auth_headers())

        assert ("users", "insert_one", True) in recorded


class TestPermissions:
    @pytest.mark.asyncio
    async def test_reading_needs_users_read(self, client, database):
        await seed_auth(database)
        await database[users_router.COLLECTION].update_one(
            {"_id": ACTOR}, {"$set": {"permissionOverrides": {"deny": [USERS_READ]}}}
        )

        response = client.get("/api/v1/users", headers=auth_headers())

        assert response.status_code == 403
        assert response.json()["error"]["details"] == {"requiredPermissions": [USERS_READ]}

    @pytest.mark.asyncio
    async def test_WRITING_NEEDS_USERS_MANAGE_NOT_USERS_READ(self, client, database):
        # A manager who can see the team list must not be able to reset their passwords.
        await seed_auth(database)
        await database[users_router.COLLECTION].update_one(
            {"_id": ACTOR}, {"$set": {"permissionOverrides": {"deny": [USERS_MANAGE]}}}
        )
        target = await seed_user(database)

        listing = client.get("/api/v1/users", headers=auth_headers())
        reset = client.patch(
            f"/api/v1/users/{target['_id']}/reset-password",
            json={"password": VALID_PASSWORD},
            headers=auth_headers(),
        )

        assert listing.status_code == 200
        assert reset.status_code == 403

    @pytest.mark.asyncio
    async def test_unauthenticated_requests_are_refused(self, client, database):
        assert client.get("/api/v1/users").status_code == 401
