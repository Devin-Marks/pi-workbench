import { readFile } from "node:fs/promises";

import {
  completeSlashCommand,
  fuzzyFilterSlashCommands,
  fuzzyMatch,
} from "../packages/client/src/lib/slash-command-fuzzy.js";

let failures = 0;
function assert(label: string, ok: boolean): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
  }
}

const commands = [
  { name: "/compact" },
  { name: "/clear" },
  { name: "/skill:code-review" },
  { name: "/skill:commit" },
];

assert(
  "matches non-consecutive command-name characters",
  fuzzyFilterSlashCommands(commands, "cpt")
    .map((command) => command.name)
    .join(",") === "/compact",
);
assert(
  "ranks exact command names ahead of partial matches",
  fuzzyFilterSlashCommands(commands, "clear")[0]?.name === "/clear",
);
assert(
  "uses case-insensitive matching and preserves catalog order for an empty query",
  fuzzyFilterSlashCommands(commands, "CR")[0]?.name === "/skill:code-review" &&
    fuzzyFilterSlashCommands(commands, "")
      .map((command) => command.name)
      .join(",") === commands.map((command) => command.name).join(","),
);
assert("supports Console numeric-alpha query normalization", fuzzyMatch("2fa", "fa2").matches);
assert(
  "returns no match when all query characters are unavailable",
  fuzzyFilterSlashCommands(commands, "xyz").length === 0,
);
assert("completion appends a trailing space", completeSlashCommand("/compact") === "/compact ");

const chatInputSource = await readFile(
  new URL("../packages/client/src/components/ChatInput.tsx", import.meta.url),
  "utf8",
);
const plainTabHandler = chatInputSource.match(
  /if \(e\.key === "Tab" && !e\.metaKey && !e\.ctrlKey && !e\.shiftKey && !e\.altKey\) \{\s*e\.preventDefault\(\);\s*slashCompleteSelected\(\);\s*return;\s*\}/s,
)?.[0];

assert(
  "plain Tab completes and never dispatches the selected command",
  plainTabHandler !== undefined && !plainTabHandler.includes("slashRunSelected"),
);
assert(
  "completion restores the caret after the trailing space",
  /const slashCompleteSelected = \(\): void => \{[\s\S]*?setSelectionRange\(insert\.length, insert\.length\);/.test(
    chatInputSource,
  ),
);
assert(
  "Enter retains selected-command dispatch semantics",
  /if \(e\.key === "Enter"\) \{[\s\S]*?slashRunSelected\(\);/.test(chatInputSource),
);
assert(
  "palette clicks retain indexed command dispatch semantics",
  chatInputSource.includes("slashRunSelected(i);"),
);
assert(
  "completion guards unavailable or removed selected commands",
  /const cmd = slashFiltered\[slashSelectedIdx\];\s*if \(cmd === undefined \|\| !cmd\.available\) return;/.test(
    chatInputSource,
  ),
);
assert(
  "query changes reset selection and catalog changes clamp it to a valid index",
  /useEffect\(\(\) => \{\s*setSlashSelectedIdx\(0\);\s*\}, \[slashQuery\]\);[\s\S]*?setSlashSelectedIdx\(\(idx\) => Math\.min\(idx, Math\.max\(slashFiltered\.length - 1, 0\)\)\);/.test(
    chatInputSource,
  ),
);

if (failures > 0) {
  console.log(`\n[test-slash-command-fuzzy] FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n[test-slash-command-fuzzy] PASS");
