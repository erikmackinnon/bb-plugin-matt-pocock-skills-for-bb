import { mirrorConfig } from "../../mirror.config";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import type { MattState } from "./model";
import type { ConflictState, ScanSnapshot } from "../../shared/conflicts";
import { matchingSnapshot, verifiedDelivery } from "./conflict-details";

function recommendation(state: MattState | undefined, canonicalId: string) {
  if (!state) return { name: `/${canonicalId}`, available: true, reason: "" };
  if (state.project === null) return { name: `/${canonicalId}`, available: true, reason: "" };
  const skill = state.resolved.find((item) => item.canonicalId === canonicalId);
  if (!skill) {
    return { name: canonicalId, available: false, reason: "Scope availability has not been resolved." };
  }
  if (skill.conflict.internalDependencyFor.length > 0) {
    return {
      name: canonicalId,
      available: false,
      reason: `Available only as an internal dependency for ${skill.conflict.internalDependencyFor.join(", ")}.`,
    };
  }
  if (
    skill.active &&
    skill.bbName &&
    (skill.outcome === "canonical-selected" || skill.outcome === "alias-selected")
  ) {
    return { name: `/${skill.bbName}`, available: true, reason: "" };
  }
  if (skill.reason === "off-master") return { name: canonicalId, available: false, reason: "Matt Pocock skills are off in this project." };
  if (skill.reason === "off-explicit" || skill.reason === "off-inherited") {
    return { name: canonicalId, available: false, reason: "This skill is off in this project." };
  }
  // On, but not yet checked for same-name skills: the expected name is still the right advice.
  if (skill.outcome === "unknown") return { name: `/${canonicalId}`, available: true, reason: "" };
  if (skill.outcome === "yielded") return { name: canonicalId, available: false, reason: "A skill you already have uses this name." };
  return { name: canonicalId, available: false, reason: "This skill is unavailable in this project." };
}

function SkillExample({ skill }: { skill: ReturnType<typeof recommendation> }) {
  return (
    <>
      <code className="rounded bg-muted px-1 py-0.5 text-xs">{skill.name}</code>
      {!skill.available && (
        <span className="text-muted-foreground"> is unavailable here: {skill.reason.replace(/\.$/, "")}</span>
      )}
    </>
  );
}

const STEP_SKILLS = ["setup-matt-pocock-skills", "grill-with-docs", "grill-me", "ask-matt"] as const;

function StartSteps({ state }: { state?: MattState }) {
  const setup = recommendation(state, "setup-matt-pocock-skills");
  const codeWork = recommendation(state, "grill-with-docs");
  const planning = recommendation(state, "grill-me");
  const advice = recommendation(state, "ask-matt");
  return (
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          {setup.available ? "Run " : "Setup: "}<SkillExample skill={setup} />
          {setup.available
            ? " once per repo to choose your tracker, triage labels, and domain-doc locations."
            : ". It chooses your tracker, triage labels, and domain-doc locations once per repo."}
        </li>
        <li>
          {codeWork.available ? "Before a change, use " : "For code work before a change, "}
          <SkillExample skill={codeWork} />{codeWork.available ? " for code work" : ""}.
          {" "}{planning.available ? "Use " : "For a plan or non-code decision, "}
          <SkillExample skill={planning} />
          {planning.available ? " for a plan or non-code decision." : "."}
        </li>
        <li>
          {advice.available ? "Ask " : "Choosing a flow: "}<SkillExample skill={advice} />
          {advice.available ? " which skill or flow fits." : "."}
          {" "}It offers advice and stops before execution.
        </li>
      </ol>
  );
}

export function StartHere({
  dismissed,
  pending,
  onDismiss,
  state,
  conflicts,
  snapshots = [],
}: {
  dismissed: boolean;
  pending: boolean;
  onDismiss: () => void;
  state?: MattState;
  conflicts?: readonly ConflictState[];
  snapshots?: readonly ScanSnapshot[];
}) {
  if (dismissed) return null;
  const scopedContexts = state?.project && conflicts !== undefined
    ? [...new Map(conflicts.map((conflict) => [JSON.stringify(conflict.scope), conflict.scope])).values()].map((scope) => {
        const scoped = conflicts.filter((conflict) => JSON.stringify(conflict.scope) === JSON.stringify(scope));
        const resolved = state.resolved.map<MattState["resolved"][number]>((skill) => {
          const conflict = scoped.find((item) => item.canonicalId === skill.canonicalId);
          const available = conflict && verifiedDelivery(conflict, matchingSnapshot(conflict, snapshots));
          return {
            ...skill,
            active: Boolean(available && conflict.effectiveName),
            bbName: available ? conflict.effectiveName : null,
            outcome: available ? conflict.outcome : "unknown",
            conflict: conflict && available ? conflict : {
              ...(conflict ?? skill.conflict),
              reason: "Delivery is unknown until a matching, complete, fresh scan is available.",
            },
          };
        });
        return { scope, state: { ...state, resolved } };
      })
    : null;
  // Providers that would see the same steps share one list; ids stay out of the copy.
  const stepGroups: { providers: string[]; state: MattState }[] = [];
  for (const { scope, state: scopedState } of scopedContexts ?? []) {
    const key = JSON.stringify(STEP_SKILLS.map((id) => recommendation(scopedState, id)));
    const group = stepGroups.find((item) => JSON.stringify(STEP_SKILLS.map((id) => recommendation(item.state, id))) === key);
    if (group) { if (!group.providers.includes(scope.providerId)) group.providers.push(scope.providerId); }
    else stepGroups.push({ providers: [scope.providerId], state: scopedState });
  }
  return (
    <Card className="mt-4 space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Start here</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Matt Pocock&apos;s small, composable skills for engineering and everyday work.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          disabled={pending}
          aria-label="Dismiss getting started"
          onClick={onDismiss}
        >
          <Icon name="X" className="size-3.5" />
        </Button>
      </div>
      {stepGroups.length <= 1 ? <StartSteps state={stepGroups[0]?.state ?? state} /> : stepGroups.map(({ providers, state: scopedState }) => (
        <section key={providers.join(",")} aria-label={`Getting started in ${providers.join(" and ")}`} className="space-y-2">
          <p className="text-xs text-muted-foreground">In {providers.join(" and ")}:</p>
          <StartSteps state={scopedState} />
        </section>
      ))}
      <p className="text-sm">
        Engineering and Productivity start on. In-progress is experimental and
        starts off; choose opt-ins below.
      </p>
      <p className="text-xs text-muted-foreground">
        Read the{" "}
        <a
          href={`${mirrorConfig.upstream.url}/blob/main/README.md`}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          upstream README
        </a>{" "}
        and{" "}
        <a
          href={mirrorConfig.mirror.compatUrl}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          compatibility notes
        </a>.
      </p>
      <p className="text-xs text-muted-foreground">
        Skills © 2026 Matt Pocock, MIT, from{" "}
        <a href={mirrorConfig.upstream.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          mattpocock/skills
        </a>. Adapted for bb by Erik MacKinnon. Not affiliated with or endorsed by Matt Pocock or bb.
      </p>
    </Card>
  );
}
