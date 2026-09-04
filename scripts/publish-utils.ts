const releaseTagPattern = /^v\d+\.\d+\.\d+(?:-alpha\.\d+)?$/;
const releaseCommitPattern =
  /^chore: release (v\d+\.\d+\.\d+(?:-alpha\.\d+)?)(?: \(#\d+\))?$/;

export const resolveReleaseTag = (
  explicitTag: string | undefined,
  commitSubject: string,
  packageVersions: string[],
) => {
  const requestedTag = explicitTag?.trim();
  const commitMatch = releaseCommitPattern.exec(commitSubject.trim());
  const releaseTag =
    requestedTag === undefined || requestedTag === ""
      ? commitMatch?.[1]
      : requestedTag;

  if (!releaseTag) {
    throw new Error(
      "cannot derive release tag: use RELEASE_TAG or a 'chore: release v...' commit",
    );
  }

  if (!releaseTagPattern.test(releaseTag)) {
    throw new Error(`invalid release tag: ${releaseTag}`);
  }

  const releaseVersion = releaseTag.slice(1);
  if (!packageVersions.includes(releaseVersion)) {
    throw new Error(
      `release tag ${releaseTag} does not match a publishable package version`,
    );
  }

  return releaseTag;
};

const expectedVersion = (spec: string) => spec.slice(spec.lastIndexOf("@") + 1);

const defaultWait = (delayMs: number): Promise<void> =>
  new Promise((resolveWait) => {
    setTimeout(resolveWait, delayMs);
  });

export const verifyPublishedSpecs = async (
  specs: string[],
  options: {
    readVersion: (spec: string) => string | undefined;
    attempts?: number;
    delayMs?: number;
    wait?: (delayMs: number) => Promise<void>;
    onRetry?: (spec: string, attempt: number, attempts: number) => void;
  },
) => {
  const attempts = options.attempts ?? 61;
  const delayMs = options.delayMs ?? 5_000;
  const wait = options.wait ?? defaultWait;

  const failures = await Promise.all(
    specs.map(async (spec) => {
      const expected = expectedVersion(spec);

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const actual = options.readVersion(spec);
        if (actual === expected) return undefined;

        if (attempt < attempts) {
          options.onRetry?.(spec, attempt, attempts);
          await wait(delayMs);
        } else {
          return `${spec} (registry: ${actual ?? "not found"})`;
        }
      }

      return `${spec} (registry: not found)`;
    }),
  );

  return failures.filter((failure) => failure !== undefined);
};
