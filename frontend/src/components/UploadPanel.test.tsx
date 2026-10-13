import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";

import { api, ApiError, type ValidationResult } from "../lib/api";
import { sendSignInLink, useSession } from "../lib/auth";
import { UploadPanel } from "./UploadPanel";

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: { batches: vi.fn(), validateUpload: vi.fn(), ingestUpload: vi.fn() },
}));
vi.mock("../lib/auth", () => ({
  useSession: vi.fn(),
  sendSignInLink: vi.fn(),
  signOut: vi.fn(),
}));

const SIGNED_IN = {
  session: { user: { email: "registrar@uc-bcf.edu.ph" } } as Session,
  loading: false,
};
const SIGNED_OUT = { session: null, loading: false };

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
  vi.mocked(api.batches).mockResolvedValue([]);
  vi.mocked(useSession).mockReturnValue(SIGNED_IN);
});

afterEach(() => {
  vi.resetAllMocks();
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UploadPanel onClose={() => {}} />
    </QueryClientProvider>,
  );
}

const CHECK: ValidationResult = {
  filename: "term.csv",
  rows_read: 100,
  rows_valid: 98,
  rows_rejected: 2,
  ignored_columns: ["RELIGION"],
  rejections: [{ row: 7, reason: "term 9 out of range 1-4" }],
};

const csv = () => new File(["USER_INDEX\n1\n"], "term.csv", { type: "text/csv" });

async function pickFile(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText("Enrollment CSV"), csv());
}

describe("UploadPanel — signing in", () => {
  it("asks for an email and keeps the file picker shut until signed in", () => {
    vi.mocked(useSession).mockReturnValue(SIGNED_OUT);
    show();
    expect(screen.getByLabelText("Your email")).toBeInTheDocument();
    expect(screen.getByLabelText("Enrollment CSV")).toBeDisabled();
    expect(screen.queryByLabelText("Upload key")).not.toBeInTheDocument();
  });

  it("emails a sign-in link and says where it went", async () => {
    vi.mocked(useSession).mockReturnValue(SIGNED_OUT);
    vi.mocked(sendSignInLink).mockResolvedValue();
    const user = userEvent.setup();
    show();
    await user.type(screen.getByLabelText("Your email"), "registrar@uc-bcf.edu.ph");
    await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(sendSignInLink).toHaveBeenCalledWith("registrar@uc-bcf.edu.ph");
    expect(await screen.findByRole("status")).toHaveTextContent("Sign-in link sent");
  });

  it("shows who is signed in", () => {
    show();
    expect(screen.getByText("registrar@uc-bcf.edu.ph")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

describe("UploadPanel — loading a file", () => {
  it("checks a file as soon as it is chosen, and reports what would be refused", async () => {
    vi.mocked(api.validateUpload).mockResolvedValue(CHECK);
    const user = userEvent.setup();
    show();
    await pickFile(user);

    expect(await screen.findByText(/Nothing has been written yet/)).toBeInTheDocument();
    expect(screen.getByText(/row 7: term 9 out of range/)).toBeInTheDocument();
    expect(screen.getByText(/Columns ignored: RELIGION/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load 98 rows" })).toBeEnabled();
    expect(api.ingestUpload).not.toHaveBeenCalled();
  });

  it("loads on confirmation", async () => {
    vi.mocked(api.validateUpload).mockResolvedValue(CHECK);
    vi.mocked(api.ingestUpload).mockResolvedValue({
      batch_id: 4,
      rows_read: 100,
      rows_inserted: 98,
      rows_duplicate: 0,
      rows_rejected: 2,
      unmatched_municipalities: [],
    });
    const user = userEvent.setup();
    show();
    await pickFile(user);
    await user.click(await screen.findByRole("button", { name: "Load 98 rows" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Batch 4");
    expect(vi.mocked(api.ingestUpload).mock.calls[0][0]).toBeInstanceOf(File);
  });

  it("will not offer to load a file with nothing valid in it", async () => {
    vi.mocked(api.validateUpload).mockResolvedValue({ ...CHECK, rows_valid: 0, rows_rejected: 100 });
    const user = userEvent.setup();
    show();
    await pickFile(user);
    expect(await screen.findByRole("button", { name: "Load 0 rows" })).toBeDisabled();
  });

  it("explains an address that is not on the upload list", async () => {
    vi.mocked(api.validateUpload).mockRejectedValue(
      new ApiError(403, "registrar@uc-bcf.edu.ph is not on the upload list."),
    );
    const user = userEvent.setup();
    show();
    await pickFile(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(/not on the upload list/);
  });

  it("says plainly when the sign-in has expired", async () => {
    vi.mocked(api.validateUpload).mockRejectedValue(new ApiError(401, "expired"));
    const user = userEvent.setup();
    show();
    await pickFile(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(/sign-in has expired/);
  });

  it("surfaces the server's own message for a bad header", async () => {
    vi.mocked(api.validateUpload).mockRejectedValue(
      new ApiError(422, "missing required column(s): COURSE"),
    );
    const user = userEvent.setup();
    show();
    await pickFile(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("missing required column(s): COURSE");
  });

  it("choosing a new file clears the previous verdict", async () => {
    vi.mocked(api.validateUpload)
      .mockResolvedValueOnce(CHECK)
      .mockReturnValueOnce(new Promise(() => {})); // second check never answers
    const user = userEvent.setup();
    show();
    await pickFile(user);
    expect(await screen.findByText(/Nothing has been written yet/)).toBeInTheDocument();

    await pickFile(user);
    expect(screen.queryByText(/Nothing has been written yet/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load 0 rows" })).toBeDisabled();
  });

  it("shows the load history", async () => {
    vi.mocked(api.batches).mockResolvedValue([
      {
        id: 1,
        filename: "Data for dashboard.csv",
        loaded_at: "2026-10-12T09:26:54Z",
        rows_read: 158101,
        rows_loaded: 158098,
        rows_rejected: 0,
        note: null,
      },
    ]);
    show();
    expect(await screen.findByText("Data for dashboard.csv")).toBeInTheDocument();
    expect(screen.getByText("158,098")).toBeInTheDocument();
  });
});

describe("file size display", () => {
  beforeEach(() => {
    vi.mocked(api.validateUpload).mockReturnValue(new Promise(() => {}));
  });

  it("shows small files in KB rather than as 0.0 MB", async () => {
    const user = userEvent.setup();
    show();
    await user.upload(screen.getByLabelText("Enrollment CSV"), csv());
    expect(screen.getByText(/\(1 KB\)/)).toBeInTheDocument();
  });

  it("shows a term-sized file in MB", async () => {
    const user = userEvent.setup();
    show();
    const big = new File(["x".repeat(36 * 1024 * 1024)], "term.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Enrollment CSV"), big);
    expect(screen.getByText(/\(36\.0 MB\)/)).toBeInTheDocument();
  });
});
