# TODO: Std.cpp Reliability Refactor

## Goal

Make `std.cpp` the most reliable artifact in the pipeline. The solution text and data package must be downstream of a verified standard program, not co-generated with an unproven explanation.

## Phase 1: Solution Pipeline Restructure

- [x] Split solution generation into explicit stages: algorithm plan, std.cpp candidates, verification, final solution explanation.
- [x] Persist intermediate artifacts so failures can be audited:
  - `solution/algorithm.md`
  - `solution/verification.md`
- [x] Generate final `solution/solution.md` only after a verified `std.cpp` exists.
- [x] Move sample output rewriting after std.cpp verification.

## Phase 2: Std.cpp Verification Gates

- [x] Compile every candidate before accepting it.
- [x] Run LLM code review before expensive tests.
- [x] Run independent-solution differential testing.
- [x] Run brute-force oracle differential testing.
- [x] Add explicit counterexample search using LLM-generated adversarial cases.
- [x] Write a verification report describing which gates ran and which candidate was accepted.

## Phase 3: Data Package Reliability

- [x] Generate a validator for `.in` files and require every generated input to pass it.
- [x] Add maximum-scale stress tests before packaging `.out` files.
- [x] Generate a machine-readable data coverage report.
- [x] Detect multi-answer / construction problems and require checker generation before data packaging.

## Phase 4: Product Surface

- [x] Show `algorithm.md` and `verification.md` as first-class readonly artifacts in the UI.
- [x] Add failure messages that identify which verification gate failed.
- [x] Add a "regenerate std.cpp only" action for users who edited the题面 or algorithm plan manually.
