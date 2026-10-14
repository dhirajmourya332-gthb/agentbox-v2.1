# Onshape

The owner reviews CAD models in their Onshape account ({{base_url}}). Agents put models there with
`agentbox-onshape`; the owner opens the link, measures, sections and comments.

- **One document per part**, named `{{doc_prefix}}<part>` (created private on first upload), and **one tab per
  version** (`v1`, `v2-cnc`, …), with an Onshape version saved per upload so the owner can compare.
- Upload what was actually generated from source (the STEP from the part version's `cad/STEP/`), and say in
  `--note` which commit and version it came from.
- **Only add.** Never delete, rename or edit the owner's Onshape documents, tabs or versions, and never share or
  publish a document. {{^allow_public}}Never create public documents (they're visible to anyone on Onshape).{{/allow_public}}
- Give the owner the link the tool prints (it opens the tab), with a one-line summary of what to look at.
- If the key fails (401/403) or the plan refuses a private document, say so and stop; don't work around it.
