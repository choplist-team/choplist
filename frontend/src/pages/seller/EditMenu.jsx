
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Trash2, RefreshCw } from "lucide-react";

import { ApiError } from "@/api/api-client";
import { getMenuById, updateMenu } from "@/api/seller-api";
import SellerHeader from "@/components/seller/Header";
import { FieldError } from "@/components/field-error";
import { hasErrors, validateMenu } from "@/lib/validation";
import SellerBottomNav from "@/components/seller/BottomNav";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";

function toLocalDateTime(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  const offset = date.getTimezoneOffset() * 60_000;

  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function getErrorMessage(error) {
  if (error instanceof ApiError) return error.message;

  return error?.message || "Something went wrong. Please try again.";
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
      <RefreshCw className="h-4 w-4 animate-spin" />
      Loading menu...
    </div>
  );
}

function PageMessage({ title, message, onBack }) {
  return (
    <div className="mt-8 rounded-xl border border-border bg-card p-5 lg:mt-0">
      <h1 className="font-semibold text-foreground">{title}</h1>

      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {message}
      </p>

      <button
        type="button"
        onClick={onBack}
        className="mt-5 w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground md:w-auto md:px-6"
      >
        Back to dashboard
      </button>
    </div>
  );
}

export default function EditMenu() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const { data: seller } = useCurrentSeller();

  const menuQuery = useQuery({
    queryKey: ["menu", id],
    queryFn: () => getMenuById(id, getToken),
    enabled: Boolean(id),
    retry: (failureCount, error) => {
      if (error?.status === 401 || error?.status === 403) {
        return false;
      }

      return failureCount < 2;
    },
  });

  if (menuQuery.isPending) {
    return (
      <main className="min-h-[100dvh] bg-background px-4 py-6 md:px-8 md:pt-10 lg:pl-72 lg:pr-8">
        <div className="mx-auto w-full max-w-[420px] md:max-w-2xl">
          <SellerHeader businessName={seller?.businessName ?? "Your shop"} />
          <LoadingState />
        </div>

        <SellerBottomNav />
      </main>
    );
  }

  if (menuQuery.isError || !menuQuery.data) {
    return (
      <main className="min-h-[100dvh] bg-background px-4 py-6 md:px-8 md:pt-10 lg:pl-72 lg:pr-8">
        <div className="mx-auto w-full max-w-[420px] md:max-w-2xl">
          <SellerHeader businessName={seller?.businessName ?? "Your shop"} />

          <PageMessage
            title="Could not load menu"
            message={getErrorMessage(menuQuery.error)}
            onBack={() => navigate("/seller/dashboard")}
          />
        </div>

        <SellerBottomNav />
      </main>
    );
  }

  const menu = menuQuery.data;

  if (menu.status !== "draft") {
    return (
      <main className="min-h-[100dvh] bg-background px-4 py-6 md:px-8 md:pt-10 lg:pl-72 lg:pr-8">
        <div className="mx-auto w-full max-w-[420px] md:max-w-2xl">
          <SellerHeader businessName={seller?.businessName ?? "Your shop"} />

          <PageMessage
            title="This menu cannot be edited"
            message={`Only draft menus can be edited. This menu is currently ${menu.status}.`}
            onBack={() => navigate("/seller/dashboard")}
          />
        </div>

        <SellerBottomNav />
      </main>
    );
  }

  return (
    <EditMenuForm
      key={menu.id}
      menu={menu}
      seller={seller}
      getToken={getToken}
      queryClient={queryClient}
      navigate={navigate}
    />
  );
}

