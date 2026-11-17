# Development

This app is developed and delivered per the [continuous-delivery standard](https://github.com/jakubprzybytek/agent-playbook/blob/main/skills/continuous-delivery/STANDARD.md), with the deviations listed at the end: develop on `dev`, every push to `main` goes to `prod`. This file holds what is specific to this app.

## Stages

| Stage | URL | Notes |
|---|---|---|
| `dev` | https://dev.claude-ec2.albedoonline.com (or http://localhost:5173 with `npm run dev`) | controls the **real** instance; the test user is read-only |
| `prod` | https://claude-ec2.albedoonline.com | holds the launch template (`infra/ec2.ts`) |

There is only one instance (tag `Name=claude-code`), and every stage controls it: a stage costs only its serverless parts (cents a month), no second instance.

## Run locally

```sh
npm ci && npx sst install
npm run deploy -- --stage dev     # full deployment (agent sessions)
npm run dev -- --stage dev        # sst dev: the function on your machine, the site on http://localhost:5173
```

## Tests

| Kind | Command | What |
|---|---|---|
| Type check, lint, unit | `npm run typecheck`, `npm run lint`, `npm test` | the API with EC2/SSM mocked (`aws-sdk-client-mock`), access rules, argument validation, quoting |
| CLI | `cd cli && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` | |
| Integration | `npx sst shell --stage dev -- npm run test:integration` | the deployed API as the test user: reads, and refused writes |
| E2E | `npx sst shell --stage dev -- npm run test:e2e` | the deployed dev site, desktop and phone width |

**The tests only read.** The test user's group `claude-ec2-test` is read-only (`READ_ONLY_GROUPS`, `infra/stage.ts`): the API refuses it every action that changes something, before any AWS call, so a test can never stop the instance or spawn a session while it is in use. The integration tests check that refusal with requests that would be harmless even if they got through. Actions are covered by the unit tests with EC2 and SSM mocked; the instance-side scripts (`remote/`) by trying them on the instance (as root, the way SSM runs them: `base64 -w0 remote/x.sh | base64 -d | sudo bash -s -- args`), and by the CLI.

Test user: `claude-ec2-test@albedoonline.com`, group `claude-ec2-test`, password in the SST secret `TestUserPassword` of `dev`. Created once with admin credentials ([test-user template](https://github.com/jakubprzybytek/agent-playbook/blob/main/skills/continuous-delivery/templates/test-user.md), with `APP=claude-ec2` and the secret set on `dev` only).

## Delivery

`.github/workflows/continuous-delivery.yaml`: checks (app and CLI, `.github/workflows/checks.yaml`) → deploy `prod` → smoke checks without a login (the site shows this version, the API answers 401 without a token) → tag `vM.N`. Releases only go forward; the version is in the site's footer. Rollback: run Continuous Delivery manually from the release tag (`gh workflow run continuous-delivery.yaml --ref vM.N`).

Ask before pushing changes that touch data, resources holding data, access, or cost (the standard, section 5). For this app also:

- anything in `infra/ec2.ts` or `infra/ec2/user-data.sh`: it changes what the next instance is launched with;
- the function's permissions, the boundary, or the access groups: they decide who controls the instance;
- the instance-side scripts in `remote/` that change something on the instance (`spawn.sh`, `close.sh`, `snooze.sh`, `exec.sh`).

## The launch template

`infra/ec2.ts` imports the hand-made template (`lt-09036c7e82f2ca477`, version 8) on prod, with `retainOnDelete` and `protect`. Its arguments must stay equal to the template's current version, or a deploy creates a new version (that is the way to change it: edit the arguments or `infra/ec2/user-data.sh`, and the deploy publishes the next version; set `description` to say what changed). A running instance is not affected: the setup script runs once, at an instance's first boot.

## Deviations

- **No `int` stage; the pipeline deploys `prod` straight after the checks.** There is only one instance, it is in use while the pipeline runs, and tests must not stop, start or change it; a separate stage would test against the same instance anyway. In its place: the read-only test group, unit tests with AWS mocked, and smoke checks without a login after the prod deploy. The release is tagged after the prod deploy and its smoke checks, not before.
- **Not everything is in the stack yet (phase 1).** The instance itself, its IAM role and instance profile `claude-code-ec2`, the security group `claude-code-no-inbound`, the key pair and the SSM parameter `/claude-code/github-token` are managed by hand. Phase 2 brings them in. The instance role is the hard part: it deploys every app from the instance, so it can't carry this app's permissions boundary (rule 8 of aws-github-deploy) and the deploy role must not be able to change it; that needs a decision first.
- **Integration and E2E tests run on `dev` only, by hand** (not in the pipeline, which has no stage to run them on).
