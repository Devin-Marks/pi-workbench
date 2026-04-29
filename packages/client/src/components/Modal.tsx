import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";

/**
 * Visual primitive for modal dialogs. Replaces the built-in
 * `window.prompt` / `window.confirm` calls that some browser configs
 * intercept and that look nothing like the rest of the app.
 *
 * Behaviour:
 *  - Esc closes (calls `onClose`).
 *  - Click on the backdrop closes.
 *  - Click on the dialog body does NOT close.
 *  - Focus moves to the first focusable element inside on open;
 *    Tab-cycles within the dialog (basic trap, sufficient for our
 *    single-input + two-button dialogs).
 *  - Renders inline (no Portal) — the app shell is full-screen
 *    `flex h-screen` so a `fixed inset-0` overlay reliably covers it.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  width = "max-w-sm",
  initialFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  /**
   * Optional ref to the element that should receive focus when the
   * dialog opens. When omitted, focus moves to the first focusable
   * descendant — but the close-X is usually that, which is rarely
   * what callers want. PromptDialog passes its input ref here.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Stash the latest `onClose` and `initialFocusRef` in refs so the
  // mount-time effect doesn't depend on them. Without this, callers
  // who pass an inline arrow (`onClose={() => setOpen(false)}`) — the
  // common case — give us a NEW function reference every render. With
  // those props in the dep array, every keystroke that re-renders
  // the parent retriggers our effect: cleanup steals focus back to
  // the trigger, then setTimeout re-focuses the first focusable
  // (the header X), so the user types one char then loses focus to
  // the close button. Refs let us read the latest callback inside
  // the handler without forcing the effect to re-run.
  const onCloseRef = useRef(onClose);
  const initialFocusRefRef = useRef(initialFocusRef);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    initialFocusRefRef.current = initialFocusRef;
  });

  useEffect(() => {
    if (!open) return undefined;
    // Capture the trigger so we can restore focus to it on close —
    // standard a11y pattern, keeps keyboard users on the same row of
    // the UI they just acted on. Also snapshot the dialog DOM node
    // here so the cleanup contains() check still works after React
    // has cleared the ref on unmount.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialogNode = dialogRef.current;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && dialogRef.current !== null) {
        // Tiny focus trap: collect focusable descendants, wrap the
        // selection at the boundaries. Good enough for our dialogs;
        // not a fully spec-compliant trap.
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    // Initial focus: prefer the caller-provided ref (input field for
    // PromptDialog) over "first focusable" — which would land on the
    // header X button and require Tab before the user could type.
    const id = window.setTimeout(() => {
      const focusTarget = initialFocusRefRef.current?.current;
      if (focusTarget !== undefined && focusTarget !== null) {
        focusTarget.focus();
        return;
      }
      const first = dialogRef.current?.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
    }, 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(id);
      // Restore focus only if it's still inside our dialog. If the
      // user clicked elsewhere on the page since open, don't yank
      // their focus back.
      if (
        previouslyFocused !== null &&
        document.contains(previouslyFocused) &&
        dialogNode !== null &&
        dialogNode.contains(document.activeElement)
      ) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        ref={dialogRef}
        className={`w-full ${width} rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
          <h2 id={titleId} className="text-sm font-medium text-neutral-100">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title="Close (Esc)"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/**
 * Text-input prompt. Replaces `window.prompt(message)`. Calls
 * `onSubmit` with the trimmed value when the user hits Enter or
 * clicks the primary button; calls `onClose` on Esc / backdrop /
 * Cancel. Empty submissions are blocked by disabling the primary
 * button.
 */
export function PromptDialog({
  open,
  onClose,
  onSubmit,
  title,
  label,
  initialValue = "",
  placeholder,
  primaryLabel = "OK",
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (value: string) => void;
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  primaryLabel?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the draft each time the dialog opens.
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const trimmed = value.trim();
  const submit = (): void => {
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
  };

  return (
    <Modal open={open} onClose={onClose} title={title} initialFocusRef={inputRef}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3 px-4 py-3"
      >
        <label className="block space-y-1.5">
          <span className="text-xs text-neutral-300">{label}</span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 outline-none focus:border-neutral-500"
          />
        </label>
        <footer className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={trimmed.length === 0}
            className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {primaryLabel}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/**
 * Confirmation dialog. Replaces `window.confirm(message)`. The
 * `tone="danger"` variant red-tints the primary button — used for
 * destructive operations (delete, etc.).
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  primaryLabel = "Confirm",
  tone = "default",
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  primaryLabel?: string;
  tone?: "default" | "danger";
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-3 px-4 py-3">
        <p className="text-xs text-neutral-300">{message}</p>
        <footer className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              tone === "danger"
                ? "rounded-md bg-red-700 px-3 py-1 text-xs font-medium text-red-50 hover:bg-red-600"
                : "rounded-md bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-white"
            }
          >
            {primaryLabel}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
