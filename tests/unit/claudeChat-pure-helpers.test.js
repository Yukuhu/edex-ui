"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// claudeChat.class.js writes `window.ClaudeChat = ClaudeChat;` at
// module load — provide a minimal `window` first.
global.window = global.window ?? {};
const { ClaudeChat } = require("../../src/classes/claudeChat.class.js");

// ---------------------------------------------------------------------
// _isHttpUrl  (security gate before anything reaches shell.openExternal)
// ---------------------------------------------------------------------

test("ClaudeChat._isHttpUrl accepts http(s) URLs", async (t) => {
    const accept = [
        "http://example.com",
        "https://example.com",
        "HTTPS://Example.com",        // scheme-case-insensitive per WHATWG URL
        "https://example.com/",
        "https://example.com/path",
        "https://example.com/path?query=1",
        "https://example.com:8080/path#frag",
        "http://user:pass@example.com",
        "https://example.com/with%20space"
    ];
    for (const url of accept) {
        await t.test(`accepts ${JSON.stringify(url)}`, () => {
            assert.equal(ClaudeChat._isHttpUrl(url), true);
        });
    }
});

test("ClaudeChat._isHttpUrl rejects dangerous schemes", async (t) => {
    // The whole point of this gate: `shell.openExternal("javascript:...")`
    // would run arbitrary code via the OS handler.
    const reject = [
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "file:///etc/passwd",
        "vbscript:msgbox",
        "ftp://example.com",
        "ws://example.com",
        "mailto:x@example.com",
        "chrome://settings"
    ];
    for (const url of reject) {
        await t.test(`rejects ${JSON.stringify(url)}`, () => {
            assert.equal(ClaudeChat._isHttpUrl(url), false);
        });
    }
});

test("ClaudeChat._isHttpUrl rejects malformed / non-string inputs", async (t) => {
    await t.test("non-strings", () => {
        assert.equal(ClaudeChat._isHttpUrl(undefined), false);
        assert.equal(ClaudeChat._isHttpUrl(null), false);
        assert.equal(ClaudeChat._isHttpUrl(0), false);
        assert.equal(ClaudeChat._isHttpUrl(123), false);
        assert.equal(ClaudeChat._isHttpUrl({}), false);
        assert.equal(ClaudeChat._isHttpUrl([]), false);
        assert.equal(ClaudeChat._isHttpUrl(true), false);
    });
    await t.test("empty / whitespace-only strings", () => {
        assert.equal(ClaudeChat._isHttpUrl(""), false);
    });
    await t.test("malformed URLs", () => {
        assert.equal(ClaudeChat._isHttpUrl("not a url"), false);
        assert.equal(ClaudeChat._isHttpUrl("https//missing-colon.com"), false);
        assert.equal(ClaudeChat._isHttpUrl("://no-scheme"), false);
    });
    await t.test("a bare host with no scheme is not valid", () => {
        // `new URL("example.com")` throws; the static catch returns false.
        assert.equal(ClaudeChat._isHttpUrl("example.com"), false);
    });
});

// ---------------------------------------------------------------------
// _extractSources  (the meatiest pure transform in the class)
// ---------------------------------------------------------------------

// _extractSources reads no `this` state in its current implementation
// (only static class members) but is defined as an instance method.
// We can call it through a bare prototype subject.
const instance = Object.create(ClaudeChat.prototype);

test("_extractSources: identity cases", async (t) => {
    await t.test("empty string → cleaned='', no sources", () => {
        const r = instance._extractSources("");
        assert.equal(r.cleaned, "");
        assert.deepEqual(r.sources, []);
    });
    await t.test("plain prose, no URLs, no Sources block → unchanged", () => {
        const text = "Hello world.\nThis is a paragraph.";
        const r = instance._extractSources(text);
        assert.equal(r.cleaned, text);
        assert.deepEqual(r.sources, []);
    });
});

test("_extractSources: bare URLs in the body", async (t) => {
    await t.test("strips a single bare URL and captures it as a source", () => {
        const r = instance._extractSources("Check https://example.com/foo for details.");
        // Bare URL is REMOVED from cleaned text.
        assert.ok(!r.cleaned.includes("https://example.com"));
        // Captured with url=url, label=url (no markdown label).
        assert.equal(r.sources.length, 1);
        assert.equal(r.sources[0].url, "https://example.com/foo");
        assert.equal(r.sources[0].label, "https://example.com/foo");
    });
    await t.test("strips trailing punctuation from captured URL", () => {
        // The URL ends with ", " in prose — the trailing punctuation
        // strip happens inside pushUrl via [.,;:!?)\]]+$.
        const r = instance._extractSources("See https://example.com/foo, and more.");
        assert.equal(r.sources[0].url, "https://example.com/foo");
    });
});

