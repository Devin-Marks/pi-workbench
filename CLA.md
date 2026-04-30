# Contributor License Agreement

This Contributor License Agreement ("CLA") describes the terms under which
contributions to pi-workbench are accepted. By submitting a contribution
(commit, pull request, patch, documentation change, design asset, etc.) you
represent and agree to the terms below.

## Why this exists

The MIT [LICENSE](./LICENSE) governs end-user use of the project. The CLA
governs the relationship between **contributors** and the project. Without
a CLA, the project has only an implicit license to your contribution
(under the doctrine of inbound = outbound), which is enough for most uses
but creates ambiguity about provenance, the right to relicense in the
future, and dual-licensing.

The pi-workbench CLA is permissive — it grants the project the rights it
needs to redistribute your work, without taking copyright from you and
without giving the maintainer rights you didn't intend.

## Who needs to sign

- **Anyone submitting a non-trivial contribution.** "Non-trivial" is the
  threshold a court would treat as copyrightable: anything beyond a typo
  fix or a one-line change.
- **Including:** code, tests, documentation, build configuration,
  Dockerfiles, CI workflows, design assets, and any other material
  reproduced or derived in the project repository.
- **Excluding:** typo fixes, formatting-only changes, dependency-version
  bumps that don't add or remove dependencies, and other changes too
  small to attract independent copyright protection.

If you're unsure whether your contribution requires sign-off, default to
signing — it costs nothing and avoids questions later.

## How to sign

Append the following line to the commit message of your first
contribution:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds this automatically. By including this line, you
certify that the contribution complies with the
[Developer Certificate of Origin (DCO)](https://developercertificate.org/)
v1.1 AND with the additional terms in this document.

The DCO certifies that:

> 1. The contribution was created in whole or in part by you and you have
>    the right to submit it under the open source license indicated in
>    the file; or
>
> 2. The contribution is based upon previous work that, to the best of
>    your knowledge, is covered under an appropriate open source license
>    and you have the right under that license to submit that work with
>    modifications, whether created in whole or in part by you, under
>    the same open source license (unless you are permitted to submit
>    under a different license), as indicated in the file; or
>
> 3. The contribution was provided directly to you by some other person
>    who certified (1), (2) or (3) and you have not modified it.
>
> 4. You understand and agree that this project and the contribution are
>    public and that a record of the contribution (including all
>    personal information you submit with it, including your sign-off)
>    is maintained indefinitely and may be redistributed consistent with
>    this project or the open source license(s) involved.

## Additional terms

In addition to the DCO, by submitting a contribution you agree to the
following:

### 1. Copyright

You retain copyright on your contribution. Granting the project the rights
in section 2 does not transfer your copyright.

### 2. License grant to the project

You grant the pi-workbench project (and through it, every recipient of the
project) a perpetual, worldwide, non-exclusive, no-charge, royalty-free,
irrevocable license to:

- Reproduce, prepare derivative works of, publicly display, publicly
  perform, sublicense, and distribute your contribution
- Distribute your contribution under the project's then-current open
  source license (currently MIT)
- Distribute your contribution under any future open source license the
  maintainer chooses, provided that license is approved by the
  [Open Source Initiative](https://opensource.org/licenses) at the time
  of the relicense

This grant includes a patent license: if any of your patents read on your
contribution, you grant a patent license to the project under the same
terms as the copyright license above. If you initiate patent litigation
alleging that the project (or a contribution to it) infringes your
patents, the patent license you granted terminates as of the date of
litigation.

### 3. Original work / right to submit

You represent that:

- The contribution is your original work, OR
- The contribution is properly attributed to its original author and is
  submitted under a license compatible with MIT (you must include the
  original copyright notice + license text in the contribution)
- You have the right to grant the licenses above (e.g., your employer
  has not asserted ownership over the work, or has explicitly granted
  you permission to contribute it)

If your employer owns IP rights in code you write, get their sign-off
before contributing. If you're contributing on behalf of an employer,
substitute "the entity I represent" for "you" / "your" throughout this
document and have an authorized representative confirm.

### 4. No warranty

You provide your contribution "AS IS", without warranty of any kind. See
the project [LICENSE](./LICENSE) and [DISCLAIMER](./DISCLAIMER.md) for
the warranty position generally.

### 5. No obligation to merge

The maintainer is not obligated to accept any contribution. Submitting a
contribution doesn't entitle you to a merge, a code review, or a
specific response time. Most PRs are reviewed within a week, but there
are no guarantees.

## Withdrawing a contribution

You cannot withdraw a contribution once it has been merged. The license
grants in section 2 are irrevocable so the project can be relied upon by
its users. You can, however:

- Open a PR to remove your contribution if it's no longer needed
- Request the maintainer remove personal information (email, name) from
  commit metadata in line with GDPR / CCPA subject rights, where
  applicable. Note that this requires rewriting git history, which is
  disruptive and only done for genuine privacy reasons.

## Changes to this CLA

This document may be updated. Material changes that affect the rights
granted under section 2 do not retroactively apply to past
contributions — those remain governed by the version of the CLA in
effect at the time of the contribution.

The current version of this CLA is the one in `main` at the SHA of your
contribution.

## Questions

Open a public issue tagged `cla-question`, or reach out per
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) if your question involves
employer ownership or other private context.
