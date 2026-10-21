/**
 * Perception: one compact semantic snapshot of a page.
 *
 * Written fresh for the new core (D34). The behaviours below are deliberately
 * ported from the old system because they were learned from real pages, not
 * because the code was reusable:
 *   - editor-like elements are collected even when zero-sized (Monaco, CodeMirror)
 *   - Monaco values come from the editor API, not the DOM text
 *   - password values are redacted at the source, never leaving the page as plaintext
 *   - refs are assigned in document order and re-tagged on every observation
 */

import type { Page } from "playwright";
import { compactControls, diffControls } from "./diff.ts";
import { shortId } from "./ids.ts";
import { displayControlName } from "./accessible-name.ts";
import type { Control, Observation } from "./types.ts";

/** Attribute used to address controls. Distinct from the old system's marker. */
export const REF_ATTR = "data-core-ref";

interface Collected {
  url: string;
  title: string;
  controls: Control[];
  dialogs: string[];
  errors: string[];
  heading?: string;
  stats?: Array<{ label: string; value: string }>;
}

const COLLECT = `(() => {
  const REF_ATTR = "data-core-ref";
  const selector = [
    "a", "button", "input", "select", "textarea",
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="checkbox"]',
    '[role="radio"]', '[role="option"]', '[role="listbox"]', '[role="combobox"]',
    '[role="menuitem"]', '[role="tab"]', '[contenteditable="true"]',
  ].join(",");

  /*
   * A ref belongs to an element for as long as the element lasts.
   *
   * Refs used to be positional and reassigned from scratch on every look, so inserting
   * one row at the top of a list renumbered every row below it. That is why the card has
   * to say refs go stale, and it is what makes it impossible to describe a page as a
   * change from the last one: an unchanged control cannot be left out of a snapshot if
   * leaving it out also takes away the only way to address it.
   *
   * The marker is already in the DOM, so keeping it is enough. New elements are numbered
   * above every ref the page is already carrying, so a fresh number never collides with
   * one the model is still holding. Navigation replaces the document and the numbering
   * starts again, which is correct: that is a different page.
   */
  let seq = 0;
  for (const el of document.querySelectorAll("[" + REF_ATTR + "]")) {
    const existing = Number(String(el.getAttribute(REF_ATTR)).slice(1));
    if (Number.isFinite(existing) && existing > seq) seq = existing;
  }

  const visible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  // Zero-sized editors are real and must survive: Monaco hides its textarea.
  const editorLike = (el) =>
    el.tagName.toLowerCase() === "textarea" ||
    el.isContentEditable === true ||
    el.getAttribute("role") === "textbox";

  const clean = (s) => (s || "").trim().replace(/\\s+/g, " ");

  // A label wrapping its control also contains that control's text, so
  // "<label>Location <select><option>Remote</option>…" would otherwise be named
  // "Location Remote NYC". Strip nested controls before reading the label.
  // The control's own label, as Playwright names it: aria-labelledby, then any associated
  // <label> (for= or wrapping, via el.labels), then an enclosing <label>.
  const labelTextFor = (el) => {
    const ids = el.getAttribute ? el.getAttribute("aria-labelledby") : null;
    if (ids) {
      const text = clean(
        ids
          .split(/\\s+/)
          .map((id) => {
            const node = document.getElementById(id);
            return node ? node.textContent : "";
          })
          .join(" "),
      );
      if (text) return text;
    }
    const label = (el.labels && el.labels[0]) || (el.closest ? el.closest("label") : null);
    if (!label) return "";
    const copy = label.cloneNode(true);
    for (const nested of copy.querySelectorAll("input, select, textarea, button, option")) {
      nested.remove();
    }
    return clean(copy.textContent);
  };

  /*
   * The text of the row a control sits in.
   *
   * A list row routinely spreads one thing's identity across siblings: an anchor holding
   * a handle, a span beside it holding the display name. Reading only the anchor's own
   * text throws half of it away, and then a task like "find Varya" cannot be matched
   * against a row whose anchor says "v_varvar" - the two never appear together anywhere
   * the agent can see.
   *
   * Row containers, not arbitrary ancestors: going up until the text got long would pick
   * up the whole list. This is a structural property of lists rather than a fact about
   * any site.
   */
  const ROW = "li, tr, [role='listitem'], [role='row'], [role='option'], [role='treeitem']";
  const rowTextFor = (el, name) => {
    const row = el.closest ? el.closest(ROW) : null;
    if (!row) return undefined;
    const text = clean(row.innerText || row.textContent).slice(0, 120);
    if (!text || text === name) return undefined;
    // Only when it adds something the control's own name does not already carry.
    return text.includes(name) && text.length <= name.length + 2 ? undefined : text;
  };

  const monacoValue = () => {
    const api = window.monaco && window.monaco.editor && window.monaco.editor.getEditors
      ? window.monaco.editor.getEditors()[0]
      : null;
    if (api && typeof api.getValue === "function") {
      const fromApi = clean(api.getValue());
      if (fromApi) return fromApi;
    }
    const host = document.querySelector(".monaco-editor .view-lines");
    return host ? clean(host.innerText) : "";
  };

  /*
   * Site furniture, from the document's own landmarks.
   *
   * Every page carries a header, a nav and a footer that are the same on every page of
   * the site, and on a crowded page they crowd out the thing the agent came for: a
   * follower dialog arrived as eleven navigation links, fifteen footer links and
   * fourteen rows of the list. Which controls those are is a structural question HTML
   * already answers, so nothing here needs to know what site it is on.
   *
   * Marked, never dropped: a nav link is often exactly the route the agent wants.
   */
  const LANDMARK = "nav, footer, header, [role='navigation'], [role='contentinfo'], [role='banner']";
  const inLandmark = (el) => Boolean(el.closest && el.closest(LANDMARK));
  const dialogNodes = [...document.querySelectorAll("dialog[open], [role='dialog'], [role='alertdialog']")]
    .filter(visible);
  const inDialog = (el) => dialogNodes.some((dialog) => dialog.contains(el));

  // The name of a control that has no text of its own: an image link, a bare icon.
  // Without this a photo grid arrives as a dozen controls all called "a".
  const borrowedName = (el) => {
    const image = el.querySelector ? el.querySelector("img[alt], [aria-label]") : null;
    const fromImage = image
      ? clean(image.getAttribute("alt") || image.getAttribute("aria-label"))
      : "";
    if (fromImage) return fromImage;
    const title = clean(el.getAttribute("title"));
    if (title) return title;
    const href = el.tagName.toLowerCase() === "a" ? el.getAttribute("href") || "" : "";
    const tail = href.split("?")[0].split("#")[0].split("/").filter(Boolean).pop() || "";
    return tail && tail !== "" ? tail : "";
  };

  const nativeNodes = [...document.querySelectorAll(selector)].filter(
    (el) => visible(el) || editorLike(el),
  );
  const native = new Set(nativeNodes);

  /*
   * Anything a person could click, not only the tags HTML happens to call controls.
   *
   * A suggestion row, a day cell, an icon-only control: visible, and either the
   * pointer cursor, a tab stop, or its own click handler. Descendants count. No
   * class name, no z-index, no "menu" guess. A node inside one we already kept is
   * the same click, so the ancestor stays and the child goes. A node that wraps a
   * real control does not replace that control.
   */
  const skipTag = { SCRIPT: 1, STYLE: 1, HTML: 1, BODY: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1 };
  const clickSignal = (el) => {
    const style = window.getComputedStyle(el);
    const tab = el.getAttribute("tabindex");
    const tabOk = tab != null && tab !== "" && Number(tab) >= 0;
    return style.cursor === "pointer" || tabOk || typeof el.onclick === "function";
  };
  const insideNative = (el) => {
    let parent = el.parentElement;
    while (parent) {
      if (native.has(parent)) return true;
      parent = parent.parentElement;
    }
    return false;
  };
  const extras = [];
  for (const el of document.querySelectorAll("body *")) {
    if (native.has(el) || skipTag[el.tagName] || !visible(el) || !clickSignal(el)) continue;
    if (insideNative(el)) continue;
    let wrapsNative = false;
    for (const node of nativeNodes) {
      if (el.contains(node)) {
        wrapsNative = true;
        break;
      }
    }
    if (!wrapsNative) extras.push(el);
  }
  const extraSet = new Set(extras);
  const extraKept = new Set(extras.filter((el) => {
    let parent = el.parentElement;
    while (parent) {
      if (extraSet.has(parent)) return false;
      parent = parent.parentElement;
    }
    return true;
  }));
  const nodes = [];
  for (const el of document.querySelectorAll("body *")) {
    if (native.has(el) || extraKept.has(el)) nodes.push(el);
  }

  const controls = nodes.map((el) => {
    let ref = el.getAttribute(REF_ATTR) || "";
    if (!ref) {
      seq += 1;
      ref = "e" + seq;
      el.setAttribute(REF_ATTR, ref);
    }
    const tag = el.tagName.toLowerCase();
    const labelText = labelTextFor(el).slice(0, 80);
    let role = el.getAttribute("role") || "";
    let inputType = el.type || undefined;
    if (el.isContentEditable) {
      role = role || "textbox";
      inputType = inputType || "contenteditable";
    } else if (tag === "textarea") {
      role = role || "textbox";
      inputType = "textarea";
    } else if (extraKept.has(el)) {
      role = role || "clickable";
    } else if (!role) {
      role = el.type || tag;
    }

    const name =
      el.getAttribute("aria-label") ||
      labelText ||
      el.getAttribute("name") ||
      el.getAttribute("placeholder") ||
      clean(el.textContent).slice(0, 80) ||
      borrowedName(el).slice(0, 80) ||
      inputType ||
      tag;

    let value;
    if (inputType === "password") {
      value = el.value ? "***" : "";
    } else if (el.isContentEditable || role === "textbox") {
      const own = clean(el.innerText || el.textContent || el.value);
      value = own || monacoValue() || undefined;
    } else {
      value = clean(el.value) || undefined;
    }

    const form = typeof el.closest === "function" ? el.closest("form") : null;
    const submits = Boolean(
      form &&
        (el.type === "submit" ||
          (tag === "button" && (el.type === "submit" || !el.getAttribute("type")))),
    );

    return {
      ref,
      role,
      name,
      tag,
      chrome: inLandmark(el) || undefined,
      dialog: inDialog(el) || undefined,
      value,
      disabled: el.disabled || undefined,
      checked: el.checked || undefined,
      required: el.required || el.getAttribute("aria-required") === "true" || undefined,
      inputType,
      submits: submits || undefined,
      href: tag === "a" ? el.href || undefined : undefined,
      row: rowTextFor(el, name),
    };
  });

  /*
   * A short summary, not the content.
   *
   * This used to be the only place a modal's text appeared, truncated to 160 characters -
   * so a follower list of hundreds of rows arrived as one clipped string and the agent
   * reasoned from a fragment. The rows inside a dialog are ordinary controls and are
   * enumerated above, each now carrying its own row text, so this can stay a summary.
   */
  const dialogs = dialogNodes
    .map((el) => clean(el.textContent).slice(0, 160))
    .filter(Boolean);

  const errors = [...document.querySelectorAll("[role='alert'], [aria-invalid='true'], .error")]
    .filter(visible)
    .map((el) => clean(el.textContent).slice(0, 160))
    .filter(Boolean);

  const headingEl = [...document.querySelectorAll("h1")].find(visible);
  const heading = headingEl ? clean(headingEl.innerText).slice(0, 80) : "";
  const stats = [];
  const isCounter = (label) => /^(followers|following|posts)$/i.test(clean(label));
  const isCount = (value) => /^\\d[\\d,]*$/.test(clean(value));
  const pushStat = (label, value) => {
    const l = clean(label).slice(0, 40);
    const v = clean(value).slice(0, 40);
    if (!l || !v || !isCounter(l) || !isCount(v)) return;
    if (stats.some((s) => s.label === l && s.value === v)) return;
    if (stats.length < 6) stats.push({ label: l, value: v });
  };
  for (const dt of document.querySelectorAll("dt")) {
    if (!visible(dt)) continue;
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === "DD") pushStat(dt.innerText, dd.innerText);
  }
  const host = headingEl && headingEl.parentElement ? headingEl.parentElement : document.body;
  const blob = clean((host && host.innerText) || "").slice(0, 800);
  const re = /(\\d[\\d,]*)\\s+(followers|following|posts)\\b/gi;
  let m;
  while (stats.length < 6 && (m = re.exec(blob))) {
    pushStat(m[2], m[1]);
  }

  return { url: location.href, title: document.title, controls, dialogs, errors, heading: heading || undefined, stats };
})()`;

