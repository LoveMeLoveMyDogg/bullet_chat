const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadConfigFile, saveConfigFile, encryptSecret, decryptSecret,
} = require('../shared/configCore');

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// safeStorage 不可用时降级为明文（仅本地文件，仍不联网）
const encrypter = (s) => safeStorage.isEncryptionAvailable()
  ? safeStorage.encryptString(s)
  : Buffer.from(s, 'utf8');
const decrypter = (buf) => safeStorage.isEncryptionAvailable()
  ? safeStorage.decryptString(buf)
  : buf.toString('utf8');

function loadConfig() {
  return loadConfigFile(configPath(), fs, decrypter);
}

function saveConfig(cfg) {
  saveConfigFile(configPath(), cfg, fs, encrypter);
}

module.exports = { loadConfig, saveConfig, configPath };
