import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { formatNumber, getErrorMessage } from "@/components/admin/admin-format";

// Small building blocks shared by the admin money pages (refunds, payment problems,
// subscriptions, inbox, system check). They follow the look of the existing admin pages
// (AdminSystemHealth.jsx) so the screens match. Kept in one file on purpose: restyle
// here and every one of these pages changes.

export function PageHeader({ eyebrow, title, description, children }) {
  return (
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
      <div>
        {eyebrow && <p className="text-sm font-medium text-primary">{eyebrow}</p>}
        <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function MetricCard({ label, value, description, icon: Icon, tone = "default" }) {
  const ring = tone === "alert" ? "border-amber-300 bg-amber-50" : "border-border bg-card";
  return (
    <article className={`rounded-xl border p-5 ${ring}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        {Icon && (
          <span className="rounded-lg bg-soft-green p-2 text-primary">
            <Icon size={19} aria-hidden="true" />
          </span>
        )}
      </div>
      <p className="mt-5 text-2xl font-bold tracking-tight">{typeof value === "number" ? formatNumber(value) : (value ?? "—")}</p>
      {description && <p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p>}
    </article>
  );
}

const GOOD = ["resolved", "refunded", "active", "connected", "info", "test", "paid", "confirmed", "verified", "success"];
const WARN = ["open", "due", "warn", "warning", "pending", "needs_review", "trial", "unknown", "live", "customer_reported", "money_held", "cancelled_after_payment"];
const BAD = ["error", "failed", "cancelled", "expired", "rejected", "disconnected"];

export function StatusBadge({ value }) {
  const normalized = String(value ?? "unknown").toLowerCase();
  let styles = "bg-muted text-muted-foreground";
  if (GOOD.includes(normalized)) styles = "bg-soft-green text-primary";
  else if (WARN.includes(normalized)) styles = "bg-amber-100 text-amber-800";
  else if (BAD.includes(normalized)) styles = "bg-destructive/10 text-destructive";
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${styles}`}>{normalized.replaceAll("_", " ")}</span>;
}

export function ErrorMessage({ children }) {
  if (!children) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <AlertCircle size={18} className="mt-0.5 shrink-0 text-destructive" />
      <p>{children}</p>
    </div>
  );
}

export function EmptyState({ children }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

export function FilterSelect({ label, value, onChange, options }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm">
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function DataTable({ headers, children }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <thead className="bg-muted/60">
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col" className="whitespace-nowrap px-4 py-3 text-xs font-semibold text-muted-foreground">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function TableCell({ children, className = "" }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children ?? "—"}</td>;
}

export function Pagination({ pagination, onPageChange, disabled }) {
  if (!pagination) return null;
  const page = pagination.page || 1;
  const totalPages = Math.max(pagination.totalPages || 1, 1);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <p className="text-xs text-muted-foreground">
        Page {page} of {totalPages} · {formatNumber(pagination.total)} total
      </p>
      <div className="flex gap-2">
        <button type="button" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)} className="min-h-9 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50">
          Previous
        </button>
        <button type="button" disabled={disabled || page >= totalPages} onClick={() => onPageChange(page + 1)} className="min-h-9 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50">
          Next
        </button>
      </div>
    </div>
  );
}

// Shows loading, error or empty, or nothing when there is data to show.
export function QueryStatus({ query, loadingText, emptyText, hasData }) {
  if (query.isPending) return <p className="text-sm text-muted-foreground">{loadingText}</p>;
  if (query.isError) return <ErrorMessage>{getErrorMessage(query.error)}</ErrorMessage>;
  if (!hasData) return <EmptyState>{emptyText}</EmptyState>;
  return null;
}

// A small inline form for the actions that need a note: press the button, type the
// note, confirm. Used for "mark refunded", "resolve", "cancel", and so on. The action
// is a function that takes the note; errors from it are shown under the form.
export function NoteAction({ label, confirmLabel = "Confirm", placeholder = "Add a note (optional)", noteRequired = false, noteHelp, tone = "default", onSubmit, busy }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (noteRequired && note.trim().length < 3) {
      setError("Give a reason (at least 3 characters).");
      return;
    }
    setError("");
    try {
      await onSubmit(note);
      setOpen(false);
      setNote("");
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  if (!open) {
    const style = tone === "danger" ? "border-destructive/40 text-destructive hover:bg-destructive/5" : "border-border hover:bg-muted";
    return (
      <button type="button" onClick={() => setOpen(true)} className={`min-h-9 rounded-lg border px-3 text-sm font-medium ${style}`}>
        {label}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="w-full min-w-[240px] space-y-2">
      <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={300} placeholder={placeholder} className="w-full rounded-lg border border-border bg-background p-2 text-sm" />
      {noteHelp && <p className="text-xs text-muted-foreground">{noteHelp}</p>}
      <ErrorMessage>{error}</ErrorMessage>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="min-h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {busy ? "Saving..." : confirmLabel}
        </button>
        <button type="button" onClick={() => { setOpen(false); setError(""); }} className="min-h-9 rounded-lg border border-border px-3 text-sm hover:bg-muted">
          Cancel
        </button>
      </div>
    </form>
  );
}
