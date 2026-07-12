#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync
} from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareResourceAllowlist } from "./resource-allowlist.mjs";

export const CONNECT_SIGNING_KEY_ROTATION_SCHEMA = "hunsu.connect-signing-key-rotation.v1";
const DEFAULT_REPOSITORY = "lhj6102/hunsu";
const ENVIRONMENT_TARGET = Object.freeze({
  "hunsu-preview": "preview",
  "hunsu-production": "production"
});
const TARGET_BRANCH = Object.freeze({
  preview: "preview",
  production: "main"
});
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function generateConnectSigningKeyRotation(input) {
  const environment = assertEnvironment(input.environment);
  const repository = assertRepository(input.repository ?? DEFAULT_REPOSITORY);
  const bundlePath = assertAbsoluteBundlePath(input.bundlePath);
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicExport = publicKey.export({ format: "jwk" });
  const privateExport = privateKey.export({ format: "jwk" });
  const publicJwk = normalizePublicJwk(publicExport, "generated public JWK");
  const privateJwk = normalizePrivateJwk(privateExport, "generated private JWK");
  const keyId = connectSigningKeyId(publicJwk);
  const bundle = {
    schema: CONNECT_SIGNING_KEY_ROTATION_SCHEMA,
    environment,
    repository,
    createdAt: (input.now ?? new Date()).toISOString(),
    publicJwk,
    keyId,
    privateJwk
  };
  writePrivateBundle(bundlePath, bundle, {
    platform: input.platform ?? process.platform,
    windowsSecureWriter: input.windowsSecureWriter,
    windowsAclValidator: input.windowsAclValidator
  });
  return publicRotationMetadata("staged", bundle, bundlePath);
}

export function activateConnectSigningKeyRotation(input, dependencies = {}) {
  const bundlePath = assertAbsoluteBundlePath(input.bundlePath);
  const bundle = readRotationBundle(bundlePath, {
    platform: dependencies.platform ?? process.platform,
    windowsAclValidator: dependencies.windowsAclValidator
  });
  const environment = assertEnvironment(input.environment);
  const repository = assertRepository(input.repository ?? DEFAULT_REPOSITORY);
  if (bundle.environment !== environment || bundle.repository !== repository) {
    throw new Error("The staged Connect key bundle belongs to a different GitHub environment or repository.");
  }

  const target = ENVIRONMENT_TARGET[environment];
  const resourceAllowlist = dependencies.resourceAllowlist ?? cloudflareResourceAllowlist;
  const committed = resourceAllowlist(target);
  const publicJwk = JSON.stringify(bundle.publicJwk);
  if (committed.connectSigningPublicJwk !== publicJwk || committed.connectSigningKeyId !== bundle.keyId) {
    throw new Error(
      "The staged Connect key is not present in the committed Cloudflare allowlist. "
      + "Update the allowlist, immutable Bridge profile, tests, and candidate version before activation."
    );
  }

  const gh = dependencies.runGh ?? runGh;
  const git = dependencies.runGit ?? runGit;
  const workingTree = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (workingTree.trim()) {
    throw new Error("Connect key activation requires a clean source checkout.");
  }
  const localSha = assertCommitSha(git(["rev-parse", "HEAD"]), "local source SHA");
  gh(["auth", "status", "--hostname", "github.com"]);
  gh(["api", `repos/${repository}/environments/${encodeURIComponent(environment)}`]);
  const protectedBranch = TARGET_BRANCH[target];
  const remoteRef = parseGitHubRef(gh([
    "api",
    `repos/${repository}/git/ref/heads/${encodeURIComponent(protectedBranch)}`
  ]), protectedBranch);
  if (remoteRef !== localSha) {
    throw new Error(
      `Connect key activation requires HEAD to equal the protected ${protectedBranch} branch SHA. `
      + "Land and verify the complete trust/profile/version change before activation."
    );
  }

  const report = dependencies.report ?? (() => undefined);
  report(publicRotationMetadata("activating", bundle, bundlePath));
  let step = "public variable";
  try {
    gh([
      "variable", "set", "HUNSU_CONNECT_SIGNING_PUBLIC_JWK",
      "--env", environment,
      "--repo", repository,
      "--body", publicJwk
    ]);
    step = "key-id variable";
    gh([
      "variable", "set", "HUNSU_CONNECT_SIGNING_KEY_ID",
      "--env", environment,
      "--repo", repository,
      "--body", bundle.keyId
    ]);
    step = "private-key secret";
    gh([
      "secret", "set", "HUNSU_CONNECT_SIGNING_PRIVATE_JWK",
      "--env", environment,
      "--repo", repository
    ], JSON.stringify(bundle.privateJwk));
  } catch (error) {
    throw new Error(
      `Connect key activation failed while updating the ${step}. The GitHub environment may be partially updated; `
      + "deployments remain blocked by the exact trust gate. Re-run activate with the same staged bundle to reconcile it.",
      { cause: error }
    );
  }
  return publicRotationMetadata("activated", bundle, bundlePath);
}

