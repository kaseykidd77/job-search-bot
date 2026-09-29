// Daily job search: island caretaker / lighthouse keeper / marina live-aboard couple
// Crawls a curated list of niche sites + boards, filters for paid + housing/RV-spot,
// dedupes against previous run, and emails a digest via Resend.

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";

const STATE_FILE = new URL("./seen.json", import.meta.url);
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM || "job-bot@resend.dev";

if (!RESEND_API_KEY || !EMAIL_TO) {
  console.error("Missing RESEND_API_KEY or EMAIL_TO env vars.");
  process.exit(1);
}

// ---- 1. Sources -----------------------------------------------------------
// Mix of: (a) niche listing boards we crawl for their current listing page(s),
// (b) individual organizations known to post these roles directly.
// Each entry: a page to fetch + simple text-based relevance rules.
const SOURCES = [
  { name: "Caretaker Gazette - listings", url: "https://caretaker.org/listings/" },
  { name: "Caretaker Gazette - home", url: "https://caretaker.org/" },
  { name: "Workamper News - job search", url: "https://www.workamper.com/jobs" },
  { name: "Coolworks - camp/marina/park jobs", url: "https://www.coolworks.com/jobs/" },
  { name: "Coolworks - couples jobs", url: "https://www.coolworks.com/jobs-for-couples/" },
  { name: "Escapees RV Club - workers on wheels", url: "https://www.escapees.com/rving/care-taking-jobs-for-rvers/" },
  { name: "ACRES Landtrust / caretaker (example land trust)", url: "https://www.acreslandtrust.org/jobs/" },
  { name: "US Lighthouse Society - keeper news", url: "https://uslhs.org/news" },
  { name: "National Park Service - jobs (caretaker/campground host)", url: "https://www.nps.gov/subjects/workwithus/volunteer.htm" },
  { name: "Workfrom / RV Workamping jobs board", url: "https://www.rvertravel.com/category/workamping/" },
  { name: "Marina Jobs (Marina Association job board)", url: "https://www.marinaassociation.org/jobs" },
  { name: "Indeed - island caretaker couple", url: "https://www.indeed.com/jobs?q=island+caretaker+couple" },
  { name: "Indeed - marina live aboard", url: "https://www.indeed.com/jobs?q=marina+live+aboard+couple" },
  { name: "Indeed - lighthouse keeper", url: "https://www.indeed.com/jobs?q=lighthouse+keeper" },
];

// Keywords that must appear (role relevance)
const ROLE_KEYWORDS = [
  "caretaker", "care taker", "lighthouse", "light station", "keeper",
  "marina", "live aboard", "live-aboard", "liveaboard", "campground host",
  "workamper", "workamping", "dockhand", "dock hand", "Island caretaker", "island property manager", "Island grounds keeper" 
];

// Keywords signalling paid compensation
const PAID_KEYWORDS = [
  "salary", "hourly", "pay", "paid", "stipend", "wage", "compensation",
  "$", "/hr", "per hour", "per month", "monthly pay"
];

// Keywords signalling housing OR RV spot provided
const HOUSING_KEYWORDS = [
  "housing provided", "free housing", "rv spot", "rv site", "rv hookup",
  "full hookup", "electric hookup", "site provided", "on-site housing",
  "live-in", "live in", "cottage provided", "accommodation provided",
  "utilities included", "lot provided", "on site rv"
];

// Explicit unpaid/volunteer-only exclusion signals
const VOLUNTEER_ONLY_KEYWORDS = [
  "volunteer position", "unpaid", "no compensation", "no salary",
  "volunteer opportunity", "this is a volunteer"
];

// ---- 2. Fetch + extract -----------------------------------------------------
async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html;
  } catch (err) {
    console.error(`Fetch failed for ${url}:`, err.message);
    return null;
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Break a page's text into candidate "chunks" (rough heuristic: split on
// job-posting-ish boundaries) so we can score relevance per-chunk rather
// than only per-page, and surface a usable snippet per hit.
function chunkText(text, chunkSize = 900, overlap = 150) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize - overlap) {
    chunks.push(text.slice(i, i + chunkSize));
    if (i + chunkSize >= text.length) break;
  }
  return chunks;
}

function containsAny(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}

function scoreChunk(chunk) {
  const roleHits = containsAny(chunk, ROLE_KEYWORDS);
  if (roleHits.length === 0) return null;

  const paidHits = containsAny(chunk, PAID_KEYWORDS);
  const housingHits = containsAny(chunk, HOUSING_KEYWORDS);
  const volunteerHits = containsAny(chunk, VOLUNTEER_ONLY_KEYWORDS);

  // Require: role relevance AND (paid signal OR at least not explicitly
  // volunteer-only) AND housing/RV signal preferred but not hard-required
  // (many postings describe this in a linked page we're not crawling).
  if (volunteerHits.length > 0 && paidHits.length === 0) return null;

  const score =
    roleHits.length * 2 + paidHits.length + housingHits.length * 1.5;

  return { score, roleHits, paidHits, housingHits };
}

