import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { mirrorConfig } from "../../mirror.config";
import type { CatalogSkill } from "../../shared/catalog";
import type { ConflictChoice, ConflictSource, ConflictState, ScanSnapshot } from "../../shared/conflicts";
import type { ResolvedSkill } from "./model";

export function matchingSnapshot(conflict: ConflictState, snapshots: readonly ScanSnapshot[]): ScanSnapshot | undefined {
  return snapshots.find((snapshot) => JSON.stringify(snapshot.scope) === JSON.stringify(conflict.scope));
}

export function verifiedDelivery(conflict: ConflictState, snapshot?: ScanSnapshot): boolean {
  return snapshot !== undefined && JSON.stringify(snapshot.scope) === JSON.stringify(conflict.scope) &&
    snapshot.complete && snapshot.freshness !== "invalidated" && snapshot.generation === conflict.snapshotGeneration &&
    !snapshot.affectedUnknownNames.includes(conflict.canonicalId) &&
    (!conflict.effectiveName || !snapshot.affectedUnknownNames.includes(conflict.effectiveName));
}

/** Who else provides a skill with the same name, in words a user recognises. */
export function ownerLabel(source: ConflictSource): string {
  switch (source.scope) {
    case "bb-plugin":
    case "native-plugin":
      return source.pluginId ? `the ${source.pluginId} plugin` : "another plugin";
    case "bb-user":
    case "shared-user":
    case "provider-user":
      return "your own skills";
    case "project":
    case "shared-project":
    case "provider-project":
      return "this project's skills";
    case "inherited":
      return "bb's built-in skills";
    case "command":
      return `a /${source.name} command`;
  }
}

const competing = (conflict: ConflictState) => conflict.sources.filter((source) =>
  source.name === conflict.canonicalId && source.active && source.selection !== "omitted",
);

/** What new threads get today: "yours", "both", "matt", or "checking" while discovery is unverified. */
export type ClashCurrent = "yours" | "both" | "matt" | "checking";

export type Clash = {
  canonicalId: string;
  aliasName: string;
  owners: string[];
  requestedChoice: ConflictChoice;
  current: ClashCurrent;
  /** Why "Use Matt's" is unavailable, in plain language, or null when it can be chosen. */
  mattBlocked: string | null;
};

function mattBlockedReason(conflict: ConflictState, snapshot: ScanSnapshot | undefined, aliasName: string): string | null {
  const unsupported = competing(conflict).find((source) => source.scope !== "bb-plugin" ||
    !source.pluginId || source.pluginId.localeCompare(mirrorConfig.identity.pluginId) <= 0);
  if (unsupported) return `Matt's can't replace ${ownerLabel(unsupported)}. Turn that one off where it lives, or keep both to use Matt's as /${aliasName}.`;
  if (!verifiedDelivery(conflict, snapshot) || conflict.oursBlockedReason !== null) {
    return `bb can't give Matt's this name yet. Keep both to use Matt's as /${aliasName}.`;
  }
  return null;
}

/**
 * Skills the user wants that share a name with a skill they already have. Collapses every
 * provider, environment and host into one entry per skill; empty when nothing clashes.
 */
export function findClashes(input: {
  skills: readonly CatalogSkill[];
  resolved: readonly ResolvedSkill[];
  conflicts: readonly ConflictState[];
  snapshots: readonly ScanSnapshot[];
}): Clash[] {
  const clashes: Clash[] = [];
  for (const skill of input.skills) {
    const wanted = input.resolved.find((item) => item.canonicalId === skill.canonicalId);
    if (!wanted || !(wanted.chosen || wanted.active) || wanted.reason === "off-master") continue;
    const scoped = input.conflicts.filter((conflict) => conflict.canonicalId === skill.canonicalId &&
      conflict.internalDependencyFor.length === 0 && matchingSnapshot(conflict, input.snapshots));
    const clashing = scoped.filter((conflict) => competing(conflict).length > 0);
    if (clashing.length === 0) continue;
    const owners = [...new Set(clashing.flatMap((conflict) => competing(conflict).map(ownerLabel)))];
    const verified = clashing.filter((conflict) => verifiedDelivery(conflict, matchingSnapshot(conflict, input.snapshots)));
    const outcomes = new Set(verified.map((conflict) => conflict.outcome));
    const current: ClashCurrent = verified.length === 0 ? "checking"
      : outcomes.has("canonical-selected") ? "matt"
        : outcomes.has("alias-selected") ? "both"
          : outcomes.has("yielded") || outcomes.has("blocked") ? "yours" : "checking";
    const mattBlocked = clashing.map((conflict) =>
      mattBlockedReason(conflict, matchingSnapshot(conflict, input.snapshots), skill.aliasName)).find((reason) => reason !== null) ?? null;
    clashes.push({
      canonicalId: skill.canonicalId, aliasName: skill.aliasName, owners,
      requestedChoice: clashing[0].requestedChoice, current, mattBlocked,
    });
  }
  return clashes;
}