export function readRotationBundle(bundlePathInput, options = {}) {
  const bundlePath = assertAbsoluteBundlePath(bundlePathInput);
  const stat = lstatSync(bundlePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("The Connect key bundle must be a direct regular file.");
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const validate = options.windowsAclValidator ?? validateWindowsPrivateFileAcl;
    validate(bundlePath);
  } else {
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("The Connect key bundle must have current-user-only permissions (0600).");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("The Connect key bundle must be owned by the current user.");
    }
  }
  let value;
  let descriptor;
  try {
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    descriptor = openSync(bundlePath, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    const current = lstatSync(bundlePath);
    if (!opened.isFile() || current.isSymbolicLink() || !current.isFile()
      || !sameFileIdentity(fileIdentity(stat), fileIdentity(opened))
      || !sameFileIdentity(fileIdentity(current), fileIdentity(opened))) {
      throw new Error("The Connect key bundle changed while its security was being validated.");
    }
    if (platform === "win32") {
      const validate = options.windowsAclValidator ?? validateWindowsPrivateFileAcl;
      validate(bundlePath);
    }
    value = JSON.parse(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("The Connect key bundle is not valid JSON.", { cause: error });
    }
    if (error instanceof Error && error.message.startsWith("The Connect key bundle")) throw error;
    throw new Error("The Connect key bundle could not be read securely.", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const bundle = requireRecord(value, "Connect key bundle");
  requireExactKeys(bundle, [
    "schema",
    "environment",
    "repository",
    "createdAt",
    "publicJwk",
    "keyId",
    "privateJwk"
  ], "Connect key bundle");
  if (bundle.schema !== CONNECT_SIGNING_KEY_ROTATION_SCHEMA) {
    throw new Error("The Connect key bundle schema is unsupported.");
  }
  const environment = assertEnvironment(bundle.environment);
  const repository = assertRepository(bundle.repository);
  if (typeof bundle.createdAt !== "string" || !Number.isFinite(Date.parse(bundle.createdAt))) {
    throw new Error("The Connect key bundle creation time is invalid.");
  }
  const publicJwk = normalizePublicJwk(bundle.publicJwk, "Connect key bundle public JWK");
  const privateJwk = normalizePrivateJwk(bundle.privateJwk, "Connect key bundle private JWK");
  const expectedKeyId = connectSigningKeyId(publicJwk);
  if (bundle.keyId !== expectedKeyId) {
    throw new Error("The Connect key bundle key id does not match its public JWK.");
  }
  let derived;
  try {
    const imported = createPrivateKey({ key: privateJwk, format: "jwk" });
    derived = normalizePublicJwk(createPublicKey(imported).export({ format: "jwk" }), "derived public JWK");
  } catch (error) {
    throw new Error("The Connect key bundle private JWK is invalid.", { cause: error });
  }
  if (JSON.stringify(derived) !== JSON.stringify(publicJwk)) {
    throw new Error("The Connect key bundle private JWK does not match its public JWK.");
  }
  return {
    schema: CONNECT_SIGNING_KEY_ROTATION_SCHEMA,
    environment,
    repository,
    createdAt: bundle.createdAt,
    publicJwk,
    keyId: expectedKeyId,
    privateJwk
  };
}

function writePrivateBundle(bundlePath, bundle, options) {
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  if (options.platform === "win32") {
    const writeSecurely = options.windowsSecureWriter ?? writeWindowsPrivateBundleAtomically;
    const validate = options.windowsAclValidator ?? validateWindowsPrivateFileAcl;
    let writtenIdentity;
    try {
      writeSecurely(bundlePath, serialized);
      const writtenStats = lstatSync(bundlePath);
      if (writtenStats.isSymbolicLink() || !writtenStats.isFile()) {
        throw new Error("The atomic Windows Connect key writer did not create a direct regular file.");
      }
      writtenIdentity = fileIdentity(writtenStats);
      const written = readRotationBundle(bundlePath, {
        platform: "win32",
        windowsAclValidator: validate
      });
      if (written.keyId !== bundle.keyId) {
        throw new Error("The atomically written Windows Connect key bundle changed during verification.");
      }
    } catch (error) {
      if (writtenIdentity) unlinkCreatedPrivateBundle(bundlePath, writtenIdentity);
      throw new Error("The Connect key bundle could not be created atomically for the current Windows user.", { cause: error });
    }
    return;
  }

  let descriptor;
  let identity;
  try {
    descriptor = openSync(bundlePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    identity = fileIdentity(fstatSync(descriptor));
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch (_closeError) { /* cleanup continues by verified identity */ }
    }
    if (identity) unlinkCreatedPrivateBundle(bundlePath, identity);
    throw error;
  }
}

function assertOwnedPrivateBundle(bundlePath, expectedIdentity) {
  const stats = lstatSync(bundlePath);
  if (stats.isSymbolicLink() || !stats.isFile() || !sameFileIdentity(fileIdentity(stats), expectedIdentity)) {
    throw new Error("The newly created Connect key bundle changed during secure creation.");
  }
}

function unlinkCreatedPrivateBundle(bundlePath, expectedIdentity) {
  if (!expectedIdentity) return;
  assertOwnedPrivateBundle(bundlePath, expectedIdentity);
  unlinkSync(bundlePath);
}

function publicRotationMetadata(state, bundle, bundlePath) {
  return Object.freeze({
    schema: CONNECT_SIGNING_KEY_ROTATION_SCHEMA,
    state,
    environment: bundle.environment,
    repository: bundle.repository,
    bundleFile: basename(bundlePath),
    publicJwk: JSON.stringify(bundle.publicJwk),
    keyId: bundle.keyId
  });
}

function connectSigningKeyId(publicJwk) {
  return `connect-${createHash("sha256").update(JSON.stringify(publicJwk)).digest("base64url").slice(0, 24)}`;
}

function normalizePublicJwk(value, label) {
  const jwk = requireRecord(value, label);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256"
    || typeof jwk.x !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x)
    || typeof jwk.y !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.y)) {
    throw new Error(`${label} must be a public P-256 JWK.`);
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

function normalizePrivateJwk(value, label) {
  const jwk = requireRecord(value, label);
  const publicJwk = normalizePublicJwk(jwk, label);
  if (typeof jwk.d !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.d)) {
    throw new Error(`${label} must contain a P-256 private scalar.`);
  }
  return { ...publicJwk, d: jwk.d };
}

