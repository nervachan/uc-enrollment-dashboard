import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError, type IngestResult, type ValidationResult } from "../lib/api";
import { sendSignInLink, signOut, useSession } from "../lib/auth";
import { formatNumber } from "../lib/format";

type Stage = "pick" | "checked" | "loaded";

/** A term's export is tens of megabytes; a two-row test file is not. Show both honestly. */
function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(Math.round(bytes / 1024), 1)} KB`;
}

/**
 * The upload desk: sign in with an emailed link, drop a term's CSV, see what the server
 * makes of it, then commit.
 *
 * Dropping a file checks it straight away (a dry run that writes nothing). The
 * registrar's export is 158k rows and a bad column drops silently if nobody looks, so
 * the panel refuses to offer the Load button until it has shown how many rows will be
 * refused and why.
 */
export function UploadPanel({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();

  const { session, loading: sessionLoading } = useSession();
  const [email, setEmail] = useState("");
  const [linkSent, setLinkSent] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("pick");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<ValidationResult | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [dragging, setDragging] = useState(false);

  const batches = useQuery({ queryKey: ["batches"], queryFn: api.batches });

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  function pick(next: File | null) {
    setFile(next);
    setStage("pick");
    setCheck(null);
    setResult(null);
    setError(null);
    if (next && session) void run("check", next);
  }

  async function requestLink() {
    setBusy(true);
    setError(null);
    try {
      await sendSignInLink(email);
      setLinkSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function run(step: "check" | "load", target: File | null = file) {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      if (step === "check") {
        setCheck(await api.validateUpload(target));
        setStage("checked");
      } else {
        const loaded = await api.ingestUpload(target);
        setResult(loaded);
        setStage("loaded");
        // Every number on the page is now stale.
        await queryClient.invalidateQueries();
      }
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.status === 401
            ? "Your sign-in has expired. Sign out and request a new link."
            : caught.message
          : String(caught);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      className="m-auto w-[min(44rem,92vw)] rounded-xl border border-[var(--color-hairline)] bg-[var(--color-surface)] p-0 text-[var(--color-ink)] backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-[var(--color-hairline)] px-5 py-3">
        <h2 className="text-sm font-semibold">Load a term&rsquo;s enrollment export</h2>
        <button
          type="button"
          onClick={() => dialog.current?.close()}
          className="rounded-lg px-2 py-1 text-xs text-[var(--color-ink-2)] hover:bg-[var(--color-grid)]"
        >
          Close
        </button>
      </div>

      <div className="space-y-4 px-5 py-4">
        {sessionLoading ? null : session ? (
          <p className="flex items-center justify-between text-xs text-[var(--color-ink-2)]">
            <span>
              Signed in as <strong>{session.user.email}</strong>. Uploads are recorded with
              this address.
            </span>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-lg px-2 py-1 hover:bg-[var(--color-grid)]"
            >
              Sign out
            </button>
          </p>
        ) : linkSent ? (
          <p role="status" className="rounded-lg border border-[var(--color-hairline)] px-3 py-2 text-sm">
            Sign-in link sent to <strong>{email.trim()}</strong>. Open it on this computer, then
            reopen this panel.
          </p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void requestLink();
            }}
            className="block"
          >
            <label className="block">
              <span className="text-xs font-medium text-[var(--color-ink-2)]">Your email</span>
              <span className="mt-1 flex gap-2">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@uc-bcf.edu.ph"
                  aria-label="Your email"
                  className="w-full rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                />
                <button
                  type="submit"
                  disabled={busy || !email.trim()}
                  className="shrink-0 rounded-lg border border-[var(--color-hairline)] px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  Email me a sign-in link
                </button>
              </span>
            </label>
            <span className="mt-1 block text-[11px] text-[var(--color-ink-muted)]">
              No password. Only addresses on the upload list can load data.
            </span>
          </form>
        )}

        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            pick(event.dataTransfer.files[0] ?? null);
          }}
          data-testid="dropzone"
          className={`rounded-xl border border-dashed px-4 py-6 text-center ${
            dragging
              ? "border-[var(--color-series-1)] bg-[var(--color-grid)]"
              : "border-[var(--color-hairline)]"
          }`}
        >
          <p className="text-sm">
            {file ? (
              <span className="font-medium">
                {file.name}{" "}
                <span className="text-[var(--color-ink-muted)]">({fileSize(file.size)})</span>
              </span>
            ) : (
              "Drop the CSV here, or choose a file"
            )}
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="Enrollment CSV"
            disabled={!session}
            onChange={(event) => pick(event.target.files?.[0] ?? null)}
            className="mt-2 text-xs text-[var(--color-ink-2)] file:mr-2 file:rounded-lg file:border file:border-[var(--color-hairline)] file:bg-[var(--color-surface)] file:px-3 file:py-1 file:text-xs file:text-[var(--color-ink)]"
          />
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-grid)] px-3 py-2 text-sm"
          >
            {error}
          </p>
        ) : null}

        {check ? (
          <div className="rounded-lg border border-[var(--color-hairline)] px-3 py-2 text-sm">
            <p>
              <strong>{formatNumber(check.rows_valid)}</strong> rows will load,{" "}
              <strong>{formatNumber(check.rows_rejected)}</strong> refused, out of{" "}
              {formatNumber(check.rows_read)} read. Nothing has been written yet.
            </p>
            {check.ignored_columns.length ? (
              <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
                Columns ignored: {check.ignored_columns.join(", ")}
              </p>
            ) : null}
            {check.rejections.length ? (
              <ul className="mt-2 max-h-32 space-y-0.5 overflow-auto text-[11px] text-[var(--color-ink-2)]">
                {check.rejections.slice(0, 20).map((rejection) => (
                  <li key={`${rejection.row}-${rejection.reason}`}>
                    row {rejection.row}: {rejection.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {result ? (
          <div
            role="status"
            className="rounded-lg border border-[var(--color-series-1)] px-3 py-2 text-sm"
          >
            <p>
              Batch {result.batch_id}: <strong>{formatNumber(result.rows_inserted)}</strong> rows
              added, {formatNumber(result.rows_duplicate)} already present,{" "}
              {formatNumber(result.rows_rejected)} refused.
            </p>
            {result.unmatched_municipalities.length ? (
              <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
                No polygon matched {result.unmatched_municipalities.length} origin(s), including{" "}
                {result.unmatched_municipalities[0].municity}. They count in the totals but not on
                the map.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!file || !session || busy}
            onClick={() => run("check")}
            className="rounded-lg border border-[var(--color-hairline)] px-3 py-1.5 text-xs disabled:opacity-40"
          >
            {busy && stage === "pick" ? "Checking…" : "Check file"}
          </button>
          <button
            type="button"
            disabled={stage !== "checked" || busy || (check?.rows_valid ?? 0) === 0}
            onClick={() => run("load")}
            className="rounded-lg bg-[var(--color-series-1)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {busy && stage === "checked"
              ? "Loading…"
              : `Load ${formatNumber(check?.rows_valid ?? 0)} rows`}
          </button>
          <span className="text-[11px] text-[var(--color-ink-muted)]">
            Re-loading a file already loaded adds nothing.
          </span>
        </div>

        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--color-ink-2)]">Load history</summary>
          <table className="mt-2 w-full text-left text-[11px]">
            <thead className="text-[var(--color-ink-muted)]">
              <tr>
                <th className="py-1">File</th>
                <th>Loaded</th>
                <th className="text-right">Read</th>
                <th className="text-right">Added</th>
                <th className="text-right">Refused</th>
              </tr>
            </thead>
            <tbody>
              {(batches.data ?? []).slice(0, 10).map((batch) => (
                <tr key={batch.id} className="border-t border-[var(--color-hairline)]">
                  <td className="truncate py-1">{batch.filename}</td>
                  <td>{new Date(batch.loaded_at).toLocaleDateString()}</td>
                  <td className="text-right tabular-nums">{formatNumber(batch.rows_read)}</td>
                  <td className="text-right tabular-nums">{formatNumber(batch.rows_loaded)}</td>
                  <td className="text-right tabular-nums">{formatNumber(batch.rows_rejected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </dialog>
  );
}