async function crawlSource(source) {
  const html = await fetchText(source.url);
  if (!html) return [];
  const text = stripHtml(html);
  const chunks = chunkText(text);

  const hits = [];
  for (const chunk of chunks) {
    const scored = scoreChunk(chunk);
    if (scored && scored.score >= 3) {
      hits.push({
        source: source.name,
        url: source.url,
        snippet: chunk.slice(0, 400).trim() + "...",
        score: scored.score,
        roleHits: scored.roleHits,
        paidHits: scored.paidHits,
        housingHits: scored.housingHits,
      });
    }
  }

  // Dedupe near-identical chunks from the same page (boilerplate repeats)
  const deduped = [];
  const seenSnippets = new Set();
  for (const h of hits.sort((a, b) => b.score - a.score)) {
    const key = h.snippet.slice(0, 80);
    if (!seenSnippets.has(key)) {
      seenSnippets.add(key);
      deduped.push(h);
    }
  }
  return deduped.slice(0, 8); // cap per source
}

// ---- 3. State (dedupe across days) -----------------------------------------
async function loadSeen() {
  if (!existsSync(STATE_FILE)) return new Set();
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function saveSeen(seenSet) {
  await writeFile(STATE_FILE, JSON.stringify([...seenSet].slice(-2000), null, 0));
}

function hitKey(hit) {
  return `${hit.url}::${hit.snippet.slice(0, 60)}`;
}

// ---- 4. Email ---------------------------------------------------------------
function buildEmailHtml(newHits, totalScanned) {
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  if (newHits.length === 0) {
    return `
      <div style="font-family:Georgia,serif;max-width:640px;margin:0 auto;padding:24px;color:#2b2320;">
        <h2 style="color:#1d3557;">Daily Caretaker/Lighthouse/Marina Job Scan — ${dateStr}</h2>
        <p>No new matching postings found today across ${totalScanned} sources checked. The script will keep watching and email you as soon as something new turns up.</p>
      </div>`;
  }

  const bySource = {};
  for (const h of newHits) {
    bySource[h.source] = bySource[h.source] || [];
    bySource[h.source].push(h);
  }

  const sections = Object.entries(bySource)
    .map(([source, hits]) => {
      const items = hits
        .map(
          (h) => `
        <div style="margin:14px 0;padding:14px;background:#f8f6f1;border-left:3px solid #1d3557;border-radius:4px;">
          <div style="font-size:13px;color:#555;margin-bottom:6px;">
            Paid signal: ${h.paidHits.length ? "✅ " + h.paidHits.slice(0,3).join(", ") : "⚠️ not detected on this page"} &nbsp;|&nbsp;
            Housing/RV signal: ${h.housingHits.length ? "✅ " + h.housingHits.slice(0,3).join(", ") : "⚠️ not detected on this page"}
          </div>
          <div style="font-size:14px;line-height:1.5;">${h.snippet}</div>
          <div style="margin-top:8px;"><a href="${h.url}" style="color:#1d3557;">View source page →</a></div>
        </div>`
        )
        .join("");
      return `<h3 style="color:#1d3557;border-bottom:1px solid #ddd;padding-bottom:4px;">${source}</h3>${items}`;
    })
    .join("");

  return `
    <div style="font-family:Georgia,serif;max-width:640px;margin:0 auto;padding:24px;color:#2b2320;">
      <h2 style="color:#1d3557;">Daily Caretaker/Lighthouse/Marina Job Scan — ${dateStr}</h2>
      <p style="font-size:14px;color:#555;">${newHits.length} new potential match(es) found across ${totalScanned} sources. "Paid" and "housing/RV" signals are auto-detected from page text — always verify on the actual listing before applying.</p>
      ${sections}
      <p style="font-size:12px;color:#888;margin-top:24px;">Searching: island caretaker, lighthouse keeper, marina live-aboard couple roles. Requires a pay signal; housing or RV-spot signal is flagged but not required to appear (some postings detail this off-page).</p>
    </div>`;
}

async function sendEmail(html, subject) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [EMAIL_TO],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
  console.log("Email sent.");
}

// ---- 5. Main -----------------------------------------------------------------
async function main() {
  const seen = await loadSeen();
  const allHits = [];

  for (const source of SOURCES) {
    console.log(`Crawling: ${source.name}`);
    const hits = await crawlSource(source);
    allHits.push(...hits);
    // Be polite between requests
    await new Promise((r) => setTimeout(r, 800));
  }

  const newHits = allHits.filter((h) => !seen.has(hitKey(h)));
  for (const h of allHits) seen.add(hitKey(h));
  await saveSeen(seen);

  const subject =
    newHits.length > 0
      ? `🏝️ ${newHits.length} new caretaker/lighthouse/marina job match(es)`
      : `Daily job scan: no new matches today`;

  const html = buildEmailHtml(newHits, SOURCES.length);
  await sendEmail(html, subject);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
