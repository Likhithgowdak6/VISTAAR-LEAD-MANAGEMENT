import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient
from app import db
from app.config import settings
from app.errors import install_error_handlers
from app.routers import google_auth as g

class Redis:
    def __init__(self): self.values = {}
    async def set(self, key, value, **kwargs): self.values[key] = value
    async def get(self, key): return self.values.get(key)
    async def getdel(self, key): return self.values.pop(key, None)
    async def eval(self, *args): return 1

@pytest.fixture
def setup(monkeypatch):
    database = AsyncMongoMockClient().google_auth_test
    redis = Redis()
    monkeypatch.setattr(db, 'get_database', lambda: database)
    monkeypatch.setattr(g.cache, 'get_client', lambda: redis)
    for name, value in dict(google_auth_client_id='test-client-id', bcrypt_rounds=4,
        auth_cookie_cross_site=False, saas_signup_enabled=True, saas_signup_invite_code='').items():
        monkeypatch.setattr(settings, name, value)
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(g.router, prefix='/api/v1/auth/google')
    monkeypatch.setattr(g, 'check_login_rate_limit', AsyncMock(return_value={'limited': False}))
    return TestClient(app), database


def test_verified_google_provisions_without_workspace_address_and_blocks_replay(setup, monkeypatch):
    client, database = setup
    nonce = client.get('/api/v1/auth/google/nonce').json()['data']['nonce']
    monkeypatch.setattr(g, 'verify_identity', AsyncMock(return_value={'email': 'owner@gmail.com', 'sub': 'google-sub', 'name': 'Owner'}))
    response = client.post('/api/v1/auth/google', json={'credential': 'signed-token'})
    assert response.status_code == 200, response.text
    assert response.json()['data']['user']['email'] == 'owner@gmail.com'
    assert asyncio.run(database.users.find_one({}))['googleSubject'] == 'google-sub'
    client.cookies.set(g.COOKIE, nonce, path='/api/v1/auth')
    assert client.post('/api/v1/auth/google', json={'credential': 'signed-token'}).status_code == 401


def test_multi_workspace_selection_cannot_access_foreign_business(setup, monkeypatch):
    from bson import ObjectId
    client, database = setup
    orgs = [ObjectId(), ObjectId()]
    async def seed():
        for index, oid in enumerate(orgs):
            await database.organizations.insert_one({'_id': oid, 'name': str(index), 'status': 'active'})
            await database.users.insert_one({'organizationId': oid, 'email': 'owner@gmail.com', 'status': 'active', 'role': 'super_admin'})
    asyncio.run(seed())
    client.get('/api/v1/auth/google/nonce')
    monkeypatch.setattr(g, 'verify_identity', AsyncMock(return_value={'email': 'owner@gmail.com', 'sub': 'verified'}))
    response = client.post('/api/v1/auth/google', json={'credential': 'signed-token'})
    assert response.json()['data']['selectionRequired'] is True
    assert asyncio.run(database.refreshsessions.count_documents({})) == 0
    assert client.post('/api/v1/auth/google', json={'credential': 'signed-token', 'organizationId': str(ObjectId())}).status_code == 403
    chosen = client.post('/api/v1/auth/google', json={'credential': 'signed-token', 'organizationId': str(orgs[1])})
    assert chosen.status_code == 200
    assert chosen.json()['data']['organization']['id'] == str(orgs[1])


@pytest.mark.asyncio
@pytest.mark.parametrize('change', [{}, {'aud': 'wrong'}, {'iss': 'wrong'}, {'exp': 1},
    {'nonce': 'wrong'}, {'email_verified': False}, {'email': 'owner@example.com'}])
async def test_real_signed_tokens_validate_claims(setup, monkeypatch, change):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_jwk = jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True)
    public_jwk['kid'] = 'test-key'
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def get(self, url): return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {'keys': [public_jwk]})
    monkeypatch.setattr(g.httpx, 'AsyncClient', Client)
    now = int(time.time())
    payload = {'iss': 'https://accounts.google.com', 'aud': 'test-client-id', 'iat': now,
        'exp': now + 300, 'sub': 'google-sub', 'email': 'owner@gmail.com', 'email_verified': True, 'nonce': 'bound'}
    token = jwt.encode({**payload, **change}, private_key, algorithm='RS256', headers={'kid': 'test-key'})
    if change:
        with pytest.raises(HTTPException): await g.verify_identity(token, 'bound')
    else:
        assert (await g.verify_identity(token, 'bound'))['sub'] == 'google-sub'
