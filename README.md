# @hausofweb/env-cli

SOPS-encrypted env var management for Haus of Web monorepos. Variables live encrypted in git under `env/`, and the `hwenv` CLI decrypts them into each app's `.env.local`, syncs them to Vercel and AWS SSM, and edits them without ever leaving plaintext behind.

## Install

```sh
pnpm add -D @hausofweb/env-cli
```

Requires Node 24 or newer and the [`sops`](https://github.com/getsops/sops) binary on your PATH. Vercel sync runs the `vercel` CLI, so add it too when you use `hwenv sync`: `pnpm add -D vercel`.

Run it with `pnpm exec hwenv <command>`, or with no command for an interactive menu.

## env.config.json

`hwenv` finds the repository root by walking up from the current directory to the first folder containing `env.config.json`. Everything is optional.

```json
{
  "envDir": "env",
  "awsProfiles": {
    "development": "dev",
    "preview": "preview",
    "staging": "staging",
    "production": "prod"
  },
  "ssm": {
    "required": ["DATABASE_URL"],
    "optional": ["CRON_SECRET"]
  },
  "externallyManagedKeys": ["SENTRY_AUTH_TOKEN"]
}
```

`envDir` is where the encrypted files live, relative to the repository root (default `env`). `awsProfiles` maps each environment to the AWS profile `sync-ssm` assumes for it; a command that needs a profile that is not listed fails with an error naming the missing key. `ssm` lists the variables `sync-ssm` writes to AWS SSM Parameter Store at `/<environment>/<KEY>`: `required` keys must have a value and a type annotation in every environment, `optional` keys are synced when present. When `ssm` is absent, `sync-ssm` reports there is nothing configured and exits 0. `externallyManagedKeys` lists Vercel variables owned by another system (Terraform, an integration), which `sync` and `remove` never create, update or delete and `sync --prune` never lists.

The environments are fixed: `production`, `staging`, `preview` and `development`.

## .sops.yaml

Keep a `.sops.yaml` at the repository root so sops knows which key encrypts each environment's files. For example, with AWS KMS:

```yaml
creation_rules:
  - path_regex: env/.*\.env\.production\.enc$
    kms: arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000000
  - path_regex: env/.*\.env\.staging\.enc$
    kms: arn:aws:kms:us-east-1:222222222222:key/00000000-0000-0000-0000-000000000000
  - path_regex: env/.*\.env\.(preview|development)\.enc$
    kms: arn:aws:kms:us-east-1:333333333333:key/00000000-0000-0000-0000-000000000000
```

## Folder layout

```text
env.config.json
.sops.yaml
env/
  web/
    app.config
    .env.development.enc
    .env.production.enc
  api/
    app.config
    .env.development.enc
  shared/
    .env.development.enc
    .env.production.enc
apps/
  web/
  api/
```

Each folder under `env/` (other than `shared`) is an app, named after its folder. `env/<app>/` holds that app's variables, one encrypted file per environment (`.env.<environment>.enc`). `env/shared/` holds variables several apps see, and each block is scoped with an `# @apps:` tag.

```dotenv
# @apps: web, api
# SecureString
DATABASE_URL="postgres://..."

# @global
NEXT_PUBLIC_SITE_NAME="Example"
```

`# @apps: a, b` limits the variables below it to those apps, `# @global` gives them to every app, and a `# String` or `# SecureString` line before a variable sets its SSM parameter type. Variables tagged for an app named `infra` are what `sync-ssm` reads, together with `env/infra/`.

`env/<app>/app.config` is optional, in `KEY=VALUE` form:

```dotenv
APP_TYPE=vercel
APP_DIRECTORY=apps/web
VERCEL_PROJECT=web
VERCEL_PROJECT_ID=prj_...
VERCEL_TEAM_ID=team_...
EXTERNAL_REPOSITORY=owner/repo
```

`APP_TYPE` is `vercel` (default), `non-vercel` or `local-only`. `APP_DIRECTORY` defaults to `apps/<name>` and is where `.env.local` is written and where the `.vercel` project link is read. `EXTERNAL_REPOSITORY` marks an app that deploys from another repository, so it has no local directory.

## Commands

- `decrypt [environment]` decrypts the encrypted files and writes each app's `.env.local` (`--all` includes non-Vercel apps).
- `encrypt` encrypts every plaintext env file with SOPS.
- `add [key]` adds a variable through a wizard, or non-interactively when a key and flags are given.
- `update [key]` changes a variable's value in place, or with `--apps` which apps see it.
- `copy [key]` copies one variable's decrypted value to the clipboard, showing only a masked preview.
- `remove [key]` retires a variable from the encrypted files, Vercel and SSM.
- `tidy` moves `shared/` variables that only one app sees into that app's own folder.
- `sync [environment]` syncs variables to Vercel (`--dry-run`, `--prune` to list variables no longer defined, `--confirm-prune` to remove them).
- `sync-ssm [environment]` syncs the configured keys to AWS SSM (`--dry-run`, `--delete-absent-optional`).
- `setup [app]` sets up local development for one app or all of them.
- `list` lists the discovered apps and their types.
- `delete-local` deletes every app's `.env.local`.

Commands that change production require `--confirm-production` when run non-interactively. Run `hwenv <command> --help` for every flag.

## Adding your own commands

The package exports the program builder, so a repository can register extra commander commands on it.

```ts
import { createEnvProgram } from "@hausofweb/env-cli";
import { Command } from "commander";

const rotateKeys = new Command("rotate-keys").action(() => {
  // ...
});

createEnvProgram({ commands: [rotateKeys] }).parse(process.argv);
```

## Development

```sh
pnpm install
pnpm typecheck
pnpm check
pnpm test
pnpm build
```

Commits follow Conventional Commits. Merging to `main` publishes a release to npm with semantic-release.

## License

MIT
