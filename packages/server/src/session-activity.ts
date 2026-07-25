export interface SessionActivity {
  sessionId: string;
  projectId: string;
  running: boolean;
}

type Listener = (activity: SessionActivity) => void;

const listeners = new Set<Listener>();

export function subscribeSessionActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishSessionActivity(activity: SessionActivity): void {
  for (const listener of listeners) listener(activity);
}
