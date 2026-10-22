import React, { useEffect, useState, useCallback, useRef, useId } from "react";
import { createRoot } from "react-dom/client";
import {
  Box,
  LayoutDashboard,
  FileCheck2,
  ArrowUpRight,
  ChevronRight,
  Plus,
  Search,
  UploadCloud,
  FileText,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Clock,
  MinusCircle,
  ArrowLeft,
  RefreshCw,
  Download,
  ShieldCheck,
  LogOut,
  History,
  ExternalLink,
  LoaderCircle,
  Check,
  X,
  Layers3,
} from "lucide-react";
import type {
  Shipment,
  DocKind,
  DocumentRecord,
  Field,
  Check as RuleCheck,
} from "@cargo/shared";
import { allFields, processingStatus, isConfirmed } from "@cargo/shared";
import { api } from "./api";
import "./styles.css";

type User = { id: string; name: string; email: string };
type View = "dashboard" | "review" | "report" | "activity";
type Health = {
  extraction: string;
  storage: string;
  queue: string;
  cloudConfigured: boolean;
};
const labels: Record<string, string> = {
  shipmentRef: "Shipment reference",
  seller: "Seller",
  consignee: "Consignee",
  address: "Consignee address",
  currency: "Currency",
  code: "Product code",
  description: "Description",
  quantity: "Quantity",
  unit: "Unit",
  unitPrice: "Unit price",
  lineTotal: "Line total",
};
const kindName = (k: DocKind) =>
  k === "invoice" ? "Commercial invoice" : "Packing list";
const date = (s: string) =>
  new Date(s).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