const joinOwners = (owners: readonly string[]) =>
  owners.length <= 1 ? owners[0] ?? "another skill" : `${owners.slice(0, -1).join(", ")} and ${owners[owners.length - 1]}`;

export function currentText(clash: Clash): string {
  switch (clash.current) {
    case "yours": return `New threads use the one from ${joinOwners(clash.owners)}. Matt's is off here.`;
    case "both": return `New threads get both: theirs as /${clash.canonicalId}, Matt's as /${clash.aliasName}.`;
    case "matt": return `New threads use Matt's /${clash.canonicalId}.`;
    case "checking": return "Still checking which one new threads get.";
  }
}

/** One short line on a skill row; shown only when that skill clashes. */
export function ClashLine({ clash, disabled, onReview }: { clash: Clash; disabled: boolean; onReview: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <span>Same name as a skill in {joinOwners(clash.owners)}. {currentText(clash)}</span>
      <Button variant="ghost" size="sm" className="h-6 px-1" disabled={disabled} onClick={onReview}
        aria-label={`Choose which ${clash.canonicalId} to use`}>Choose</Button>
    </p>
  );
}

/**
 * Page-level notice. Renders nothing unless a skill clashes and still needs a choice,
 * or the check itself failed (then Matt's same-name skills may be held back).
 */
export function ConflictNotice({ clashes, checkFailed, pending, onReview, onRetry }: {
  clashes: readonly Clash[]; checkFailed: boolean; pending: boolean; onReview: () => void; onRetry: () => void;
}) {
  const open = clashes.filter((clash) => clash.requestedChoice === "unresolved");
  if (open.length === 0 && !checkFailed) return null;
  return (
    <div role="status" className="mt-4 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      {open.length > 0 && <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          {open.length === 1
            ? <>Matt&apos;s <code>/{open[0].canonicalId}</code> has the same name as a skill in {joinOwners(open[0].owners)}.</>
            : <>{open.length} of Matt&apos;s skills have the same name as skills you already have.</>}
        </p>
        <Button variant="outline" size="sm" disabled={pending} onClick={onReview}>{open.length === 1 ? "Choose" : "Review"}</Button>
      </div>}
      {checkFailed && <div className="flex flex-wrap items-center justify-between gap-2">
        <p>Couldn&apos;t check whether Matt&apos;s skills share names with yours, so some may be held back from new threads.</p>
        <Button variant="outline" size="sm" disabled={pending} onClick={onRetry}>Try again</Button>
      </div>}
    </div>
  );
}

export function ConflictDialog({ open, clashes, pending, error, onOpenChange, onChoice }: {
  open: boolean; clashes: readonly Clash[]; pending: boolean; error?: string | null;
  onOpenChange: (open: boolean) => void; onChoice: (canonicalId: string, choice: ConflictChoice) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent hideCloseButton={pending}>
        <DialogHeader>
          <DialogTitle>{clashes.length === 1 ? `Two skills called /${clashes[0].canonicalId}` : "Skills with the same name"}</DialogTitle>
          <DialogDescription>
            Only one skill can use a name in a thread. Choose which one new threads in this project get.
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="space-y-4">
          {clashes.map((clash) => (
            <section key={clash.canonicalId} aria-label={`/${clash.canonicalId}`} className="space-y-2 text-sm">
              {clashes.length > 1 && <h3 className="font-medium">/{clash.canonicalId}</h3>}
              <p>You already have <code>{clash.canonicalId}</code> from {joinOwners(clash.owners)}. {currentText(clash)}</p>
              <div role="group" aria-label={`Which ${clash.canonicalId} to use`} className="flex flex-wrap gap-2">
                {([
                  ["theirs", "Use theirs"],
                  ["both", `Keep both (Matt's as /${clash.aliasName})`],
                  ["ours", "Use Matt's"],
                ] satisfies [ConflictChoice, string][]).map(([choice, label]) => (
                  <Button key={choice} variant="outline" size="sm" className="h-auto whitespace-normal py-1.5"
                    aria-pressed={clash.requestedChoice === choice}
                    disabled={pending || (choice === "ours" && clash.mattBlocked !== null)}
                    onClick={() => onChoice(clash.canonicalId, choice)}>{label}</Button>
                ))}
              </div>
              {clash.mattBlocked && <p className="text-xs text-muted-foreground">{clash.mattBlocked}</p>}
            </section>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
