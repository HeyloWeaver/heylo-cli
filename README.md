# Heylo CLI (`npx heylo`)

The `heylo` CLI is the local dev launcher. It lets you start any combination of the three services — API, Web, and AppSync (Go) — and routes everything else directly to the cloud.

## How it works

Each service owns a set of environment variables that point to it (e.g. `NEXT_PUBLIC_API_BASE_URL`). By default, those vars hold cloud URLs from `.env`. When you start a service locally, the CLI overrides that var to `localhost`. When you don't, the cloud URL stays in place — there's no proxy or forwarding, the client just hits the cloud endpoint directly.

On startup it always prints a **Routing** table so you can see at a glance what's local and what's cloud:

```
DB       ↳ dev    rds.example.us-east-2.amazonaws.com
Routing:
  NEXT_PUBLIC_API_BASE_URL              ↳ local  http://localhost:4000
  NEXT_PUBLIC_APPSYNC_GRAPHQL_ENDPOINT  ↳ cloud  https://....appsync-api.us-east-2.amazonaws.com/graphql
```

## Services

| ID    | What it runs                        | Port | Controls env var                          |
|-------|-------------------------------------|------|-------------------------------------------|
| `api` | NestJS API (`heylo-api`)            | 4000 | `NEXT_PUBLIC_API_BASE_URL`                |
| `web` | Next.js web console (`heylo-web`)   | 3000 | (none — it's the client)                 |
| `go`  | AppSync GraphQL (Go Lambda, local)  | 8080 | `NEXT_PUBLIC_APPSYNC_GRAPHQL_ENDPOINT`   |

## Environments

The CLI asks which database to connect to (or you can pass it via `--env`):

| Flag          | DB target                        | Overlay file  |
|---------------|----------------------------------|---------------|
| `local`       | Docker MySQL at `127.0.0.1:3306` | `.env.local`  |
| `dev`         | Cloud RDS (AWS dev)              | `.env.dev`    |

The base `.env` is always loaded first; the chosen profile is overlaid on top.

## Usage

```sh
heylo                          # interactive: pick services + env
heylo api                      # API local, everything else → cloud
heylo api web --env local      # API + web local, Docker MySQL
heylo go --env dev             # Go GraphQL local, cloud RDS
heylo --all --env local        # all services local, Docker MySQL
heylo --help                   # full usage
```

## Cognito / Auth

Cognito always runs in AWS — there is no local Cognito. The flow in dev is:

1. The browser authenticates directly with the AWS Cognito User Pool and receives a JWT.
2. The JWT is sent as a Bearer token on every API request.
3. The local API (if started) validates the JWT by fetching the User Pool's public JWKS from AWS — identical to production.

If you don't start the API locally, the browser just sends the JWT straight to the cloud API. Nothing is forwarded or proxied.

## File reference

| File                    | Purpose                                           |
|-------------------------|---------------------------------------------------|
| `cli/dev-services.mjs`  | CLI source — service definitions and routing      |
| `cli/appsync-local-dev.mjs` | AppSync Go local runner (watch mode support)  |
| `.env`                  | Base env (cloud URLs, shared config)              |
| `.env.dev`              | Dev profile overlay (cloud RDS)                   |
| `.env.local`            | Local profile overlay (Docker MySQL)              |
| `.env.example`          | Template for `.env`                               |
