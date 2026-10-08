# LARP Detector for LinkedIn — Privacy Policy

_Last updated: 8 October 2026_

LARP Detector is a browser extension that labels LinkedIn posts REAL or LARP as you scroll. This policy explains what data it handles and where that data goes.

## What the extension reads

While you browse `linkedin.com`, the extension reads, for each post that scrolls into view:

- the post's text,
- the author's headline (the line under their name), and
- a short note on what is attached: whether there is an image, video, or document, any alt text the author wrote, and the domain and title of any link preview.

It does not read your messages, your profile, your connections, your account details, or any page outside `linkedin.com`.

## Where that data goes

- **Offline mode (default, no API key):** nothing leaves your browser. Posts are judged by rules built into the extension.
- **With an API key:** the three items above are sent to the provider you chose in Options to be judged:
  - **TypeSafe** (`api.typesafe.ai`), or
  - **OpenRouter** (`openrouter.ai`), which forwards the request to the model you selected.

  Those providers process the data under their own privacy policies. The extension sends nothing that identifies you. The request carries no LinkedIn account details, cookies, or browsing history, just the post content and your API key so the provider can authenticate it.

The extension sends no data to the developer, uses no analytics or tracking, and shows no ads.

## What is stored on your device

The extension uses `chrome.storage.local`, which never leaves your browser:

- **Settings:** on/off, sensitivity, provider, and model.
- **API keys:** kept in the extension's background worker only and never exposed to LinkedIn's page.
- **Verdict cache:** recent verdicts keyed by a hash of the post, so a post isn't judged twice. It stores the verdict, not the post text.

You can clear the cache any time with **Clear cache** in the popup. Uninstalling the extension deletes all of it.

## Sharing and sale

Your data is never sold, rented, or shared for advertising, credit, or any purpose other than producing the verdict you see. The extension's use of data complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Children

The extension is not directed at children under 13.

## Changes

If this policy changes, the updated version will be posted here with a new date.

## Contact

Questions or requests: open an issue at <https://github.com/sxeptical/larp-detector/issues>.

LARP Detector is not affiliated with or endorsed by LinkedIn.
