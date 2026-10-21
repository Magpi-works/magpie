import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/site");

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function hasSession(req: IncomingMessage): boolean {
  return (req.headers.cookie ?? "").includes("bsa_session=1");
}

const ROUTES: Record<string, string> = {
  "/": "login.html",
  "/login": "login.html",
  "/jobs": "jobs.html",
  "/apply": "apply.html",
  "/dialog": "dialog.html",
  "/labels": "labels.html",
  "/error": "error.html",
  "/dynamic": "dynamic.html",
  "/jsonlint": "jsonlint.html",
  "/dead-click": "dead-click.html",
  "/combobox": "combobox.html",
  "/plan-labeled": "plan-labeled.html",
  "/fill": "fill.html",
  "/upload": "upload.html",
  "/list": "list.html",
  "/ambiguous": "ambiguous.html",
  "/noisy": "noisy.html",
  "/challenge": "challenge.html",
  "/once": "once.html",
  "/draft": "draft.html",
  "/tmpl-a": "tmpl-a.html",
  "/tmpl-b": "tmpl-b.html",
  "/secrets": "secrets.html",
  "/account": "account.html",
  "/roster": "roster.html",
  "/guests": "guests.html",
  "/split-rows": "split-rows.html",
  "/rows": "rows.html",
  "/crowded": "crowded.html",
  "/prepend": "prepend.html",
  "/modal-list": "modal-list.html",
  "/nav-shell": "nav-shell.html",
  "/nested-cards": "nested-cards.html",
  "/notes": "notes.html",
  "/stutter": "stutter.html",
  "/grid": "grid.html",
  "/profile-stats": "profile-stats.html",
  "/overlay-card": "overlay-card.html",
  "/chooser": "chooser.html",
  "/day-grid": "day-grid.html",
  "/icon-click": "icon-click.html",
};

/**
 * People for the roster fixtures. The city lives only on a person's own page, so the list
 * cannot answer "who is from Minsk" and each candidate has to be looked at.
 */
const PEOPLE: Record<string, { name: string; city: string }> = {
  ada: { name: "Ada Lovelace", city: "London" },
  grace: { name: "Grace Hopper", city: "New York" },
  alan: { name: "Alan Turing", city: "Manchester" },
  katherine: { name: "Katherine Johnson", city: "Hampton" },
  barbara: { name: "Barbara Liskov", city: "Boston" },
  edsger: { name: "Edsger Dijkstra", city: "Austin" },
  dana: { name: "Dana Ivanova", city: "Minsk" },
  linus: { name: "Linus Torvalds", city: "Portland" },
  // Guests. Boris is also from Minsk, which is what makes "my contacts" a fork rather
  // than a wording problem: the two readings give different answers.
  boris: { name: "Boris Petrov", city: "Minsk" },
  carla: { name: "Carla Mendes", city: "Lisbon" },
  nadia: { name: "Nadia Haddad", city: "Beirut" },
};

/** Shared handler for the two hosts that render the same application template. */
async function templatePost(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
): Promise<void> {
  const body = await readBody(req);
  const missing = ["firstName", "lastName", "email", "auth"].filter((field) => !body.get(field));
  if (missing.length > 0) {
    send(res, 200, await page(file, { error: "All fields are required" }));
    return;
  }
  send(res, 200, await page("success.html", { name: `${body.get("firstName")} ${body.get("lastName")}` }));
}

