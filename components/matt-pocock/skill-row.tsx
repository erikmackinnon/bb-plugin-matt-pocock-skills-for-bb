import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge, Hint, Toggle } from "./controls";
import { differsFromGlobal, keptOnText, secondaryName } from "./model";
import type { MattState, ResolvedSkill } from "./model";
import type { CatalogSkill } from "../../shared/catalog";
import type { ConflictState, ScanSnapshot } from "../../shared/conflicts";
import { ClashLine, matchingSnapshot, verifiedDelivery, type Clash } from "./conflict-details";

export function SkillRow({
  skill,
  resolved,
  state,
  disabled,
  onToggle,
  onReset,
  conflicts = [],
  snapshots = [],
  clash,
  onReviewClash,
  conflictDisabled = disabled,
  onOptIn,
  isNew = false,
}: {
  skill: CatalogSkill;
  resolved: ResolvedSkill;
  state: MattState;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onReset: () => void;
  conflicts?: ConflictState[];
  snapshots?: ScanSnapshot[];
  clash?: Clash;
  onReviewClash?: () => void;
  conflictDisabled?: boolean;
  onOptIn?: (ids: string[]) => void;
  isNew?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Only clamped descriptions are clickable; short ones have nothing to expand.
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const node = descriptionRef.current;
    if (!node || expanded) return;
    const measure = () => setTruncated(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [expanded, skill.description]);
  const expandable = expanded || truncated;
  const descriptionId = useId();
  const required = resolved.reason === "on-required";
  const displayName = secondaryName(skill);
  const effective = state.project !== null
    ? conflicts.find((conflict) => verifiedDelivery(conflict, matchingSnapshot(conflict, snapshots)))?.effectiveName
    : resolved.bbName;
  const name = effective ? `/${effective}` : state.project === null ? `/${skill.canonicalId}` : skill.canonicalId;
  const keptDescriptionId = useId();
  const prerequisites = skill.prereqs.map(prerequisite => {
    const label = prerequisite.kind === "project-file" ? prerequisite.path : prerequisite.name;
    const key = prerequisite.kind === "project-file" ? `project-file:${prerequisite.path}` : prerequisite.kind === "capability" ? `capability:${prerequisite.name}` : prerequisite.name;
    return { label, conditional: prerequisite.when === "conditional", missing: state.prerequisites[key] === false };
  });
  const overridden = differsFromGlobal(state, skill);
  return (
    <li className="flex items-start gap-3 py-4">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {displayName && (
            <span className="text-xs text-muted-foreground">{displayName}</span>
          )}
          {!skill.userInvoked && (
            <Badge>Agents can use this on their own</Badge>
          )}
          {effective === skill.aliasName && <span className="text-xs text-muted-foreground">alias of <code>{skill.canonicalId}</code></span>}
          {overridden && <Badge>Project override</Badge>}
          {isNew && <Badge>New</Badge>}
        </div>
        <p
          id={descriptionId}
          ref={descriptionRef}
          {...(expandable
            ? {
                role: "button",
                tabIndex: 0,
                "aria-expanded": expanded,
                title: expanded ? "Show less" : "Show full description",
                onClick: () => setExpanded(!expanded),
                onKeyDown: (event: React.KeyboardEvent) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setExpanded(!expanded);
                  }
                },
              }
            : {})}
          className={`whitespace-pre-wrap break-words text-sm text-muted-foreground ${expanded ? "" : "line-clamp-2"} ${expandable ? "cursor-pointer rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" : ""}`}
        >
          {skill.description}
        </p>
        {prerequisites.length > 0 && <Hint text="Command presence does not verify authentication or tracker configuration. Conditional tools are needed only for some routes.">
          <span className="text-xs text-muted-foreground">Needs: {prerequisites.map((item, index) => <span key={item.label}>
            {index > 0 && ", "}{item.label}{item.conditional && " (only for some routes)"}{item.missing && <> <Badge>missing</Badge></>}
          </span>)}</span>
        </Hint>}
        {required && (
          <p
            id={keptDescriptionId}
            className="text-xs text-muted-foreground"
            title={`Used by ${resolved.neededBy.join(", ") || "active skills"}`}
          >
            {keptOnText(resolved.neededBy)}
          </p>
        )}
        {resolved.blockedBy.length > 0 && <div className="space-y-1 text-xs text-muted-foreground">
          <p>Unavailable until these dependencies are selected: {resolved.blockedBy.join(", ")}</p>
          {onOptIn && resolved.blockedBy.some((id) => state.catalog.skills.some((item) => item.canonicalId === id && item.bucket === "in-progress")) && <Button variant="outline" size="sm" disabled={disabled} onClick={() => onOptIn([...resolved.blockedBy])}>Review experimental opt-in</Button>}
        </div>}
        {(state.project?.mode === "custom" ? state.project.skills[skill.canonicalId] !== undefined : state.project === null && state.global.skills[skill.canonicalId] !== undefined) && (
            <Button
              disabled={disabled}
              variant="ghost"
              size="sm"
              className="h-6 px-1 text-muted-foreground"
              onClick={onReset}
            >
              {state.project === null ? "Use bucket default" : "Use default choice"}
            </Button>
          )}
        {state.project !== null && clash && onReviewClash && <ClashLine clash={clash} disabled={conflictDisabled} onReview={onReviewClash} />}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
        {required && (
          <Icon name="Lock" className="size-3.5 text-muted-foreground" />
        )}
        <Toggle
          checked={resolved.chosen || resolved.active}
          label={
            required
              ? `Review turning off ${name}, kept on by other skills`
              : `Enable ${name}`
          }
          disabled={disabled}
          locked={required}
          describedBy={required ? keptDescriptionId : undefined}
          onChange={onToggle}
        />
      </div>
    </li>
  );
}
