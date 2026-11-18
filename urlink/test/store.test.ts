import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediumFeedUrl, parseMediumFeed, parseTikTokPage, tiktokVideo, youtubeId, exportBookmarks, importBookmarks, defaultImportPath } from "../src/store.ts";

test("youtubeId extracts ids from common YouTube URL shapes", () => {
  assert.equal(youtubeId("https://www.youtube.com/watch?v=abc123"), "abc123");
  assert.equal(youtubeId("https://youtu.be/abc123"), "abc123");
  assert.equal(youtubeId("https://www.youtube.com/shorts/abc123"), "abc123");
  assert.equal(youtubeId("https://www.youtube.com/embed/abc123"), "abc123");
  assert.equal(youtubeId("https://www.youtube.com/live/abc123"), "abc123");
});

test("youtubeId ignores non-YouTube URLs", () => {
  assert.equal(youtubeId("https://example.com/watch?v=abc123"), null);
  assert.equal(youtubeId("https://notyoutube.com/watch?v=abc123"), null);
  assert.equal(youtubeId("not a url"), null);
});

test("mediumFeedUrl derives the author feed for medium posts", () => {
  assert.equal(mediumFeedUrl("https://medium.com/@david.gilbertson/icons-as-react-components-de3e33cb8792"), "https://medium.com/feed/@david.gilbertson");
  assert.equal(mediumFeedUrl("https://www.medium.com/@user/some-post-abc123"), "https://medium.com/feed/@user");
  assert.equal(mediumFeedUrl("https://example.com/@user/some-post"), null);
  assert.equal(mediumFeedUrl("https://medium.com/tag/typescript"), null);
});

test("parseMediumFeed matches the article entry by link", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title><![CDATA[Other post]]></title>
      <link>https://medium.com/@user/other-post-111</link>
      <description><![CDATA[<p>Nope.</p>]]></description>
    </item>
    <item>
      <title><![CDATA[Icons as React Components]]></title>
      <link>https://medium.com/@user/icons-as-react-components-de3e33cb8792?source=rss-123</link>
      <description><![CDATA[<p>A guide to <b>icons</b>.</p>]]></description>
    </item>
  </channel></rss>`;
  const meta = parseMediumFeed(xml, "https://medium.com/@user/icons-as-react-components-de3e33cb8792");
  assert.equal(meta?.title, "Icons as React Components");
  assert.equal(meta?.description, "A guide to icons.");
});

test("parseMediumFeed returns null when the article is not in the feed", () => {
  const xml = `<rss><channel><item><title>X</title><link>https://medium.com/@user/x-1</link></item></channel></rss>`;
  assert.equal(parseMediumFeed(xml, "https://medium.com/@user/missing-2"), null);
});

test("parseMediumFeed falls back to content:encoded when description is missing", () => {
  const xml = `<rss><channel><item>
    <title>Post</title>
    <link>https://medium.com/@user/post-1</link>
    <content:encoded><![CDATA[<p>First paragraph.</p><p>Second paragraph.</p><p>Third.</p>]]></content:encoded>
  </item></channel></rss>`;
  const meta = parseMediumFeed(xml, "https://medium.com/@user/post-1");
  assert.equal(meta?.description, "First paragraph. Second paragraph.");
});

test("tiktokVideo recognizes TikTok video URLs", () => {
  assert.equal(tiktokVideo("https://www.tiktok.com/@user/video/7106594312292453675"), true);
  assert.equal(tiktokVideo("https://vm.tiktok.com/ZMabc123/"), true);
  assert.equal(tiktokVideo("https://example.com/@user/video/123"), false);
});

test("parseTikTokPage extracts the caption from the hydration JSON", () => {
  const html = `<script>{"itemStruct":{"id":"123","desc":"how many frogs did you find? 🐸 #Minecraft","createTime":"1"}}</script>`;
  assert.equal(parseTikTokPage(html).title, "how many frogs did you find? 🐸 #Minecraft");
});

test("parseTikTokPage decodes escaped quotes in the caption", () => {
  const html = `<script>{"itemStruct":{"id":"123","desc":"he said \\"hi\\" loudly","createTime":"1"}}</script>`;
  assert.equal(parseTikTokPage(html).title, 'he said "hi" loudly');
});

test("exportBookmarks writes JSON and importBookmarks reads it back", () => {
  const dir = mkdtempSync(join(tmpdir(), "urlink-test-"));
  const path = join(dir, "bookmarks.json");
  const list = [
    { id: "1", url: "https://example.com", title: "Example", description: "A test", tags: ["test"], archived: false, createdAt: 1 },
  ];
  exportBookmarks(list, path, "json");
  assert.deepEqual(importBookmarks(path, "json"), list);
  rmSync(dir, { recursive: true, force: true });
});

test("defaultImportPath picks the latest export file in the import dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "urlink-import-"));
  process.env.URLINK_IMPORT_DIR = dir;
  writeFileSync(join(dir, "urlink-export-2020-01-01-000000.json"), JSON.stringify({ bookmarks: [{ id: "1" }] }));
  writeFileSync(join(dir, "urlink-export-2021-01-01-000000.json"), JSON.stringify({ bookmarks: [{ id: "2" }] }));
  assert.equal(defaultImportPath(), join(dir, "urlink-export-2021-01-01-000000.json"));
  delete process.env.URLINK_IMPORT_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("exportBookmarks writes CSV and importBookmarks reads it back", () => {
  const dir = mkdtempSync(join(tmpdir(), "urlink-test-"));
  const path = join(dir, "bookmarks.csv");
  const list = [
    { id: "1", url: "https://example.com", title: "Example", description: "A test", tags: ["tag one", "tag two"], archived: false, createdAt: 1 },
  ];
  exportBookmarks(list, path, "csv");
  const back = importBookmarks(path, "csv");
  assert.equal(back.length, 1);
  assert.equal(back[0]!.url, "https://example.com");
  assert.equal(back[0]!.title, "Example");
  assert.equal(back[0]!.description, "A test");
  assert.deepEqual(back[0]!.tags, ["tag one", "tag two"]);
  rmSync(dir, { recursive: true, force: true });
});
