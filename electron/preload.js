const { contextBridge, webUtils } = require("electron");

contextBridge.exposeInMainWorld("photosLight", {
  resolveDropFiles(fileList) {
    const paths = [];
    for (let index = 0; index < fileList.length; index += 1) {
      const file = fileList[index];
      if (!file) {
        continue;
      }
      const resolved = webUtils.getPathForFile(file);
      if (resolved) {
        paths.push(resolved);
      }
    }
    return paths;
  },
});
