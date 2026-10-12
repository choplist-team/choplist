
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function QuantityStepper({
  quantity = 0,
  max = 0,
  onChange,
  disabled = false,
}) {
  const canDecrease = quantity > 0;
  const canIncrease = quantity < max;

  return (
    <div
      className="flex items-center gap-2 rounded-2xl bg-soft-green p-1.5"
      aria-label="Select quantity"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Decrease quantity"
        disabled={disabled || !canDecrease}
        onClick={() => onChange(Math.max(0, quantity - 1))}
        className="size-9 text-primary hover:bg-white/60"
      >
        <Minus size={18} />
      </Button>

      <span
        aria-live="polite"
        className="min-w-6 text-center font-semibold tabular-nums"
      >
        {quantity}
      </span>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Increase quantity"
        disabled={disabled || !canIncrease}
        onClick={() => onChange(Math.min(max, quantity + 1))}
        className="size-9 text-primary hover:bg-white/60"
      >
        <Plus size={18} />
      </Button>
    </div>
  );
}
