---
name: Bug report
about: Something isn't working the way the docs say it should
title: "bug: <short summary>"
labels: bug
assignees: ''
---

## What happened

<!-- One or two sentences. What did you do, what did you expect, what
happened instead? -->

## Steps to reproduce

1.
2.
3.

## Expected vs actual

- **Expected:**
- **Actual:**

## Environment

- pi-forge version / commit SHA:
- Install method: [ ] Docker compose  [ ] `npm run dev`  [ ] Kubernetes  [ ] other:
- Host OS + version:
- Node version (if running outside Docker): `node --version`
- Browser + version (if a UI bug):
- Provider being used (Anthropic / OpenAI / custom OpenAI-compatible / ...):
- Model being used:

## Logs / screenshots

<!-- Server logs (`docker compose logs pi-forge` or your terminal),
browser devtools console output, screenshots — whatever helps.

PLEASE redact API keys, JWTs, and any private code or paths before
pasting. The maintainers cannot un-see what you post here. -->

```
<paste relevant logs here>
```

## Additional context

<!-- Anything else: was this working in a previous version? Does it only
happen for some sessions / projects / models? Any local patches applied? -->

---

### Before submitting

- [ ] I searched [open and closed issues](https://github.com/Devin-Marks/pi-forge/issues?q=) for duplicates
- [ ] I redacted API keys, tokens, and private code from logs/screenshots
- [ ] If this is a security vulnerability, I am using the [private vulnerability reporting](../../security/advisories/new) flow instead — see [`SECURITY.md`](../../SECURITY.md)
