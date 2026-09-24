# Field notes: cost and quality from real runs

Early, single-run observations from building one real project with DotSwarm. Treat them as evidence, not benchmarks: each configuration ran once, and my project's instructions changed a little between runs. I'm sharing them so you can reproduce them and tell me if you see something different.

I ran out of my ChatGPT subscription allowance partway through, so I bought Codex credits instead. That turned out to be useful: at $0.04 per credit, every run below has a real dollar cost.

## The task

The first stage of a multi-stage planning workflow, stopping at an owner approval gate:

- market and customer research with sources,
- a site architecture: every page, its purpose, and how pages relate, checked by a validator script,
- an offer and conversion brief,
- a list of questions the owner has to answer before the next stage.

## Stage 1 results

| Configuration | Cost | Time | Outcome |
|---|---|---|---|
| Frontier model alone (GPT-6 Astra, extra-high reasoning) | over $5 | stopped early | I stopped it before it finished; it was still researching and drafting the site architecture |
| Tiered Codex subagents (Luna coordinator, Terra research, Sol planning) | $5.16 | ~16 min | Complete; site architecture passed validation |
| **Terra (medium) coordinating a DotSwarm DeepSeek team** | **under $1 total**, Codex credits and DeepSeek API combined | ~33 min | Complete; site architecture passed validation; by far the most thorough |

## How much more thorough the swarm was

This is the part that surprised me most. The cheapest configuration was not a trade-off on quality; for this kind of work it was clearly the best.

- **About four times the research detail**, with sources for the claims that matter, and a clean split between facts the owner confirmed, facts found in sources, and open questions only the owner can answer.
- **It verified instead of assuming.** It checked the service area against the official government GIS source, and it found that the business's domain was only a parked placeholder, not a live site.
- **It refused a false match.** It found a directory listing for a similarly named business and rejected it, because the listing did not match on name plus a second identifier. An earlier run of mine had presented a record like that as verified.
- **It reviewed itself, properly.** A reviewer agent went through the owner-facing review page and flagged wording that read like internal notes. It found contradictions between the research, the site architecture, and the review page (for example, three different lists of candidate communities) and sent them back to be fixed.
- **It checked its own checks.** It found a blind spot in the project's validation script, which skipped any line containing a negative word, so a claim like "never late, guaranteed" would have passed. It closed the gap, then proved each fix by running the validator against copies of the files with one deliberate defect planted in each.
- **It re-verified every fix independently**, re-ran all acceptance checks after its last edit, and only then stopped at the gate with a complete, numbered list of questions for the owner.

All of that came from DeepSeek teammates, not from the coordinating OpenAI model. The coordinator mostly relayed my decisions.

## What made the difference

1. **The coordinator stays small.** A coordinator's cost is roughly turns times context, so it delegates everything and waits on a blocking status call instead of polling. An earlier configuration of mine, where a frontier model supervised a swarm turn by turn, cost more than doing the work directly (over $100 against $37 for the same later stage).
2. **Written review rules.** Every reviewer gets the same standard verbatim: prove each failure, read the output as its real audience would, verify outside facts on name plus a second identifier, and test every check against bad input. A cheap model follows explicit rules well.
3. **Fix in the work, not the rules.** The team's lead may relax a rule only with a recorded reason, and must rerun acceptance after the last edit.

## Design and code: still being measured

On my first build pass (visual design and code), the DeepSeek team's aesthetics were noticeably weaker than Astra's. I have since changed the workflow: the design is settled first as reviewable HTML comps, the design work gets screenshot-based review, and a verify swarm handles QA. I'm retesting the design and build stages now and will update these notes.

## Caveats

- One run per configuration. The frontier-only run was stopped early, so its cost is a floor.
- The DeepSeek run is slower, about twice the wall-clock time for stage 1.
- It is verbose: its planning files were about four times larger. Cheap to write, but a frontier model that later reads them pays for that size. I'm adding a size budget.

## Reproduce

Install DotSwarm, open a Codex session on Terra at medium reasoning, and ask it to use DotSwarm for all of the work, one stage at a time, stopping at each approval gate. Note your Codex credits and DeepSeek balance before and after.
