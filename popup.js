// SPDX-FileCopyrightText: 2026 Jakub Majcher
// SPDX-License-Identifier: GPL-3.0-only

const api = typeof browser !== "undefined" ? browser : chrome;

const COPIED_LABEL_MS = 1000;

/**
 * Every visible string lives in _locales; nothing user-facing is hardcoded here.
 *
 * Substitutions are passed only when there are any - handing getMessage an empty array
 * is a known way to get an empty string back. The key is used as a last-resort label so
 * a missing translation shows up as a visible defect instead of a blank button.
 */
const t = (key, ...substitutions) => {
  const message = substitutions.length
    ? api.i18n.getMessage(key, substitutions)
    : api.i18n.getMessage(key);
  return message || key;
};

/**
 * DASH/HLS keep video and audio in separate streams, so a manifest cannot be saved as one
 * file by a plain download. yt-dlp fetches both and muxes them; it also sends a browser
 * User-Agent, which servers like cda.pl require (plain curl/wget get a 403).
 */
const streamCommand = (url) => `yt-dlp "${url}"`;

const statusEl = document.getElementById("status");
const countEl = document.getElementById("count");
const resultsEl = document.getElementById("results");
const hintEl = document.getElementById("hint");

const showStatus = (message, isError = false) => {
  statusEl.textContent = message;
  statusEl.classList.toggle("status--error", isError);
  statusEl.hidden = false;
};

/** navigator.clipboard needs a focused document; execCommand covers the odd case it isn't. */
const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    return copied;
  }
};

const createCopyButton = ({ label, text, title, variant }) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `copy-button${variant ? ` copy-button--${variant}` : ""}`;
  button.textContent = label;
  if (title) button.title = title;

  let resetTimer = null;

  button.addEventListener("click", async () => {
    const copied = await copyToClipboard(text);
    button.textContent = copied ? t("copied") : t("copyFailed");
    button.classList.toggle("copy-button--copied", copied);

    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      button.textContent = label;
      button.classList.remove("copy-button--copied");
    }, COPIED_LABEL_MS);
  });

  return button;
};

/**
 * Streams get plain text instead of a link on purpose: a manifest opened in a tab downloads
 * its XML, which looks like the extension handed you a broken file.
 */
const createTitle = ({ url, title, isStream }) => {
  // content.js leaves the title empty when the URL carries no usable name.
  const shown = title || t("untitledVideo");

  if (isStream) {
    const label = document.createElement("span");
    label.className = "result__title";
    label.textContent = shown;
    label.title = t("streamTitleTooltip", url);
    return label;
  }

  const link = document.createElement("a");
  link.className = "result__title result__title--link";
  link.href = url;
  link.textContent = shown;
  link.title = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.addEventListener("click", (event) => {
    // Opening through the tabs API is reliable from a popup, which closes on click.
    event.preventDefault();
    api.tabs.create({ url });
  });
  return link;
};

const MAX_HINT_SEGMENTS = 2;

const directoriesOf = (url) => {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).slice(0, -1);
  } catch {
    return [];
  }
};

/** Codec directories are a common convention, and the codec is worth more than the path. */
const KNOWN_CODECS = new Set([
  "av1", "avc", "avc1", "h264", "h265", "hevc", "vp8", "vp9", "theora", "xvid", "mpeg4",
]);

const codecOf = (url) =>
  directoriesOf(url)
    .map((segment) => segment.toLowerCase())
    .find((segment) => KNOWN_CODECS.has(segment)) ?? null;

const MAX_QUERY_HINT = 24;

/** Last resort for rows that differ only past the "?": a clipped query is still a clue. */
const queryHintOf = (url) => {
  try {
    const { search } = new URL(url);
    if (!search) return null;
    return search.length > MAX_QUERY_HINT ? `${search.slice(0, MAX_QUERY_HINT - 1)}…` : search;
  } catch {
    return null;
  }
};

/**
 * A site can serve the same file name from several directories: test-videos.co.uk offers
 * mp4/av1, mp4/h264 and webm/vp9 versions of Big_Buck_Bunny_360_10s_1MB. Those rows are
 * different files, but with only the file name on screen they read as duplicates.
 *
 * A codec goes into the badge next to the container, where it reads as a property of the
 * file. Anything else that tells two rows apart stays in front of the file name.
 */
