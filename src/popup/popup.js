const DEFAULT_SETTINGS = {
  enabled: true,
  mirrorCharacters: false,
  reverseLetters: false,
  reverseWords: true
};

const enabledInput = document.getElementById("enabled");
const mirrorCharactersInput = document.getElementById("mirrorCharacters");
const reverseLettersInput = document.getElementById("reverseLetters");
const reverseWordsInput = document.getElementById("reverseWords");

async function readSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
      resolve({ ...DEFAULT_SETTINGS, ...stored });
    });
  });
}

function applySettingsToUi(settings) {
  enabledInput.checked = Boolean(settings.enabled);
  mirrorCharactersInput.checked = false;
  reverseLettersInput.checked = Boolean(settings.reverseLetters);
  reverseWordsInput.checked = Boolean(settings.reverseWords);
}

function writeSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(settings, resolve);
  });
}

function getCurrentSettingsFromUi() {
  return {
    enabled: enabledInput.checked,
    mirrorCharacters: false,
    reverseLetters: reverseLettersInput.checked,
    reverseWords: reverseWordsInput.checked
  };
}

async function handleChange() {
  const settings = getCurrentSettingsFromUi();
  await writeSettings(settings);
}

async function initializePopup() {
  const settings = await readSettings();
  applySettingsToUi(settings);

  enabledInput.addEventListener("change", handleChange);
  reverseLettersInput.addEventListener("change", handleChange);
  reverseWordsInput.addEventListener("change", handleChange);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    const nextSettings = {
      enabled: changes.enabled ? changes.enabled.newValue : enabledInput.checked,
      reverseLetters: changes.reverseLetters ? changes.reverseLetters.newValue : reverseLettersInput.checked,
      reverseWords: changes.reverseWords ? changes.reverseWords.newValue : reverseWordsInput.checked
    };

    applySettingsToUi(nextSettings);
  });
}

initializePopup();
