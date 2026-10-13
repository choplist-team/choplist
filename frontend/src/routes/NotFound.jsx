import { useNavigate } from "react-router-dom";
import { ArrowLeft, House, SearchX } from "lucide-react";
import { ChopListLogo } from "@/components/choplist-logo";

export default function NotFound() {
  const navigate = useNavigate();

  return (
    <main className="min-h-[100dvh] bg-background px-4 py-8">
      <div className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-[420px] flex-col">
        <header className="flex justify-center">
          <ChopListLogo />
        </header>

        <section className="flex flex-1 flex-col items-center justify-center py-12 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-soft-green">
            <SearchX className="h-10 w-10 text-primary" />
          </div>

          <p className="mt-8 text-sm font-bold uppercase tracking-[0.2em] text-primary">
            Error 404
          </p>

          <h1 className="mt-3 text-3xl font-bold tracking-tight text-foreground">
            Page not found
          </h1>

          <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
            Oops! We couldn't find the page you're looking for. It may have been
            moved, or the link might be incorrect.
          </p>

          <div className="mt-8 flex w-full flex-col gap-3">
            <button
              type="button"
              onClick={() => navigate("/")}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              <House className="h-4 w-4" />
              Back to home
            </button>

            <button
              type="button"
              onClick={() => navigate(-1)}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              <ArrowLeft className="h-4 w-4" />
              Go back
            </button>
          </div>
        </section>

        <footer className="py-4 text-center">
          <p className="text-xs text-muted-foreground">
            Made with care by ChopList.
          </p>
        </footer>
      </div>
    </main>
  );
}
