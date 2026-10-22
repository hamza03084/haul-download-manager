# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:

- Use GitHub's **Report a vulnerability** button on the repository's **Security** tab (private vulnerability reporting must be enabled by the maintainers in the repository settings), or
- contact the maintainers privately through the contact listed on the repository profile.

Include a description, steps to reproduce, the affected version, and the impact you expect. You should receive an acknowledgement within a week. Please give the maintainers reasonable time to release a fix before disclosing details publicly.

## Scope

Examples of issues we especially want to hear about:

- a server response that makes Haul write outside the chosen download folder or overwrite an existing file;
- data from a server being appended to the wrong file or a corrupted file being reported as complete;
- web content or `haul://` links causing Haul to download or open something without the user confirming it;
- secrets (URL tokens, passwords) appearing in logs;
- a link or quality choice that makes yt-dlp run with options Haul did not intend, or write outside the download folder.

## Supported versions

Only the latest release receives security fixes.

## Release integrity

Release builds are currently not code-signed. Download them only from the official repository's Releases page; each release is built by the public GitHub Actions workflow in `.github/workflows/ci.yml`.
