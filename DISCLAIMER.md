# Disclaimer

pi-workbench is open-source software provided under the MIT license. This
document expands on the warranty and liability sections of the
[LICENSE](./LICENSE) and identifies specific operational risks an operator
should understand before deploying it.

## No warranty

The software is provided **"AS IS"**, without warranty of any kind, express
or implied — including but not limited to warranties of merchantability,
fitness for a particular purpose, accuracy, completeness, security, or
non-infringement. See the LICENSE for the full warranty disclaimer.

## What pi-workbench is

A browser UI for the [`pi-coding-agent`](https://github.com/badlogic/pi-mono)
SDK. It exposes the agent over HTTP + Server-Sent Events with a React
frontend. It is a **development tool**, not a managed service, and ships
**no certifications** (SOC 2, ISO 27001, HIPAA, PCI DSS, FedRAMP, etc.).

## What pi-workbench is not

- **Not a managed service.** There is no hosted offering. You run the
  container; you operate it.
- **Not a productized AI assistant.** It is plumbing around an LLM SDK,
  delivered as source.
- **Not safety-critical.** Do not place it in the control loop of medical,
  transportation, energy, financial-settlement, or weapons systems. The
  agent's tool calls have no safety verification, the LLM can hallucinate,
  and the bash tool can run arbitrary commands as the workbench user.
- **Not a security boundary by itself.** The container is the boundary;
  pi-workbench inside it has full access to the bind-mounted workspace and
  whatever the container can reach on the network.
- **Not certified for regulated data.** Decisions about processing PHI,
  PCI cardholder data, GDPR-special-category data, classified information,
  etc., are entirely yours.

## LLM-specific risks

When you connect pi-workbench to an LLM provider (Anthropic, OpenAI, Google,
or any OpenAI-API-compatible endpoint), you accept the following:

- **Hallucinations.** LLMs produce plausible-looking but factually incorrect
  output. Code the agent writes may compile and run while doing the wrong
  thing. Code the agent calls "secure" may have vulnerabilities. Always
  review.
- **Tool execution side effects.** The agent's `bash`, `write`, and `edit`
  tools take real action on your filesystem. A wrong call can delete
  files, corrupt configurations, push broken code, or send wasteful API
  requests. The single-tenant threat model assumes you trust the agent
  with the same permissions you trust yourself.
- **Provider data handling.** Your prompts, file contents, and tool
  outputs are sent to the configured LLM provider. Provider terms govern
  whether they retain, log, or train on this data — not pi-workbench. Do
  not send data you cannot legally share with the provider.
- **Cost overruns.** A misconfigured agent (or an honestly-wrong tool call)
  can burn through API tokens fast. Set provider-side spending limits.
  pi-workbench surfaces per-turn token + cost estimates in the Context
  Inspector but enforces no caps of its own.
- **Prompt injection.** Content the agent reads (file contents, tool
  output, web fetches) can contain instructions that override your
  intent. Pi's tool design mitigates the worst cases, but the threat is
  real and pi-workbench inherits it.
- **Jurisdictional regulation.** AI use is regulated differently across
  jurisdictions (EU AI Act, US state AI bills, sector-specific rules in
  finance / health / law). Compliance is yours.

## Operational risks

- **Data loss.** The project does not provide backup tooling. Workspace
  files, session JSONLs under `${SESSION_DIR}`, and project metadata in
  `WORKBENCH_DATA_DIR/projects.json` are persisted to bind-mounted
  volumes that you back up.
- **Network exposure.** The container speaks plain HTTP. Exposing port
  3000 to the public internet without a reverse proxy + TLS + auth is
  unsafe. See [SECURITY.md](./SECURITY.md).
- **Multi-user mistakes.** pi-workbench is single-tenant. Sharing one
  deploy across multiple humans means they all share the same project
  list, the same agent state, and the same auth credentials. Run
  separate deploys per user.
- **Filesystem mutations.** The agent's bash tool can delete or rename
  files outside the file browser's tracked diff view. The Last-Turn pane
  only surfaces `write`/`edit` tool results; bash-side `rm`/`mv` show up
  in the Git tab if the workspace is a git repo, and not at all
  otherwise.
- **Native module fragility.** `node-pty` requires a native binding that
  matches the Node major it runs against. Host installs may need a
  manual rebuild (`cd node_modules/node-pty && npx node-gyp rebuild`).
  The Docker image avoids this.

## Limitation of liability

To the maximum extent permitted by law:

- **No party** associated with this project (the maintainer, contributors,
  the GitHub organization, anyone listed in `git log`) is liable for any
  damages — direct, indirect, incidental, consequential, special, exemplary,
  or punitive — arising from or relating to your use of pi-workbench.
- This includes (without limitation): lost profits, lost data, business
  interruption, system damage, costs of substitute services, harm to
  third parties caused by the agent's actions, regulatory fines, and
  reputational harm.
- This limitation applies regardless of the legal theory (contract, tort,
  negligence, strict liability, etc.) and regardless of whether the
  damages were foreseeable.
- The MIT license's warranty disclaimer (cited at the top of this file)
  is the controlling text in case of any conflict.

## Indemnification (community expectation)

If you contribute to the project (open source PRs, file issues, etc.),
you do so under the terms of the MIT license and the project's
[CLA.md](./CLA.md). You retain copyright on your contributions; you grant
the project the necessary rights to redistribute them; and you confirm
your contribution is your own work or properly attributed.

If you operate pi-workbench in a way that causes harm to third parties
(e.g., the agent causes damage to systems you weren't authorized to
access), you alone are responsible for that harm. The project is not in
a position to indemnify you against the consequences.

## Changes

This document may be updated. Material changes will be noted in the release
notes. Past tagged releases retain whatever DISCLAIMER was current at
release time.
