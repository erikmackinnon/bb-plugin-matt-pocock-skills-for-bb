import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { conflictRpcContract, rpcContract } from "./shared/rpc";
import type { ConflictChoice, ConflictState, ScanSnapshot } from "./shared/conflicts";
import { STATE_CHANGED } from "./shared/events";
import { mirrorConfig } from "./mirror.config";
import { BUCKETS } from "./shared/catalog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "./components/matt-pocock/controls";
import { SkillRow } from "./components/matt-pocock/skill-row";
import { StatusCard } from "./components/matt-pocock/status";
import {
  planTurnOff,
  turnOffCopy,
  dependencies,
  BUCKET_LABELS,
  projectChoice,
  projectSuffix,
  activitySummary,
  defaultSkillSet,
  projectOnSkillSet,
  configuredSkillSet,
  matchesSkillSearch,
  planOptIn,
} from "./components/matt-pocock/model";
import type { MattState, Scope } from "./components/matt-pocock/model";

import { DependencyNotice } from "./components/matt-pocock/dependency-notice";
import { DependencySummary } from "./components/matt-pocock/dependency-summary";
import { ScopeControls } from "./components/matt-pocock/scope-controls";
import { StartHere } from "./components/matt-pocock/start-here";
import { ConflictDialog, ConflictNotice, findClashes } from "./components/matt-pocock/conflict-details";
import { OptInPreview } from "./components/matt-pocock/opt-in-preview";
const GLOBAL: Scope = { kind: "global" };