export class FixtureServer {
  private server: Server | null = null;
  port = 0;
  challengeSolved = false;
  rateHits = 0;

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", this.origin);
      try {
        if (req.method === "POST" && url.pathname === "/login") {
          const body = await readBody(req);
          if (body.get("email") && body.get("password")) {
            send(res, 302, "", {
              location: "/jobs",
              "set-cookie": "bsa_session=1; Path=/; Max-Age=86400",
            });
            return;
          }
          send(res, 200, await page("login.html", { error: "Email and password required" }));
          return;
        }
        if (req.method === "POST" && url.pathname === "/fill") {
          const body = await readBody(req);
          if (!body.get("fullName") || !body.get("email")) {
            send(res, 200, await page("fill.html", { error: "Name and email are required" }));
            return;
          }
          send(res, 200, await page("success.html", { name: body.get("fullName") ?? "" }));
          return;
        }
        if (req.method === "POST" && url.pathname === "/apply") {
          const body = await readBody(req);
          if (!body.get("fullName") || !body.get("email")) {
            send(res, 200, await page("apply.html", { error: "Name and email are required" }));
            return;
          }
          send(res, 200, await page("success.html", { name: body.get("fullName") ?? "" }));
          return;
        }
        if (req.method === "POST" && url.pathname === "/tmpl-a") {
          await templatePost(req, res, "tmpl-a.html");
          return;
        }
        if (req.method === "POST" && url.pathname === "/tmpl-b") {
          await templatePost(req, res, "tmpl-b.html");
          return;
        }
        if (url.pathname === "/api/search") {
          const body = JSON.stringify({
            users: Array.from({ length: 40 }, (_, index) => ({
              id: index,
              name: `User ${index}`,
              bio: "x".repeat(80),
            })),
          });
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(body);
          return;
        }
        if (url.pathname === "/api/page") {
          send(
            res,
            200,
            "<!doctype html><html><head><title>API page</title></head><body><h1>HTML under /api/</h1><a href=\"/\">Home</a></body></html>",
          );
          return;
        }
        if (url.pathname === "/go-jobs") {
          send(res, 302, "", { location: "/jobs" });
          return;
        }
        if (url.pathname === "/jobs" && !hasSession(req)) {
          send(res, 302, "", { location: "/login" });
          return;
        }
        // The plain roster shows handles as text with nothing to click, so reaching a
        // person needs a built URL or the search page.
        if (url.pathname === "/roster-plain") {
          const html = await page("roster.html");
          send(res, 200, html.replace("<body>", '<body data-plain="1">'));
          return;
        }
        if (url.pathname.startsWith("/p/")) {
          const handle = url.pathname.slice("/p/".length);
          const person = PEOPLE[handle];
          if (!person) {
            send(res, 404, "<h1>No such person</h1>");
            return;
          }
          send(res, 200, await page("person.html", { ...person, handle }));
          return;
        }
        if (url.pathname === "/found") {
          const handle = url.searchParams.get("who") ?? "";
          const person = PEOPLE[handle];
          if (!person) {
            send(res, 404, "<h1>No such person</h1>");
            return;
          }
          send(res, 200, await page("found.html", person));
          return;
        }
        // Every effect on this page lands after ?delay= milliseconds, so a test can
        // choose a delay wide enough that its assertion is not a coin toss.
        if (url.pathname === "/late") {
          const requested = Number(url.searchParams.get("delay"));
          const delay = Number.isFinite(requested) && requested > 0 ? requested : 350;
          send(res, 200, await page("late.html", { delay: String(delay) }));
          return;
        }
        if (url.pathname === "/late-paint") {
          const requested = Number(url.searchParams.get("delay"));
          const delay = Number.isFinite(requested) && requested > 0 ? requested : 350;
          send(res, 200, await page("late-paint.html", { delay: String(delay) }));
          return;
        }
        if (url.pathname === "/challenge") {
          if (req.method === "POST") {
            this.challengeSolved = true;
            send(res, 200, await page("challenge.html", { status: "Challenge cleared", form: "" }));
            return;
          }
          if (url.searchParams.get("gone") === "1" || this.challengeSolved) {
            send(res, 200, await page("challenge.html", { status: "Challenge cleared", form: "" }));
            return;
          }
          send(
            res,
            200,
            await page("challenge.html", {
              status: "CAPTCHA required",
              form: '<form method="post"><button type="submit">I am human</button></form>',
            }),
          );
          return;
        }
        if (url.pathname === "/rate-limit") {
          this.rateHits += 1;
          if (this.rateHits > 2) {
            send(res, 429, "<h1>Too many requests</h1><p>Retry-After: 3600</p>");
            return;
          }
          send(res, 200, "<h1>OK</h1><p>Allowed</p>");
          return;
        }
        if (url.pathname === "/find") {
          const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
          const results = q
            ? Object.entries(PEOPLE)
                .filter(
                  ([handle, person]) =>
                    handle.includes(q) || person.name.toLowerCase().includes(q),
                )
                .map(([handle, person]) => `<li><a href="/p/${handle}">${person.name}</a></li>`)
                .join("\n")
            : "";
          send(res, 200, await page("find.html", { q, results }));
          return;
        }
        const file = ROUTES[url.pathname] ?? "";
        if (!file) {
          send(res, 404, "<h1>Not found</h1>");
          return;
        }
        send(res, 200, await page(file));
      } catch (err) {
        send(res, 500, `<pre>${String(err)}</pre>`);
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    return this.origin;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function page(file: string, vars: Record<string, string> = {}): Promise<string> {
  const html = await readFile(path.join(SITE_DIR, file), "utf8");
  // Every placeholder, not two named ones: the roster fixtures need name, handle, city,
  // and a results list. Unsupplied placeholders still blank out as they always did.
  return html.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? "");
}
