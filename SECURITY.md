# Security Policy

## Supported versions

Artifacts is unversioned pre-alpha software. There are no supported releases and no guarantee that
security fixes will be backported.

## Deployment boundary

Artifacts has no authentication or authorization. Anyone who can reach the server can list, read,
create, change, and remove artifacts. Deploy it only on loopback or a trusted internal network. If
broader access is required, place an authentication-capable reverse proxy in front of it and verify
that the application itself is not directly reachable. Never store secrets in artifacts.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Include affected behavior,
reproduction steps, impact, and any suggested mitigation. Do not open a public issue for an
unresolved vulnerability.

Because the project is pre-alpha, response and remediation timelines are best effort.
