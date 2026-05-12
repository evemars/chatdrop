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

function resolveWorkspaceConfig(rawConfig, configDir) {
  const workspaceDirRaw = rawConfig.workspace_dir ?? rawConfig.storage?.workspace_dir;

  if (workspaceDirRaw) {
    const workspaceDir = resolveConfiguredPath(configDir, workspaceDirRaw, "workspace_dir");
    return {
      workspaceDir,
      filesDir: path.join(workspaceDir, "files"),
      dbDir: path.join(workspaceDir, "db"),
      runDir: path.join(workspaceDir, "run"),
      logsDir: path.join(workspaceDir, "logs"),
    };
  }

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

  const sharedParent =
    path.basename(filesDir) === "files" &&
    path.basename(dbDir) === "db" &&
    path.dirname(filesDir) === path.dirname(dbDir)
      ? path.dirname(filesDir)
      : path.resolve(configDir, "data");

  return {
    workspaceDir: sharedParent,
    filesDir,
    dbDir,
    runDir: path.join(sharedParent, "run"),
    logsDir: path.join(sharedParent, "logs"),
  };
}

function loadConfig(configPath = path.resolve(process.cwd(), "config.yaml")) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const rawConfig = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
  const configDir = path.dirname(configPath);
  const storage = resolveWorkspaceConfig(rawConfig, configDir);

  fs.mkdirSync(storage.workspaceDir, { recursive: true });
  fs.mkdirSync(storage.filesDir, { recursive: true });
  fs.mkdirSync(storage.dbDir, { recursive: true });
  fs.mkdirSync(storage.runDir, { recursive: true });
  fs.mkdirSync(storage.logsDir, { recursive: true });

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
    storage,
  };
}

module.exports = {
  loadConfig,
};