function Badge({
  status,
  children,
}: {
  status: string;
  children?: React.ReactNode;
}) {
  const ok = ["passed", "Reviewed", "reviewed", "Complete", "ready"].includes(
      status,
    ),
    bad = ["discrepancy", "Processing failed", "failed"].includes(status),
    neutral = ["not_compared", "Awaiting documents"].includes(status),
    busy = ["queued", "processing", "Processing"].includes(status);
  const Icon = ok
    ? CheckCircle2
    : bad
      ? AlertCircle
      : neutral
        ? MinusCircle
        : busy
          ? Clock
          : AlertTriangle;
  return (
    <span
      className={`badge ${ok ? "green" : bad ? "red" : neutral ? "gray" : busy ? "blue" : "amber"}`}
    >
      <Icon size={13} />
      {children ?? status.replaceAll("_", " ")}
    </span>
  );
}
function Button({
  children,
  onClick,
  primary = false,
  disabled = false,
  className = "",
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`btn ${primary ? "primary" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null),
    [boot, setBoot] = useState(true),
    [health, setHealth] = useState<Health>(),
    [view, setView] = useState<View>("dashboard"),
    [shipments, setShipments] = useState<Shipment[]>([]),
    [selected, setSelected] = useState<Shipment | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [create, setCreate] = useState(false),
    [reference, setReference] = useState(""),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("All reviews");
  const selectedId = useRef<string | null>(null);
  selectedId.current = selected?.id ?? null;
  const refresh = useCallback(async () => {
    const list = await api<Shipment[]>("/shipments");
    setShipments(list);
    if (selectedId.current) {
      const x = list.find((x) => x.id === selectedId.current);
      if (x) setSelected(x);
    }
  }, []);
  useEffect(() => {
    void Promise.all([
      api<User>("/auth/me")
        .then(setUser)
        .catch(() => {}),
      api<Health>("/health")
        .then(setHealth)
        .catch(() => {}),
    ]).finally(() => setBoot(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => void refresh().catch(() => {}), 2500);
    return () => clearInterval(timer);
  }, [user, refresh]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  function open(x: Shipment, next: View = "review") {
    setSelected(x);
    setView(next);
    setNotice("");
  }
  async function sample() {
    await action(async () => {
      const x = await api<Shipment>("/sample", {});
      open(x);
    });
  }
  async function mutate(
    url: string,
    body: Record<string, unknown> = {},
    method?: string,
  ) {
    if (!selected) return;
    await action(async () => {
      const x = await api<Shipment>(
        `/shipments/${selected.id}${url}`,
        { version: selected.version, ...body },
        method,
      );
      if (x?.id) setSelected(x);
    });
  }
  if (boot)
    return (
      <div className="boot">
        <LoaderCircle className="spin" />
        Opening CargoCheck…
      </div>
    );
  if (!user) return <Auth onAuth={(u) => setUser(u)} />;
  const reviewed = shipments.filter(
      (x) => x.reviewStatus === "reviewed",
    ).length,
    attention = shipments.filter(
      (x) =>
        x.reviewStatus !== "reviewed" &&
        Object.values(x.documents).some((d) => d.status === "ready"),
    ).length;
  const visibleShipments = shipments.filter(
    (x) =>
      x.reference.toLowerCase().includes(search.trim().toLowerCase()) &&
      (filter === "All reviews" ||
        (filter === "Reviewed"
          ? x.reviewStatus === "reviewed"
          : x.reviewStatus !== "reviewed")),
  );
  const canRunChecks = (["invoice", "packing"] as const).every(
    (kind) => selected?.documents[kind]?.status === "ready",
  );
  return (
    <>
      <header className="topbar">
        <button className="brand" onClick={() => setView("dashboard")}>
          <span className="mark">
            <Box size={22} />
          </span>
          CargoCheck <span className="ai">AI</span>
        </button>
        <span className="top-divider" />
        <span className="breadcrumb">
          Shipment reviews{" "}
          {view !== "dashboard" && (
            <>
              <ChevronRight size={14} />
              <b>{selected?.reference}</b>
            </>
          )}
        </span>
        <div className="top-right">
          <span className="release">DEVELOPMENT BUILD · v0.1</span>
          <span className="avatar" title={user.email}>
            {user.name.slice(0, 2).toUpperCase()}
          </span>
          <button
            className="icon-btn light"
            title="Sign out"
            onClick={() =>
              void action(async () => {
                await api("/auth/logout", {});
                setUser(null);
                setSelected(null);
              })
            }
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <div className="shell">
        <aside className="sidebar">
          <p className="eyebrow">WORKSPACE</p>
          <button
            className={view === "dashboard" ? "nav active" : "nav"}
            onClick={() => setView("dashboard")}
          >
            <LayoutDashboard size={18} />
            Shipment reviews
          </button>
          {selected && (
            <>
              <button
                className={view === "review" ? "nav active" : "nav"}
                onClick={() => setView("review")}
              >
                <Layers3 size={18} />
                Document review
              </button>
              <button
                className={view === "report" ? "nav active" : "nav"}
                onClick={() => setView("report")}
              >
                <FileCheck2 size={18} />
                Validation report
              </button>
              <button
                className={view === "activity" ? "nav active" : "nav"}
                onClick={() => setView("activity")}
              >
                <History size={18} />
                Review history
              </button>
            </>
          )}
          <div className="sidebar-bottom">
            <ShieldCheck size={24} />
            <b>Evidence, before decisions.</b>
            <p>
              Original documents stay unchanged. Every correction has a history.
            </p>
            <div className="mode">
              {health && <span className="dot" />}
              {!health
                ? "Extraction mode unavailable"
                : health.extraction === "gemini"
                  ? "Gemini cloud"
                  : "Local OCR"}
            </div>
            <small>
              {!health
                ? "Reload the page to check where documents are processed."
                : health.extraction === "gemini"
                  ? "Documents are sent to Google Gemini to extract fields."
                  : "English OCR and labelled templates extract fields without AI. Documents stay on this server."}
            </small>
            <details>
              <summary>Development services</summary>
              <small>
                Storage: {health?.storage ?? "Unavailable"}
                <br />
                Jobs: {health?.queue ?? "Unavailable"}
              </small>
            </details>
          </div>
        </aside>
        <main className={view === "review" ? "main review-main" : "main"}>
          {error && (
            <div role="alert" className="banner error">
              <AlertCircle size={18} />
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="banner">
              <CheckCircle2 size={18} />
              {notice}
            </div>
          )}
          {view === "dashboard" ? (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">DOCUMENT OPERATIONS</p>
                  <h1>Shipment reviews</h1>
                  <p>Catch the difference. Keep the evidence.</p>
                </div>
                <div className="actions">
                  <Button disabled={busy} onClick={() => void sample()}>
                    <Layers3 size={16} />
                    Try sample shipment
                  </Button>
                  <Button primary onClick={() => setCreate(true)}>
                    <Plus size={17} />
                    New review
                  </Button>
                </div>
              </div>
              <div className="stats">
                <Stat
                  label="Total reviews"
                  value={shipments.length}
                  icon={<FileText size={21} />}
                />
                <Stat
                  label="Need attention"
                  value={attention}
                  icon={<AlertTriangle size={21} />}
                  tone="amber"
                />
                <Stat
                  label="Reviewed"
                  value={reviewed}
                  icon={<CheckCircle2 size={21} />}
                  tone="green"
                />
              </div>
              {!shipments.length && (
                <div className="welcome">
                  <div className="welcome-icon">
                    <FileCheck2 size={36} />
                  </div>
                  <div>
                    <h2>Your next shipment, checked with care.</h2>
                    <p>
                      Upload an invoice and packing list, confirm extracted
                      fields, then compare the details with transparent rules.
                    </p>
                    <Button
                      primary
                      disabled={busy}
                      onClick={() => void sample()}
                    >
                      Explore with synthetic sample PDFs
                      <ArrowUpRight size={16} />
                    </Button>
                  </div>
                  <div className="steps-mini">
                    <span>
                      01 <b>Upload</b>
                    </span>
                    <span>
                      02 <b>Confirm</b>
                    </span>
                    <span>
                      03 <b>Compare</b>
                    </span>
                  </div>
                </div>
              )}
              <div className="table-toolbar">
                <div className="tabs">
                  {["All reviews", "In progress", "Reviewed"].map((t) => (
                    <button
                      key={t}
                      className={filter === t ? "on" : ""}
                      onClick={() => setFilter(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <label className="search">
                  <Search size={16} />
                  <input
                    aria-label="Search reviews"
                    placeholder="Search shipment reference…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
              <div className="table-scroll">
                <table className="reviews-table">
                  <thead>
                    <tr>
                      <th>Shipment</th>
                      <th>Trading parties</th>
                      <th>Documents</th>
                      <th>Processing</th>
                      <th>Human review</th>
                      <th>Updated</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleShipments.map((x) => (
                      <tr key={x.id} onClick={() => open(x)}>
                        <td>
                          <button
                            className="ref-link"
                            onClick={(e) => {
                              e.stopPropagation();
                              open(x);
                            }}
                          >
                            {x.reference}
                          </button>
                          {x.synthetic && (
                            <small className="sample-label">
                              Synthetic sample
                            </small>
                          )}
                        </td>
                        <td>
                          {x.documents.invoice?.extraction?.seller.value ??
                            "Not extracted yet"}
                          <small>
                            to{" "}
                            {x.documents.invoice?.extraction?.consignee.value ??
                              "Not extracted yet"}
                          </small>
                        </td>
                        <td>
                          {(["invoice", "packing"] as const).map((k) => (
                            <div className="doc-status" key={k}>
                              <FileText size={13} />
                              {k === "invoice" ? "Invoice" : "Packing list"}
                              {x.documents[k] ? (
                                <Check size={13} />
                              ) : (
                                <span>Missing</span>
                              )}
                            </div>
                          ))}
                        </td>
                        <td>
                          <Badge status={processingStatus(x)} />
                        </td>
                        <td>
                          <Badge
                            status={
                              x.reviewStatus === "reviewed"
                                ? "Reviewed"
                                : "In progress"
                            }
                          />
                          {x.checks.some((c) => c.status === "discrepancy") && (
                            <small>
                              {
                                x.checks.filter(
                                  (c) => c.status === "discrepancy",
                                ).length
                              }{" "}
                              discrepancies
                            </small>
                          )}
                        </td>
                        <td className="muted">{date(x.updatedAt)}</td>
                        <td>
                          <ChevronRight size={17} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!shipments.length && (
                  <p className="empty">
                    No reviews yet. Create a review or try the sample shipment.
                  </p>
                )}
                {shipments.length > 0 && !visibleShipments.length && (
                  <div className="empty" role="status">
                    <p>No reviews match your search and filters.</p>
                    <Button
                      onClick={() => {
                        setSearch("");
                        setFilter("All reviews");
                      }}
                    >
                      Show all reviews
                    </Button>
                  </div>
                )}
              </div>
              <div className="legend">
                <p>
                  <b>Processing complete</b> means documents are extracted and
                  confirmed.
                </p>
                <p>
                  <b>Reviewed</b> can include documented unresolved
                  discrepancies. It is not shipment approval.
                </p>
              </div>
            </>
          ) : (
            selected && (
              <>
                <div className="shipment-heading">
                  <div>
                    <button
                      className="back"
                      onClick={() => setView("dashboard")}
                    >
                      <ArrowLeft size={14} />
                      All reviews
                    </button>
                    <h1>
                      {selected.reference}
                      {selected.synthetic && (
                        <span className="sample-label">Synthetic sample</span>
                      )}
                    </h1>
                    <p>
                      {selected.documents.invoice?.extraction?.seller.value ??
                        "Shipment review"}{" "}
                      <span className="muted">→</span>{" "}
                      {selected.documents.invoice?.extraction?.consignee
                        .value ?? "Upload documents to begin"}
                    </p>
                  </div>
                  <div className="actions">
                    <Badge status={processingStatus(selected)} />
                    <Badge
                      status={
                        selected.reviewStatus === "reviewed"
                          ? "Reviewed"
                          : "In progress"
                      }
                    />
                    <Button
                      onClick={() =>
                        setView(view === "report" ? "review" : "report")
                      }
                    >
                      <FileCheck2 size={16} />
                      {view === "report" ? "Document review" : "Open report"}
                    </Button>
                  </div>
                </div>
                {view === "activity" ? (
                  <section className="panel history-panel">
                    <h2>Review history</h2>
                    <p className="muted">
                      Corrections change extracted data only. Uploaded files are
                      preserved.
                    </p>
                    {[...selected.history].reverse().map((h, i) => (
                      <div className="event" key={i}>
                        <span className="event-dot" />
                        <div>
                          <b>{h.action.replaceAll("_", " ")}</b>
                          <p>{h.detail}</p>
                          <small>
                            {date(h.at)} · {h.by}
                          </small>
                        </div>
                      </div>
                    ))}
                  </section>
                ) : view === "report" ? (
                  <>
                    <div className="report-heading">
                      <div>
                        <h2>Validation report</h2>
                        <p className="muted">
                          Explicit rules. Traceable evidence. Human decisions.
                        </p>
                      </div>
                      <div className="actions">
                        <Button
                          disabled={busy || !canRunChecks}
                          onClick={() => void mutate("/validate")}
                        >
                          <RefreshCw size={16} />
                          Rerun checks
                        </Button>
                        <a
                          className="btn"
                          href={`/api/shipments/${selected.id}/export`}
                        >
                          <Download size={16} />
                          Export PDF
                        </a>
                        <Button
                          primary
                          disabled={
                            busy || selected.reviewStatus === "reviewed"
                          }
                          onClick={() => void mutate("/complete")}
                        >
                          <CheckCircle2 size={16} />
                          Complete review
                        </Button>
                      </div>
                    </div>
                    <div className="banner">
                      <ShieldCheck size={18} />
                      {isConfirmed(selected)
                        ? "Both documents are confirmed. Record a decision for each flagged item before completing the review."
                        : "Results remain provisional until you confirm the extracted fields against both originals."}
                    </div>
                    <div className="check-summary">
                      {[
                        "discrepancy",
                        "needs_review",
                        "passed",
                        "not_compared",
                      ].map((status) => (
                        <Badge key={status} status={status}>
                          {
                            selected.checks.filter((c) => c.status === status)
                              .length
                          }{" "}
                          {status.replaceAll("_", " ")}
                        </Badge>
                      ))}
                    </div>
                    {!selected.checks.length ? (
                      <div className="panel empty">
                        Finish extracting both documents, then run checks.
                      </div>
                    ) : (
                      <div className="report-list">
                        {selected.checks.map((c) => (
                          <CheckCard
                            key={`${selected.id}-${c.id}`}
                            check={c}
                            busy={busy}
                            onSource={(kind, page) => {
                              setView("review");
                              window.open(
                                `/api/shipments/${selected.id}/documents/${kind}/file#page=${page}`,
                                "_blank",
                                "noopener",
                              );
                            }}
                            onDecision={(outcome, note) =>
                              mutate(`/decisions/${encodeURIComponent(c.id)}`, {
                                outcome,
                                note,
                              })
                            }
                          />
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="review-toolbar">
                      <div>
                        <b>Compare originals, confirm the details.</b>
                        <span>
                          {" "}
                          Source references point to extracted text lines; PDF
                          bounding-box highlights are a later milestone.
                        </span>
                      </div>
                      <Button
                        disabled={busy || !canRunChecks}
                        onClick={() => void mutate("/validate")}
                      >
                        <RefreshCw size={15} />
                        Run checks
                      </Button>
                    </div>
                    <div className="document-grid">
                      {(["invoice", "packing"] as const).map((kind) => (
                        <DocumentPane
                          key={`${selected.id}-${kind}`}
                          shipment={selected}
                          kind={kind}
                          busy={busy}
                          onUpload={async (file) => {
                            await action(async () => {
                              const form = new FormData();
                              form.set("file", file);
                              form.set("version", String(selected.version));
                              await api(
                                `/shipments/${selected.id}/documents/${kind}`,
                                form,
                              );
                            });
                          }}
                          onRetry={() => mutate(`/documents/${kind}/retry`)}
                          onConfirm={() => mutate(`/documents/${kind}/confirm`)}
                          onAdd={() => mutate(`/documents/${kind}/items`)}
                          onField={(path, value) =>
                            mutate("/fields", { kind, path, value }, "PATCH")
                          }
                        />
                      ))}
                    </div>
                    <div className="review-footer">
                      <span>
                        <ShieldCheck size={16} />
                        Original files remain unchanged. Corrections are
                        recorded in review history.
                      </span>
                      <Button primary onClick={() => setView("report")}>
                        View validation report
                        <ChevronRight size={16} />
                      </Button>
                    </div>
                  </>
                )}
              </>
            )
          )}
        </main>
      </div>
      {create && (
        <div className="modal-backdrop" onClick={() => setCreate(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const x = await api<Shipment>("/shipments", { reference });
                setCreate(false);
                setReference("");
                open(x);
              });
            }}
          >
            <button
              type="button"
              className="modal-close icon-btn"
              aria-label="Close"
              onClick={() => setCreate(false)}
            >
              <X size={19} />
            </button>
            <span className="modal-symbol">
              <Plus size={25} />
            </span>
            <h2>Start a shipment review</h2>
            <p>
              Give this review a reference. You’ll upload the two documents
              next.
            </p>
            <label>
              Shipment reference
              <input
                autoFocus
                required
                maxLength={80}
                placeholder="e.g. SH-2026-001"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </label>
            <Button type="submit" primary disabled={busy}>
              Create review
              <ChevronRight size={16} />
            </Button>
          </form>
        </div>
      )}
      {busy && (
        <div className="saving" role="status">
          <LoaderCircle size={15} className="spin" />
          Saving…
        </div>
      )}
    </>
  );
}
function Stat({
  label,
  value,
  icon,
  tone = "blue",
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="stat">
      <div>
        <p>{label}</p>
        <strong>{value.toString().padStart(2, "0")}</strong>
      </div>
      <span className={`stat-icon ${tone}`}>{icon}</span>
    </div>
  );
}

