# Daily Job Search Bot
### Island caretaker · lighthouse keeper · marina live-aboard couple

Crawls a curated list of niche job boards + sites daily, filters for **paid** roles that mention **housing or an RV spot**, and emails you only the **new** matches (it remembers what it already sent you).

---

## How it works

- `search.mjs` fetches each site in the `SOURCES` list, strips the HTML down to
  text, and scans it in chunks for:
  - **Role keywords** — caretaker, lighthouse/light station/keeper, marina,
    live-aboard, campground host, workamper/workamping, dockhand
  - **Paid signals** — salary, hourly, pay, stipend, wage, $, /hr, etc.
  - **Housing/RV signals** — RV spot, RV hookup, housing provided, live-in,
    accommodation provided, etc.
  - It **excludes** anything that reads as volunteer-only *unless* a paid
    signal also appears (some listings mix "volunteer" language loosely).
- It keeps a `seen.json` file of what it already flagged, so tomorrow's email
  only shows genuinely new postings.
- It emails you a digest via [Resend](https://resend.com) (free tier: 100
  emails/day, no credit card needed to start).
- GitHub Actions runs it once a day on a schedule — free, no server needed.

## ⚠️ Important limitation, read this

This is a **keyword-matching scanner**, not a true job-listing parser. Sites
change their HTML constantly, some block bots outright, and "paid" / "housing"
detection is done by scanning nearby text, not by understanding the posting's
actual terms. Treat every hit as **"worth a look,"** not as a verified match —
always open the source link and confirm pay and housing/RV details yourself
before applying. I built in a bias toward showing you more rather than
silently filtering out a real opportunity.

Also: several sites (Indeed, LinkedIn, etc.) actively block scripted access or
serve JavaScript-only pages that this simple fetch can't read. I included them
anyway since they sometimes still return static snippets, but the *niche*
sources (Caretaker Gazette, Coolworks, Workamper, Escapees) are doing the real
work here and are more likely to actually match what you want.

---

## Setup (about 15 minutes, all free)

### 1. Create a Resend account (for sending email)
1. Go to https://resend.com → sign up (free).
2. Verify your own email as the "to" address is easy — but to send *from* a
   custom domain you'd need to verify a domain. **Easiest path:** just use
   Resend's shared sending domain for now (`onboarding@resend.dev` or your
   assigned sandbox sender) — works immediately, no domain needed.
3. Go to **API Keys** → create one → copy it. You'll paste it into GitHub next.

### 2. Create a GitHub repo
1. Go to https://github.com/new → name it e.g. `job-search-bot` → Create.
2. Upload these files (drag-and-drop works, or use `git push`):
   - `search.mjs`
   - `.github/workflows/daily-job-search.yml`
   - `seen.json` (create an empty one: just type `[]` and save)
   - this `README.md`

   Keep the same folder structure — the workflow expects
   `job-search-bot/search.mjs` relative to the repo root. If you upload
   `search.mjs` straight into the repo root instead, edit the `run:` line in
   the workflow file to just `node search.mjs`.

### 3. Add your secrets
In your new repo: **Settings → Secrets and variables → Actions → New repository secret**. Add three:
| Name | Value |
|---|---|
| `RESEND_API_KEY` | the API key from step 1 |
| `EMAIL_TO` | your email address |
| `EMAIL_FROM` | `onboarding@resend.dev` (or your verified sender) |

### 4. Test it
Go to **Actions** tab → "Daily Job Search" workflow → **Run workflow** (this
is the `workflow_dispatch` trigger) → watch it run. Check your email.

### 5. Let it run
Once the test succeeds, it'll fire automatically every day at the time set in
the cron line (`0 12 * * *` = 6 AM Central / adjust as you like — GitHub cron
is always in UTC).

---

## Customizing

- **Add/remove sites:** edit the `SOURCES` array in `search.mjs` — each entry
  is just `{ name, url }`.
- **Change keywords:** edit `ROLE_KEYWORDS`, `PAID_KEYWORDS`,
  `HOUSING_KEYWORDS`, `VOLUNTEER_ONLY_KEYWORDS` near the top of the file.
- **Change schedule:** edit the `cron:` line in the workflow file
  ([crontab.guru](https://crontab.guru) helps write these).
- **Lower/raise the match threshold:** the line `scored.score >= 3` in
  `crawlSource()` — lower it to catch more (noisier), raise it for fewer
  (stricter, but cleaner) results.

## Suggested niche sources worth adding manually over time

Some of the best opportunities in this space come from small orgs that don't
show up in any search index — local land trusts, historical lighthouse
preservation societies, state park systems, and individual marinas. Worth
periodically Googling `"caretaker" "island" [your target region]` or
`"marina" "live aboard" "couple" hiring` and adding any recurring posters to
the `SOURCES` list by hand.
