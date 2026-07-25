import assert from "node:assert/strict";
import {
  publishSessionActivity,
  subscribeSessionActivity,
  type SessionActivity,
} from "../packages/server/src/session-activity.js";

const received: SessionActivity[] = [];
const unsubscribe = subscribeSessionActivity((activity) => received.push(activity));
publishSessionActivity({ sessionId: "session-1", projectId: "project-1", running: true });
unsubscribe();
publishSessionActivity({ sessionId: "session-1", projectId: "project-1", running: false });

assert.deepEqual(received, [{ sessionId: "session-1", projectId: "project-1", running: true }]);
console.log("Session activity tests passed.");
