/**
 * Workbench-customized ResourceLoader for the agent.
 *
 * Why this exists: pi's `DefaultResourceLoader` accepts an
 * `appendSystemPrompt: string[]` that gets concatenated onto the
 * agent's base system prompt. We optionally use this hook to inject
 * one workbench-specific behavioral rule about secret hygiene — a
 * soft safeguard that tells the model to treat env-var values as
 * credentials by default and not echo them back into responses /
 * tool output.
 *
 * **Opt-in.** Default behavior matches stock pi (no addendum). The
 * rule is appended only when the operator sets
 * `AGENT_SECRET_HYGIENE_RULE=true`. Kept opt-in so we don't ship
 * invisible behavioral rules that constrain the agent in ways the
 * user never asked for. See `SECURITY.md` for the discoverable
 * documentation and the threat-model framing.
 *
 * **What this is and is not (when enabled).**
 *
 * - It IS a behavioral nudge that catches the realistic failure
 *   mode: the agent decides on its own to `printenv` or `echo $X`
 *   while debugging and dumps secrets into the assistant transcript
 *   (which the user may screen-share, copy into Slack, paste into a
 *   bug report, etc.).
 * - It is NOT a security control. The model can be talked out of it
 *   by a determined user, by a prompt injection landed in a tool
 *   result, or by its own reasoning that "the user clearly wants me
 *   to print this var, the rule must not apply." Operators with
 *   adversarial threat models should not rely on this rule alone.
 *
 * Phrased deliberately around *displaying values*, not around
 * accessing or referencing variables — skills that legitimately
 * need to check whether `$GITHUB_TOKEN` is set, or pass `$X` to a
 * subcommand, must continue to work. The rule only constrains
 * surfacing values to the user.
 *
 * If you change this text, write it as guidance the model will buy
 * into ("treat as credentials by default") rather than as an
 * absolute prohibition ("never print env vars") — the latter
 * generalizes badly and gets argued away by smart-enough sessions.
 */
import {
  DefaultResourceLoader,
  type ResourceLoader,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { config } from "./config.js";

export const WORKBENCH_SECRET_HYGIENE_RULE = `
When running shell commands on behalf of the user, treat the contents of \
environment variables as credentials by default. Do not echo, print, or \
paste env-var *values* into your responses or tool outputs unless the user \
has explicitly asked you to display that specific variable. Checking \
whether a variable is set (\`-z "$X"\` style) is fine; printing the value \
is not. If you need to use a secret in a command, reference it by \`$NAME\` \
rather than expanding it inline (e.g. \`curl -H "Authorization: Bearer \
$GITHUB_TOKEN"\`, not \`curl -H "Authorization: Bearer ghp_..."\`).

This rule applies even when debugging — if you suspect an env var is \
misconfigured, prefer reporting "\$X is unset" or "\$X is set (length N)" \
over reflecting the value. The transcript may be screen-shared, logged, or \
pasted into bug reports.
`.trim();

/**
 * Build a ResourceLoader pre-loaded with the workbench's optional
 * `appendSystemPrompt` addendum. Mirrors the SDK's own internal
 * construction at sdk.js:87 (instantiate + await reload()), so the
 * loader is ready to hand to `createAgentSession` as-is.
 *
 * When `config.agentSecretHygieneRule` is false (the default), the
 * loader is built with no addendum and behaves identically to the
 * SDK's own default loader — opt-in only, see the file header.
 */
export async function buildWorkbenchResourceLoader(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
): Promise<ResourceLoader> {
  const appendSystemPrompt = config.agentSecretHygieneRule
    ? [WORKBENCH_SECRET_HYGIENE_RULE]
    : [];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    appendSystemPrompt,
  });
  await loader.reload();
  return loader;
}