test("_extractSources: markdown links in the body keep their labels", async (t) => {
    await t.test("[label](url) — keeps label, captures source", () => {
        const r = instance._extractSources("Read the [docs](https://docs.example.com) please.");
        assert.ok(r.cleaned.includes("docs"));            // label preserved
        assert.ok(!r.cleaned.includes("https://docs"));   // URL removed
        assert.equal(r.sources.length, 1);
        assert.equal(r.sources[0].url, "https://docs.example.com");
        assert.equal(r.sources[0].label, "docs");
    });
});

test("_extractSources: trailing Sources block", async (t) => {
    await t.test("Sources: heading with bare URLs is lopped off", () => {
        const text = "Here is the answer.\n\nSources:\nhttps://a.com\nhttps://b.com\n";
        const r = instance._extractSources(text);
        assert.ok(!r.cleaned.includes("Sources:"));
        assert.ok(!r.cleaned.includes("a.com"));
        assert.equal(r.sources.length, 2);
        const urls = r.sources.map(s => s.url).sort();
        assert.deepEqual(urls, ["https://a.com", "https://b.com"]);
    });
    await t.test("Sources: heading with markdown links keeps labels in sources", () => {
        const text = "Answer body.\n\nSources:\n- [Foo](https://foo.example)\n- [Bar](https://bar.example)\n";
        const r = instance._extractSources(text);
        const byUrl = Object.fromEntries(r.sources.map(s => [s.url, s.label]));
        assert.equal(byUrl["https://foo.example"], "Foo");
        assert.equal(byUrl["https://bar.example"], "Bar");
    });
    await t.test("References: heading variant", () => {
        const r = instance._extractSources("Body.\n\nReferences:\nhttps://r.com\n");
        assert.equal(r.sources.length, 1);
        assert.equal(r.sources[0].url, "https://r.com");
    });
    await t.test("Citations: heading variant", () => {
        const r = instance._extractSources("Body.\n\nCitations:\nhttps://c.com\n");
        assert.equal(r.sources.length, 1);
    });
    await t.test("emphasized heading: **Sources**: also matches", () => {
        const r = instance._extractSources("Body.\n\n**Sources**:\nhttps://e.com\n");
        assert.equal(r.sources.length, 1);
        assert.ok(!r.cleaned.includes("**Sources**"));
    });
    await t.test("markdown-heading variant: ## References", () => {
        const r = instance._extractSources("Body.\n\n## References\nhttps://e.com\n");
        assert.equal(r.sources.length, 1);
    });
});

test("_extractSources: dedupe by URL keeps the first label seen", () => {
    const text = "First [foo](https://example.com), then [bar](https://example.com).";
    const r = instance._extractSources(text);
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0].url, "https://example.com");
    assert.equal(r.sources[0].label, "foo"); // first wins
});

test("_extractSources: rejects javascript:/file:/data: even if they slip into the regex", () => {
    // The bare-URL regex requires https?:// at the start so these
    // wouldn't even reach pushUrl in practice — but the explicit
    // _isHttpUrl gate is what guarantees the safety story. Verify
    // it ALSO rejects dangerous URLs that somehow get past the regex.
    //
    // We can't easily force a javascript: URL through the regex from
    // the outside; instead, assert the regex doesn't pull such URLs
    // out at all.
    const tricky = "Body.\nSee javascript:alert(1) for fun, also data:text/html,bad, and file:///etc/passwd.";
    const r = instance._extractSources(tricky);
    assert.equal(r.sources.length, 0);
});

test("_extractSources: whitespace tidying", async (t) => {
    await t.test("collapses 3+ newlines to 2", () => {
        const r = instance._extractSources("Para 1.\n\n\n\nPara 2.");
        assert.ok(!r.cleaned.includes("\n\n\n"));
    });
    await t.test("trims leading/trailing whitespace", () => {
        const r = instance._extractSources("   \n  hello  \n   ");
        assert.equal(r.cleaned, "hello");
    });
    await t.test("strips dangling-bullet lines left behind after URL stripping", () => {
        // "- https://x.com" → URL stripped → "- " left over → tidy pass removes it.
        const r = instance._extractSources("Body.\n- https://x.com\n- More text.");
        assert.ok(!r.cleaned.match(/^\s*-\s*$/m), `cleaned should not have a bare bullet:\n${r.cleaned}`);
    });
});

