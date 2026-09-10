# StreetRove on OVHcloud VPS-2

Selected host: VPS-2 2027, US East (Vinthill), Ubuntu 26.04 LTS, 4 vCores,
8 GB RAM, 75 GB NVMe. The configurator quoted $10/month before tax with
**No commitment** on 2026-09-02. IPv4 and the standard daily backup are included.
No premium backup, extra disk, control panel, or annual commitment is selected.

## Deployment status and access

These files prepare a **password-protected pilot with one shared workspace**.
The Caddy password gate covers the entire site and API. It is not separate user
accounts or tenant isolation: everyone given the pilot password can see and edit
all worlds. Do not remove the gate for public registration. Before a wider
50-user release, implement ownership, account management and per-user quotas,
and measure the actual capacity with a representative load test.

The production API queues imports in PostgreSQL. A separate worker processes
one at a time and takes a database session lock to exclude another worker.
Jobs interrupted by process termination are recovered by the next worker,
up to three starts. Provider failures are shown as failed imports, and can be
retried through the UI. Existing development Compose retains inline execution.

## Transfer and initial setup

Create the source archive from PowerShell on the development machine:

```powershell
./deploy/package.ps1
```

The result is `output/deployment/streetrove-deploy.tar.gz`, containing current
source edits and deployment files. Local secrets, dependencies, runtime data,
and build outputs are excluded. Transfer it by SCP to the provisioned server,
verify its SHA-256 there, and extract into a new `/opt/streetrove` directory.
Do not overwrite a running release or its `deploy/private` directory.

From the extracted repository on the VPS:

```bash
sudo bash deploy/install-docker.sh
sudo bash deploy/initialize.sh
sudo docker compose --env-file deploy/private/production.env -f compose.production.yaml config --quiet
sudo docker compose --env-file deploy/private/production.env -f compose.production.yaml build api
sudo docker compose --env-file deploy/private/production.env -f compose.production.yaml up -d db api worker
```

The initializer asks for the hostname, contact email and pilot login. It writes
private configuration once, with a random hexadecimal database password and a
bcrypt password hash; it never prints either password. Store the pilot password
in a password manager. The first image build can run on the empty VPS; build
subsequent release images away from the active production workload.

Test the API internally before pointing DNS:

```bash
sudo docker compose --env-file deploy/private/production.env -f compose.production.yaml exec -T api node -e "fetch('http://localhost:3000/api/ready').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})"
```

Validate a sample import and restart recovery using the deployment smoke test:

```bash
sudo docker compose --env-file deploy/private/production.env -f compose.production.yaml exec -T api node --input-type=module < deploy/smoke.mjs
```

The smoke test creates a new synthetic test world. It never calls live map
providers. Verify worker recovery separately by stopping the worker, queuing
a sample import, and restarting it; the queued import should then complete.
After a forced stop during an import, its running job should resume on startup.

## Domain and HTTPS

Retain GoDaddy as the DNS provider. Add only an A record with host `streetrove`
and the VPS public IPv4. Leave the apex domain, mail records and nameservers
unchanged. Use a low TTL initially. Start the proxy after DNS resolves:

```bash
sudo docker compose --env-file deploy/private/production.env -f compose.production.yaml up -d caddy
```

Caddy obtains and renews the certificate. Its `/data` volume preserves the
certificate account across updates. Only ports 80 and 443 are published; the
database and API have no host port. Restrict SSH to your management address
using the OVHcloud network firewall; retain working SSH access while doing so.
Docker-published ports can bypass UFW, so do not rely on UFW to hide a published
database port.

Before release, verify unauthenticated requests receive 401, authenticated
requests can load/create/edit/reopen a sample world, and the certificate is
valid. Use `curl -u streetrove https://streetrove.kimber.dev/api/ready` to enter
the password interactively rather than placing it in shell history.

## Backups and updates

Run `sudo bash deploy/backup.sh`. It exports a database dump, immutable raw map
files and private deployment configuration into a timestamped private directory.
Keep the archive confidential: it contains credentials and saved locations.
Copy completed archives to independent storage, for example by SCP to your own
computer. A local copy alone does not protect against losing the VPS. The
included OVH backup has only the latest daily restore point; it is not a
long-term database backup policy. Schedule exports only with a retention policy
so backups do not fill the 75 GB disk.

Rehearse restoration into an **empty** database: validate the dump with
`pg_restore --list`, restore it with `pg_restore --exit-on-error --no-owner`,
restore `osm.tar.gz` into the cache volume owned by UID 10001, and verify the
saved world and its overrides. Keep the original server intact until the
restored instance is verified. A full server restore is also available through
OVHcloud's included backup. No destructive restore command is automated here.

Before updates, export a backup and keep the previous application image tag.
Set `STREETROVE_RELEASE` to a unique version. Update API and worker together;
both must use the same image. Roll back application images only while their
database schema remains compatible. Never use `docker compose down --volumes`
on this deployment. Keep paid options out of the configuration until required.

## Map data and capacity

Keep imports small, reuse snapshots, and preserve attribution. Public Nominatim
allows at most one request per second across the whole application, prohibits
autocomplete and requires application identification and caching. The existing
single API instance applies this limit. Overpass's public instances are not a
reliable production backend for a general public app. A supported map-data
provider or regional data source is a separate decision and potential cost.

50 browser sessions is a capacity target, not a verified result. Measure API
latency, memory, disk space and import wait times with realistic maps. Multiple
large imports queue rather than run concurrently. Graphics and vehicle physics
remain in each visitor's browser.

Sources:

- [OVHcloud VPS](https://us.ovhcloud.com/vps/)
- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Caddy authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
- [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/)
- [Overpass shared infrastructure](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)
