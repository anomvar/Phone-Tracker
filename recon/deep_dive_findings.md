# Deep Dive Critical Findings

## 1. Ekam OIDC Client Registration — COMPLETELY OPEN (CRITICAL)
**Endpoint**: `POST https://ekam.olakrutrim.com/register`

**No authentication required**. Successfully registered multiple OAuth 2.1 clients:

```json
// Client 1: Basic test
{"client_id":"clt_d96d66b15cee4683b0ae","client_name":"test","redirect_uris":["http://localhost/callback"],
 "token_endpoint_auth_method":"none","grant_types":["authorization_code"],"response_types":["code"],
 "client_id_issued_at":1784835721}

// Client 2: Full privileges requested
{"client_id":"clt_03e29029fa434442af94","client_name":"exploit","redirect_uris":["http://localhost:9999/cb","https://evil.com/cb"],
 "token_endpoint_auth_method":"none","grant_types":["authorization_code"],"response_types":["code"],
 "client_id_issued_at":1784835733}
```

**Impact**: Anyone can register OAuth clients with `token_endpoint_auth_method: "none"`.
- Could be chained with CSRF or phishing to steal authorization codes
- Registered redirect_uris include `http://localhost:9999/cb` — could be used for localhost-based attacks
- Open redirect possible via `redirect_uris`

---

## 2. PostgreSQL + Vault Backend Confirmed (HIGH)
**Endpoint**: `GET https://ekam.olakrutrim.com/healthz`
```json
{"ok":true,"issuer":"https://ekam.olakrutrim.com","store":"postgres","db":"up","key":"persistent","keySource":"vault"}
```
- PostgreSQL as primary store
- HashiCorp Vault for key management
- Issuer confirmed: `https://ekam.olakrutrim.com`

---

## 3. MongoDB Backend Confirmed (HIGH)
**Endpoint**: `GET https://cloud.olakrutrim.com/api/v1/health`
```json
{"status":"UP","checks":{"configService":{"status":"UP"},"integration":{"status":"UP"},"mongoDb":{"status":"UP","message":"Service is Healthy"}}}
```
- MongoDB is the primary database for the Krutrim Cloud console
- Health endpoint requires NO authentication

---

## 4. Full OIDC/OAuth2 Infrastructure (MEDIUM-HIGH)
All endpoints publicly accessible:

**Standard endpoints:**
- `/.well-known/openid-configuration` — Full OIDC discovery
- `/.well-known/jwks.json` — ES256 public key (`kid: ekam-2026-06`)
- `/.well-known/oauth-authorization-server` — OAuth metadata
- `/.well-known/oauth-protected-resource` — Protected resource metadata
- `/.well-known/ssf-configuration` — SSF/CAEP config

**Token endpoints:**
- `POST /oauth/token` — Token issuance (requires owner key)
- `POST /oauth/introspect` — Token validation
- `POST /authz/decision` — Authorization decisions

**Auth endpoints:**
- `GET /authorize` — Authorization (requires PKCE S256)
- `GET /userinfo` — User info (requires valid token)
- `GET /logout` — Session logout
- `POST /register` — **NO AUTH CLIENT REGISTRATION**

**Admin endpoints (require admin token):**
- `GET /admin/webhooks` — Webhook management
- `PUT /admin/birthright-policy` — Birthright access policies
- `POST /ssf/streams` — Event streams

**V1 API endpoints (require owner key):**
- `POST /v1/agents` — Create agents
- `POST /v1/blueprints` — Create blueprints
- `GET /v1/me` — Whoami
- `GET /v1/usage` — Usage data
- `GET /v1/billing` — Billing info
- `POST /v1/agents/:id/revoke` — Kill-switch
- `GET /v1/tenants` — (admin: List tenants)
- `GET /v1/owners` — (admin: List owners)
- `POST /v1/persons/:id/erase` — GDPR erasure

**SSO endpoints:**
- `GET /auth/login` — Google SSO login
- `POST /auth/saml/acs` — SAML ACS
- `GET /auth/saml/metadata` — SAML SP metadata exposed
- `GET /auth/github/login` — GitHub login
- `POST /oauth/federate/google` — Google federation
- `POST /oauth/federate/oidc` — OIDC federation (returns internal error)

**Scopes supported:** `openid`, `email`, `profile`, `models:invoke`, `models:chat`, `models:embed`, `agents:manage`

**Grant types:** `authorization_code`, `urn:ietf:params:oauth:grant-type:token-exchange`, `urn:ietf:params:oauth:grant-type:jwt-bearer`

---

## 5. JWT Bearer Grant — Processed but Locked (MEDIUM)
The JWT bearer grant type is supported but requires trusted issuers. Current federated issuers list is **empty** (`[]`).

Error messages leak information:
- `"untrusted id-jag issuer: test"` — Validates issuer field
- `"Unsupported \"alg\" value for a JSON Web Key Set"` — Only ES256 alg supported via JWKS
- `"id-jag invalid"` — Proprietary format name (ID-JAG = IDentity Jwt Assertion Grant)

---

## 6. SAML Metadata Exposed (MEDIUM)
**Endpoint**: `GET https://ekam.olakrutrim.com/auth/saml/metadata`
```xml
<EntityDescriptor entityID="https://ekam.olakrutrim.com">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" 
      Location="https://ekam.olakrutrim.com/auth/saml/acs"/>
  </SPSSODescriptor>
</EntityDescriptor>
```

---

## 7. Cloud API Config Endpoint (MEDIUM)
`/api/config` returns HTTP 400 ("Invalid query parameters") instead of 401. This endpoint exists independently of the APISIX auth barrier. Could be vulnerable to parameter injection.

---

## 8. APISIX Version Fingerprint (HIGH)
Apache APISIX 3.9.1 running on `www.olakrutrim.com` and `beta.olakrutrim.com`.
- Admin API port 9180 is firewalled
- batch-requests plugin may be disabled or behind Next.js proxy
- Multiple CVEs exist for this version

---

## 9. Fast2SMS API Key Exposure (CRITICAL)
```html
<meta name="fast2sms" content="KLRurCchswGiEG1TuRDZtCzXUvInuxof">
```
Every page on `test1.staging.olakrutrim.com` (Chitthi app) leaks this key.

---

## 10. Internal Infrastructure Leaks (HIGH)
- Internal K8s domains: `*.kcs-prod-krutrim-0.corp.olakrutrim.com`
- Internal K8s staging: `*.kcs-stg-krutrim-0.corp.olakrutrim.com`
- FaaS: `*.in-bangalore-1.faas.olakrutrim.com`
- Grafana, Keycloak, Rancher, Harbor DNS-resolvable
- S3 bucket: `hv-camera-web-sg.s3-ap-southeast-1.amazonaws.com`
- CDN bucket: `ev-discovery-platform-prod`
- WP Engine: `blogolelectric.wpengine.com`

---

## Priority Exploit Paths

1. **Fast2SMS API key** → SMS abuse / financial impact (immediate)
2. **OIDC client registration** → Phishing / CSRF chain (no auth required)
3. **Ekam health endpoint** → PostgreSQL + Vault info leak
4. **Cloud health endpoint** → MongoDB info leak
5. **APISIX 3.9.1** → RCE if batch-requests accessible via internal path
6. **SAML metadata exposure** → SAML response crafting attempts
7. **Federated issuers manipulation** → JWT bearer grant abuse (if issuer can be added)
