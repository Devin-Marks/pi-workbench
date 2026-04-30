# Acceptable Use Policy

This Acceptable Use Policy ("AUP") describes the kinds of use of pi-workbench
that the project supports versus the kinds it explicitly does not. It is a
companion to the [LICENSE](./LICENSE) (MIT, which permits broad use) and the
[DISCLAIMER](./DISCLAIMER.md) (which limits warranty and liability). The
license still governs your legal rights; this document describes the
project's stance on use cases as a community matter.

## What this document is not

- **Not a contract.** The MIT license has no AUP teeth — there is no central
  service operator who can revoke your access. This document expresses the
  project's intent and the maintainer's expectation of good-faith use.
- **Not a moderation policy for the maintainer's hosted services.** The
  project ships software you self-host. There is no upstream service to
  moderate.
- **Not legal advice.** Consult counsel for jurisdiction-specific compliance
  (data protection laws, export controls, sector-specific regulations).

## Who this applies to

This AUP applies to:

1. Operators self-hosting pi-workbench (the people running the container)
2. End-users interacting with a pi-workbench deploy (typically the same
   person, since pi-workbench is single-tenant)
3. Contributors submitting code or documentation

## Permitted use

pi-workbench is a development tool. It is built for and supports:

- **Personal coding projects** — running an LLM coding agent against your own
  source repositories on your own hardware or container infrastructure.
- **Professional software engineering** — using the agent for code review,
  refactoring, debugging, and ordinary software development work.
- **Education and research** — teaching students about LLM tool use, agent
  architectures, prompt engineering, and the operational concerns of
  self-hosted AI infrastructure.
- **Internal tooling** at companies that have completed their own legal,
  security, and data-protection review.
- **Forking, modifying, and redistributing** the source under MIT terms.

## Use the project does not support

The project asks you not to use pi-workbench to:

- **Generate content used to defraud, deceive, or impersonate** identifiable
  real people or organizations.
- **Generate or distribute material targeted at minors** in any context that
  would be unlawful in the operator's jurisdiction.
- **Develop or operate weapons systems** including autonomous targeting,
  chemical / biological / nuclear / radiological weapons design, or
  surveillance systems used to suppress lawful dissent.
- **Conduct attacks on systems you do not own or are not explicitly
  authorized to test.** The agent's `bash` tool is a real shell; using it
  to scan, exploit, or otherwise interfere with third-party systems
  without authorization may constitute a criminal offense in your
  jurisdiction (US: CFAA; UK: Computer Misuse Act; EU: NIS2-aligned
  national laws).
- **Operate critical infrastructure** (medical devices, transportation
  control, energy grids, financial settlement) where an LLM hallucination
  or a bash mishap could endanger life or property. The project is not
  designed, tested, or certified for safety-critical use.
- **Process regulated data** (PHI, PCI cardholder data, classified
  information) without your own compliance review. The project ships with
  no certifications.

## LLM provider terms

pi-workbench connects to upstream LLM providers (Anthropic, OpenAI, Google,
or anything OpenAI-API-compatible you wire up). Your use of those providers
is governed by their terms — not this project's. You are responsible for:

- **Reading and complying** with the provider's acceptable-use / usage
  policy. Most major providers prohibit categories beyond what this
  document lists (e.g., content moderation classes for Anthropic, OpenAI,
  Google).
- **Holding your own provider account** and credentials. Do not use API keys
  that don't belong to you, or share keys across users beyond what the
  provider permits.
- **Respecting rate limits** the provider sets. The agent's bash tool can
  burn tokens fast; configure provider quotas accordingly.

## Self-hosting responsibilities

Operators of a pi-workbench deploy are responsible for:

- **Securing the deploy** per [SECURITY.md](./SECURITY.md). Do not expose
  the HTTP surface to the public internet without TLS termination at a
  reverse proxy AND password / API-key auth enabled.
- **Backing up workspace data.** The workbench writes to mounted volumes;
  the project ships no backup tooling.
- **Auditing the agent's actions** if they have compliance obligations.
  The session JSONLs under `${SESSION_DIR}` contain a complete record of
  every prompt, response, and tool call.
- **Complying with local law** governing AI use, automated content
  generation, and software development.

## Reporting concerns

This is a self-hosted project — the maintainer cannot directly enforce the
AUP against your deploy. However:

- **If you observe a contributor violating this policy** (e.g., a PR that
  intentionally weakens safety controls, or a repository fork being
  marketed for prohibited use cases), open a private security advisory or
  email the maintainer per [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- **If you observe license violation** (e.g., redistribution stripping the
  copyright notice required by MIT), open a public issue.
- **The maintainer reserves the right** to refuse contributions, ban
  contributors, decline support requests, and decline to feature forks
  whose primary use case violates this policy.

## Changes

This AUP may evolve as the project grows. Material changes will be announced
in the release notes for the version that ships them. Continuing to use the
project after a change indicates acceptance of the updated terms (subject to
your right under MIT to fork and continue using any prior version).