/** Keyed by scope so responses and dialogs never bleed into another project. */
function ScopePage({
  scope,
  selectScope,
  onProjects,
  onCommit,
  projects,
}: {
  scope: Scope;
  selectScope: (scope: Scope) => void;
  onProjects: (projects: MattState["projects"]) => void;
  onCommit: (commit: string) => void;
  projects: MattState["projects"];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const conflictRpc = useRpc<typeof conflictRpcContract>();
  const [state, setState] = useState<MattState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [turnOff, setTurnOff] = useState<string[] | null>(null);
  const [included, setIncluded] = useState<string[]>([]);
  const [optIn, setOptIn] = useState<string[] | null>(null);
  const [conflicts, setConflicts] = useState<ConflictState[]>([]);
  const [snapshots, setSnapshots] = useState<ScanSnapshot[]>([]);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [reviewingClashes, setReviewingClashes] = useState(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const busy = useRef(false);
  const report = useCallback((cause: unknown) => {
    if (mounted.current)
      setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(async () => {
    const request = ++revision.current;
    try {
      const next = await rpc.call("matt_pocock_state", { scope });
      if (mounted.current && revision.current === request) {
        setState(next);
        setLoadError(null);
        onProjects(next.projects);
        onCommit(next.catalog.upstream.commit);
      }
      if (scope.kind === "project") {
        try {
          const discovery = await conflictRpc.call("matt_pocock_conflicts", { projectId: scope.projectId, refresh: true });
          if (mounted.current && revision.current === request) {
            setConflicts(discovery.conflicts);
            setSnapshots(discovery.snapshots);
            setConflictError(null);
          }
        } catch (cause) {
          if (mounted.current && revision.current === request) {
            setConflictError(cause instanceof Error ? cause.message : String(cause));
            setSnapshots((current) => current.map((snapshot) => ({ ...snapshot, freshness: "stale" })));
          }
        }
      }
    } catch (cause) {
      if (mounted.current && revision.current === request)
        setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc, conflictRpc, scope, onProjects, onCommit]);
  useEffect(() => {
    mounted.current = true;
    void refetch();
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, [refetch]);
  useRealtime(STATE_CHANGED, refetch);
  useEffect(() => {
    if (scope.kind !== "project") return;
    const timer = setInterval(() => { void refetch(); }, mirrorConfig.conflicts.scanIntervalMs);
    return () => clearInterval(timer);
  }, [scope, refetch]);
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (
      connection === "connected" &&
      previousConnection.current !== "connected"
    )
      void refetch();
    previousConnection.current = connection;
  }, [connection, refetch]);

  const mutate = async (action: () => Promise<unknown>, after?: () => void) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
      if (mounted.current) after?.();
      await refetch();
    } catch (cause) {
      report(cause);
      await refetch();
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const dismissIncluded = useCallback(() => setIncluded([]), []);
  const setSkills = (ids: string[], enabled: boolean, cascade = false) => {
    if (!state) return;
    const active = new Set(
      (skillState ?? state).resolved
        .filter((skill) => skill.active)
        .map((skill) => skill.canonicalId),
    );
    const candidateDependencies = enabled
      ? dependencies(state.catalog.skills, ids).filter((id) => !active.has(id))
      : [];
    let autoIncluded: string[] = [];
    void mutate(
      async () => {
        const result = await rpc.call("matt_pocock_set_skills", {
          scope,
          changes: ids.map((canonicalId) => ({ canonicalId, value: enabled ? "on" : "off" })),
          cascade,
        });
        autoIncluded = candidateDependencies.filter((id) => result.resolved.some((skill) => skill.canonicalId === id && skill.active));
        if (mounted.current) setTurnOff(null);
        if (
          scope.kind === "project" &&
          state.project?.mode === "inherit" &&
          !state.project.enabled
        ) {
          try {
            await rpc.call("matt_pocock_set_master", { scope, enabled: true });
          } catch (cause) {
            const detail =
              cause instanceof Error ? cause.message : String(cause);
            throw new Error(
              `Skill choices saved, but couldn't turn this project on. Choose On to retry. ${detail}`,
            );
          }
        }
        return result;
      },
      () => {
        setIncluded(autoIncluded);
        setTurnOff(null);
        setOptIn(null);
      },
    );
  };
  const requestToggle = (ids: string[], enabled: boolean) => {
    if (!state || pending) return;
    if (enabled && planOptIn(editState ?? state, ids).experimental.length > 0) {
      setError(null);
      setOptIn(ids);
      return;
    }
    const plan = enabled ? null : planTurnOff(editState ?? state, ids);
    if (plan && plan.kept.length > 0) {
      setError(null);
      setTurnOff(plan.ids);
    } else setSkills(ids, enabled);
  };
  const inherited =
    scope.kind === "project" && state?.project?.mode !== "custom";
  const editsDefault = scope.kind === "global" || inherited;
  const skillState = state ? editsDefault ? defaultSkillSet(state) : configuredSkillSet(state) : null;
  const editState = state && inherited ? projectOnSkillSet(state) : skillState;
  const turnOffPlan =
    editState && turnOff ? planTurnOff(editState, turnOff) : null;
  const dialogCopy = turnOffPlan ? turnOffCopy(turnOffPlan) : null;
  const disabled =
    pending ||
    (scope.kind === "project" &&
      !inherited &&
      projectChoice(state?.project ?? null) === "off");
  const query = search.trim().toLocaleLowerCase();
  const skills =
    state?.catalog.skills.filter((skill) => matchesSkillSearch(skill,
      [...conflicts.filter((item) => item.canonicalId === skill.canonicalId).map((item) => item.effectiveName ?? ""),
        state.resolved.find((item) => item.canonicalId === skill.canonicalId)?.bbName ?? ""], query)) ?? [];
  const resolved = new Map(
    skillState?.resolved.map((skill) => [skill.canonicalId, skill]) ?? [],
  );
  const scopeValue =
    scope.kind === "global" ? "global" : `project:${scope.projectId}`;
  const newCount = state?.newSkillIds?.length ?? 0;
  const chooseConflict = (canonicalId: string, choice: ConflictChoice) => {
    if (scope.kind !== "project") return;
    void mutate(() => conflictRpc.call("matt_pocock_resolve", { projectId: scope.projectId, canonicalId, choice }));
  };
  const clashes = state && scope.kind === "project"
    ? findClashes({ skills: state.catalog.skills, resolved: state.resolved, conflicts, snapshots })
    : [];
  const checkFailed = scope.kind === "project" && state?.project !== null && state?.project !== undefined &&
    (conflictError !== null || snapshots.some((snapshot) => snapshot.errors.length > 0));

  return (
    <>
      {state && (
        <p className="mt-3 text-xs text-muted-foreground">
          {activitySummary(state)}
        </p>
      )}
      {state && (
        <StartHere
          state={state}
          conflicts={conflicts}
          snapshots={snapshots}
          dismissed={state.startHereDismissed}
          pending={pending}
          onDismiss={() => {
            void mutate(() =>
              rpc.call("matt_pocock_dismiss_start_here", { dismissed: true }),
            );
          }}
        />
      )}
      <Card className="mt-5 space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="matt-pocock-scope" className="text-sm font-medium">
            Scope
          </label>
          <select
            id="matt-pocock-scope"
            value={scopeValue}
            disabled={pending}
            onChange={(event) =>
              selectScope(
                event.target.value === "global"
                  ? GLOBAL
                  : { kind: "project", projectId: event.target.value.slice(8) },
              )
            }
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            <option value="global">
              Default for all projects · {state?.global.enabled === false ? "off" : "on"}
            </option>
            {projects.map((item) => (
              <option key={item.id} value={`project:${item.id}`}>
                {item.name}
                {` · ${projectSuffix(item)}`}
              </option>
            ))}
          </select>
        </div>
        {state && (
          <ScopeControls
            scope={scope}
            state={state}
            pending={pending}
            onDefault={(enabled) => {
              void mutate(() =>
                rpc.call("matt_pocock_set_master", { scope: GLOBAL, enabled }),
              );
            }}
            onProject={(choice) => {
              if (scope.kind !== "project") return;
              void mutate(() =>
                choice === "inherit"
                  ? rpc.call("matt_pocock_set_project_mode", {
                      projectId: scope.projectId,
                      mode: "inherit",
                    })
                  : rpc.call("matt_pocock_set_master", {
                      scope,
                      enabled: choice === "on",
                    }),
              );
            }}
          />
        )}
      </Card>
      {state && scope.kind === "project" && (
        <ConflictNotice clashes={clashes} checkFailed={checkFailed} pending={pending}
          onReview={() => setReviewingClashes(true)} onRetry={() => { void refetch(); }} />
      )}
      {(error || loadError) && (
        <div
          role="alert"
          className="mt-4 flex items-center justify-between gap-3 rounded-md border border-destructive/40 p-3 text-sm text-destructive"
        >
          <span>{error || loadError}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => {
              setError(null);
              setLoadError(null);
              void refetch();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {!state ? (
        <p
          role="status"
          className="mt-4 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
        >
          {loadError
            ? "Unable to load Matt Pocock skill settings."
            : "Loading Matt Pocock skill settings…"}
        </p>
      ) : (
        <>
          <h2 className="mt-5 text-sm font-medium">
            {editsDefault ? "Default skill set" : "Skills for this project"}
          </h2>
          {inherited && (
            <p className="mt-1 text-xs text-muted-foreground">
              Choose On to customize skills for this project. Editing a skill
              also switches this project to On.
              {Object.keys(state.project?.skills ?? {}).length > 0 &&
                " Your saved project skill choices will be restored when you choose On or edit a skill."}
            </p>
          )}
          {scope.kind === "global" && (
            <p className="mt-1 text-xs text-muted-foreground">
              These choices are the default skill set, even when Matt Pocock skills are off
              by default.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setCollapsed(new Set());
              }}
              aria-label="Search skills"
              placeholder="Search skills…"
              className="min-w-0 flex-1"
            />
            <span className="text-xs text-muted-foreground">
              {skillState?.resolved.filter((skill) => skill.chosen || skill.active).length} /{" "}
              {state.catalog.skills.length}{" "}
              {editsDefault ? "in default set" : "in project set"}
            </span>
            {newCount > 0 && <Button variant="outline" size="sm" disabled={pending} onClick={() => {
              void mutate(() => rpc.call("matt_pocock_mark_seen", null));
            }}>Acknowledge {newCount} new {newCount === 1 ? "skill" : "skills"}</Button>}
          </div>
          {included.length > 0 && (
            <DependencyNotice
              key={included.join(",")}
              ids={included}
              onDismiss={dismissIncluded}
            />
          )}
          <div
            className={`mt-4 space-y-3 ${inherited ? "opacity-70" : ""}`}
            aria-busy={pending}
          >
            {BUCKETS.map((group) => {
              const groupSkills = skills.filter(
                (skill) => skill.bucket === group,
              );
              if (groupSkills.length === 0) return null;
              const count = groupSkills.filter(
                (skill) => {
                  const item = resolved.get(skill.canonicalId);
                  return item?.chosen || item?.active;
                },
              ).length;
              const allOn = count === groupSkills.length;
              const closed = collapsed.has(group);
              return (
                <Card key={group}>
                  <div className="flex items-center gap-3 px-4 py-3">
                    <Button
                      variant="ghost"
                      className="h-auto min-w-0 flex-1 justify-start px-0 py-1"
                      aria-expanded={!closed}
                      aria-controls={`matt-pocock-bucket-${group}`}
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(group)) next.delete(group);
                          else next.add(group);
                          return next;
                        })
                      }
                    >
                      <Icon
                        name={closed ? "ChevronRight" : "ChevronDown"}
                        className="size-4 shrink-0"
                      />
                      <span className="truncate">{BUCKET_LABELS[group]}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {count}/{groupSkills.length}
                      </span>
                    </Button>
                    {group === "in-progress" ? <Button variant="outline" size="sm" disabled={disabled} onClick={() => requestToggle(groupSkills.map((skill) => skill.canonicalId), !allOn)}>
                      {allOn ? "Disable experimental skills" : query ? "Enable matching experimental skills" : "Enable all experimental skills"}
                    </Button> : <Checkbox
                      checked={
                        allOn ? true : count > 0 ? "indeterminate" : false
                      }
                      disabled={disabled}
                      aria-label={`${allOn ? "Disable" : "Enable"} ${BUCKET_LABELS[group]}${query ? " matching search" : ""}`}
                      onCheckedChange={() =>
                        requestToggle(
                          groupSkills.map((skill) => skill.canonicalId),
                          !allOn,
                        )
                      }
                    />}
                  </div>
                  {group === "in-progress" && <p className="px-4 pb-3 text-xs text-muted-foreground">Experimental. Off by default. Enable only the skills you want.</p>}
                  <ul
                    hidden={closed}
                    id={`matt-pocock-bucket-${group}`}
                    className="divide-y divide-border border-t border-border px-4"
                  >
                    {groupSkills.map((skill) => {
                      const item = resolved.get(skill.canonicalId);
                      return item ? (
                        <SkillRow
                          key={skill.canonicalId}
                          skill={skill}
                          resolved={item}
                          state={state}
                          conflicts={scope.kind === "project" ? conflicts.filter((conflict) => conflict.canonicalId === skill.canonicalId) : []}
                          snapshots={snapshots}
                          isNew={state.newSkillIds?.includes(skill.canonicalId)}
                          clash={clashes.find((clash) => clash.canonicalId === skill.canonicalId)}
                          onReviewClash={() => setReviewingClashes(true)}
                          onOptIn={(ids) => requestToggle(ids, true)}
                          disabled={disabled}
                          conflictDisabled={pending}
                          onToggle={(enabled) =>
                            requestToggle([skill.canonicalId], enabled)
                          }
                          onReset={() => {
                            void mutate(
                              () =>
                                rpc.call("matt_pocock_set_skills", {
                                  scope,
                                  changes: [{ canonicalId: skill.canonicalId, value: null }],
                                  cascade: false,
                                }),
                              () => setIncluded([]),
                            );
                          }}
                        />
                      ) : null;
                    })}
                  </ul>
                </Card>
              );
            })}
            {skills.length === 0 && (
              <p
                role="status"
                className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
              >
                No skills match "{search}".
              </p>
            )}
          </div>
          {query && (
            <p className="mt-2 text-xs text-muted-foreground">
              Group toggles apply to skills matching this search.
            </p>
          )}
          <StatusCard
            state={state}
            pending={pending}
            onCheck={() => {
              void mutate(() => rpc.call("matt_pocock_check_updates", null));
            }}
            onDefault={(on) => {
              void mutate(() =>
                rpc.call("matt_pocock_set_arrival_policy", {
                  value: on ? "bucket-default" : "off",
                }),
              );
            }}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Changes apply to new agent sessions.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Plugin maintained by erikmackinnon ·{" "}
            <a
              href="https://github.com/erikmackinnon"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              GitHub
            </a>{" "}
            ·{" "}
            <a
              href="https://x.com/erikmackinnon"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              X
            </a>{" "}
            ·{" "}
            <a
              href={mirrorConfig.mirror.issuesUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Report a plugin issue
            </a>{" "}
            ·{" "}
            <button
              type="button"
              disabled={pending}
              className="rounded-sm text-xs underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              onClick={() => {
                void mutate(() =>
                  rpc.call("matt_pocock_dismiss_start_here", { dismissed: false }),
                );
              }}
            >
              Getting started
            </button>
          </p>
        </>
      )}
      <Dialog
        open={turnOff !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setTurnOff(null);
        }}
      >
        <DialogContent hideCloseButton={pending}>
          <DialogHeader>
            <DialogTitle>{dialogCopy?.title}</DialogTitle>
            <DialogDescription>{dialogCopy?.body}</DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {turnOffPlan && <DependencySummary plan={turnOffPlan} />}
          <DialogFooter className="sm:flex-wrap">
            <Button
              variant="outline"
              className="h-auto whitespace-normal py-2"
              disabled={pending}
              onClick={() => {
                if (turnOff) setSkills(turnOff, false, false);
              }}
            >
              {dialogCopy?.keep}
            </Button>
            <Button
              variant="destructive"
              className="h-auto whitespace-normal py-2"
              disabled={pending}
              onClick={() => {
                if (turnOff) setSkills(turnOff, false, true);
              }}
            >
              {dialogCopy?.cascade}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConflictDialog open={reviewingClashes && clashes.length > 0} clashes={clashes} pending={pending} error={error}
        onOpenChange={setReviewingClashes} onChoice={chooseConflict} />
      <Dialog open={optIn !== null} onOpenChange={(open) => { if (!open && !pending) setOptIn(null); }}>
        <DialogContent hideCloseButton={pending}>
          <DialogHeader>
            <DialogTitle>Enable experimental skills?</DialogTitle>
            <DialogDescription>Review the selected skills and their dependency closure before opting in.</DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {state && optIn && <OptInPreview state={editState ?? state} ids={optIn} />}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setOptIn(null)}>Cancel</Button>
            <Button disabled={pending} onClick={() => {
              if (!state || !optIn) return;
              const plan = planOptIn(editState ?? state, optIn);
              setSkills([...new Set([...optIn, ...plan.blockedExperimental])], true);
            }}>Enable selected skills</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function MattPage() {
  const [scope, setScope] = useState<Scope>(GLOBAL);
  const [commit, setCommit] = useState<string | null>(null);
  const [projects, setProjects] = useState<MattState["projects"]>([]);
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto text-foreground">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-6 pt-4 md:px-5">
        <header className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight">
            {mirrorConfig.identity.displayName}
          </h1>
          <p className="text-sm text-muted-foreground">
            Matt Pocock&apos;s engineering and productivity skills, synced daily
            from mattpocock/skills. In-progress skills are available as opt-ins.
          </p>
          <p className="text-sm text-muted-foreground">
            See the{" "}
            <a
              className="underline underline-offset-2"
              href={mirrorConfig.mirror.compatUrl}
              target="_blank"
              rel="noreferrer"
            >
              compatibility notes
            </a>{" "}
            for adaptations for bb.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Unofficial mirror · skills © Matt Pocock · MIT</Badge>
            <a
              className="text-xs text-muted-foreground underline underline-offset-2"
              href={mirrorConfig.upstream.url}
              target="_blank"
              rel="noreferrer"
            >
              Original Matt Pocock skills
            </a>
            {commit && (
              <a
                className="text-xs text-muted-foreground underline underline-offset-2"
                href={`${mirrorConfig.upstream.url}/commit/${commit}`}
                target="_blank"
                rel="noreferrer"
              >
                Upstream commit {commit.slice(0, 8)}
              </a>
            )}
          </div>
        </header>
        <ScopePage
          key={scope.kind === "global" ? "global" : scope.projectId}
          scope={scope}
          selectScope={setScope}
          projects={projects}
          onProjects={setProjects}
          onCommit={setCommit}
        />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: mirrorConfig.identity.pageId,
    title: mirrorConfig.identity.displayName,
    icon: mirrorConfig.identity.icon,
    path: mirrorConfig.identity.pagePath,
    component: MattPage,
  });
});
