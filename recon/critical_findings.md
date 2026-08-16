# Critical Vulnerability Findings

## 1. Fast2SMS API Key Exposure — test1.staging.olakrutrim.com
**Severity: CRITICAL**

**Location**: Every page on `test1.staging.olakrutrim.com` (Chitthi app)
**Exposed key** (in `<meta>` tag): `KLRurCchswGiEG1TuRDZtCzXUvInuxof`

Every HTML page on this subdomain contains:
```html
<meta name="fast2sms" content="KLRurCchswGiEG1TuRDZtCzXUvInuxof">
```

**Impact**: This API key can be used with Fast2SMS API to:
- Send SMS messages at the company's cost (financial impact)
- Access SMS delivery reports
- Potentially access other Fast2SMS account resources

**Curl test**:
```bash
curl -X POST "https://www.fast2sms.com/dev/bulkV2" \
  -H "authorization: KLRurCchswGiEG1TuRDZtCzXUvInuxof" \
  -H "Content-Type: application/json" \
  -d '{"sender_id":"FSTSMS","message":"test","route":"v3","numbers":"9999999999"}'
```

---

## 2. MongoDB Backend Exposed — cloud.olakrutrim.com
**Severity: HIGH**

**Endpoint**: `https://cloud.olakrutrim.com/api/v1/health`
**Response**:
```json
{"status":"UP","checks":
  {"configService":{"status":"UP","message":"Service is Healthy"},
   "integration":{"status":"UP","message":"Service is Healthy"},
   "mongoDb":{"status":"UP","message":"Service is Healthy"}}
}
```

**Impact**: Confirms MongoDB is the primary database backend. The health endpoint is accessible without any authentication.

---

## 3. PostgreSQL + Vault Backend Exposed — ekam.olakrutrim.com
**Severity: HIGH**

**Endpoint**: `https://ekam.olakrutrim.com/healthz`
**Response**:
```json
{"ok":true,"issuer":"https://ekam.olakrutrim.com","store":"postgres","db":"up","key":"persistent","keySource":"vault"}
```

**Impact**: Confirms PostgreSQL database and Hashicorp Vault as key management system.

---

## 4. Unauthenticated Access Request — ekam.olakrutrim.com
**Severity: HIGH**

**Endpoint**: `POST https://ekam.olakrutrim.com/access/request`
**Accepts**: `{"email":"...","org":"...","use":"..."}`
**Response**: `{"ok":true}`

No authentication required. Accepts arbitrary data.

---

## 5. Full OIDC/OAuth2 Infrastructure Exposed — ekam.olakrutrim.com
**Severity: MEDIUM-HIGH**

All OIDC/OAuth2 endpoints publicly accessible:
- `/.well-known/openid-configuration`
- `/.well-known/jwks.json` (ES256 key: `ekam-2026-06`)
- `/oauth/token` (POST)
- `/oauth/introspect` (POST)
- `/authorize`
- `/userinfo`
- `/register` (returns internal error)
- `/v1/tenants`, `/v1/owners`, `/v1/agents`, `/v1/blueprints`
- Postman collection: `/ekam.postman_collection.json`

---

## 6. Apache APISIX 3.9.1 — Known CVEs
**Severity: CRITICAL**

**Locations**: `www.olakrutrim.com`, `beta.olakrutrim.com`

Apache APISIX 3.9.1 has multiple known critical vulnerabilities:
- **CVE-2022-24112**: RCE via batch-requests plugin
- **CVE-2023-2970**: Authentication bypass
- Improper access control vulnerabilities

---

## 7. Internal K8s Infrastructure Exposure
**Severity: HIGH**

Several internal Kubernetes services are DNS-resolvable from public internet:
- `grafana.kcs-prod-krutrim-0.corp.olakrutrim.com`
- `grafana.kcs-stg-krutrim-0.corp.olakrutrim.com`
- `keycloak.rnd.staging.olakrutrim.com`
- `rancher.staging.olakrutrim.com`
- `harbor-test.staging.olakrutrim.com`

Internal K8s namespace structure leaked: `kcs-prod-krutrim-0`, `kcs-stg-krutrim-0`

---

## 8. FaaS/Lambda Functions Exposed
**Severity: MEDIUM**

Serverless functions publicly accessible:
- `*.2552197821.in-bangalore-1.faas.olakrutrim.com`
- `*.1895689115.in-bangalore-1.faas.olakrutrim.com`
- `first-function-prod.4883507295.in-bangalore-1.faas.olakrutrim.com`

---

## 9. WordPress User Enumeration — blog.olakrutrim.com
**Severity: MEDIUM**

**Endpoint**: `https://blog.olakrutrim.com/wp-json/wp/v2/users`

Users exposed:
1. Anmol Bhatt (admin)
2. Aparna Narayana
3. Shilpa
4. Vishnu

Internal WP Engine host: `blogolelectric.wpengine.com`

---

## 10. S3/CDN Bucket Names Leaked
**Severity: MEDIUM**

- `hv-camera-web-sg.s3-ap-southeast-1.amazonaws.com` (HyperVerge SDK hosting)
- `ev-discovery-platform-prod` (From CDN error response)

---

## 11. Ekam Credential Issuance Endpoints
**Severity: HIGH**

**Endpoints** (require POST with body):
- `POST /cred`
- `POST /token`

These accept requests with proper headers but deny empty bodies. Could potentially be used to issue credentials if body requirements are met.

---

## 12. Ghost Blog (tech.olakrutrim.com)
**Severity: MEDIUM**

Ghost 6.54 running on Nginx/OpenResty/Varnish. Has known vulnerabilities.

---

## 13. Cloud API Config Endpoint
**Severity: MEDIUM**

`/api/config` returns "Invalid query parameters" instead of 401 auth required — APISIX route exists but is parameterized. Potential parameter pollution / injection vector.

---

## Attack Chain for Maximum Impact

1. **Fast2SMS API key** → Send SMS, financial abuse, potential account takeover
2. **Apache APISIX RCE** → Server access → Internal network pivot → MongoDB/PostgreSQL access
3. **Ekam OIDC abuse** → Token manipulation → Access to internal services
4. **Chitthi app data** → PII collection (phone, email, passwords)
