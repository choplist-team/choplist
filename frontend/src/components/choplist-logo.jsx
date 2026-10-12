import { Utensils } from "lucide-react";

export function ChopListLogo() {
  return (
    <div className="flex items-center gap-2 text-3xl font-bold text-primary">
      <Utensils className="h-7 w-7" />
      <span>choplist</span>
    </div>
  );
}