
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Trash2, RefreshCw } from "lucide-react";

import { ApiError } from "@/api/api-client";
import { getMenuById, updateMenu } from "@/api/seller-api";
import SellerHeader from "@/components/seller/Header";
import SellerBottomNav from "@/components/seller/BottomNav";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";

function toLocalDateTime(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  const offset = date.getTimezoneOffset() * 60_000;

  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function toIsoWithTimezone(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Enter a valid order cutoff date and time.");
  }

  return date.toISOString();
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
    <div className="mt-8 rounded-xl border border-border bg-card p-5">
      <h1 className="font-semibold text-foreground">{title}</h1>

      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {message}
      </p>

      <button
        type="button"
        onClick={onBack}
        className="mt-5 w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground"
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
      <main className="min-h-[100dvh] bg-background px-4 py-6">
        <div className="mx-auto w-full max-w-[420px]">
          <SellerHeader businessName={seller?.businessName ?? "Your shop"} />
          <LoadingState />
        </div>

        <SellerBottomNav />
      </main>
    );
  }

  if (menuQuery.isError || !menuQuery.data) {
    return (
      <main className="min-h-[100dvh] bg-background px-4 py-6">
        <div className="mx-auto w-full max-w-[420px]">
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
      <main className="min-h-[100dvh] bg-background px-4 py-6">
        <div className="mx-auto w-full max-w-[420px]">
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
    setItems((current) => current.filter((_, i) => i !== index));
  };

  const addDeliveryDay = () => {
    setDeliveryDays((current) => [...current, ""]);
  };

  const updateDeliveryDay = (index, value) => {
    setDeliveryDays((current) =>
      current.map((day, i) => (i === index ? value : day)),
    );
  };

  const removeDeliveryDay = (index) => {
    setDeliveryDays((current) =>
      current.filter((_, i) => i !== index),
    );
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    setErrorMessage("");

    const areas = [
      ...new Set(
        areasText
          .split(",")
          .map((area) => area.trim())
          .filter(Boolean),
      ),
    ];

    const cleanedItems = items.map((item) => ({
      name: item.name.trim(),
      description: item.description.trim(),
      price: Number(item.price),
      qty: Number(item.qty),
    }));

    const cleanedDeliveryDays = deliveryDays.filter(Boolean);

    if (!title.trim()) {
      setErrorMessage("Enter a title for this menu.");
      return;
    }

    if (cleanedItems.length < 1 || cleanedItems.length > 30) {
      setErrorMessage("Add between 1 and 30 dishes.");
      return;
    }

    if (
      cleanedItems.some(
        (item) =>
          !item.name ||
          !Number.isInteger(item.price) ||
          item.price < 1 ||
          !Number.isInteger(item.qty) ||
          item.qty < 1 ||
          item.qty > 1000,
      )
    ) {
      setErrorMessage(
        "Every dish needs a name, a whole-naira price, and 1–1000 portions.",
      );
      return;
    }

    if (areas.length < 1 || areas.length > 30) {
      setErrorMessage("Enter between 1 and 30 delivery areas.");
      return;
    }

    if (
      cleanedDeliveryDays.length < 1 ||
      new Set(cleanedDeliveryDays).size !== cleanedDeliveryDays.length
    ) {
      setErrorMessage("Choose at least one unique delivery date.");
      return;
    }

    if (cleanedDeliveryDays.some((day) => !/^\d{4}-\d{2}-\d{2}$/.test(day))) {
      setErrorMessage("Enter valid delivery dates.");
      return;
    }

    let cutoff;

    try {
      cutoff = toIsoWithTimezone(cutoffAt);
    } catch (error) {
      setErrorMessage(error.message);
      return;
    }

    if (new Date(cutoff).getTime() <= Date.now()) {
      setErrorMessage("The order cutoff must be in the future.");
      return;
    }

    const cutoffDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Lagos",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(cutoff));

    if (cleanedDeliveryDays.some((day) => day < cutoffDate)) {
      setErrorMessage(
        "Delivery dates cannot be before the cutoff date in Lagos time.",
      );
      return;
    }

    updateMenuMutation.mutate({
      title: title.trim(),
      cutoffAt: cutoff,
      items: cleanedItems,
      areas,
      deliveryDays: cleanedDeliveryDays,
    });
  };

  return (
    <main className="min-h-[100dvh] bg-background px-4 py-6">
      <div className="mx-auto w-full max-w-[420px] pb-26">
        <SellerHeader businessName={seller?.businessName ?? "Your shop"} />

        <button
          type="button"
          onClick={() => navigate("/seller/dashboard")}
          className="mt-8 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </button>

        <section className="mt-6">
          <h1 className="text-3xl font-bold text-foreground">
            Edit menu
          </h1>

          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Update your draft menu, dishes, cutoff, and delivery details.
          </p>
        </section>

        <form onSubmit={handleSubmit} className="mt-8 space-y-7">
          <section>
            <div className="space-y-4 rounded-xl border border-border bg-card p-4">
              <div>
                <label
                  htmlFor="menu-title"
                  className="text-sm font-medium text-foreground"
                >
                  Menu title
                </label>

                <input
                  id="menu-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  className="mt-2 w-full rounded-lg border border-border bg-card px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
                  type="datetime-local"
                  value={cutoffAt}
                  onChange={(event) => setCutoffAt(event.target.value)}
                  required
                  className="w-full rounded-lg border border-border bg-card px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
                className="space-y-4 rounded-xl border border-border bg-card p-4"
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
                    value={item.name}
                    onChange={(event) =>
                      updateDish(index, "name", event.target.value)
                    }
                    placeholder="e.g. Jollof rice"
                    required
                    className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
                    value={item.description}
                    onChange={(event) =>
                      updateDish(index, "description", event.target.value)
                    }
                    placeholder="Describe the dish"
                    rows={2}
                    className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
                      type="number"
                      min="1"
                      step="1"
                      inputMode="numeric"
                      value={item.price}
                      onChange={(event) =>
                        updateDish(index, "price", event.target.value)
                      }
                      required
                      className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
                      className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
          </section>

          <section>
            <div className="space-y-4 rounded-xl border border-border bg-card p-4">
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
                  <div key={index} className="flex items-center gap-2">
                    <input
                      type="date"
                      value={day}
                      onChange={(event) =>
                        updateDeliveryDay(index, event.target.value)
                      }
                      required
                      aria-label={`Delivery day ${index + 1}`}
                      className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
                ))}
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
                  value={areasText}
                  onChange={(event) => setAreasText(event.target.value)}
                  placeholder="Yaba, Surulere, Lekki"
                  rows={3}
                  required
                  className="w-full rounded-lg border border-border bg-card px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
            className="w-full rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
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