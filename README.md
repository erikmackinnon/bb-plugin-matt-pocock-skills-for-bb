# Matt Pocock skills for bb

Use [Matt Pocock's skills](https://github.com/mattpocock/skills) in [bb](https://github.com/get-bb), with a page for turning skills on or off globally and per project. This is an **unofficial mirror** of `mattpocock/skills`. Matt's skill text ships unchanged; see the [compatibility notes](compat/README.md) for how it is packaged for bb.

> [!NOTE]
> This project is not affiliated with or endorsed by Matt Pocock or bb.

## Install and update

Install the compatible release range:

```sh
bb plugin install git:https://github.com/erikmackinnon/bb-plugin-matt-pocock-skills-for-bb.git@^0.1.0
```

bb selects the highest compatible tag in that range and builds the plugin. Requires bb 0.45.0 or later.

New upstream skills are released here as patch versions. To update:

```sh
bb plugin outdated
bb plugin update matt-pocock-skills-for-bb
```

## Use the skills

Open **Matt Pocock skills for bb** in the sidebar. Under **Scope**, choose **Default for all projects** to set defaults, or select a project to follow those defaults or pick its own skills. The master switch turns the whole set off at the selected scope. Changes apply to new threads.

The bundle has 33 skills:

- **Engineering (20, on by default):** `ask-matt`, `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grill-with-docs`, `implement`, `implement-spec`, `improve-codebase-architecture`, `pr`, `prototype`, `research`, `retro`, `setup-matt-pocock-skills`, `tdd`, `to-spec`, `to-tickets`, `triage`, `wayfinder`, `wizard`.
- **Productivity (7, on by default):** `grill-me`, `grilling`, `handoff`, `teach`, `to-questionnaire`, `wait-what`, `writing-for-agents`.
- **In-progress (6, off until you opt in):** `chief-of-staff`, `loop-me`, `setup-ts-deep-modules`, `writing-beats`, `writing-fragments`, `writing-shape`. Matt marks these experimental, so the page asks before turning them on.

To get started, run `/setup-matt-pocock-skills` once per repository to record your issue tracker, triage labels and domain-doc locations. Then use `/grill-with-docs` before a code change, `/grill-me` for a plan or decision, and `/ask-matt` when you're not sure which skill fits.

A skill can require other skills. Those stay on while a selected skill needs them, and the page shows which skills need them; turning one off offers to turn off the skills that use it too. Some skills need tools such as `git`, `gh` or your test commands. The page flags missing ones; bundling a skill does not install them.

### Skills with the same name

If one of Matt's skills has the same name as a skill you already have (your own, a project's, or another plugin's), yours keeps the name and the page says so. Choose **Keep both** to also get Matt's under `/matt-pocock-<name>`, or **Use Matt's** where bb allows it. Nothing is shown when there are no clashes.

### Command line

```sh
bb matt-pocock-skills-for-bb --help
bb matt-pocock-skills-for-bb list --project <id>
bb matt-pocock-skills-for-bb enable teach --project <id>
bb matt-pocock-skills-for-bb conflicts --project <id>
```

Every command accepts `--json`.

## Attribution

**Skills © 2026 Matt Pocock, MIT**, from [mattpocock/skills](https://github.com/mattpocock/skills), in `matt-pocock/` with its [license](matt-pocock/LICENSE). **Plugin code © 2026 Erik MacKinnon, MIT**, under our [LICENSE](LICENSE). Matt's `pr` skill credits Dex Horthy's material; see [NOTICE.md](NOTICE.md) for all attribution.

## Report an issue

- For skill content or workflow issues, use [mattpocock/skills issues](https://github.com/mattpocock/skills/issues).
- For installation, toggles or bb compatibility, use [this repository's issues](https://github.com/erikmackinnon/bb-plugin-matt-pocock-skills-for-bb/issues). Include the plugin version, bb version and any error output.

---

Plugin maintained by [erikmackinnon](https://github.com/erikmackinnon) ([X](https://x.com/erikmackinnon)). The skills are Matt Pocock's; this repo packages them for bb.