function assertEnvironment(value) {
  if (value !== "hunsu-preview" && value !== "hunsu-production") {
    throw new Error("Environment must be hunsu-preview or hunsu-production.");
  }
  return value;
}

function assertRepository(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error("Repository must use the owner/name form.");
  }
  return value;
}

function assertAbsoluteBundlePath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || !value.endsWith(".json")) {
    throw new Error("The Connect key bundle path must be an absolute .json path.");
  }
  return resolve(value);
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const required = [...expected].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new Error(`${label} has an invalid field set.`);
  }
}

function assertCommitSha(value, label) {
  const sha = String(value ?? "").trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`${label} must be a complete Git commit SHA.`);
  return sha;
}

function parseGitHubRef(raw, branch) {
  let value;
  try {
    value = JSON.parse(String(raw ?? ""));
  } catch (error) {
    throw new Error(`GitHub did not return valid protected ${branch} branch identity.`, { cause: error });
  }
  return assertCommitSha(value?.object?.sha, `protected ${branch} branch SHA`);
}

function fileIdentity(stats) {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function windowsAtomicPrivateBundlePowerShellInvocation(path) {
  const commands = [
    "$ErrorActionPreference = 'Stop'",
    `$PrivateFile = ${powerShellString(path)}`,
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = [System.Security.AccessControl.FileSecurity]::new()",
    "$acl.SetOwner($sid)",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)",
    "$acl.SetAccessRule($rule)",
    "$content = [Console]::In.ReadToEnd()",
    "$stream = $null",
    "$created = $false",
    "$complete = $false",
    "try { $stream = [System.IO.FileStream]::new($PrivateFile, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough, $acl); $created = $true; $writtenAcl = $stream.GetAccessControl(); $owner = $writtenAcl.GetOwner([System.Security.Principal.SecurityIdentifier]); if ($owner.Value -ne $sid.Value -or -not $writtenAcl.AreAccessRulesProtected) { throw 'Private ACL owner or inheritance is unsafe.' }; $rules = @($writtenAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); if ($rules.Count -ne 1) { throw 'Private ACL must contain exactly one rule.' }; $writtenRule = $rules[0]; if ($writtenRule.IsInherited -or $writtenRule.IdentityReference.Value -ne $sid.Value -or $writtenRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $writtenRule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Private ACL rule is unsafe.' }; $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($content); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true); $complete = $true } finally { if ($null -ne $stream) { $stream.Dispose() }; if ($created -and -not $complete -and [System.IO.File]::Exists($PrivateFile)) { [System.IO.File]::Delete($PrivateFile) } }"
  ];
  return windowsPowerShellInvocation(commands);
}

