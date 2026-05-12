(() => {
    const DEFAULT_SETTINGS = {
        enabled: true,
        mirrorCharacters: false,
        reverseLetters: false,
        reverseWords: true
    };

    const RTL_SCRIPT_PATTERN = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
    const CANDIDATE_SELECTOR = "p, li, blockquote, dd, dt, figcaption, td, th";
    const LINE_GROUP_TOLERANCE_PX = 2;
    const TRAILING_PUNCTUATION_PATTERN = /^(.+?)([.,!?;:]+)$/;

    let settings = { ...DEFAULT_SETTINGS };
    let renderTimer = null;

    function getSettings() {
        return new Promise((resolve) => {
            chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
                resolve({ ...DEFAULT_SETTINGS, ...stored });
            });
        });
    }

    function isLikelyLtrText(text) {
        if (!text || !/[A-Za-z]/.test(text)) {
            return false;
        }

        return !RTL_SCRIPT_PATTERN.test(text);
    }

    function isAlphaNumericGrapheme(grapheme) {
        return /[\p{L}\p{N}]/u.test(grapheme);
    }

    function reverseLettersOnly(token) {
        const graphemes = Array.from(token);
        const reversible = graphemes.filter(isAlphaNumericGrapheme).reverse();
        let reverseIndex = 0;

        return graphemes.map((grapheme) => {
            if (!isAlphaNumericGrapheme(grapheme)) {
                return grapheme;
            }

            const next = reversible[reverseIndex];
            reverseIndex += 1;
            return next;
        }).join("");
    }

    // Returns only visible client rects for the current range.
    function getVisibleRects(range) {
        return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    }

    // Splits a wrapped hyphenated token to match the number of rect fragments.
    function splitWrappedHyphenatedToken(tokenText, rectCount) {
        // Split on literal hyphens so we can rebuild fragments per visual line.
        const parts = tokenText.split("-");

        // Not a hyphenated token, so there is nothing useful to split.
        if (parts.length <= 1) {
            return null;
        }

        const tokenParts = [];

        for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index];
            const isLastPart = index === parts.length - 1;

            // Keep trailing hyphens on all non-final pieces, e.g. "low-" + "light".
            if (isLastPart) {
                tokenParts.push(part);
            } else {
                tokenParts.push(`${part}-`);
            }
        }

        // Ideal case: one reconstructed token piece per measured rect fragment.
        if (tokenParts.length === rectCount) {
            return tokenParts;
        }

        // Common wrap case: browser gives 2 rects but token has multiple hyphens.
        // Merge all early pieces into line 1 and keep the final piece for line 2.
        if (rectCount === 2 && tokenParts.length > 2) {
            return [tokenParts.slice(0, -1).join(""), tokenParts[tokenParts.length - 1]];
        }

        // Unknown mapping between token pieces and rect fragments.
        return null;
    }

    function moveTrailingPunctuationToFront(token) {
        const match = token.match(TRAILING_PUNCTUATION_PATTERN);

        if (!match) {
            return token;
        }

        const [, core, punctuation] = match;
        return `${punctuation}${core}`;
    }

    // Used by collectWordRects: adds one visual word fragment (text + position)
    // to the words list for later line grouping.
    function pushWordFromRect(words, rect, elementRect, text) {
        words.push({
            text,
            top: rect.top - elementRect.top,
            left: rect.left - elementRect.left
        });
    }

    // applies word and/or letter reversals to alternating lines, if applicable.
    function transformWordsForLine(words, isOddLine) {
        let transformed = words.slice();

        if (isOddLine && settings.reverseWords) {
            transformed = transformed.reverse().map(moveTrailingPunctuationToFront);
        }

        if (isOddLine && settings.reverseLetters) {
            transformed = transformed.map(reverseLettersOnly);
        }

        return transformed;
    }

    function hasAnyTransformationEnabled() {
        return Boolean(settings.mirrorCharacters || settings.reverseLetters || settings.reverseWords);
    }

    // Reads text nodes and records word fragments with their rect-based positions.
    function collectWordRects(element) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        const words = [];
        const elementRect = element.getBoundingClientRect();

        while (walker.nextNode()) {
            const node = walker.currentNode;
            const value = node.nodeValue || "";

            if (!value.trim()) {
                continue;
            }

            const matches = value.matchAll(/\S+/g);

            for (const match of matches) {
                const start = match.index;
                const end = start + match[0].length;

                range.setStart(node, start);
                range.setEnd(node, end);

                const rects = getVisibleRects(range);

                if (rects.length === 0) {
                    continue;
                }

                if (rects.length === 1) {
                    const rect = rects[0];
                    pushWordFromRect(words, rect, elementRect, match[0]);

                    continue;
                }

                const splitParts = splitWrappedHyphenatedToken(match[0], rects.length);

                if (splitParts) {
                    rects.forEach((rect, rectIndex) => {
                        pushWordFromRect(words, rect, elementRect, splitParts[rectIndex]);
                    });

                    continue;
                }

                rects.forEach((rect) => {
                    pushWordFromRect(words, rect, elementRect, match[0]);
                });
            }
        }

        range.detach();

        return words;
    }

    // Groups recorded word fragments into visual lines based on rect top values.
    function groupWordsIntoLines(wordRects) {
        const sorted = wordRects.slice().sort((a, b) => {
            const topDelta = a.top - b.top;

            if (Math.abs(topDelta) > LINE_GROUP_TOLERANCE_PX) {
                return topDelta;
            }

            return a.left - b.left;
        });

        const lines = [];

        for (const word of sorted) {
            const existing = lines.find((line) => Math.abs(line.top - word.top) <= LINE_GROUP_TOLERANCE_PX);

            if (!existing) {
                lines.push({ top: word.top, words: [word] });
                continue;
            }

            existing.words.push(word);
        }

        for (const line of lines) {
            line.words.sort((a, b) => a.left - b.left);
        }

        return lines;
    }

    function isEligibleElement(element) {
        if (!element.isConnected) {
            return false;
        }

        if (element.closest("[contenteditable='true']")) {
            return false;
        }

        const text = element.innerText || "";

        if (text.trim().length < 20) {
            return false;
        }

        return isLikelyLtrText(text);
    }

    function clearBoustroRendering() {
        const processed = document.querySelectorAll("[data-boustro-applied='1'], [data-boustro-justify='1']");

        processed.forEach((element) => {
            const overlay = element.querySelector(":scope > .boustro-overlay");

            if (overlay) {
                overlay.remove();
            }

            if (element.getAttribute("data-boustro-position") === "set") {
                element.style.removeProperty("position");
            }

            element.style.removeProperty("--boustro-color");
            element.classList.remove("boustro-source");
            element.classList.remove("boustro-justify-only");
            element.removeAttribute("data-boustro-applied");
            element.removeAttribute("data-boustro-justify");
            element.removeAttribute("data-boustro-position");
        });
    }

    function applyJustifyOnlyToElement(element) {
        element.classList.add("boustro-justify-only");
        element.setAttribute("data-boustro-justify", "1");
    }

    function applyBoustroToElement(element) {
        if (!isEligibleElement(element)) {
            return;
        }

        if (!hasAnyTransformationEnabled()) {
            applyJustifyOnlyToElement(element);
            return;
        }

        const wordRects = collectWordRects(element);

        if (wordRects.length <= 1) {
            return;
        }

        const lines = groupWordsIntoLines(wordRects);

        if (lines.length <= 1) {
            return;
        }

        const overlay = document.createElement("div");
        overlay.className = "boustro-overlay";
        overlay.setAttribute("aria-hidden", "true");

        lines.forEach((line, lineIndex) => {
            const isOddLine = lineIndex % 2 === 1;
            const isVisualRtlLine = Boolean(settings.reverseWords && isOddLine);
            const isFinalLine = lineIndex === lines.length - 1;

            const lineWords = line.words.map((entry) => entry.text);
            const transformedWords = transformWordsForLine(lineWords, isOddLine);
            const lineElement = document.createElement("div");

            lineElement.className = "boustro-line";

            if (isFinalLine) {
                lineElement.classList.add(isVisualRtlLine ? "boustro-line--final-rtl" : "boustro-line--final-ltr");
            } else {
                lineElement.classList.add(isVisualRtlLine ? "boustro-line--rtl" : "boustro-line--ltr");
            }

            lineElement.textContent = transformedWords.join(" ");
            overlay.appendChild(lineElement);
        });

        const computedStyle = window.getComputedStyle(element);

        if (computedStyle.position === "static") {
            element.style.position = "relative";
            element.setAttribute("data-boustro-position", "set");
        }

        element.style.setProperty("--boustro-color", computedStyle.color);
        element.classList.add("boustro-source");
        element.setAttribute("data-boustro-applied", "1");
        element.appendChild(overlay);
    }

    function renderPage() {
        if (!settings.enabled) {
            clearBoustroRendering();
            return;
        }

        clearBoustroRendering();

        const candidates = document.querySelectorAll(CANDIDATE_SELECTOR);
        candidates.forEach(applyBoustroToElement);
    }

    function scheduleRender() {
        if (renderTimer) {
            window.clearTimeout(renderTimer);
        }

        renderTimer = window.setTimeout(() => {
            renderPage();
        }, 120);
    }

    async function initialize() {
        settings = await getSettings();
        scheduleRender();
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "sync") {
            return;
        }

        const updatedSettings = { ...settings };
        let shouldRender = false;

        Object.keys(DEFAULT_SETTINGS).forEach((key) => {
            if (changes[key]) {
                updatedSettings[key] = changes[key].newValue;
                shouldRender = true;
            }
        });

        if (shouldRender) {
            settings = updatedSettings;
            scheduleRender();
        }
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || message.type !== "boustro:toggle-enabled") {
            return;
        }

        settings = {
            ...settings,
            enabled: !settings.enabled
        };

        chrome.storage.sync.set({ enabled: settings.enabled }, () => {
            scheduleRender();
            sendResponse({ ok: true, enabled: settings.enabled });
        });

        return true;
    });

    window.addEventListener("load", scheduleRender, { once: true });
    window.addEventListener("resize", scheduleRender);

    initialize();
})()