export interface PerceiveContext {
  tabId: string;
  previous?: Observation;
  consoleErrors?: string[];
  failedRequests?: string[];
}

/**
 * A chance to drop controls the page is carrying but the agent cannot act on.
 *
 * Runs before the budget, and that ordering is the whole value of it. A control buried
 * under an open modal which keeps its slot in an 80-control cap has taken that slot from
 * something clickable, so filtering afterwards would fix what the model is shown without
 * fixing what it is shown *instead*.
 */
export type ControlFilter = (controls: Control[], page: Page) => Promise<Control[]>;

export async function perceive(
  page: Page,
  context: PerceiveContext,
  filter?: ControlFilter,
): Promise<Observation> {
  const collected = (await page.evaluate(COLLECT)) as Collected;
  // Everything downstream counts, diffs and ranks what is present, not what was found: a
  // control we are deliberately not offering should not appear in the delta, and should
  // not inflate the remainder the model is told about.
  const seen = new Set((context.previous?.controls ?? []).map((control) => control.ref));
  const hasPrevious = context.previous != null;
  const named = collected.controls.map((control) => ({
    ...control,
    name: displayControlName(control.name, control.href) || control.name,
    fresh: hasPrevious && !seen.has(control.ref) ? true : undefined,
  }));
  const present = filter ? await filter(named, page) : named;
  const { controls, truncated } = compactControls(present);
  const identity = pageIdentity(collected);
  return {
    id: shortId("obs"),
    tabId: context.tabId,
    url: collected.url,
    title: collected.title,
    controls,
    dialogs: collected.dialogs,
    errors: dedupe(collected.errors),
    consoleErrors: (context.consoleErrors ?? []).slice(-8),
    failedRequests: (context.failedRequests ?? []).slice(-8),
    changes: diffControls(context.previous?.controls, present),
    truncated: truncated || undefined,
    // The page, not the filtered list: a buried control still exists, and the remainder
    // the model is told has to count it. Filtering decides what is offered, not what was
    // there.
    totalControls: collected.controls.length,
    ...(identity ? { identity } : {}),
    capturedAt: new Date().toISOString(),
  };
}

