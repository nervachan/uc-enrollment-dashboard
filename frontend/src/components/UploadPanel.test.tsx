import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { UploadPanel } from "./UploadPanel";

// jsdom has no <dialog> implementation. A no-op stub is not enough: without the `open`
// attribute the dialog's contents count as hidden and every query inside it fails.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UploadPanel onClose={() => {}} />
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200) {
  // Both shapes are needed: the upload calls read text() so they can surface the API's
  // own error message, while the plain GETs read json().
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

const CHECK = {
  filename: "term.csv",
  rows_read: 100,
  rows_valid: 98,
  rows_rejected: 2,
  ignored_columns: ["RELIGION"],
  rejections: [{ row: 7, reason: "term 9 out of range 1-4" }],
};

const csv = () => new File(["USER_INDEX\n1\n"], "term.csv", { type: "text/csv" });

async function pickFile(user: ReturnType<typeof userEvent.setup>, key = "k") {
  await user.type(screen.getByLabelText("Upload key"), key);
  await user.upload(screen.getByLabelText("Enrollment CSV"), csv());
}

describe("UploadPanel", () => {
  it("cannot check a file before a key and a file are given", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    show();
    expect(screen.getByRole("button", { name: "Check file" })).toBeDisabled();
  });

  it("will not offer to load before the file has been checked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const user = userEvent.setup();
    show();
    await pickFile(user);
    expect(screen.getByRole("button", { name: "Check file" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Load/ })).toBeDisabled();
  });

  it("dry-runs first and reports what would be refused", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/validate") ? jsonResponse(CHECK) : jsonResponse([]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    show();
    await pickFile(user);
    await user.click(screen.getByRole("button", { name: "Check file" }));

    expect(await screen.findByText(/Nothing has been written yet/)).toBeInTheDocument();
    expect(screen.getByText(/row 7: term 9 out of range/)).toBeInTheDocument();
    expect(screen.getByText(/Columns ignored: RELIGION/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load 98 rows" })).toBeEnabled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/ingest"))).toBe(false);
  });

  it("sends the key as a header and loads on confirmation", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("/validate")) return jsonResponse(CHECK);
      if (String(url).endsWith("/api/ingest"))
        return jsonResponse({
          batch_id: 4,
          rows_read: 100,
          rows_inserted: 98,
          rows_duplicate: 0,
          rows_rejected: 2,
          unmatched_municipalities: [],
        });
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    show();
    await pickFile(user, "secret");
    await user.click(screen.getByRole("button", { name: "Check file" }));
    await user.click(await screen.findByRole("button", { name: "Load 98 rows" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Batch 4");
    const ingest = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/ingest"));
    const init = ingest?.[1] as unknown as RequestInit;
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("secret");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("will not offer to load a file with nothing valid in it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/validate")
          ? jsonResponse({ ...CHECK, rows_valid: 0, rows_rejected: 100 })
          : jsonResponse([]),
      ),
    );
    const user = userEvent.setup();
    show();
    await pickFile(user);
    await user.click(screen.getByRole("button", { name: "Check file" }));
    expect(await screen.findByRole("button", { name: "Load 0 rows" })).toBeDisabled();
  });

  it("explains a disabled ingest endpoint rather than showing a raw 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/validate")
          ? jsonResponse({ detail: "ingest is disabled: INGEST_API_KEY is not set" }, 503)
          : jsonResponse([]),
      ),
    );
    const user = userEvent.setup();
    show();
    await pickFile(user);
    await user.click(screen.getByRole("button", { name: "Check file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/switched off/);
  });

  it("says plainly when the key is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/validate")
          ? jsonResponse({ detail: "invalid or missing X-API-Key" }, 401)
          : jsonResponse([]),
      ),
    );
    const user = userEvent.setup();
    show();
    await pickFile(user, "wrong");
    await user.click(screen.getByRole("button", { name: "Check file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That key was refused.");
  });

  it("surfaces the API's own message for a bad header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/validate")
          ? jsonResponse({ detail: "missing required column(s): COURSE" }, 422)
          : jsonResponse([]),
      ),
    );
    const user = userEvent.setup();
    show();
    await pickFile(user);
    await user.click(screen.getByRole("button", { name: "Check file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("missing required column(s): COURSE");
  });

  it("keeps the key for the tab but not beyond it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const user = userEvent.setup();
    show();
    await user.type(screen.getByLabelText("Upload key"), "remembered");
    await waitFor(() => expect(sessionStorage.getItem("uc-ingest-key")).toBe("remembered"));
    expect(localStorage.getItem("uc-ingest-key")).toBeNull();
  });

  it("re-checking a newly chosen file clears the previous verdict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/validate") ? jsonResponse(CHECK) : jsonResponse([]),
      ),
    );
    const user = userEvent.setup();
    show();
    await pickFile(user);
    await user.click(screen.getByRole("button", { name: "Check file" }));
    expect(await screen.findByText(/Nothing has been written yet/)).toBeInTheDocument();

    await user.upload(screen.getByLabelText("Enrollment CSV"), csv());
    expect(screen.queryByText(/Nothing has been written yet/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load 0 rows" })).toBeDisabled();
  });

  it("shows the load history", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse([
        {
          id: 1,
          filename: "Data for dashboard.csv",
          loaded_at: "2026-10-12T09:26:54Z",
          rows_read: 158101,
          rows_loaded: 158098,
          rows_rejected: 0,
          note: null,
        },
      ]),
    ));
    show();
    expect(await screen.findByText("Data for dashboard.csv")).toBeInTheDocument();
    expect(screen.getByText("158,098")).toBeInTheDocument();
  });
});

describe("file size display", () => {
  it("shows small files in KB rather than as 0.0 MB", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const user = userEvent.setup();
    show();
    await user.upload(screen.getByLabelText("Enrollment CSV"), csv());
    expect(screen.getByText(/\(1 KB\)/)).toBeInTheDocument();
  });

  it("shows a term-sized file in MB", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const user = userEvent.setup();
    show();
    const big = new File(["x".repeat(36 * 1024 * 1024)], "term.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Enrollment CSV"), big);
    expect(screen.getByText(/\(36\.0 MB\)/)).toBeInTheDocument();
  });
});
