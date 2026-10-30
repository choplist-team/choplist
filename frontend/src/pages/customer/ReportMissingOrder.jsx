import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, CircleCheck, MessageSquareWarning } from "lucide-react";

import CustomerHeader from "@/components/customer/Header";
import { FieldError } from "@/components/field-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { reportMissingOrder } from "@/api/customer-api";
import { hasErrors, validateMissingOrder } from "@/lib/validation";

const linkButton =
  "flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 text-sm font-medium hover:bg-muted";

export default function ReportMissingOrder() {
  const [reference, setReference] = useState("");
  const [phoneLast4, setPhoneLast4] = useState("");
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  const report = useMutation({ mutationFn: reportMissingOrder });

  const clear = (field) =>
    setFieldErrors((current) => ({ ...current, [field]: "" }));

  const handleSubmit = (event) => {
    event.preventDefault();

    const errors = validateMissingOrder({ reference, phoneLast4, message });
    setFieldErrors(errors);
    if (hasErrors(errors)) return;

    report.mutate({
      ref: reference.trim().toUpperCase(),
      phoneLast4: phoneLast4.trim(),
      message: message.trim(),
    });
  };

  // The server gives the same answer whether or not it found an order, so this
  // message must not say anything about whether one was found.
  if (report.isSuccess) {
    return (
      <main className="min-h-[100dvh] bg-background px-4">
        <div className="mx-auto w-full max-w-[420px] pb-10 md:max-w-xl md:pb-14">
          <CustomerHeader />

          <section
            role="status"
            className="mt-8 rounded-2xl border border-border bg-card p-6 text-center md:mt-12"
          >
            <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-soft-green text-primary">
              <CircleCheck size={25} />
            </div>
            <h1 className="mt-4 text-xl font-bold text-foreground">
              We've received your report
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              The ChopList team will look into it. Keep your payment receipt in
              case we need it.
            </p>
            <Link to="/order-lookup" className={`${linkButton} mt-6`}>
              Back to order lookup
            </Link>
          </section>
        </div>
      </main>
    );
  }

  const code = report.error?.code;

  return (
    <main className="min-h-[100dvh] bg-background px-4">
      <div className="mx-auto w-full max-w-[420px] pb-10 md:max-w-xl md:pb-14">
        <CustomerHeader />

        <section className="mt-8 space-y-2 md:mt-12">
          <div className="flex size-12 items-center justify-center rounded-xl bg-soft-green text-primary">
            <MessageSquareWarning size={25} />
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-4xl">
            My order is missing
          </h1>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Tell us what happened and we'll look into it. Give your order
            reference, or the last four digits of the phone number you ordered
            with.
          </p>
        </section>

        <form
          onSubmit={handleSubmit}
          noValidate
          className="mt-6 space-y-4 rounded-2xl border border-border bg-card p-5 md:p-6"
        >
          <div className="space-y-2">
            <Label htmlFor="reference">Order reference (optional)</Label>
            <Input
              id="reference"
              value={reference}
              onChange={(event) => {
                setReference(event.target.value);
                clear("reference");
              }}
              aria-invalid={Boolean(fieldErrors.reference)}
              aria-describedby={
                fieldErrors.reference ? "reference-error" : undefined
              }
              placeholder="e.g. CL-7KQ2M"
              autoComplete="off"
            />
            <FieldError id="reference-error" message={fieldErrors.reference} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="phoneLast4">
              Last four digits of phone number (optional)
            </Label>
            <Input
              id="phoneLast4"
              value={phoneLast4}
              onChange={(event) => {
                setPhoneLast4(
                  event.target.value.replace(/\D/g, "").slice(0, 4)
                );
                clear("phoneLast4");
              }}
              aria-invalid={Boolean(fieldErrors.phoneLast4)}
              aria-describedby={
                fieldErrors.phoneLast4 ? "phoneLast4-error" : undefined
              }
              placeholder="e.g. 1234"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
            />
            <FieldError
              id="phoneLast4-error"
              message={fieldErrors.phoneLast4}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="message">What happened?</Label>
            <Textarea
              id="message"
              value={message}
              onChange={(event) => {
                setMessage(event.target.value);
                clear("message");
              }}
              aria-invalid={Boolean(fieldErrors.message)}
              aria-describedby={
                fieldErrors.message ? "message-error" : undefined
              }
              placeholder="e.g. I transferred at 3pm and nothing has come."
              maxLength={500}
              rows={4}
            />
            <FieldError id="message-error" message={fieldErrors.message} />
          </div>

          {report.isError && (
            <p role="alert" className="text-sm text-destructive">
              {code === "RATE_LIMITED"
                ? "You've sent several reports in a short time. Please try again in a few minutes."
                : code === "NETWORK_ERROR"
                ? "We couldn't reach the server. Check your internet connection and try again."
                : report.error?.message ||
                  "Something went wrong. Please try again."}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={report.isPending}>
            {report.isPending ? "Sending..." : "Send report"}
          </Button>
        </form>

        <Link to="/order-lookup" className={`${linkButton} mt-5`}>
          <ArrowLeft size={18} />
          Back to order lookup
        </Link>
      </div>
    </main>
  );
}
