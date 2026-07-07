export class HunsuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HunsuError";
  }
}

export class InvalidTrailerError extends HunsuError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTrailerError";
  }
}

export class MissingTrailerError extends HunsuError {
  constructor(commitSha: string, trailer: string) {
    super(`Commit ${commitSha} is missing required trailer ${trailer}`);
    this.name = "MissingTrailerError";
  }
}

export class LookupError extends HunsuError {
  constructor(message: string) {
    super(message);
    this.name = "LookupError";
  }
}

export class GitError extends HunsuError {
  readonly command: string[];
  readonly stderr: string;

  constructor(command: string[], stderr: string) {
    super(`Git command failed: git ${command.join(" ")}${stderr ? `\n${stderr}` : ""}`);
    this.name = "GitError";
    this.command = command;
    this.stderr = stderr;
  }
}
