# Krutrim/Ola Bug Bounty Recon Report

## Scope
- Domain: olakrutrim.com
- Subdomains: 175 discovered via subfinder, 81 unique, 16 live

## Attack Surface Summary

### 1. WordPress Blog (blog.olakrutrim.com)
- **Stack**: WordPress, WP Engine hosting, Elementor 3.34.3, Yoast SEO 26.8, AddThis, Cloudflare
- **Internal hostname**: blogolelectric.wpengine.com
- **Users enumerated** via `/wp-json/wp/v2/users`:
  - ID 1: Anmol Bhatt (admin)
  - ID 20: Aparna Narayana
  - ID 8: Shilpa
  - ID 16: Vishnu
- **Potential vectors**: Brute-force, plugin vulns, XML-RPC

### 2. Apache APISIX 3.9.1 (www.olakrutrim.com, beta.olakrutrim.com)
- Known CVEs: CVE-2022-24112 (Apache APISIX remote code execution), CVE-2023-2970, others
- Path traversal, batch request smuggling possible

### 3. Krutrim Ekam Identity Service (ekam.olakrutrim.com)
- Agent-identity & access control plane (OAuth2/OIDC)
- Nginx 1.24.0, PostgreSQL backend, Vault
- **API Endpoints discovered:**
  - `POST /oauth/token` - broker tokens (requires auth)
  - `POST /oauth/introspect` - token introspection
  - `POST /v1/agents` - create agents
  - `GET /healthz` - health (`{"ok":true,"store":"postgres","db":"up","keySource":"vault"}`)
  - `POST /cred` - credential issuance
  - `POST /token` - token issuance
  - `POST /access/request` - **unauthenticated access request** (returns `{"ok":true}`)
  - `GET /.well-known/jwks.json` - ES256 key `ekam-2026-06`
  - `GET /.well-known/openid-configuration` - full OIDC config
  - `GET /.well-known/oauth-authorization-server`
  - `GET /.well-known/oauth-protected-resource`
  - `GET /.well-known/ssf-configuration`
  - `GET /userinfo`
  - `GET /authorize` (requires PKCE)
  - `GET /register`
  - `GET /logout`
  - `GET /authz/decision`
- **Auth endpoints**: Google SSO, GitHub login, SAML ACS, OIDC federation
- **Interest**: `/access/request` is unauthenticated, `/healthz` exposes infra details

### 4. Ola Maps (maps.olakrutrim.com)
- Next.js app with custom 404
- **Endpoints**: `/api/auth/login` (returns "Missing token"), `/api/org/check` (404 client-side), `/health`
- Requires API token for map services

### 5. Krutrim Cloud Dashboard (cloud.olakrutrim.com)
- Next.js with Apache APISIX proxy
- Routes: `/console/home`, `/signIn`, `/signUp`
- **Third-party integrations:**
  - HyperVerge SDK v9.7.1 (identity verification)
  - Chatwoot SDK (customer support chat)
  - Akamai CDN, NewRelic, Akamai Boomerang
- S3 bucket: `hv-camera-web-sg.s3-ap-southeast-1.amazonaws.com`

### 6. Infrastructure Leaks

| Leak | Source |
|------|--------|
| WP Engine internal URL | blogolelectric.wpengine.com |
| K8s internal domains | *.kcs-prod-krutrim-0.corp.olakrutrim.com |
| K8s staging domains | *.kcs-stg-krutrim-0.corp.olakrutrim.com |
| FaaS functions | *.2552197821.in-bangalore-1.faas.olakrutrim.com |
| CDN bucket name | ev-discovery-platform-prod |
| S3 bucket | hv-camera-web-sg.s3-ap-southeast-1.amazonaws.com |
| PostgreSQL backend | Via ekam /healthz endpoint |
| Vault | Via ekam /healthz endpoint (keySource) |
| Postman collection | https://ekam.olakrutrim.com/ekam.postman_collection.json |

### 7. Internal/Corp Services (partially accessible)
- Grafana: `grafana.kcs-prod-krutrim-0.corp.olakrutrim.com`, `grafana.kcs-stg-krutrim-0.corp.olakrutrim.com`
- Keycloak: `keycloak.rnd.staging.olakrutrim.com`, `keycloak.test.proxy.olakrutrim.com`
- Rancher: `rancher.staging.olakrutrim.com`, `rancher.test.proxy.olakrutrim.com`
- Harbor: `harbor-test.staging.olakrutrim.com`, `harbor.internal.staging.olakrutrim.com`
- Various internal AI services, chat apps, MCP servers

### 8. Misconfigurations
- **waf.olakrutrim.com** - Returns placeholder "Example Domain" page (IANA example page)
- **delivery.olakrutrim.com** - 404 Not Found but responds (Google Cloud L7)
- Several FaaS endpoints exposed to public

## Recommended Focus Areas
1. **Apache APISIX 3.9.1** - Known RCE vulns (CVE-2022-24112)
2. **Ekam `/access/request`** - Unauthenticated endpoint accepting any data
3. **WordPress blog** - User enumeration, version exposure, plugin vulns
4. **Internal K8s services** - Some are publicly accessible (Grafana, Keycloak, Rancher)
5. **S3 buckets** - Check for public access
6. **FaaS functions** - Check for serverless function vulnerabilities