export async function visibleText(page: Page): Promise<string> {
  return (await page.evaluate("document.body ? document.body.innerText : ''")) as string;
}

export function refSelector(ref: string): string {
  return `[${REF_ATTR}="${ref.replace(/["\\]/g, "\\$&")}"]`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function pageIdentity(collected: Collected): Observation["identity"] | undefined {
  const heading = collected.heading?.trim();
  const stats = filterIdentityStats(collected.stats ?? []);
  if (!heading && stats.length === 0) return undefined;
  return {
    ...(heading ? { heading } : {}),
    ...(stats.length ? { stats } : {}),
  };
}

const IDENTITY_COUNTER = /^(followers|following|posts)$/i;
const IDENTITY_COUNT = /^\d[\d,]*$/;

/**
 * Counts the page already shows, and only those.
 *
 * A looser "digits then words" sweep turned a handle (`naiem6632`) and a copyright
 * year into stats, which is why the model still probed the same page for numbers that
 * were already on it.
 */
export function filterIdentityStats(
  stats: ReadonlyArray<{ label: string; value: string }>,
): Array<{ label: string; value: string }> {
  return stats
    .filter((stat) => IDENTITY_COUNTER.test(stat.label.trim()) && IDENTITY_COUNT.test(stat.value.trim()))
    .slice(0, 6);
}
