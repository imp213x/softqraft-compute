# softqraft-compute

## Read this first

1. **This repository's `AGENTS.md`.** It holds the rules for working here, including the documentation rules, and outranks the workspace contract (it may only be stricter).
2. **The Alpha Workspace Agent Operating Contract at `C:\Projects\AGENTS.md`.** It is binding for every agent and human under `C:\Projects`: instruction precedence, repository boundaries, the work loop, credentials, subagents, independent validation and the definition of done. Agents that cannot read it (for example in a cloud container) follow this file and `AGENTS.md`, which carry the rules that matter most.

### Instruction precedence, in order

1. Platform, runtime, security, and tool-enforced requirements.
2. The user's latest explicit instruction for the current task.
3. Repository-local instructions (`AGENTS.md`, `README`, architecture rules).
4. The workspace contract at `C:\Projects\AGENTS.md`.
5. Conventions inferred from this repository.
6. General engineering practice.

A lower-priority instruction never overrides a higher one.

### The rules broken most often

- **No silent scope expansion**, into another repository or into infrastructure, production deployment, secret rotation, destructive migrations, billing, DNS or access control. Adjacent work worth doing is reported as a recommendation, not performed.
- **Preserve uncommitted work.** `git checkout --`, `git reset --hard`, force-push and branch deletion are destructive and need explicit authorisation.
- **Credentials are never typed by an agent.** Ask the user to do it.
- **Do not hide failures.** A skipped step or an unverified claim is reported as such. Green output is not evidence on its own.
- **Validate independently.** A tool reporting success about its own work is not verification of it.
- **Developer docs are part of done.** Every product update, enhancement or feature addition updates `CHANGELOG.md`, and `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, the version and the feature's living doc in `myDocs/` whenever they are affected, in the same PR.
- **Keep design docs slim.** One living doc per feature in `myDocs/<feature>/README.md`, updated in place. Working papers are deleted once their facts are folded in. Never copy a document another repository owns.
- **No developer text in product UI.** Screens carry what the user needs for the task, nothing more.

This file is a pointer, not a substitute. The full rules are in `AGENTS.md`.
