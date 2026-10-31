import { Utensils } from "lucide-react";

export function ChopListLogo() {
  return (
    <div className="flex items-center gap-2 text-3xl font-bold text-primary">
      <Utensils className="h-7 w-7" />
      <div className="flex flex-col">
        <span className="text-2xl font-bold leading-none tracking-tight">
          choplist
        </span>
        <span className="font-semibold text-xs mt-1 leading-none">Africa</span>
      </div>
    </div>
  );
}
