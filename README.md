# Ticket Sorter

**Live page:** https://tanmaypathak18.github.io/ticket-sorter/

A small web page that sorts support tickets about restrictions, removals, points and pay into plain problem types. It shows which problem is biggest and suggests the cheapest fix level for each one.

**This is a demo by Tanmay Pathak.** It is not a support tool and is not connected to any support system.

## How to use it

1. **Load tickets.** Press "Try it with sample data", or upload your own CSV, Excel or JSON export. The page guesses which columns hold the ticket ID, date, worker ID, subject and description, shows a preview, and lets you change any guess. You can sort right away, or download your file in the [template](data/ticket_export_template.csv) format. Excel files are read from the first sheet only.
2. **See the answer.** Read the biggest problem, the bars, the fix level and idea for each problem, and the flag counts. With a date column you also get a before and after view. With a date and a worker ID you also get repeat contacts.
3. **Check and fix the sorting.** See the words that decided each ticket, move any ticket to another problem, and download the sorted CSV.

## Your data

Everything runs in your browser. Your file is never uploaded or stored. The only outside scripts are [Papa Parse](https://www.papaparse.com/), which reads CSV files, and [SheetJS](https://sheetjs.com/), which reads Excel files and loads only when you pick one. Both run on your own device.

## How the sorting works

It uses word rules, not AI, so every result can be explained. Each problem has a list of words and phrases in [data/rules.json](data/rules.json). A ticket scores one point for each different word from a list. The highest score wins, and ties go to the problem listed first. A ticket with no matches is "Other".

Dates like 03/04/2026 are read as month first, unless the first number can't be a month.

## Sample data

The sample is public worker reviews from Indeed, BBB, Trustpilot and app stores, summarized by hand. These are reviews, not real support tickets. The file holds 228 reviews, and the page counts the 163 that describe a problem. The text is a short summary, not the reviewer's own words.

## How well it works

The rules agree with my hand sorting on 119 of 163 sample reviews (73%). I did not tune the rules to raise this number. The summaries are my own paraphrases, so real tickets will likely score lower. That is why anyone can move a ticket by hand.

## Run it yourself

No build step. From this folder:

```bash
python3 -m http.server
```

Then open http://localhost:8000. To run the check on the sorting rules:

```bash
node tests/check.mjs
```