function writeWindowsPrivateBundleAtomically(path, content) {
  const invocation = windowsAtomicPrivateBundlePowerShellInvocation(path);
  runWindowsPowerShellInvocation(invocation, content);
}

function validateWindowsPrivateFileAcl(path) {
  runWindowsPowerShellInvocation(windowsPowerShellInvocation([
    "$ErrorActionPreference = 'Stop'",
    `$PrivateFile = ${powerShellString(path)}`,
    "$attributes = [System.IO.File]::GetAttributes($PrivateFile)",
    "if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) { throw 'Private path is not a direct regular file.' }",
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = [System.IO.File]::GetAccessControl($PrivateFile, ([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access))",
    "$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])",
    "if ($owner.Value -ne $sid.Value -or -not $acl.AreAccessRulesProtected) { throw 'Private ACL owner or inheritance is unsafe.' }",
    "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
    "if ($rules.Count -ne 1) { throw 'Private ACL must contain exactly one rule.' }",
    "$rule = $rules[0]",
    "if ($rule.IsInherited -or $rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Private ACL rule is unsafe.' }"
  ]));
}

function windowsPowerShellInvocation(commands) {
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(commands.join("; "), "utf16le").toString("base64")
    ]
  };
}

function runWindowsPowerShellInvocation(invocation, input) {
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: windowsPowerShellEnvironment(process.env),
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows private-file ACL command failed with exit ${result.status ?? "unknown"}.`);
}

function powerShellString(value) {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Windows private-file paths cannot contain control characters.");
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsPowerShellEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) =>
    value !== undefined && name.toLowerCase() !== "psmodulepath" && name.toLowerCase() !== "winpsmodulepath"
  ));
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.slice(0, 2).join(" ")} failed with exit ${result.status ?? "unknown"}.`);
  }
  return result.stdout;
}

function runGh(args, input) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed with exit ${result.status ?? "unknown"}.`);
  }
  return result.stdout;
}

function usage() {
  return [
    "Usage:",
    "  provision-connect-signing-key.mjs generate <hunsu-preview|hunsu-production> <absolute-bundle.json> [owner/repository]",
    "  provision-connect-signing-key.mjs activate <hunsu-preview|hunsu-production> <absolute-bundle.json> [owner/repository]"
  ].join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const [operation, environment, bundlePath, repository = DEFAULT_REPOSITORY, ...extra] = argv;
  if (extra.length > 0 || (operation !== "generate" && operation !== "activate")) {
    throw new Error(usage());
  }
  if (operation === "generate") {
    process.stdout.write(`${JSON.stringify(generateConnectSigningKeyRotation({ environment, repository, bundlePath }))}\n`);
    return;
  }
  const activated = activateConnectSigningKeyRotation(
    { environment, repository, bundlePath },
    { report: metadata => process.stdout.write(`${JSON.stringify(metadata)}\n`) }
  );
  process.stdout.write(`${JSON.stringify(activated)}\n`);
}

const isEntryPoint = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) main();
