# The ground-truth corpus

Until this directory has labels in it, nothing in the detector can be judged.
Every fix so far has been verified the same way: the user reported a case, the
case was investigated, the case went away, done. That finds errors only where
someone happened to walk, and it cannot tell a real improvement from a
regression somewhere else in the level.

A **label** is one sentence of ground truth about one position — "I am blocked
here by nothing visible" or "I walk through here freely" — stored with the
**exact surface pool** the game had at that moment. That makes it replayable
offline, forever, against any future version of the detector.

## Layout

```
corpus/
  pools/      one file per level:area snapshot (shared by its labels)
  labels/     one file per labelled position
  baselines/  every blocked cell the probe reports for a pool, as a sorted list
  fixtures/   synthetic scenes with the same structure, so the pipeline is
              exercised even when the real corpus is small
  runner.test.ts
```

Labels and pools are split because one pool is ~600 kB and a level's worth of
labels would otherwise store it twenty times.

## Capturing labels (needs a live Project64)

1. Run the viewer: the exe, or from source (`start.cmd`). A **Ground truth**
   panel appears in the HUD once the bridge is streaming.
2. Wait until the HUD names the collision engine ("Frame's patch detected" or
   "collision: vanilla"). A label taken before that records an unproven engine
   and the runner will reject it.
3. Park Mario at the spot. **Mario's position is the label**, so put him where
   the truth is — pressed against the invisible wall, or standing in the middle
   of the place that is definitely walkable.
4. Type what happens there in plain words. The note is the evidence a future
   session has; "walking west along the ledge, stopped dead about a body-width
   before the corner" is useful, "wall" is not.
5. Click **Wall here** or **Clear here**. The browser downloads one JSON file.

Then file them into the corpus and run it:

```bash
npm run corpus:import    # scans your Downloads folder
npm run corpus
```

Re-running the import is safe — labels already in the corpus are recognised
and skipped.

### What makes a good set

The point is coverage of the ways the detector can be wrong, not a pile of
similar spots. Aim for roughly twenty labels spread over at least three pools,
including:

- **confirmed invisible walls** — the ones you already know about;
- **confirmed clears**, especially places that *look* like they should trip the
  detector: bridge railings, low ceilings you can walk under, ledge rims,
  sloped seams. False positives are what the corpus is best at catching;
- **at least two air walls** — blocked in mid-air with nothing under you. That
  class is currently the least trustworthy part of the tool;
- **more than one world scale.** A 4x-scale level and a 1x-scale level exercise
  different arithmetic; a bug in the conversion hides completely if every label
  comes from one scale.

Two labels at the same spot should produce identical files apart from the
timestamp — worth doing once as a sanity check.

## Running it

```bash
npm run corpus           # replay every label + check the cell baselines
npm run corpus -- -u     # accept changed baselines
```

It is deliberately **not** part of `npm test`: probing one dense level takes
tens of seconds. It is the gate for detector changes — run it before and after
any change to the probe or the collision core, and read the diff.

Each pool gets a baseline listing every blocked cell (`x,z,kind,blocker,y
range`), sorted by position. A detector change shows up as added and removed
cells, which is the only honest way to see what a change did: segment counts
and segment keys reshape whenever merging changes, which looks like a detection
change and isn't.

**Accepting a new baseline requires a written justification in the commit
message** — which cells moved, and why that is correct. A baseline updated
without one is just the old habit of declaring the new number right.

## Fixtures

`fixtures/` holds synthetic scenes built by `npm run corpus:fixtures`
(`scripts/makeFixtures.ts`). They keep the whole path — stored bytes → parse →
probe → judge → baseline — under test regardless of what the real corpus
contains. They are not ground truth and never substitute for it: the runner
fails while no real label exists.
