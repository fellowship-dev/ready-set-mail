<!-- Each section below is what the independent reviewer verifies. CI (`scripts/check-pr-body.mjs`) fails a body with a section missing, empty or only a placeholder (a checkbox line alone does not count); "None" needs a reason. -->

## What changes for whom
<!-- Who notices what after this merges (hosted, self-host, agents, operators), in plain words; "None" needs a reason. -->

## Flow mapped
<!-- Who does what, in order, to which value moment; the screens touched; the map in `.flowchad/flows/` used or updated; "None" needs a reason. -->

## Single sources touched
<!-- Which entries of `docs/single-sources.md` this extends; each duplicate found removed, or listed with its paths; "None" needs a reason. -->
- [ ] Extends the module listed in `docs/single-sources.md` for every concept it touches; adds no second implementation (or updates the map and its guard in this PR).

## Vocabulary
<!-- New or changed terms, and the `CONTEXT.md` entry added or updated for each; "None" needs a reason. -->

## Design system
<!-- Components and tokens used (`DESIGN.md`); any new component added to `packages/ui`, not inlined; "None" needs a reason. -->

## Docs updated
<!-- `AGENTS.md`, `CONTEXT.md`, `docs/`, ADRs in `docs/adr/`, `CHANGELOG.md`: what changed so every statement stays true; "None" needs a reason. -->

## Walk records
<!-- The record in `.flowchad/walks/` for each protected flow touched (AGENTS.md rule 5): walk or "not affected", widths walked, gate result; "None" needs a reason. -->
- [ ] Changes no file on a protected flow (`AGENTS.md`, Protected flows), or adds a new record for each flow it touches in `.flowchad/walks/`: the gate's walk record, or a "not affected" record with its reason (updating the map first if the flow changed).

## Decisions made by the implementer: confirm
<!-- Choices the owner did not make, listed for confirmation; an ADR contradicted is superseded here; nothing builds on `docs/adr/OPEN.md`; "None" needs a reason. -->
- [ ] Contradicts no ADR in `docs/adr/`, or adds the superseding ADR; builds on no decision in `docs/adr/OPEN.md`.

## Tests and evidence
<!-- Commands run on this revision and what they showed (tests, `bash scripts/check-flows.sh`, counts); a new guard shown failing first; "None" needs a reason. -->
