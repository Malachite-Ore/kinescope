# Security Policy

## Supported Versions

Kinescope is maintained as a rolling release. Only the most recent release on the
[Releases page](https://github.com/Malachite-Ore/kinescope/releases) receives
fixes — if you are running an older build, please update before reporting.

## Reporting a Vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting instead: go to the
[Security tab](https://github.com/Malachite-Ore/kinescope/security) and choose
**Report a vulnerability**. That opens a private thread visible only to the
maintainer, so a fix can ship before the details are public.

Useful things to include, as far as you can:

- What an attacker gains, and what they need in order to do it.
- The Kinescope version, your OS, and the source URL or file involved.
- Steps to reproduce.

Expect a first response within about a week. This is a hobby project maintained
by one person, so please be patient.

## Scope

Kinescope is a desktop GUI that drives [yt-dlp](https://github.com/yt-dlp/yt-dlp)
and [FFmpeg](https://ffmpeg.org). Things worth reporting here:

- Anything that lets a crafted URL, playlist, video title, or subtitle file run
  commands, write outside the chosen download directory, or read files it
  shouldn't. Titles reach filename templates, and remote metadata reaches the UI.
- Mishandling of the sign-in cookies Kinescope reads from your browser or from a
  `cookies.txt` file — leaking, logging, or transmitting them anywhere.
- Weaknesses in how the app downloads and installs its own FFmpeg binaries.

Out of scope:

- Vulnerabilities in yt-dlp or FFmpeg themselves — report those upstream, to
  [yt-dlp](https://github.com/yt-dlp/yt-dlp/security) or
  [FFmpeg](https://ffmpeg.org/security.html). If Kinescope's bundled version is
  simply outdated, a normal issue is fine.
- Anything requiring an attacker who already has access to your user account on
  your own machine, since they could read the cookie stores directly anyway.
- The ability to download videos you are signed in to. That is the feature.
