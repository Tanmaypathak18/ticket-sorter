# Ticket Sorter

A static web page (GitHub Pages) that sorts support tickets into plain problem types with keyword rules, shows the biggest problem and suggests a fix level. Full plan: BUILD_PLAN.md. Build one phase per session.

## Rules
- Plain HTML, CSS and JavaScript. No framework, no build step. The only outside script is Papa Parse 5.4.1 from jsDelivr.
- All sorting logic lives in js/sorter.js as a plain ES module, so it runs in the browser and in `node tests/check.mjs`.
- Never send ticket data anywhere. No analytics, no external requests besides Papa Parse.
- Do not edit the data files, except data/rules.json, and only when a phase says so.
- Do not tune rules.json to raise the sample agreement number.
- Run `node tests/check.mjs` after any change to sorter.js or rules.json.
- Show your plan before writing code. Keep changes small.

## Language on screen
- Plain words a busy reader understands at a glance. Short sentences.
- No jargon: avoid "coded", "taxonomy", "classifier", "NLP", "pipeline", "leverage", "insights".
- Use the names and descriptions from data/categories.json exactly.
- Never call the sample data real support tickets. It is public reviews, summarized.
- Footer must say it is a demo by Tanmay Pathak.
- Never name the company the demo is made for in the page, README or repo. The sample data files are the only exception: they stay as provided.

## Check before calling a phase done
- Every "Done when" box in BUILD_PLAN.md for that phase is true.
- No console errors. Works at 375 px wide.
