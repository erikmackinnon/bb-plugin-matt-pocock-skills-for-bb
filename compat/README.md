# Compatibility for bb

Matt's skills ship as he wrote them. This plugin adds three things so they work well in bb:

- **Alias copies.** Each skill also ships as `matt-pocock-<name>`, identical except for the `name` in its frontmatter. bb uses the alias only when you choose **Keep both** because another skill already has the name.
- **A short runtime note.** New threads get a brief note ([bb-runtime-note.md](bb-runtime-note.md)) that maps Matt's instructions to bb tools, such as how to open an HTML report. It does not change any workflow.
- **Selection.** The plugin page decides which skills reach new threads, globally and per project. In-progress skills stay off until you opt in.

No skill body is rewritten. Matt's `in-progress/claude-handoff` is not included.