const withFileDetails = (videos) => {
  for (const video of videos) {
    video.codec = codecOf(video.url);
  }
  return withPathHints(videos);
};

const withPathHints = (videos) => {
  const groups = new Map();

  for (const video of videos) {
    const key = `${video.title}\u0000${video.fileName}`;
    const group = groups.get(key);
    if (group) group.push(video);
    else groups.set(key, [video]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const directories = group.map((video) => directoriesOf(video.url));
    group.forEach((video, index) => {
      const others = directories.filter((_, other) => other !== index);
      const distinctive = directories[index]
        .filter((segment) => !others.every((other) => other.includes(segment)))
        // The codec already shows in the badge, so repeating it here would be noise.
        .filter((segment) => !KNOWN_CODECS.has(segment.toLowerCase()));

      if (distinctive.length) {
        video.pathHint = distinctive.slice(-MAX_HINT_SEGMENTS).join("/");
        return;
      }
      // Nothing in the path separates them. Signed CDN links differ only past the "?",
      // and without this the rows come out identical to the pixel.
      if (group.every((other) => other.codec === video.codec)) {
        video.queryHint = queryHintOf(video.url);
      }
    });
  }

  return videos;
};

const createMeta = ({ url, fileName, pathHint, queryHint, codec, extension, isStream }) => {
  const badge = document.createElement("span");
  badge.className = `badge${isStream ? " badge--stream" : ""}`;
  badge.textContent = codec
    ? `${extension.toUpperCase()}·${codec.toUpperCase()}`
    : extension.toUpperCase();

  // The extension is already in the badge; printing it again reads as a stutter.
  const stem = fileName.replace(/\.[^.]+$/, "");

  const named = pathHint ? `${pathHint}/${stem}` : stem;

  const file = document.createElement("span");
  file.className = "result__file";
  file.textContent = queryHint ? `${named} ${queryHint}` : named;
  file.title = url;

  const meta = document.createElement("div");
  meta.className = "result__meta";
  meta.append(badge, file);

  if (isStream) {
    const flag = document.createElement("span");
    flag.className = "result__flag";
    flag.textContent = `· ${t("streamLabel")}`;
    meta.append(flag);
  }
  return meta;
};

const createResultRow = ({ url, title, fileName, pathHint, queryHint, codec, extension, isStream }) => {
  const item = document.createElement("li");
  item.className = "result";

  const main = document.createElement("div");
  main.className = "result__main";
  main.append(
    createTitle({ url, title, isStream }),
    createMeta({ url, fileName, pathHint, queryHint, codec, extension, isStream }),
  );

  const actions = document.createElement("div");
  actions.className = "result__actions";
  actions.append(
    createCopyButton({
      label: t("copyLink"),
      text: url,
      title: isStream ? t("copyStreamLinkTooltip", url) : url,
    }),
  );
  if (isStream) {
    actions.append(
      createCopyButton({
        label: t("copyCommand"),
        text: streamCommand(url),
        title: t("copyCommandTooltip", streamCommand(url)),
        variant: "ghost",
      }),
    );
  }

  item.append(main, actions);
  return item;
};

const render = (videos) => {
  if (!videos.length) {
    showStatus(t("noVideos"));
    return;
  }

  statusEl.hidden = true;
  countEl.textContent = t("foundCount", String(videos.length));
  countEl.hidden = false;

  const fragment = document.createDocumentFragment();
  for (const video of withFileDetails(videos)) {
    fragment.append(createResultRow(video));
  }
  resultsEl.append(fragment);

  if (videos.some((video) => video.isStream)) {
    hintEl.textContent = t("streamHint");
    hintEl.hidden = false;
  }
};

const findVideos = async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");

  const injections = await api.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"],
  });

  return injections?.[0]?.result ?? [];
};

document.documentElement.lang = api.i18n.getUILanguage();
for (const element of document.querySelectorAll("[data-i18n]")) {
  element.textContent = t(element.dataset.i18n);
}

findVideos()
  .catch((error) => {
    // Privileged pages (about:, view-source:, addons.mozilla.org) reject injection.
    console.error("Video Lister: cannot scan this page:", error);
    showStatus(t("pageNotScannable"), true);
    return null;
  })
  .then((videos) => {
    // Kept out of the catch above: a bug in render is not a permission problem, and
    // reporting it as one hides it behind a message that reads like expected behaviour.
    if (videos) render(videos);
  });
