import { useState } from "react";
import { mirrorConfig } from "../../mirror.config";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Toggle } from "./controls";
import { newerRelease } from "./model";
import type { MattState } from "./model";

export const UPDATE_COMMAND = `bb plugin update ${mirrorConfig.identity.pluginId}`;
export function StatusCard({
  state,
  pending,
  onCheck,
  onDefault,
}: {
  state: MattState;
  pending: boolean;
  onCheck: () => void;
  onDefault: (on: boolean) => void;
}) {
  const [copied, setCopied] = useState<"commit" | "update" | null>(null);
  const [copyError, setCopyError] = useState<{ kind: "commit" | "update"; message: string } | null>(null);
  const update = state.update;
  const installedVersion = state.installedPluginVersion ?? update?.installedPluginVersion;
  const newer = newerRelease(
    update?.latestPluginVersion ?? null,
    installedVersion ?? "",
  );
  const commit = update?.bundledCommit ?? state.catalog.upstream.commit;
  const date = state.catalog.upstream.committedAt.slice(0, 10);
  const copy = async (kind: "commit" | "update") => {
    try {
      await navigator.clipboard.writeText(kind === "commit" ? commit : UPDATE_COMMAND);
      setCopied(kind);
      setCopyError(null);
    } catch {
      setCopyError({
        kind,
        message: kind === "commit"
          ? "Couldn't copy. Select and copy the full commit SHA below."
          : "Couldn't copy. Select and copy the command above.",
      });
    }
  };
  return (
    <Card className="mt-6 space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">
            Bundled Matt Pocock skills {update?.bundledUpstreamVersion ?? state.catalog.upstream.version}
          </h2>
          <p className="text-xs text-muted-foreground">
            Matt&apos;s plugin manifest version at this commit
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <a
              className="underline underline-offset-2"
              href={`${mirrorConfig.upstream.url}/commit/${commit}`}
              target="_blank"
              rel="noreferrer"
              title={commit}
            >
              {commit.slice(0, 8)}
            </a>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { void copy("commit"); }}
              aria-label="Copy bundled upstream commit SHA"
            >
              <Icon name={copied === "commit" ? "Check" : "Copy"} className="size-3.5" />
              {copied === "commit" ? "Copied" : "Copy SHA"}
            </Button>
            <span>Committed {date}</span>
          </div>
          {copyError?.kind === "commit" && (
            <div className="space-y-1">
              <p role="alert" className="text-xs text-destructive">{copyError.message}</p>
              <code className="select-all break-all text-xs">{commit}</code>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Installed bb plugin version: {installedVersion ?? "Unknown"}
          </p>
          <p className="text-sm">
            {update?.upstreamAheadCount == null
              ? update?.checkedAt
                ? "Upstream ancestry is unknown."
                : "Upstream status hasn't been checked yet."
              : update?.upstreamAheadCount === 0
                ? "Up to date with upstream"
                : `Upstream is ${update?.upstreamAheadCount} ${update?.upstreamAheadCount === 1 ? "commit" : "commits"} ahead`}
          </p>
          {update?.latestUpstreamCommit && (
            <p className="text-xs text-muted-foreground">
              Latest upstream commit:{" "}
              <a
                href={`${mirrorConfig.upstream.url}/commit/${update.latestUpstreamCommit}`}
                target="_blank"
                rel="noreferrer"
                title={update.latestUpstreamCommit}
                className="underline underline-offset-2"
              >
                {update.latestUpstreamCommit.slice(0, 8)}
              </a>
            </p>
          )}
          {update?.latestPluginVersion && (
            <p className="text-xs text-muted-foreground">
              Latest bb plugin release: {update.latestPluginVersion}
            </p>
          )}
          {update?.checkedAt && (
            <p className="text-xs text-muted-foreground">
              Last checked {new Date(update.checkedAt).toLocaleString()}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onCheck}
          disabled={pending}
        >
          <Icon name="RefreshCw" className="size-3.5" />
          Check now
        </Button>
      </div>
      {update?.error && (
        <p role="status" className="text-xs text-muted-foreground">
          Couldn't check for updates: {update.error}
        </p>
      )}
      {newer && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-sm">
            bb plugin {update?.latestPluginVersion} is available. Update to receive
            the latest mirrored skills.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="select-all break-all text-xs">
              {UPDATE_COMMAND}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void copy("update");
              }}
              aria-label="Copy plugin update command"
            >
              <Icon name={copied === "update" ? "Check" : "Copy"} className="size-3.5" />
              {copied === "update" ? "Copied" : "Copy"}
            </Button>
          </div>
          {copyError?.kind === "update" && (
            <p role="alert" className="text-xs text-destructive">
              {copyError.message}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
        <div>
          <p className="text-sm">
            New stable skills follow bucket defaults:{" "}
            <strong>
              {state.global.arrivalPolicy.newStableSkills === "bucket-default" ? "On" : "Off"}
            </strong>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Applies to new engineering and productivity skills. In-progress skills start off.
          </p>
        </div>
        <Toggle
          checked={state.global.arrivalPolicy.newStableSkills === "bucket-default"}
          label="New stable skills follow bucket defaults"
          disabled={pending}
          onChange={onDefault}
        />
      </div>
    </Card>
  );
}