// ---------------------------------------------------------------------
// Regex spot-checks (covered in detail by the #126 equivalence sweep;
// these are belt-and-braces in case future refactors touch the regexes
// without re-running that sweep)
// ---------------------------------------------------------------------

test("SOURCES_BLOCK_RE matches the documented variants", async (t) => {
    const re = ClaudeChat.SOURCES_BLOCK_RE;
    const matchers = [
        ["body\n\nSources:\nfoo\n", true],
        ["body\n\nReferences:\nfoo\n", true],
        ["body\n\nCitations:\nfoo\n", true],
        ["body\n\nsource:\nfoo\n", true],        // /i flag → case-insensitive
        ["body\n\n## Sources\nfoo\n", true],
        ["body\n\n**Sources**:\nfoo\n", true],
        ["body without any block", false],
        ["body\n\nAnnotation:\nfoo\n", false],   // not a keyword
        ["body\n\nSourceCode\nfoo\n", false]     // wordlike-but-not-keyword
    ];
    for (const [text, expected] of matchers) {
        await t.test(`${expected ? "matches" : "rejects"} ${JSON.stringify(text.slice(0, 40))}`, () => {
            assert.equal(re.test(text), expected);
        });
    }
});

// ---------------------------------------------------------------------
// Static data tables (settings-editor and chat-modal dropdown sources)
// ---------------------------------------------------------------------

test("ClaudeChat.DEFAULT_MODEL is a Claude model id", () => {
    assert.equal(typeof ClaudeChat.DEFAULT_MODEL, "string");
    assert.ok(ClaudeChat.DEFAULT_MODEL.startsWith("claude-"), ClaudeChat.DEFAULT_MODEL);
});

test("ClaudeChat.VOICES is a well-formed Kokoro voice table", () => {
    const V = ClaudeChat.VOICES;
    assert.ok(Array.isArray(V) && V.length > 0);
    const seenIds = new Set();
    for (const v of V) {
        assert.equal(typeof v.id, "string");
        assert.equal(typeof v.grade, "string");
        assert.equal(typeof v.region, "string");
        assert.equal(typeof v.gender, "string");
        assert.ok(!seenIds.has(v.id), `duplicate voice id ${v.id}`);
        seenIds.add(v.id);
        // Per the Kokoro id convention: <region-letter><gender-letter>_<name>.
        // Region: a (US) or b (UK); gender: f or m.
        assert.match(v.id, /^[ab][fm]_/, `voice id ${v.id} doesn't match <region><gender>_… convention`);
    }
});

test("ClaudeChat.DTYPES is a well-formed Kokoro quantization-tier list", () => {
    const D = ClaudeChat.DTYPES;
    assert.ok(Array.isArray(D) && D.length > 0);
    const seenIds = new Set();
    for (const d of D) {
        assert.equal(typeof d.id, "string");
        assert.equal(typeof d.label, "string");
        assert.ok(!seenIds.has(d.id), `duplicate dtype id ${d.id}`);
        seenIds.add(d.id);
    }
});

test("ClaudeChat.CHAT_BACKENDS has exactly claude-cli and gemma-local", () => {
    const ids = ClaudeChat.CHAT_BACKENDS.map(b => b.id).sort();
    assert.deepEqual(ids, ["claude-cli", "gemma-local"]);
    for (const b of ClaudeChat.CHAT_BACKENDS) {
        assert.equal(typeof b.label, "string");
        assert.ok(b.label.length > 0);
    }
});

test("ClaudeChat.GEMMA_DTYPES has exactly q4f16 and q8", () => {
    const ids = ClaudeChat.GEMMA_DTYPES.map(d => d.id).sort();
    assert.deepEqual(ids, ["q4f16", "q8"]);
});

test("CHAT_BACKENDS ids round-trip through _migrateBackend", () => {
    // The dropdown UI relies on this: every backend the user can pick
    // must canonicalise to itself.
    for (const b of ClaudeChat.CHAT_BACKENDS) {
        assert.equal(ClaudeChat._migrateBackend(b.id), b.id);
    }
});
