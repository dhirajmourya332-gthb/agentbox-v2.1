---
name: onshape
description: "Put CAD models into the owner's Onshape for review: upload a part version's STEP as a tab in the part's private document, save an Onshape version, and hand the owner the link. Use after building or changing a model the owner should look at."
---

# Models into Onshape for review

<!-- Built into agentbox (server/seed-skills/onshape); refreshed at every start. -->

The owner reviews CAD in their Onshape. You add models there with `agentbox-onshape`; you never
change or remove anything that's already there.

## Upload a version
```bash
agentbox-onshape upload parts/<part>/<version>/cad/STEP/<model>.step \
  --doc <part> --tab <version> --version "<version>: <one-line what changed>" \
  --note "<repo>@<short commit> parts/<part>/<version>"
```
- `--doc`: the part's name (the configured prefix is added). The document is created **private** on the
  first upload; later uploads add tabs to it.
- `--tab`: the version (`v1`, `v2-cnc`); one tab per version. For an assembly, upload the assembly STEP
  as its own tab (`v2-assembly`).
- `--version`: an Onshape version saved right after the upload, so the owner can compare uploads.
- Upload only files generated from source (rerun the model first), never hand-edited exports.
- The tool prints JSON with `link` (opens the tab) and `version_link`. Translation takes from seconds to
  a few minutes for big assemblies; it waits for it.

## Hand it to the owner
One message: the link, what to look at (fits, clearances, the dimension that changed), and the
requirements this version targets. Don't paste the whole spec.

## Look around
```bash
agentbox-onshape docs [query]          # the owner's documents, newest first
agentbox-onshape tabs --doc <part>     # a document's tabs
agentbox-onshape whoami                # which account the key belongs to
```

## When it fails
- `refused the keys (401/403)`: the key is wrong, expired or lacks read+write. Tell the owner (Integrations
  → Onshape → Reconnect); don't retry in a loop.
- `won't create a private document on this plan`: the owner's plan only allows public documents. Stop and
  ask; never turn on public documents yourself.
- `couldn't translate the file`: re-export the STEP from the model (check it opens with cadgen), then try
  once more; report the reason if it fails again.
