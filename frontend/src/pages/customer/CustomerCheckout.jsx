import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ClipboardList } from "lucide-react";

import { usePlaceOrder } from "@/hooks/usePlaceOrder";
import CustomerHeader from "@/components/customer/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/api/api-client";
import { FieldError } from "@/components/field-error";
import { hasErrors, validateOrder } from "@/lib/validation";

const formatPrice = (price) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(price);

export default function CustomerCheckout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { slug } = useParams();

  const { seller, menu, selectedItems } = location.state ?? {};

  const placeOrderMutation = usePlaceOrder();

  const [customer, setCustomer] = useState({
    name: "",
    phone: "",
  });

  const [delivery, setDelivery] = useState({
    area: "",
    address: "",
    day: "",
  });

  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  const clearFieldError = (name) =>
    setFieldErrors((current) => ({ ...current, [name]: "" }));

  const total = (selectedItems ?? []).reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );

  const updateCustomer = (event) => {
    const { name, value } = event.target;

    setCustomer((current) => ({
      ...current,
      [name]: value,
    }));
    clearFieldError(name);
  };

  const updateDelivery = (event) => {
    const { name, value } = event.target;

    setDelivery((current) => ({
      ...current,
      [name]: value,
    }));
    clearFieldError(name);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");

    if (!menu || !selectedItems?.length) {
      setError("Your basket is empty. Please return to the menu.");
      return;
    }

    const errors = validateOrder({ customer, delivery, note });
    setFieldErrors(errors);

    if (hasErrors(errors)) {
      setError("Please fix the highlighted fields above.");
      return;
    }

    const order = {
      menuId: menu.id,
      customer: {
        name: customer.name.trim(),
        phone: customer.phone.trim(),
      },
      delivery: {
        area: delivery.area,
        address: delivery.address.trim(),
        day: delivery.day,
      },
      note: note.trim() || undefined,
      lines: selectedItems.map((item) => ({
        itemId: item.id,
        qty: item.quantity,
      })),
    };

    try {
      const result = await placeOrderMutation.mutateAsync(order);

      navigate(`/shop/${slug}/confirmation`, {
        state: {
          order: result,
          seller,
        },
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "INVALID_AREA") {
        setFieldErrors((current) => ({
          ...current,
          area: `This area is no longer available. ${error.message}.`,
        }));
        setError("Please fix the highlighted fields above.");
        return;
      }

      if (error instanceof ApiError && error.code === "INVALID_DELIVERY_DAY") {
        setFieldErrors((current) => ({
          ...current,
          day: "This delivery day is no longer available. Choose another day.",
        }));
        setError("Please fix the highlighted fields above.");
        return;
      }

      const messages = {
        SOLD_OUT: `Some items sold out while you were ordering. ${error.message}. Go back to the menu and adjust your basket.`,
        ORDERING_CLOSED:
          "This menu has stopped taking orders. The cutoff time has passed or the seller closed it.",
        MENU_NOT_FOUND:
          "This menu is no longer available. Go back to the shop to see the current menu.",
        ITEM_NOT_FOUND:
          "One of the items in your basket is no longer on the menu. Go back to the menu and update your basket.",
        NETWORK_ERROR:
          "We couldn't reach the server. Check your internet connection and try again.",
      };

      setError(
        (error instanceof ApiError && messages[error.code]) ||
          (error instanceof Error
            ? error.message
            : "We couldn't place your order. Please try again.")
      );
    }
  };

  if (!menu || !selectedItems?.length) {
    return (
      <main className="min-h-[100dvh] bg-background px-4">
        <div className="mx-auto w-full max-w-[420px] py-6 md:max-w-3xl md:px-4 lg:max-w-5xl">
          <CustomerHeader />

          <section className="mt-12 space-y-4 text-center">
            <ClipboardList className="mx-auto size-10 text-muted-foreground" />

            <h1 className="text-xl font-bold text-foreground">
              No order to check out
            </h1>

            <p className="text-sm text-muted-foreground">
              Return to the menu and add items to your basket.
            </p>

            <Button onClick={() => navigate(`/shop/${slug ?? ""}`)}>
              Back to menu
            </Button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[100dvh] bg-background px-4">
      <div className="mx-auto w-full max-w-[420px] pb-10 md:max-w-3xl md:px-4 md:pb-14 lg:max-w-5xl">
        <CustomerHeader />

        <button
          type="button"
          onClick={() => navigate(`/shop/${slug}`)}
          className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={18} />
          Back to menu
        </button>

        <section className="mt-6 space-y-2">
          <p className="text-sm font-semibold uppercase tracking-wider text-primary">
            Checkout
          </p>

          <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-4xl">
            Delivery details
          </h1>

          <p className="text-sm text-muted-foreground">
            Ordering from {seller?.businessName ?? "your selected kitchen"}.
          </p>
        </section>

        <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-6 md:mt-8 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-8 lg:space-y-0">
          <div className="space-y-6">
            <section className="space-y-4 rounded-2xl border border-border bg-card p-4 md:p-6">
              <h2 className="font-semibold text-foreground">Your details</h2>

              <div className="space-y-4 md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
                <div className="space-y-2">
                  <Label htmlFor="customer-name">Full name *</Label>

                  <Input
                    id="customer-name"
                    aria-invalid={Boolean(fieldErrors.name)}
                    aria-describedby={fieldErrors.name ? "customer-name-error" : undefined}
                    name="name"
                    value={customer.name}
                    onChange={updateCustomer}
                    placeholder="Enter your full name"
                    autoComplete="name"
                    required
                  />

                  <FieldError
                    id="customer-name-error"
                    message={fieldErrors.name}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="customer-phone">Phone number *</Label>

                  <Input
                    id="customer-phone"
                    aria-invalid={Boolean(fieldErrors.phone)}
                    aria-describedby={fieldErrors.phone ? "customer-phone-error" : undefined}
                    name="phone"
                    type="tel"
                    value={customer.phone}
                    onChange={updateCustomer}
                    placeholder="e.g. 08012345678"
                    autoComplete="tel"
                    required
                  />

                  <FieldError
                    id="customer-phone-error"
                    message={fieldErrors.phone}
                  />
                </div>
              </div>
            </section>

            <section className="space-y-4 rounded-2xl border border-border bg-card p-4 md:p-6">
              <h2 className="font-semibold text-foreground">Delivery details</h2>

              <div className="space-y-2">
                <Label htmlFor="delivery-area">Delivery area *</Label>

                <select
                  id="delivery-area"
                  aria-invalid={Boolean(fieldErrors.area)}
                  aria-describedby={fieldErrors.area ? "delivery-area-error" : undefined}
                  name="area"
                  value={delivery.area}
                  onChange={updateDelivery}
                  required
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm aria-invalid:border-destructive"
                >
                  <option value="">Select your area</option>

                  {(menu.areas ?? []).map((area) => (
                    <option key={area} value={area}>
                      {area}
                    </option>
                  ))}
                </select>

                <FieldError
                  id="delivery-area-error"
                  message={fieldErrors.area}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="delivery-address">Delivery address *</Label>

                <Textarea
                  id="delivery-address"
                  aria-invalid={Boolean(fieldErrors.address)}
                  aria-describedby={fieldErrors.address ? "delivery-address-error" : undefined}
                  name="address"
                  value={delivery.address}
                  onChange={updateDelivery}
                  placeholder="Enter your street address and directions"
                  rows={3}
                  required
                />

                <FieldError
                  id="delivery-address-error"
                  message={fieldErrors.address}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="delivery-day">Delivery day *</Label>

                <select
                  id="delivery-day"
                  aria-invalid={Boolean(fieldErrors.day)}
                  aria-describedby={fieldErrors.day ? "delivery-day-error" : undefined}
                  name="day"
                  value={delivery.day}
                  onChange={updateDelivery}
                  required
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm aria-invalid:border-destructive"
                >
                  <option value="">Select delivery day</option>

                  {(menu.deliveryDays ?? []).map((day) => (
                    <option key={day} value={day}>
                      {new Date(`${day}T12:00:00`).toLocaleDateString("en-NG", {
                        weekday: "long",
                        day: "numeric",
                        month: "long",
                      })}
                    </option>
                  ))}
                </select>

                <FieldError
                  id="delivery-day-error"
                  message={fieldErrors.day}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="order-note">Additional note (optional)</Label>

                <Textarea
                  id="order-note"
                  aria-invalid={Boolean(fieldErrors.note)}
                  aria-describedby={fieldErrors.note ? "order-note-error" : undefined}
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                    clearFieldError("note");
                  }}
                  placeholder="Any special delivery instructions?"
                  rows={2}
                />

                <FieldError
                  id="order-note-error"
                  message={fieldErrors.note}
                />
              </div>
            </section>
          </div>

          <div className="space-y-6 lg:sticky lg:top-6">
            <section className="space-y-4 rounded-2xl border border-border bg-card p-4 md:p-6">
              <h2 className="font-semibold text-foreground">Your order</h2>

              {selectedItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start justify-between gap-3 text-sm"
                >
                  <div>
                    <p className="font-medium text-foreground">{item.name}</p>

                    <p className="text-muted-foreground">
                      {item.quantity} × {formatPrice(item.price)}
                    </p>
                  </div>

                  <p className="shrink-0 font-medium text-foreground">
                    {formatPrice(item.quantity * item.price)}
                  </p>
                </div>
              ))}

              <div className="flex items-center justify-between border-t border-border pt-4">
                <span className="font-semibold">Total</span>

                <span className="text-xl font-bold text-primary">
                  {formatPrice(total)}
                </span>
              </div>
            </section>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button
              type="submit"
              className="w-full rounded-xl"
              disabled={placeOrderMutation.isPending}
            >
              {placeOrderMutation.isPending ? "Placing order..." : "Place order"}
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              Your order details will be sent to the kitchen for processing.
            </p>
          </div>
        </form>
      </div>
    </main>
  );
}
