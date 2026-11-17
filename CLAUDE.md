# claude-ec2

Web app (SST: `sst.config.ts`, `infra/`, `packages/api`, `packages/web`) and CLI (`cli/`, Rust) to control the Claude Code EC2 instance. Both run the instance-side scripts in `remote/`.

- Read [docs/development.md](docs/development.md) first: stages, tests, delivery and the deviations (no `int`; the test user is read-only because every stage controls the one real instance).
- Never stop, start, resize or spawn on the instance from tests or while trying things out: this session may be running on it.
- A change to `remote/*.sh` affects the web app and the CLI: run the unit tests and `cargo test` in `cli/`.