function Auth({ onAuth }: { onAuth: (u: User) => void }) {
  const [register, setRegister] = useState(true),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="auth">
      <section className="auth-story">
        <div className="brand">
          <span className="mark">
            <Box size={24} />
          </span>
          CargoCheck AI
        </div>
        <div>
          <p className="eyebrow">EVERY DETAIL COUNTS</p>
          <h1>
            Confidence starts
            <br />
            with the documents.
          </h1>
          <p>
            One workspace to compare shipping documents, inspect the evidence,
            and record decisions with care.
          </p>
          <div className="auth-flow">
            <span>
              <FileText />
              Read
            </span>
            <ChevronRight />
            <span>
              <Layers3 />
              Compare
            </span>
            <ChevronRight />
            <span>
              <ShieldCheck />
              Review
            </span>
          </div>
        </div>
        <small>
          Development version · No customs certification or automatic approval.
        </small>
      </section>
      <section className="auth-form">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              onAuth(
                await api<User>(`/auth/${register ? "register" : "login"}`, {
                  email,
                  password,
                  ...(register ? { name } : {}),
                }),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="eyebrow">YOUR REVIEW WORKSPACE</span>
          <h2>{register ? "Create your account" : "Welcome back"}</h2>
          <p>
            {register
              ? "Start with a synthetic sample or your own documents."
              : "Sign in to continue your document reviews."}
          </p>
          {error && (
            <div className="banner error" role="alert">
              {error}
            </div>
          )}
          {register && (
            <label>
              Name
              <input
                required
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          <label>
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              required
              minLength={10}
              maxLength={128}
              autoComplete={register ? "new-password" : "current-password"}
              placeholder="At least 10 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <Button primary type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : null}
            {register ? "Create account" : "Sign in"}
            <ArrowUpRight size={16} />
          </Button>
          <button
            type="button"
            className="auth-switch"
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register
              ? "Already have an account? Sign in"
              : "New to CargoCheck? Create an account"}
          </button>
          <div className="auth-note">
            <ShieldCheck size={17} />
            <span>
              Reviews and original files are scoped to your account. This is an
              early development build.
            </span>
          </div>
        </form>
      </section>
    </div>
  );
}

function DocumentPane({
  shipment,
  kind,
  busy,
  onUpload,
  onRetry,
  onConfirm,
  onAdd,
  onField,
}: {
  shipment: Shipment;
  kind: DocKind;
  busy: boolean;
  onUpload: (f: File) => Promise<void>;
  onRetry: () => Promise<void>;
  onConfirm: () => Promise<void>;
  onAdd: () => Promise<void>;
  onField: (path: string, value: string | null) => Promise<void>;
}) {
  const doc = shipment.documents[kind];
  const [tab, setTab] = useState<"original" | "fields" | "text">("original"),
    [page, setPage] = useState(1),
    [focus, setFocus] = useState<Field["source"]>(null);
  const input = useRef<HTMLInputElement>(null);
  const fileUrl = `/api/shipments/${shipment.id}/documents/${kind}/file#page=${page}`;
  const extracted = doc?.extraction;
  function source(f: Field) {
    setFocus(f.source);
    setPage(f.source?.page ?? 1);
    setTab("text");
  }
  return (
    <section className="document-pane">
      <div className="document-title">
        <span className="file-icon">
          <FileText size={19} />
        </span>
        <div>
          <h3>{kindName(kind)}</h3>
          <small>{doc?.filename ?? "No document uploaded"}</small>
        </div>
        {doc && <Badge status={doc.status} />}
      </div>
      <input
        ref={input}
        className="hidden"
        type="file"
        accept="application/pdf,image/jpeg,image/png"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onUpload(f);
          e.target.value = "";
        }}
      />
      {!doc ? (
        <div
          className="upload-area"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!busy && e.dataTransfer.files[0])
              void onUpload(e.dataTransfer.files[0]);
          }}
        >
          <div className="upload-illustration">
            <FileText size={45} />
            <span>
              <Plus size={18} />
            </span>
          </div>
          <h3>
            Drop your {kind === "invoice" ? "invoice" : "packing list"} here
          </h3>
          <p>PDF, JPG or PNG · up to 10 MB</p>
          <Button
            primary
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <UploadCloud size={16} />
            Choose document
          </Button>
          <a href={`/api/samples/${kind}`} className="sample-download">
            Download a synthetic sample
            <Download size={13} />
          </a>
        </div>
      ) : (
        <>
          <div className="doc-tabs">
            <div>
              {(["original", "fields", "text"] as const).map((t) => (
                <button
                  key={t}
                  className={tab === t ? "on" : ""}
                  onClick={() => setTab(t)}
                >
                  {t === "original"
                    ? "Original document"
                    : t === "fields"
                      ? "Extracted fields"
                      : "Source text"}
                </button>
              ))}
            </div>
            <a
              className="icon-btn"
              href={fileUrl}
              target="_blank"
              rel="noreferrer"
              title="Open original"
            >
              <ExternalLink size={15} />
            </a>
          </div>
          {(doc.status === "processing" || doc.status === "queued") && (
            <div className="processing">
              <LoaderCircle className="spin" size={20} />
              <div>
                <b>Extracting document fields</b>
                <p>
                  Attempt {Math.max(1, doc.attempts)} of 3. You can leave this
                  page.
                </p>
              </div>
            </div>
          )}
          {doc.status === "failed" && (
            <div className="processing failed">
              <AlertTriangle size={20} />
              <div>
                <b>Extraction could not finish</b>
                <p>{doc.error}</p>
                <Button disabled={busy} onClick={() => void onRetry()}>
                  <RefreshCw size={14} />
                  Retry extraction
                </Button>
              </div>
            </div>
          )}
          {tab === "original" ? (
            <div className="original-view">
              {doc.mime === "application/pdf" ? (
                <iframe title={`${kindName(kind)} original`} src={fileUrl} />
              ) : (
                <img alt={`${kindName(kind)} original`} src={fileUrl} />
              )}
            </div>
          ) : tab === "text" ? (
            <div className="source-text">
              <div className="source-note">
                {focus ? (
                  <>
                    <b>
                      Source: page {focus.page}, extracted text line{" "}
                      {focus.line}
                    </b>
                    <blockquote>{focus.text}</blockquote>
                  </>
                ) : (
                  <p>
                    OCR/text extraction may differ from the original. Confirm
                    each value against the uploaded document.
                  </p>
                )}
              </div>
              {doc.pages.length ? (
                doc.pages.map((p, n) => (
                  <section key={n}>
                    <h4>Page {n + 1}</h4>
                    {p.split("\n").map((l, i) => (
                      <div
                        key={i}
                        className={
                          focus?.page === n + 1 && focus.line === i + 1
                            ? "source-line highlighted"
                            : "source-line"
                        }
                      >
                        <span>{i + 1}</span>
                        <code>{l || " "}</code>
                      </div>
                    ))}
                  </section>
                ))
              ) : (
                <p className="empty">
                  No local source text is available. Open the original document
                  to verify provider references.
                </p>
              )}
            </div>
          ) : (
            <div className="fields-view">
              {extracted ? (
                <>
                  <div className="fields-note">
                    <AlertTriangle size={16} />
                    <span>
                      {allFields(extracted).filter((f) => !f.confirmed).length}{" "}
                      fields need confirmation. Missing values are never
                      guessed.
                    </span>
                  </div>
                  {(
                    [
                      "shipmentRef",
                      "seller",
                      "consignee",
                      "address",
                      "currency",
                    ] as const
                  ).map((k) => (
                    <FieldEditor
                      key={`${doc.id}-${k}-${extracted[k].value}`}
                      label={labels[k]}
                      field={extracted[k]}
                      busy={busy}
                      onSave={(v) => onField(k, v)}
                      onSource={() => source(extracted[k])}
                    />
                  ))}
                  <div className="line-heading">
                    <h3>Line items</h3>
                    <Button
                      disabled={busy || doc.status !== "ready"}
                      onClick={() => void onAdd()}
                    >
                      <Plus size={13} />
                      Add line
                    </Button>
                  </div>
                  {extracted.items.length ? (
                    extracted.items.map((item, n) => (
                      <div className="item-card" key={n}>
                        <h4>
                          Line {n + 1}{" "}
                          <span>
                            {item.code.value ?? "Product code missing"}
                          </span>
                        </h4>
                        {Object.entries(item).map(([key, f]) => (
                          <FieldEditor
                            key={`${doc.id}-${n}-${key}-${f.value}`}
                            label={labels[key]}
                            field={f}
                            busy={busy}
                            onSave={(v) => onField(`items.${n}.${key}`, v)}
                            onSource={() => source(f)}
                          />
                        ))}
                      </div>
                    ))
                  ) : (
                    <p className="empty">
                      No lines recognised. Add a line manually or use cloud
                      extraction for other layouts.
                    </p>
                  )}
                </>
              ) : (
                <div className="empty">
                  Fields appear when extraction finishes.
                </div>
              )}
            </div>
          )}
          <div className="document-bottom">
            <small>
              {doc.provider} · {Math.ceil(doc.size / 1024)} KB
            </small>
            <div className="actions">
              <Button
                disabled={
                  busy || doc.status === "processing" || doc.status === "queued"
                }
                onClick={() => input.current?.click()}
              >
                Replace file
              </Button>
              <Button
                primary
                disabled={
                  busy ||
                  !extracted ||
                  doc.status !== "ready" ||
                  allFields(extracted).every((f) => f.confirmed)
                }
                onClick={() => void onConfirm()}
              >
                <Check size={14} />
                Confirm all fields
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
function FieldEditor({
  label,
  field,
  busy,
  onSave,
  onSource,
}: {
  label: string;
  field: Field;
  busy: boolean;
  onSave: (value: string | null) => Promise<void>;
  onSource: () => void;
}) {
  const [value, setValue] = useState(field.value ?? "");
  const inputId = useId();
  return (
    <div className="field-row">
      <div className="field-label">
        <label htmlFor={inputId}>{label}</label>
        {field.confirmed ? (
          <span className="confirmed">
            <CheckCircle2 size={12} />
            Confirmed
          </span>
        ) : (
          <span className="unconfirmed">Needs confirmation</span>
        )}
      </div>
      <div className="field-input">
        <input
          id={inputId}
          value={value}
          placeholder="Not stated"
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          aria-label={`Save and confirm ${label}`}
          title="Save and confirm"
          disabled={busy || (field.confirmed && value === (field.value ?? ""))}
          onClick={() => void onSave(value || null)}
        >
          <Check size={16} />
        </button>
      </div>
      {field.source && (
        <button className="source-link" onClick={onSource}>
          Page {field.source.page}, extracted line {field.source.line}
          <ArrowUpRight size={12} />
        </button>
      )}
      {field.originalValue !== undefined &&
        field.originalValue !== field.value && (
          <small className="correction">
            Original extraction: {field.originalValue ?? "Not stated"} →{" "}
            {field.value ?? "Not stated"}
          </small>
        )}
    </div>
  );
}

function CheckCard({
  check: c,
  busy,
  onDecision,
  onSource,
}: {
  check: RuleCheck;
  busy: boolean;
  onDecision: (outcome: string, note: string) => Promise<void>;
  onSource: (kind: DocKind, page: number) => void;
}) {
  const [note, setNote] = useState(c.decision?.note ?? ""),
    [outcome, setOutcome] = useState(c.decision?.outcome ?? "unresolved");
  return (
    <article className={`check-card ${c.status}`}>
      <div className="check-card-title">
        <h3>{c.title}</h3>
        <Badge status={c.status} />
      </div>
      <p>{c.message}</p>
      <div className="comparison">
        {(["invoice", "packing"] as const).map((kind) => {
          const source = kind === "invoice" ? c.invoiceSource : c.packingSource;
          return (
            <div key={kind}>
              <small>{kind === "invoice" ? "Invoice" : "Packing list"}</small>
              <strong>
                {(kind === "invoice" ? c.invoice : c.packing) ?? "Not stated"}
              </strong>
              {source && (
                <button
                  className="source-link"
                  onClick={() => onSource(kind, source.page)}
                >
                  Page {source.page} · extracted line {source.line}
                  <ExternalLink size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {(c.status === "discrepancy" || c.status === "needs_review") && (
        <div className="decision">
          <label>
            Reviewer decision
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as typeof outcome)}
            >
              <option value="unresolved">
                Unresolved — document and follow up
              </option>
              <option value="accepted">Accepted with explanation</option>
              <option value="false_positive">
                False positive — explain why
              </option>
            </select>
          </label>
          <label>
            Review note
            <textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Record the reason and next action (at least 5 characters)"
            />
          </label>
          <div className="decision-bottom">
            <Button
              primary
              disabled={busy || note.trim().length < 5}
              onClick={() => void onDecision(outcome, note)}
            >
              {c.decision ? "Update decision" : "Record decision"}
            </Button>
            {c.decision && (
              <small>
                <CheckCircle2 size={13} />
                Recorded by {c.decision.by} · {date(c.decision.at)}
              </small>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
