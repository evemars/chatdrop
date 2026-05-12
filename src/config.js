const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing or invalid config field: ${fieldName}`);
  }

  return value.trim();
}

function resolveConfiguredPath(configDir, rawValue, fieldName) {
  const value = requireNonEmptyString(rawValue, fieldName);
  return path.isAbsolute(value) ? value : path.resolve(configDir, value);
}

function requirePositiveNumber(value, fieldName, fallback) {
  const resolved = value ?? fallback;
  const numberValue = Number(resolved);

  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`Missing or invalid config field: ${fieldName}`);
  }

  return numberValue;
}

function loadConfig(configPath = path.resolve(process.cwd(), "config.yaml")) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const rawConfig = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
  const configDir = path.dirname(configPath);

  const filesDir = resolveConfiguredPath(
    configDir,
    rawConfig.storage?.files_dir,
    "storage.files_dir",
  );
  const dbDir = resolveConfiguredPath(
    configDir,
    rawConfig.storage?.db_dir,
    "storage.db_dir",
  );

  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(dbDir, { recursive: true });

  return {
    path: configPath,
    server: {
      host: String(rawConfig.server?.host ?? "0.0.0.0"),
      port: requirePositiveNumber(rawConfig.server?.port, "server.port", 3000),
    },
    auth: {
      password: requireNonEmptyString(rawConfig.auth?.password, "auth.password"),
      sessionDays: requirePositiveNumber(
        rawConfig.auth?.session_days,
        "auth.session_days",
        30,
      ),
    },
    storage: {
      filesDir,
      dbDir,
    },
  };
}

module.exports = {
  loadConfig,
};