function EditMenuForm({
  menu,
  seller,
  getToken,
  queryClient,
  navigate,
}) {
  const [title, setTitle] = useState(menu.title ?? "");
  const [cutoffAt, setCutoffAt] = useState(
    toLocalDateTime(menu.cutoffAt),
  );

  const [items, setItems] = useState(
    (menu.items ?? []).map((item) => ({
      name: item.name ?? "",
      description: item.description ?? "",
      price: String(item.price ?? ""),
      qty: String(item.qtyTotal ?? item.qty ?? ""),
    })),
  );

  const [areasText, setAreasText] = useState(
    (menu.areas ?? []).join(", "),
  );

  const [deliveryDays, setDeliveryDays] = useState(
    menu.deliveryDays ?? [],
  );

  const [errorMessage, setErrorMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  const clearFieldError = (name) =>
    setFieldErrors((current) => ({ ...current, [name]: "" }));

  const updateMenuMutation = useMutation({
    mutationFn: (updatedMenu) =>
      updateMenu(menu.id, updatedMenu, getToken),

    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["menus"] }),
        queryClient.invalidateQueries({ queryKey: ["menu", menu.id] }),
      ]);

      navigate("/seller/dashboard", { replace: true });
    },

    onError: (error) => {
      setErrorMessage(getErrorMessage(error));
    },
  });

  const updateDish = (index, field, value) => {
    clearFieldError(`item-${index}-${field}`);
    setItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, [field]: value }
          : item,
      ),
    );
  };

  const addDish = () => {
    if (items.length >= 30) return;

    setItems((current) => [
      ...current,
      { name: "", description: "", price: "", qty: "" },
    ]);
  };

  const removeDish = (index) => {
    setFieldErrors({});
    setItems((current) => current.filter((_, i) => i !== index));
  };

  const addDeliveryDay = () => {
    setDeliveryDays((current) => [...current, ""]);
  };

  const updateDeliveryDay = (index, value) => {
    clearFieldError(`deliveryDay-${index}`);
    setDeliveryDays((current) =>
      current.map((day, i) => (i === index ? value : day)),
    );
  };

  const removeDeliveryDay = (index) => {
    setFieldErrors({});
    setDeliveryDays((current) =>
      current.filter((_, i) => i !== index),
    );
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    setErrorMessage("");

    const { errors, menu: menuBody } = validateMenu({
      title,
      cutoffAt,
      items,
      areasText,
      deliveryDays,
    });

    setFieldErrors(errors);

    if (hasErrors(errors)) {
      setErrorMessage("Please fix the highlighted fields above.");
      return;
    }

    updateMenuMutation.mutate(menuBody);
  };

  return (
    <main className="min-h-[100dvh] bg-background px-4 py-6 md:px-8 md:pt-10 lg:pl-72 lg:pr-8">
      <div className="mx-auto w-full max-w-[420px] pb-26 md:max-w-2xl lg:pb-6">
        <SellerHeader businessName={seller?.businessName ?? "Your shop"} />

        <button
          type="button"
          onClick={() => navigate("/seller/dashboard")}
          className="mt-8 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground lg:mt-0"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </button>

        <section className="mt-6">
          <h1 className="text-3xl font-bold text-foreground md:text-4xl">
            Edit menu
          </h1>

          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Update your draft menu, dishes, cutoff, and delivery details.
          </p>
        </section>

        <form onSubmit={handleSubmit} noValidate className="mt-8 space-y-7">
          <section>
            <div className="space-y-4 rounded-xl border border-border bg-card p-4 md:grid md:grid-cols-2 md:gap-4 md:space-y-0 md:p-5">
              <div>
                <label
                  htmlFor="menu-title"
                  className="text-sm font-medium text-foreground"
                >
                  Menu title
                </label>

                <input
                  id="menu-title"
                  aria-invalid={Boolean(fieldErrors.title)}
                  aria-describedby={fieldErrors.title ? "menu-title-error" : undefined}
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    clearFieldError("title");
                  }}
                  required
                  className="aria-invalid:border-destructive mt-2 w-full rounded-lg border border-border bg-card px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />

                <FieldError
                  id="menu-title-error"
                  message={fieldErrors.title}
                />
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="menu-cutoff"
                  className="text-sm font-medium text-foreground"
                >
                  Order cutoff
                </label>

                <input
                  id="menu-cutoff"
                  aria-invalid={Boolean(fieldErrors.cutoffAt)}
                  aria-describedby={fieldErrors.cutoffAt ? "menu-cutoff-error" : undefined}
                  type="datetime-local"
                  value={cutoffAt}
                  onChange={(event) => {
                    setCutoffAt(event.target.value);
                    clearFieldError("cutoffAt");
                  }}
                  required
                  className="aria-invalid:border-destructive w-full rounded-lg border border-border bg-card px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />

                <FieldError
                  id="menu-cutoff-error"
                  message={fieldErrors.cutoffAt}
                />
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-foreground">
                Your dishes
              </h2>

              <span className="text-xs text-muted-foreground">
                {items.length}/30
              </span>
            </div>

            {items.map((item, index) => (
              <div
                key={index}
                className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-5"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-medium text-foreground">
                    Dish {index + 1}
                  </h3>

                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeDish(index)}
                      aria-label={`Remove dish ${index + 1}`}
                      className="rounded-md p-2 text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor={`dish-name-${index}`}
                    className="text-sm font-medium text-foreground"
                  >
                    Dish name
                  </label>

                  <input
                    id={`dish-name-${index}`}
                    aria-invalid={Boolean(fieldErrors[`item-${index}-name`])}
                    aria-describedby={fieldErrors[`item-${index}-name`] ? `dish-name-${index}-error` : undefined}
                    value={item.name}
                    onChange={(event) =>
                      updateDish(index, "name", event.target.value)
                    }
                    placeholder="e.g. Jollof rice"
                    required
                    className="aria-invalid:border-destructive w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  />

                  <FieldError
                    id={`dish-name-${index}-error`}
                    message={fieldErrors[`item-${index}-name`]}
                  />
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor={`dish-description-${index}`}
                    className="text-sm font-medium text-foreground"
                  >
                    Description (optional)
                  </label>

                  <textarea
                    id={`dish-description-${index}`}
                    aria-invalid={Boolean(fieldErrors[`item-${index}-description`])}
                    aria-describedby={fieldErrors[`item-${index}-description`] ? `dish-description-${index}-error` : undefined}
                    value={item.description}
                    onChange={(event) =>
                      updateDish(index, "description", event.target.value)
                    }
                    placeholder="Describe the dish"
                    rows={2}
                    className="aria-invalid:border-destructive w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  />

                  <FieldError
                    id={`dish-description-${index}-error`}
                    message={fieldErrors[`item-${index}-description`]}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <label
                      htmlFor={`dish-price-${index}`}
                      className="text-sm font-medium text-foreground"
                    >
                      Price (₦)
                    </label>

                    <input
                      id={`dish-price-${index}`}
                      aria-invalid={Boolean(fieldErrors[`item-${index}-price`])}
                      aria-describedby={fieldErrors[`item-${index}-price`] ? `dish-price-${index}-error` : undefined}
                      type="number"
                      min="1"
                      step="1"
                      inputMode="numeric"
                      value={item.price}
                      onChange={(event) =>
                        updateDish(index, "price", event.target.value)
                      }
                      required
                      className="aria-invalid:border-destructive w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    />

                    <FieldError
                      id={`dish-price-${index}-error`}
                      message={fieldErrors[`item-${index}-price`]}
                    />
                  </div>

                  <div className="space-y-2">
                    <label
                      htmlFor={`dish-qty-${index}`}
                      className="text-sm font-medium text-foreground"
                    >
                      Portions
                    </label>

                    <input
                      id={`dish-qty-${index}`}
                      aria-invalid={Boolean(fieldErrors[`item-${index}-qty`])}
                      aria-describedby={fieldErrors[`item-${index}-qty`] ? `dish-qty-${index}-error` : undefined}
                      type="number"
                      min="1"
                      max="1000"
                      step="1"
                      inputMode="numeric"
                      value={item.qty}
                      onChange={(event) =>
                        updateDish(index, "qty", event.target.value)
                      }
                      required
                      className="aria-invalid:border-destructive w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    />

                    <FieldError
                      id={`dish-qty-${index}-error`}
                      message={fieldErrors[`item-${index}-qty`]}
                    />
                  </div>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={addDish}
              disabled={items.length >= 30}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-3 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              Add a dish
            </button>

            <FieldError message={fieldErrors.items} />
          </section>

          <section>
            <div className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-5">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-sm font-semibold text-foreground">
                    Delivery days
                  </label>

                  <button
                    type="button"
                    onClick={addDeliveryDay}
                    className="text-sm font-semibold text-primary"
                  >
                    + Add day
                  </button>
                </div>

                {deliveryDays.map((day, index) => (
                  <div key={index} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="date"
                        aria-invalid={Boolean(fieldErrors[`deliveryDay-${index}`])}
                        value={day}
                        onChange={(event) =>
                          updateDeliveryDay(index, event.target.value)
                        }
                        required
                        aria-label={`Delivery day ${index + 1}`}
                        className="aria-invalid:border-destructive min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      />

                      {deliveryDays.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeDeliveryDay(index)}
                          aria-label={`Remove delivery day ${index + 1}`}
                          className="rounded-md p-2 text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                    <FieldError message={fieldErrors[`deliveryDay-${index}`]} />
                  </div>
                ))}

                <FieldError message={fieldErrors.deliveryDays} />
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="delivery-areas"
                  className="text-sm font-medium text-foreground"
                >
                  Delivery areas
                </label>

                <textarea
                  id="delivery-areas"
                  aria-invalid={Boolean(fieldErrors.areas)}
                  aria-describedby={fieldErrors.areas ? "delivery-areas-error" : undefined}
                  value={areasText}
                  onChange={(event) => {
                    setAreasText(event.target.value);
                    clearFieldError("areas");
                  }}
                  placeholder="Yaba, Surulere, Lekki"
                  rows={3}
                  required
                  className="aria-invalid:border-destructive w-full rounded-lg border border-border bg-card px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />

                <FieldError
                  id="delivery-areas-error"
                  message={fieldErrors.areas}
                />

                <p className="text-xs text-muted-foreground">
                  Enter different areas, separated by commas.
                </p>
              </div>
            </div>
          </section>

          {errorMessage && (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
            >
              {errorMessage}
            </p>
          )}

          <button
            type="submit"
            disabled={updateMenuMutation.isPending}
            className="w-full rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 md:ml-auto md:block md:w-auto md:px-8"
          >
            {updateMenuMutation.isPending
              ? "Saving changes..."
              : "Save menu changes"}
          </button>
        </form>
      </div>

      <SellerBottomNav />
    </main>
  );
}