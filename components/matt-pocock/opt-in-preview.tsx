import { planOptIn } from "./model";
import type { MattState } from "./model";

export function OptInPreview({ state, ids }: { state: MattState; ids: string[] }) {
  const plan = planOptIn(state, ids);
  return (
    <div className="space-y-3 text-sm">
      <p>Experimental. Off by default. Enable only the skills you want.</p>
      <p>Selected skills: {plan.ids.join(", ")}</p>
      <p>Experimental opt-ins: {plan.experimental.join(", ")}</p>
      <p>Required dependencies: {plan.dependencies.join(", ") || "None"}</p>
      <p className="text-xs text-muted-foreground">Confirming saves these experimental choices in the selected scope. Stable skills never turn them on silently.</p>
    </div>
  );
}
