import type { GitLogEntry } from "./api-client";

/**
 * Per-row layout info computed once for the whole log. The renderer
 * consumes this to draw a `git log --graph`-style column to the
 * left of each commit.
 *
 * `lane` is the column the commit's dot lives on. `incomingLanes`
 * are columns coming in from the row above (lanes that were tracking
 * this commit as a parent and are now consumed). `outgoingLanes` is
 * the post-commit set of "(lane index, expected parent hash)" pairs;
 * the renderer uses it to draw the lines that descend out of this
 * row into the next.
 *
 * `throughLanes` is the subset of lanes that pass STRAIGHT through
 * this row (started above, end below, neither created nor consumed
 * here). The renderer draws a full-height vertical line for each.
 */
export interface CommitLayout {
  hash: string;
  /** Column the commit dot sits on. */
  lane: number;
  /** Lanes that joined into this commit (drawn as edges from above). */
  incomingLanes: number[];
  /** Lanes carrying onward (from this row to the next), with the parent hash they track. */
  outgoingLanes: { lane: number; parent: string }[];
  /** Lanes that pass through this row without being created or consumed. */
  through: number[];
  /** Total lane count needed to render this row (incl. all of the above). */
  width: number;
}

/**
 * Walk the commit list (already in newest-first order from `git log`)
 * and assign each commit to a lane. Implements the standard git-graph
 * lane algorithm:
 *
 * Maintain `activeLanes`: a sparse array where each slot stores the
 * commit hash the lane is "expecting" to encounter next (i.e. an
 * unsatisfied parent reference). When we walk a commit:
 *   1. Pick the lane whose expected hash matches this commit (the
 *      leftmost match if multiple — handles the merge-into case).
 *      If none matches, allocate a new lane (leftmost empty slot).
 *   2. Collect every other lane expecting this commit — those are
 *      "incoming" merge lanes that consume here.
 *   3. After the dot, the commit's lane swaps to track its FIRST
 *      parent; additional parents (merges) start new lanes (or
 *      reuse existing ones expecting that parent).
 *   4. Compress trailing empty lanes.
 *
 * The result is a stable, narrow layout for typical histories and
 * a correct (if wider) layout for parallel branches.
 */
export function layoutCommits(commits: readonly GitLogEntry[]): CommitLayout[] {
  // Mutable lane state — `undefined` slots are "free" (available
  // to reuse). Compressed periodically so we don't grow forever.
  const activeLanes: (string | undefined)[] = [];
  const out: CommitLayout[] = [];

  for (const commit of commits) {
    // Snapshot the lane state BEFORE we mutate, so we can compute
    // "through" lanes accurately afterwards. Through = "active before
    // AND not this commit's own lane AND not consumed by this commit".
    const before = activeLanes.slice();

    // 1. Assign this commit's lane.
    let lane = activeLanes.findIndex((p) => p === commit.hash);
    if (lane === -1) {
      // No incoming branch is tracking this commit — it's a tip.
      lane = activeLanes.findIndex((p) => p === undefined);
      if (lane === -1) {
        lane = activeLanes.length;
        activeLanes.push(undefined);
      }
    }

    // 2. Incoming lanes: every lane (including `lane` itself) that
    //    pointed at this commit as a parent. These render as edges
    //    from above to the dot, and are consumed (cleared) here.
    const incomingLanes: number[] = [];
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === commit.hash) {
        incomingLanes.push(i);
      }
    }
    // Clear the consumed lanes BEFORE we re-occupy them with parents
    // — otherwise the findIndex below could see a stale match.
    for (const i of incomingLanes) activeLanes[i] = undefined;

    // 3. Outgoing: assign each parent to a lane.
    //    First parent stays in this commit's lane.
    //    Additional parents (merge inputs) reuse existing lanes that
    //    already track them, OR claim a free slot, OR extend.
    const outgoingLanes: { lane: number; parent: string }[] = [];
    if (commit.parents.length > 0) {
      const firstParent = commit.parents[0]!;
      activeLanes[lane] = firstParent;
      outgoingLanes.push({ lane, parent: firstParent });
    }
    for (let p = 1; p < commit.parents.length; p++) {
      const parent = commit.parents[p]!;
      // Already tracked elsewhere? Don't double-assign.
      let pLane = activeLanes.findIndex((x) => x === parent);
      if (pLane === -1) {
        pLane = activeLanes.findIndex((x) => x === undefined);
        if (pLane === -1) {
          pLane = activeLanes.length;
          activeLanes.push(undefined);
        }
        activeLanes[pLane] = parent;
      }
      outgoingLanes.push({ lane: pLane, parent });
    }

    // 4. Compress trailing empties.
    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === undefined) {
      activeLanes.pop();
    }

    // through: lanes that were populated BEFORE this row AND aren't
    // either consumed by this commit or this commit's own lane. They
    // pass straight through, drawn as a full-height vertical line.
    const through: number[] = [];
    for (let i = 0; i < before.length; i++) {
      if (before[i] === undefined) continue;
      if (i === lane) continue;
      if (incomingLanes.includes(i)) continue;
      through.push(i);
    }

    // Through lanes ARE preserved in activeLanes (they survive the
    // mutation pass), so `activeLanes.length` already covers them.
    // Including `through` in the Math.max anyway as defense-in-depth:
    // a future refactor could decide to compress interior empties or
    // drop a through lane from activeLanes for some reason, and the
    // SVG would silently truncate without this guard.
    const width = Math.max(
      lane + 1,
      activeLanes.length,
      ...incomingLanes.map((i) => i + 1),
      ...outgoingLanes.map((o) => o.lane + 1),
      ...through.map((i) => i + 1),
    );
    out.push({ hash: commit.hash, lane, incomingLanes, outgoingLanes, through, width });
  }
  return out;
}

/**
 * Pick a stable color for a lane. Hash-based — same lane number
 * always picks the same swatch. The palette stays inside the dark
 * theme's mid-saturation range so foreground text isn't washed out.
 */
const LANE_PALETTE = [
  "#a5b4fc", // indigo-300 — dot for lane 0 (most common: trunk)
  "#fde047", // yellow-300
  "#a3e635", // lime-400
  "#f472b6", // pink-400
  "#67e8f9", // cyan-300
  "#fb923c", // orange-400
  "#c084fc", // purple-400
  "#86efac", // green-300
];

export function laneColor(lane: number): string {
  return LANE_PALETTE[lane % LANE_PALETTE.length] ?? "#a5b4fc";
}
