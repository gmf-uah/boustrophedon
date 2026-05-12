chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-boustro-enabled") {
    return;
  }

  chrome.storage.sync.get({ enabled: true }, (stored) => {
    chrome.storage.sync.set({ enabled: !stored.enabled });
  });
});
