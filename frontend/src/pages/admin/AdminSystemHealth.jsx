
import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  Database,
  FileWarning,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wrench,
} from "lucide-react";

import {
  getAdminHealth,
  getAdminEvents,
  getAdminReports,
  resolveAdminReport,
  getAdminAudit,
} from "@/api/admin-api";
import { ApiError } from "@/api/api-client";

const eventTypes = [
  { value: "", label: "All event types" },
  { value: "order_failed", label: "Failed orders" },
  { value: "server_error", label: "Server errors" },
  { value: "notification_failed", label: "Notification failures" },
  { value: "missing_order_report", label: "Missing-order reports" },
];

const eventLevels = [
  { value: "", label: "All levels" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warning" },
  { value: "error", label: "Error" },
];

const reportStatuses = [
  { value: "open", label: "Open reports" },
  { value: "resolved", label: "Resolved reports" },
];

const auditActions = [
  { value: "", label: "All actions" },
  { value: "seller.suspend", label: "Seller suspended" },
  { value: "seller.deactivate", label: "Seller deactivated" },
  { value: "seller.reinstate", label: "Seller reinstated" },
  { value: "order.reveal_phone", label: "Order phone revealed" },
  { value: "report.resolve", label: "Report resolved" },
];

function formatNumber(value) {
  return typeof value === "number"
    ? new Intl.NumberFormat("en-NG").format(value)
    : "—";
}

function formatDate(value) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function getErrorMessage(error) {
  if (error instanceof ApiError && error.status === 403) {
    return "Access denied. Your account is not authorized to access the admin workspace.";
  }

  if (error instanceof ApiError && error.status === 401) {
    return "Your session is missing or has expired. Please sign in again.";
  }

  return error?.message || "Something went wrong. Please try again.";
}

function SectionHeading({ title, description, children }) {
  return (
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function MetricCard({ label, value, description, icon: Icon }) {
  return (
    <article className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">
          {label}
        </p>

        <span className="rounded-lg bg-soft-green p-2 text-primary">
          <Icon size={19} aria-hidden="true" />
        </span>
      </div>

      <p className="mt-5 text-2xl font-bold tracking-tight">
        {formatNumber(value)}
      </p>

      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {description}
      </p>
    </article>
  );
}

function StatusBadge({ value }) {
  const normalized = String(value || "unknown").toLowerCase();

  let styles = "bg-muted text-muted-foreground";

  if (
    ["connected", "resolved", "info"].includes(normalized)
  ) {
    styles = "bg-soft-green text-primary";
  } else if (
    ["open", "warn", "warning"].includes(normalized)
  ) {
    styles = "bg-amber-100 text-amber-800";
  } else if (
    ["error", "disconnected", "failed"].includes(normalized)
  ) {
    styles = "bg-destructive/10 text-destructive";
  }

  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${styles}`}
    >
      {normalized.replaceAll("_", " ")}
    </span>
  );
}

function ErrorMessage({ children }) {
  if (!children) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      <AlertCircle
        size={18}
        className="mt-0.5 shrink-0 text-destructive"
      />
      <p>{children}</p>
    </div>
  );
}

function EmptyState({ children }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        {label}
      </span>

      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        {label}
      </span>

      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
      />
    </label>
  );
}

function DataTable({ headers, children }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[680px] border-collapse text-left text-sm">
        <thead className="bg-muted/60">
          <tr>
            {headers.map((header) => (
              <th
                key={header}
                scope="col"
                className="whitespace-nowrap px-4 py-3 text-xs font-semibold text-muted-foreground"
              >
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

function TableCell({ children, className = "" }) {
  return (
    <td className={`px-4 py-3 align-top ${className}`}>
      {children ?? "—"}
    </td>
  );
}

function Pagination({ pagination, onPageChange, disabled }) {
  if (!pagination) return null;

  const page = pagination.page || 1;
  const totalPages = Math.max(pagination.totalPages || 1, 1);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <p className="text-xs text-muted-foreground">
        Page {page} of {totalPages} · {formatNumber(pagination.total)} total
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="min-h-9 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          Previous
        </button>

        <button
          type="button"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="min-h-9 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function QueryStatus({ query, loadingText, emptyText, hasData }) {
  if (query.isPending) {
    return (
      <p className="text-sm text-muted-foreground">{loadingText}</p>
    );
  }

  if (query.isError) {
    return <ErrorMessage>{getErrorMessage(query.error)}</ErrorMessage>;
  }

  if (!hasData) {
    return <EmptyState>{emptyText}</EmptyState>;
  }

  return null;
}

export default function AdminSystemHealth() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const queryClient = useQueryClient();

  const [eventType, setEventType] = useState("");
  const [eventLevel, setEventLevel] = useState("");
  const [eventSellerId, setEventSellerId] = useState("");
  const [eventFrom, setEventFrom] = useState("");
  const [eventTo, setEventTo] = useState("");
  const [eventsPage, setEventsPage] = useState(1);

  const [reportStatus, setReportStatus] = useState("open");
  const [reportsPage, setReportsPage] = useState(1);
  const [reportNotes, setReportNotes] = useState({});
  const [reportActionError, setReportActionError] = useState("");

  const [auditAdminId, setAuditAdminId] = useState("");
  const [auditAction, setAuditAction] = useState("");
  const [auditTargetId, setAuditTargetId] = useState("");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");
  const [auditPage, setAuditPage] = useState(1);

  const enabled = isLoaded && isSignedIn;

  // Health summary
  const healthQuery = useQuery({
    queryKey: ["admin", "health"],
    queryFn: () => getAdminHealth(getToken),
    enabled,
  });

  // Troubleshooting events
  const eventsQuery = useQuery({
    queryKey: [
      "admin",
      "events",
      {
        type: eventType,
        level: eventLevel,
        sellerId: eventSellerId.trim(),
        from: eventFrom,
        to: eventTo,
        page: eventsPage,
        limit: 20,
      },
    ],
    queryFn: () =>
      getAdminEvents(getToken, {
        type: eventType,
        level: eventLevel,
        sellerId: eventSellerId.trim(),
        from: eventFrom,
        to: eventTo,
        page: eventsPage,
        limit: 20,
      }),
    enabled,
  });

  // Missing-order reports
  const reportsQuery = useQuery({
    queryKey: [
      "admin",
      "reports",
      { status: reportStatus, page: reportsPage, limit: 20 },
    ],
    queryFn: () =>
      getAdminReports(getToken, {
        status: reportStatus,
        page: reportsPage,
        limit: 20,
      }),
    enabled,
  });

  // Administrative audit log
  const auditQuery = useQuery({
    queryKey: [
      "admin",
      "audit",
      {
        adminId: auditAdminId.trim(),
        action: auditAction,
        targetId: auditTargetId.trim(),
        from: auditFrom,
        to: auditTo,
        page: auditPage,
        limit: 20,
      },
    ],
    queryFn: () =>
      getAdminAudit(getToken, {
        adminId: auditAdminId.trim(),
        action: auditAction,
        targetId: auditTargetId.trim(),
        from: auditFrom,
        to: auditTo,
        page: auditPage,
        limit: 20,
      }),
    enabled,
  });

  // Resolve a missing-order report
  const resolveMutation = useMutation({
    mutationFn: ({ reportId, note }) =>
      resolveAdminReport(getToken, reportId, note),

    onSuccess: async () => {
      setReportActionError("");

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["admin", "reports"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["admin", "health"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["admin", "audit"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["admin", "events"],
        }),
      ]);
    },

    onError: (error) => {
      setReportActionError(getErrorMessage(error));
    },
  });

  async function handleRefresh() {
    await Promise.all([
      healthQuery.refetch(),
      eventsQuery.refetch(),
      reportsQuery.refetch(),
      auditQuery.refetch(),
    ]);
  }

  function handleResolveReport(reportId) {
    setReportActionError("");

    resolveMutation.mutate({
      reportId,
      note: reportNotes[reportId] || "",
    });
  }

  if (!isLoaded) {
    return (
      <div className="flex min-h-64 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          Checking authentication...
        </p>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <section className="p-6 lg:p-8">
        <div
          role="alert"
          className="max-w-2xl rounded-xl border border-border bg-card p-5"
        >
          <h1 className="font-semibold">Sign-in required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Please sign in to access System Health.
          </p>
        </div>
      </section>
    );
  }

  const health = healthQuery.data;
  const events = eventsQuery.data?.events || [];
  const eventsPagination = eventsQuery.data?.pagination;
  const reports = reportsQuery.data?.reports || [];
  const reportsPagination = reportsQuery.data?.pagination;

  // The API contract describes audit results as a paginated collection.
  // Accept either `entries` or `audit` if the backend uses that wrapper.
  const auditData = auditQuery.data;
  const audit = auditData?.entries || auditData?.audit || [];
  const auditPagination = auditData?.pagination;

  const isRefreshing =
    healthQuery.isFetching ||
    eventsQuery.isFetching ||
    reportsQuery.isFetching ||
    auditQuery.isFetching;

  return (
    <section className="space-y-8 p-4 sm:p-6 lg:p-8">
      {/* Page heading */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <p className="text-sm font-medium text-primary">
            PLATFORM MONITORING
          </p>

          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
            System Health
          </h1>

          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Monitor platform errors, investigate missing orders, and review
            administrative activity.
          </p>
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw
            size={16}
            className={isRefreshing ? "animate-spin" : ""}
          />
          {isRefreshing ? "Refreshing..." : "Refresh data"}
        </button>
      </div>

      {/* Health summary */}
      <section className="space-y-4">
        <SectionHeading
          title="Health summary"
          description="Database status and operational counts reported by the backend."
        />

        {healthQuery.isPending && (
          <p className="text-sm text-muted-foreground">
            Loading health summary...
          </p>
        )}

        {healthQuery.isError && (
          <ErrorMessage>
            {getErrorMessage(healthQuery.error)}
          </ErrorMessage>
        )}

        {health && (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
              <Database
                size={20}
                className={
                  health.database === "connected"
                    ? "text-primary"
                    : "text-destructive"
                }
              />

              <span className="text-sm font-medium">Database</span>

              <StatusBadge value={health.database} />

              <span className="text-xs text-muted-foreground sm:ml-auto">
                Reporting window: {health.window?.hours ?? "—"} hours
              </span>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <MetricCard
                label="Failed submissions"
                value={health.failedSubmissions?.total}
                description="Order attempts that did not become orders within the reporting window."
                icon={FileWarning}
              />

              <MetricCard
                label="Server errors"
                value={health.serverErrors}
                description="Unexpected server errors within the reporting window."
                icon={ShieldAlert}
              />

              <MetricCard
                label="Notification failures"
                value={health.notificationFailures}
                description="Notification tracking is not implemented yet. Zero does not confirm successful delivery."
                icon={Activity}
              />

              <MetricCard
                label="Open reports"
                value={health.openReports}
                description="All unresolved missing-order reports, including older reports."
                icon={AlertCircle}
              />

              <MetricCard
                label="Reports in last 24 hours"
                value={health.reportsLast24h}
                description="Missing-order reports created within the reporting window."
                icon={Clock}
              />
            </div>

            {health.failedSubmissions?.byCode &&
              Object.keys(health.failedSubmissions.byCode).length > 0 && (
                <div className="rounded-xl border border-border bg-card p-5">
                  <h3 className="font-semibold">
                    Failed submissions by code
                  </h3>

                  <div className="mt-4 flex flex-wrap gap-3">
                    {Object.entries(
                      health.failedSubmissions.byCode,
                    ).map(([code, count]) => (
                      <div
                        key={code}
                        className="rounded-lg bg-muted px-3 py-2"
                      >
                        <p className="text-xs text-muted-foreground">
                          {code}
                        </p>
                        <p className="mt-1 font-semibold">
                          {formatNumber(count)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            <div className="text-xs text-muted-foreground mb-4">
              <p>Window start: {formatDate(health.window?.since)}</p>
              <p className="mt-1">
                Last generated: {formatDate(health.generatedAt)}
              </p>
            </div>
          </>
        )}
      </section>

      {/* Troubleshooting events */}
      <section className="space-y-4">
        <SectionHeading
          title="Troubleshooting events"
          description="Newest events first. Event records are designed to avoid exposing private customer details."
        />

        <div className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 xl:grid-cols-5">
          <FilterSelect
            label="Event type"
            value={eventType}
            onChange={(value) => {
              setEventType(value);
              setEventsPage(1);
            }}
            options={eventTypes}
          />

          <FilterSelect
            label="Level"
            value={eventLevel}
            onChange={(value) => {
              setEventLevel(value);
              setEventsPage(1);
            }}
            options={eventLevels}
          />

          <FilterInput
            label="Seller ID"
            value={eventSellerId}
            onChange={(value) => {
              setEventSellerId(value);
              setEventsPage(1);
            }}
            placeholder="Filter by seller"
          />

          <FilterInput
            label="From"
            type="date"
            value={eventFrom}
            onChange={(value) => {
              setEventFrom(value);
              setEventsPage(1);
            }}
          />

          <FilterInput
            label="To"
            type="date"
            value={eventTo}
            onChange={(value) => {
              setEventTo(value);
              setEventsPage(1);
            }}
          />
        </div>

        {eventsQuery.isError && (
          <ErrorMessage>
            {getErrorMessage(eventsQuery.error)}
          </ErrorMessage>
        )}

        {eventsQuery.isPending ? (
          <QueryStatus
            query={eventsQuery}
            loadingText="Loading events..."
            emptyText=""
            hasData={false}
          />
        ) : events.length > 0 ? (
          <>
            <DataTable
              headers={[
                "Date",
                "Type / level",
                "Code",
                "Message",
                "Seller ID",
                "Order reference",
              ]}
            >
              {events.map((event) => (
                <tr key={event.id}>
                  <TableCell>{formatDate(event.createdAt)}</TableCell>
                  <TableCell>
                    <p className="font-medium">
                      {event.type?.replaceAll("_", " ") || "—"}
                    </p>
                    <div className="mt-1">
                      <StatusBadge value={event.level} />
                    </div>
                  </TableCell>
                  <TableCell>{event.code || "—"}</TableCell>
                  <TableCell className="max-w-xs whitespace-normal">
                    {event.message || "—"}
                  </TableCell>
                  <TableCell className="max-w-40 break-all">
                    {event.sellerId || "—"}
                  </TableCell>
                  <TableCell>{event.orderRef || "—"}</TableCell>
                </tr>
              ))}
            </DataTable>

            <Pagination
              pagination={eventsPagination}
              onPageChange={setEventsPage}
              disabled={eventsQuery.isFetching}
            />
          </>
        ) : (
          <EmptyState>
            No events found for these filters.
          </EmptyState>
        )}
      </section>

      {/* Missing-order reports */}
      <section className="space-y-4 mt-4">
        <SectionHeading
          title="Missing-order reports"
          description="Investigate customer reports and resolve them after reviewing the available match information."
        >
          <div className="w-full sm:w-48">
            <FilterSelect
              label="Report status"
              value={reportStatus}
              onChange={(value) => {
                setReportStatus(value);
                setReportsPage(1);
              }}
              options={reportStatuses}
            />
          </div>
        </SectionHeading>

        <ErrorMessage>{reportActionError}</ErrorMessage>

        {reportsQuery.isError && (
          <ErrorMessage>
            {getErrorMessage(reportsQuery.error)}
          </ErrorMessage>
        )}

        {reportsQuery.isPending ? (
          <QueryStatus
            query={reportsQuery}
            loadingText="Loading reports..."
            emptyText=""
            hasData={false}
          />
        ) : reports.length > 0 ? (
          <>
            <div className="space-y-4">
              {reports.map((report) => (
                <article
                  key={report.id}
                  className="rounded-xl border border-border bg-card p-4 sm:p-5"
                >
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge value={report.status} />
                        <span className="text-xs text-muted-foreground">
                          {formatDate(report.createdAt)}
                        </span>
                      </div>

                      <h3 className="mt-3 font-semibold">
                        {report.seller?.businessName || "Unknown seller"}
                      </h3>

                      <p className="mt-1 text-sm text-muted-foreground">
                        Menu: {report.menuSlug || "—"}
                        {" · "}
                        Reference: {report.ref || "—"}
                      </p>
                    </div>

                    <div className="rounded-lg bg-muted px-3 py-2">
                      <p className="text-xs text-muted-foreground">
                        Phone last four digits
                      </p>
                      <p className="mt-1 font-semibold">
                        {report.phoneLast4 || "—"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 rounded-lg border border-border p-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Customer report
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">
                      {report.message || "No report message provided."}
                    </p>
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Order match
                      </p>
                      <p className="mt-1">
                        {report.orderFound === true
                          ? "Order found"
                          : report.orderFound === false
                            ? "No order found"
                            : "Not confirmed"}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs text-muted-foreground">
                        Matched order reference
                      </p>
                      <p className="mt-1 break-all">
                        {report.matchedOrderRef || "No unique match"}
                      </p>
                    </div>

                    {report.status === "resolved" && (
                      <>
                        <div>
                          <p className="text-xs text-muted-foreground">
                            Resolved by
                          </p>
                          <p className="mt-1 break-all">
                            {report.resolvedBy || "—"}
                          </p>
                        </div>

                        <div>
                          <p className="text-xs text-muted-foreground">
                            Resolved at
                          </p>
                          <p className="mt-1">
                            {formatDate(report.resolvedAt)}
                          </p>
                        </div>

                        {report.resolutionNote && (
                          <div className="sm:col-span-2">
                            <p className="text-xs text-muted-foreground">
                              Resolution note
                            </p>
                            <p className="mt-1 whitespace-pre-wrap">
                              {report.resolutionNote}
                            </p>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {report.status === "open" && (
                    <div className="mt-4 border-t border-border pt-4">
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
                          Resolution note (optional, max 300 characters)
                        </span>

                        <textarea
                          value={reportNotes[report.id] || ""}
                          maxLength={300}
                          rows={2}
                          onChange={(event) =>
                            setReportNotes((current) => ({
                              ...current,
                              [report.id]: event.target.value,
                            }))
                          }
                          placeholder="Record the outcome of your investigation"
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        />
                      </label>

                      <div className="mt-3 flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                        <span className="text-xs text-muted-foreground">
                          {(reportNotes[report.id] || "").length}/300 characters
                        </span>

                        <button
                          type="button"
                          onClick={() => handleResolveReport(report.id)}
                          disabled={resolveMutation.isPending}
                          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {resolveMutation.isPending &&
                          resolveMutation.variables?.reportId === report.id ? (
                            <RefreshCw size={16} className="animate-spin" />
                          ) : (
                            <CheckCircle2 size={16} />
                          )}

                          {resolveMutation.isPending &&
                          resolveMutation.variables?.reportId === report.id
                            ? "Resolving..."
                            : "Mark as resolved"}
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>

            <Pagination
              pagination={reportsPagination}
              onPageChange={setReportsPage}
              disabled={reportsQuery.isFetching || resolveMutation.isPending}
            />
          </>
        ) : (
          <EmptyState>
            No {reportStatus} missing-order reports found.
          </EmptyState>
        )}
      </section>

      {/* Administrative audit log */}
      <section className="space-y-4 mt-4">
        <SectionHeading
          title="Administrative audit log"
          description="Review recorded administrative actions. This log is read-only."
        />

        <div className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 xl:grid-cols-5">
          <FilterInput
            label="Admin ID"
            value={auditAdminId}
            onChange={(value) => {
              setAuditAdminId(value);
              setAuditPage(1);
            }}
            placeholder="Filter by admin"
          />

          <FilterSelect
            label="Action"
            value={auditAction}
            onChange={(value) => {
              setAuditAction(value);
              setAuditPage(1);
            }}
            options={auditActions}
          />

          <FilterInput
            label="Target ID"
            value={auditTargetId}
            onChange={(value) => {
              setAuditTargetId(value);
              setAuditPage(1);
            }}
            placeholder="Filter by target"
          />

          <FilterInput
            label="From"
            type="date"
            value={auditFrom}
            onChange={(value) => {
              setAuditFrom(value);
              setAuditPage(1);
            }}
          />

          <FilterInput
            label="To"
            type="date"
            value={auditTo}
            onChange={(value) => {
              setAuditTo(value);
              setAuditPage(1);
            }}
          />
        </div>

        {auditQuery.isError && (
          <ErrorMessage>
            {getErrorMessage(auditQuery.error)}
          </ErrorMessage>
        )}

        {auditQuery.isPending ? (
          <QueryStatus
            query={auditQuery}
            loadingText="Loading audit entries..."
            emptyText=""
            hasData={false}
          />
        ) : audit.length > 0 ? (
          <>
            <DataTable
              headers={[
                "Date",
                "Admin ID",
                "Action",
                "Target type",
                "Target",
                "Reason",
              ]}
            >
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <TableCell>{formatDate(entry.at)}</TableCell>
                  <TableCell className="max-w-40 break-all">
                    {entry.adminId || "—"}
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">
                      {entry.action || "—"}
                    </span>
                  </TableCell>
                  <TableCell>{entry.targetType || "—"}</TableCell>
                  <TableCell className="max-w-48 whitespace-normal">
                    <p>{entry.targetLabel || "—"}</p>
                    {entry.targetId && (
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        ID: {entry.targetId}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs whitespace-normal">
                    {entry.reason || "—"}
                  </TableCell>
                </tr>
              ))}
            </DataTable>

            <Pagination
              pagination={auditPagination}
              onPageChange={setAuditPage}
              disabled={auditQuery.isFetching}
            />
          </>
        ) : (
          <EmptyState>
            No audit entries found for these filters.
          </EmptyState>
        )}
      </section>

      {/* Operational note */}
      <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
        <Wrench
          size={20}
          className="mt-0.5 shrink-0 text-muted-foreground"
        />

        <div>
          <p className="text-sm font-medium">Operational note</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Event history is retained for 60 days. Audit records are retained
            separately. Notification failures cannot yet verify notification
            delivery because notification tracking is not implemented.
          </p>
        </div>

        <ShieldCheck
          size={18}
          className="mt-0.5 hidden shrink-0 text-muted-foreground sm:block"
        />
      </div>
    </section>
  );
}
