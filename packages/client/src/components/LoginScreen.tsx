import { useState, type FormEvent } from "react";
import { useAuthStore } from "../store/auth-store";

export function LoginScreen() {
  const [password, setPassword] = useState("");
  const login = useAuthStore((s) => s.login);
  const pending = useAuthStore((s) => s.loginPending);
  const error = useAuthStore((s) => s.loginError);

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (password.length === 0) return;
    void login(password);
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-lg"
      >
        <header className="space-y-1">
          <div className="flex items-center gap-2">
            <img src="/icons/icon.svg" alt="" className="h-6 w-6" aria-hidden="true" />
            <h1 className="text-xl font-semibold tracking-tight">pi-forge</h1>
          </div>
          <p className="text-sm text-neutral-400">Enter the workbench password to continue.</p>
        </header>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-neutral-300">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </label>
        {error !== undefined && (
          <p role="alert" className="text-sm text-red-400">
            {error === "invalid_password" ? "Incorrect password." : `Login failed: ${error}`}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || password.length === 0}
          className="w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
